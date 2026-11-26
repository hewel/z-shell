use serde_json::{Value, json};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use z_shell_bus::{BusHub, CallerContext};
use z_shell_config::IdleSettings;
use z_shell_protocol::{
    ClientMessage, ClientRole, CommandInvokeParams, CommandName, ErrorCode, InhibitorScope,
    PROTOCOL_VERSION, RequestId, RpcError, ServerMessage, TopicName, TopicSubscribeParams,
    decode_server_line, methods,
};
use z_shell_session::coordinator::{
    CoordinatorAction, LockPhaseName, SleepInhibitor, SleepInhibitorError, SleepSignal,
};
use z_shell_session::idle::{Caffeine, IdleSnapshot, MediaPlayback};
use z_shell_session::pam::{
    AuthFuture, AuthOutcome, Authenticator, Credentials, MockAuthenticator,
};
use z_shell_session::service::{LOCK_TOPIC, SessionService};

#[derive(Debug, Default)]
struct MockSleep {
    held: Mutex<bool>,
    suspends: Mutex<u32>,
}

impl SleepInhibitor for MockSleep {
    fn acquire(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), SleepInhibitorError>> + Send + '_>> {
        Box::pin(async move {
            *self.held.lock().expect("held") = true;
            Ok(())
        })
    }

    fn release(&self) {
        *self.held.lock().expect("held") = false;
    }

    fn is_held(&self) -> bool {
        *self.held.lock().expect("held")
    }

    fn suspend(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), SleepInhibitorError>> + Send + '_>> {
        Box::pin(async move {
            *self.suspends.lock().expect("suspends") += 1;
            Ok(())
        })
    }
}

fn hub() -> BusHub {
    BusHub::new("test", PathBuf::from("/tmp/z-shell-session-test-media"))
}

fn service(authenticator: Arc<dyn Authenticator>) -> (Arc<SessionService>, Arc<MockSleep>, BusHub) {
    let inhibitor = Arc::new(MockSleep::default());
    let service = Arc::new(SessionService::new(
        "daemon-test",
        authenticator,
        inhibitor.clone(),
        &IdleSettings::default(),
    ));
    let hub = hub();
    service.install_on_bus(&hub);
    (service, inhibitor, hub)
}

async fn invoke(
    hub: &BusHub,
    role: ClientRole,
    name: &str,
    payload: Value,
) -> Result<Value, RpcError> {
    hub.invoke_command(
        CallerContext {
            client_id: 99,
            role,
        },
        CommandInvokeParams {
            name: CommandName::try_new(name).expect("command name"),
            args: Vec::new(),
            payload: Some(payload),
        },
    )
    .await
    .map(|result| result.data.unwrap_or(Value::Null))
}

#[tokio::test]
async fn every_host_command_is_hard_denied_on_the_public_channel() {
    let (_service, _, hub) = service(Arc::new(MockAuthenticator::new([
        AuthOutcome::Authenticated,
    ])));
    let cases = [
        ("host.session-register", json!({"ui_session_generation": 1})),
        (
            "host.lock-ack",
            json!({"lock_id": 1, "ui_session_generation": 1}),
        ),
        (
            "host.lock-failed",
            json!({"lock_id": 1, "reason": "finished"}),
        ),
        (
            "host.lock-authenticate",
            json!({"username": "alice", "password": "public-secret", "lock_id": 1, "ui_session_generation": 1}),
        ),
        (
            "host.lock-consume-unlock",
            json!({"token": "token", "lock_id": 1, "ui_session_generation": 1}),
        ),
        ("host.suspend", json!({})),
    ];
    for (command, payload) in cases {
        let denied = invoke(&hub, ClientRole::Public, command, payload)
            .await
            .expect_err("public host command must fail");
        assert_eq!(denied.code, ErrorCode::PermissionDenied, "{command}");
        assert!(!denied.message.contains("public-secret"));
    }
}

#[tokio::test]
async fn bus_lock_flow_requires_ack_and_returns_single_use_host_approval() {
    let (service, _, hub) = service(Arc::new(MockAuthenticator::new([
        AuthOutcome::Authenticated,
    ])));
    invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({"enabled": true}),
    )
    .await
    .expect("Caffeine");
    assert!(service.idle_snapshot().caffeine);
    invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({"enabled": false}),
    )
    .await
    .expect("Caffeine off");

    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.session-register",
        json!({"ui_session_generation": 42}),
    )
    .await
    .expect("register host");
    let actions = invoke(&hub, ClientRole::Public, "lock.request", json!({}))
        .await
        .expect("public lock request");
    assert_eq!(actions[0]["action"], "request_host_lock");
    assert_eq!(service.lock_snapshot().phase, LockPhaseName::Engaging);
    let lock_id = service.lock_snapshot().lock_id.expect("lock ID");
    let ack = invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.lock-ack",
        json!({"lock_id": lock_id, "ui_session_generation": 42}),
    )
    .await
    .expect("host ACK");
    assert_eq!(ack, json!([]));
    assert_eq!(service.lock_snapshot().phase, LockPhaseName::Locked);

    let approval = invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.lock-authenticate",
        json!({"username": "alice", "password": "never-broadcast", "lock_id": lock_id, "ui_session_generation": 42}),
    )
    .await
    .expect("approval");
    assert!(!approval.to_string().contains("never-broadcast"));
    assert!(
        !serde_json::to_string(&service.lock_snapshot())
            .expect("snapshot JSON")
            .contains("never-broadcast")
    );
    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.lock-consume-unlock",
        json!({"token": approval["token"], "lock_id": lock_id, "ui_session_generation": 42}),
    )
    .await
    .expect("consume approval");
    assert_eq!(service.lock_snapshot().phase, LockPhaseName::Unlocked);
    let replay = invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.lock-consume-unlock",
        json!({"token": approval["token"], "lock_id": lock_id, "ui_session_generation": 42}),
    )
    .await
    .expect_err("replay");
    assert_eq!(replay.code, ErrorCode::InvalidParams);
}

