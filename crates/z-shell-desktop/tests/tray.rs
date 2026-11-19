mod common;

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use common::{TestBus, invoke, next_update, paths, subscribe};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use z_shell_bus::{BusHub, hub::ClientOutbound};
use z_shell_desktop::{DesktopOptions, DesktopServices, SessionBusAddress};
use z_shell_protocol::{ClientRole, ErrorCode};
use zbus::export::futures_core::Stream;
use zbus::fdo::DBusProxy;
use zbus::zvariant::{ObjectPath, OwnedValue, Structure, Value as DbusValue};
use zbus::{Proxy, proxy::CacheProperties};

const WATCHER: &str = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH: &str = "/StatusNotifierWatcher";
const ITEM_IFACE: &str = "org.kde.StatusNotifierItem";
const ITEM: &str = "org.example.TrayItem";
const ITEM_ID: &str = "org.example.TrayItem/StatusNotifierItem";
const MENU: &str = "/Menu";

#[derive(Debug, PartialEq, Eq)]
enum Call {
    Activate(i32, i32),
    ContextMenu(i32, i32),
    Menu(i32, String, u32),
}

struct Item {
    alternate: Arc<AtomicBool>,
    actions: mpsc::UnboundedSender<Call>,
}

#[zbus::interface(name = "org.kde.StatusNotifierItem")]
impl Item {
    #[zbus(property)]
    fn title(&self) -> &str {
        "Working item"
    }

    #[zbus(property)]
    fn icon_name(&self) -> &str {
        "/missing/icon.png"
    }

    #[zbus(property)]
    fn icon_pixmap(&self) -> Vec<(i32, i32, Vec<u8>)> {
        let pixel = if self.alternate.load(Ordering::Relaxed) {
            [0xff, 0x30, 0x20, 0x10]
        } else {
            [0x80, 0x12, 0x34, 0x56]
        };
        vec![(32, 32, vec![0]), (1, 1, pixel.to_vec())]
    }

    #[zbus(property)]
    fn menu(&self) -> ObjectPath<'_> {
        ObjectPath::try_from(MENU).expect("valid menu path")
    }

    fn activate(&self, x: i32, y: i32) {
        self.actions
            .send(Call::Activate(x, y))
            .expect("action receiver");
    }

    fn context_menu(&self, x: i32, y: i32) {
        self.actions
            .send(Call::ContextMenu(x, y))
            .expect("action receiver");
    }
}

struct OddItem {
    file_icon: Arc<AtomicBool>,
    icon_path: String,
}

#[zbus::interface(name = "org.kde.StatusNotifierItem")]
impl OddItem {
    #[zbus(property)]
    fn title(&self) -> &str {
        "Odd item"
    }

    #[zbus(property)]
    fn status(&self) -> u32 {
        123
    }

    #[zbus(property)]
    fn icon_name(&self) -> &str {
        if self.file_icon.load(Ordering::Relaxed) {
            &self.icon_path
        } else {
            "network-wireless"
        }
    }

    #[zbus(property)]
    fn menu(&self) -> &str {
        "/BrokenMenu"
    }
}

type Layout = (i32, HashMap<String, OwnedValue>, Vec<OwnedValue>);

struct Menu(mpsc::UnboundedSender<Call>);

#[zbus::interface(name = "com.canonical.dbusmenu")]
impl Menu {
    fn get_layout(&self, parent: i32, depth: i32, _properties: Vec<String>) -> (u32, Layout) {
        assert_eq!(parent, 0);
        assert!(depth > 0);
        let child = Structure::from((
            42i32,
            HashMap::from([("label", DbusValue::from("_Open"))]),
            Vec::<OwnedValue>::new(),
        ));
        let children = vec![OwnedValue::try_from(DbusValue::from(child)).expect("child variant")];
        (1, (0, HashMap::new(), children))
    }

    fn event(&self, id: i32, event: String, _data: OwnedValue, timestamp: u32) {
        self.0
            .send(Call::Menu(id, event, timestamp))
            .expect("menu receiver");
    }
}

struct BrokenMenu(mpsc::UnboundedSender<()>);

#[zbus::interface(name = "com.canonical.dbusmenu")]
impl BrokenMenu {
    fn get_layout(&self, _parent: i32, _depth: i32, _properties: Vec<String>) -> &'static str {
        self.0.send(()).expect("broken menu receiver");
        "not a layout"
    }
}

fn item<'a>(snapshot: &'a Value, id: &str) -> Option<&'a Value> {
    snapshot["items"]
        .as_array()
        .expect("tray items array")
        .iter()
        .find(|item| item["id"] == id)
}

async fn wait_for(
    mut snapshot: Value,
    outbound: &ClientOutbound,
    ready: impl Fn(&Value) -> bool,
) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !ready(&snapshot) {
            snapshot = next_update(outbound).await;
        }
        snapshot
    })
    .await
    .expect("expected tray state within 5s")
}

