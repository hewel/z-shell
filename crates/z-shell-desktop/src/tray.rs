use std::collections::HashMap;
use std::fmt;
use std::future::poll_fn;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::task::{AbortHandle, Id, JoinSet};
use tokio::time::{Instant, timeout, timeout_at};
use z_shell_bus::{BusHub, CommandCall, UpdateKind};
use z_shell_protocol::{CommandInvokeResult, ErrorCode, MediaRef, RpcError};
use zbus::export::futures_core::Stream;
use zbus::fdo::{self, DBusProxy, RequestNameFlags, RequestNameReply};
use zbus::message::{Header, Sequence, Type as MessageType};
use zbus::names::{BusName, OwnedUniqueName};
use zbus::object_server::SignalEmitter;
use zbus::zvariant::{Array, Dict, ObjectPath, Signature, Structure, Value};
use zbus::{Connection, MatchRule, Message, MessageStream};

use crate::assets::{Blobs, cache_icon, local_path, png_rgba};
use crate::{data, disabled, failed, not_found, ok, payload, publish, register};

const TOPIC: &str = "desktop.tray";
pub(crate) const WATCHER: &str = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH: &str = "/StatusNotifierWatcher";
const ITEM: &str = "org.kde.StatusNotifierItem";
const ITEM_FDO: &str = "org.freedesktop.StatusNotifierItem";
const ITEM_PATH: &str = "/StatusNotifierItem";
const MENU: &str = "com.canonical.dbusmenu";
const DBUS: &str = "org.freedesktop.DBus";
const DBUS_PATH: &str = "/org/freedesktop/DBus";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const TIMEOUT: Duration = Duration::from_secs(2);
const MAX_ITEMS: usize = 32;
const MAX_PATH: usize = 256;
const MAX_TEXT: usize = 160;
const MAX_ITEM_REPLY: usize = 4 * 1024 * 1024;
const MAX_PIXMAP_EDGE: u32 = 256;
const MAX_MENU_REPLY: usize = 256 * 1024;
const MAX_MENU_DEPTH: i32 = 8;
const MAX_MENU_NODES: usize = 48;
const MENU_PROPERTIES: &[&str] = &[
    "label",
    "enabled",
    "visible",
    "type",
    "toggle-type",
    "toggle-state",
    "children-display",
    "disposition",
];

pub(crate) struct Tray {
    hub: BusHub,
    media_dir: PathBuf,
    xdg_data_dirs: Vec<PathBuf>,
    icon_theme: String,
    ime_refresh: Arc<Notify>,
    state: Mutex<State>,
}

impl fmt::Debug for Tray {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Tray").finish_non_exhaustive()
    }
}

#[derive(Default)]
struct State {
    connection: Option<Connection>,
    items: Vec<Item>,
    blobs: Blobs,
}

#[derive(Serialize)]
struct Snapshot<'a> {
    available: bool,
    items: &'a [Item],
}

#[derive(Serialize)]
struct Item {
    id: String,
    #[serde(flatten)]
    info: ItemInfo,
    has_menu: bool,
    icon: Option<MediaRef>,
    menu: Option<Menu>,
    #[serde(skip)]
    name: String,
    #[serde(skip)]
    owner_verified_at: Sequence,
    #[serde(skip)]
    endpoint: Endpoint,
    #[serde(skip)]
    icon_digest: Option<[u8; 32]>,
    #[serde(skip)]
    menu_path: Option<String>,
    #[serde(skip)]
    properties_refresh: Refresh,
    #[serde(skip)]
    menu_refresh: Refresh,
}

#[derive(Clone)]
struct Endpoint {
    owner: OwnedUniqueName,
    path: String,
    interface: &'static str,
}

#[derive(Default, PartialEq, Eq, Serialize)]
struct ItemInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    app_id: Option<String>,
    title: Option<String>,
    category: Option<String>,
    status: Option<String>,
    icon_name: Option<String>,
    item_is_menu: bool,
    tooltip: Option<Tooltip>,
}

#[derive(PartialEq, Eq, Serialize)]
struct Tooltip {
    title: Option<String>,
    description: Option<String>,
}

#[derive(PartialEq, Eq, Serialize)]
struct Menu {
    revision: u32,
    root: MenuNode,
}

#[derive(PartialEq, Eq, Serialize)]
struct MenuNode {
    id: i32,
    label: Option<String>,
    enabled: bool,
    visible: bool,
    separator: bool,
    is_submenu: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children_display: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disposition: Option<&'static str>,
    toggle_type: Option<&'static str>,
    toggle_state: Option<i32>,
    children: Vec<Self>,
}

impl MenuNode {
    fn accepts_click(&self, id: i32) -> bool {
        self.visible
            && self.enabled
            && !self.separator
            && (self.id == id || self.children.iter().any(|child| child.accepts_click(id)))
    }

    fn find(&self, id: i32) -> Option<&Self> {
        if self.id == id {
            return Some(self);
        }
        self.children.iter().find_map(|child| child.find(id))
    }
}

struct Properties {
    interface: &'static str,
    info: ItemInfo,
    icon: Option<Icon>,
    menu_path: Option<String>,
}

enum Icon {
    File(MediaRef),
    Pixmap { png: Vec<u8>, digest: [u8; 32] },
}

