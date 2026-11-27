mod common;

use std::{collections::HashMap, future::poll_fn, path::Path, pin::Pin, time::Duration};

use common::{TestBus, invoke, next_update, paths, subscribe};
use image::{Rgba, RgbaImage};
use serde_json::{Value, json};
use z_shell_bus::{BusHub, hub::ClientOutbound};
use z_shell_desktop::{DesktopOptions, DesktopServices, ImeLockState, SessionBusAddress};
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
    assert_eq!(
        first["popups"][0]["attachment"]["dimensions"],
        json!({"width": 1, "height": 1})
    );
    // With empty xdg_data_dirs, unresolved theme names fall back to null so UI renders the bell.
    assert_eq!(first["popups"][0]["icon"], Value::Null);

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
    assert_eq!(missing["history"][0]["icon"], Value::Null);
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
    let acted = next_update(&stream).await;
    assert_eq!(acted["popups"], json!([]));
    assert_eq!(acted["history"][0]["actions"], json!([]));
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

#[tokio::test]
async fn resolves_xdg_app_icons_and_exposes_image_dimensions() {
    let bus = TestBus::new();
    let client = bus.connection().await;
    let root = tempfile::tempdir().unwrap();
    let xdg_data = root.path().join("share");
    let icon_dir = xdg_data.join("icons/hicolor/48x48/apps");
    let apps_dir = xdg_data.join("applications");
    std::fs::create_dir_all(&icon_dir).unwrap();
    std::fs::create_dir_all(&apps_dir).unwrap();

    // Fixture XDG theme icons for Discord (named app_icon) and Ghostty (via .desktop entry).
    RgbaImage::from_pixel(48, 48, Rgba([88, 101, 242, 255]))
        .save(icon_dir.join("discord.png"))
        .unwrap();
    RgbaImage::from_pixel(48, 48, Rgba([34, 40, 56, 255]))
        .save(icon_dir.join("com.mitchellh.ghostty.png"))
        .unwrap();
    std::fs::write(
        apps_dir.join("com.mitchellh.ghostty.desktop"),
        "[Desktop Entry]\nType=Application\nName=Ghostty\nExec=/bin/true\nIcon=com.mitchellh.ghostty\n",
    )
    .unwrap();

    let paths = paths(root.path());
    let hub = BusHub::new("test", paths.media_dir());
    let _desktop = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Address(bus.address().into()),
            tray: false,
            xdg_data_dirs: vec![xdg_data],
            icon_theme: "hicolor".to_owned(),
            ..DesktopOptions::default()
        },
    );
    let (initial, stream) = subscribe(&hub, TOPIC).await;
    assert_eq!(ready(initial, &stream).await["available"], true);
    let proxy = dbus_proxy(&client).await;

    // 1. Discord: theme app_icon="discord" + 128x128 avatar in image-data
    let avatar_bytes = vec![120_u8; 128 * 128 * 4];
    let avatar_hint: OwnedValue = DbusValue::from((
        128_i32,
        128_i32,
        128_i32 * 4,
        true,
        8_i32,
        4_i32,
        avatar_bytes,
    ))
    .try_into()
    .unwrap();
    let _: u32 = proxy
        .call(
            "Notify",
            &(
                "Discord",
                0_u32,
                "discord",
                "QuickFlash",
                "Avatar message",
                Vec::<String>::new(),
                HashMap::from([("image-data", avatar_hint)]),
                0_i32,
            ),
        )
        .await
        .unwrap();
    let discord = next_update(&stream).await;
    let discord_icon: MediaRef = serde_json::from_value(discord["popups"][0]["icon"].clone())
        .expect("resolved discord icon");
    assert!(matches!(discord_icon, MediaRef::RuntimePath { .. }));
    assert_eq!(
        discord["popups"][0]["attachment"]["dimensions"],
        json!({"width": 128, "height": 128})
    );

    // 2. Ghostty: empty app_icon, resolved via desktop-entry / app_name fallback
    let _: u32 = proxy
        .call(
            "Notify",
            &(
                "Ghostty",
                0_u32,
                "",
                "Approval requested",
                "CLI ready",
                Vec::<String>::new(),
                HashMap::<String, OwnedValue>::new(),
                0_i32,
            ),
        )
        .await
        .unwrap();
    let ghostty = next_update(&stream).await;
    let ghostty_icon: MediaRef = serde_json::from_value(ghostty["popups"][0]["icon"].clone())
        .expect("resolved ghostty .desktop icon");
    assert!(matches!(ghostty_icon, MediaRef::RuntimePath { .. }));

    // 3. niri screenshot: 320x180 PNG file passed directly in app_icon carries real dimensions
    let shot = root.path().join("niri-shot.png");
    RgbaImage::from_pixel(320, 180, Rgba([100, 180, 250, 255]))
        .save(&shot)
        .unwrap();
    let _: u32 = proxy
        .call(
            "Notify",
            &(
                "niri",
                0_u32,
                shot.to_str().unwrap(),
                "Screenshot captured",
                "You can paste the image from the clipboard.",
                Vec::<String>::new(),
                HashMap::<String, OwnedValue>::new(),
                0_i32,
            ),
        )
        .await
        .unwrap();
    let niri = next_update(&stream).await;
    let niri_icon: MediaRef =
        serde_json::from_value(niri["popups"][0]["icon"].clone()).expect("cached niri shot");
    assert!(matches!(niri_icon, MediaRef::RuntimePath { .. }));
    assert_eq!(
        niri["popups"][0]["icon"]["dimensions"],
        json!({"width": 320, "height": 180})
    );
}

