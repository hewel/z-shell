//! Shell daemon (`z-shelld`) library entry point with serialized atomic state and trust tiers.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use tokio::sync::{Mutex as AsyncMutex, OnceCell, watch};
use tracing::info;
use z_shell_bus::{
    BusHub, BusLimits, BusServer, CommandCall, CommandHandler, ShutdownHandle, UpdateKind,
};
use z_shell_clipboard::{ClipboardService, History as ClipboardHistory, LockedState};
use z_shell_config::{ConfigStore, RuntimeState, ShellPaths, UserSettings};
use z_shell_desktop::{DesktopHandle, DesktopServices, OfflinePolicy};
use z_shell_plugins::registry::{PluginError, PluginManager};
use z_shell_protocol::{
    ClientMessage, ClientRole, CommandInvokeResult, CommandName, ErrorCode, PROTOCOL_VERSION,
    PluginId, RequestId, RpcError, ServerMessage, TopicName, TopicSubscribeParams,
    decode_server_line, methods,
};
use z_shell_session::{
    coordinator::{
        InhibitorFuture, LockPhaseName, LogindEvent, LogindSleepInhibitor, SleepInhibitor,
        SleepInhibitorError, SleepSignal,
    },
    idle::{ActionCompletion, IdleAction, IdleEffect, MediaPlayback},
    pam::HelperAuthenticator,
    screensaver::{ScreenSaverRegistry, ScreenSaverServer},
    service::{LOCK_TOPIC, SessionService},
    wayland_idle::{WaylandIdle, WaylandIdleDriver},
};
use z_shell_system::{SystemHandle, SystemServices};
use z_shell_theme::{GtkLinker, ThemeEngine};
use z_shell_wayland::{OutputPowerMode, WaylandHandle};

/// Canonical core topic names published by `z-shelld`.
pub mod topics {
    /// Daemon readiness, version, and offline status.
    pub const DAEMON_STATUS: &str = "daemon.status";
    /// Public non-secret summary of `settings.toml`.
    pub const SETTINGS: &str = "settings";
    /// Public non-secret summary of durable `state.toml`.
    pub const STATE: &str = "state";
    /// Public non-secret summary of installed plugins at startup.
    pub const PLUGINS: &str = "plugins";
}

/// Running daemon assembly owning the config store, bus hub, domain services, and dual Unix socket server.
pub struct DaemonApp {
    hub: BusHub,
    server: BusServer,
    _theme: ThemeEngine,
    _wayland: Option<Arc<WaylandHandle>>,
    _system: Option<SystemHandle>,
    _clipboard: Arc<ClipboardService>,
    _desktop: Option<Arc<DesktopHandle>>,
    _session: Arc<SessionService>,
    _session_drivers: Option<SessionRuntimeDrivers>,
    _bridge: Option<CrossDomainBridge>,
}

impl DaemonApp {
    /// Bootstraps verified XDG directories, loads `settings.toml` and `state.toml`, wires built-in
    /// core topics and role-guarded control commands, and binds both public and host Unix sockets.
    ///
    /// # Errors
    ///
    /// Returns an error if directories, configuration files, single-instance lock, or sockets fail.
    pub fn bootstrap(paths: ShellPaths) -> Result<Self> {
        Self::bootstrap_with_limits(paths, BusLimits::default())
    }

