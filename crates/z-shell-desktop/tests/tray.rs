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
    assert_eq!(odd_entry["has_menu"], true);
    assert!(odd_entry["menu"].is_null());
    let entry = item(&snapshot, ITEM_ID).expect("working item");
    assert_eq!(entry["has_menu"], true);
    assert_eq!(entry["menu"]["root"]["children"][0]["label"], "Open");
    assert_eq!(entry["menu"]["root"]["children"][0]["is_submenu"], false);
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

struct LazySniItem {
    hang_activate: Arc<AtomicBool>,
}

#[zbus::interface(name = "org.kde.StatusNotifierItem")]
impl LazySniItem {
    #[zbus(property)]
    fn title(&self) -> &str {
        "Lazy Electron App"
    }

    #[zbus(property)]
    fn item_is_menu(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn menu(&self) -> ObjectPath<'_> {
        ObjectPath::try_from("/LazyMenu").expect("valid menu path")
    }

    async fn activate(&self, _x: i32, _y: i32) -> zbus::fdo::Result<()> {
        if self.hang_activate.load(Ordering::Relaxed) {
            std::future::pending::<()>().await;
        }
        Err(zbus::fdo::Error::UnknownMethod(
            "Activate is not implemented".into(),
        ))
    }
}

struct LazyMenu {
    root_opened: Arc<AtomicBool>,
    submenu_opened: Arc<AtomicBool>,
    hang: Arc<AtomicBool>,
    events: mpsc::UnboundedSender<(i32, String)>,
}

#[zbus::interface(name = "com.canonical.dbusmenu")]
impl LazyMenu {
    async fn get_layout(&self, parent: i32, _depth: i32, properties: Vec<String>) -> (u32, Layout) {
        if self.hang.load(Ordering::Relaxed) {
            std::future::pending::<()>().await;
        }
        assert_eq!(parent, 0);
        assert!(properties.iter().any(|p| p == "children-display"));
        assert!(properties.iter().any(|p| p == "disposition"));
        if !self.root_opened.load(Ordering::Relaxed) {
            return (1, (0, HashMap::new(), Vec::new()));
        }
        let submenu_children = if self.submenu_opened.load(Ordering::Relaxed) {
            let leaf = Structure::from((
                11i32,
                HashMap::from([("label", DbusValue::from("Sub__Leaf"))]),
                Vec::<OwnedValue>::new(),
            ));
            vec![OwnedValue::try_from(DbusValue::from(leaf)).expect("leaf variant")]
        } else {
            Vec::new()
        };
        let open_node = Structure::from((
            10i32,
            HashMap::from([
                ("label", DbusValue::from("_Recent")),
                ("children-display", DbusValue::from("submenu")),
            ]),
            submenu_children,
        ));
        let quit_node = Structure::from((
            20i32,
            HashMap::from([
                ("label", DbusValue::from("Foo__Bar _Quit")),
                ("disposition", DbusValue::from("warning")),
            ]),
            Vec::<OwnedValue>::new(),
        ));
        let rev = if self.submenu_opened.load(Ordering::Relaxed) {
            3
        } else {
            2
        };
        (
            rev,
            (
                0,
                HashMap::new(),
                vec![
                    OwnedValue::try_from(DbusValue::from(open_node)).unwrap(),
                    OwnedValue::try_from(DbusValue::from(quit_node)).unwrap(),
                ],
            ),
        )
    }

    async fn about_to_show(&self, id: i32) -> bool {
        if self.hang.load(Ordering::Relaxed) {
            std::future::pending::<()>().await;
        }
        self.events
            .send((id, "about_to_show".to_owned()))
            .expect("event receiver");
        match id {
            0 => !self.root_opened.swap(true, Ordering::Relaxed),
            10 => !self.submenu_opened.swap(true, Ordering::Relaxed),
            _ => false,
        }
    }

    async fn event(&self, id: i32, event_id: String, _data: OwnedValue, _timestamp: u32) {
        if self.hang.load(Ordering::Relaxed) {
            std::future::pending::<()>().await;
        }
        self.events.send((id, event_id)).expect("event receiver");
    }
}

