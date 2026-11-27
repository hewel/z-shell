//! Desktop protocols for notifications, the system tray, MPRIS, Fcitx5, and the XDG launcher.
//!
//! Keep the [`DesktopHandle`] alive while serving these topics. Desktop bus
//! daemons use separate session D-Bus connections: a missing bus or a name
//! owned by another daemon does not prevent the XDG launcher running.
//!
//! ## Notifications
//!
//! `desktop.notifications` separates `popups` from retained `history`. Both
//! carry notification IDs, optional `desktop_entry` stems, `icon` (theme name
//! or media token), and `attachment` (media token or null). Only open
//! notifications retain invokable `actions` or match `replaces_id` /
//! `CloseNotification`; expired or popup-dismissed archived `history` entries
//! clear `actions` to `[]`. Locking immediately hides live `popups`, suppresses
//! toast delivery while locked, and denies `notifications.invoke-action`.
//! `notifications.dismiss` takes `{id}`, `notifications.invoke-action` takes
//! `{id, action_key, activation_token?}` (emitting `ActivationToken` ahead of
//! `ActionInvoked` when present), `notifications.clear` takes no payload, and
//! `notifications.set-dnd` takes `{dnd}`.
//!
//! `notifications.fetch-blob` and `tray.fetch-blob` take `{token}` and only
//! accept the host control channel. They return bounded PNG octets on demand
//! as `{mime, byte_len, bytes}`; topics never carry raw image bytes.
//!
//! ## System tray and media
//!
//! `desktop.tray` reports registered items (`has_menu` plus optional `icon` and
//! `DBusMenu` `menu` layouts with stripped mnemonics and `is_submenu` flags).
//! `tray.activate` takes `{id, x?, y?, activation_token?}` (returning
//! `{fallback_menu}`), `tray.context-menu` takes `{id, x?, y?}`,
//! `tray.prepare-menu` and `tray.close-menu` take `{id, menu_id?, timestamp?}`,
//! and `tray.menu-item` takes `{id, menu_id, timestamp?, activation_token?}`.
//! When `activation_token` is supplied, `ProvideXdgActivationToken` is sent on
//! the SNI item before the click action.
//!
//! `desktop.media` reports the MPRIS players, `selected_player_id`,
//! `any_playing`, and the selected player's `cover`. `media.play-pause`,
//! `media.next`, and `media.previous` act on the selected player or an explicit
//! `{player_id}`. `media.seek` additionally takes a relative `{offset_us}`.
//! `media.select-player` takes `{player_id}`; null restores automatic selection.
//!
//! ## Input method
//!
//! `[ime].mode = "indicator_only"` (default) leaves Fcitx5's native Wayland popup
//! in place. `"kimpanel"` opts into shell-owned composition; `"disabled"` leaves
//! both backends untouched. `candidate_layout` overrides the kimpanel layout
//! hint unless set to `"auto"`; `switch_osd` is a hint for UI hosts.
//!
//! `desktop.ime` carries input method status, properties, group entries, and
//! revisioned `exec_menu` requests. For switch OSDs, ignore source baselines and
//! compare `active_im`, `enabled`, and `properties` on live updates.
//! `desktop.ime.panel` carries live preedit, candidates, and the unmodified
//! spot rectangle. Relative coordinates require compositor-specific placement
//! information; fall back to a shell anchor when unavailable.
//!
//! `ime.toggle`, `ime.set-im {unique_name}`, `ime.reload-config`, and
//! `ime.configure` control Fcitx5. `ime.trigger-property {key}`,
//! `ime.select-candidate {index}`, `ime.page-up`, `ime.page-down`, and
//! `ime.move-caret {position}` require kimpanel. Locking clears composition
//! and denies all `ime.*` commands on the public bus channel.
//!
//! ## Apps and launcher
//!
//! The `desktop.apps` topic carries `{available, count, pinned_apps, apps}`. `apps.list`
//! pages `{items, total}` with optional `offset` and `limit`; `apps.launch` spawns an
//! installed catalog entry `{id, action_id?, activation_token?}` when unlocked; `apps.pin`
//! (host only) persists `{id, pinned}`.
//!
//! `launcher.query {query, query_id?, limit?}` returns `{query_id, items}`. IDs
//! increase per connection; a supplied ID must exceed the last accepted one.
//! Starting a newer query invalidates both the previous result and any outstanding
//! query. Results have `{provider_id, item_id, title, subtitle?, icon?, actions,
//! score, pinned?}`. Invoke `launcher.activate {query_id?, provider_id, item_id,
//! action_id?, activation_token?}` from the same connection. Omit `query_id` to use
//! the latest result, and `action_id` to use the default action.
//! Clients should correlate replies with the latest `query_id` before displaying them.
//!
//! A plugin invokes `launcher.register-provider {entry, prefix?}` on a persistent
//! bus connection and receives `{provider_id}`. `entry` is `author/plugin:entry`
//! attribution; the daemon assigns the actual provider identity. The owner may
//! unregister with `launcher.unregister-provider {provider_id}`. An empty prefix
//! matches all queries; otherwise it is matched literally at the start and
//! stripped along with any whitespace following it.
//!
//! Only the owning connection receives `launcher.provider-query` events with
//! `{request_id, query_id, provider_id, query, limit}` and
//! `launcher.provider-activate` events with
//! `{request_id, query_id, provider_id, item_id, action_id, activation_token?}`. It replies using
//! `launcher.provider-reply {request_id, items}` or `{request_id, activated}`,
//! respectively. Provider items accept `item_id`, `title`, optional `subtitle`,
//! optional `score` (0–1000), and optional `{action_id, title}` actions. IDs are
//! unique within each result or action list. A slow provider does not delay app
//! results beyond the shared query deadline. No command name is trusted for routing.

