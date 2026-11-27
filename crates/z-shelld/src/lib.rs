//! Shell daemon (`z-shelld`) library entry point with serialized atomic state and trust tiers.

mod plugins;

use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::{Mutex as AsyncMutex, watch};
use tracing::info;
use z_shell_bus::{
    BusHub, BusLimits, BusServer, CommandCall, CommandHandler, ShutdownHandle, UpdateKind,
};
use z_shell_clipboard::{ClipboardService, History as ClipboardHistory, LockedState};
use z_shell_config::{ConfigStore, RuntimeState, ShellPaths, UserSettings};
use z_shell_desktop::{
    DesktopHandle, DesktopOptions, DesktopServices, ImeLockState, OfflinePolicy, SessionBusAddress,
};
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
    idle::{ActionCompletion, IdleAction, IdleEffect, MediaPlayback, SleepState},
    pam::PamHelperAuthenticator,
    polkit::{PolkitBus, PolkitEnabled, PolkitLockState, PolkitRegistration, PolkitService},
    screensaver::{ScreenSaverRegistry, ScreenSaverServer},
    service::SessionService,
    wayland_idle::{WaylandIdle, WaylandIdleDriver},
};
use z_shell_system::{SystemHandle, SystemServices};
use z_shell_theme::{GtkLinker, ThemeEngine};
use z_shell_wallpaper::{WallpaperLockState, WallpaperService, WallpaperSleepState};
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

// Taking the handle out lets shutdown await D-Bus lease release even if a command or
// bridge callback still has a temporary strong reference to the slot.
type DesktopSlot = Mutex<Option<DesktopHandle>>;

#[derive(Clone)]
struct SettingsTargets {
    store: Arc<ConfigStore>,
    desktop: Option<Weak<DesktopSlot>>,
    session: Weak<SessionService>,
    polkit: Weak<PolkitService>,
    wallpaper: Weak<WallpaperService>,
    plugins: Weak<plugins::PluginService>,
    theme: ThemeEngine,
}

/// D-Bus endpoint selection for daemon-managed D-Bus integrations.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum DaemonBus {
    /// Connect to the default system or session bus from the environment.
    #[default]
    Default,
    /// Connect to an explicit D-Bus address.
    Address(String),
    /// Disable the D-Bus integration.
    Disabled,
}

/// Runtime configuration overrides for [`DaemonApp::bootstrap_with_options`].
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct DaemonOptions {
    limits: BusLimits,
    pam_helper_path: Option<PathBuf>,
    logind_bus: DaemonBus,
    polkit_bus: DaemonBus,
    session_bus: DaemonBus,
    xdg_data_dirs: Option<Vec<PathBuf>>,
}

impl DaemonOptions {
    /// Creates default daemon bootstrap options.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets explicit [`BusLimits`] for public and host connections.
    #[must_use]
    pub fn with_limits(mut self, limits: BusLimits) -> Self {
        self.limits = limits;
        self
    }

    /// Overrides the standalone PAM helper executable path.
    #[must_use]
    pub fn with_pam_helper_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.pam_helper_path = Some(path.into());
        self
    }

    /// Overrides the D-Bus endpoint used for `systemd-logind`.
    #[must_use]
    pub fn with_logind_bus(mut self, bus: DaemonBus) -> Self {
        self.logind_bus = bus;
        self
    }

    /// Overrides the D-Bus endpoint used for Polkit agent registration.
    #[must_use]
    pub fn with_polkit_bus(mut self, bus: DaemonBus) -> Self {
        self.polkit_bus = bus;
        self
    }

    /// Overrides the session D-Bus endpoint used for desktop integrations.
    #[must_use]
    pub fn with_session_bus(mut self, bus: DaemonBus) -> Self {
        self.session_bus = bus;
        self
    }

    /// Overrides XDG data directories scanned by the desktop application catalog.
    #[must_use]
    pub fn with_xdg_data_dirs(mut self, dirs: Vec<PathBuf>) -> Self {
        self.xdg_data_dirs = Some(dirs);
        self
    }
}