#[tokio::test]
async fn set_paused_freezes_and_resumes_popup_auto_expiry() {
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
            tray: false,
            xdg_data_dirs: Vec::new(),
            ..DesktopOptions::default()
        },
    );
    let (initial, stream) = subscribe(&hub, TOPIC).await;
    assert_eq!(ready(initial, &stream).await["available"], true);
    let proxy = dbus_proxy(&client).await;

    // Pause before notifying: a short-lived 60ms popup must stay active while paused.
    invoke(
        &hub,
        ClientRole::Public,
        "notifications.set-paused",
        json!({"paused": true}),
    )
    .await
    .unwrap();
    let id: u32 = proxy
        .call(
            "Notify",
            &(
                "Discord",
                0_u32,
                "",
                "Hold me",
                "Hovering pauses countdown",
                Vec::<String>::new(),
                HashMap::<String, OwnedValue>::new(),
                60_i32,
            ),
        )
        .await
        .unwrap();
    let live = next_update(&stream).await;
    assert_eq!(live["popups"][0]["id"], id);

    // Wait well past 60ms while paused: no expiry update may fire.
    tokio::time::sleep(Duration::from_millis(140)).await;
    let still_open = tokio::time::timeout(Duration::from_millis(60), next_update(&stream)).await;
    assert!(
        still_open.is_err(),
        "popup must not expire while notifications.set-paused is true"
    );

    // Resuming restarts countdown and expires the popup cleanly into history.
    invoke(
        &hub,
        ClientRole::Public,
        "notifications.set-paused",
        json!({"paused": false}),
    )
    .await
    .unwrap();
    let expired = tokio::time::timeout(Duration::from_secs(2), next_update(&stream))
        .await
        .expect("resumed popup expires");
    assert_eq!(expired["popups"], json!([]));
    assert_eq!(expired["history"][0]["id"], id);
    desktop.shutdown().await;
}