    /// Bootstraps the daemon with explicit [`BusLimits`] (useful for backpressure tests).
    ///
    /// # Errors
    ///
    /// Returns an error if directories, configuration files, single-instance lock, or sockets fail.
    pub fn bootstrap_with_limits(paths: ShellPaths, limits: BusLimits) -> Result<Self> {
        paths
            .ensure_dirs()
            .context("initializing verified z-shell XDG directories")?;
        let store = Arc::new(ConfigStore::new(paths.clone()));
        let settings = store
            .load_settings()
            .context("loading settings.toml at startup")?;
        let runtime_state = store
            .load_state()
            .context("loading state.toml at startup")?;
        let plugins = Arc::new(PluginManager::new(paths.clone()));
        let plugin_summaries = match plugins.list() {
            Ok(list) => list,
            Err(err) => {
                tracing::warn!(error = %err, "failed to load plugin registry at startup; continuing with empty plugins topic");
                Vec::new()
            }
        };

        let hub = BusHub::with_limits(env!("CARGO_PKG_VERSION"), paths.media_dir(), limits);
        let server = BusServer::bind(
            paths.socket_path().to_path_buf(),
            paths.host_socket_path().to_path_buf(),
            paths.daemon_lock_path().to_path_buf(),
            hub.clone(),
        )
        .context("binding z-shelld public and host Unix sockets")?;
        let shutdown = server.shutdown_handle();

        // Single serialized async writers prevent concurrent save/publish reordering and avoid
        // holding std::sync::Mutex across disk I/O.
        let shared_settings = Arc::new(AsyncMutex::new(settings.clone()));
        let shared_state = Arc::new(AsyncMutex::new(runtime_state.clone()));

        publish_core_baselines(&hub, &settings, &runtime_state);
        hub.publish_core_topic(
            topic(topics::PLUGINS),
            json!(plugin_summaries),
            UpdateKind::SourceBaseline,
        );

        let config_home = paths
            .config_dir()
            .parent()
            .unwrap_or_else(|| paths.config_dir())
            .to_path_buf();
        let state_home = paths
            .state_dir()
            .parent()
            .unwrap_or_else(|| paths.state_dir())
            .to_path_buf();
        let theme = ThemeEngine::with_gtk(GtkLinker::new(config_home, state_home));
        theme.install_on_bus(&hub);

        let wayland = match z_shell_wayland::connect_from_env() {
            Ok(handle) => Some(Arc::new(z_shell_wayland::install_on_bus(&hub, handle))),
            Err(err) => {
                tracing::info!(error = %err, "no Wayland compositor detected; publishing disconnected baselines");
                z_shell_wayland::publish_disconnected_baselines(&hub);
                None
            }
        };

        let system = tokio::runtime::Handle::try_current()
            .ok()
            .map(|_| SystemServices::install(&hub, &paths));

        let clipboard = Arc::new(ClipboardService::new(ClipboardHistory::memory()));
        clipboard.install_on_bus(&hub);
        if let Err(err) = clipboard.connect_from_env() {
            tracing::info!(error = %err, "no Wayland clipboard transport available; staying memory-only");
        }

        let desktop = tokio::runtime::Handle::try_current().ok().map(|_| {
            let offline_policy = if settings.general.offline_mode {
                OfflinePolicy::Offline
            } else {
                OfflinePolicy::Online
            };
            Arc::new(DesktopServices::install(&hub, &paths, offline_policy))
        });

        let sleep_inhibitor = Arc::new(LazyLogindSleepInhibitor::new());
        let session = Arc::new(SessionService::new(
            hub.daemon_instance_id().to_owned(),
            Arc::new(HelperAuthenticator::new(resolve_pam_helper_path())),
            Arc::clone(&sleep_inhibitor) as Arc<dyn SleepInhibitor>,
            &settings.idle,
        ));
        session.install_on_bus(&hub);

        let session_drivers = SessionRuntimeDrivers::start(
            Arc::clone(&session),
            sleep_inhibitor,
            wayland.as_ref().map(Arc::downgrade),
        );

        let bridge =
            CrossDomainBridge::start(&hub, Arc::downgrade(&clipboard), Arc::downgrade(&session));

        register_plugin_commands(&hub, plugins);
        register_core_commands(
            &hub,
            store,
            shared_settings,
            shared_state,
            desktop.as_ref().map(Arc::downgrade),
            Arc::downgrade(&session),
            shutdown,
        );

        info!(
            public_socket = %paths.socket_path().display(),
            host_socket = %paths.host_socket_path().display(),
            daemon_instance_id = hub.daemon_instance_id(),
            "z-shelld bootstrapped"
        );
        Ok(Self {
            hub,
            server,
            _theme: theme,
            _wayland: wayland,
            _system: system,
            _clipboard: clipboard,
            _desktop: desktop,
            _session: session,
            _session_drivers: session_drivers,
            _bridge: bridge,
        })
    }

    /// Returns a cloneable [`ShutdownHandle`] for stopping the daemon gracefully.
    #[must_use]
    pub fn shutdown_handle(&self) -> ShutdownHandle {
        self.server.shutdown_handle()
    }

    /// Returns a clone of the underlying [`BusHub`].
    #[must_use]
    pub fn hub(&self) -> BusHub {
        self.hub.clone()
    }

    /// Runs the dual Unix socket accept loop until shutdown is signaled and active replies drain.
    ///
    /// # Errors
    ///
    /// Returns an error if the underlying listener encounters a fatal I/O failure.
    pub async fn run(self) -> Result<()> {
        self.server.serve().await.context("serving z-shelld bus")
    }
}