#[tokio::test]
async fn host_suspend_waits_for_ack_before_executing_logind_suspend() {
    let (service, inhibitor, hub) = service(Arc::new(MockAuthenticator::new([])));
    service.arm_sleep_delay().await.expect("arm delay");
    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.session-register",
        json!({"ui_session_generation": 5}),
    )
    .await
    .expect("register");
    invoke(&hub, ClientRole::PrivilegedHost, "host.suspend", json!({}))
        .await
        .expect("request suspend");
    assert_eq!(*inhibitor.suspends.lock().expect("suspends"), 0);
    assert!(service.lock_snapshot().sleep_hold);
    let lock_id = service.lock_snapshot().lock_id.expect("lock ID");
    let actions = invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.lock-ack",
        json!({"lock_id": lock_id, "ui_session_generation": 5}),
    )
    .await
    .expect("ACK");
    assert!(
        actions
            .as_array()
            .expect("actions")
            .contains(&serde_json::to_value(CoordinatorAction::Suspend).expect("action JSON"))
    );
    assert_eq!(*inhibitor.suspends.lock().expect("suspends"), 1);
    assert!(!inhibitor.is_held());
}

#[derive(Debug)]
struct GatedAuthenticator {
    started: tokio::sync::Notify,
    release: tokio::sync::Notify,
    entered: AtomicBool,
}

impl GatedAuthenticator {
    fn new() -> Self {
        Self {
            started: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
            entered: AtomicBool::new(false),
        }
    }
}

impl Authenticator for GatedAuthenticator {
    fn authenticate(&self, _credentials: Credentials) -> AuthFuture<'_> {
        Box::pin(async move {
            self.entered.store(true, Ordering::SeqCst);
            self.started.notify_waiters();
            self.release.notified().await;
            AuthOutcome::Authenticated
        })
    }
}

#[tokio::test]
async fn in_flight_bus_auth_is_stale_after_sleep_hold() {
    let authenticator = Arc::new(GatedAuthenticator::new());
    let (service, _, hub) = service(authenticator.clone());
    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.session-register",
        json!({"ui_session_generation": 1}),
    )
    .await
    .expect("register");
    invoke(&hub, ClientRole::Public, "lock.request", json!({}))
        .await
        .expect("lock");
    let lock_id = service.lock_snapshot().lock_id.expect("lock ID");
    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.lock-ack",
        json!({"lock_id": lock_id, "ui_session_generation": 1}),
    )
    .await
    .expect("ACK");
    let auth_hub = hub.clone();
    let auth = tokio::spawn(async move {
        invoke(
            &auth_hub,
            ClientRole::PrivilegedHost,
            "host.lock-authenticate",
            json!({"username": "alice", "password": "secret", "lock_id": lock_id, "ui_session_generation": 1}),
        )
        .await
    });
    while !authenticator.entered.load(Ordering::SeqCst) {
        tokio::task::yield_now().await;
    }
    service
        .handle_sleep_signal(SleepSignal::PrepareForSleep)
        .await;
    authenticator.release.notify_waiters();
    let outcome = auth
        .await
        .expect("auth task")
        .expect_err("stale PAM result");
    assert_eq!(outcome.code, ErrorCode::Disabled);
    assert_eq!(service.lock_snapshot().phase, LockPhaseName::Locked);
    service.handle_sleep_signal(SleepSignal::Wake).await;
    assert_eq!(service.lock_snapshot().phase, LockPhaseName::Locked);
}

#[tokio::test]
async fn no_host_fallback_is_not_locked_and_lock_failure_aborts_suspend() {
    let inhibitor = Arc::new(MockSleep::default());
    let settings = IdleSettings {
        fallback_locker: Some(vec!["/bin/true".into()]),
        ..IdleSettings::default()
    };
    let service = Arc::new(SessionService::new(
        "daemon-test",
        Arc::new(MockAuthenticator::new([])),
        inhibitor,
        &settings,
    ));
    let hub = hub();
    service.install_on_bus(&hub);
    let actions = invoke(&hub, ClientRole::Public, "lock.request", json!({}))
        .await
        .expect("fallback");
    assert_eq!(actions[0]["action"], "spawn_fallback");
    assert_eq!(
        service.lock_snapshot().phase,
        LockPhaseName::FallbackSpawned
    );

    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.session-register",
        json!({"ui_session_generation": 1}),
    )
    .await
    .expect("register");
    invoke(&hub, ClientRole::PrivilegedHost, "host.suspend", json!({}))
        .await
        .expect_err("fallback cannot suspend");
}