/// Running daemon assembly owning the config store, bus hub, domain services, and dual Unix socket server.
pub struct DaemonApp {
    hub: BusHub,
    server: BusServer,
    wallpaper_theme: WallpaperThemeBridge,
    _wayland: Option<Arc<WaylandHandle>>,
    _system: Option<SystemHandle>,
    _clipboard: Arc<ClipboardService>,
    wallpaper: Arc<WallpaperService>,
    desktop: Option<Arc<DesktopSlot>>,
    session: Arc<SessionService>,
    session_drivers: Option<SessionRuntimeDrivers>,
    _polkit: Arc<PolkitService>,
    plugins: Arc<plugins::PluginService>,
    bridge: Option<CrossDomainBridge>,
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
        Self::bootstrap_with_options(paths, DaemonOptions::new().with_limits(limits))
    }

    /// Bootstraps the daemon with explicit [`DaemonOptions`].
    ///
    /// # Errors
    ///
    /// Returns an error if directories, configuration files, single-instance lock, or sockets fail.
    pub fn bootstrap_with_options(paths: ShellPaths, options: DaemonOptions) -> Result<Self> {
        let DaemonOptions {
            limits,
            pam_helper_path,
            logind_bus,
            polkit_bus,
            session_bus,
            xdg_data_dirs,
        } = options;
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
        let plugins_service = plugins::PluginService::install(&hub, paths.clone(), &settings);

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

        let (wallpaper_changes, updates) = watch::channel(None);
        let wallpaper = Arc::new(
            WallpaperService::new_deferred(
                store.as_ref().clone(),
                &settings.wallpaper,
                &runtime_state,
            )
            .with_shared_state(Arc::clone(&shared_state))
            .with_theme_sync(move |path| {
                wallpaper_changes.send_replace(Some(path));
            }),
        );
        wallpaper.install_on_bus(&hub);
        let mut wallpaper_theme = WallpaperThemeBridge {
            theme: theme.clone(),
            settings: Arc::clone(&shared_settings),
            pending: Some(updates),
            task: None,
        };
        wallpaper_theme.start();

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
            let session_bus = match session_bus {
                DaemonBus::Default => SessionBusAddress::Default,
                DaemonBus::Address(addr) => SessionBusAddress::Address(addr),
                DaemonBus::Disabled => SessionBusAddress::Disabled,
            };
            let mut desktop_options = DesktopOptions {
                session_bus,
                offline_policy,
                ime: settings.ime.clone(),
                ..DesktopOptions::default()
            };
            if let Some(dirs) = xdg_data_dirs {
                desktop_options.xdg_data_dirs = dirs;
            }
            let handle = DesktopServices::install_with_options(&hub, &paths, desktop_options);
            Arc::new(Mutex::new(Some(handle)))
        });

        let polkit = Arc::new(PolkitService::new(&settings.polkit));
        polkit.install_on_bus(&hub);

        let sleep_inhibitor = Arc::new(LazyLogindSleepInhibitor::new(logind_bus));
        let authenticator = Arc::new(PamHelperAuthenticator::resolve(pam_helper_path.as_deref()));
        let session = Arc::new(
            SessionService::new(
                hub.daemon_instance_id().to_owned(),
                authenticator,
                Arc::clone(&sleep_inhibitor) as Arc<dyn SleepInhibitor>,
                &settings.idle,
            )
            .with_lock_guard(CrossDomainBridge::lock_guard(
                Arc::downgrade(&clipboard),
                desktop.as_ref().map(Arc::downgrade),
                Arc::downgrade(&polkit),
                Arc::downgrade(&wallpaper),
            ))
            .with_sleep_guard({
                let wallpaper = Arc::downgrade(&wallpaper);
                move |state| {
                    if let Some(wallpaper) = wallpaper.upgrade() {
                        wallpaper.set_sleeping(match state {
                            SleepState::Awake => WallpaperSleepState::Awake,
                            SleepState::Sleeping => WallpaperSleepState::Sleeping,
                        });
                    }
                }
            }),
        );
        session.install_on_bus(&hub);

        let session_drivers = SessionRuntimeDrivers::start(
            Arc::clone(&session),
            sleep_inhibitor,
            wayland.as_ref().map(Arc::downgrade),
            &polkit,
            polkit_bus,
        );

        let bridge = CrossDomainBridge::start(&hub, Arc::downgrade(&session));

        register_core_commands(
            &hub,
            Arc::clone(&store),
            shared_settings,
            shared_state,
            SettingsTargets {
                store,
                desktop: desktop.as_ref().map(Arc::downgrade),
                session: Arc::downgrade(&session),
                polkit: Arc::downgrade(&polkit),
                wallpaper: Arc::downgrade(&wallpaper),
                plugins: Arc::downgrade(&plugins_service),
                theme,
            },
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
            wallpaper_theme,
            _wayland: wayland,
            _system: system,
            _clipboard: clipboard,
            wallpaper,
            desktop,
            session,
            session_drivers,
            _polkit: polkit,
            plugins: plugins_service,
            bridge,
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

    /// Runs the bus until shutdown, then releases the Polkit registration and desktop D-Bus leases.
    ///
    /// # Errors
    ///
    /// Returns an error if the underlying listener encounters a fatal I/O failure.
    pub async fn run(mut self) -> Result<()> {
        self.wallpaper_theme.start();
        let result = self.server.serve().await.context("serving z-shelld bus");
        self.plugins.shutdown();
        self.session.shutdown();
        drop(self.wallpaper);
        drop(self.wallpaper_theme);
        drop(self.bridge);
        if let Some(mut drivers) = self.session_drivers {
            drivers.shutdown_polkit().await;
        }
        let desktop = self
            .desktop
            .and_then(|slot| slot.lock().expect("desktop slot mutex poisoned").take());
        if let Some(desktop) = desktop {
            desktop.shutdown().await;
        }
        result
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

fn require_host_role(call: &CommandCall, action: &str) -> Result<(), RpcError> {
    if call.caller.role != ClientRole::PrivilegedHost {
        return Err(RpcError::new(
            ErrorCode::PermissionDenied,
            format!("{action} requires the privileged host control channel"),
        ));
    }
    Ok(())
}

async fn apply_and_publish_settings(
    hub: &BusHub,
    guard: &mut UserSettings,
    fresh: UserSettings,
    targets: &SettingsTargets,
    verb: &str,
) -> Result<CommandInvokeResult, RpcError> {
    if *guard == fresh {
        let data =
            serde_json::to_value(guard.public_summary()).expect("PublicSettingsSummary serializes");
        return Ok(CommandInvokeResult {
            message: Some("settings unchanged".to_owned()),
            data: Some(data),
        });
    }
    let old_offline = guard.general.offline_mode;
    let plugins_changed =
        guard.plugins != fresh.plugins || old_offline != fresh.general.offline_mode;
    let idle_changed = guard.idle != fresh.idle;
    let ime_changed = guard.ime != fresh.ime;
    let polkit_changed = guard.polkit != fresh.polkit;
    let wallpaper_changed = guard.wallpaper != fresh.wallpaper;
    let palette_changed = guard.theme.mode != fresh.theme.mode
        || guard.theme.variant != fresh.theme.variant
        || guard.theme.seed_color != fresh.theme.seed_color
        || guard.theme.backend != fresh.theme.backend
        || guard.theme.gtk_linking != fresh.theme.gtk_linking;
    let summary_changed = guard.public_summary() != fresh.public_summary();
    *guard = fresh.clone();
    let summary_json =
        serde_json::to_value(guard.public_summary()).expect("PublicSettingsSummary serializes");

    if plugins_changed && let Some(plugins) = targets.plugins.upgrade() {
        plugins.apply_settings(&fresh);
    }
    if (old_offline != fresh.general.offline_mode || ime_changed)
        && let Some(slot) = targets.desktop.as_ref().and_then(Weak::upgrade)
        && let Some(desktop) = slot.lock().expect("desktop slot mutex poisoned").as_ref()
    {
        if old_offline != fresh.general.offline_mode {
            desktop.set_offline_policy(if fresh.general.offline_mode {
                OfflinePolicy::Offline
            } else {
                OfflinePolicy::Online
            });
        }
        if ime_changed {
            desktop.set_ime_settings(fresh.ime.clone());
        }
    }
    if polkit_changed && let Some(polkit) = targets.polkit.upgrade() {
        polkit.set_enabled(PolkitEnabled::from(&fresh.polkit));
    }
    if idle_changed && let Some(session) = targets.session.upgrade() {
        session.apply_settings(&fresh.idle).await;
    }
    if wallpaper_changed
        && let Some(wallpaper) = targets.wallpaper.upgrade()
        && let Err(error) = wallpaper.apply_settings(&fresh.wallpaper).await
    {
        tracing::error!(%error, "wallpaper settings worker failed");
    }
    if palette_changed {
        let wallpaper_fallback = if fresh.theme.seed_color.is_none() && fresh.wallpaper.sync_theme {
            targets
                .store
                .load_state()
                .ok()
                .and_then(|state| state.last_wallpaper)
        } else {
            None
        };
        if let Err(error) = targets
            .theme
            .apply_settings(&fresh.theme, wallpaper_fallback)
            .await
        {
            tracing::error!(%error, "theme regeneration failed after settings update");
        }
    }

    let msg = if summary_changed {
        let rev = hub.publish_core_topic(
            topic(topics::SETTINGS),
            summary_json.clone(),
            UpdateKind::Live,
        );
        if old_offline != fresh.general.offline_mode {
            hub.publish_core_topic(
                topic(topics::DAEMON_STATUS),
                json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "daemon_instance_id": hub.daemon_instance_id(),
                    "offline_mode": fresh.general.offline_mode,
                }),
                UpdateKind::Live,
            );
        }
        format!("settings {verb} (revision {rev})")
    } else {
        format!("settings {verb} (private overrides updated)")
    };
    Ok(CommandInvokeResult {
        message: Some(msg),
        data: Some(summary_json),
    })
}