fn publish_core_baselines(hub: &BusHub, settings: &UserSettings, state: &RuntimeState) {
    hub.publish_core_topic(
        topic(topics::DAEMON_STATUS),
        json!({
            "version": env!("CARGO_PKG_VERSION"),
            "daemon_instance_id": hub.daemon_instance_id(),
            "offline_mode": settings.general.offline_mode,
        }),
        UpdateKind::SourceBaseline,
    );
    hub.publish_core_topic(
        topic(topics::SETTINGS),
        serde_json::to_value(settings.public_summary())
            .expect("PublicSettingsSummary serializes to JSON"),
        UpdateKind::SourceBaseline,
    );
    hub.publish_core_topic(
        topic(topics::STATE),
        serde_json::to_value(state.public_summary())
            .expect("PublicStateSummary serializes to JSON"),
        UpdateKind::SourceBaseline,
    );
}

fn register_plugin_commands(hub: &BusHub, plugins: Arc<PluginManager>) {
    let list_plugins = Arc::clone(&plugins);
    hub.register_core_command(
        cmd("plugins.list"),
        "List installed plugins without exposing settings or source credentials",
        Arc::new(move |_| {
            let plugins = Arc::clone(&list_plugins);
            Box::pin(plugin_query(move || {
                plugins.list().map(|summary| json!(summary))
            }))
        }),
    );
    hub.register_core_command(
        cmd("plugins.audit"),
        "Check a plugin's pinned content digest and capability approval",
        Arc::new(move |call| {
            let plugins = Arc::clone(&plugins);
            Box::pin(async move {
                let raw_id = match (call.params.args.as_slice(), call.params.payload.as_ref()) {
                    ([id], None) => Some(id.as_str()),
                    ([], Some(payload)) => payload.get("id").and_then(Value::as_str),
                    _ => None,
                }
                .ok_or_else(|| {
                    RpcError::new(
                        ErrorCode::InvalidParams,
                        "plugins.audit requires one plugin id argument or payload.id",
                    )
                })?;
                let id: PluginId = raw_id
                    .parse()
                    .map_err(|_| RpcError::new(ErrorCode::InvalidParams, "invalid plugin id"))?;
                plugin_query(move || plugins.audit(&id).map(|audit| json!(audit))).await
            })
        }),
    );
}

async fn plugin_query(
    query: impl FnOnce() -> Result<Value, PluginError> + Send + 'static,
) -> Result<CommandInvokeResult, RpcError> {
    let result = tokio::task::spawn_blocking(query).await.map_err(|_| {
        RpcError::new(
            ErrorCode::Internal,
            "plugin registry query did not complete",
        )
    })?;
    match result {
        Ok(data) => Ok(CommandInvokeResult {
            message: None,
            data: Some(data),
        }),
        Err(err @ PluginError::NotFound(_)) => {
            Err(RpcError::new(ErrorCode::NotFound, err.to_string()))
        }
        Err(err) => {
            tracing::warn!(%err, "plugin registry query failed");
            Err(RpcError::new(
                ErrorCode::Internal,
                "plugin registry query failed",
            ))
        }
    }
}

fn require_host_role(call: &CommandCall, action: &str) -> Result<(), RpcError> {
    if call.caller.role != ClientRole::PrivilegedHost {
        return Err(RpcError::new(
            ErrorCode::PermissionDenied,
            format!("{action} requires the privileged host control channel"),
        ));
    }
    Ok(())
}

