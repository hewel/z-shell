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
    assets::{Blobs, MAX_IMAGE_BYTES, cache_icon, cache_image, local_path, png_rgba, read_bounded},
    failed, ok, payload, publish, register,
};

const TOPIC: &str = "desktop.notifications";
pub(crate) const NAME: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const HISTORY_LIMIT: usize = 100;
const DEFAULT_TIMEOUT_MS: u64 = 5000;
const EXPIRED: u32 = 1;
const DISMISSED: u32 = 2;
const CLOSED_BY_CLIENT: u32 = 3;
const UNDEFINED: u32 = 4;

pub(crate) struct Notifications {
    hub: BusHub,
    state: Mutex<State>,
    timer_changed: Notify,
    media_dir: PathBuf,
    image_work: Arc<Semaphore>,
}

#[derive(Default)]
struct State {
    epoch: u64,
    connection: Option<Connection>,
    next_id: u32,
    next_revision: u64,
    dnd: bool,
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
    Deadline(Instant),
}

impl Lifetime {
    fn is_open(&self) -> bool {
        !matches!(self, Self::Closed)
    }

    fn deadline(&self) -> Option<Instant> {
        match self {
            Self::Deadline(instant) => Some(*instant),
            Self::Closed | Self::Persistent => None,
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
    icon: Option<Icon>,
    attachment: Option<MediaRef>,
    actions: Vec<Action>,
    urgency: u8,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Icon {
    Name(String),
    Cached(MediaRef),
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
    pub(crate) fn install(hub: &BusHub, media_dir: PathBuf) -> Arc<Self> {
        let service = Arc::new(Self {
            hub: hub.clone(),
            state: Mutex::new(State::default()),
            timer_changed: Notify::new(),
            media_dir,
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
            Some(Attachment::Png(png)) => state.blobs.insert_png(png),
            Some(Attachment::Cached(mut media)) => {
                if let MediaRef::RuntimePath {
                    revision: image_revision,
                    ..
                } = &mut media
                {
                    *image_revision = revision;
                }
                Some(media)
            }
            None => None,
        };
        let popup = !state.dnd;
        state.history.push_front(Entry {
            popup,
            lifetime: incoming.timeout.map_or(Lifetime::Persistent, |duration| {
                Lifetime::Deadline(Instant::now() + duration)
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
        self.blobs.revoke(entry.notification.attachment.as_ref());
        entry
    }
}

struct Incoming {
    replaces: u32,
    app_name: String,
    summary: String,
    body: String,
    icon: Option<Icon>,
    attachment: Option<Attachment>,
    actions: Vec<Action>,
    urgency: u8,
    timeout: Option<Duration>,
}

enum Attachment {
    Png(Vec<u8>),
    Cached(MediaRef),
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
        let app_icon = clip_text(app_icon, 256);
        let has_image = hints.keys().any(|key| {
            matches!(
                key.as_str(),
                "image-data" | "image_data" | "icon_data" | "image-path" | "image_path"
            )
        });
        let (icon, attachment) = if (icon_path.is_some() || has_image)
            && let Ok(permit) = service.image_work.clone().try_acquire_owned()
        {
            let media_dir = service.media_dir.clone();
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                let icon = match icon_path {
                    Some(path) => cache_icon(&media_dir, &path).map(Icon::Cached),
                    None => theme_icon(app_icon),
                };
                (icon, resolve_attachment(&media_dir, hints))
            })
            .await
            .unwrap_or_default()
        } else {
            (theme_icon(app_icon), None)
        };
        let (id, evicted) = service
            .receive(
                Incoming {
                    replaces: replaces_id,
                    app_name: clip_text(app_name, 128),
                    summary: clip_text(summary, 256),
                    body: clip_text(body, 2048),
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

fn clip_text(mut text: String, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.retain(|c| !c.is_ascii_control() || matches!(c, '\n' | '\t'));
    text
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
                label: clip_text(label, 96),
            });
        }
    }
    actions
}

fn theme_icon(name: String) -> Option<Icon> {
    (!name.is_empty() && !name.contains(['/', '\n', '\t'])).then_some(Icon::Name(name))
}

fn resolve_attachment(dir: &Path, mut hints: HashMap<String, OwnedValue>) -> Option<Attachment> {
    for key in ["image-data", "image_data", "icon_data"] {
        if let Some(image) = hints.remove(key).and_then(image_data) {
            return Some(Attachment::Png(image));
        }
    }
    for key in ["image-path", "image_path"] {
        if let Some(media) = hints
            .get(key)
            .and_then(|value| <&str>::try_from(value).ok())
            .and_then(local_path)
            .and_then(|path| read_bounded(&path, MAX_IMAGE_BYTES))
            .and_then(|bytes| cache_image(dir, &bytes))
        {
            return Some(Attachment::Cached(media));
        }
    }
    None
}

fn image_data(value: OwnedValue) -> Option<Vec<u8>> {
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
    if alpha && stride == row_len {
        return png_rgba(width, height, &bytes[..row_len * h]);
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
    png_rgba(width, height, &packed)
}