mod apps;
mod assets;
mod ime;
mod launcher;
mod media;
mod notifications;
mod tray;

use std::{
    future::Future,
    path::PathBuf,
    sync::{Arc, LazyLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    sync::{Notify, watch},
    task::JoinHandle,
    time,
};
use z_shell_bus::{BusHub, CommandCall, UpdateKind};
use z_shell_config::{ImeSettings, ShellPaths};
use z_shell_protocol::{CommandInvokeResult, CommandName, ErrorCode, RpcError, TopicName};
use zbus::{Connection, connection::Builder};

pub use ime::ImeLockState;

/// Session D-Bus endpoint used by the desktop daemons.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum SessionBusAddress {
    /// Resolve the session bus through zbus and the environment.
    #[default]
    Default,
    /// Connect to this explicit D-Bus address.
    Address(String),
    /// Do not attempt a session D-Bus connection.
    Disabled,
}

/// Network access policy for MPRIS cover art. Local assets work in both modes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum OfflinePolicy {
    /// Permit bounded HTTP and HTTPS cover requests.
    #[default]
    Online,
    /// Do not fetch remote covers.
    Offline,
}

/// Explicit toggle for optional desktop D-Bus name ownership.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ServiceToggle {
    /// Claim and serve the domain's session D-Bus well-known name.
    #[default]
    Enabled,
    /// Release the domain's well-known name without stopping other desktop services.
    Disabled,
}

impl ServiceToggle {
    fn is_enabled(self) -> bool {
        matches!(self, Self::Enabled)
    }
}

/// Overrides desktop sources and runtime policy for a daemon invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopOptions {
    /// Session D-Bus address for all D-Bus integrations.
    pub session_bus: SessionBusAddress,
    /// Allow this daemon to claim `org.freedesktop.Notifications`.
    pub notifications: bool,
    /// Allow this daemon to claim `org.kde.StatusNotifierWatcher`.
    pub tray: bool,
    /// Initial Fcitx5 integration settings; can be changed without restarting.
    pub ime: ImeSettings,
    /// Initial network access policy for media covers.
    pub offline_policy: OfflinePolicy,
    /// XDG data roots in precedence order (not their `applications` subdirectories).
    pub xdg_data_dirs: Vec<PathBuf>,
    /// Preferred icon theme, with XDG fallbacks.
    pub icon_theme: String,
}

impl Default for DesktopOptions {
    fn default() -> Self {
        Self {
            session_bus: SessionBusAddress::Default,
            notifications: true,
            tray: true,
            ime: ImeSettings::default(),
            offline_policy: OfflinePolicy::Online,
            xdg_data_dirs: apps::xdg_data_dirs(),
            icon_theme: apps::icon_theme(),
        }
    }
}