fn register_core_commands(
    hub: &BusHub,
    store: Arc<ConfigStore>,
    settings_cell: Arc<AsyncMutex<UserSettings>>,
    state_cell: Arc<AsyncMutex<RuntimeState>>,
    desktop_ref: Option<Weak<DesktopHandle>>,
    session_ref: Weak<SessionService>,
    shutdown: ShutdownHandle,
) {
    // status (public) — receives `call.hub` at invocation time so BusHub holds zero Arc cycles!
    {
        let settings_ref = Arc::clone(&settings_cell);
        let handler: CommandHandler = Arc::new(move |call: CommandCall| {
            let settings_ref = Arc::clone(&settings_ref);
            Box::pin(async move {
                let offline = settings_ref.lock().await.general.offline_mode;
                let clients = call.hub.connected_clients();
                let topic_count = call.hub.list_topics().len();
                let command_count = call.hub.list_commands().len();
                Ok(CommandInvokeResult {
                    message: Some(format!(
                        "z-shelld v{} (clients={clients}, topics={topic_count}, commands={command_count}, offline={offline})",
                        env!("CARGO_PKG_VERSION")
                    )),
                    data: Some(json!({
                        "version": env!("CARGO_PKG_VERSION"),
                        "daemon_instance_id": call.hub.daemon_instance_id(),
                        "clients": clients,
                        "topics": topic_count,
                        "commands": command_count,
                        "offline_mode": offline,
                    })),
                })
            })
        });
        hub.register_core_command(cmd("status"), "Print daemon status summary", handler);
    }

    // settings.get (public: returns non-secret summary only)
    {
        let settings_ref = Arc::clone(&settings_cell);
        let handler: CommandHandler = Arc::new(move |_call: CommandCall| {
            let settings_ref = Arc::clone(&settings_ref);
            Box::pin(async move {
                let summary = settings_ref.lock().await.public_summary();
                let data = serde_json::to_value(summary).expect("PublicSettingsSummary serializes");
                Ok(CommandInvokeResult {
                    message: None,
                    data: Some(data),
                })
            })
        });
        hub.register_core_command(
            cmd("settings.get"),
            "Return public non-secret summary of settings.toml",
            handler,
        );
    }

    // settings.get-plugin (privileged host only: reads one plugin's settings table)
    {
        let settings_ref = Arc::clone(&settings_cell);
        let handler: CommandHandler = Arc::new(move |call: CommandCall| {
            let settings_ref = Arc::clone(&settings_ref);
            Box::pin(async move {
                require_host_role(&call, "settings.get-plugin")?;
                let raw_id = call
                    .params
                    .args
                    .first()
                    .map(String::as_str)
                    .or_else(|| {
                        call.params
                            .payload
                            .as_ref()
                            .and_then(|v| v.get("plugin_id"))
                            .and_then(Value::as_str)
                    })
                    .ok_or_else(|| {
                        RpcError::new(
                            ErrorCode::InvalidParams,
                            "settings.get-plugin requires a plugin_id argument",
                        )
                    })?;
                let plugin_id = PluginId::try_new(raw_id).map_err(|err| {
                    RpcError::new(
                        ErrorCode::InvalidParams,
                        format!("invalid plugin_id: {err}"),
                    )
                })?;
                let guard = settings_ref.lock().await;
                let value = guard
                    .plugin_settings
                    .get(&plugin_id)
                    .map(|v| serde_json::to_value(v).expect("toml::Value serializes"))
                    .unwrap_or_else(|| json!({}));
                Ok(CommandInvokeResult {
                    message: None,
                    data: Some(json!({
                        "plugin_id": plugin_id,
                        "settings": value,
                    })),
                })
            })
        });
        hub.register_core_command(
            cmd("settings.get-plugin"),
            "Return one plugin's settings overrides (privileged host only)",
            handler,
        );
    }

    // settings.reload (public: serialized single writer; no mutation on error; no live update if unchanged)
    {
        let store_ref = Arc::clone(&store);
        let settings_ref = Arc::clone(&settings_cell);
        let desktop_ref = desktop_ref.clone();
        let session_ref = session_ref.clone();
        let handler: CommandHandler = Arc::new(move |call: CommandCall| {
            let store_ref = Arc::clone(&store_ref);
            let settings_ref = Arc::clone(&settings_ref);
            let desktop_ref = desktop_ref.clone();
            let session_ref = session_ref.clone();
            Box::pin(async move {
                let mut guard = settings_ref.lock().await;
                let fresh = store_ref.load_settings().map_err(|err| {
                    RpcError::new(
                        ErrorCode::InvalidParams,
                        format!("failed to reload settings.toml: {err}"),
                    )
                })?;
                if *guard == fresh {
                    let data = serde_json::to_value(guard.public_summary())
                        .expect("PublicSettingsSummary serializes");
                    return Ok(CommandInvokeResult {
                        message: Some("settings unchanged".to_owned()),
                        data: Some(data),
                    });
                }
                let old_offline = guard.general.offline_mode;
                let idle_changed = guard.idle != fresh.idle;
                let summary_changed = guard.public_summary() != fresh.public_summary();
                *guard = fresh.clone();
                let summary_json = serde_json::to_value(guard.public_summary())
                    .expect("PublicSettingsSummary serializes");

                if old_offline != fresh.general.offline_mode
                    && let Some(desktop) = desktop_ref.as_ref().and_then(Weak::upgrade)
                {
                    desktop.set_offline_policy(if fresh.general.offline_mode {
                        OfflinePolicy::Offline
                    } else {
                        OfflinePolicy::Online
                    });
                }
                if idle_changed && let Some(session) = session_ref.upgrade() {
                    session.apply_settings(&fresh.idle).await;
                }

                let msg = if summary_changed {
                    let rev = call.hub.publish_core_topic(
                        topic(topics::SETTINGS),
                        summary_json.clone(),
                        UpdateKind::Live,
                    );
                    if old_offline != fresh.general.offline_mode {
                        call.hub.publish_core_topic(
                            topic(topics::DAEMON_STATUS),
                            json!({
                                "version": env!("CARGO_PKG_VERSION"),
                                "daemon_instance_id": call.hub.daemon_instance_id(),
                                "offline_mode": fresh.general.offline_mode,
                            }),
                            UpdateKind::Live,
                        );
                    }
                    format!("settings reloaded (revision {rev})")
                } else {
                    "settings reloaded (private overrides updated)".to_owned()
                };
                Ok(CommandInvokeResult {
                    message: Some(msg),
                    data: Some(summary_json),
                })
            })
        });
        hub.register_core_command(
            cmd("settings.reload"),
            "Reload settings.toml from disk and broadcast public changes",
            handler,
        );
    }

    // state.get (public: returns non-secret summary only)
    {
        let state_ref = Arc::clone(&state_cell);
        let handler: CommandHandler = Arc::new(move |_call: CommandCall| {
            let state_ref = Arc::clone(&state_ref);
            Box::pin(async move {
                let summary = state_ref.lock().await.public_summary();
                let data = serde_json::to_value(summary).expect("PublicStateSummary serializes");
                Ok(CommandInvokeResult {
                    message: None,
                    data: Some(data),
                })
            })
        });
        hub.register_core_command(
            cmd("state.get"),
            "Return public non-secret summary of state.toml",
            handler,
        );
    }

    // state.get-table (privileged host only)
    {
        let state_ref = Arc::clone(&state_cell);
        let handler: CommandHandler = Arc::new(move |call: CommandCall| {
            let state_ref = Arc::clone(&state_ref);
            Box::pin(async move {
                require_host_role(&call, "state.get-table")?;
                let key = call
                    .params
                    .args
                    .first()
                    .map(String::as_str)
                    .or_else(|| {
                        call.params
                            .payload
                            .as_ref()
                            .and_then(|v| v.get("key"))
                            .and_then(Value::as_str)
                    })
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        RpcError::new(
                            ErrorCode::InvalidParams,
                            "state.get-table requires a non-empty key",
                        )
                    })?;
                let guard = state_ref.lock().await;
                let value = guard
                    .tables
                    .get(key)
                    .map(|v| serde_json::to_value(v).expect("toml::Value serializes"));
                Ok(CommandInvokeResult {
                    message: None,
                    data: Some(json!({
                        "key": key,
                        "value": value,
                    })),
                })
            })
        });
        hub.register_core_command(
            cmd("state.get-table"),
            "Read a single owner-scoped durable state table (privileged host only)",
            handler,
        );
    }

    // state.set-table (privileged host only; serialized persist-before-commit so failure never mutates memory!)
    {
        let store_ref = Arc::clone(&store);
        let state_ref = Arc::clone(&state_cell);
        let handler: CommandHandler = Arc::new(move |call: CommandCall| {
            let store_ref = Arc::clone(&store_ref);
            let state_ref = Arc::clone(&state_ref);
            Box::pin(async move {
                require_host_role(&call, "state.set-table")?;
                let Some(payload) = call.params.payload else {
                    return Err(RpcError::new(
                        ErrorCode::InvalidParams,
                        "state.set-table requires a JSON object payload with 'key' and 'value'",
                    ));
                };
                let Some(key) = payload
                    .get("key")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                else {
                    return Err(RpcError::new(
                        ErrorCode::InvalidParams,
                        "payload.key must be a non-empty string",
                    ));
                };
                let Some(raw_val) = payload.get("value") else {
                    return Err(RpcError::new(
                        ErrorCode::InvalidParams,
                        "payload.value is required",
                    ));
                };
                let toml_val: toml::Value =
                    serde_json::from_value(raw_val.clone()).map_err(|err| {
                        RpcError::new(
                            ErrorCode::InvalidParams,
                            format!("value cannot be represented in TOML: {err}"),
                        )
                    })?;

                // Single serialized writer: persist atomically under cross-display flock BEFORE
                // swapping in-memory state or publishing a new revision.
                let mut guard = state_ref.lock().await;
                let key_owned = key.to_owned();
                let committed = store_ref
                    .update_state(move |disk_state| {
                        disk_state.tables.insert(key_owned, toml_val);
                        Ok(())
                    })
                    .map_err(|err| {
                        RpcError::new(
                            ErrorCode::Internal,
                            format!("failed to persist state.toml: {err}"),
                        )
                    })?;

                *guard = committed;
                let summary_json = serde_json::to_value(guard.public_summary())
                    .expect("PublicStateSummary serializes");
                let rev = call.hub.publish_core_topic(
                    topic(topics::STATE),
                    summary_json.clone(),
                    UpdateKind::Live,
                );
                Ok(CommandInvokeResult {
                    message: Some(format!("state table '{key}' committed (revision {rev})")),
                    data: Some(summary_json),
                })
            })
        });
        hub.register_core_command(
            cmd("state.set-table"),
            "Persist an owner-scoped table in state.toml atomically (privileged host only)",
            handler,
        );
    }

    // quit (privileged host only; reply flushes cleanly during bounded connection drain)
    {
        let handler: CommandHandler = Arc::new(move |call: CommandCall| {
            let shutdown = shutdown.clone();
            Box::pin(async move {
                require_host_role(&call, "quit")?;
                shutdown.shutdown();
                Ok(CommandInvokeResult {
                    message: Some("shutting down".to_owned()),
                    data: None,
                })
            })
        });
        hub.register_core_command(
            cmd("quit"),
            "Gracefully shut down z-shelld (privileged host only)",
            handler,
        );
    }
}