#[tokio::test]
async fn sanitizes_dbus_notify_body_markup_for_popups_and_history_without_advertising_markup() {
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
            tray: false,
            xdg_data_dirs: Vec::new(),
            ..DesktopOptions::default()
        },
    );
    let (initial, stream) = subscribe(&hub, TOPIC).await;
    assert_eq!(ready(initial, &stream).await["available"], true);
    let proxy = dbus_proxy(&client).await;

    let capabilities: Vec<String> = proxy.call("GetCapabilities", &()).await.unwrap();
    assert_eq!(
        capabilities,
        vec!["actions", "body", "icon-static", "persistence"]
    );
    assert!(!capabilities.iter().any(|cap| cap == "body-markup"));
    assert!(!capabilities.iter().any(|cap| cap == "body-hyperlinks"));

    let cases = [
        (
            "Chrome PWA",
            "<a href=\"https://chat.example.com/room/42\">chat.example.com</a>\n\n<b>Deploy</b> finished &amp; passed",
            "chat.example.com\n\nDeploy finished & passed",
        ),
        (
            "Escaped & Image",
            "&lt;b&gt;raw&lt;/b&gt; &amp;lt; <img src=\"file:///secret.png\" alt=\"Chart &amp; metrics\"/>",
            "<b>raw</b> &lt; Chart & metrics",
        ),
        (
            "Plain Code",
            "a < b && c > d; Vec<String>",
            "a < b && c > d; Vec<String>",
        ),
    ];

    for (summary, raw_body, expected_body) in cases {
        let _: u32 = proxy
            .call(
                "Notify",
                &(
                    "Google Chrome",
                    0_u32,
                    "",
                    summary,
                    raw_body,
                    Vec::<String>::new(),
                    HashMap::<String, OwnedValue>::new(),
                    0_i32,
                ),
            )
            .await
            .expect("Notify with body succeeds");
        let snapshot = next_update(&stream).await;
        for view in ["popups", "history"] {
            assert_eq!(
                snapshot[view][0]["body"], expected_body,
                "{summary} in {view}"
            );
        }
    }

    desktop.shutdown().await;
}

