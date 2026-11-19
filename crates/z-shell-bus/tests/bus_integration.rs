//! Concurrency, ordering, backpressure, trust-boundary, and lifecycle tests for z-shell-bus.

use serde_json::json;
use tempfile::TempDir;
use tokio::time::{Duration, timeout};
use z_shell_bus::{BusClient, BusError, BusHub, BusLimits, BusServer, ClientError, UpdateKind};
use z_shell_protocol::{
    BusHelloParams, ClientRole, CommandDispatchNotification, CommandInvokeParams,
    CommandInvokeResult, CommandName, CommandRegisterParams, CommandReplyParams, ErrorCode,
    InhibitorAcquireParams, InhibitorEntry, InhibitorScope, PROTOCOL_VERSION, PluginId,
    ServerMessage, TopicName, TopicPublishParams, TopicRegisterParams, TopicRemovedNotification,
    TopicResetNotification, TopicUpdate, methods,
};

#[tokio::test]
async fn enforces_handshake_trust_roles_namespaces_and_cleanup() {
    let dir = TempDir::new().unwrap();
    let public_sock = dir.path().join("bus.sock");
    let host_sock = dir.path().join("host.sock");
    let lock_path = dir.path().join("daemon.lock");
    let media_dir = dir.path().join("media");

    let hub = BusHub::new("0.1.0-test", media_dir.clone());
    hub.publish_core_topic(
        TopicName::try_new("daemon.status").unwrap(),
        json!({ "ready": true }),
        UpdateKind::SourceBaseline,
    );

    let server = BusServer::bind(
        public_sock.clone(),
        host_sock.clone(),
        lock_path.clone(),
        hub.clone(),
    )
    .unwrap();
    // Second daemon attempting to acquire the same flock must fail cleanly.
    assert!(matches!(
        BusServer::bind(
            public_sock.clone(),
            host_sock.clone(),
            lock_path.clone(),
            hub.clone()
        ),
        Err(BusError::AlreadyRunning(_))
    ));

    let shutdown = server.shutdown_handle();
    let server_task = tokio::spawn(async move { server.serve().await });

    // Unhandshaked client must be rejected before bus.hello.
    let raw_client = BusClient::connect_without_handshake(&public_sock)
        .await
        .unwrap();
    let unhandshaked_err = raw_client.list_topics().await.unwrap_err();
    assert!(matches!(
        unhandshaked_err,
        ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::HandshakeRequired
    ));
    let mismatch_err = raw_client
        .request::<_, serde_json::Value>(
            methods::BUS_HELLO,
            Some(&BusHelloParams {
                protocol_version: 999,
                client_name: None,
            }),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        mismatch_err,
        ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::VersionMismatch
    ));
    drop(raw_client);

    // Public vs Host socket roles are derived strictly from the accepting socket.
    let mut observer = BusClient::connect(&public_sock).await.unwrap();
    assert_eq!(observer.hello_info().protocol_version, PROTOCOL_VERSION);
    assert_eq!(observer.hello_info().role, ClientRole::Public);
    assert_eq!(observer.hello_info().media_dir, media_dir);

    let host_client = BusClient::connect(&host_sock).await.unwrap();
    assert_eq!(host_client.hello_info().role, ClientRole::PrivilegedHost);
    assert_eq!(
        host_client.hello_info().daemon_instance_id,
        observer.hello_info().daemon_instance_id
    );

    let inh_snap = observer
        .subscribe(TopicName::try_new("inhibitors").unwrap())
        .await
        .unwrap();
    assert_eq!(inh_snap.data, json!([]));

    // Plugin client tests namespace enforcement, topic_instance_id, command dispatch, and disconnect cleanup.
    let mut plugin = BusClient::connect(&public_sock).await.unwrap();
    let plugin_id = PluginId::try_new("z-shell/ai-usage").unwrap();

    // Core namespaces must be rejected for both topics and commands.
    let bad_topic_err = plugin
        .register_topic(TopicRegisterParams {
            topic: TopicName::try_new("settings").unwrap(),
            plugin_id: Some(plugin_id.clone()),
            initial: json!({}),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        bad_topic_err,
        ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::PermissionDenied
    ));

    let bad_cmd_err = plugin
        .register_command(CommandRegisterParams {
            name: CommandName::try_new("quit").unwrap(),
            description: "Attempt to hijack core command".to_owned(),
            plugin_id: Some(plugin_id.clone()),
        })
        .await
        .unwrap_err();
    assert!(matches!(
        bad_cmd_err,
        ClientError::Rpc(ref rpc) if rpc.code == ErrorCode::PermissionDenied
    ));

    let custom_topic = TopicName::try_new("plugin.ai-usage.quotas").unwrap();
    let reg_res = plugin
        .register_topic(TopicRegisterParams {
            topic: custom_topic.clone(),
            plugin_id: Some(plugin_id.clone()),
            initial: json!({ "remaining": 80 }),
        })
        .await
        .unwrap();
    let first_instance_id = reg_res["topic_instance_id"].as_u64().unwrap();

    let custom_snap = observer.subscribe(custom_topic.clone()).await.unwrap();
    assert_eq!(custom_snap.topic_instance_id, first_instance_id);
    assert_eq!(custom_snap.revision, 1);
    assert_eq!(custom_snap.data, json!({ "remaining": 80 }));

    plugin
        .publish_topic(TopicPublishParams {
            topic: custom_topic.clone(),
            data: json!({ "remaining": 75 }),
        })
        .await
        .unwrap();

    let Some(ServerMessage::Notification { method, params, .. }) =
        timeout(Duration::from_secs(2), observer.next_notification())
            .await
            .unwrap()
    else {
        panic!("expected topic.update notification");
    };
    assert_eq!(method, methods::TOPIC_UPDATE);
    let update: TopicUpdate = serde_json::from_value(params).unwrap();
    assert_eq!(update.topic_instance_id, first_instance_id);
    assert_eq!(update.revision, 2);
    assert!(!update.source_baseline);
    assert_eq!(update.data, json!({ "remaining": 75 }));

    // Plugin command in `plugin.*` namespace round-trips via dispatch + reply.
    let cmd_name = CommandName::try_new("plugin.ai-usage.refresh").unwrap();
    plugin
        .register_command(CommandRegisterParams {
            name: cmd_name.clone(),
            description: "Refresh AI quota snapshots".to_owned(),
            plugin_id: Some(plugin_id.clone()),
        })
        .await
        .unwrap();

    let invoker = BusClient::connect(&public_sock).await.unwrap();
    let invoke_task = tokio::spawn({
        let cmd_name = cmd_name.clone();
        async move {
            invoker
                .invoke_command(CommandInvokeParams {
                    name: cmd_name,
                    args: vec!["--force".to_owned()],
                    payload: Some(json!({ "account": "primary" })),
                })
                .await
        }
    });

    let Some(ServerMessage::Notification { method, params, .. }) =
        timeout(Duration::from_secs(2), plugin.next_notification())
            .await
            .unwrap()
    else {
        panic!("expected command.dispatch notification");
    };
    assert_eq!(method, methods::COMMAND_DISPATCH);
    let dispatch: CommandDispatchNotification = serde_json::from_value(params).unwrap();
    assert_eq!(dispatch.args, vec!["--force"]);

    plugin
        .reply_command(CommandReplyParams {
            call_id: dispatch.call_id,
            result: Some(CommandInvokeResult {
                message: Some("refreshed".to_owned()),
                data: Some(json!({ "ok": true })),
            }),
            error: None,
        })
        .await
        .unwrap();

    let invoke_res = invoke_task.await.unwrap().unwrap();
    assert_eq!(invoke_res.message.as_deref(), Some("refreshed"));

    // Acquire inhibitor and observe live update.
    let inh = plugin
        .acquire_inhibitor(InhibitorAcquireParams {
            scope: InhibitorScope::Sleep,
            reason: "Agent running".to_owned(),
            plugin_id: Some(plugin_id.clone()),
        })
        .await
        .unwrap();
    assert!(inh.cookie >= 1);

    let Some(ServerMessage::Notification { params, .. }) =
        timeout(Duration::from_secs(2), observer.next_notification())
            .await
            .unwrap()
    else {
        panic!("expected inhibitors update");
    };
    let inh_update: TopicUpdate = serde_json::from_value(params).unwrap();
    let active: Vec<InhibitorEntry> = serde_json::from_value(inh_update.data).unwrap();
    assert_eq!(active.len(), 1);

    // Disconnect plugin: observer must receive BOTH topic.removed and inhibitors cleared!
    drop(plugin);

    let mut saw_removed = false;
    let mut saw_inhibitors_empty = false;
    for _ in 0..2 {
        let Some(ServerMessage::Notification { method, params, .. }) =
            timeout(Duration::from_secs(2), observer.next_notification())
                .await
                .unwrap()
        else {
            panic!("expected notification after plugin disconnect");
        };
        if method == methods::TOPIC_REMOVED {
            let removed: TopicRemovedNotification = serde_json::from_value(params).unwrap();
            assert_eq!(removed.topic, custom_topic);
            assert_eq!(removed.topic_instance_id, first_instance_id);
            saw_removed = true;
        } else if method == methods::TOPIC_UPDATE {
            let upd: TopicUpdate = serde_json::from_value(params).unwrap();
            let list: Vec<InhibitorEntry> = serde_json::from_value(upd.data).unwrap();
            if list.is_empty() {
                saw_inhibitors_empty = true;
            }
        }
    }
    assert!(saw_removed, "expected topic.removed notification");
    assert!(
        saw_inhibitors_empty,
        "expected inhibitors to clear on disconnect"
    );

    // Re-registering the same topic name must allocate a distinct topic_instance_id.
    let plugin2 = BusClient::connect(&public_sock).await.unwrap();
    let reg2 = plugin2
        .register_topic(TopicRegisterParams {
            topic: custom_topic.clone(),
            plugin_id: Some(plugin_id),
            initial: json!({ "remaining": 100 }),
        })
        .await
        .unwrap();
    let second_instance_id = reg2["topic_instance_id"].as_u64().unwrap();
    assert_ne!(first_instance_id, second_instance_id);

    shutdown.shutdown();
    server_task.await.unwrap().unwrap();
    assert!(!public_sock.exists());
    assert!(!host_sock.exists());
}