fn register_core_commands(
    hub: &BusHub,
    store: Arc<ConfigStore>,
    settings_cell: Arc<AsyncMutex<UserSettings>>,
    state_cell: Arc<AsyncMutex<RuntimeState>>,
    settings_targets: SettingsTargets,
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
        let targets = settings_targets.clone();
        let handler: CommandHandler = Arc::new(move |call: CommandCall| {
            let store_ref = Arc::clone(&store_ref);
            let settings_ref = Arc::clone(&settings_ref);
            let targets = targets.clone();
            Box::pin(async move {
                let mut guard = settings_ref.lock().await;
                let fresh = store_ref.load_settings().map_err(|err| {
                    RpcError::new(
                        ErrorCode::InvalidParams,
                        format!("failed to reload settings.toml: {err}"),
                    )
                })?;
                apply_and_publish_settings(&call.hub, &mut guard, fresh, &targets, "reloaded").await
            })
        });
        hub.register_core_command(
            cmd("settings.reload"),
            "Reload settings.toml from disk and broadcast public changes",
            handler,
        );
    }

    // settings.patch (privileged host only: lossless toml_edit patch + validate + atomic write + live apply)
    {
        let store_ref = Arc::clone(&store);
        let settings_ref = Arc::clone(&settings_cell);
        let targets = settings_targets.clone();
        let handler: CommandHandler = Arc::new(move |call: CommandCall| {
            let store_ref = Arc::clone(&store_ref);
            let settings_ref = Arc::clone(&settings_ref);
            let targets = targets.clone();
            Box::pin(async move {
                require_host_role(&call, "settings.patch")?;
                let patch = call
                    .params
                    .payload
                    .as_ref()
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        RpcError::new(
                            ErrorCode::InvalidParams,
                            "settings.patch requires a JSON object payload",
                        )
                    })?;
                let mut guard = settings_ref.lock().await;
                let fresh = store_ref.patch_settings(patch).map_err(|err| {
                    RpcError::new(
                        ErrorCode::InvalidParams,
                        format!("failed to patch settings.toml: {err}"),
                    )
                })?;
                apply_and_publish_settings(&call.hub, &mut guard, fresh, &targets, "updated").await
            })
        });
        hub.register_core_command(
            cmd("settings.patch"),
            "Patch settings.toml losslessly and apply changes live (privileged host only)",
            handler,
        );
    }

    // settings.patch-plugin (privileged host only: scoped lossless patch of [plugin_settings."<id>"])
    {
        let store_ref = Arc::clone(&store);
        let settings_ref = Arc::clone(&settings_cell);
        let targets = settings_targets;
        let handler: CommandHandler = Arc::new(move |call: CommandCall| {
            let store_ref = Arc::clone(&store_ref);
            let settings_ref = Arc::clone(&settings_ref);
            let targets = targets.clone();
            Box::pin(async move {
                require_host_role(&call, "settings.patch-plugin")?;
                let payload = call
                    .params
                    .payload
                    .as_ref()
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        RpcError::new(
                            ErrorCode::InvalidParams,
                            "settings.patch-plugin requires a JSON object payload",
                        )
                    })?;
                let raw_id = payload
                    .get("plugin_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RpcError::new(
                            ErrorCode::InvalidParams,
                            "settings.patch-plugin requires payload.plugin_id",
                        )
                    })?;
                let plugin_id = PluginId::try_new(raw_id).map_err(|err| {
                    RpcError::new(
                        ErrorCode::InvalidParams,
                        format!("invalid plugin_id: {err}"),
                    )
                })?;
                let patch = payload
                    .get("settings")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        RpcError::new(
                            ErrorCode::InvalidParams,
                            "settings.patch-plugin requires object payload.settings",
                        )
                    })?;
                let mut guard = settings_ref.lock().await;
                let fresh = store_ref
                    .patch_plugin_settings(&plugin_id, patch)
                    .map_err(|err| {
                        RpcError::new(
                            ErrorCode::InvalidParams,
                            format!("failed to patch plugin settings: {err}"),
                        )
                    })?;
                let plugin_value = fresh
                    .plugin_settings
                    .get(&plugin_id)
                    .map(|v| serde_json::to_value(v).expect("toml::Value serializes"))
                    .unwrap_or_else(|| json!({}));
                let _ =
                    apply_and_publish_settings(&call.hub, &mut guard, fresh, &targets, "updated")
                        .await?;
                Ok(CommandInvokeResult {
                    message: Some(format!("plugin settings updated for {plugin_id}")),
                    data: Some(json!({
                        "plugin_id": plugin_id,
                        "settings": plugin_value,
                    })),
                })
            })
        });
        hub.register_core_command(
            cmd("settings.patch-plugin"),
            "Patch one plugin's settings table in settings.toml (privileged host only)",
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

/// Initial retry delay when `systemd-logind` connection or inhibitor setup fails.
const LOGIND_BACKOFF_INITIAL: std::time::Duration = std::time::Duration::from_millis(250);
/// Upper bound on `systemd-logind` supervision exponential backoff.
const LOGIND_BACKOFF_MAX: std::time::Duration = std::time::Duration::from_secs(10);
/// Minimum healthy `monitor_events` span that resets the supervision backoff to `LOGIND_BACKOFF_INITIAL`.
const LOGIND_HEALTHY_UPTIME: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Debug)]
struct LazyLogindSleepInhibitor {
    bus: DaemonBus,
    inner: Mutex<Option<Arc<LogindSleepInhibitor>>>,
    connect_lock: AsyncMutex<()>,
}