#[derive(Default)]
struct Refresh {
    task: Option<AbortHandle>,
    dirty: bool,
}

impl Refresh {
    fn schedule(&mut self, start: impl FnOnce() -> AbortHandle) {
        if self.task.is_some() {
            self.dirty = true;
        } else {
            self.task = Some(start());
        }
    }

    fn finish(&mut self, id: Id) -> Option<bool> {
        if self.task.as_ref()?.id() != id {
            return None;
        }
        self.task = None;
        Some(std::mem::take(&mut self.dirty))
    }

    fn cancel(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.dirty = false;
    }
}

enum Job {
    Properties(String, Option<Properties>),
    Menu(String, Option<Menu>),
}

#[derive(Clone, Copy)]
enum Control {
    Activate,
    ContextMenu,
    MenuItem,
    PrepareMenu,
    CloseMenu,
}

#[derive(Deserialize)]
struct PointAction<'a> {
    id: &'a str,
    #[serde(default)]
    x: i32,
    #[serde(default)]
    y: i32,
}

#[derive(Deserialize)]
struct MenuAction<'a> {
    id: &'a str,
    menu_id: i32,
    #[serde(default)]
    timestamp: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MenuLifecycle<'a> {
    id: &'a str,
    #[serde(default)]
    menu_id: i32,
    #[serde(default)]
    timestamp: u32,
}

impl Tray {
    pub(crate) fn install(
        hub: &BusHub,
        media_dir: PathBuf,
        xdg_data_dirs: Vec<PathBuf>,
        icon_theme: String,
        ime_refresh: Arc<Notify>,
    ) -> Arc<Self> {
        let tray = Arc::new(Self {
            hub: hub.clone(),
            media_dir,
            xdg_data_dirs,
            icon_theme,
            ime_refresh,
            state: Mutex::new(State::default()),
        });
        tray.publish(&tray.state(), UpdateKind::SourceBaseline);
        for (kind, name, description) in [
            (
                Control::Activate,
                "tray.activate",
                "Activate a status notifier item",
            ),
            (
                Control::ContextMenu,
                "tray.context-menu",
                "Open a status notifier item's context menu",
            ),
            (
                Control::MenuItem,
                "tray.menu-item",
                "Click a status notifier menu entry",
            ),
            (
                Control::PrepareMenu,
                "tray.prepare-menu",
                "Prepare a status notifier menu or submenu via AboutToShow",
            ),
            (
                Control::CloseMenu,
                "tray.close-menu",
                "Notify a status notifier menu or submenu that it closed",
            ),
        ] {
            register(
                hub,
                &tray,
                name,
                description,
                move |tray, call| async move { tray.control(kind, &call).await },
            );
        }
        register(
            hub,
            &tray,
            "tray.fetch-blob",
            "Fetch a tray pixmap as the native host",
            |tray, call| async move { tray.state().blobs.fetch(&call) },
        );
        tray
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("tray state lock poisoned")
    }

    fn publish(&self, state: &State, kind: UpdateKind) {
        publish(
            &self.hub,
            TOPIC,
            &Snapshot {
                available: state.connection.is_some(),
                items: &state.items,
            },
            kind,
        );
    }

    pub(crate) fn disconnected(&self) {
        let mut state = self.state();
        if state.connection.is_some() {
            *state = State::default();
            self.publish(&state, UpdateKind::SourceBaseline);
        }
    }

    pub(crate) async fn run(self: &Arc<Self>, connection: &Connection) -> zbus::Result<()> {
        let dbus = DBusProxy::new(connection).await?;
        install_matches(&dbus).await?;
        let mut messages = MessageStream::from(connection);
        let (registrations, mut requests) = mpsc::channel(MAX_ITEMS);
        connection
            .object_server()
            .at(
                WATCHER_PATH,
                Watcher {
                    tray: Arc::downgrade(self),
                    registrations,
                },
            )
            .await?;
        let claimed = connection
            .request_name_with_flags(WATCHER, RequestNameFlags::DoNotQueue.into())
            .await?;
        if !matches!(
            claimed,
            RequestNameReply::PrimaryOwner | RequestNameReply::AlreadyOwner
        ) {
            return Err(zbus::Error::NameTaken);
        }
        {
            let mut state = self.state();
            state.connection = Some(connection.clone());
            self.publish(&state, UpdateKind::SourceBaseline);
        }
        let emitter = SignalEmitter::new(connection, WATCHER_PATH)?;
        Watcher::status_notifier_host_registered(&emitter).await?;
        let mut monitor = Monitor {
            tray: self,
            connection,
            jobs: JoinSet::new(),
        };
        loop {
            tokio::select! {
                message = poll_fn(|cx| std::pin::Pin::new(&mut messages).poll_next(cx)) => {
                    let Some(message) = message else { break };
                    monitor.signal(&message?, &emitter).await?;
                }
                Some(request) = requests.recv() => {
                    monitor.register(request, &emitter).await?;
                }
                Some(result) = monitor.jobs.join_next_with_id(), if !monitor.jobs.is_empty() => {
                    match result {
                        Ok((id, job)) => monitor.complete(id, job),
                        Err(error) if !error.is_cancelled() => {
                            tracing::warn!(%error, "tray refresh task exited unexpectedly");
                        }
                        Err(_) => {}
                    }
                }
            }
        }
        Ok(())
    }

