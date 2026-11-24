use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{
    sync::{Notify, Semaphore},
    time::{self, Instant},
};
use z_shell_bus::{BusHub, CommandCall, UpdateKind};
use z_shell_protocol::{CommandInvokeResult, ErrorCode, MAX_SAFE_JS_INT, MediaRef, RpcError};
use zbus::{
    Connection,
    fdo::{self, RequestNameFlags, RequestNameReply},
    zvariant::{OwnedValue, Structure, Value},
};

use crate::{
    apps,
    assets::{
        Blobs, ImageDimensions, MAX_IMAGE_BYTES, cache_icon_with_dimensions,
        cache_image_with_dimensions, local_path, png_rgba, read_bounded,
    },
    failed,
    launcher::Launcher,
    ok, payload, publish, register,
};

const TOPIC: &str = "desktop.notifications";
pub(crate) const NAME: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const HISTORY_LIMIT: usize = 100;
const MAX_BODY_BYTES: usize = 2048;
const MAX_BODY_SCAN_BYTES: usize = 16 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 5000;
const RESUME_MIN_GRACE: Duration = Duration::from_millis(2000);
const EXPIRED: u32 = 1;
const DISMISSED: u32 = 2;
const CLOSED_BY_CLIENT: u32 = 3;
const UNDEFINED: u32 = 4;

pub(crate) struct Notifications {
    hub: BusHub,
    state: Mutex<State>,
    timer_changed: Notify,
    media_dir: PathBuf,
    xdg_data_dirs: Vec<PathBuf>,
    icon_theme: String,
    launcher: Arc<Launcher>,
    image_work: Arc<Semaphore>,
}

#[derive(Default)]
struct State {
    epoch: u64,
    connection: Option<Connection>,
    next_id: u32,
    next_revision: u64,
    dnd: bool,
    paused: bool,
    history: VecDeque<Entry>,
    blobs: Blobs,
}

struct Entry {
    notification: Notification,
    popup: bool,
    lifetime: Lifetime,
}

enum Lifetime {
    Closed,
    Persistent,
    Deadline {
        at: Instant,
        original: Duration,
    },
    Paused {
        remaining: Duration,
        original: Duration,
    },
}

impl Lifetime {
    fn is_open(&self) -> bool {
        !matches!(self, Self::Closed)
    }

    fn deadline(&self) -> Option<Instant> {
        match self {
            Self::Deadline { at, .. } => Some(*at),
            Self::Closed | Self::Persistent | Self::Paused { .. } => None,
        }
    }
}

#[derive(Serialize)]
struct Notification {
    id: u32,
    revision: u64,
    app_name: String,
    summary: String,
    body: String,
    icon: Option<NotificationMedia>,
    attachment: Option<NotificationMedia>,
    actions: Vec<Action>,
    urgency: u8,
}

#[derive(Clone, Serialize)]
struct NotificationMedia {
    #[serde(flatten)]
    media: MediaRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    dimensions: Option<ImageDimensions>,
}

#[derive(Serialize)]
struct Action {
    key: String,
    label: String,
}

#[derive(Debug, thiserror::Error)]
enum NotificationError {
    #[error("notification daemon is unavailable")]
    Unavailable,
    #[error("unknown notification")]
    Unknown,
    #[error("unknown notification action")]
    UnknownAction,
}

impl From<NotificationError> for RpcError {
    fn from(error: NotificationError) -> Self {
        let code = match error {
            NotificationError::Unavailable => ErrorCode::Disabled,
            NotificationError::Unknown | NotificationError::UnknownAction => ErrorCode::NotFound,
        };
        Self::new(code, error.to_string())
    }
}

impl Notifications {
    pub(crate) fn install(
        hub: &BusHub,
        media_dir: PathBuf,
        xdg_data_dirs: Vec<PathBuf>,
        icon_theme: String,
        launcher: Arc<Launcher>,
    ) -> Arc<Self> {
        let service = Arc::new(Self {
            hub: hub.clone(),
            state: Mutex::new(State::default()),
            timer_changed: Notify::new(),
            media_dir,
            xdg_data_dirs,
            icon_theme,
            launcher,
            image_work: Arc::new(Semaphore::new(2)),
        });
        service.publish(&service.state(), UpdateKind::SourceBaseline);
        register(
            hub,
            &service,
            "notifications.dismiss",
            "Dismiss a notification",
            Self::dismiss,
        );
        register(
            hub,
            &service,
            "notifications.clear",
            "Clear notification history",
            Self::clear,
        );
        register(
            hub,
            &service,
            "notifications.invoke-action",
            "Invoke a notification action",
            Self::invoke_action,
        );
        register(
            hub,
            &service,
            "notifications.set-dnd",
            "Set notification Do Not Disturb",
            Self::set_dnd,
        );
        register(
            hub,
            &service,
            "notifications.set-paused",
            "Pause or resume active notification popup auto-expiry",
            Self::set_paused,
        );
        register(
            hub,
            &service,
            "notifications.fetch-blob",
            "Pull a notification attachment on the host channel",
            |service, call| async move { service.state().blobs.fetch(&call) },
        );
        service
    }

