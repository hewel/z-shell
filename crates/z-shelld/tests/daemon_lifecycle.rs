//! End-to-end tests for `z-shelld` trust boundaries, atomic state persistence, reload deduplication,
//! failure non-mutation, and graceful shutdown.

use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use tempfile::TempDir;
use tokio::time::{Duration, timeout};
use z_shell_bus::{BusClient, ClientError};
use z_shell_config::ShellPaths;
use z_shell_protocol::{
    CommandInvokeParams, CommandName, ErrorCode, ServerMessage, TopicName, TopicUpdate, methods,
};
use z_shelld::{DaemonApp, DaemonBus, DaemonOptions};

#[tokio::test]
async fn enforces_host_trust_atomic_state_and_deduped_settings_reload() {
    let dir = TempDir::new().unwrap();
    let paths = ShellPaths::from_roots(
        dir.path().join("config"),
        dir.path().join("state"),
        dir.path().join("runtime"),
        dir.path().join("runtime/bus.sock"),
    );

    let app = DaemonApp::bootstrap(paths.clone()).unwrap();
    let server_task = tokio::spawn(async move { app.run().await });

    let mut public_client = BusClient::connect(paths.socket_path()).await.unwrap();
    let host_client = BusClient::connect(paths.host_socket_path()).await.unwrap();

    // Public client cannot invoke privileged host commands (`quit`, `state.set-table`, `state.get-table`).
    let denied_quit = public_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("quit").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        denied_quit,
        ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::PermissionDenied
    ));

    let denied_write = public_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("state.set-table").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "key": "k", "value": 1 })),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        denied_write,
        ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::PermissionDenied
    ));

    // Subscribe to settings and verify reload with NO changes emits no live topic update.
    let settings_snap = public_client
        .subscribe(TopicName::try_new("settings").unwrap())
        .await
        .unwrap();
    assert_eq!(settings_snap.revision, 1);

    let noop_reload = public_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("settings.reload").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap();
    assert_eq!(noop_reload.message.as_deref(), Some("settings unchanged"));
    assert!(
        timeout(
            Duration::from_millis(100),
            public_client.next_notification()
        )
        .await
        .is_err(),
        "unchanged settings.reload must not emit live topic.update"
    );

    // Edit settings.toml on disk and trigger live reload.
    std::fs::write(
        paths.settings_file(),
        "[general]\noffline_mode = true\n\n[bar]\nposition = \"left\"\ngaps = 10\n",
    )
    .unwrap();
    public_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("settings.reload").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap();

    let Some(ServerMessage::Notification { method, params, .. }) =
        timeout(Duration::from_secs(2), public_client.next_notification())
            .await
            .unwrap()
    else {
        panic!("expected settings topic.update");
    };
    assert_eq!(method, methods::TOPIC_UPDATE);
    let update: TopicUpdate = serde_json::from_value(params).unwrap();
    assert!(!update.source_baseline);
    assert_eq!(update.revision, 2);
    assert_eq!(update.data["general"]["offline_mode"], json!(true));

    // Concurrent state.set-table writes from host client serialize cleanly and agree across disk,
    // state.get-table, and state topic.
    let state_snap = host_client
        .subscribe(TopicName::try_new("state").unwrap())
        .await
        .unwrap();
    assert_eq!(state_snap.revision, 1);

    let (r1, r2) = tokio::join!(
        host_client.invoke_command(CommandInvokeParams {
            name: CommandName::try_new("state.set-table").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "key": "alpha", "value": { "v": 1 } })),
        }),
        host_client.invoke_command(CommandInvokeParams {
            name: CommandName::try_new("state.set-table").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "key": "beta", "value": { "v": 2 } })),
        })
    );
    r1.unwrap();
    r2.unwrap();

    let alpha = host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("state.get-table").unwrap(),
            args: vec!["alpha".to_owned()],
            payload: None,
        })
        .await
        .unwrap();
    assert_eq!(alpha.data.unwrap()["value"]["v"], json!(1));

    let beta = host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("state.get-table").unwrap(),
            args: vec!["beta".to_owned()],
            payload: None,
        })
        .await
        .unwrap();
    assert_eq!(beta.data.unwrap()["value"]["v"], json!(2));

    // Make state directory read-only and verify failed save does NOT mutate memory or revision!
    let rev_before_fail = host_client
        .list_topics()
        .await
        .unwrap()
        .into_iter()
        .find(|t| t.topic.as_str() == "state")
        .unwrap()
        .revision;

    std::fs::set_permissions(paths.state_dir(), std::fs::Permissions::from_mode(0o500)).unwrap();
    let fail_res = host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("state.set-table").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "key": "gamma", "value": { "v": 3 } })),
        })
        .await;
    // Restore permissions immediately so TempDir cleanup succeeds even on failure.
    std::fs::set_permissions(paths.state_dir(), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(fail_res.is_err(), "write to read-only state_dir must fail");

    let gamma = host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("state.get-table").unwrap(),
            args: vec!["gamma".to_owned()],
            payload: None,
        })
        .await
        .unwrap();
    assert_eq!(gamma.data.unwrap()["value"], json!(null));

    let rev_after_fail = host_client
        .list_topics()
        .await
        .unwrap()
        .into_iter()
        .find(|t| t.topic.as_str() == "state")
        .unwrap()
        .revision;
    assert_eq!(rev_before_fail, rev_after_fail);

    // Host client shuts down gracefully and receives the `quit` response before exit.
    let quit_res = host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("quit").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap();
    assert_eq!(quit_res.message.as_deref(), Some("shutting down"));

    timeout(Duration::from_secs(3), server_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!paths.socket_path().exists());
    assert!(!paths.host_socket_path().exists());
}