#[tokio::test]
async fn publishes_app_key_and_dismiss_popups_checks_revisions_atomically() {
    let bus = TestBus::new();
    let client = bus.connection().await;
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    let hub = BusHub::new("test", paths.media_dir());
    let desktop = DesktopServices::install_with_options(
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
    let mut closed = proxy.receive_signal("NotificationClosed").await.unwrap();

    // Two notifications sharing identical app_name ("Slack") but distinct desktop-entry hints must yield distinct app_keys.
    let id1: u32 = proxy
        .call(
            "Notify",
            &(
                "Slack",
                0_u32,
                "",
                "Work 1",
                "body",
                Vec::<String>::new(),
                HashMap::from([(
                    "desktop-entry",
                    OwnedValue::try_from(DbusValue::from("  Slack-Work.desktop  ")).unwrap(),
                )]),
                0_i32,
            ),
        )
        .await
        .unwrap();
    let s1 = next_update(&stream).await;
    assert_eq!(s1["popups"][0]["app_key"], "desktop:slack-work");
    let rev1 = s1["popups"][0]["revision"].as_u64().unwrap();

    let id2: u32 = proxy
        .call(
            "Notify",
            &(
                "Slack",
                0_u32,
                "",
                "Personal 1",
                "body",
                Vec::<String>::new(),
                HashMap::from([(
                    "desktop-entry",
                    OwnedValue::try_from(DbusValue::from("slack-personal")).unwrap(),
                )]),
                0_i32,
            ),
        )
        .await
        .unwrap();
    let s2 = next_update(&stream).await;
    assert_eq!(s2["popups"][0]["app_key"], "desktop:slack-personal");
    let rev2 = s2["popups"][0]["revision"].as_u64().unwrap();

    // Unnamed notification falls back to unnamed:<id>
    let id3: u32 = proxy
        .call(
            "Notify",
            &(
                "   ",
                0_u32,
                "",
                "Anon",
                "body",
                Vec::<String>::new(),
                HashMap::<String, OwnedValue>::new(),
                0_i32,
            ),
        )
        .await
        .unwrap();
    let s3 = next_update(&stream).await;
    assert_eq!(s3["popups"][0]["app_key"], format!("unnamed:{id3}"));
    let rev3 = s3["popups"][0]["revision"].as_u64().unwrap();

    // Replace id2 in-flight before calling dismiss-popups with stale rev2.
    let _: u32 = proxy
        .call(
            "Notify",
            &(
                "Slack",
                id2,
                "",
                "Personal replaced",
                "new body",
                Vec::<String>::new(),
                HashMap::from([(
                    "desktop-entry",
                    OwnedValue::try_from(DbusValue::from("slack-personal")).unwrap(),
                )]),
                0_i32,
            ),
        )
        .await
        .unwrap();
    let _ = next_update(&stream).await;

    // Atomically dismiss id1 (matching rev1) and stale (id2, rev2) plus id3 (matching rev3).
    // Stale id2 must remain a popup; id1 & id3 leave popups but stay in history!
    invoke(
        &hub,
        ClientRole::Public,
        "notifications.dismiss-popups",
        json!({
            "items": [
                { "id": id1, "revision": rev1 },
                { "id": id2, "revision": rev2 },
                { "id": id3, "revision": rev3 }
            ]
        }),
    )
    .await
    .unwrap();

    let after = next_update(&stream).await;
    assert_eq!(after["popups"].as_array().unwrap().len(), 1);
    assert_eq!(after["popups"][0]["id"], id2);
    assert_eq!(after["popups"][0]["summary"], "Personal replaced");
    assert_eq!(
        after["history"].as_array().unwrap().len(),
        3,
        "dismiss-popups must leave history intact"
    );

    // Collect NotificationClosed signals for id1 and id3 (DISMISSED = 2).
    let mut dismissed_signals = Vec::new();
    for _ in 0..2 {
        let sig = tokio::time::timeout(
            Duration::from_secs(2),
            poll_fn(|cx| Pin::new(&mut closed).poll_next(cx)),
        )
        .await
        .unwrap()
        .unwrap();
        dismissed_signals.push(sig.body().deserialize::<(u32, u32)>().unwrap());
    }
    assert!(dismissed_signals.contains(&(id1, 2)));
    assert!(dismissed_signals.contains(&(id3, 2)));

    // Reject unknown fields and oversized batches (> 100).
    assert_eq!(
        invoke(
            &hub,
            ClientRole::Public,
            "notifications.dismiss-popups",
            json!({ "items": [], "extra": true }),
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::InvalidParams
    );
    let oversized: Vec<Value> = (1..=101).map(|i| json!({"id": i, "revision": 1})).collect();
    assert_eq!(
        invoke(
            &hub,
            ClientRole::Public,
            "notifications.dismiss-popups",
            json!({ "items": oversized }),
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::InvalidParams
    );

    desktop.shutdown().await;
}

#[tokio::test]
async fn archived_history_clears_actions_isolates_replaces_id_and_rejects_closed_dbus_close() {
    let bus = TestBus::new();
    let client = bus.connection().await;
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    let hub = BusHub::new("test", paths.media_dir());
    let desktop = DesktopServices::install_with_options(
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
    let mut closed = proxy.receive_signal("NotificationClosed").await.unwrap();

    // 1. Expiring notification starts with actions while open, then clears actions once archived.
    let id1: u32 = proxy
        .call(
            "Notify",
            &(
                "Chat",
                0_u32,
                "",
                "Expiring message",
                "Original body",
                vec!["default", "Open", "reply", "Reply"],
                HashMap::<String, OwnedValue>::new(),
                40_i32,
            ),
        )
        .await
        .unwrap();
    let live1 = next_update(&stream).await;
    assert_eq!(live1["popups"][0]["id"], id1);
    assert_eq!(live1["popups"][0]["actions"].as_array().unwrap().len(), 2);
    assert_eq!(live1["history"][0]["actions"].as_array().unwrap().len(), 2);

    let sig1 = tokio::time::timeout(
        Duration::from_secs(3),
        poll_fn(|cx| Pin::new(&mut closed).poll_next(cx)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(sig1.body().deserialize::<(u32, u32)>().unwrap(), (id1, 1));

    let expired1 = next_update(&stream).await;
    assert_eq!(expired1["popups"], json!([]));
    assert_eq!(expired1["history"][0]["id"], id1);
    assert_eq!(expired1["history"][0]["summary"], "Expiring message");
    assert_eq!(
        expired1["history"][0]["actions"],
        json!([]),
        "expired history entries must strip actions so no dead buttons render"
    );
    assert_eq!(
        invoke(
            &hub,
            ClientRole::Public,
            "notifications.invoke-action",
            json!({"id": id1, "action_key": "default"}),
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::NotFound
    );

    // 2. Notify with replaces_id targeting closed id1 must allocate a new ID and keep id1 immutable.
    let id2: u32 = proxy
        .call(
            "Notify",
            &(
                "Chat",
                id1,
                "",
                "Replacement attempt",
                "New body",
                vec!["open", "Open"],
                HashMap::<String, OwnedValue>::new(),
                0_i32,
            ),
        )
        .await
        .unwrap();
    assert_ne!(
        id2, id1,
        "replaces_id targeting an archived notification must allocate a fresh ID"
    );
    let after_replace = next_update(&stream).await;
    assert_eq!(after_replace["popups"].as_array().unwrap().len(), 1);
    assert_eq!(after_replace["popups"][0]["id"], id2);
    assert_eq!(after_replace["history"].as_array().unwrap().len(), 2);
    assert_eq!(after_replace["history"][0]["id"], id2);
    assert_eq!(
        after_replace["history"][0]["actions"],
        json!([{"key": "open", "label": "Open"}])
    );
    assert_eq!(after_replace["history"][1]["id"], id1);
    assert_eq!(after_replace["history"][1]["summary"], "Expiring message");
    assert_eq!(after_replace["history"][1]["actions"], json!([]));

    // 3. Dismissing popups into history also clears actions and prevents future replaces_id mutation.
    let rev2 = after_replace["popups"][0]["revision"].as_u64().unwrap();
    invoke(
        &hub,
        ClientRole::Public,
        "notifications.dismiss-popups",
        json!({"items": [{"id": id2, "revision": rev2}]}),
    )
    .await
    .unwrap();
    let after_dismiss_popup = next_update(&stream).await;
    assert_eq!(after_dismiss_popup["popups"], json!([]));
    assert_eq!(after_dismiss_popup["history"][0]["id"], id2);
    assert_eq!(
        after_dismiss_popup["history"][0]["actions"],
        json!([]),
        "dismissed popup retained in history must also clear actions"
    );
    let sig2 = tokio::time::timeout(
        Duration::from_secs(2),
        poll_fn(|cx| Pin::new(&mut closed).poll_next(cx)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(sig2.body().deserialize::<(u32, u32)>().unwrap(), (id2, 2));

    let id3: u32 = proxy
        .call(
            "Notify",
            &(
                "Chat",
                id2,
                "",
                "Open target",
                "Body 3",
                vec!["open", "Open"],
                HashMap::<String, OwnedValue>::new(),
                0_i32,
            ),
        )
        .await
        .unwrap();
    assert_ne!(id3, id2);
    let s3 = next_update(&stream).await;
    assert_eq!(s3["history"].as_array().unwrap().len(), 3);

    // 4. CloseNotification rejects 0, unknown IDs, and already-closed history IDs with InvalidArgs.
    for bad_id in [0_u32, 999_999_u32, id1, id2] {
        let err = proxy
            .call::<_, _, ()>("CloseNotification", &(bad_id,))
            .await
            .expect_err("CloseNotification must error for 0, unknown, or closed ID");
        assert!(
            matches!(
                &err,
                zbus::Error::MethodError(name, _, _)
                    if name.as_str() == "org.freedesktop.DBus.Error.InvalidArgs"
            ),
            "expected InvalidArgs for CloseNotification({bad_id}), got {err:?}"
        );
    }

    // Open notification id3 closes cleanly with CLOSED_BY_CLIENT (3), then rejects a repeat close.
    proxy
        .call::<_, _, ()>("CloseNotification", &(id3,))
        .await
        .expect("CloseNotification succeeds for open notification");
    let after_close3 = next_update(&stream).await;
    assert_eq!(after_close3["popups"], json!([]));
    assert_eq!(
        after_close3["history"].as_array().unwrap().len(),
        2,
        "archived entries id1 and id2 remain untouched"
    );
    let sig3 = tokio::time::timeout(
        Duration::from_secs(2),
        poll_fn(|cx| Pin::new(&mut closed).poll_next(cx)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(sig3.body().deserialize::<(u32, u32)>().unwrap(), (id3, 3));

    let repeat_err = proxy
        .call::<_, _, ()>("CloseNotification", &(id3,))
        .await
        .expect_err("repeat CloseNotification on closed ID must error");
    assert!(matches!(
        &repeat_err,
        zbus::Error::MethodError(name, _, _)
            if name.as_str() == "org.freedesktop.DBus.Error.InvalidArgs"
    ));

    desktop.shutdown().await;
}

#[tokio::test]
async fn locking_hides_popups_suppresses_live_toasts_and_denies_invoke_action() {
    let bus = TestBus::new();
    let client = bus.connection().await;
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    let hub = BusHub::new("test", paths.media_dir());
    let desktop = DesktopServices::install_with_options(
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
    let mut actions = proxy.receive_signal("ActionInvoked").await.unwrap();

    let id1 = notify(&proxy, 0, "before-lock", blob_hint()).await;
    let live1 = next_update(&stream).await;
    assert_eq!(live1["popups"][0]["id"], id1);

    // Transitioning to Locked must immediately hide active popups while retaining history.
    desktop.set_locked(ImeLockState::Locked);
    let locked_snap = next_update(&stream).await;
    assert_eq!(locked_snap["popups"], json!([]));
    assert_eq!(locked_snap["history"][0]["id"], id1);

    // Invoking actions while locked must fail with PermissionDenied without emitting ActionInvoked.
    for payload in [json!({"id": id1, "action_key": "open"}), json!({})] {
        assert_eq!(
            invoke(
                &hub,
                ClientRole::Public,
                "notifications.invoke-action",
                payload,
            )
            .await
            .expect_err("notifications.invoke-action must be denied while locked")
            .code,
            ErrorCode::PermissionDenied
        );
    }

    // Incoming notifications while locked are recorded in history without live popup delivery.
    let id2 = notify(&proxy, 0, "during-lock", blob_hint()).await;
    let during_lock = next_update(&stream).await;
    assert_eq!(
        during_lock["popups"],
        json!([]),
        "live popups must stay suppressed while locked"
    );
    assert_eq!(during_lock["history"][0]["id"], id2);
    assert_eq!(during_lock["history"][1]["id"], id1);

    // Unlocking restores action invocation on open notifications and resumes popup delivery for new arrivals.
    desktop.set_locked(ImeLockState::Unlocked);
    invoke(
        &hub,
        ClientRole::Public,
        "notifications.invoke-action",
        json!({"id": id2, "action_key": "open"}),
    )
    .await
    .expect("open notification action succeeds once unlocked");
    let invoked = tokio::time::timeout(
        Duration::from_secs(3),
        poll_fn(|cx| Pin::new(&mut actions).poll_next(cx)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        invoked.body().deserialize::<(u32, &str)>().unwrap(),
        (id2, "open")
    );
    let acted2 = next_update(&stream).await;
    assert_eq!(acted2["history"][0]["id"], id2);
    assert_eq!(acted2["history"][0]["actions"], json!([]));

    let id3 = notify(&proxy, 0, "after-unlock", blob_hint()).await;
    let unlocked_live = next_update(&stream).await;
    assert_eq!(unlocked_live["popups"].as_array().unwrap().len(), 1);
    assert_eq!(unlocked_live["popups"][0]["id"], id3);

    desktop.shutdown().await;
}

#[tokio::test]
async fn honors_transient_resident_and_critical_urgency_hints() {
    let bus = TestBus::new();
    let client = bus.connection().await;
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    let hub = BusHub::new("test", paths.media_dir());
    let desktop = DesktopServices::install_with_options(
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
    let mut actions = proxy.receive_signal("ActionInvoked").await.unwrap();
    let mut closed = proxy.receive_signal("NotificationClosed").await.unwrap();

    // 1. transient = true: appears in popups, excluded from history while open, and discarded on expiry.
    let (_, img_data) = blob_hint();
    let transient_id: u32 = proxy
        .call(
            "Notify",
            &(
                "OSD",
                0_u32,
                "",
                "Volume 65%",
                "",
                Vec::<String>::new(),
                HashMap::from([
                    (
                        "transient",
                        OwnedValue::try_from(DbusValue::from(true)).unwrap(),
                    ),
                    ("image-data", img_data),
                ]),
                40_i32,
            ),
        )
        .await
        .unwrap();
    let transient_live = next_update(&stream).await;
    assert_eq!(transient_live["popups"][0]["id"], transient_id);
    assert_eq!(
        transient_live["history"],
        json!([]),
        "transient notification must not enter retained history"
    );
    let transient_token = json!({"token": transient_live["popups"][0]["attachment"]["token"]});

    let exp_sig = tokio::time::timeout(
        Duration::from_secs(3),
        poll_fn(|cx| Pin::new(&mut closed).poll_next(cx)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        exp_sig.body().deserialize::<(u32, u32)>().unwrap(),
        (transient_id, 1)
    );
    let transient_expired = next_update(&stream).await;
    assert_eq!(transient_expired["popups"], json!([]));
    assert_eq!(transient_expired["history"], json!([]));
    assert_eq!(
        invoke(
            &hub,
            ClientRole::PrivilegedHost,
            "notifications.fetch-blob",
            transient_token
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::NotFound,
        "discarded transient notification revokes its blob"
    );

    // 2. Non-resident notification: invoke-action emits ActionInvoked then NotificationClosed(2)
    //    and archives to history with actions: [] (or discards completely if transient = true).
    let std_id: u32 = proxy
        .call(
            "Notify",
            &(
                "Mail",
                0_u32,
                "",
                "New message",
                "Click to open",
                vec!["open", "Open", "archive", "Archive"],
                HashMap::<String, OwnedValue>::new(),
                0_i32,
            ),
        )
        .await
        .unwrap();
    let std_live = next_update(&stream).await;
    assert_eq!(std_live["popups"][0]["id"], std_id);

    invoke(
        &hub,
        ClientRole::Public,
        "notifications.invoke-action",
        json!({"id": std_id, "action_key": "open"}),
    )
    .await
    .unwrap();
    let act_sig = tokio::time::timeout(
        Duration::from_secs(2),
        poll_fn(|cx| Pin::new(&mut actions).poll_next(cx)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        act_sig.body().deserialize::<(u32, &str)>().unwrap(),
        (std_id, "open")
    );
    let close_sig = tokio::time::timeout(
        Duration::from_secs(2),
        poll_fn(|cx| Pin::new(&mut closed).poll_next(cx)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        close_sig.body().deserialize::<(u32, u32)>().unwrap(),
        (std_id, 2)
    );
    let std_after = next_update(&stream).await;
    assert_eq!(std_after["popups"], json!([]));
    assert_eq!(std_after["history"][0]["id"], std_id);
    assert_eq!(std_after["history"][0]["actions"], json!([]));

    // Transient + action: discarded completely after ActionInvoked + NotificationClosed(2).
    let trans_act_id: u32 = proxy
        .call(
            "Notify",
            &(
                "Alert",
                0_u32,
                "",
                "Ephemeral prompt",
                "",
                vec!["ack", "Acknowledge"],
                HashMap::from([(
                    "transient",
                    OwnedValue::try_from(DbusValue::from(true)).unwrap(),
                )]),
                0_i32,
            ),
        )
        .await
        .unwrap();
    let _ = next_update(&stream).await;
    invoke(
        &hub,
        ClientRole::Public,
        "notifications.invoke-action",
        json!({"id": trans_act_id, "action_key": "ack"}),
    )
    .await
    .unwrap();
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        poll_fn(|cx| Pin::new(&mut actions).poll_next(cx)),
    )
    .await
    .unwrap()
    .unwrap();
    let trans_close_sig = tokio::time::timeout(
        Duration::from_secs(2),
        poll_fn(|cx| Pin::new(&mut closed).poll_next(cx)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        trans_close_sig.body().deserialize::<(u32, u32)>().unwrap(),
        (trans_act_id, 2)
    );
    let trans_after_act = next_update(&stream).await;
    assert_eq!(trans_after_act["popups"], json!([]));
    assert_eq!(trans_after_act["history"].as_array().unwrap().len(), 1);
    assert_eq!(trans_after_act["history"][0]["id"], std_id);

    // 3. resident = true: invoke-action emits ActionInvoked without closing, keeping notification active.
    let res_id: u32 = proxy
        .call(
            "Notify",
            &(
                "Player",
                0_u32,
                "",
                "Now Playing",
                "Track 1",
                vec!["play", "Play/Pause", "next", "Next"],
                HashMap::from([(
                    "resident",
                    OwnedValue::try_from(DbusValue::from(true)).unwrap(),
                )]),
                0_i32,
            ),
        )
        .await
        .unwrap();
    let res_live = next_update(&stream).await;
    assert_eq!(res_live["popups"][0]["id"], res_id);

    for key in ["play", "next"] {
        invoke(
            &hub,
            ClientRole::Public,
            "notifications.invoke-action",
            json!({"id": res_id, "action_key": key}),
        )
        .await
        .expect("resident notification stays open across multiple action invocations");
        let sig = tokio::time::timeout(
            Duration::from_secs(2),
            poll_fn(|cx| Pin::new(&mut actions).poll_next(cx)),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            sig.body().deserialize::<(u32, &str)>().unwrap(),
            (res_id, key)
        );
    }
    assert!(
        tokio::time::timeout(
            Duration::from_millis(60),
            poll_fn(|cx| Pin::new(&mut closed).poll_next(cx)),
        )
        .await
        .is_err(),
        "resident notification must not emit NotificationClosed on invoke-action"
    );

    // 4. Critical urgency (urgency == 2) with expire_timeout < 0 stays open past 5000ms default timeout.
    let crit_id: u32 = proxy
        .call(
            "Notify",
            &(
                "Power",
                0_u32,
                "",
                "Battery Critical (3%)",
                "Plug in AC adapter immediately",
                Vec::<String>::new(),
                HashMap::from([(
                    "urgency",
                    OwnedValue::try_from(DbusValue::from(2_u8)).unwrap(),
                )]),
                -1_i32,
            ),
        )
        .await
        .unwrap();
    let crit_live = next_update(&stream).await;
    assert_eq!(crit_live["popups"][0]["id"], crit_id);
    assert_eq!(crit_live["popups"][0]["urgency"], 2);

    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(6)).await;
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    tokio::time::resume();

    assert!(
        tokio::time::timeout(Duration::from_millis(50), next_update(&stream))
            .await
            .is_err(),
        "urgency == 2 with expire_timeout < 0 must not auto-expire after 5000ms"
    );
    proxy
        .call::<_, _, ()>("CloseNotification", &(crit_id,))
        .await
        .expect("critical notification is still open after 6s");

    desktop.shutdown().await;
}