/// Installs desktop topics and their control commands on a bus hub.
#[derive(Debug)]
pub struct DesktopServices;

impl DesktopServices {
    /// Starts desktop integrations with sources resolved from the environment.
    ///
    /// # Panics
    ///
    /// Requires a Tokio runtime with time and I/O enabled.
    pub fn install(
        hub: &BusHub,
        paths: &ShellPaths,
        offline_policy: OfflinePolicy,
    ) -> DesktopHandle {
        Self::install_with_options(
            hub,
            paths,
            DesktopOptions {
                offline_policy,
                ..DesktopOptions::default()
            },
        )
    }

    /// Installs the desktop domains once per hub, with explicit sources and policies.
    ///
    /// The caller must prepare the private runtime media directory with
    /// [`ShellPaths::ensure_dirs`] before installation to enable cached media.
    ///
    /// # Panics
    ///
    /// Requires a Tokio runtime with time and I/O enabled.
    pub fn install_with_options(
        hub: &BusHub,
        paths: &ShellPaths,
        options: DesktopOptions,
    ) -> DesktopHandle {
        let (stop, running) = watch::channel(());
        let (launcher, launcher_watcher) = launcher::Launcher::install(
            hub,
            paths,
            options.session_bus.clone(),
            options.xdg_data_dirs.clone(),
            options.icon_theme.clone(),
            running.clone(),
        );
        let notifications = notifications::Notifications::install(
            hub,
            paths.media_dir(),
            options.xdg_data_dirs.clone(),
            options.icon_theme.clone(),
            Arc::clone(&launcher),
        );
        let ime_refresh = Arc::new(Notify::new());
        let tray = tray::Tray::install(
            hub,
            paths.media_dir(),
            options.xdg_data_dirs,
            options.icon_theme,
            Arc::clone(&ime_refresh),
        );
        let ime = ime::Ime::install(hub, options.ime, ime_refresh);
        let media = media::Media::install(hub, paths.media_dir(), options.offline_policy);

        let (notifications_enabled, notifications_setting) = watch::channel(options.notifications);
        let (tray_enabled, tray_setting) = watch::channel(options.tray);
        let mut workers = Vec::new();
        if let Some(watcher) = launcher_watcher {
            workers.push(watcher);
        }
        if options.session_bus != SessionBusAddress::Disabled {
            workers.extend([
                tokio::spawn(supervise(
                    DbusDomain::Notifications(Arc::clone(&notifications)),
                    options.session_bus.clone(),
                    running.clone(),
                    Some(notifications_setting),
                )),
                tokio::spawn(supervise(
                    DbusDomain::Tray(tray),
                    options.session_bus.clone(),
                    running.clone(),
                    Some(tray_setting),
                )),
                tokio::spawn(supervise(
                    DbusDomain::Media(media.clone()),
                    options.session_bus.clone(),
                    running.clone(),
                    None,
                )),
                tokio::spawn(Arc::clone(&ime).run(options.session_bus, running)),
            ]);
        }
        DesktopHandle {
            stop,
            workers,
            notifications_enabled,
            tray_enabled,
            notifications,
            ime,
            media,
            launcher,
        }
    }
}

/// Owns desktop monitoring, command handlers, and D-Bus name leases.
#[must_use = "dropping the handle stops desktop services"]
pub struct DesktopHandle {
    stop: watch::Sender<()>,
    workers: Vec<JoinHandle<()>>,
    notifications_enabled: watch::Sender<bool>,
    tray_enabled: watch::Sender<bool>,
    notifications: Arc<notifications::Notifications>,
    ime: Arc<ime::Ime>,
    media: Arc<media::Media>,
    launcher: Arc<launcher::Launcher>,
}

impl std::fmt::Debug for DesktopHandle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DesktopHandle")
            .field(
                "notifications_enabled",
                &*self.notifications_enabled.borrow(),
            )
            .field("tray_enabled", &*self.tray_enabled.borrow())
            .finish_non_exhaustive()
    }
}