#[tokio::test]
async fn wires_desktop_settings_and_protects_clipboard_ime_and_polkit_on_session_lock() {
    let dir = TempDir::new().unwrap();
    let paths = ShellPaths::from_roots(
        dir.path().join("config"),
        dir.path().join("state"),
        dir.path().join("runtime"),
        dir.path().join("runtime/bus.sock"),
    );
    paths.ensure_dirs().unwrap();
    std::fs::write(paths.settings_file(), "[ime]\nmode = \"disabled\"\n").unwrap();

    let app = DaemonApp::bootstrap(paths.clone()).unwrap();
    let server_task = tokio::spawn(async move { app.run().await });

    let mut public_client = BusClient::connect(paths.socket_path()).await.unwrap();
    let mut host_client = BusClient::connect(paths.host_socket_path()).await.unwrap();

    let topics: Vec<String> = public_client
        .list_topics()
        .await
        .unwrap()
        .into_iter()
        .map(|entry| entry.topic.as_str().to_owned())
        .collect();
    for expected in [
        "desktop.notifications",
        "desktop.tray",
        "desktop.media",
        "desktop.apps",
        "desktop.ime",
        "desktop.ime.panel",
        "session.lock",
        "session.idle",
        "session.polkit",
    ] {
        assert!(
            topics.iter().any(|name| name == expected),
            "missing expected core topic {expected} in {topics:?}"
        );
    }

    let polkit = public_client
        .subscribe(TopicName::try_new("session.polkit").unwrap())
        .await
        .unwrap();
    assert_eq!(polkit.data["enabled"], true);
    assert_eq!(polkit.data["locked_suppressed"], false);
    assert!(polkit.data["active"].is_null());
    public_client
        .unsubscribe(TopicName::try_new("session.polkit").unwrap())
        .await
        .unwrap();

    let ime_snap = public_client
        .subscribe(TopicName::try_new("desktop.ime").unwrap())
        .await
        .unwrap();
    assert_eq!(ime_snap.data["mode"], json!("disabled"));
    assert_eq!(ime_snap.data["candidate_layout"], json!("auto"));
    assert_eq!(ime_snap.data["switch_osd"], json!(true));

    std::fs::write(
        paths.settings_file(),
        r#"
[ime]
mode = "indicator_only"
candidate_layout = "vertical"
switch_osd = false

[polkit]
enabled = false
"#,
    )
    .unwrap();
    let settings = public_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("settings.reload").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(
        settings["ime"],
        json!({
            "mode": "indicator_only",
            "candidate_layout": "vertical",
            "switch_osd": false,
        })
    );
    assert_eq!(settings["polkit"]["enabled"], false);
    let polkit = public_client
        .subscribe(TopicName::try_new("session.polkit").unwrap())
        .await
        .unwrap();
    assert_eq!(polkit.data["enabled"], false);
    assert_eq!(polkit.data["registered"], false);
    public_client
        .unsubscribe(TopicName::try_new("session.polkit").unwrap())
        .await
        .unwrap();

    let ime_update: TopicUpdate = timeout(Duration::from_secs(2), async {
        loop {
            let Some(ServerMessage::Notification { method, params }) =
                public_client.next_notification().await
            else {
                panic!("expected input method topic.update before socket closed");
            };
            assert_eq!(method, methods::TOPIC_UPDATE);
            let update: TopicUpdate = serde_json::from_value(params).unwrap();
            if update.topic.as_str() == "desktop.ime" {
                return update;
            }
        }
    })
    .await
    .expect("settings reload must publish an input method update");
    assert!(ime_update.revision > ime_snap.revision);
    assert!(ime_update.source_baseline);
    assert_eq!(ime_update.data["mode"], json!("indicator_only"));
    assert_eq!(ime_update.data["candidate_layout"], json!("vertical"));
    assert_eq!(ime_update.data["switch_osd"], json!(false));
    public_client
        .unsubscribe(TopicName::try_new("desktop.ime").unwrap())
        .await
        .unwrap();

    // The public socket cannot call host controls or configure executable idle actions.
    for (name, payload) in [
        (
            "host.lock-ack",
            json!({ "lock_id": 1, "ui_session_generation": 1 }),
        ),
        ("idle.configure", json!({ "rules": [] })),
        (
            "host.polkit-respond",
            json!({"request_id": 1, "response": "not-a-credential"}),
        ),
    ] {
        let denied = public_client
            .invoke_command(CommandInvokeParams {
                name: CommandName::try_new(name).unwrap(),
                args: Vec::new(),
                payload: Some(payload),
            })
            .await
            .unwrap_err();
        assert!(
            matches!(denied, ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::PermissionDenied),
            "expected PermissionDenied for public {name}, got {denied:?}"
        );
    }

    // Subscribe to clipboard so we can observe the cross-domain lock transition.
    let clipboard_snap = host_client
        .subscribe(TopicName::try_new("clipboard").unwrap())
        .await
        .unwrap();
    assert_eq!(clipboard_snap.data["locked"], json!("unlocked"));

    // Register host generation, request lock, and acknowledge it from host socket.
    host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("host.session-register").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "ui_session_generation": 7 })),
        })
        .await
        .unwrap();
    let lock_req = public_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("lock.request").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap();
    let lock_id = lock_req.data.unwrap()[0]["data"]["lock_id"]
        .as_u64()
        .unwrap();
    let polkit = public_client
        .subscribe(TopicName::try_new("session.polkit").unwrap())
        .await
        .unwrap();
    assert_eq!(polkit.data["locked_suppressed"], true);
    assert!(polkit.data["active"].is_null());
    public_client
        .unsubscribe(TopicName::try_new("session.polkit").unwrap())
        .await
        .unwrap();
    let denied_while_engaging = public_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("ime.toggle").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        denied_while_engaging,
        ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::PermissionDenied
    ));
    host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("host.lock-ack").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "lock_id": lock_id, "ui_session_generation": 7 })),
        })
        .await
        .unwrap();

    // Wait for CrossDomainBridge to propagate lock state to ClipboardService.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        let Some(ServerMessage::Notification { method, params, .. }) = timeout(
            deadline.saturating_duration_since(tokio::time::Instant::now()),
            host_client.next_notification(),
        )
        .await
        .unwrap() else {
            panic!("expected clipboard topic.update");
        };
        if method == methods::TOPIC_UPDATE {
            let update: TopicUpdate = serde_json::from_value(params).unwrap();
            if update.topic.as_str() == "clipboard" && update.data["locked"] == json!("locked") {
                break;
            }
        }
    }

    // Public commands for both domains must be denied while locked.
    for name in ["clipboard.list", "ime.toggle"] {
        let denied = public_client
            .invoke_command(CommandInvokeParams {
                name: CommandName::try_new(name).unwrap(),
                args: Vec::new(),
                payload: None,
            })
            .await
            .unwrap_err();
        assert!(
            matches!(&denied, ClientError::Rpc(rpc) if rpc.code == ErrorCode::PermissionDenied),
            "expected PermissionDenied for locked {name}, got {denied:?}"
        );
    }

    // Reloading declarative [[idle.rules]] from settings.toml must update session.idle live!
    std::fs::write(
        paths.settings_file(),
        r#"
[ime]
mode = "indicator_only"
candidate_layout = "vertical"
switch_osd = false

[idle]
pre_action_fade_seconds = 3

[[idle.rules]]
name = "quick-screen-off"
enabled = true
timeout_seconds = 45
action = "screen_off"
"#,
    )
    .unwrap();
    public_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("settings.reload").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap();
    let polkit = public_client
        .subscribe(TopicName::try_new("session.polkit").unwrap())
        .await
        .unwrap();
    assert_eq!(polkit.data["enabled"], true);
    assert_eq!(polkit.data["locked_suppressed"], true);
    public_client
        .unsubscribe(TopicName::try_new("session.polkit").unwrap())
        .await
        .unwrap();
    let idle_status = public_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("idle.status").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap();
    let rules = idle_status.data.unwrap()["rules"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0]["name"], json!("quick-screen-off"));
    assert_eq!(rules[0]["enabled"], json!(true));
    assert_eq!(rules[0]["timeout_seconds"], json!(45));
    assert_eq!(rules[0]["pre_action_fade_seconds"], json!(3));

    // Subscribe public_client to session.lock, then drop host_client abruptly ->
    // Coordinator::host_disconnected must fire immediately (host_connected=false) while staying
    // fail-closed in phase="locked"!
    let lock_snap = public_client
        .subscribe(TopicName::try_new("session.lock").unwrap())
        .await
        .unwrap();
    assert_eq!(lock_snap.data["host_connected"], json!(true));
    assert_eq!(lock_snap.data["phase"], json!("locked"));

    drop(host_client);
    let disconnect_deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        let Some(ServerMessage::Notification { method, params, .. }) = timeout(
            disconnect_deadline.saturating_duration_since(tokio::time::Instant::now()),
            public_client.next_notification(),
        )
        .await
        .unwrap() else {
            panic!("expected session.lock topic.update after host disconnect");
        };
        if method == methods::TOPIC_UPDATE {
            let update: TopicUpdate = serde_json::from_value(params).unwrap();
            if update.topic.as_str() == "session.lock" {
                assert_eq!(update.data["host_connected"], json!(false));
                assert_eq!(update.data["phase"], json!("locked"));
                break;
            }
        }
    }

    let shutdown_host = BusClient::connect(paths.host_socket_path()).await.unwrap();
    shutdown_host
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("quit").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap();
    timeout(Duration::from_secs(3), server_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn wires_wallpaper_to_durable_state_theme_reload_and_session_lock() {
    let dir = TempDir::new().unwrap();
    let paths = ShellPaths::from_roots(
        dir.path().join("config"),
        dir.path().join("state"),
        dir.path().join("runtime"),
        dir.path().join("runtime/bus.sock"),
    );
    let store = z_shell_config::ConfigStore::new(paths.clone());
    let mut settings = z_shell_config::UserSettings::default();
    settings.wallpaper.directories = vec![dir.path().to_str().unwrap().to_owned()];
    settings.theme.mode = z_shell_config::ThemeMode::Light;
    store.save_settings(&settings).unwrap();
    let image = dir.path().join("desktop.png");
    image::RgbImage::from_pixel(40, 30, image::Rgb([28, 172, 80]))
        .save(&image)
        .unwrap();

    let app = DaemonApp::bootstrap(paths.clone()).unwrap();
    let shutdown = app.shutdown_handle();
    let server = tokio::spawn(app.run());
    let mut public = BusClient::connect(paths.socket_path()).await.unwrap();
    let host = BusClient::connect(paths.host_socket_path()).await.unwrap();
    let wallpaper = TopicName::try_new("wallpaper").unwrap();
    let initial = public.subscribe(wallpaper.clone()).await.unwrap();
    let ready = if initial.data["available"] == true {
        initial.data
    } else {
        timeout(Duration::from_secs(5), async {
            loop {
                if let Some(ServerMessage::Notification { method, params }) =
                    public.next_notification().await
                    && method == methods::TOPIC_UPDATE
                {
                    let update: TopicUpdate = serde_json::from_value(params).unwrap();
                    if update.topic == wallpaper && update.data["available"] == true {
                        break update.data;
                    }
                }
            }
        })
        .await
        .expect("deferred initial wallpaper scan must publish available baseline")
    };
    assert_eq!(ready["available"], true);
    assert_eq!(ready["catalog_count"], 1);
    assert!(ready["current"].is_null());
    public
        .subscribe(TopicName::try_new("theme").unwrap())
        .await
        .unwrap();
    public
        .subscribe(TopicName::try_new("state").unwrap())
        .await
        .unwrap();

    let command = |name: &str, payload| CommandInvokeParams {
        name: CommandName::try_new(name).unwrap(),
        args: vec![],
        payload,
    };
    let set = command("wallpaper.set", Some(json!({"path": image})));
    let applied = public
        .invoke_command(set.clone())
        .await
        .unwrap()
        .data
        .unwrap();
    let staged = std::path::Path::new(applied["current"]["media"]["path"].as_str().unwrap());
    assert_eq!(
        staged.parent().unwrap(),
        paths.media_dir().join("wallpapers")
    );
    assert!(std::fs::symlink_metadata(staged).unwrap().is_file());
    assert_eq!(
        std::fs::read(staged).unwrap(),
        std::fs::read(&image).unwrap()
    );
    assert_eq!(
        store.load_state().unwrap().last_wallpaper.as_ref(),
        Some(&image)
    );

    let mut updated = std::collections::BTreeMap::new();
    timeout(Duration::from_secs(5), async {
        while updated.len() < 3 {
            if let Some(ServerMessage::Notification { method, params }) =
                public.next_notification().await
                && method == methods::TOPIC_UPDATE
            {
                let update: TopicUpdate = serde_json::from_value(params).unwrap();
                assert!(
                    !update.source_baseline,
                    "expected a live update: {update:?}"
                );
                updated.insert(update.topic, update.data);
            }
        }
    })
    .await
    .expect("wallpaper.set must publish live wallpaper, state, and theme updates");
    assert_eq!(updated[&wallpaper]["current"]["source_path"], json!(image));
    assert_eq!(
        updated[&TopicName::try_new("state").unwrap()]["last_wallpaper"],
        json!(image)
    );
    let theme = &updated[&TopicName::try_new("theme").unwrap()];
    assert_eq!(
        theme["source"],
        json!({"kind": "wallpaper_path", "value": image})
    );
    assert_eq!(theme["dark"], false);

    settings.wallpaper.fit = z_shell_config::WallpaperFit::Contain;
    settings.wallpaper.sync_theme = false;
    store.save_settings(&settings).unwrap();
    let reloaded = public
        .invoke_command(command("settings.reload", None))
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(reloaded["wallpaper"]["fit"], "contain");
    let effective = public.subscribe(wallpaper.clone()).await.unwrap();
    assert_eq!(effective.data["sync_theme"], false);
    assert_eq!(effective.data["current"]["fit"], "contain");

    host.invoke_command(command(
        "host.session-register",
        Some(json!({"ui_session_generation": 1})),
    ))
    .await
    .unwrap();
    let lock = public
        .invoke_command(command("lock.request", None))
        .await
        .unwrap()
        .data
        .unwrap();
    host.invoke_command(command(
        "host.lock-ack",
        Some(json!({"lock_id": lock[0]["data"]["lock_id"], "ui_session_generation": 1})),
    ))
    .await
    .unwrap();
    assert!(matches!(
        public.invoke_command(set).await,
        Err(ClientError::Rpc(rpc)) if rpc.code == ErrorCode::PermissionDenied
    ));
    assert_eq!(
        public.subscribe(wallpaper).await.unwrap().data["current"]["source_path"],
        json!(image)
    );

    shutdown.shutdown();
    timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn settings_patch_and_patch_plugin_require_host_socket_preserve_comments_and_broadcast() {
    let dir = TempDir::new().unwrap();
    let paths = ShellPaths::from_roots(
        dir.path().join("config"),
        dir.path().join("state"),
        dir.path().join("runtime"),
        dir.path().join("runtime/bus.sock"),
    );
    paths.ensure_dirs().unwrap();
    std::fs::write(
        paths.settings_file(),
        "# Keep user comment\n[bar]\nposition = \"top\"\ngaps = 14\n",
    )
    .unwrap();

    let app = DaemonApp::bootstrap(paths.clone()).unwrap();
    let server_task = tokio::spawn(async move { app.run().await });

    let mut public_client = BusClient::connect(paths.socket_path()).await.unwrap();
    let host_client = BusClient::connect(paths.host_socket_path()).await.unwrap();

    // Public socket must be denied both settings.patch and settings.patch-plugin.
    for (cmd, payload) in [
        ("settings.patch", json!({ "bar": { "gaps": 8 } })),
        (
            "settings.patch-plugin",
            json!({ "plugin_id": "z-shell/example", "patch": { "refresh_seconds": 120 } }),
        ),
    ] {
        let err = public_client
            .invoke_command(CommandInvokeParams {
                name: CommandName::try_new(cmd).unwrap(),
                args: Vec::new(),
                payload: Some(payload),
            })
            .await
            .unwrap_err();
        assert!(
            matches!(err, ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::PermissionDenied),
            "{cmd} must reject public callers: {err:?}"
        );
    }

    let settings_snap = public_client
        .subscribe(TopicName::try_new("settings").unwrap())
        .await
        .unwrap();
    assert_eq!(
        settings_snap.data["theme"]["motion_scheme"],
        json!("standard")
    );

    // Host client patches bar + theme.motion_scheme losslessly and triggers live broadcast.
    let patched = host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("settings.patch").unwrap(),
            args: Vec::new(),
            payload: Some(json!({
                "bar": { "style": "docked", "gaps": 8 },
                "theme": { "motion_scheme": "expressive" }
            })),
        })
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(patched["bar"]["style"], json!("docked"));
    assert_eq!(patched["bar"]["gaps"], json!(8));
    assert_eq!(patched["theme"]["motion_scheme"], json!("expressive"));

    let on_disk = std::fs::read_to_string(paths.settings_file()).unwrap();
    assert!(
        on_disk.contains("# Keep user comment"),
        "settings.patch must preserve user comments:\n{on_disk}"
    );
    assert!(on_disk.contains("motion_scheme = \"expressive\""));

    let Some(ServerMessage::Notification { method, params, .. }) =
        timeout(Duration::from_secs(2), public_client.next_notification())
            .await
            .unwrap()
    else {
        panic!("expected live settings topic.update after settings.patch");
    };
    assert_eq!(method, methods::TOPIC_UPDATE);
    let update: TopicUpdate = serde_json::from_value(params).unwrap();
    assert_eq!(update.topic.as_str(), "settings");
    assert_eq!(update.data["bar"]["style"], json!("docked"));
    assert_eq!(update.data["theme"]["motion_scheme"], json!("expressive"));

    // Host client patches plugin settings and reads them back via settings.get-plugin.
    let plugin_patched = host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("settings.patch-plugin").unwrap(),
            args: Vec::new(),
            payload: Some(json!({
                "plugin_id": "z-shell/sample-plugin",
                "settings": { "inhibit_scope": "idle", "poll_interval_ms": 5000 }
            })),
        })
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(plugin_patched["settings"]["inhibit_scope"], json!("idle"));
    assert_eq!(plugin_patched["settings"]["poll_interval_ms"], json!(5000));

    let plugin_read = host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("settings.get-plugin").unwrap(),
            args: vec!["z-shell/sample-plugin".to_owned()],
            payload: None,
        })
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(plugin_read["settings"]["inhibit_scope"], json!("idle"));
    assert_eq!(plugin_read["settings"]["poll_interval_ms"], json!(5000));

    // Setting and then clearing theme.seed_color regenerates theme source from Seed back to Default.
    host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("settings.patch").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "theme": { "seed_color": "#7C4DFF" } })),
        })
        .await
        .unwrap();
    let seeded_theme = public_client
        .subscribe(TopicName::try_new("theme").unwrap())
        .await
        .unwrap();
    assert_eq!(seeded_theme.data["source"]["kind"], json!("seed"));
    assert_eq!(seeded_theme.data["source"]["value"], json!("#7C4DFF"));

    host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("settings.patch").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "theme": { "seed_color": null } })),
        })
        .await
        .unwrap();
    let cleared_theme = public_client
        .subscribe(TopicName::try_new("theme").unwrap())
        .await
        .unwrap();
    assert_eq!(cleared_theme.data["source"]["kind"], json!("seed"));
    assert_eq!(cleared_theme.data["source"]["value"], json!("#6750a4"));

    host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("quit").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap();
    timeout(Duration::from_secs(3), server_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn plugin_store_trust_redaction_blobs_revocation_watcher_and_offline() {
    use image::{ImageBuffer, ImageFormat, Rgba};
    use sha2::{Digest, Sha256};
    use std::io::Cursor;
    use z_shell_plugins::catalog_media;
    use z_shell_plugins::registry::PluginManager;
    use z_shell_protocol::PluginId;

    let dir = TempDir::new().unwrap();
    let paths = ShellPaths::from_roots(
        dir.path().join("config"),
        dir.path().join("state"),
        dir.path().join("runtime"),
        dir.path().join("runtime/bus.sock"),
    );
    paths.ensure_dirs().unwrap();

    // Build a local catalog seed plugin + PNG icon asset.
    let seed_dir = dir.path().join("seed");
    let bundle_dir = seed_dir.join("sample-plugin");
    std::fs::create_dir_all(bundle_dir.join("dist/entries")).unwrap();
    let svc_js = b"export default () => {};\n";
    let svc_sha = format!("sha256:{:x}", Sha256::digest(svc_js));
    std::fs::write(bundle_dir.join("dist/entries/service.mjs"), svc_js).unwrap();
    std::fs::write(
        bundle_dir.join("dist/manifest.build.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "shared_runtime_abi": "1.0",
            "files": { "dist/entries/service.mjs": svc_sha }
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        bundle_dir.join("plugin.toml"),
        r#"
id = "z-shell/sample-plugin"
name = "Sample Plugin"
version = "0.1.0"
plugin_api = 2
[build]
manifest = "dist/manifest.build.json"
shared_runtime_abi = "1.0"
[host_capabilities]
commands = ["sample.ping"]
[[service]]
id = "svc"
bundle = "dist/entries/service.mjs"
"#,
    )
    .unwrap();

    let mut png_bytes = Vec::new();
    let img = ImageBuffer::from_pixel(16, 16, Rgba([103u8, 80, 164, 255]));
    img.write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
        .unwrap();
    let icon_path = seed_dir.join("icon.png");
    std::fs::write(&icon_path, &png_bytes).unwrap();
    let icon_sha = format!("sha256:{:x}", Sha256::digest(&png_bytes));

    let catalog_path = dir.path().join("catalog.json");
    let digest = z_shell_plugins::digest::content_digest(&bundle_dir).unwrap();
    std::fs::write(
        &catalog_path,
        serde_json::to_vec_pretty(&json!({
            "schema_version": 1,
            "source_id": "local-seed",
            "updated_at": "2026-11-26T00:00:00Z",
            "plugins": [{
                "id": "z-shell/sample-plugin",
                "name": "Sample Plugin",
                "author": "z-shell",
                "summary": "Local seed plugin",
                "category": "system",
                "tags": ["sample"],
                "icon_url": "icon.png",
                "icon_sha256": icon_sha,
                "latest_version": "0.1.0",
                "releases": [{
                    "version": "0.1.0",
                    "plugin_api": 2,
                    "shared_runtime_abi": "1.0",
                    "content_digest": digest,
                    "artifact": {
                        "kind": "local_seed",
                        "bundle_dir": bundle_dir.to_str().unwrap()
                    }
                }]
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    std::fs::write(
        paths.settings_file(),
        format!(
            r#"
[[plugins.sources]]
id = "local-seed"
name = "Local Seed"
kind = "local_file"
url = "{}"
local_seed_dir = "{}"
enabled = true
priority = 10
"#,
            catalog_path.display(),
            seed_dir.display()
        ),
    )
    .unwrap();

    let app = DaemonApp::bootstrap(paths.clone()).unwrap();
    let server_task = tokio::spawn(async move { app.run().await });

    let mut public_client = BusClient::connect(paths.socket_path()).await.unwrap();
    let host_client = BusClient::connect(paths.host_socket_path()).await.unwrap();

    let initial_topic = public_client
        .subscribe(TopicName::try_new("plugins").unwrap())
        .await
        .unwrap();
    assert_eq!(
        initial_topic.data["runtime_overlay_supported"],
        json!(false)
    );
    assert_eq!(initial_topic.data["applied_desired_revision"], json!(null));
    assert!(
        initial_topic.data["sources"][0]["url"]
            .as_str()
            .unwrap()
            .starts_with("local:sha256:"),
        "public topic must redact local file catalog source URL"
    );

    // Unprivileged public client must be denied all host-only plugin store commands.
    for (cmd, payload) in [
        ("plugins.sources.list", None),
        ("plugins.catalog.refresh", Some(json!({}))),
        (
            "plugins.catalog.fetch-blob",
            Some(json!({ "token": "abc" })),
        ),
        (
            "plugins.stage-install",
            Some(json!({ "kind": "catalog", "id": "z-shell/sample-plugin" })),
        ),
        (
            "plugins.enable",
            Some(json!({ "id": "z-shell/sample-plugin" })),
        ),
        (
            "plugins.revoke",
            Some(json!({ "id": "z-shell/sample-plugin" })),
        ),
        (
            "plugins.remove",
            Some(json!({ "id": "z-shell/sample-plugin" })),
        ),
    ] {
        let err = public_client
            .invoke_command(CommandInvokeParams {
                name: CommandName::try_new(cmd).unwrap(),
                args: Vec::new(),
                payload,
            })
            .await
            .unwrap_err();
        assert!(
            matches!(err, ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::PermissionDenied),
            "{cmd} must deny public callers: {err:?}"
        );
    }

    // Refresh local seed source via privileged host.
    host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("plugins.catalog.refresh").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "source_id": "local-seed" })),
        })
        .await
        .unwrap();

    // Public catalog.list and catalog.detail are cache-only & return redacted identity + MediaRef token.
    let list_res = public_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("plugins.catalog.list").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "query": "sample", "limit": 10 })),
        })
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(list_res["total"], json!(1));
    assert_eq!(list_res["items"][0]["id"], json!("z-shell/sample-plugin"));

    let detail_res = public_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("plugins.catalog.detail").unwrap(),
            args: vec!["z-shell/sample-plugin".to_owned()],
            payload: None,
        })
        .await
        .unwrap()
        .data
        .unwrap();
    let offering = &detail_res["offerings"][0];
    assert!(
        offering["source_identity"]
            .as_str()
            .unwrap()
            .contains("local:sha256:"),
        "catalog detail must redact local path in source_identity"
    );
    let icon_token = offering["icon"]["token"].as_str().unwrap().to_owned();

    // Host client fetches preview PNG bytes through plugins.catalog.fetch-blob.
    let blob_res = host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("plugins.catalog.fetch-blob").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "token": icon_token })),
        })
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(blob_res["mime"], json!("image/png"));
    let byte_len = blob_res["byte_len"].as_u64().unwrap() as usize;
    assert!(byte_len > 8 && byte_len <= catalog_media::MAX_PREVIEW_PNG_BYTES);
    let fetched_bytes: Vec<u8> = blob_res["bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as u8)
        .collect();
    assert_eq!(fetched_bytes.len(), byte_len);
    assert_eq!(&fetched_bytes[..4], b"\x89PNG");

    // Stage install + commit install + audit + cross-process revocation rejection.
    let staged = host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("plugins.stage-install").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "kind": "catalog", "id": "z-shell/sample-plugin" })),
        })
        .await
        .unwrap()
        .data
        .unwrap();
    let stage_token = staged["stage_token"].as_str().unwrap().to_owned();
    let staged_obj = &staged["staged"];
    host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("plugins.commit-install").unwrap(),
            args: Vec::new(),
            payload: Some(json!({
                "stage_token": stage_token,
                "expected_source_identity": staged_obj["source_identity"],
                "expected_content_digest": staged_obj["content_digest"],
                "expected_capabilities": staged_obj["requested_capabilities"],
                "approve_on_commit": false,
            })),
        })
        .await
        .unwrap();

    // External CLI/manager revocation must cause host plugins.approve (with allow_unrevoke=false) to fail,
    // AND the registry watcher must publish a live `plugins` topic update!
    let manager = PluginManager::new(paths.clone());
    let sample_id = PluginId::try_new("z-shell/sample-plugin").unwrap();
    let audit_before = manager.audit(&sample_id).unwrap();
    manager.revoke(&sample_id).unwrap();

    // Wait for watcher to emit live topic update showing revoked=true.
    let mut saw_revoked = false;
    for _ in 0..10 {
        let Ok(Some(ServerMessage::Notification { method, params, .. })) =
            timeout(Duration::from_secs(2), public_client.next_notification()).await
        else {
            break;
        };
        if method == methods::TOPIC_UPDATE {
            let update: TopicUpdate = serde_json::from_value(params).unwrap();
            if update.topic.as_str() == "plugins"
                && update.data["plugins"][0]["revoked"] == json!(true)
            {
                saw_revoked = true;
                break;
            }
        }
    }
    assert!(
        saw_revoked,
        "registry watcher must publish live update on external revoke"
    );

    let approve_err = host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("plugins.approve").unwrap(),
            args: Vec::new(),
            payload: Some(json!({
                "id": "z-shell/sample-plugin",
                "expected_source_identity": audit_before.plugin.source_identity,
                "expected_content_digest": audit_before.current_content_digest,
                "expected_capabilities": staged_obj["requested_capabilities"],
                "allow_unrevoke": false,
            })),
        })
        .await
        .unwrap_err();
    assert!(
        matches!(approve_err, ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::InvalidParams),
        "revoked plugin approval with allow_unrevoke=false must fail: {approve_err:?}"
    );

    // Turning on offline_mode blocks online catalog.refresh.
    host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("settings.patch").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "general": { "offline_mode": true } })),
        })
        .await
        .unwrap();
    let offline_refresh = host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("plugins.catalog.refresh").unwrap(),
            args: Vec::new(),
            payload: Some(json!({})),
        })
        .await
        .unwrap_err();
    assert!(
        matches!(offline_refresh, ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::Disabled),
        "offline_mode=true must block catalog refresh: {offline_refresh:?}"
    );

    host_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("quit").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap();
    timeout(Duration::from_secs(3), server_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

struct TestDbus {
    child: std::process::Child,
    address: String,
}

impl TestDbus {
    fn spawn() -> Self {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};

        let mut child = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--nosyslog", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn isolated dbus-daemon");
        let mut address = String::new();
        BufReader::new(child.stdout.take().expect("dbus-daemon stdout"))
            .read_line(&mut address)
            .expect("read dbus-daemon address");
        let address = address.trim().to_owned();
        assert!(!address.is_empty(), "dbus-daemon address must not be empty");
        Self { child, address }
    }

    fn address(&self) -> &str {
        &self.address
    }
}