fn topic(name: &str) -> TopicName {
    TopicName::try_new(name).expect("hardcoded core topic name is valid")
}

fn cmd(name: &str) -> CommandName {
    CommandName::try_new(name).expect("hardcoded core command name is valid")
}

fn resolve_pam_helper_path() -> PathBuf {
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let sibling = dir.join("z-shell-pam-helper");
        if sibling.is_file() {
            return sibling;
        }
    }
    PathBuf::from("z-shell-pam-helper")
}

#[derive(Debug)]
struct LazyLogindSleepInhibitor {
    inner: OnceCell<LogindSleepInhibitor>,
}

impl LazyLogindSleepInhibitor {
    fn new() -> Self {
        Self {
            inner: OnceCell::new(),
        }
    }

    async fn get_or_connect(&self) -> Result<&LogindSleepInhibitor, SleepInhibitorError> {
        self.inner
            .get_or_try_init(LogindSleepInhibitor::connect_system)
            .await
    }
}

impl SleepInhibitor for LazyLogindSleepInhibitor {
    fn acquire(&self) -> InhibitorFuture<'_> {
        Box::pin(async move { self.get_or_connect().await?.acquire().await })
    }

    fn release(&self) {
        if let Some(inhibitor) = self.inner.get() {
            inhibitor.release();
        }
    }

    fn is_held(&self) -> bool {
        self.inner.get().is_some_and(SleepInhibitor::is_held)
    }

    fn suspend(&self) -> InhibitorFuture<'_> {
        Box::pin(async move { self.get_or_connect().await?.suspend().await })
    }
}