async fn receive<T>(receiver: &mut mpsc::UnboundedReceiver<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .expect("D-Bus method routed within 5s")
        .expect("sender live")
}

async fn assert_signal(stream: &mut zbus::proxy::SignalStream<'_>, id: &str) {
    let signal = tokio::time::timeout(
        Duration::from_secs(5),
        std::future::poll_fn(|cx| Pin::new(&mut *stream).poll_next(cx)),
    )
    .await
    .expect("watcher signal within 5s")
    .expect("watcher remains live");
    assert_eq!(
        signal.body().deserialize::<String>().expect("signal id"),
        id
    );
}

#[tokio::test]
async fn registered_items_route_actions_and_revoke_pixmaps_without_trusting_menu_replies() {
    let session = TestBus::new();
    let app = session.connection().await;
    let odd = session.connection().await;
    let dir = tempfile::tempdir().expect("temporary shell root");
    let paths = paths(dir.path());
    let hub = BusHub::new("tray-test", paths.media_dir());
    let (actions, mut calls) = mpsc::unbounded_channel();
    let (broken_called, mut broken_calls) = mpsc::unbounded_channel();
    let alternate = Arc::new(AtomicBool::new(false));
    app.object_server()
        .at(
            "/StatusNotifierItem",
            Item {
                alternate: Arc::clone(&alternate),
                actions: actions.clone(),
            },
        )
        .await
        .expect("export SNI item");
    app.object_server()
        .at(MENU, Menu(actions))
        .await
        .expect("export menu");
    app.request_name(ITEM).await.expect("own item service");
    let icon_path = dir.path().join("odd.png");
    image::RgbaImage::from_pixel(1, 1, image::Rgba([0xff, 0, 0, 0xff]))
        .save(&icon_path)
        .expect("write absolute PNG fixture");
    let file_icon = Arc::new(AtomicBool::new(false));
    odd.object_server()
        .at(
            "/Odd",
            OddItem {
                file_icon: Arc::clone(&file_icon),
                icon_path: icon_path.to_str().expect("UTF-8 icon path").to_owned(),
            },
        )
        .await
        .expect("export unusual SNI item");
    odd.object_server()
        .at("/BrokenMenu", BrokenMenu(broken_called))
        .await
        .expect("export malformed menu");

    let desktop = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Address(session.address().to_owned()),
            tray: true,
            notifications: false,
            xdg_data_dirs: vec![dir.path().join("data")],
            ..Default::default()
        },
    );
    let (snapshot, outbound) = subscribe(&hub, "desktop.tray").await;
    let snapshot = wait_for(snapshot, &outbound, |state| state["available"] == true).await;
    let watcher: Proxy<'_> = zbus::proxy::Builder::new(&app)
        .destination(WATCHER)
        .expect("watcher service")
        .path(WATCHER_PATH)
        .expect("watcher path")
        .interface(WATCHER)
        .expect("watcher interface")
        .cache_properties(CacheProperties::No)
        .build()
        .await
        .expect("connect watcher proxy");
    assert!(
        watcher
            .get_property::<bool>("IsStatusNotifierHostRegistered")
            .await
            .expect("host status")
    );
    assert_eq!(
        watcher
            .get_property::<i32>("ProtocolVersion")
            .await
            .expect("protocol version"),
        0
    );
    let mut registered = watcher
        .receive_signal("StatusNotifierItemRegistered")
        .await
        .expect("watch registration");
    let mut unregistered = watcher
        .receive_signal("StatusNotifierItemUnregistered")
        .await
        .expect("watch disappearance");

    let odd_id = format!(
        "{}/Odd",
        odd.unique_name().expect("odd app has unique name")
    );
    odd.call_method(
        Some(WATCHER),
        WATCHER_PATH,
        Some(WATCHER),
        "RegisterStatusNotifierItem",
        &("/Odd",),
    )
    .await
    .expect("register by sender path");
    assert_signal(&mut registered, &odd_id).await;
    receive(&mut broken_calls).await;
    watcher
        .call::<_, _, ()>("RegisterStatusNotifierItem", &(ITEM,))
        .await
        .expect("register by service");
    assert_signal(&mut registered, ITEM_ID).await;
    let ids = watcher
        .get_property::<Vec<String>>("RegisteredStatusNotifierItems")
        .await
        .expect("watcher registrations");
    assert_eq!(ids.len(), 2);
    assert!(ids.iter().any(|id| id == &odd_id));
    assert!(ids.iter().any(|id| id == ITEM_ID));

    let snapshot = wait_for(snapshot, &outbound, |state| {
        item(state, ITEM_ID).is_some_and(|entry| entry["menu"]["root"]["children"][0]["id"] == 42)
    })
    .await;
    let odd_entry = item(&snapshot, &odd_id).expect("malformed menu does not drop its tray item");
    assert_eq!(odd_entry["title"], "Odd item");
    assert_eq!(odd_entry["icon_name"], "network-wireless");
    assert!(odd_entry["menu"].is_null());
    let entry = item(&snapshot, ITEM_ID).expect("working item");
    let icon = &entry["icon"];
    assert_eq!(icon["kind"], "blob_handle");
    assert!(icon.get("bytes").is_none(), "topics carry a reference only");
    let token = icon["token"].as_str().expect("icon token").to_owned();
    let denied = invoke(
        &hub,
        ClientRole::Public,
        "tray.fetch-blob",
        json!({"token": token}),
    )
    .await
    .expect_err("public fetch denied");
    assert_eq!(denied.code, ErrorCode::PermissionDenied);
    let reply = invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "tray.fetch-blob",
        json!({"token": token}),
    )
    .await
    .expect("host icon fetch");
    let bytes: Vec<u8> =
        serde_json::from_value(reply["bytes"].clone()).expect("exact PNG byte array");
    assert_eq!(reply["mime"], "image/png");
    assert_eq!(icon["byte_len"], bytes.len());
    let png = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .expect("decode PNG")
        .into_rgba8();
    assert_eq!(png.dimensions(), (1, 1));
    assert_eq!(png.as_raw(), &[0x12, 0x34, 0x56, 0x80]);

    for (command, params, expected) in [
        (
            "tray.activate",
            json!({"id": ITEM_ID, "x": 11, "y": 22}),
            Call::Activate(11, 22),
        ),
        (
            "tray.context-menu",
            json!({"id": ITEM_ID}),
            Call::ContextMenu(0, 0),
        ),
        (
            "tray.menu-item",
            json!({"id": ITEM_ID, "menu_id": 42, "timestamp": 17}),
            Call::Menu(42, "clicked".to_owned(), 17),
        ),
    ] {
        invoke(&hub, ClientRole::Public, command, params)
            .await
            .expect("tray action succeeds");
        assert_eq!(receive(&mut calls).await, expected);
    }
    let rejected = invoke(
        &hub,
        ClientRole::Public,
        "tray.menu-item",
        json!({"id": ITEM_ID, "menu_id": 999}),
    )
    .await
    .expect_err("unknown menu item rejected");
    assert_eq!(rejected.code, ErrorCode::NotFound);

    file_icon.store(true, Ordering::Relaxed);
    odd.emit_signal(None::<&str>, "/Odd", ITEM_IFACE, "NewIcon", &())
        .await
        .expect("publish absolute icon");
    let snapshot = wait_for(snapshot, &outbound, |state| {
        item(state, &odd_id).is_some_and(|entry| entry["icon"]["kind"] == "runtime_path")
    })
    .await;
    let path = item(&snapshot, &odd_id).expect("odd item")["icon"]["path"]
        .as_str()
        .expect("cached absolute icon");
    assert!(std::path::Path::new(path).starts_with(paths.media_dir()));
    assert_eq!(
        std::fs::read(path).expect("cached icon"),
        std::fs::read(icon_path).expect("fixture icon")
    );

    alternate.store(true, Ordering::Relaxed);
    app.emit_signal(
        None::<&str>,
        "/StatusNotifierItem",
        ITEM_IFACE,
        "NewIcon",
        &(),
    )
    .await
    .expect("publish changed icon");
    let snapshot = wait_for(snapshot, &outbound, |state| {
        item(state, ITEM_ID)
            .and_then(|entry| entry["icon"]["token"].as_str())
            .is_some_and(|updated| updated != token)
    })
    .await;
    let updated_token = item(&snapshot, ITEM_ID).expect("updated icon")["icon"]["token"]
        .as_str()
        .expect("updated token")
        .to_owned();
    let revoked = invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "tray.fetch-blob",
        json!({"token": token}),
    )
    .await
    .expect_err("replaced icon revoked");
    assert_eq!(revoked.code, ErrorCode::NotFound);

    assert!(
        app.release_name(ITEM)
            .await
            .expect("release well-known item name")
    );
    assert_signal(&mut unregistered, ITEM_ID).await;
    let snapshot = wait_for(snapshot, &outbound, |state| item(state, ITEM_ID).is_none()).await;
    assert!(item(&snapshot, &odd_id).is_some());
    let revoked = invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "tray.fetch-blob",
        json!({"token": updated_token}),
    )
    .await
    .expect_err("disappeared item icon revoked");
    assert_eq!(revoked.code, ErrorCode::NotFound);
    odd.close().await.expect("close uniquely named app");
    assert_signal(&mut unregistered, &odd_id).await;
    let snapshot = wait_for(snapshot, &outbound, |state| item(state, &odd_id).is_none()).await;

    desktop.shutdown().await;
    wait_for(snapshot, &outbound, |state| state["available"] == false).await;
    let dbus = DBusProxy::new(&app).await.expect("bus proxy");
    assert!(
        !dbus
            .name_has_owner(WATCHER.try_into().expect("watcher bus name"))
            .await
            .expect("watcher owner status")
    );
}