impl Drop for TestDbus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tokio::test]
async fn locks_apps_launch_and_notifications_and_authenticates_with_trusted_pam_helper() {
    let dir = TempDir::new().unwrap();
    let bus = TestDbus::spawn();

    // 1. Default bootstrap without a sibling `z-shell-pam-helper` next to the test binary must
    // fail closed with "no trusted PAM helper executable found" instead of falling back to a
    // relative `$PATH` name ("z-shell-pam-helper").
    {
        let untrusted_paths = ShellPaths::from_roots(
            dir.path().join("untrusted/config"),
            dir.path().join("untrusted/state"),
            dir.path().join("untrusted/runtime"),
            dir.path().join("untrusted/runtime/bus.sock"),
        );
        let app = DaemonApp::bootstrap_with_options(
            untrusted_paths.clone(),
            DaemonOptions::new()
                .with_logind_bus(DaemonBus::Disabled)
                .with_polkit_bus(DaemonBus::Disabled)
                .with_session_bus(DaemonBus::Disabled),
        )
        .unwrap();
        let server_task = tokio::spawn(async move { app.run().await });
        let public = BusClient::connect(untrusted_paths.socket_path())
            .await
            .unwrap();
        let host = BusClient::connect(untrusted_paths.host_socket_path())
            .await
            .unwrap();
        host.invoke_command(CommandInvokeParams {
            name: CommandName::try_new("host.session-register").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "ui_session_generation": 1 })),
        })
        .await
        .unwrap();
        let lock = public
            .invoke_command(CommandInvokeParams {
                name: CommandName::try_new("lock.request").unwrap(),
                args: Vec::new(),
                payload: None,
            })
            .await
            .unwrap()
            .data
            .unwrap();
        let lock_id = lock[0]["data"]["lock_id"].as_u64().unwrap();
        host.invoke_command(CommandInvokeParams {
            name: CommandName::try_new("host.lock-ack").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "lock_id": lock_id, "ui_session_generation": 1 })),
        })
        .await
        .unwrap();
        let err = host
            .invoke_command(CommandInvokeParams {
                name: CommandName::try_new("host.lock-authenticate").unwrap(),
                args: Vec::new(),
                payload: Some(json!({
                    "password": "secret",
                    "lock_id": lock_id,
                    "ui_session_generation": 1,
                })),
            })
            .await
            .unwrap_err();
        match err {
            ClientError::Rpc(rpc) => {
                assert_eq!(rpc.code, ErrorCode::Internal);
                assert!(
                    rpc.message
                        .contains("no trusted PAM helper executable found"),
                    "expected resolved trusted-helper absence message (never relative $PATH fallback), got: {}",
                    rpc.message
                );
            }
            other => panic!("expected RpcError, got {other:?}"),
        }
        host.invoke_command(CommandInvokeParams {
            name: CommandName::try_new("quit").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap();
        timeout(Duration::from_secs(3), server_task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    // 2. Full daemon integration with a verified absolute PAM helper, cold-boot `apps.launch`,
    // notification popup suppression + action denial on lock engagement, and UID-bound unlock
    // without passing a client username.
    let paths = ShellPaths::from_roots(
        dir.path().join("config"),
        dir.path().join("state"),
        dir.path().join("runtime"),
        dir.path().join("runtime/bus.sock"),
    );
    let data_dir = dir.path().join("xdg-data");
    let apps_dir = data_dir.join("applications");
    std::fs::create_dir_all(&apps_dir).unwrap();
    let launch_marker = dir.path().join("launched.txt");
    let launch_script = dir.path().join("launch-probe.sh");
    std::fs::write(
        &launch_script,
        format!(
            "#!/bin/sh\nprintf 'launched' > '{}'\n",
            launch_marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&launch_script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(
        apps_dir.join("probe.desktop"),
        format!(
            "[Desktop Entry]\nType=Application\nName=Probe App\nExec={}\n",
            launch_script.display()
        ),
    )
    .unwrap();

    let pam_helper = dir.path().join("mock-pam-helper.sh");
    std::fs::write(
        &pam_helper,
        r#"#!/bin/sh
payload="$(cat)"
case "$payload" in
  *'"password":"correct-password"'*)
    printf '{"status":"authenticated"}\n'
    ;;
  *)
    printf '{"status":"denied","message":"Invalid password"}\n'
    ;;
esac
"#,
    )
    .unwrap();
    std::fs::set_permissions(&pam_helper, std::fs::Permissions::from_mode(0o755)).unwrap();

    let app = DaemonApp::bootstrap_with_options(
        paths.clone(),
        DaemonOptions::new()
            .with_pam_helper_path(&pam_helper)
            .with_logind_bus(DaemonBus::Disabled)
            .with_polkit_bus(DaemonBus::Disabled)
            .with_session_bus(DaemonBus::Address(bus.address().to_owned()))
            .with_xdg_data_dirs(vec![data_dir]),
    )
    .unwrap();
    let server_task = tokio::spawn(async move { app.run().await });

    let mut public = BusClient::connect(paths.socket_path()).await.unwrap();
    let host = BusClient::connect(paths.host_socket_path()).await.unwrap();

    // Wait for `desktop.apps` and `desktop.notifications` to become available.
    let apps_snap = public
        .subscribe(TopicName::try_new("desktop.apps").unwrap())
        .await
        .unwrap();
    if apps_snap.data["available"] != json!(true) {
        timeout(Duration::from_secs(5), async {
            loop {
                if let Some(ServerMessage::Notification { method, params }) =
                    public.next_notification().await
                    && method == methods::TOPIC_UPDATE
                {
                    let update: TopicUpdate = serde_json::from_value(params).unwrap();
                    if update.topic.as_str() == "desktop.apps"
                        && update.data["available"] == json!(true)
                    {
                        break;
                    }
                }
            }
        })
        .await
        .expect("desktop.apps scan must complete");
    }

    let notif_snap = public
        .subscribe(TopicName::try_new("desktop.notifications").unwrap())
        .await
        .unwrap();
    if notif_snap.data["available"] != json!(true) {
        timeout(Duration::from_secs(5), async {
            loop {
                if let Some(ServerMessage::Notification { method, params }) =
                    public.next_notification().await
                    && method == methods::TOPIC_UPDATE
                {
                    let update: TopicUpdate = serde_json::from_value(params).unwrap();
                    if update.topic.as_str() == "desktop.notifications"
                        && update.data["available"] == json!(true)
                    {
                        break;
                    }
                }
            }
        })
        .await
        .expect("desktop.notifications D-Bus name must become available");
    }

    // Cold-boot `apps.launch` succeeds without any prior `launcher.query`.
    public
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("apps.launch").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "id": "probe.desktop" })),
        })
        .await
        .unwrap();
    timeout(Duration::from_secs(3), async {
        while !launch_marker.exists() {
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .expect("apps.launch must execute probe.desktop");

    // Emit a live notification with an action over D-Bus so `popups` has 1 item.
    let dbus_conn = zbus::connection::Builder::address(bus.address())
        .unwrap()
        .build()
        .await
        .unwrap();
    let notif_id: u32 = dbus_conn
        .call_method(
            Some("org.freedesktop.Notifications"),
            "/org/freedesktop/Notifications",
            Some("org.freedesktop.Notifications"),
            "Notify",
            &(
                "ChatApp",
                0u32,
                "",
                "Secret DM",
                "Lock test",
                vec!["open", "Open"],
                std::collections::HashMap::<&str, zbus::zvariant::Value<'_>>::new(),
                0i32,
            ),
        )
        .await
        .unwrap()
        .body()
        .deserialize()
        .unwrap();
    assert!(notif_id >= 1);

    timeout(Duration::from_secs(3), async {
        loop {
            if let Some(ServerMessage::Notification { method, params }) =
                public.next_notification().await
                && method == methods::TOPIC_UPDATE
            {
                let update: TopicUpdate = serde_json::from_value(params).unwrap();
                if update.topic.as_str() == "desktop.notifications"
                    && update.data["popups"]
                        .as_array()
                        .is_some_and(|p| p.len() == 1)
                {
                    break;
                }
            }
        }
    })
    .await
    .expect("live notification popup must publish");

    // Register host and request lock (`engaging` phase BEFORE `host.lock-ack`!).
    host.invoke_command(CommandInvokeParams {
        name: CommandName::try_new("host.session-register").unwrap(),
        args: Vec::new(),
        payload: Some(json!({ "ui_session_generation": 3 })),
    })
    .await
    .unwrap();
    let lock_data = public
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("lock.request").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap()
        .data
        .unwrap();
    let lock_id = lock_data[0]["data"]["lock_id"].as_u64().unwrap();

    // Immediately during `engaging`, notification popups must be cleared and both `apps.launch`
    // and `notifications.invoke-action` must be denied with PermissionDenied!
    let notif_while_engaging = public
        .subscribe(TopicName::try_new("desktop.notifications").unwrap())
        .await
        .unwrap();
    assert_eq!(notif_while_engaging.data["popups"], json!([]));
    assert_eq!(
        notif_while_engaging.data["history"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    for (cmd_name, payload) in [
        ("apps.launch", json!({ "id": "probe.desktop" })),
        (
            "notifications.invoke-action",
            json!({ "id": notif_id, "action_key": "open" }),
        ),
    ] {
        let denied = public
            .invoke_command(CommandInvokeParams {
                name: CommandName::try_new(cmd_name).unwrap(),
                args: Vec::new(),
                payload: Some(payload),
            })
            .await
            .unwrap_err();
        assert!(
            matches!(denied, ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::PermissionDenied),
            "expected PermissionDenied for {cmd_name} while engaging, got {denied:?}"
        );
    }

    // Acknowledge lock, verify mismatched username is rejected, then unlock with omitted username.
    host.invoke_command(CommandInvokeParams {
        name: CommandName::try_new("host.lock-ack").unwrap(),
        args: Vec::new(),
        payload: Some(json!({ "lock_id": lock_id, "ui_session_generation": 3 })),
    })
    .await
    .unwrap();

    let wrong_user = host
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("host.lock-authenticate").unwrap(),
            args: Vec::new(),
            payload: Some(json!({
                "username": "definitely-not-this-uid-account",
                "password": "correct-password",
                "lock_id": lock_id,
                "ui_session_generation": 3,
            })),
        })
        .await
        .unwrap_err();
    assert!(
        matches!(wrong_user, ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::PermissionDenied),
        "mismatched username must fail with PermissionDenied: {wrong_user:?}"
    );

    let approval = host
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("host.lock-authenticate").unwrap(),
            args: Vec::new(),
            payload: Some(json!({
                "password": "correct-password",
                "lock_id": lock_id,
                "ui_session_generation": 3,
            })),
        })
        .await
        .unwrap()
        .data
        .unwrap();
    host.invoke_command(CommandInvokeParams {
        name: CommandName::try_new("host.lock-consume-unlock").unwrap(),
        args: Vec::new(),
        payload: Some(json!({
            "token": approval["token"],
            "lock_id": lock_id,
            "ui_session_generation": 3,
        })),
    })
    .await
    .unwrap();

    // After unlock, `apps.launch` is permitted again.
    std::fs::remove_file(&launch_marker).unwrap();
    public
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("apps.launch").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "id": "probe.desktop" })),
        })
        .await
        .unwrap();
    timeout(Duration::from_secs(3), async {
        while !launch_marker.exists() {
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .expect("apps.launch must succeed again after unlock");

    host.invoke_command(CommandInvokeParams {
        name: CommandName::try_new("quit").unwrap(),
        args: Vec::new(),
        payload: None,
    })
    .await
    .unwrap();
    timeout(Duration::from_secs(3), server_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn supervises_logind_restart_inhibitors_session_lock_and_power_suspend() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use zbus::{
        Connection,
        connection::Builder,
        object_server::SignalEmitter,
        zvariant::{OwnedFd, OwnedObjectPath},
    };

    struct MockLogindManager {
        session_path: String,
        delay_inhibits: Arc<AtomicUsize>,
        block_inhibits: Arc<AtomicUsize>,
        suspends: Arc<AtomicUsize>,
    }

    #[zbus::interface(name = "org.freedesktop.login1.Manager")]
    impl MockLogindManager {
        #[zbus(name = "Inhibit")]
        fn inhibit(
            &self,
            _what: &str,
            _who: &str,
            _why: &str,
            mode: &str,
        ) -> zbus::fdo::Result<OwnedFd> {
            match mode {
                "delay" => {
                    self.delay_inhibits.fetch_add(1, Ordering::SeqCst);
                }
                "block" => {
                    self.block_inhibits.fetch_add(1, Ordering::SeqCst);
                }
                _ => {}
            }
            let (reader, _writer) = std::os::unix::net::UnixStream::pair()
                .map_err(|err| zbus::fdo::Error::Failed(err.to_string()))?;
            Ok(OwnedFd::from(std::os::fd::OwnedFd::from(reader)))
        }

        #[zbus(name = "GetSessionByPID")]
        fn get_session_by_pid(&self, _pid: u32) -> zbus::fdo::Result<OwnedObjectPath> {
            Ok(OwnedObjectPath::try_from(self.session_path.as_str()).expect("valid session path"))
        }

        #[zbus(name = "Suspend")]
        fn suspend(&self, _interactive: bool) -> zbus::fdo::Result<()> {
            self.suspends.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    struct MockLogindSession;

    #[zbus::interface(name = "org.freedesktop.login1.Session")]
    impl MockLogindSession {
        #[zbus(signal, name = "Lock")]
        async fn lock(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;
    }

    async fn serve_mock_logind(
        address: &str,
        session_path: &str,
        delay_inhibits: Arc<AtomicUsize>,
        block_inhibits: Arc<AtomicUsize>,
        suspends: Arc<AtomicUsize>,
    ) -> Connection {
        Builder::address(address)
            .expect("builder")
            .name("org.freedesktop.login1")
            .expect("logind bus name")
            .serve_at(
                "/org/freedesktop/login1",
                MockLogindManager {
                    session_path: session_path.to_owned(),
                    delay_inhibits,
                    block_inhibits,
                    suspends,
                },
            )
            .expect("serve Manager")
            .serve_at(session_path, MockLogindSession)
            .expect("serve Session")
            .build()
            .await
            .expect("build mock logind")
    }

    let dir = TempDir::new().unwrap();
    let bus = TestDbus::spawn();
    let paths = ShellPaths::from_roots(
        dir.path().join("config"),
        dir.path().join("state"),
        dir.path().join("runtime"),
        dir.path().join("runtime/bus.sock"),
    );

    // Attach a D-Bus monitor BEFORE booting `DaemonApp` so we deterministically observe the
    // daemon's initial `org.freedesktop.login1` `Inhibit` call fail (`ServiceUnknown`) before
    // spawning `logind_1`, proving bounded backoff recovery without arbitrary sleeps.
    let monitor_conn = Builder::address(bus.address())
        .expect("monitor builder")
        .build()
        .await
        .expect("connect D-Bus monitor");
    let mut monitor_stream = zbus::MessageStream::from(&monitor_conn);
    monitor_conn
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus.Monitoring"),
            "BecomeMonitor",
            &(Vec::<&str>::new(), 0u32),
        )
        .await
        .expect("BecomeMonitor on isolated TestDbus");

    let app = DaemonApp::bootstrap_with_options(
        paths.clone(),
        DaemonOptions::new()
            .with_logind_bus(DaemonBus::Address(bus.address().to_owned()))
            .with_polkit_bus(DaemonBus::Disabled)
            .with_session_bus(DaemonBus::Disabled),
    )
    .unwrap();
    let server_task = tokio::spawn(async move { app.run().await });

    let mut public = BusClient::connect(paths.socket_path()).await.unwrap();
    let host = BusClient::connect(paths.host_socket_path()).await.unwrap();

    timeout(Duration::from_secs(3), async {
        use zbus::export::futures_core::Stream;
        let mut inhibit_serial = None;
        loop {
            let item =
                std::future::poll_fn(|cx| std::pin::Pin::new(&mut monitor_stream).poll_next(cx))
                    .await
                    .expect("D-Bus monitor stream ended unexpectedly")
                    .expect("D-Bus monitor message decode");
            match item.message_type() {
                zbus::message::Type::MethodCall
                    if item.header().member().map(|m| m.as_str()) == Some("Inhibit") =>
                {
                    inhibit_serial = Some(item.primary_header().serial_num());
                }
                zbus::message::Type::Error
                    if inhibit_serial.is_some()
                        && item.header().reply_serial() == inhibit_serial =>
                {
                    break;
                }
                _ => {}
            }
        }
    })
    .await
    .expect("daemon must attempt initial logind Inhibit and receive ServiceUnknown before logind_1 starts");
    drop(monitor_stream);
    drop(monitor_conn);

    let delay_1 = Arc::new(AtomicUsize::new(0));
    let block_1 = Arc::new(AtomicUsize::new(0));
    let suspends_1 = Arc::new(AtomicUsize::new(0));
    let logind_1 = serve_mock_logind(
        bus.address(),
        "/org/freedesktop/login1/session/s1",
        Arc::clone(&delay_1),
        Arc::clone(&block_1),
        Arc::clone(&suspends_1),
    )
    .await;

    // Wait for supervised logind loop to acquire the initial delay inhibitor.
    timeout(Duration::from_secs(3), async {
        while delay_1.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("supervised logind loop must acquire delay inhibitor once logind appears");

    // Enable Keep Awake (Caffeine) so `sleep:block` inhibitor is also held.
    let caffeine_snap = public
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("idle.caffeine").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "enabled": true })),
        })
        .await
        .unwrap()
        .data
        .unwrap();
    assert_eq!(caffeine_snap["sleep_block_status"]["status"], json!("held"));
    assert_eq!(block_1.load(Ordering::SeqCst), 1);

    // Simulate `systemd-logind` restart on the bus with a new session object path `s2`.
    assert!(
        logind_1
            .release_name("org.freedesktop.login1")
            .await
            .unwrap()
    );
    drop(logind_1);

    let delay_2 = Arc::new(AtomicUsize::new(0));
    let block_2 = Arc::new(AtomicUsize::new(0));
    let suspends_2 = Arc::new(AtomicUsize::new(0));
    let logind_2 = serve_mock_logind(
        bus.address(),
        "/org/freedesktop/login1/session/s2",
        Arc::clone(&delay_2),
        Arc::clone(&block_2),
        Arc::clone(&suspends_2),
    )
    .await;

    // Without `settings.reload` or daemon restart, `z-shelld` must re-acquire both delay and block
    // inhibitors and re-subscribe to `Session.Lock` on `s2`!
    timeout(Duration::from_secs(3), async {
        while delay_2.load(Ordering::SeqCst) == 0 || block_2.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("supervised logind loop must re-acquire delay + block inhibitors after logind restart");

    host.invoke_command(CommandInvokeParams {
        name: CommandName::try_new("host.session-register").unwrap(),
        args: Vec::new(),
        payload: Some(json!({ "ui_session_generation": 9 })),
    })
    .await
    .unwrap();

    let lock_snap = public
        .subscribe(TopicName::try_new("session.lock").unwrap())
        .await
        .unwrap();
    assert_eq!(lock_snap.data["phase"], json!("unlocked"));

    let session_2_iface = logind_2
        .object_server()
        .interface::<_, MockLogindSession>("/org/freedesktop/login1/session/s2")
        .await
        .unwrap();
    let lock_id = timeout(Duration::from_secs(3), async {
        loop {
            MockLogindSession::lock(session_2_iface.signal_emitter())
                .await
                .unwrap();
            if let Ok(Some(ServerMessage::Notification { method, params })) =
                timeout(Duration::from_millis(120), public.next_notification()).await
                && method == methods::TOPIC_UPDATE
            {
                let update: TopicUpdate = serde_json::from_value(params).unwrap();
                if update.topic.as_str() == "session.lock"
                    && update.data["phase"] == json!("engaging")
                {
                    break update.data["lock_id"].as_u64().unwrap();
                }
            }
        }
    })
    .await
    .expect("Session.Lock on restarted logind must engage session lock");

    // Cancel that lock via `host.lock-failed` so we return to `unlocked`, then verify `power.suspend`
    // engages `sleep_hold` + `engaging` and waits for `host.lock-ack` before calling `Suspend`!
    host.invoke_command(CommandInvokeParams {
        name: CommandName::try_new("host.lock-failed").unwrap(),
        args: Vec::new(),
        payload: Some(json!({ "lock_id": lock_id, "reason": "reset for suspend check" })),
    })
    .await
    .unwrap();

    public
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("idle.caffeine").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "enabled": false })),
        })
        .await
        .unwrap();

    host.invoke_command(CommandInvokeParams {
        name: CommandName::try_new("power.suspend").unwrap(),
        args: Vec::new(),
        payload: None,
    })
    .await
    .unwrap();
    assert_eq!(
        suspends_2.load(Ordering::SeqCst),
        0,
        "power.suspend must not call logind Suspend before host.lock-ack"
    );

    let engaging_suspend = public
        .subscribe(TopicName::try_new("session.lock").unwrap())
        .await
        .unwrap();
    assert_eq!(engaging_suspend.data["phase"], json!("engaging"));
    assert_eq!(engaging_suspend.data["sleep_hold"], json!(true));
    let suspend_lock_id = engaging_suspend.data["lock_id"].as_u64().unwrap();

    host.invoke_command(CommandInvokeParams {
        name: CommandName::try_new("host.lock-ack").unwrap(),
        args: Vec::new(),
        payload: Some(json!({ "lock_id": suspend_lock_id, "ui_session_generation": 9 })),
    })
    .await
    .unwrap();
    assert_eq!(
        suspends_2.load(Ordering::SeqCst),
        1,
        "logind Suspend must execute once host.lock-ack completes"
    );

    host.invoke_command(CommandInvokeParams {
        name: CommandName::try_new("quit").unwrap(),
        args: Vec::new(),
        payload: None,
    })
    .await
    .unwrap();
    timeout(Duration::from_secs(3), server_task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