    async fn control(
        &self,
        kind: Control,
        call: &CommandCall,
    ) -> Result<CommandInvokeResult, RpcError> {
        match kind {
            Control::Activate => {
                let request: PointAction<'_> = payload(call)?;
                let (connection, endpoint, has_menu) = {
                    let state = self.state();
                    let (connection, item) = action_item(&state, request.id)?;
                    (
                        connection.clone(),
                        item.endpoint.clone(),
                        item.menu_path.is_some(),
                    )
                };
                match timeout(
                    TIMEOUT,
                    connection.call_method(
                        Some(endpoint.owner.as_str()),
                        endpoint.path.as_str(),
                        Some(endpoint.interface),
                        "Activate",
                        &(request.x, request.y),
                    ),
                )
                .await
                {
                    Ok(Ok(_)) => Ok(data(json!({ "fallback_menu": false }))),
                    Ok(Err(error)) if has_menu && is_unsupported_dbus_method(&error) => {
                        Ok(data(json!({ "fallback_menu": true })))
                    }
                    Err(_) => Err(RpcError::new(ErrorCode::Timeout, "tray action timed out")),
                    Ok(Err(_)) => Err(failed("tray action did not complete")),
                }
            }
            Control::ContextMenu => {
                let request: PointAction<'_> = payload(call)?;
                let (connection, endpoint) = {
                    let state = self.state();
                    let (connection, item) = action_item(&state, request.id)?;
                    (connection.clone(), item.endpoint.clone())
                };
                match timeout(
                    TIMEOUT,
                    connection.call_method(
                        Some(endpoint.owner.as_str()),
                        endpoint.path.as_str(),
                        Some(endpoint.interface),
                        "ContextMenu",
                        &(request.x, request.y),
                    ),
                )
                .await
                {
                    Ok(Ok(_)) => Ok(ok()),
                    Err(_) => Err(RpcError::new(ErrorCode::Timeout, "tray action timed out")),
                    Ok(Err(_)) => Err(failed("tray action did not complete")),
                }
            }
            Control::MenuItem => {
                let request: MenuAction<'_> = payload(call)?;
                let (connection, owner, path) = {
                    let state = self.state();
                    let (connection, item) = action_item(&state, request.id)?;
                    let path = item
                        .menu_path
                        .as_ref()
                        .filter(|_| {
                            item.menu.as_ref().is_some_and(|menu| {
                                request.menu_id != menu.root.id
                                    && menu.root.accepts_click(request.menu_id)
                            })
                        })
                        .ok_or_else(|| not_found("tray menu item not found"))?;
                    (
                        connection.clone(),
                        item.endpoint.owner.clone(),
                        path.clone(),
                    )
                };
                match timeout(
                    TIMEOUT,
                    connection.call_method(
                        Some(owner.as_str()),
                        path.as_str(),
                        Some(MENU),
                        "Event",
                        &(request.menu_id, "clicked", Value::I32(0), request.timestamp),
                    ),
                )
                .await
                {
                    Ok(Ok(_)) => Ok(ok()),
                    Err(_) => Err(RpcError::new(ErrorCode::Timeout, "tray action timed out")),
                    Ok(Err(_)) => Err(failed("tray action did not complete")),
                }
            }
            Control::PrepareMenu => {
                let request: MenuLifecycle<'_> = payload(call)?;
                self.prepare_menu_inner(request.id, request.menu_id, request.timestamp)
                    .await
            }
            Control::CloseMenu => {
                let request: MenuLifecycle<'_> = payload(call)?;
                let (connection, owner, path) = {
                    let state = self.state();
                    let (connection, item) = action_item(&state, request.id)?;
                    let path = item
                        .menu_path
                        .clone()
                        .ok_or_else(|| not_found("tray item has no menu"))?;
                    (connection.clone(), item.endpoint.owner.clone(), path)
                };
                match timeout(
                    TIMEOUT,
                    connection.call_method(
                        Some(owner.as_str()),
                        path.as_str(),
                        Some(MENU),
                        "Event",
                        &(request.menu_id, "closed", Value::I32(0), request.timestamp),
                    ),
                )
                .await
                {
                    Ok(Ok(_)) => Ok(ok()),
                    Ok(Err(error)) if is_unsupported_dbus_method(&error) => Ok(ok()),
                    Err(_) => Err(RpcError::new(
                        ErrorCode::Timeout,
                        "tray menu close timed out",
                    )),
                    Ok(Err(_)) => Err(failed("tray menu close failed")),
                }
            }
        }
    }