    pub(crate) async fn run(self: &Arc<Self>, connection: &Connection) -> zbus::Result<()> {
        let epoch = {
            let mut state = self.state();
            state.epoch += 1;
            state.epoch
        };
        connection
            .object_server()
            .at(
                PATH,
                Interface {
                    service: Arc::downgrade(self),
                    epoch,
                },
            )
            .await?;
        let name = connection
            .request_name_with_flags(NAME, RequestNameFlags::DoNotQueue.into())
            .await?;
        if !matches!(
            name,
            RequestNameReply::PrimaryOwner | RequestNameReply::AlreadyOwner
        ) {
            return Err(zbus::Error::NameTaken);
        }
        {
            let mut state = self.state();
            state.connection = Some(connection.clone());
            self.publish(&state, UpdateKind::SourceBaseline);
        }
        loop {
            let next = self
                .state()
                .history
                .iter()
                .filter_map(|entry| entry.lifetime.deadline())
                .min();
            let Some(next) = next else {
                self.timer_changed.notified().await;
                continue;
            };
            tokio::select! {
                _ = self.timer_changed.notified() => {},
                _ = time::sleep_until(next) => {
                    for id in self.expire() {
                        emit_closed(connection, id, EXPIRED).await;
                    }
                },
            }
        }
    }

    pub(crate) fn disconnected(&self) {
        let mut state = self.state();
        if state.connection.take().is_some() {
            state.paused = false;
            state.history.clear();
            state.blobs = Blobs::default();
            self.publish(&state, UpdateKind::Live);
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("notification state lock poisoned")
    }

    fn publish(&self, state: &State, kind: UpdateKind) {
        #[derive(Serialize)]
        struct Snapshot<'a> {
            available: bool,
            dnd: bool,
            popups: Vec<&'a Notification>,
            history: Vec<&'a Notification>,
        }
        publish(
            &self.hub,
            TOPIC,
            &Snapshot {
                available: state.connection.is_some(),
                dnd: state.dnd,
                popups: state
                    .history
                    .iter()
                    .filter(|entry| entry.popup)
                    .map(|entry| &entry.notification)
                    .collect(),
                history: state
                    .history
                    .iter()
                    .map(|entry| &entry.notification)
                    .collect(),
            },
            kind,
        );
    }

    fn receive(
        &self,
        incoming: Incoming,
        epoch: u64,
    ) -> Result<(u32, Option<u32>), NotificationError> {
        let mut state = self.state();
        if state.epoch != epoch || state.connection.is_none() {
            return Err(NotificationError::Unavailable);
        }
        let id = if let Some(index) = state
            .history
            .iter()
            .position(|entry| entry.notification.id == incoming.replaces)
        {
            state.remove(index).notification.id
        } else {
            state.allocate_id()
        };
        let evicted = if state.history.len() == HISTORY_LIMIT {
            let oldest = state.remove(HISTORY_LIMIT - 1);
            oldest.lifetime.is_open().then_some(oldest.notification.id)
        } else {
            None
        };
        state.next_revision = (state.next_revision % MAX_SAFE_JS_INT) + 1;
        let revision = state.next_revision;
        let attachment = match incoming.attachment {
            Some(Attachment::Png { bytes, dimensions }) => {
                state
                    .blobs
                    .insert_png(bytes)
                    .map(|media| NotificationMedia {
                        media,
                        dimensions: Some(dimensions),
                    })
            }
            Some(Attachment::Cached(mut media)) => {
                if let MediaRef::RuntimePath {
                    revision: image_revision,
                    ..
                } = &mut media.media
                {
                    *image_revision = revision;
                }
                Some(media)
            }
            None => None,
        };
        let popup = !state.dnd;
        let paused = state.paused;
        state.history.push_front(Entry {
            popup,
            lifetime: incoming.timeout.map_or(Lifetime::Persistent, |duration| {
                if paused {
                    Lifetime::Paused {
                        remaining: duration,
                        original: duration,
                    }
                } else {
                    Lifetime::Deadline {
                        at: Instant::now() + duration,
                        original: duration,
                    }
                }
            }),
            notification: Notification {
                id,
                revision,
                app_name: incoming.app_name,
                summary: incoming.summary,
                body: incoming.body,
                icon: incoming.icon,
                attachment,
                actions: incoming.actions,
                urgency: incoming.urgency,
            },
        });
        self.publish(&state, UpdateKind::Live);
        self.timer_changed.notify_one();
        Ok((id, evicted))
    }

    fn expire(&self) -> Vec<u32> {
        let mut state = self.state();
        if state.paused {
            return Vec::new();
        }
        let mut closed = Vec::new();
        let now = Instant::now();
        let mut popup_changed = false;
        for entry in &mut state.history {
            if entry.lifetime.deadline().is_some_and(|when| when <= now) {
                popup_changed |= entry.popup;
                entry.popup = false;
                entry.lifetime = Lifetime::Closed;
                closed.push(entry.notification.id);
            }
        }
        if popup_changed {
            self.publish(&state, UpdateKind::Live);
        }
        closed
    }

    fn remove(&self, id: u32, epoch: Option<u64>) -> Result<Option<Connection>, NotificationError> {
        let mut state = self.state();
        if epoch.is_some_and(|epoch| epoch != state.epoch) || state.connection.is_none() {
            return Err(NotificationError::Unavailable);
        }
        let index = state
            .history
            .iter()
            .position(|entry| entry.notification.id == id)
            .ok_or(NotificationError::Unknown)?;
        let removed = state.remove(index);
        self.publish(&state, UpdateKind::Live);
        self.timer_changed.notify_one();
        Ok(state
            .connection
            .as_ref()
            .filter(|_| removed.lifetime.is_open())
            .cloned())
    }