impl DesktopHandle {
    /// Reports whether any MPRIS player is currently playing, independent of selection.
    #[must_use]
    pub fn is_any_playing(&self) -> bool {
        self.media.is_any_playing()
    }

    /// Applies network policy immediately to media cover work.
    pub fn set_offline_policy(&self, policy: OfflinePolicy) {
        self.media.set_offline_policy(policy);
    }

    /// Enables notification ownership or releases it asynchronously.
    pub fn set_notifications(&self, toggle: ServiceToggle) {
        set_enabled(&self.notifications_enabled, toggle.is_enabled());
    }

    /// Enables tray watcher ownership or releases it asynchronously.
    pub fn set_tray(&self, toggle: ServiceToggle) {
        set_enabled(&self.tray_enabled, toggle.is_enabled());
    }

    /// Applies Fcitx5 preferences and switches backend ownership asynchronously.
    pub fn set_ime_settings(&self, settings: ImeSettings) {
        self.ime.set_settings(settings);
    }

    /// Applies the session lock policy synchronously across IME, app launching, and notifications.
    pub fn set_locked(&self, state: ImeLockState) {
        self.ime.set_locked(state);
        self.launcher.set_locked(state);
        self.notifications.set_locked(state);
    }

    /// Applies the session privacy policy synchronously across desktop services.
    pub fn set_ime_locked(&self, state: ImeLockState) {
        self.set_locked(state);
    }

    /// Stops the integrations and waits until the session D-Bus connections are closed.
    pub async fn shutdown(mut self) {
        self.stop.send_replace(());
        for worker in std::mem::take(&mut self.workers) {
            if let Err(error) = worker.await {
                tracing::warn!(%error, "desktop worker stopped unexpectedly");
            }
        }
    }
}

impl Drop for DesktopHandle {
    fn drop(&mut self) {
        self.launcher.disconnected();
        self.stop.send_replace(());
    }
}

fn set_enabled(setting: &watch::Sender<bool>, enabled: bool) {
    setting.send_if_modified(|value| {
        if *value == enabled {
            return false;
        }
        *value = enabled;
        true
    });
}

enum DbusDomain {
    Notifications(Arc<notifications::Notifications>),
    Tray(Arc<tray::Tray>),
    Media(Arc<media::Media>),
}

impl DbusDomain {
    async fn run(&self, connection: &Connection) -> zbus::Result<()> {
        match self {
            Self::Notifications(service) => service.run(connection).await,
            Self::Tray(service) => service.run(connection).await,
            Self::Media(service) => service.run(connection).await,
        }
    }

    async fn release_name(&self, connection: &Connection) {
        let name = match self {
            Self::Notifications(_) => notifications::NAME,
            Self::Tray(_) => tray::WATCHER,
            Self::Media(_) => return,
        };
        let _ = connection.release_name(name).await;
    }

    fn disconnected(&self) {
        match self {
            Self::Notifications(service) => service.disconnected(),
            Self::Tray(service) => service.disconnected(),
            Self::Media(service) => service.disconnected(),
        }
    }
}

async fn setting_changed(setting: &mut Option<watch::Receiver<bool>>) {
    match setting {
        Some(setting) => {
            let _ = setting.changed().await;
        }
        None => std::future::pending::<()>().await,
    }
}

async fn supervise(
    domain: DbusDomain,
    address: SessionBusAddress,
    mut stop: watch::Receiver<()>,
    mut setting: Option<watch::Receiver<bool>>,
) {
    const RETRY: Duration = Duration::from_secs(2);
    loop {
        if setting
            .as_mut()
            .is_some_and(|setting| !*setting.borrow_and_update())
        {
            tokio::select! {
                biased;
                _ = stop.changed() => break,
                _ = setting_changed(&mut setting) => continue,
            }
        }
        let connection = tokio::select! {
            biased;
            _ = stop.changed() => break,
            _ = setting_changed(&mut setting) => continue,
            result = connect(&address) => result,
        };
        if let Some(connection) = connection {
            let stopped = tokio::select! {
                biased;
                _ = stop.changed() => true,
                _ = setting_changed(&mut setting) => false,
                result = domain.run(&connection) => {
                    if let Err(error) = result {
                        tracing::debug!(%error, "desktop D-Bus source unavailable");
                    }
                    false
                }
                _ = connection.closed() => false,
            };
            if !connection.is_closed() {
                domain.release_name(&connection).await;
            }
            // Closing the dedicated connection releases name leases even when an
            // in-flight object call or control command still holds a clone.
            let _ = connection.close().await;
            domain.disconnected();
            if stopped {
                break;
            }
        }
        tokio::select! {
            biased;
            _ = stop.changed() => break,
            _ = setting_changed(&mut setting) => {},
            _ = time::sleep(RETRY) => {},
        }
    }
}