    async fn prepare_menu_inner(
        &self,
        id: &str,
        menu_id: i32,
        timestamp: u32,
    ) -> Result<CommandInvokeResult, RpcError> {
        let (connection, owner, path, cached_empty, has_cached_menu) = {
            let state = self.state();
            let (connection, item) = action_item(&state, id)?;
            let path = item
                .menu_path
                .clone()
                .ok_or_else(|| not_found("tray item has no menu"))?;
            if menu_id != 0
                && let Some(menu) = &item.menu
                && menu.root.find(menu_id).is_none()
            {
                return Err(not_found("tray menu item not found"));
            }
            let cached_empty = match &item.menu {
                None => true,
                Some(menu) if menu_id == 0 => menu.root.children.is_empty(),
                Some(menu) => menu
                    .root
                    .find(menu_id)
                    .is_none_or(|node| node.children.is_empty()),
            };
            (
                connection.clone(),
                item.endpoint.owner.clone(),
                path,
                cached_empty,
                item.menu.is_some(),
            )
        };
        let deadline = Instant::now() + TIMEOUT;
        let opened = timeout_at(
            deadline,
            connection.call_method(
                Some(owner.as_str()),
                path.as_str(),
                Some(MENU),
                "Event",
                &(menu_id, "opened", Value::I32(0), timestamp),
            ),
        )
        .await
        .map_err(|_| RpcError::new(ErrorCode::Timeout, "tray menu preparation timed out"))?;
        if let Err(error) = opened
            && !is_unsupported_dbus_method(&error)
        {
            tracing::debug!(%error, id, menu_id, "DBusMenu Event(opened) returned error");
        }

        let need_update = match timeout_at(
            deadline,
            connection.call_method(
                Some(owner.as_str()),
                path.as_str(),
                Some(MENU),
                "AboutToShow",
                &(menu_id,),
            ),
        )
        .await
        {
            Ok(Ok(message)) => message.body().deserialize::<bool>().unwrap_or(true),
            Ok(Err(error)) if is_unsupported_dbus_method(&error) => false,
            Ok(Err(_)) => return Err(failed("tray menu preparation failed")),
            Err(_) => {
                return Err(RpcError::new(
                    ErrorCode::Timeout,
                    "tray menu preparation timed out",
                ));
            }
        };

        if need_update || cached_empty {
            let layout = timeout_at(deadline, read_menu(&connection, &owner, &path))
                .await
                .map_err(|_| {
                    RpcError::new(ErrorCode::Timeout, "tray menu layout refresh timed out")
                })?;
            match layout {
                Some(menu) => {
                    let mut state = self.state();
                    if let Some(item) = state.items.iter_mut().find(|item| {
                        item.id == id
                            && item.endpoint.owner == owner
                            && item.menu_path.as_deref() == Some(path.as_str())
                    }) && item.menu.as_ref() != Some(&menu)
                    {
                        item.menu = Some(menu);
                        self.publish(&state, UpdateKind::Live);
                    }
                }
                None if !has_cached_menu => {
                    return Err(failed("tray menu layout unavailable"));
                }
                None => {}
            }
        }
        Ok(ok())
    }
}

fn action_item<'a>(state: &'a State, id: &str) -> Result<(&'a Connection, &'a Item), RpcError> {
    let connection = state
        .connection
        .as_ref()
        .ok_or_else(|| disabled("tray source unavailable"))?;
    let item = state
        .items
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| not_found("tray item not found"))?;
    Ok((connection, item))
}

async fn install_matches(dbus: &DBusProxy<'_>) -> zbus::Result<()> {
    let signal = || MatchRule::builder().msg_type(MessageType::Signal);
    dbus.add_match_rule(
        signal()
            .sender(DBUS)?
            .interface(DBUS)?
            .path(DBUS_PATH)?
            .member("NameOwnerChanged")?
            .build(),
    )
    .await?;
    for interface in [ITEM, ITEM_FDO, MENU] {
        dbus.add_match_rule(signal().interface(interface)?.build())
            .await?;
    }
    for interface in [ITEM, ITEM_FDO] {
        dbus.add_match_rule(
            signal()
                .interface(PROPERTIES)?
                .member("PropertiesChanged")?
                .arg(0, interface)?
                .build(),
        )
        .await?;
    }
    Ok(())
}

struct Watcher {
    tray: Weak<Tray>,
    registrations: mpsc::Sender<Registration>,
}

struct Registration {
    name: String,
    path: String,
    reply: oneshot::Sender<fdo::Result<()>>,
}

#[zbus::interface(name = "org.kde.StatusNotifierWatcher")]
impl Watcher {
    async fn register_status_notifier_item(
        &self,
        service: &str,
        #[zbus(header)] header: Header<'_>,
    ) -> fdo::Result<()> {
        let (name, path) = if service.starts_with('/') {
            let sender = header
                .sender()
                .ok_or_else(|| fdo::Error::InvalidArgs("missing item sender".into()))?;
            ObjectPath::try_from(service)
                .ok()
                .filter(|path| path.as_str().len() <= MAX_PATH)
                .ok_or_else(|| fdo::Error::InvalidArgs("invalid item object path".into()))?;
            (sender.as_str(), service)
        } else {
            BusName::try_from(service)
                .map_err(|_| fdo::Error::InvalidArgs("invalid item bus name".into()))?;
            (service, ITEM_PATH)
        };
        let (reply, result) = oneshot::channel();
        self.registrations
            .try_send(Registration {
                name: name.to_owned(),
                path: path.to_owned(),
                reply,
            })
            .map_err(|_| {
                fdo::Error::LimitsExceeded("tray registration queue unavailable".into())
            })?;
        result
            .await
            .map_err(|_| fdo::Error::Failed("tray watcher disconnected".into()))?
    }