struct SessionRuntimeDrivers {
    stop: watch::Sender<bool>,
    _wayland_idle: Option<WaylandIdleDriver>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl SessionRuntimeDrivers {
    fn start(
        session: Arc<SessionService>,
        sleep_inhibitor: Arc<LazyLogindSleepInhibitor>,
        wayland: Option<Weak<WaylandHandle>>,
    ) -> Option<Self> {
        let runtime = tokio::runtime::Handle::try_current().ok()?;
        let (stop, stop_rx) = watch::channel(false);

        let wayland_idle = match WaylandIdle::connect_from_env() {
            Ok(idle) => match WaylandIdleDriver::spawn(idle, Arc::clone(&session), runtime.clone())
            {
                Ok(driver) => Some(driver),
                Err(error) => {
                    tracing::warn!(%error, "failed to start Wayland idle driver");
                    session.set_idle_unavailable(format!("Wayland idle worker failed: {error}"));
                    None
                }
            },
            Err(error) => {
                tracing::info!(%error, "no Wayland ext-idle-notify-v1 compositor available");
                session.set_idle_unavailable(format!("ext-idle-notify-v1 unavailable: {error}"));
                None
            }
        };

        let mut tasks = Vec::new();

        // 1. DPMS ScreenOff / ResumeAction consumer bridging idle effects to wlr-output-power.
        {
            let session_weak = Arc::downgrade(&session);
            let mut effects = session.subscribe_idle_effects();
            let mut stop_dpms = stop_rx.clone();
            tasks.push(runtime.spawn(async move {
                loop {
                    tokio::select! {
                        biased;
                        _ = stop_dpms.changed() => break,
                        effect = effects.recv() => {
                            match effect {
                                Ok(IdleEffect::RunAction {
                                    action_id,
                                    action: IdleAction::ScreenOff,
                                    ..
                                }) => {
                                    let outcome = match wayland.as_ref().and_then(Weak::upgrade) {
                                        Some(handle) => {
                                            match handle.set_all_outputs_power(OutputPowerMode::Off).await {
                                                Ok(()) => ActionCompletion::Succeeded,
                                                Err(error) => {
                                                    tracing::warn!(%error, "ScreenOff output-power failed");
                                                    ActionCompletion::Failed
                                                }
                                            }
                                        }
                                        None => ActionCompletion::Failed,
                                    };
                                    if let Some(svc) = session_weak.upgrade() {
                                        svc.complete_idle_action(action_id, outcome).await;
                                    }
                                }
                                Ok(IdleEffect::ResumeAction {
                                    action: IdleAction::ScreenOff,
                                    ..
                                }) => {
                                    if let Some(handle) = wayland.as_ref().and_then(Weak::upgrade)
                                        && let Err(error) = handle.set_all_outputs_power(OutputPowerMode::On).await
                                    {
                                        tracing::warn!(%error, "ScreenOff resume output-power failed");
                                    }
                                }
                                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                            }
                        }
                    }
                }
            }));
        }

        // 2. org.freedesktop.ScreenSaver per-connection cookie inhibition server.
        {
            let session_weak = Arc::downgrade(&session);
            let mut stop_ss = stop_rx.clone();
            tasks.push(runtime.spawn(async move {
                let registry = ScreenSaverRegistry::new();
                let mut changes = registry.subscribe();
                let server = tokio::select! {
                    biased;
                    _ = stop_ss.changed() => return,
                    res = ScreenSaverServer::connect_session(registry) => match res {
                        Ok(server) => server,
                        Err(error) => {
                            tracing::info!(%error, "org.freedesktop.ScreenSaver unavailable or owned by another daemon");
                            return;
                        }
                    }
                };
                let sync_session = session_weak.clone();
                let sync_task = tokio::spawn(async move {
                    while changes.changed().await.is_ok() {
                        let list = changes.borrow_and_update().clone();
                        if let Some(svc) = sync_session.upgrade() {
                            svc.sync_screensaver_inhibitors(list).await;
                        } else {
                            break;
                        }
                    }
                });
                tokio::select! {
                    biased;
                    _ = stop_ss.changed() => {}
                    res = server.monitor_disconnects() => {
                        if let Err(error) = res {
                            tracing::info!(%error, "ScreenSaver disconnect monitor ended");
                        }
                    }
                }
                sync_task.abort();
                if let Err(error) = server.shutdown().await {
                    tracing::debug!(%error, "ScreenSaver shutdown reported D-Bus error");
                }
                if let Some(svc) = session_weak.upgrade() {
                    svc.sync_screensaver_inhibitors(Vec::new()).await;
                }
            }));
        }

        // 3. systemd-logind delay inhibitor + PrepareForSleep + Session.Lock monitor.
        {
            let session_weak = Arc::downgrade(&session);
            let mut stop_logind = stop_rx;
            tasks.push(runtime.spawn(async move {
                let logind = tokio::select! {
                    biased;
                    _ = stop_logind.changed() => return,
                    res = sleep_inhibitor.get_or_connect() => match res {
                        Ok(logind) => logind,
                        Err(error) => {
                            tracing::info!(%error, "systemd-logind unavailable; sleep/lock signals inactive");
                            return;
                        }
                    }
                };
                if let Some(svc) = session_weak.upgrade()
                    && let Err(error) = svc.arm_sleep_delay().await
                {
                    tracing::info!(%error, "could not acquire initial logind sleep delay inhibitor");
                }
                let (tx, mut rx) = tokio::sync::mpsc::channel(16);
                let monitor = logind.monitor_events(tx);
                tokio::pin!(monitor);
                loop {
                    tokio::select! {
                        biased;
                        _ = stop_logind.changed() => break,
                        res = &mut monitor => {
                            if let Err(error) = res {
                                tracing::info!(%error, "logind event monitor stopped");
                            }
                            break;
                        }
                        maybe_event = rx.recv() => {
                            let Some(event) = maybe_event else {
                                break;
                            };
                            let Some(svc) = session_weak.upgrade() else {
                                break;
                            };
                            match event {
                                LogindEvent::PrepareForSleep => {
                                    svc.handle_sleep_signal(SleepSignal::PrepareForSleep).await;
                                }
                                LogindEvent::Wake => {
                                    svc.handle_sleep_signal(SleepSignal::Wake).await;
                                }
                                LogindEvent::SessionLock => {
                                    if let Err(error) = svc.request_lock().await {
                                        tracing::warn!(%error, "logind Session.Lock request failed");
                                    }
                                }
                            }
                        }
                    }
                }
                sleep_inhibitor.release();
            }));
        }

        Some(Self {
            stop,
            _wayland_idle: wayland_idle,
            tasks,
        })
    }
}

impl Drop for SessionRuntimeDrivers {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        for task in &self.tasks {
            task.abort();
        }
    }
}

