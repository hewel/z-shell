mod common;

use std::{collections::HashMap, future::poll_fn, path::Path, pin::Pin, time::Duration};

use common::{TestBus, invoke, next_update, paths, subscribe};
use image::{Rgba, RgbaImage};
use serde_json::{Value, json};
use z_shell_bus::{BusHub, hub::ClientOutbound};
use z_shell_desktop::{DesktopOptions, DesktopServices, SessionBusAddress};
use z_shell_protocol::{ClientRole, ErrorCode, MediaRef};
use zbus::{
    Connection, Proxy,
    export::futures_core::Stream,
    fdo::DBusProxy,
    names::BusName,
    zvariant::{OwnedValue, Value as DbusValue},
};

const NAME: &str = "org.freedesktop.Notifications";
const TOPIC: &str = "desktop.notifications";

async fn ready(snapshot: Value, stream: &ClientOutbound) -> Value {
    if snapshot["available"] == true {
        snapshot
    } else {
        next_update(stream).await
    }
}

async fn notify(proxy: &Proxy<'_>, replaces: u32, text: &str, hint: (&str, OwnedValue)) -> u32 {
    proxy
        .call(
            "Notify",
            &(
                "test-app",
                replaces,
                "mail-unread",
                text,
                "body",
                vec!["open", text],
                HashMap::from([hint]),
                0_i32,
            ),
        )
        .await
        .expect("Notify succeeds")
}

fn file_hint(path: &Path) -> (&'static str, OwnedValue) {
    (
        "image-path",
        DbusValue::from(path.to_str().expect("UTF-8 fixture path"))
            .try_into()
            .expect("owned path"),
    )
}

fn blob_hint() -> (&'static str, OwnedValue) {
    (
        "image-data",
        DbusValue::from((
            1_i32,
            1_i32,
            4_i32,
            true,
            8_i32,
            4_i32,
            vec![20_u8, 40, 60, 128],
        ))
        .try_into()
        .expect("owned image data"),
    )
}

async fn dbus_proxy(connection: &Connection) -> Proxy<'_> {
    Proxy::new(connection, NAME, "/org/freedesktop/Notifications", NAME)
        .await
        .expect("notification proxy")
}

#[tokio::test]
async fn replaces_both_views_and_separates_app_icon_from_attachment() {
    let bus = TestBus::new();
    let client = bus.connection().await;
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    let hub = BusHub::new("test", paths.media_dir());
    let _desktop = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Address(bus.address().to_owned()),
            tray: false,
            xdg_data_dirs: Vec::new(),
            ..DesktopOptions::default()
        },
    );
    let (initial, stream) = subscribe(&hub, TOPIC).await;
    assert_eq!(ready(initial, &stream).await["available"], true);
    let proxy = dbus_proxy(&client).await;
    let image = root.path().join("image.png");
    RgbaImage::from_pixel(1, 1, Rgba([20, 40, 60, 128]))
        .save(&image)
        .expect("fixture PNG");
    let id = notify(&proxy, 0, "first", file_hint(&image)).await;
    let first = next_update(&stream).await;
    let first_media: MediaRef = serde_json::from_value(first["popups"][0]["attachment"].clone())
        .expect("cached local attachment");
    let MediaRef::RuntimePath { path, revision, .. } = first_media else {
        panic!("expected runtime path")
    };
    assert!(path.starts_with(paths.media_dir()));
    assert_eq!(first["popups"][0]["icon"], "mail-unread");

    assert_eq!(notify(&proxy, id, "second", file_hint(&image)).await, id);
    let replaced = next_update(&stream).await;
    for view in ["popups", "history"] {
        let entry = &replaced[view][0];
        assert_eq!(entry["summary"], "second");
        assert_eq!(entry["actions"][0], json!({"key":"open","label":"second"}));
        let MediaRef::RuntimePath { revision: next, .. } =
            serde_json::from_value(entry["attachment"].clone()).unwrap()
        else {
            panic!("expected runtime attachment")
        };
        assert!(
            next > revision,
            "replacement invalidates the cached image even with identical bytes"
        );
    }
    assert_eq!(
        notify(
            &proxy,
            id,
            "missing",
            file_hint(&root.path().join("missing.png"))
        )
        .await,
        id
    );
    let missing = next_update(&stream).await;
    assert_eq!(missing["history"][0]["attachment"], Value::Null);
    assert_eq!(missing["history"][0]["icon"], "mail-unread");
}