    async fn dismiss(self: Arc<Self>, call: CommandCall) -> Result<CommandInvokeResult, RpcError> {
        #[derive(Deserialize)]
        struct Dismiss {
            id: u32,
        }
        let Dismiss { id } = payload(&call)?;
        if let Some(connection) = self.remove(id, None)? {
            emit_closed(&connection, id, DISMISSED).await;
        }
        Ok(ok())
    }

    async fn clear(self: Arc<Self>, call: CommandCall) -> Result<CommandInvokeResult, RpcError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Clear {}
        let _: Clear = payload(&call)?;
        let (closed, connection) = {
            let mut state = self.state();
            if state.history.is_empty() {
                return Ok(ok());
            }
            let closed = state
                .history
                .drain(..)
                .filter(|entry| entry.lifetime.is_open())
                .map(|entry| entry.notification.id)
                .collect::<Vec<_>>();
            state.blobs = Blobs::default();
            self.publish(&state, UpdateKind::Live);
            self.timer_changed.notify_one();
            (closed, state.connection.clone())
        };
        if let Some(connection) = connection {
            for id in closed {
                emit_closed(&connection, id, DISMISSED).await;
            }
        }
        Ok(ok())
    }

    async fn invoke_action(
        self: Arc<Self>,
        call: CommandCall,
    ) -> Result<CommandInvokeResult, RpcError> {
        #[derive(Deserialize)]
        struct Invoke<'a> {
            id: u32,
            action_key: &'a str,
        }
        let Invoke { id, action_key } = payload(&call)?;
        let connection = {
            let state = self.state();
            let entry = state
                .history
                .iter()
                .find(|entry| entry.notification.id == id && entry.lifetime.is_open())
                .ok_or(NotificationError::Unknown)?;
            if !entry
                .notification
                .actions
                .iter()
                .any(|action| action.key == action_key)
            {
                return Err(NotificationError::UnknownAction.into());
            }
            state
                .connection
                .clone()
                .ok_or(NotificationError::Unavailable)?
        };
        Interface::action_invoked(&signal_emitter(&connection)?, id, action_key)
            .await
            .map_err(|error| {
                tracing::debug!(%error, id, "failed to emit Notification ActionInvoked");
                failed("cannot signal notification action")
            })?;
        Ok(ok())
    }

    async fn set_dnd(self: Arc<Self>, call: CommandCall) -> Result<CommandInvokeResult, RpcError> {
        #[derive(Deserialize)]
        struct SetDnd {
            dnd: bool,
        }
        let SetDnd { dnd } = payload(&call)?;
        let mut state = self.state();
        if state.dnd != dnd {
            state.dnd = dnd;
            if dnd {
                for entry in &mut state.history {
                    entry.popup = false;
                }
            }
            self.publish(&state, UpdateKind::Live);
        }
        Ok(ok())
    }

    async fn set_paused(
        self: Arc<Self>,
        call: CommandCall,
    ) -> Result<CommandInvokeResult, RpcError> {
        #[derive(Deserialize)]
        struct SetPaused {
            paused: bool,
        }
        let SetPaused { paused } = payload(&call)?;
        let mut state = self.state();
        if state.paused == paused {
            return Ok(ok());
        }
        state.paused = paused;
        let now = Instant::now();
        for entry in &mut state.history {
            if paused {
                if let Lifetime::Deadline { at, original } = entry.lifetime {
                    entry.lifetime = Lifetime::Paused {
                        remaining: at.saturating_duration_since(now),
                        original,
                    };
                }
            } else if let Lifetime::Paused {
                remaining,
                original,
            } = entry.lifetime
            {
                let grace = original.min(RESUME_MIN_GRACE);
                let effective = remaining.max(grace);
                entry.lifetime = Lifetime::Deadline {
                    at: now + effective,
                    original,
                };
            }
        }
        self.timer_changed.notify_one();
        Ok(ok())
    }
}

impl State {
    fn allocate_id(&mut self) -> u32 {
        loop {
            self.next_id = self.next_id.wrapping_add(1).max(1);
            if !self
                .history
                .iter()
                .any(|entry| entry.notification.id == self.next_id)
            {
                return self.next_id;
            }
        }
    }

    fn remove(&mut self, index: usize) -> Entry {
        let entry = self
            .history
            .remove(index)
            .expect("notification index is in bounds");
        self.blobs
            .revoke(entry.notification.attachment.as_ref().map(|a| &a.media));
        entry
    }
}

struct Incoming {
    replaces: u32,
    app_name: String,
    summary: String,
    body: String,
    icon: Option<NotificationMedia>,
    attachment: Option<Attachment>,
    actions: Vec<Action>,
    urgency: u8,
    timeout: Option<Duration>,
}

enum Attachment {
    Png {
        bytes: Vec<u8>,
        dimensions: ImageDimensions,
    },
    Cached(NotificationMedia),
}

struct Interface {
    service: Weak<Notifications>,
    epoch: u64,
}

