mod common;

use std::fs;

use common::{client, fixture, invoke, receive, subscribe};
use serde_json::json;
use tempfile::tempdir;
use z_shell_protocol::{ClientRole, ErrorCode, ServerMessage};
use z_shell_system::{SystemBusAddress, SystemOptions, SystemServices};

#[tokio::test]
async fn headless_install_publishes_all_topics_and_keeps_commands_safe() {
    let dir = tempdir().unwrap();
    let (paths, hub) = fixture(&dir);
    let backlight_root = dir.path().join("backlight");
    let handle = SystemServices::install_with_options(
        &hub,
        &paths,
        SystemOptions {
            pulse: None,
            system_bus: SystemBusAddress::Disabled,
            proc_root: dir.path().join("proc"),
            sys_root: dir.path().join("sys"),
            backlight_root: backlight_root.clone(),
        },
    );
    let topics: Vec<_> = hub
        .list_topics()
        .into_iter()
        .filter(|entry| entry.topic.as_str().starts_with("system."))
        .map(|entry| (entry.topic.to_string(), entry.revision))
        .collect();
    assert_eq!(
        topics,
        [
            "audio",
            "bluetooth",
            "brightness",
            "network",
            "power",
            "privacy",
            "telemetry",
            "user"
        ]
        .map(|name| (format!("system.{name}"), 1))
    );
    let (id, out) = client(&hub).await;
    for topic in [
        "system.network",
        "system.bluetooth",
        "system.power",
        "system.brightness",
    ] {
        assert_eq!(
            subscribe(&hub, id, &out, topic).await["available"],
            false,
            "{topic}"
        );
    }
    assert_eq!(
        subscribe(&hub, id, &out, "system.privacy").await["camera"],
        "unknown"
    );
    for (command, payload) in [
        (
            "audio.set-mute",
            json!({"kind":"sink","index":4,"muted":true}),
        ),
        ("network.wifi.set-enabled", json!({"enabled":true})),
        (
            "bluetooth.set-power",
            json!({"adapter":"/org/bluez/hci0","powered":true}),
        ),
        ("power.set-profile", json!({"profile":"balanced"})),
    ] {
        let failure = invoke(&hub, ClientRole::Public, command, Some(payload))
            .await
            .unwrap_err();
        assert_eq!(failure.code, ErrorCode::Disabled, "{command}: {failure:?}");
    }
    let failure = invoke(
        &hub,
        ClientRole::Public,
        "network.wifi.connect",
        Some(json!({"ap_id":"/org/freedesktop/NetworkManager/AccessPoint/1", "password":"private-example"})),
    ).await.unwrap_err();
    assert_eq!(failure.code, ErrorCode::PermissionDenied);
    assert!(
        !serde_json::to_string(&failure)
            .unwrap()
            .contains("private-example")
    );

    let panel = backlight_root.join("panel");
    fs::create_dir_all(&panel).unwrap();
    fs::write(panel.join("brightness"), "11").unwrap();
    fs::write(panel.join("max_brightness"), "40").unwrap();
    let ServerMessage::Notification { params, .. } = receive(&out).await else {
        panic!("expected the first observed backlight state");
    };
    assert_eq!(params["topic"], "system.brightness");
    assert_eq!(params["source_baseline"], true);
    assert_eq!(params["data"]["devices"][0]["controllable"], true);
    invoke(
        &hub,
        ClientRole::Public,
        "brightness.set",
        Some(json!({"device":"panel","value":80})),
    )
    .await
    .unwrap();
    assert_eq!(fs::read_to_string(panel.join("brightness")).unwrap(), "40");

    let failure = invoke(&hub, ClientRole::Public, "power.poweroff", None)
        .await
        .unwrap_err();
    assert_eq!(failure.code, ErrorCode::PermissionDenied);
    let missing_suspend = invoke(&hub, ClientRole::PrivilegedHost, "power.suspend", None)
        .await
        .unwrap_err();
    assert_eq!(missing_suspend.code, ErrorCode::NotFound);
    let failure = invoke(&hub, ClientRole::Public, "audio.set-mute", None)
        .await
        .unwrap_err();
    assert_eq!(failure.code, ErrorCode::InvalidParams);
    drop(handle);
    let failure = invoke(&hub, ClientRole::Public, "audio.set-mute", None)
        .await
        .unwrap_err();
    assert_eq!(failure.code, ErrorCode::Disabled);
}