struct CrossDomainBridge {
    hub: BusHub,
    client_id: u64,
    task: tokio::task::JoinHandle<()>,
}

impl CrossDomainBridge {
    fn start(
        hub: &BusHub,
        clipboard: Weak<ClipboardService>,
        session: Weak<SessionService>,
    ) -> Option<Self> {
        let runtime = tokio::runtime::Handle::try_current().ok()?;
        let (client_id, outbound) = hub.register_client(ClientRole::Public)?;
        hub.handle_inline_message(
            client_id,
            ClientMessage::request(
                RequestId::Number(1),
                methods::BUS_HELLO,
                Some(json!({ "protocol_version": PROTOCOL_VERSION })),
            ),
        );
        for (req_id, topic_name) in [(2_u64, LOCK_TOPIC), (3_u64, "desktop.media")] {
            hub.handle_inline_message(
                client_id,
                ClientMessage::request(
                    RequestId::Number(req_id),
                    methods::TOPIC_SUBSCRIBE,
                    Some(
                        serde_json::to_value(TopicSubscribeParams {
                            topic: topic(topic_name),
                        })
                        .expect("TopicSubscribeParams serializes"),
                    ),
                ),
            );
        }

        let task = runtime.spawn(async move {
            while let Some(line) = outbound.next_line().await {
                let Ok(message) = decode_server_line(&line) else {
                    continue;
                };
                let Some((topic_name, data)) = extract_topic_payload(message) else {
                    continue;
                };
                match topic_name.as_str() {
                    LOCK_TOPIC => {
                        let Some(clipboard) = clipboard.upgrade() else {
                            continue;
                        };
                        let phase = data
                            .get("phase")
                            .cloned()
                            .and_then(|value| serde_json::from_value::<LockPhaseName>(value).ok());
                        let locked =
                            matches!(phase, Some(LockPhaseName::Locked | LockPhaseName::Engaging));
                        clipboard.set_locked(if locked {
                            LockedState::Locked
                        } else {
                            LockedState::Unlocked
                        });
                    }
                    "desktop.media" => {
                        let Some(session) = session.upgrade() else {
                            continue;
                        };
                        let playing = data
                            .get("any_playing")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        session
                            .set_media_playing(if playing {
                                MediaPlayback::Playing
                            } else {
                                MediaPlayback::Idle
                            })
                            .await;
                    }
                    _ => {}
                }
            }
        });

        Some(Self {
            hub: hub.clone(),
            client_id,
            task,
        })
    }
}

impl Drop for CrossDomainBridge {
    fn drop(&mut self) {
        self.task.abort();
        self.hub.retire_client(self.client_id);
    }
}

fn extract_topic_payload(message: ServerMessage) -> Option<(String, Value)> {
    match message {
        ServerMessage::Ok { result, .. } => {
            let topic = result.get("topic")?.as_str()?.to_owned();
            let data = result.get("data")?.clone();
            Some((topic, data))
        }
        ServerMessage::Notification { method, params } if method == methods::TOPIC_UPDATE => {
            let topic = params.get("topic")?.as_str()?.to_owned();
            let data = params.get("data")?.clone();
            Some((topic, data))
        }
        _ => None,
    }
}