#[zbus::interface(name = "org.freedesktop.Notifications")]
impl Interface {
    fn get_capabilities(&self) -> Vec<&'static str> {
        vec!["actions", "body", "icon-static", "persistence"]
    }

    fn get_server_information(&self) -> (&'static str, &'static str, &'static str, &'static str) {
        ("z-shell", "z-shell", env!("CARGO_PKG_VERSION"), "1.2")
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "fixed org.freedesktop.Notifications.Notify signature"
    )]
    async fn notify(
        &self,
        app_name: String,
        replaces_id: u32,
        app_icon: String,
        summary: String,
        body: String,
        actions: Vec<String>,
        hints: HashMap<String, OwnedValue>,
        expire_timeout: i32,
        #[zbus(connection)] connection: &Connection,
    ) -> fdo::Result<u32> {
        let service = self.service.upgrade().ok_or_else(source_unavailable)?;
        let urgency = hints
            .get("urgency")
            .and_then(|value| u8::try_from(value).ok())
            .unwrap_or(1)
            .min(2);
        let timeout = match expire_timeout {
            0 => None,
            ..0 => Some(Duration::from_millis(DEFAULT_TIMEOUT_MS)),
            ms => Some(Duration::from_millis(u64::from(ms.unsigned_abs()))),
        };
        let icon_path = local_path(&app_icon);
        let app_icon = clip_text(&app_icon, 256);
        let app_name = clip_text(&app_name, 128);
        let desktop_entry = hints
            .get("desktop-entry")
            .and_then(|value| <&str>::try_from(value).ok())
            .map(|value| clip_text(value, 256))
            .filter(|value| !value.is_empty());
        let has_image = hints.keys().any(|key| {
            matches!(
                key.as_str(),
                "image-data" | "image_data" | "icon_data" | "image-path" | "image_path"
            )
        });
        let needs_icon_lookup = icon_path.is_some()
            || !app_icon.is_empty()
            || desktop_entry.is_some()
            || !app_name.is_empty();
        let (icon, attachment) = if (needs_icon_lookup || has_image)
            && let Ok(permit) = service.image_work.clone().try_acquire_owned()
        {
            let media_dir = service.media_dir.clone();
            let xdg_data_dirs = service.xdg_data_dirs.clone();
            let icon_theme = service.icon_theme.clone();
            let launcher = Arc::clone(&service.launcher);
            let app_name_for_icon = app_name.clone();
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let icon = resolve_notification_icon(
                    &media_dir,
                    &xdg_data_dirs,
                    &icon_theme,
                    &launcher,
                    icon_path.as_deref(),
                    &app_icon,
                    desktop_entry.as_deref(),
                    &app_name_for_icon,
                );
                let attachment = if has_image {
                    resolve_attachment(&media_dir, hints)
                } else {
                    None
                };
                (icon, attachment)
            })
            .await
            .unwrap_or_default()
        } else {
            (None, None)
        };
        let (id, evicted) = service
            .receive(
                Incoming {
                    replaces: replaces_id,
                    app_name,
                    summary: clip_text(&summary, 256),
                    body: sanitize_notification_body(&body, MAX_BODY_BYTES),
                    icon,
                    attachment,
                    actions: parse_actions(actions),
                    urgency,
                    timeout,
                },
                self.epoch,
            )
            .map_err(|_| source_unavailable())?;
        if let Some(evicted) = evicted {
            emit_closed(connection, evicted, UNDEFINED).await;
        }
        Ok(id)
    }

    async fn close_notification(&self, id: u32) -> fdo::Result<()> {
        let service = self.service.upgrade().ok_or_else(source_unavailable)?;
        match service.remove(id, Some(self.epoch)) {
            Ok(Some(connection)) => emit_closed(&connection, id, CLOSED_BY_CLIENT).await,
            Ok(None) | Err(NotificationError::Unknown) => {}
            Err(error) => return Err(fdo::Error::Failed(error.to_string())),
        }
        Ok(())
    }

    #[zbus(signal)]
    async fn notification_closed(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        id: u32,
        reason: u32,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn action_invoked(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        id: u32,
        action_key: &str,
    ) -> zbus::Result<()>;
}

fn signal_emitter(
    connection: &Connection,
) -> Result<zbus::object_server::SignalEmitter<'_>, RpcError> {
    zbus::object_server::SignalEmitter::new(connection, PATH)
        .map_err(|_| failed("invalid notification signal path"))
}

async fn emit_closed(connection: &Connection, id: u32, reason: u32) {
    if let Ok(emitter) = signal_emitter(connection)
        && let Err(error) = Interface::notification_closed(&emitter, id, reason).await
    {
        tracing::debug!(%error, id, reason, "failed to emit NotificationClosed");
    }
}

fn source_unavailable() -> fdo::Error {
    fdo::Error::Failed(NotificationError::Unavailable.to_string())
}