    fn register_status_notifier_host(&self, service: &str) -> fdo::Result<()> {
        BusName::try_from(service)
            .map_err(|_| fdo::Error::InvalidArgs("invalid host bus name".into()))?;
        // The daemon already supplies the local host; external hosts are free to observe it.
        Ok(())
    }

    #[zbus(property(emits_changed_signal = "false"))]
    fn registered_status_notifier_items(&self) -> Vec<String> {
        self.tray.upgrade().map_or_else(Vec::new, |tray| {
            tray.state()
                .items
                .iter()
                .map(|item| item.id.clone())
                .collect()
        })
    }

    #[zbus(property(emits_changed_signal = "const"))]
    fn is_status_notifier_host_registered(&self) -> bool {
        true
    }

    #[zbus(property(emits_changed_signal = "const"))]
    fn protocol_version(&self) -> i32 {
        0
    }

    #[zbus(signal)]
    async fn status_notifier_item_registered(
        emitter: &SignalEmitter<'_>,
        service: &str,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn status_notifier_item_unregistered(
        emitter: &SignalEmitter<'_>,
        service: &str,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn status_notifier_host_registered(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;
}

struct Monitor<'a> {
    tray: &'a Tray,
    connection: &'a Connection,
    jobs: JoinSet<Job>,
}

impl Monitor<'_> {
    async fn register(
        &mut self,
        request: Registration,
        emitter: &SignalEmitter<'_>,
    ) -> zbus::Result<()> {
        let Registration { name, path, reply } = request;
        let id = format!("{name}{path}");
        let resolution = async {
            let message = self
                .connection
                .call_method(
                    Some(DBUS),
                    DBUS_PATH,
                    Some(DBUS),
                    "GetNameOwner",
                    &(name.as_str(),),
                )
                .await?;
            Ok::<_, zbus::Error>((
                message.body().deserialize::<OwnedUniqueName>()?,
                message.recv_position(),
            ))
        };
        let Ok(Ok((owner, owner_verified_at))) = timeout(TIMEOUT, resolution).await else {
            let _ = reply.send(Err(fdo::Error::NameHasNoOwner(
                "tray item bus name has no owner".into(),
            )));
            return Ok(());
        };
        let replaced_owner = {
            let mut state = self.tray.state();
            if let Some(item) = state.items.iter_mut().find(|item| item.id == id) {
                if item.endpoint.owner == owner {
                    item.owner_verified_at = owner_verified_at;
                    let _ = reply.send(Ok(()));
                    return Ok(());
                }
                Some(item.endpoint.owner.clone())
            } else {
                None
            }
        };
        // A replacement may register before the monitor consumes the bus's loss signal.
        if let Some(previous) = replaced_owner {
            self.owner_left(&name, previous.as_str(), owner_verified_at, emitter)
                .await?;
        }
        {
            let mut state = self.tray.state();
            if state.items.len() >= MAX_ITEMS {
                let _ = reply.send(Err(fdo::Error::LimitsExceeded(
                    "tray item capacity reached".into(),
                )));
                return Ok(());
            }
            let mut item = Item {
                id: id.clone(),
                endpoint: Endpoint {
                    owner,
                    path,
                    interface: ITEM,
                },
                name,
                owner_verified_at,
                info: ItemInfo::default(),
                has_menu: false,
                icon: None,
                icon_digest: None,
                menu: None,
                menu_path: None,
                properties_refresh: Refresh::default(),
                menu_refresh: Refresh::default(),
            };
            self.refresh_properties(&mut item);
            state.items.push(item);
            self.tray.publish(&state, UpdateKind::Live);
        }
        self.tray.ime_refresh.notify_one();
        Watcher::status_notifier_item_registered(emitter, &id).await?;
        let _ = reply.send(Ok(()));
        Ok(())
    }

    async fn signal(&mut self, message: &Message, emitter: &SignalEmitter<'_>) -> zbus::Result<()> {
        let header = message.header();
        if header.message_type() != MessageType::Signal {
            return Ok(());
        }
        let (Some(sender), Some(path), Some(interface), Some(member)) = (
            header.sender(),
            header.path(),
            header.interface(),
            header.member(),
        ) else {
            return Ok(());
        };
        let (sender, path, interface, member) = (
            sender.as_str(),
            path.as_str(),
            interface.as_str(),
            member.as_str(),
        );
        match (interface, member) {
            (DBUS, "NameOwnerChanged") if sender == DBUS && path == DBUS_PATH => {
                let body = message.body();
                if let Ok((name, previous, next)) = body.deserialize::<(&str, &str, &str)>()
                    && !previous.is_empty()
                    && previous != next
                {
                    self.owner_left(name, previous, message.recv_position(), emitter)
                        .await?;
                }
            }
            (
                ITEM | ITEM_FDO,
                "NewTitle" | "NewIcon" | "NewAttentionIcon" | "NewOverlayIcon" | "NewToolTip"
                | "NewStatus" | "NewMenu" | "NewIconThemePath" | "NewLabel" | "XAyatanaNewLabel",
            )
            | (PROPERTIES, "PropertiesChanged") => {
                let mut state = self.tray.state();
                for item in &mut state.items {
                    if item.endpoint.owner.as_str() == sender && item.endpoint.path == path {
                        self.refresh_properties(item);
                        self.tray.ime_refresh.notify_one();
                    }
                }
            }
            (MENU, "LayoutUpdated" | "ItemsPropertiesUpdated") => {
                let mut state = self.tray.state();
                for item in &mut state.items {
                    if item.endpoint.owner.as_str() == sender
                        && item.menu_path.as_deref() == Some(path)
                    {
                        self.refresh_menu(item);
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn owner_left(
        &self,
        name: &str,
        owner: &str,
        change: Sequence,
        emitter: &SignalEmitter<'_>,
    ) -> zbus::Result<()> {
        let removed = {
            let mut state = self.tray.state();
            let State { items, blobs, .. } = &mut *state;
            let mut removed = Vec::new();
            for mut item in items.extract_if(.., |item| {
                item.owner_verified_at < change
                    && item.endpoint.owner.as_str() == owner
                    && (item.name == name || name == owner)
            }) {
                item.properties_refresh.cancel();
                item.menu_refresh.cancel();
                blobs.revoke(item.icon.as_ref());
                removed.push(item.id);
            }
            if !removed.is_empty() {
                self.tray.publish(&state, UpdateKind::Live);
            }
            removed
        };
        for id in removed {
            Watcher::status_notifier_item_unregistered(emitter, &id).await?;
        }
        Ok(())
    }

    fn refresh_properties(&mut self, item: &mut Item) {
        item.properties_refresh.schedule(|| {
            let connection = self.connection.clone();
            let endpoint = item.endpoint.clone();
            let id = item.id.clone();
            let media_dir = self.tray.media_dir.clone();
            let xdg_data_dirs = self.tray.xdg_data_dirs.clone();
            let icon_theme = self.tray.icon_theme.clone();
            self.jobs.spawn(async move {
                let properties = timeout(
                    TIMEOUT,
                    read_properties(&connection, &endpoint, media_dir, xdg_data_dirs, icon_theme),
                )
                .await
                .ok()
                .flatten();
                Job::Properties(id, properties)
            })
        });
    }

    fn refresh_menu(&mut self, item: &mut Item) {
        if let Some(path) = &item.menu_path {
            item.menu_refresh.schedule(|| {
                let connection = self.connection.clone();
                let owner = item.endpoint.owner.clone();
                let path = path.clone();
                let id = item.id.clone();
                self.jobs.spawn(async move {
                    let layout = timeout(TIMEOUT, read_menu(&connection, &owner, &path))
                        .await
                        .ok()
                        .flatten();
                    Job::Menu(id, layout)
                })
            });
        }
    }

    fn complete(&mut self, task_id: Id, job: Job) {
        let mut state = self.tray.state();
        let State { items, blobs, .. } = &mut *state;
        let changed = match job {
            Job::Properties(id, properties) => {
                let Some(item) = items.iter_mut().find(|item| item.id == id) else {
                    return;
                };
                let Some(dirty) = item.properties_refresh.finish(task_id) else {
                    return;
                };
                let mut changed = false;
                if let Some(properties) = properties {
                    item.endpoint.interface = properties.interface;
                    if item.info != properties.info {
                        item.info = properties.info;
                        changed = true;
                    }
                    changed |= update_icon(item, blobs, properties.icon);
                    let next_has_menu = properties.menu_path.is_some();
                    if item.has_menu != next_has_menu {
                        item.has_menu = next_has_menu;
                        changed = true;
                    }
                    if item.menu_path != properties.menu_path {
                        item.menu_refresh.cancel();
                        item.menu_path = properties.menu_path;
                        changed |= item.menu.take().is_some();
                        self.refresh_menu(item);
                    }
                }
                if dirty {
                    self.refresh_properties(item);
                }
                changed
            }
            Job::Menu(id, menu) => {
                let Some(item) = items.iter_mut().find(|item| item.id == id) else {
                    return;
                };
                let Some(dirty) = item.menu_refresh.finish(task_id) else {
                    return;
                };
                if dirty {
                    self.refresh_menu(item);
                }
                let Some(menu) = menu else {
                    return;
                };
                if item.menu.as_ref() == Some(&menu) {
                    false
                } else {
                    item.menu = Some(menu);
                    true
                }
            }
        };
        if changed {
            self.tray.publish(&state, UpdateKind::Live);
        }
    }
}

fn update_icon(item: &mut Item, blobs: &mut Blobs, icon: Option<Icon>) -> bool {
    let (next, digest) = match icon {
        Some(Icon::Pixmap { png, digest }) => {
            if item.icon_digest == Some(digest) {
                return false;
            }
            match blobs.insert_png(png) {
                Some(media) => (Some(media), Some(digest)),
                None => (None, None),
            }
        }
        Some(Icon::File(media)) => (Some(media), None),
        None => (None, None),
    };
    if item.icon == next {
        return false;
    }
    blobs.revoke(item.icon.as_ref());
    item.icon = next;
    item.icon_digest = digest;
    true
}

async fn read_properties(
    connection: &Connection,
    endpoint: &Endpoint,
    mut media_dir: PathBuf,
    mut xdg_data_dirs: Vec<PathBuf>,
    mut icon_theme: String,
) -> Option<Properties> {
    let first = endpoint.interface;
    let second = if first == ITEM { ITEM_FDO } else { ITEM };
    for interface in [first, second] {
        let Ok(message) = connection
            .call_method(
                Some(endpoint.owner.as_str()),
                endpoint.path.as_str(),
                Some(PROPERTIES),
                "GetAll",
                &(interface,),
            )
            .await
        else {
            continue;
        };
        if message.body().len() > MAX_ITEM_REPLY {
            continue;
        }
        // Cache access and image encoding must not block the watcher or other tray apps.
        let (properties, returned_dir, returned_dirs, returned_theme) =
            tokio::task::spawn_blocking(move || {
                let properties =
                    parse_properties(&message, interface, &media_dir, &xdg_data_dirs, &icon_theme);
                (properties, media_dir, xdg_data_dirs, icon_theme)
            })
            .await
            .ok()?;
        if properties.is_some() {
            return properties;
        }
        media_dir = returned_dir;
        xdg_data_dirs = returned_dirs;
        icon_theme = returned_theme;
    }
    None
}

fn parse_properties(
    message: &Message,
    interface: &'static str,
    media_dir: &Path,
    xdg_data_dirs: &[PathBuf],
    icon_theme: &str,
) -> Option<Properties> {
    let body = message.body();
    let fields: HashMap<&str, Value<'_>> = body.deserialize().ok()?;
    if fields.is_empty() {
        return None;
    }
    let get = |key| fields.get(key).map(unvariant);
    let status = get("Status").and_then(as_str);
    let attention = status == Some("NeedsAttention");
    let icon_theme_path = get("IconThemePath").and_then(as_str).and_then(local_path);
    let (icon_name, icon) = if attention {
        read_icon(
            get("AttentionIconName"),
            get("AttentionIconPixmap"),
            media_dir,
            xdg_data_dirs,
            icon_theme,
            icon_theme_path.as_deref(),
        )
        .or_else(|| {
            read_icon(
                get("IconName"),
                get("IconPixmap"),
                media_dir,
                xdg_data_dirs,
                icon_theme,
                icon_theme_path.as_deref(),
            )
        })
    } else {
        read_icon(
            get("IconName"),
            get("IconPixmap"),
            media_dir,
            xdg_data_dirs,
            icon_theme,
            icon_theme_path.as_deref(),
        )
    }
    .unwrap_or_default();
    let tooltip = get("ToolTip").and_then(|value| {
        let Value::Structure(tooltip) = value else {
            return None;
        };
        let [_, _, title, description] = tooltip.fields() else {
            return None;
        };
        let title = as_str(title).and_then(text);
        let description = as_str(description).and_then(text);
        (title.is_some() || description.is_some()).then_some(Tooltip { title, description })
    });
    let menu_path = get("Menu")
        .and_then(|value| match value {
            Value::ObjectPath(path) => Some(path.as_str()),
            value => as_str(value),
        })
        .filter(|path| *path != "/" && *path != "/NO_DBUSMENU" && path.len() <= MAX_PATH)
        .filter(|path| ObjectPath::try_from(*path).is_ok())
        .map(str::to_owned);
    Some(Properties {
        interface,
        info: ItemInfo {
            app_id: get("Id").and_then(as_str).and_then(text),
            title: get("Title").and_then(as_str).and_then(text),
            category: get("Category").and_then(as_str).and_then(text),
            status: status.and_then(text),
            icon_name,
            item_is_menu: matches!(get("ItemIsMenu"), Some(Value::Bool(true))),
            tooltip,
        },
        icon,
        menu_path,
    })
}

fn read_icon(
    name: Option<&Value<'_>>,
    pixmaps: Option<&Value<'_>>,
    dir: &Path,
    xdg_data_dirs: &[PathBuf],
    icon_theme: &str,
    icon_theme_path: Option<&Path>,
) -> Option<(Option<String>, Option<Icon>)> {
    let mut themed_name = None;
    if let Some(name) = name.and_then(as_str).filter(|name| name.len() <= 4096) {
        if let Some(path) = local_path(name) {
            if let Some(media) = cache_icon(dir, &path) {
                return Some((None, Some(Icon::File(media))));
            }
        } else if name.len() <= MAX_TEXT
            && !matches!(name, "" | "." | "..")
            && !name.contains(['/', '\\'])
            && name.chars().all(|c| !c.is_whitespace() && !c.is_control())
        {
            if let Some(media) =
                crate::apps::resolve_icon(name, xdg_data_dirs, icon_theme, icon_theme_path, dir)
            {
                return Some((Some(name.to_owned()), Some(Icon::File(media))));
            }
            themed_name = Some(name.to_owned());
        }
    }
    if let Some(pixmap) = pixmaps.and_then(pixmap) {
        let digest = Sha256::digest(&pixmap).into();
        return Some((
            themed_name,
            Some(Icon::Pixmap {
                png: pixmap,
                digest,
            }),
        ));
    }
    themed_name.map(|name| (Some(name), None))
}

fn pixmap(value: &Value<'_>) -> Option<Vec<u8>> {
    let Value::Array(pixmaps) = unvariant(value) else {
        return None;
    };
    let mut best = None;
    let mut best_len = 0;
    for candidate in pixmaps.inner() {
        let Value::Structure(candidate) = unvariant(candidate) else {
            continue;
        };
        let [width, height, bytes] = candidate.fields() else {
            continue;
        };
        let (Some(width), Some(height), Value::Array(bytes)) =
            (dimension(width), dimension(height), unvariant(bytes))
        else {
            continue;
        };
        let byte_len = (width * height * 4) as usize;
        if byte_len > best_len
            && byte_len == bytes.len()
            && bytes.element_signature() == &Signature::U8
        {
            best = Some((width, height, bytes));
            best_len = byte_len;
        }
    }
    let (width, height, bytes) = best?;
    let mut rgba = Vec::with_capacity(best_len);
    for channels in bytes.inner().as_chunks::<4>().0 {
        let [
            Value::U8(alpha),
            Value::U8(red),
            Value::U8(green),
            Value::U8(blue),
        ] = channels
        else {
            return None;
        };
        rgba.extend_from_slice(&[*red, *green, *blue, *alpha]);
    }
    png_rgba(width, height, &rgba)
}

fn dimension(value: &Value<'_>) -> Option<u32> {
    let number = match unvariant(value) {
        Value::I32(value) => u32::try_from(*value).ok()?,
        Value::U32(value) => *value,
        _ => return None,
    };
    (1..=MAX_PIXMAP_EDGE).contains(&number).then_some(number)
}

async fn read_menu(connection: &Connection, owner: &OwnedUniqueName, path: &str) -> Option<Menu> {
    let message = connection
        .call_method(
            Some(owner.as_str()),
            path,
            Some(MENU),
            "GetLayout",
            &(0i32, MAX_MENU_DEPTH, MENU_PROPERTIES),
        )
        .await
        .ok()?;
    let body = message.body();
    if body.len() > MAX_MENU_REPLY {
        return None;
    }
    let reply: Structure<'_> = body.deserialize().ok()?;
    let [Value::U32(revision), Value::Structure(layout)] = reply.fields() else {
        return None;
    };
    let [
        Value::I32(0),
        Value::Dict(properties),
        Value::Array(children),
    ] = layout.fields()
    else {
        return None;
    };
    let mut remaining = MAX_MENU_NODES;
    let root = parse_menu_node(0, properties, children, MAX_MENU_DEPTH, &mut remaining);
    let revision = *revision;
    Some(Menu { revision, root })
}

fn parse_menu_node(
    id: i32,
    properties: &Dict<'_, '_>,
    children: &Array<'_>,
    depth: i32,
    remaining: &mut usize,
) -> MenuNode {
    *remaining -= 1;
    let property = |key| {
        properties
            .iter()
            .find_map(|(name, value)| (as_str(name) == Some(key)).then(|| unvariant(value)))
    };
    let mut nodes = Vec::new();
    if depth > 0 {
        for child in children.inner() {
            if *remaining == 0 {
                break;
            }
            let Value::Structure(child) = unvariant(child) else {
                continue;
            };
            let [Value::I32(id), Value::Dict(props), Value::Array(children)] = child.fields()
            else {
                continue;
            };
            nodes.push(parse_menu_node(*id, props, children, depth - 1, remaining));
        }
    }
    let separator = property("type").and_then(as_str) == Some("separator");
    let children_display = match property("children-display").and_then(as_str) {
        Some("submenu") => Some("submenu"),
        _ => None,
    };
    let disposition = match property("disposition").and_then(as_str) {
        Some("normal") => Some("normal"),
        Some("informative") => Some("informative"),
        Some("warning") => Some("warning"),
        Some("alert") => Some("alert"),
        _ => None,
    };
    let is_submenu = !separator && (children_display == Some("submenu") || !nodes.is_empty());
    MenuNode {
        id,
        label: property("label")
            .and_then(as_str)
            .map(strip_mnemonics)
            .as_deref()
            .and_then(text),
        enabled: !matches!(property("enabled"), Some(Value::Bool(false))),
        visible: !matches!(property("visible"), Some(Value::Bool(false))),
        separator,
        is_submenu,
        children_display,
        disposition,
        toggle_type: match property("toggle-type").and_then(as_str) {
            Some("checkmark") => Some("checkmark"),
            Some("radio") => Some("radio"),
            _ => None,
        },
        toggle_state: match property("toggle-state") {
            Some(Value::I32(value @ -1..=1)) => Some(*value),
            _ => None,
        },
        children: nodes,
    }
}

fn is_unsupported_dbus_method(error: &zbus::Error) -> bool {
    matches!(
        error,
        zbus::Error::MethodError(name, _, _)
            if matches!(
                name.as_str(),
                "org.freedesktop.DBus.Error.UnknownMethod"
                    | "org.freedesktop.DBus.Error.NotSupported"
            )
    )
}

fn strip_mnemonics(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch == '_' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn unvariant<'a, 'v>(mut value: &'a Value<'v>) -> &'a Value<'v> {
    while let Value::Value(inner) = value {
        value = inner;
    }
    value
}

fn as_str<'a>(value: &'a Value<'_>) -> Option<&'a str> {
    match unvariant(value) {
        Value::Str(text) => Some(text.as_str()),
        _ => None,
    }
}

fn text(value: &str) -> Option<String> {
    let value = value.trim();
    let mut end = value.len().min(MAX_TEXT);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    let value: String = value[..end].chars().filter(|c| !c.is_control()).collect();
    (!value.is_empty()).then_some(value)
}