async fn connect(address: &SessionBusAddress) -> Option<Connection> {
    let builder = match address {
        SessionBusAddress::Default => Builder::session(),
        SessionBusAddress::Address(address) => Builder::address(address.as_str()),
        SessionBusAddress::Disabled => return None,
    }
    .ok()?;
    time::timeout(
        Duration::from_secs(3),
        builder.method_timeout(Duration::from_secs(2)).build(),
    )
    .await
    .ok()?
    .ok()
}

fn publish(hub: &BusHub, topic: &'static str, state: &impl Serialize, kind: UpdateKind) {
    hub.publish_core_topic(
        TopicName::try_new(topic).expect("static desktop topic is valid"),
        serde_json::to_value(state).expect("desktop topic state serializes"),
        kind,
    );
}

fn register<S, F, Fut>(
    hub: &BusHub,
    state: &Arc<S>,
    name: &'static str,
    description: &'static str,
    run: F,
) where
    S: Send + Sync + 'static,
    F: Fn(Arc<S>, CommandCall) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<CommandInvokeResult, RpcError>> + Send + 'static,
{
    let state = Arc::downgrade(state);
    hub.register_core_command(
        CommandName::try_new(name).expect("static desktop command is valid"),
        description,
        Arc::new(move |call| {
            let future = state.upgrade().map(|state| run(state, call));
            Box::pin(async move {
                future
                    .ok_or_else(|| disabled("desktop service has stopped"))?
                    .await
            })
        }),
    );
}

fn payload<'a, T: Deserialize<'a>>(call: &'a CommandCall) -> Result<T, RpcError> {
    static EMPTY: LazyLock<Value> = LazyLock::new(|| Value::Object(serde_json::Map::new()));
    match (
        call.params.args.is_empty(),
        call.params.payload.as_ref().unwrap_or(&EMPTY),
    ) {
        (true, value @ Value::Object(_)) => {
            T::deserialize(value).map_err(|_| invalid("invalid command payload"))
        }
        _ => Err(invalid("expected a JSON object payload")),
    }
}

fn ok() -> CommandInvokeResult {
    CommandInvokeResult {
        message: None,
        data: None,
    }
}

fn data(value: Value) -> CommandInvokeResult {
    CommandInvokeResult {
        message: None,
        data: Some(value),
    }
}

fn invalid(reason: &'static str) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, reason)
}

fn disabled(reason: &'static str) -> RpcError {
    RpcError::new(ErrorCode::Disabled, reason)
}

fn failed(reason: &'static str) -> RpcError {
    RpcError::new(ErrorCode::Internal, reason)
}

fn not_found(reason: &'static str) -> RpcError {
    RpcError::new(ErrorCode::NotFound, reason)
}

const MAX_ACTIVATION_TOKEN_BYTES: usize = 256;

#[derive(Clone)]
pub(crate) struct ActivationToken(String);

impl std::fmt::Debug for ActivationToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ActivationToken([redacted])")
    }
}

impl ActivationToken {
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

pub(crate) fn parse_activation_token(
    raw: Option<String>,
) -> Result<Option<ActivationToken>, RpcError> {
    let Some(token) = raw else {
        return Ok(None);
    };
    if token.is_empty() {
        return Ok(None);
    }
    if token.len() > MAX_ACTIVATION_TOKEN_BYTES || token.bytes().any(|b| b <= 0x1f || b == 0x7f) {
        return Err(invalid(
            "activation_token exceeds 256 bytes or contains ASCII control characters",
        ));
    }
    Ok(Some(ActivationToken(token)))
}