fn floor_char_boundary(text: &str, max_bytes: usize) -> usize {
    let mut end = text.len().min(max_bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn is_allowed_text_char(ch: char) -> bool {
    !ch.is_control() || matches!(ch, '\n' | '\t')
}

fn clip_text(text: &str, limit: usize) -> String {
    let end = floor_char_boundary(text, limit);
    let slice = &text[..end];
    let mut out = String::with_capacity(slice.len());
    for ch in slice.chars() {
        if is_allowed_text_char(ch) {
            out.push(ch);
        }
    }
    out
}

enum TagMatch<'a> {
    Valid { end: usize, alt: Option<&'a str> },
    TruncatedAtBudget,
    Invalid { literal_end: usize },
}

fn is_markup_tag_name(name: &str) -> bool {
    matches!(name, "b" | "i" | "u" | "a" | "img")
}

fn is_markup_tag_prefix(name: &str) -> bool {
    ["b", "i", "u", "a", "img"]
        .iter()
        .any(|tag| tag.starts_with(name))
}

fn is_attr_name_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || matches!(byte, b'_' | b':')
}

fn is_attr_name_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
}

fn parse_markup_tag(input: &str, start: usize, truncated_by_scan_budget: bool) -> TagMatch<'_> {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut pos = start + 1;
    if pos == len {
        return if truncated_by_scan_budget {
            TagMatch::TruncatedAtBudget
        } else {
            TagMatch::Invalid { literal_end: len }
        };
    }

    let closing = bytes[pos] == b'/';
    if closing {
        pos += 1;
        if pos == len {
            return if truncated_by_scan_budget {
                TagMatch::TruncatedAtBudget
            } else {
                TagMatch::Invalid { literal_end: len }
            };
        }
    }

    let name_start = pos;
    while pos < len && (bytes[pos].is_ascii_alphanumeric() || matches!(bytes[pos], b'_' | b'-')) {
        pos += 1;
    }
    let name = &input[name_start..pos];

    if pos == len {
        return if truncated_by_scan_budget && is_markup_tag_prefix(name) {
            TagMatch::TruncatedAtBudget
        } else {
            TagMatch::Invalid {
                literal_end: pos.max(start + 1),
            }
        };
    }

    if !is_markup_tag_name(name) {
        return TagMatch::Invalid {
            literal_end: pos.max(start + 1),
        };
    }

    if closing {
        while pos < len && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        if pos == len {
            return if truncated_by_scan_budget {
                TagMatch::TruncatedAtBudget
            } else {
                TagMatch::Invalid { literal_end: len }
            };
        }
        return if bytes[pos] == b'>' {
            TagMatch::Valid {
                end: pos + 1,
                alt: None,
            }
        } else {
            TagMatch::Invalid { literal_end: pos }
        };
    }

    let allows_attrs = matches!(name, "a" | "img");
    let mut alt: Option<&str> = None;

    loop {
        while pos < len && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        if pos == len {
            return if truncated_by_scan_budget {
                TagMatch::TruncatedAtBudget
            } else {
                TagMatch::Invalid { literal_end: len }
            };
        }
        if bytes[pos] == b'>' {
            return TagMatch::Valid { end: pos + 1, alt };
        }
        if bytes[pos] == b'/' {
            pos += 1;
            if pos == len {
                return if truncated_by_scan_budget {
                    TagMatch::TruncatedAtBudget
                } else {
                    TagMatch::Invalid { literal_end: len }
                };
            }
            return if bytes[pos] == b'>' {
                TagMatch::Valid { end: pos + 1, alt }
            } else {
                TagMatch::Invalid { literal_end: pos }
            };
        }
        if !allows_attrs {
            return TagMatch::Invalid { literal_end: pos };
        }

        let attr_start = pos;
        if !is_attr_name_start(bytes[pos]) {
            return TagMatch::Invalid { literal_end: pos };
        }
        pos += 1;
        while pos < len && is_attr_name_continue(bytes[pos]) {
            pos += 1;
        }
        let attr_name = &input[attr_start..pos];

        while pos < len && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        if pos == len {
            return if truncated_by_scan_budget {
                TagMatch::TruncatedAtBudget
            } else {
                TagMatch::Invalid { literal_end: len }
            };
        }
        if bytes[pos] != b'=' {
            return TagMatch::Invalid { literal_end: pos };
        }
        pos += 1;

        while pos < len && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        if pos == len {
            return if truncated_by_scan_budget {
                TagMatch::TruncatedAtBudget
            } else {
                TagMatch::Invalid { literal_end: len }
            };
        }

        let quote = bytes[pos];
        if !matches!(quote, b'"' | b'\'') {
            return TagMatch::Invalid { literal_end: pos };
        }
        pos += 1;
        let val_start = pos;
        while pos < len && bytes[pos] != quote {
            pos += 1;
        }
        if pos == len {
            return if truncated_by_scan_budget {
                TagMatch::TruncatedAtBudget
            } else {
                TagMatch::Invalid { literal_end: len }
            };
        }
        let val_end = pos;
        pos += 1;

        if name == "img" && attr_name.eq_ignore_ascii_case("alt") && alt.is_none() {
            alt = Some(&input[val_start..val_end]);
        }
    }
}

fn decode_entity(slice: &str) -> Option<(Option<char>, usize)> {
    let bytes = slice.as_bytes();
    if bytes.first().copied() != Some(b'&') {
        return None;
    }
    let max_end = bytes.len().min(16);
    let semi = bytes[1..max_end].iter().position(|&b| b == b';')? + 1;
    let body = &slice[1..semi];
    let consumed = semi + 1;

    if let Some(rest) = body.strip_prefix('#') {
        let code = if let Some(hex) = rest.strip_prefix('x').or_else(|| rest.strip_prefix('X')) {
            if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            u32::from_str_radix(hex, 16).ok()
        } else {
            if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            rest.parse::<u32>().ok()
        };
        let ch = code
            .and_then(char::from_u32)
            .filter(|&c| is_allowed_text_char(c));
        return Some((ch, consumed));
    }

    let decoded = match body {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        _ => return None,
    };
    Some((Some(decoded), consumed))
}