impl LazyLogindSleepInhibitor {
    fn new(bus: DaemonBus) -> Self {
        Self {
            bus,
            inner: Mutex::new(None),
            connect_lock: AsyncMutex::new(()),
        }
    }

    fn is_disabled(&self) -> bool {
        self.bus == DaemonBus::Disabled
    }

    fn current(&self) -> Option<Arc<LogindSleepInhibitor>> {
        self.inner
            .lock()
            .expect("logind inhibitor slot poisoned")
            .clone()
    }

    async fn ensure_connected(&self) -> Result<Arc<LogindSleepInhibitor>, SleepInhibitorError> {
        if self.is_disabled() {
            return Err(SleepInhibitorError::new("systemd-logind disabled"));
        }
        if let Some(existing) = self.current()
            && existing.is_connected()
        {
            return Ok(existing);
        }
        let _guard = self.connect_lock.lock().await;
        if let Some(existing) = self.current() {
            if existing.is_connected() {
                return Ok(existing);
            }
            match &self.bus {
                DaemonBus::Default => existing.reconnect_system().await?,
                DaemonBus::Address(addr) => existing.reconnect_address(addr).await?,
                DaemonBus::Disabled => {
                    return Err(SleepInhibitorError::new("systemd-logind disabled"));
                }
            }
            return Ok(existing);
        }
        let connected = match &self.bus {
            DaemonBus::Default => LogindSleepInhibitor::connect_system().await?,
            DaemonBus::Address(addr) => LogindSleepInhibitor::connect_address(addr).await?,
            DaemonBus::Disabled => {
                return Err(SleepInhibitorError::new("systemd-logind disabled"));
            }
        };
        let shared = Arc::new(connected);
        *self.inner.lock().expect("logind inhibitor slot poisoned") = Some(Arc::clone(&shared));
        Ok(shared)
    }
}