#[tokio::test]
async fn concurrent_publishers_preserve_strict_snapshot_then_monotonic_revision_order() {
    let dir = TempDir::new().unwrap();
    let public_sock = dir.path().join("bus.sock");
    let host_sock = dir.path().join("host.sock");
    let lock_path = dir.path().join("daemon.lock");

    let hub = BusHub::new("0.1.0-test", dir.path().join("media"));
    let counter_topic = TopicName::try_new("daemon.counter").unwrap();
    hub.publish_core_topic(counter_topic.clone(), json!(0), UpdateKind::SourceBaseline);

    let server = BusServer::bind(public_sock.clone(), host_sock, lock_path, hub.clone()).unwrap();
    let shutdown = server.shutdown_handle();
    let server_task = tokio::spawn(async move { server.serve().await });

    let mut subscriber = BusClient::connect(&public_sock).await.unwrap();

    // Start two concurrent publishers hammering the topic while subscribing.
    let p1 = {
        let hub = hub.clone();
        let topic = counter_topic.clone();
        tokio::spawn(async move {
            for i in 1..=25u64 {
                hub.publish_core_topic(topic.clone(), json!(i), UpdateKind::Live);
                tokio::task::yield_now().await;
            }
        })
    };
    let p2 = {
        let hub = hub.clone();
        let topic = counter_topic.clone();
        tokio::spawn(async move {
            for i in 101..=125u64 {
                hub.publish_core_topic(topic.clone(), json!(i), UpdateKind::Live);
                tokio::task::yield_now().await;
            }
        })
    };

    let snap = subscriber.subscribe(counter_topic.clone()).await.unwrap();
    p1.await.unwrap();
    p2.await.unwrap();

    // Publish one sentinel final value and verify strictly monotonic revisions from snapshot -> final!
    let final_rev = hub.publish_core_topic(counter_topic.clone(), json!(999), UpdateKind::Live);
    let mut last_rev = snap.revision;
    while last_rev < final_rev {
        let Some(ServerMessage::Notification { method, params, .. }) =
            timeout(Duration::from_secs(2), subscriber.next_notification())
                .await
                .unwrap()
        else {
            panic!("expected topic.update until final_rev");
        };
        assert_eq!(method, methods::TOPIC_UPDATE);
        let upd: TopicUpdate = serde_json::from_value(params).unwrap();
        assert!(
            upd.revision > last_rev,
            "revision went backwards or duplicated: {} after {last_rev}",
            upd.revision
        );
        last_rev = upd.revision;
    }
    assert_eq!(last_rev, final_rev);

    shutdown.shutdown();
    server_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn slow_subscriber_receives_topic_reset_and_recovers_latest_state() {
    let dir = TempDir::new().unwrap();
    let public_sock = dir.path().join("bus.sock");
    let host_sock = dir.path().join("host.sock");
    let lock_path = dir.path().join("daemon.lock");

    // Tight outbound frame budget to deterministically trigger slow-consumer reset.
    let limits = BusLimits {
        max_queued_frames: 4,
        max_queued_bytes: 8 * 1024,
        ..BusLimits::default()
    };
    let hub = BusHub::with_limits("0.1.0-test", dir.path().join("media"), limits);
    let burst_topic = TopicName::try_new("daemon.burst").unwrap();
    hub.publish_core_topic(burst_topic.clone(), json!(0), UpdateKind::SourceBaseline);

    let server = BusServer::bind(public_sock.clone(), host_sock, lock_path, hub.clone()).unwrap();
    let shutdown = server.shutdown_handle();
    let server_task = tokio::spawn(async move { server.serve().await });

    let mut client = BusClient::connect(&public_sock).await.unwrap();
    let snap = client.subscribe(burst_topic.clone()).await.unwrap();
    assert_eq!(snap.revision, 1);

    // Burst far beyond max_queued_frames without yielding to the writer task.
    let mut final_rev = 1;
    for i in 1..=60u64 {
        final_rev = hub.publish_core_topic(burst_topic.clone(), json!(i), UpdateKind::Live);
    }

    let mut saw_reset = false;
    while let Ok(Some(ServerMessage::Notification { method, params, .. })) =
        timeout(Duration::from_millis(300), client.next_notification()).await
    {
        if method == methods::TOPIC_RESET {
            let reset: TopicResetNotification = serde_json::from_value(params).unwrap();
            assert!(reset.topics.contains(&burst_topic));
            saw_reset = true;
            break;
        }
    }
    assert!(saw_reset, "expected slow subscriber to receive topic.reset");

    // Re-subscribe recovers the exact latest committed revision without silent staleness.
    let recovered = client.subscribe(burst_topic).await.unwrap();
    assert_eq!(recovered.revision, final_rev);
    assert_eq!(recovered.data, json!(60));

    shutdown.shutdown();
    server_task.await.unwrap().unwrap();
}