fn is_incomplete_entity_prefix(slice: &str) -> bool {
    let Some(rest) = slice.strip_prefix('&') else {
        return false;
    };
    if rest.is_empty() {
        return true;
    }
    if rest.len() >= 15 {
        return false;
    }
    if let Some(num) = rest.strip_prefix('#') {
        if num.is_empty() {
            return true;
        }
        if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
            return hex.bytes().all(|b| b.is_ascii_hexdigit());
        }
        return num.bytes().all(|b| b.is_ascii_digit());
    }
    ["amp", "lt", "gt", "quot", "apos"]
        .iter()
        .any(|name| name.starts_with(rest))
}

fn push_text_segment(
    out: &mut String,
    segment: &str,
    max_output_bytes: usize,
    stop_on_incomplete_entity: bool,
) -> bool {
    let bytes = segment.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if out.len() >= max_output_bytes {
            return false;
        }
        if bytes[i] == b'&' {
            if let Some((decoded, consumed)) = decode_entity(&segment[i..]) {
                if let Some(ch) = decoded {
                    if out.len() + ch.len_utf8() > max_output_bytes {
                        return false;
                    }
                    out.push(ch);
                }
                i += consumed;
                continue;
            }
            if stop_on_incomplete_entity && is_incomplete_entity_prefix(&segment[i..]) {
                return false;
            }
        }
        let ch = segment[i..].chars().next().expect("valid UTF-8 boundary");
        i += ch.len_utf8();
        if is_allowed_text_char(ch) {
            if out.len() + ch.len_utf8() > max_output_bytes {
                return false;
            }
            out.push(ch);
        }
    }
    true
}

/// Single-pass O(n) Freedesktop v1.2 notification body sanitizer.
///
/// Strips valid `<b>`, `<i>`, `<u>`, `<a>`, and `<img>` tags (emitting only `<a>` inner text and
/// single-pass decoded `<img alt>` text, never `src`/`href`), decodes XML/numeric entities in one
/// pass without re-parsing decoded markup, preserves plain `<`/`>`/`&` text, bounds input scanning
/// to `MAX_BODY_SCAN_BYTES`, and allocates a fresh `String` whose retained capacity never exceeds
/// `max_output_bytes`.
fn sanitize_notification_body(raw: &str, max_output_bytes: usize) -> String {
    if max_output_bytes == 0 || raw.is_empty() {
        return String::new();
    }
    let scan_limit = floor_char_boundary(raw, MAX_BODY_SCAN_BYTES);
    let input = &raw[..scan_limit];
    let truncated_by_scan_budget = scan_limit < raw.len();
    let mut out = String::with_capacity(input.len().min(max_output_bytes));
    let bytes = input.as_bytes();
    let mut i = 0;

    while i < bytes.len() && out.len() < max_output_bytes {
        if bytes[i] == b'<' {
            match parse_markup_tag(input, i, truncated_by_scan_budget) {
                TagMatch::Valid { end, alt } => {
                    i = end;
                    if let Some(alt_text) = alt
                        && !push_text_segment(&mut out, alt_text, max_output_bytes, false)
                    {
                        break;
                    }
                }
                TagMatch::TruncatedAtBudget => break,
                TagMatch::Invalid { literal_end } => {
                    let at_budget_end = truncated_by_scan_budget && literal_end == input.len();
                    if !push_text_segment(
                        &mut out,
                        &input[i..literal_end],
                        max_output_bytes,
                        at_budget_end,
                    ) {
                        break;
                    }
                    i = literal_end;
                }
            }
            continue;
        }
        let next_lt = bytes[i..]
            .iter()
            .position(|&b| b == b'<')
            .map_or(bytes.len(), |rel| i + rel);
        let at_budget_end = truncated_by_scan_budget && next_lt == input.len();
        if !push_text_segment(
            &mut out,
            &input[i..next_lt],
            max_output_bytes,
            at_budget_end,
        ) {
            break;
        }
        i = next_lt;
    }

    out
}

fn parse_actions(actions: Vec<String>) -> Vec<Action> {
    let mut fields = actions.into_iter();
    let mut actions = Vec::new();
    for _ in 0..8 {
        let (Some(key), Some(label)) = (fields.next(), fields.next()) else {
            break;
        };
        if !key.is_empty() && key.len() <= 32 && !key.chars().any(|c| c.is_ascii_control()) {
            actions.push(Action {
                key,
                label: clip_text(&label, 96),
            });
        }
    }
    actions
}