#[tokio::test]
async fn topics_publish_non_secret_state_and_hub_inhibitors_sync() {
    let (service, _, hub) = service(Arc::new(MockAuthenticator::new([])));
    let (client_id, outbound) = hub.register_client(ClientRole::Public).expect("client");
    hub.handle_inline_message(
        client_id,
        ClientMessage::request(
            RequestId::Number(1),
            methods::BUS_HELLO,
            Some(json!({"protocol_version": PROTOCOL_VERSION})),
        ),
    );
    let _hello = outbound.next_line().await.expect("hello");
    for (id, topic) in [(2, LOCK_TOPIC), (3, "session.idle")] {
        hub.handle_inline_message(
            client_id,
            ClientMessage::request(
                RequestId::Number(id),
                methods::TOPIC_SUBSCRIBE,
                Some(
                    serde_json::to_value(TopicSubscribeParams {
                        topic: TopicName::try_new(topic).expect("topic"),
                    })
                    .expect("params"),
                ),
            ),
        );
        let line = outbound.next_line().await.expect("snapshot");
        let message = decode_server_line(&line).expect("snapshot message");
        let ServerMessage::Ok { result, .. } = message else {
            panic!("expected snapshot");
        };
        assert_eq!(result["topic"], topic);
        assert!(!result.to_string().contains("password"));
    }

    hub.handle_inline_message(
        client_id,
        ClientMessage::request(
            RequestId::Number(4),
            methods::INHIBITOR_ACQUIRE,
            Some(json!({"scope": InhibitorScope::Idle, "reason": "presentation"})),
        ),
    );
    let acquired = outbound.next_line().await.expect("acquire response");
    assert!(matches!(
        decode_server_line(&acquired).expect("acquire message"),
        ServerMessage::Ok { .. }
    ));
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if service
                .idle_snapshot()
                .active_inhibitors
                .iter()
                .any(|entry| entry.reason == "presentation")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("inhibitor sync");
    service.set_media_playing(MediaPlayback::Playing).await;
    let snapshot: IdleSnapshot = service.idle_snapshot();
    assert!(snapshot.media_playing);
    service.set_caffeine(Caffeine::Enabled).await;
    assert!(service.idle_snapshot().caffeine);
}

#[tokio::test]
async fn idle_caffeine_preset_validation_null_indefinite_and_timer_expiry() {
    let (service, _, hub) = service(Arc::new(MockAuthenticator::new([])));

    // Default remembered preset is 3600s and disabled.
    let initial = service.idle_snapshot();
    assert!(!initial.caffeine);
    assert_eq!(initial.caffeine_scope, InhibitorScope::Sleep);
    assert_eq!(initial.caffeine_duration_seconds, Some(3600));
    assert_eq!(initial.caffeine_expires_at_ms, None);

    // Reject 0 and > 86400 seconds.
    for invalid in [0_u64, 86_401_u64] {
        let err = invoke(
            &hub,
            ClientRole::Public,
            "idle.caffeine",
            json!({ "enabled": true, "duration_seconds": invalid }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidParams);
    }

    // Set timed duration 1s and verify expiry turns caffeine off while remembering preset 1s.
    let armed = invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": true, "duration_seconds": 1 }),
    )
    .await
    .unwrap();
    assert_eq!(armed["caffeine"], json!(true));
    assert_eq!(armed["caffeine_duration_seconds"], json!(1));
    assert!(armed["caffeine_expires_at_ms"].as_u64().is_some());

    // Re-arming immediately with indefinite `null` cancels the 1s timer so it stays on past 1.2s.
    let indef = invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": true, "duration_seconds": null }),
    )
    .await
    .unwrap();
    assert_eq!(indef["caffeine"], json!(true));
    assert_eq!(indef["caffeine_duration_seconds"], json!(null));
    assert_eq!(indef["caffeine_expires_at_ms"], json!(null));

    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(
        service.idle_snapshot().caffeine,
        "indefinite Keep awake must stay active past cancelled 1s timer"
    );

    // Turning off preserves `null` preset; turning back on without `duration_seconds` preserves it.
    invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": false }),
    )
    .await
    .unwrap();
    assert_eq!(service.idle_snapshot().caffeine_duration_seconds, None);
    invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": true }),
    )
    .await
    .unwrap();
    assert_eq!(service.idle_snapshot().caffeine_duration_seconds, None);
    assert_eq!(service.idle_snapshot().caffeine_expires_at_ms, None);

    // Now test actual 1s timed auto-expiry.
    invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": true, "duration_seconds": 1 }),
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if !service.idle_snapshot().caffeine {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("timed Keep awake must auto-expire");
    assert_eq!(service.idle_snapshot().caffeine_expires_at_ms, None);
    assert_eq!(service.idle_snapshot().caffeine_duration_seconds, Some(1));
}