impl SleepInhibitor for LazyLogindSleepInhibitor {
    fn acquire(&self) -> InhibitorFuture<'_> {
        Box::pin(async move { self.ensure_connected().await?.acquire().await })
    }

    fn release(&self) {
        if let Some(inhibitor) = self.current() {
            inhibitor.release();
        }
    }

    fn is_held(&self) -> bool {
        self.current().is_some_and(|inhibitor| inhibitor.is_held())
    }

    fn acquire_sleep_block(&self, reason: &str) -> InhibitorFuture<'_> {
        let reason = reason.to_owned();
        Box::pin(async move {
            self.ensure_connected()
                .await?
                .acquire_sleep_block(&reason)
                .await
        })
    }

    fn release_sleep_block(&self) {
        if let Some(inhibitor) = self.current() {
            inhibitor.release_sleep_block();
        }
    }

    fn is_sleep_block_held(&self) -> bool {
        self.current()
            .is_some_and(|inhibitor| inhibitor.is_sleep_block_held())
    }

    fn suspend(&self) -> InhibitorFuture<'_> {
        Box::pin(async move { self.ensure_connected().await?.suspend().await })
    }
}

struct SessionRuntimeDrivers {
    stop: watch::Sender<bool>,
    sleep_inhibitor: Arc<LazyLogindSleepInhibitor>,
    _wayland_idle: Option<WaylandIdleDriver>,
    polkit: Option<PolkitRegistration>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl SessionRuntimeDrivers {
    fn start(
        session: Arc<SessionService>,
        sleep_inhibitor: Arc<LazyLogindSleepInhibitor>,
        wayland: Option<Weak<WaylandHandle>>,
        polkit: &Arc<PolkitService>,
        polkit_bus: DaemonBus,
    ) -> Option<Self> {
        let runtime = tokio::runtime::Handle::try_current().ok()?;
        let (stop, stop_rx) = watch::channel(false);
        let polkit = match polkit_bus {
            DaemonBus::Default => Some(polkit.start_registration(PolkitBus::System, &runtime)),
            DaemonBus::Address(addr) => {
                Some(polkit.start_registration(PolkitBus::Address(addr), &runtime))
            }
            DaemonBus::Disabled => None,
        };

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

        // 3. Supervised systemd-logind delay & block inhibitors + PrepareForSleep + Session.Lock monitor.
        if !sleep_inhibitor.is_disabled() {
            let session_weak = Arc::downgrade(&session);
            let sleep_inhibitor_task = Arc::clone(&sleep_inhibitor);
            let mut stop_logind = stop_rx;
            tasks.push(runtime.spawn(async move {
                let mut backoff = LOGIND_BACKOFF_INITIAL;
                loop {
                    if *stop_logind.borrow() || session_weak.strong_count() == 0 {
                        break;
                    }

                    let logind = tokio::select! {
                        biased;
                        _ = stop_logind.changed() => break,
                        res = sleep_inhibitor_task.ensure_connected() => match res {
                            Ok(logind) => logind,
                            Err(error) => {
                                tracing::debug!(%error, ?backoff, "systemd-logind unavailable; retrying with backoff");
                                tokio::select! {
                                    biased;
                                    _ = stop_logind.changed() => break,
                                    () = tokio::time::sleep(backoff) => {}
                                }
                                backoff = backoff.saturating_mul(2).min(LOGIND_BACKOFF_MAX);
                                continue;
                            }
                        }
                    };

                    let armed = if let Some(svc) = session_weak.upgrade() {
                        let delay_ok = if svc.lock_snapshot().sleep_hold {
                            true
                        } else {
                            match tokio::select! {
                                biased;
                                _ = stop_logind.changed() => break,
                                res = svc.arm_sleep_delay() => res,
                            } {
                                Ok(()) => true,
                                Err(error) => {
                                    tracing::debug!(%error, ?backoff, "could not acquire logind sleep delay inhibitor; retrying");
                                    false
                                }
                            }
                        };
                        tokio::select! {
                            biased;
                            _ = stop_logind.changed() => break,
                            () = svc.sync_sleep_block_inhibitor() => {}
                        }
                        delay_ok
                    } else {
                        break;
                    };

                    if !armed {
                        tokio::select! {
                            biased;
                            _ = stop_logind.changed() => break,
                            () = tokio::time::sleep(backoff) => {}
                        }
                        backoff = backoff.saturating_mul(2).min(LOGIND_BACKOFF_MAX);
                        continue;
                    }

                    let monitor_started = tokio::time::Instant::now();
                    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
                    let monitor = logind.monitor_events(tx);
                    tokio::pin!(monitor);
                    let mut stop_requested = false;
                    loop {
                        tokio::select! {
                            biased;
                            _ = stop_logind.changed() => {
                                stop_requested = true;
                                break;
                            }
                            res = &mut monitor => {
                                if let Err(error) = res {
                                    tracing::info!(%error, "logind event monitor ended; scheduling reconnect");
                                }
                                break;
                            }
                            maybe_event = rx.recv() => {
                                let Some(event) = maybe_event else {
                                    break;
                                };
                                let Some(svc) = session_weak.upgrade() else {
                                    stop_requested = true;
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

                    if stop_requested || *stop_logind.borrow() || session_weak.strong_count() == 0 {
                        break;
                    }
                    if monitor_started.elapsed() >= LOGIND_HEALTHY_UPTIME {
                        backoff = LOGIND_BACKOFF_INITIAL;
                    }
                    tokio::select! {
                        biased;
                        _ = stop_logind.changed() => break,
                        () = tokio::time::sleep(backoff) => {}
                    }
                    backoff = backoff.saturating_mul(2).min(LOGIND_BACKOFF_MAX);
                }
                sleep_inhibitor_task.release();
                sleep_inhibitor_task.release_sleep_block();
            }));
        }

        Some(Self {
            stop,
            sleep_inhibitor,
            _wayland_idle: wayland_idle,
            polkit,
            tasks,
        })
    }

    async fn shutdown_polkit(&mut self) {
        if let Some(polkit) = self.polkit.take() {
            polkit.shutdown().await;
        }
    }
}

impl Drop for SessionRuntimeDrivers {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
        for task in &self.tasks {
            task.abort();
        }
        self.sleep_inhibitor.release();
        self.sleep_inhibitor.release_sleep_block();
    }
}

struct CrossDomainBridge {
    hub: BusHub,
    client_id: u64,
    task: tokio::task::JoinHandle<()>,
}

impl CrossDomainBridge {
    fn lock_guard(
        clipboard: Weak<ClipboardService>,
        desktop: Option<Weak<DesktopSlot>>,
        polkit: Weak<PolkitService>,
        wallpaper: Weak<WallpaperService>,
    ) -> impl Fn(LockPhaseName) {
        // Apply privacy changes before publishing the lock transition, not through a subscriber.
        move |phase| {
            let (ime, clip, polkit_lock, wallpaper_lock) = match phase {
                LockPhaseName::Unlocked | LockPhaseName::FallbackSpawned => (
                    ImeLockState::Unlocked,
                    LockedState::Unlocked,
                    PolkitLockState::Unlocked,
                    WallpaperLockState::Unlocked,
                ),
                LockPhaseName::Locked | LockPhaseName::Engaging => (
                    ImeLockState::Locked,
                    LockedState::Locked,
                    PolkitLockState::Locked,
                    WallpaperLockState::Locked,
                ),
            };
            if let Some(polkit) = polkit.upgrade() {
                polkit.set_locked(polkit_lock);
            }
            if let Some(slot) = desktop.as_ref().and_then(Weak::upgrade)
                && let Some(desktop) = slot.lock().expect("desktop slot mutex poisoned").as_ref()
            {
                desktop.set_locked(ime);
            }
            if let Some(clipboard) = clipboard.upgrade() {
                clipboard.set_locked(clip);
            }
            if let Some(wallpaper) = wallpaper.upgrade() {
                wallpaper.set_locked(wallpaper_lock);
            }
        }
    }

    fn start(hub: &BusHub, session: Weak<SessionService>) -> Option<Self> {
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
        hub.handle_inline_message(
            client_id,
            ClientMessage::request(
                RequestId::Number(2),
                methods::TOPIC_SUBSCRIBE,
                Some(
                    serde_json::to_value(TopicSubscribeParams {
                        topic: topic("desktop.media"),
                    })
                    .expect("TopicSubscribeParams serializes"),
                ),
            ),
        );

        let task = runtime.spawn(async move {
            while let Some(line) = outbound.next_line().await {
                let Ok(message) = decode_server_line(&line) else {
                    continue;
                };
                let Some(playing) = media_playing(message) else {
                    continue;
                };
                let Some(session) = session.upgrade() else {
                    break;
                };
                session.set_media_playing(playing).await;
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

fn media_playing(message: ServerMessage) -> Option<MediaPlayback> {
    let frame = match message {
        ServerMessage::Ok { result, .. } => result,
        ServerMessage::Notification { method, params } if method == methods::TOPIC_UPDATE => params,
        _ => return None,
    };
    if frame.get("topic")?.as_str()? != "desktop.media" {
        return None;
    }
    Some(if frame.get("data")?.get("any_playing")?.as_bool()? {
        MediaPlayback::Playing
    } else {
        MediaPlayback::Idle
    })
}

struct WallpaperThemeBridge {
    theme: ThemeEngine,
    settings: Arc<AsyncMutex<UserSettings>>,
    pending: Option<watch::Receiver<Option<PathBuf>>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl WallpaperThemeBridge {
    fn start(&mut self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let Some(mut updates) = self.pending.take() else {
            return;
        };
        let theme = self.theme.clone();
        let settings = Arc::clone(&self.settings);
        self.task = Some(runtime.spawn(async move {
            // A single consumer preserves assignment order; a slow backend can coalesce
            // pending changes rather than building up one generation job per assignment.
            while updates.changed().await.is_ok() {
                let path = updates.borrow_and_update().clone();
                let Some(path) = path else { continue };
                let theme_settings = {
                    let settings = settings.lock().await;
                    if !settings.wallpaper.sync_theme || settings.theme.seed_color.is_some() {
                        continue;
                    }
                    settings.theme.clone()
                };
                if let Err(error) = theme.generate_wallpaper(path, &theme_settings).await {
                    tracing::warn!(%error, "wallpaper theme generation failed");
                }
            }
        }));
    }
}

impl Drop for WallpaperThemeBridge {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