#[expect(
    clippy::too_many_arguments,
    reason = "internal icon resolution helper bundling notification fields and XDG lookup roots"
)]
fn resolve_notification_icon(
    media_dir: &Path,
    xdg_data_dirs: &[PathBuf],
    icon_theme: &str,
    launcher: &Launcher,
    icon_path: Option<&Path>,
    app_icon: &str,
    desktop_entry: Option<&str>,
    app_name: &str,
) -> Option<NotificationMedia> {
    if let Some(path) = icon_path {
        return cache_icon_with_dimensions(media_dir, path)
            .map(|(media, dimensions)| NotificationMedia { media, dimensions });
    }
    fn clean_name(name: &str) -> Option<&str> {
        let trimmed = name.trim();
        (!trimmed.is_empty() && !trimmed.contains(['/', '\n', '\t'])).then_some(trimmed)
    }
    let app_icon_name = clean_name(app_icon);
    let desktop_name = desktop_entry.and_then(clean_name);
    let app_name_trimmed = (!app_name.trim().is_empty()).then_some(app_name.trim());

    if let Some(name) = app_icon_name
        && let Some(media) = apps::resolve_icon(name, xdg_data_dirs, icon_theme, None, media_dir)
    {
        return Some(NotificationMedia {
            media,
            dimensions: None,
        });
    }

    let catalog_icon = match launcher.lookup_app_icon(desktop_name, app_icon_name, app_name_trimmed)
    {
        Some(found) => found,
        None if !xdg_data_dirs.is_empty() => {
            let catalog = apps::scan(xdg_data_dirs, icon_theme, media_dir);
            apps::find_desktop_icon(&catalog, desktop_name, app_icon_name, app_name_trimmed)
        }
        None => None,
    };
    if let Some(media) = catalog_icon {
        return Some(NotificationMedia {
            media,
            dimensions: None,
        });
    }

    if let Some(entry) = desktop_name {
        let stem = entry.strip_suffix(".desktop").unwrap_or(entry);
        if let Some(media) = apps::resolve_icon(stem, xdg_data_dirs, icon_theme, None, media_dir) {
            return Some(NotificationMedia {
                media,
                dimensions: None,
            });
        }
    }

    if let Some(name) = app_name_trimmed {
        let lower = name.to_lowercase();
        if let Some(candidate) = clean_name(&lower)
            && let Some(media) =
                apps::resolve_icon(candidate, xdg_data_dirs, icon_theme, None, media_dir)
        {
            return Some(NotificationMedia {
                media,
                dimensions: None,
            });
        }
    }

    None
}

fn resolve_attachment(dir: &Path, mut hints: HashMap<String, OwnedValue>) -> Option<Attachment> {
    for key in ["image-data", "image_data", "icon_data"] {
        if let Some((bytes, dimensions)) = hints.remove(key).and_then(image_data) {
            return Some(Attachment::Png { bytes, dimensions });
        }
    }
    for key in ["image-path", "image_path"] {
        if let Some((media, dimensions)) = hints
            .get(key)
            .and_then(|value| <&str>::try_from(value).ok())
            .and_then(local_path)
            .and_then(|path| read_bounded(&path, MAX_IMAGE_BYTES))
            .and_then(|bytes| cache_image_with_dimensions(dir, &bytes))
        {
            return Some(Attachment::Cached(NotificationMedia {
                media,
                dimensions: Some(dimensions),
            }));
        }
    }
    None
}