#[tokio::test]
async fn lazy_menus_submenus_mnemonics_timeout_preservation_and_activate_fallback() {
    let session = TestBus::new();
    let lazy_conn = session.connection().await;
    let healthy_conn = session.connection().await;
    let dir = tempfile::tempdir().expect("temporary shell root");
    let paths = paths(dir.path());
    let hub = BusHub::new("tray-lazy-test", paths.media_dir());

    let root_opened = Arc::new(AtomicBool::new(false));
    let submenu_opened = Arc::new(AtomicBool::new(false));
    let hang_menu = Arc::new(AtomicBool::new(false));
    let hang_activate = Arc::new(AtomicBool::new(false));
    let (menu_tx, mut menu_rx) = mpsc::unbounded_channel();
    let (healthy_tx, mut healthy_rx) = mpsc::unbounded_channel();

    lazy_conn
        .object_server()
        .at(
            "/StatusNotifierItem",
            LazySniItem {
                hang_activate: Arc::clone(&hang_activate),
            },
        )
        .await
        .unwrap();
    lazy_conn
        .object_server()
        .at(
            "/LazyMenu",
            LazyMenu {
                root_opened: Arc::clone(&root_opened),
                submenu_opened: Arc::clone(&submenu_opened),
                hang: Arc::clone(&hang_menu),
                events: menu_tx,
            },
        )
        .await
        .unwrap();
    lazy_conn.request_name("org.example.LazyApp").await.unwrap();

    healthy_conn
        .object_server()
        .at(
            "/StatusNotifierItem",
            Item {
                alternate: Arc::new(AtomicBool::new(false)),
                actions: healthy_tx.clone(),
            },
        )
        .await
        .unwrap();
    healthy_conn
        .object_server()
        .at(MENU, Menu(healthy_tx))
        .await
        .unwrap();
    healthy_conn.request_name(ITEM).await.unwrap();

    let desktop = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Address(session.address().to_owned()),
            tray: true,
            notifications: false,
            xdg_data_dirs: Vec::new(),
            ..Default::default()
        },
    );
    let (snapshot, outbound) = subscribe(&hub, "desktop.tray").await;
    let snapshot = wait_for(snapshot, &outbound, |state| state["available"] == true).await;

    let watcher: Proxy<'_> = Proxy::new(&lazy_conn, WATCHER, WATCHER_PATH, WATCHER)
        .await
        .unwrap();
    watcher
        .call::<_, _, ()>("RegisterStatusNotifierItem", &("org.example.LazyApp",))
        .await
        .unwrap();
    watcher
        .call::<_, _, ()>("RegisterStatusNotifierItem", &(ITEM,))
        .await
        .unwrap();

    let lazy_id = "org.example.LazyApp/StatusNotifierItem";
    let snapshot = wait_for(snapshot, &outbound, |state| {
        item(state, lazy_id).is_some_and(|entry| {
            entry["has_menu"] == true && entry["menu"]["root"]["children"] == json!([])
        }) && item(state, ITEM_ID).is_some()
    })
    .await;

    // 1. Narrow Activate fallback: UnknownMethod on an item with menu_path returns fallback_menu: true.
    let activate_res = invoke(
        &hub,
        ClientRole::Public,
        "tray.activate",
        json!({"id": lazy_id}),
    )
    .await
    .expect("UnknownMethod Activate falls back cleanly");
    assert_eq!(activate_res["fallback_menu"], true);

    // 2. Preparing root menu populates lazy entries, strips mnemonics, and marks empty submenus.
    invoke(
        &hub,
        ClientRole::Public,
        "tray.prepare-menu",
        json!({"id": lazy_id}),
    )
    .await
    .expect("prepare root menu");
    let mut observed = Vec::new();
    while let Ok(ev) = menu_rx.try_recv() {
        observed.push(ev);
    }
    assert!(observed.iter().any(|ev| ev == &(0, "opened".to_owned())));
    assert!(
        observed
            .iter()
            .any(|ev| ev == &(0, "about_to_show".to_owned()))
    );

    let snapshot = wait_for(snapshot, &outbound, |state| {
        item(state, lazy_id).is_some_and(|entry| {
            entry["menu"]["root"]["children"]
                .as_array()
                .is_some_and(|c| c.len() == 2)
        })
    })
    .await;
    let lazy_entry = item(&snapshot, lazy_id).unwrap();
    let recent = &lazy_entry["menu"]["root"]["children"][0];
    assert_eq!(recent["id"], 10);
    assert_eq!(recent["label"], "Recent");
    assert_eq!(recent["is_submenu"], true);
    assert_eq!(recent["children_display"], "submenu");
    assert_eq!(recent["children"], json!([]));
    let quit = &lazy_entry["menu"]["root"]["children"][1];
    assert_eq!(quit["label"], "Foo_Bar Quit");
    assert_eq!(quit["disposition"], "warning");
    assert_eq!(quit["is_submenu"], false);

    // 3. Preparing submenu id=10 populates nested leaf and allows clicking it.
    invoke(
        &hub,
        ClientRole::Public,
        "tray.prepare-menu",
        json!({"id": lazy_id, "menu_id": 10}),
    )
    .await
    .expect("prepare submenu 10");
    let snapshot = wait_for(snapshot, &outbound, |state| {
        item(state, lazy_id)
            .is_some_and(|entry| entry["menu"]["root"]["children"][0]["children"][0]["id"] == 11)
    })
    .await;
    assert_eq!(
        item(&snapshot, lazy_id).unwrap()["menu"]["root"]["children"][0]["children"][0]["label"],
        "Sub_Leaf"
    );
    invoke(
        &hub,
        ClientRole::Public,
        "tray.menu-item",
        json!({"id": lazy_id, "menu_id": 11, "timestamp": 42}),
    )
    .await
    .expect("click populated submenu leaf");

    invoke(
        &hub,
        ClientRole::Public,
        "tray.close-menu",
        json!({"id": lazy_id}),
    )
    .await
    .expect("close root menu");
    let mut saw_closed = false;
    while let Ok((id, ev)) = menu_rx.try_recv() {
        if id == 0 && ev == "closed" {
            saw_closed = true;
        }
    }
    assert!(saw_closed, "expected Event(0, closed)");

    // 4. Hung tray app: prepare-menu timeout must NOT freeze sibling items OR wipe cached Some(menu),
    //    and Activate timeout must NEVER fall back to opening the menu!
    hang_menu.store(true, Ordering::Relaxed);
    hang_activate.store(true, Ordering::Relaxed);

    let (hung_prepare, healthy_activate) = tokio::join!(
        invoke(
            &hub,
            ClientRole::Public,
            "tray.prepare-menu",
            json!({"id": lazy_id}),
        ),
        async {
            let res = tokio::time::timeout(
                Duration::from_millis(500),
                invoke(
                    &hub,
                    ClientRole::Public,
                    "tray.activate",
                    json!({"id": ITEM_ID}),
                ),
            )
            .await
            .expect("sibling tray item must not be blocked by hung prepare-menu")
            .expect("sibling activate succeeds");
            assert_eq!(res["fallback_menu"], false);
            assert_eq!(receive(&mut healthy_rx).await, Call::Activate(0, 0));
        }
    );
    let () = healthy_activate;
    assert_eq!(
        hung_prepare
            .expect_err("hung prepare-menu must fail with timeout")
            .code,
        ErrorCode::Timeout
    );

    // Also emit LayoutUpdated while hung to prove background refresh timeout preserves cached menu too.
    lazy_conn
        .emit_signal(
            None::<&str>,
            "/LazyMenu",
            "com.canonical.dbusmenu",
            "LayoutUpdated",
            &(4_u32, 0_i32),
        )
        .await
        .unwrap();

    // Activate timeout on hung item must fail, never returning fallback_menu: true.
    assert!(
        invoke(
            &hub,
            ClientRole::Public,
            "tray.activate",
            json!({"id": lazy_id}),
        )
        .await
        .is_err(),
        "Activate timeout must never fall back to menu"
    );

    let (latest, _) = subscribe(&hub, "desktop.tray").await;
    let preserved = item(&latest, lazy_id).expect("hung item still registered");
    assert_eq!(
        preserved["menu"]["root"]["children"][0]["children"][0]["label"], "Sub_Leaf",
        "cached menu must remain intact across AboutToShow and GetLayout timeouts"
    );

    desktop.shutdown().await;
}