#[tokio::test]
async fn dnd_retains_history_and_only_the_host_can_fetch_live_blob_tokens() {
    let bus = TestBus::new();
    let client = bus.connection().await;
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    let hub = BusHub::new("test", paths.media_dir());
    let _desktop = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Address(bus.address().into()),
            xdg_data_dirs: Vec::new(),
            ..DesktopOptions::default()
        },
    );
    let (initial, stream) = subscribe(&hub, TOPIC).await;
    assert_eq!(ready(initial, &stream).await["available"], true);
    invoke(
        &hub,
        ClientRole::Public,
        "notifications.set-dnd",
        json!({"dnd":true}),
    )
    .await
    .unwrap();
    assert_eq!(next_update(&stream).await["dnd"], true);
    let proxy = dbus_proxy(&client).await;
    let id = notify(&proxy, 0, "quiet", blob_hint()).await;
    let snapshot = next_update(&stream).await;
    assert_eq!(snapshot["popups"], json!([]));
    let attachment = &snapshot["history"][0]["attachment"];
    assert_eq!(attachment["kind"], "blob_handle");
    let token = json!({"token": attachment["token"]});
    let blob_command = "notifications.fetch-blob";
    assert_eq!(
        invoke(&hub, ClientRole::Public, blob_command, token.clone())
            .await
            .unwrap_err()
            .code,
        ErrorCode::PermissionDenied
    );
    let blob = invoke(
        &hub,
        ClientRole::PrivilegedHost,
        blob_command,
        token.clone(),
    )
    .await
    .unwrap();
    let png: Vec<u8> = serde_json::from_value(blob["bytes"].clone()).unwrap();
    assert_eq!(
        image::load_from_memory(&png)
            .unwrap()
            .into_rgba8()
            .get_pixel(0, 0)
            .0,
        [20, 40, 60, 128]
    );
    invoke(
        &hub,
        ClientRole::Public,
        "notifications.dismiss",
        json!({"id":id}),
    )
    .await
    .unwrap();
    assert_eq!(next_update(&stream).await["history"], json!([]));
    assert_eq!(
        invoke(&hub, ClientRole::PrivilegedHost, blob_command, token)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );

    notify(&proxy, 0, "clear me", blob_hint()).await;
    let pending = next_update(&stream).await;
    let token = json!({"token": pending["history"][0]["attachment"]["token"]});
    invoke(&hub, ClientRole::Public, "notifications.clear", json!({}))
        .await
        .unwrap();
    assert_eq!(next_update(&stream).await["history"], json!([]));
    assert_eq!(
        invoke(&hub, ClientRole::PrivilegedHost, blob_command, token)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
}

#[tokio::test]
async fn expiry_retains_history_and_shutdown_releases_the_well_known_name() {
    let bus = TestBus::new();
    let client = bus.connection().await;
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    let hub = BusHub::new("test", paths.media_dir());
    let desktop = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Address(bus.address().into()),
            xdg_data_dirs: Vec::new(),
            ..DesktopOptions::default()
        },
    );
    let (initial, stream) = subscribe(&hub, TOPIC).await;
    assert_eq!(ready(initial, &stream).await["available"], true);
    let proxy = dbus_proxy(&client).await;
    let mut closed = proxy.receive_signal("NotificationClosed").await.unwrap();
    let id: u32 = proxy
        .call(
            "Notify",
            &(
                "app",
                0_u32,
                "",
                "expires",
                "body",
                Vec::<String>::new(),
                HashMap::<String, OwnedValue>::new(),
                30_i32,
            ),
        )
        .await
        .unwrap();
    let signal = tokio::time::timeout(
        Duration::from_secs(3),
        poll_fn(|cx| Pin::new(&mut closed).poll_next(cx)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(signal.body().deserialize::<(u32, u32)>().unwrap(), (id, 1));
    assert_eq!(next_update(&stream).await["popups"][0]["id"], id);
    let expired = next_update(&stream).await;
    assert_eq!(expired["popups"], json!([]));
    assert_eq!(expired["history"][0]["id"], id);
    desktop.shutdown().await;
    assert!(
        !DBusProxy::new(&client)
            .await
            .unwrap()
            .name_has_owner(BusName::try_from(NAME).unwrap())
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn an_existing_owner_is_not_replaced_and_disabling_releases_the_name() {
    let bus = TestBus::new();
    let owner = bus.connection().await;
    owner.request_name(NAME).await.unwrap();
    let dbus = DBusProxy::new(&owner).await.unwrap();
    let name = BusName::try_from(NAME).unwrap();
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    let hub = BusHub::new("test", paths.media_dir());
    let desktop = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Address(bus.address().into()),
            xdg_data_dirs: Vec::new(),
            ..DesktopOptions::default()
        },
    );
    let (tray, tray_stream) = subscribe(&hub, "desktop.tray").await;
    assert_eq!(ready(tray, &tray_stream).await["available"], true);
    let (initial, stream) = subscribe(&hub, TOPIC).await;
    assert_eq!(initial["available"], false);
    assert_eq!(
        &dbus.get_name_owner(name.clone()).await.unwrap(),
        owner.unique_name().unwrap()
    );
    owner.release_name(NAME).await.unwrap();
    assert_eq!(next_update(&stream).await["available"], true);

    let proxy = dbus_proxy(&owner).await;
    let capabilities: Vec<String> = proxy.call("GetCapabilities", &()).await.unwrap();
    assert!(capabilities.iter().any(|value| value == "actions"));
    let mut actions = proxy.receive_signal("ActionInvoked").await.unwrap();
    let id = notify(&proxy, 0, "action", blob_hint()).await;
    let _ = next_update(&stream).await;
    invoke(
        &hub,
        ClientRole::Public,
        "notifications.invoke-action",
        json!({"id":id, "action_key":"open"}),
    )
    .await
    .unwrap();
    let signal = tokio::time::timeout(
        Duration::from_secs(3),
        poll_fn(|cx| Pin::new(&mut actions).poll_next(cx)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        signal.body().deserialize::<(u32, &str)>().unwrap(),
        (id, "open")
    );
    desktop.set_notifications(z_shell_desktop::ServiceToggle::Disabled);
    assert_eq!(next_update(&stream).await["available"], false);
    assert!(!dbus.name_has_owner(name).await.unwrap());
}

#[tokio::test]
async fn unavailable_session_bus_does_not_prevent_starting_the_launcher() {
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    let hub = BusHub::new("test", paths.media_dir());
    let _desktop = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Address(format!(
                "unix:path={}/absent.sock",
                root.path().display()
            )),
            xdg_data_dirs: Vec::new(),
            ..DesktopOptions::default()
        },
    );
    for topic in [TOPIC, "desktop.tray", "desktop.media"] {
        let (initial, _) = subscribe(&hub, topic).await;
        assert_eq!(initial["available"], false, "{topic}");
    }
    let (apps, stream) = subscribe(&hub, "desktop.apps").await;
    assert_eq!(ready(apps, &stream).await["available"], true);
}
