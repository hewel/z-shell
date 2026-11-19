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
use z_shelld::DaemonApp;

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
async fn wires_desktop_and_session_domains_and_locks_clipboard_on_session_lock() {
    let dir = TempDir::new().unwrap();
    let paths = ShellPaths::from_roots(
        dir.path().join("config"),
        dir.path().join("state"),
        dir.path().join("runtime"),
        dir.path().join("runtime/bus.sock"),
    );

    let app = DaemonApp::bootstrap(paths.clone()).unwrap();
    let server_task = tokio::spawn(async move { app.run().await });

    let public_client = BusClient::connect(paths.socket_path()).await.unwrap();
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
        "session.lock",
        "session.idle",
    ] {
        assert!(
            topics.iter().any(|name| name == expected),
            "missing expected core topic {expected} in {topics:?}"
        );
    }

    // Public socket cannot call host.lock-ack.
    let denied = public_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("host.lock-ack").unwrap(),
            args: Vec::new(),
            payload: Some(json!({ "lock_id": 1, "ui_session_generation": 1 })),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        denied,
        ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::PermissionDenied
    ));

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

    // Public clipboard reads must now be denied while locked!
    let denied_clip = public_client
        .invoke_command(CommandInvokeParams {
            name: CommandName::try_new("clipboard.list").unwrap(),
            args: Vec::new(),
            payload: None,
        })
        .await
        .unwrap_err();
    assert!(matches!(
        denied_clip,
        ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::PermissionDenied
    ));

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