fn image_data(value: OwnedValue) -> Option<(Vec<u8>, ImageDimensions)> {
    let fields: [Value<'_>; 7] = Structure::try_from(value)
        .ok()?
        .into_fields()
        .try_into()
        .ok()?;
    let [width, height, row_stride, alpha, bits, channels, bytes] = fields;
    let width = i32::try_from(width).ok()?;
    let height = i32::try_from(height).ok()?;
    let row_stride = i32::try_from(row_stride).ok()?;
    let alpha = bool::try_from(alpha).ok()?;
    let bits = i32::try_from(bits).ok()?;
    let channels = i32::try_from(channels).ok()?;
    let bytes: Vec<u8> = bytes.try_into().ok()?;
    if bits != 8
        || channels != if alpha { 4 } else { 3 }
        || width <= 0
        || height <= 0
        || width > 4096
        || height > 4096
        || bytes.len() > MAX_IMAGE_BYTES
    {
        return None;
    }
    let (w, h, stride) = (
        usize::try_from(width).ok()?,
        usize::try_from(height).ok()?,
        usize::try_from(row_stride).ok()?,
    );
    let row_len = w * usize::try_from(channels).ok()?;
    if stride < row_len
        || bytes.len() < stride.checked_mul(h - 1)?.checked_add(row_len)?
        || w * h * 4 > MAX_IMAGE_BYTES
    {
        return None;
    }
    let width = u32::try_from(width).ok()?;
    let height = u32::try_from(height).ok()?;
    let dimensions = ImageDimensions { width, height };
    if alpha && stride == row_len {
        return png_rgba(width, height, &bytes[..row_len * h]).map(|png| (png, dimensions));
    }
    let mut packed = Vec::with_capacity(w * h * 4);
    for row in bytes.chunks(stride).take(h) {
        let row = &row[..row_len];
        if alpha {
            packed.extend_from_slice(row);
        } else {
            for &[red, green, blue] in row.as_chunks::<3>().0 {
                packed.extend_from_slice(&[red, green, blue, 255]);
            }
        }
    }
    png_rgba(width, height, &packed).map(|png| (png, dimensions))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_freedesktop_v1_2_markup_and_extracts_only_anchor_text_and_img_alt() {
        let chrome_pwa = "<a href=\"https://web.telegram.org/a/\">web.telegram.org</a>\n\n<b>Alice</b> sent an <i>important</i> <u>update</u>: check <a href=\"https://example.com/a>b\">docs &amp; guides</a> <img src=\"file:///etc/passwd\" alt=\"Preview &amp; &lt;tag&gt;\"/> <img src=\"https://tracker.invalid/p.png\"/>";
        let sanitized = sanitize_notification_body(chrome_pwa, MAX_BODY_BYTES);
        assert_eq!(
            sanitized,
            "web.telegram.org\n\nAlice sent an important update: check docs & guides Preview & <tag> "
        );
        assert!(!sanitized.contains("https://"));
        assert!(!sanitized.contains("file://"));
        assert!(!sanitized.contains("tracker.invalid"));
    }

    #[test]
    fn decodes_entities_single_pass_without_reparsing_markup_or_double_decoding() {
        assert_eq!(
            sanitize_notification_body("&lt;b&gt;literal bold&lt;/b&gt;", MAX_BODY_BYTES),
            "<b>literal bold</b>"
        );
        assert_eq!(
            sanitize_notification_body(
                "&amp;lt; &amp;amp; &quot;hi&quot; &apos;ok&apos;",
                MAX_BODY_BYTES
            ),
            "&lt; &amp; \"hi\" 'ok'"
        );
        assert_eq!(
            sanitize_notification_body(
                "&#39; &#x27; &#X41; &#x1F600; &#0; &#xD800; &#x07; &#x0A;ok",
                MAX_BODY_BYTES
            ),
            "' ' A 😀    \nok"
        );
    }

    #[test]
    fn preserves_plain_text_angle_brackets_and_ampersands() {
        let plain = "a < b && c > d; Vec<String>; Option<U>; if x<a && y>z { AT&T &unknown; }";
        assert_eq!(sanitize_notification_body(plain, MAX_BODY_BYTES), plain);
    }

    #[test]
    fn handles_adversarial_repeated_malformed_tags_in_linear_time_with_bounded_capacity() {
        let repeated_bad = "<a ".repeat(20_000);
        let start = std::time::Instant::now();
        let out = sanitize_notification_body(&repeated_bad, MAX_BODY_BYTES);
        assert!(
            start.elapsed() < Duration::from_millis(200),
            "repeated malformed tags must stay linear time, took {:?}",
            start.elapsed()
        );
        assert!(out.len() <= MAX_BODY_BYTES);
        assert!(out.capacity() <= MAX_BODY_BYTES);
        assert!(out.starts_with("<a <a "));

        let clipped = clip_text(&"x".repeat(64_000), 256);
        assert_eq!(clipped.len(), 256);
        assert!(clipped.capacity() <= 256);
    }

    #[test]
    fn truncates_cleanly_on_scan_budget_exhaustion_without_partial_tag_or_entity() {
        let padding = "<b></b>".repeat(MAX_BODY_SCAN_BYTES / 7 - 2);
        let cut_tag = format!("ok {padding}<a href=\"https://example.com/very-long-url\">tail</a>");
        assert!(cut_tag.len() > MAX_BODY_SCAN_BYTES);
        let out_tag = sanitize_notification_body(&cut_tag, MAX_BODY_BYTES);
        assert_eq!(out_tag, "ok ");
        assert!(out_tag.capacity() <= MAX_BODY_BYTES);

        let prefix_len = MAX_BODY_SCAN_BYTES - 3;
        let cut_entity = format!("{}&amp;tail", "z".repeat(prefix_len));
        assert!(cut_entity.len() > MAX_BODY_SCAN_BYTES);
        let out_entity = sanitize_notification_body(&cut_entity, MAX_BODY_BYTES);
        assert_eq!(out_entity.len(), MAX_BODY_BYTES);
        assert!(!out_entity.contains('&'));

        let pad_tags = "<i></i>".repeat(MAX_BODY_SCAN_BYTES / 7 - 1);
        let rem = MAX_BODY_SCAN_BYTES - pad_tags.len();
        let entity_at_budget = format!("{pad_tags}{}&amp;end", "x".repeat(rem.saturating_sub(2)));
        assert!(entity_at_budget.len() > MAX_BODY_SCAN_BYTES);
        let out_clean_entity = sanitize_notification_body(&entity_at_budget, MAX_BODY_BYTES);
        assert!(!out_clean_entity.ends_with('&'));
        assert!(!out_clean_entity.ends_with("&a"));
    }

    #[test]
    fn respects_utf8_boundaries_and_retained_capacity_at_output_limit() {
        // 682 * 3 = 2046 bytes of CJK + one 3-byte char that must not be split or overflow 2048.
        let cjk = "汉".repeat(700);
        let out = sanitize_notification_body(&cjk, MAX_BODY_BYTES);
        assert_eq!(out.len(), 2046);
        assert!(out.capacity() <= MAX_BODY_BYTES);
        assert!(out.chars().all(|c| c == '汉'));

        // Entity whose decoded UTF-8 char would exceed max_output_bytes stops cleanly before it.
        let near_cap = format!("{}&#x1F600;after", "a".repeat(2046));
        let out_emoji = sanitize_notification_body(&near_cap, MAX_BODY_BYTES);
        assert_eq!(out_emoji.len(), 2046);
        assert!(out_emoji.capacity() <= MAX_BODY_BYTES);
    }
}
