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
use z_shell_session::idle::{
    Caffeine, IdleAction, IdleConfig, IdleRule, IdleSnapshot, MediaPlayback, SleepBlockStatus,
};
use z_shell_session::pam::{
    AuthFuture, AuthOutcome, Authenticator, Credentials, MockAuthenticator,
};
use z_shell_session::service::{LOCK_TOPIC, SessionService, resolve_effective_username};
use z_shell_session::wayland_idle::WaylandIdleEvent;

#[derive(Debug, Default)]
struct MockSleep {
    held: Mutex<bool>,
    block_held: Mutex<bool>,
    block_acquisitions: Mutex<u32>,
    block_releases: Mutex<u32>,
    block_fail: Mutex<Option<String>>,
    block_gate: Mutex<Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
    suspends: Mutex<u32>,
    suspend_fail: Mutex<Option<String>>,
    suspend_gate: Mutex<Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>>,
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

    fn acquire_sleep_block(
        &self,
        _reason: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(), SleepInhibitorError>> + Send + '_>> {
        let gate = self.block_gate.lock().expect("block gate").clone();
        let fail = self.block_fail.lock().expect("block fail").clone();
        Box::pin(async move {
            if let Some((entered, release)) = gate {
                entered.notify_waiters();
                release.notified().await;
            }
            if let Some(reason) = fail {
                return Err(SleepInhibitorError::new(reason));
            }
            *self.block_held.lock().expect("block held") = true;
            *self.block_acquisitions.lock().expect("block acq") += 1;
            Ok(())
        })
    }

    fn release_sleep_block(&self) {
        let mut held = self.block_held.lock().expect("block held");
        if *held {
            *held = false;
            *self.block_releases.lock().expect("block rel") += 1;
        }
    }

    fn is_sleep_block_held(&self) -> bool {
        *self.block_held.lock().expect("block held")
    }

    fn suspend(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), SleepInhibitorError>> + Send + '_>> {
        let gate = self.suspend_gate.lock().expect("suspend gate").clone();
        let fail = self.suspend_fail.lock().expect("suspend fail").clone();
        Box::pin(async move {
            if let Some((entered, release)) = gate {
                entered.notify_waiters();
                release.notified().await;
            }
            if let Some(reason) = fail {
                return Err(SleepInhibitorError::new(reason));
            }
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
    let service = Arc::new(
        SessionService::new(
            "daemon-test",
            authenticator,
            inhibitor.clone(),
            &IdleSettings::default(),
        )
        .with_account_resolver(|| Ok("alice".to_owned())),
    );
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
        ("power.suspend", json!({})),
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

#[tokio::test]
async fn sleep_block_inhibitor_tracks_caffeine_legacy_payload_and_timer_expiry() {
    let (service, inhibitor, hub) = service(Arc::new(MockAuthenticator::new([])));
    assert!(!inhibitor.is_sleep_block_held());
    assert_eq!(
        service.idle_snapshot().sleep_block_status,
        SleepBlockStatus::Inactive
    );

    // Legacy `{enabled: true}` payload acquires block FD before returning.
    let on = invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": true }),
    )
    .await
    .unwrap();
    assert!(inhibitor.is_sleep_block_held());
    assert_eq!(on["sleep_block_status"]["status"], json!("held"));
    assert_eq!(
        service.idle_snapshot().sleep_block_status,
        SleepBlockStatus::Held
    );

    // Turning off releases block FD.
    let off = invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": false }),
    )
    .await
    .unwrap();
    assert!(!inhibitor.is_sleep_block_held());
    assert_eq!(off["sleep_block_status"]["status"], json!("inactive"));

    // Timed Keep awake acquires and releases on auto-expiry.
    invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": true, "duration_seconds": 1 }),
    )
    .await
    .unwrap();
    assert!(inhibitor.is_sleep_block_held());

    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if !service.idle_snapshot().caffeine && !inhibitor.is_sleep_block_held() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .expect("timed Keep awake must release sleep:block FD on expiry");
    assert_eq!(
        service.idle_snapshot().sleep_block_status,
        SleepBlockStatus::Inactive
    );
}

#[tokio::test]
async fn sleep_block_failure_is_observable_while_local_caffeine_remains_active() {
    let (service, inhibitor, hub) = service(Arc::new(MockAuthenticator::new([])));
    *inhibitor.block_fail.lock().expect("block fail") = Some("logind denied inhibit".into());

    let reply = invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": true }),
    )
    .await
    .unwrap();
    assert_eq!(reply["caffeine"], json!(true));
    assert_eq!(reply["sleep_block_status"]["status"], json!("unavailable"));
    assert_eq!(
        reply["sleep_block_status"]["reason"],
        json!("logind denied inhibit")
    );
    assert!(!inhibitor.is_sleep_block_held());
    assert_eq!(
        service.idle_snapshot().sleep_block_status,
        SleepBlockStatus::Unavailable {
            reason: "logind denied inhibit".into(),
        }
    );

    // Turning off resets status to Inactive.
    invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": false }),
    )
    .await
    .unwrap();
    assert_eq!(
        service.idle_snapshot().sleep_block_status,
        SleepBlockStatus::Inactive
    );
}

#[tokio::test]
async fn pending_sleep_block_acquisition_completing_after_shutdown_does_not_reinstall_fd() {
    let (service, inhibitor, hub) = service(Arc::new(MockAuthenticator::new([])));
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    *inhibitor.block_gate.lock().expect("block gate") = Some((entered.clone(), release.clone()));

    let entered_wait = entered.notified();
    let call_hub = hub.clone();
    let task = tokio::spawn(async move {
        invoke(
            &call_hub,
            ClientRole::Public,
            "idle.caffeine",
            json!({ "enabled": true }),
        )
        .await
    });
    entered_wait.await;

    // Shut down while acquire_sleep_block() is still in flight.
    service.shutdown();
    release.notify_waiters();
    task.await.expect("task join").expect("caffeine call");

    assert!(
        !inhibitor.is_sleep_block_held(),
        "sleep:block FD must not remain installed after shutdown()"
    );
    assert_eq!(
        service.idle_snapshot().sleep_block_status,
        SleepBlockStatus::Inactive
    );
}

#[tokio::test]
async fn explicit_host_suspend_bypasses_block_fd_and_ignores_concurrent_caffeine_toggle() {
    let (service, inhibitor, hub) = service(Arc::new(MockAuthenticator::new([])));
    service.arm_sleep_delay().await.expect("arm delay");
    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.session-register",
        json!({ "ui_session_generation": 1 }),
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
        json!({ "lock_id": lock_id, "ui_session_generation": 1 }),
    )
    .await
    .expect("ack");

    // Enable Keep awake so our own sleep:block FD is held.
    invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": true }),
    )
    .await
    .expect("caffeine on");
    assert!(inhibitor.is_sleep_block_held());

    // Gate suspend() so we can toggle Keep awake while explicit suspend is in flight.
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    *inhibitor.suspend_gate.lock().expect("suspend gate") =
        Some((entered.clone(), release.clone()));

    let entered_wait = entered.notified();
    let suspend_hub = hub.clone();
    let suspend_task = tokio::spawn(async move {
        invoke(
            &suspend_hub,
            ClientRole::PrivilegedHost,
            "host.suspend",
            json!({}),
        )
        .await
    });
    entered_wait.await;

    // Our own block FD must already be released before suspend() executes.
    assert!(!inhibitor.is_sleep_block_held());

    // Toggling Keep awake off and back on while explicit suspend is in flight must NOT reinstall FD.
    invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": false }),
    )
    .await
    .expect("caffeine off mid-suspend");
    invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": true }),
    )
    .await
    .expect("caffeine on mid-suspend");
    assert!(
        !inhibitor.is_sleep_block_held(),
        "concurrent Keep awake toggle must not reinstall block FD during explicit suspend"
    );

    release.notify_waiters();
    suspend_task
        .await
        .expect("suspend join")
        .expect("suspend succeeded");
    assert_eq!(*inhibitor.suspends.lock().expect("suspends"), 1);
    assert!(!inhibitor.is_sleep_block_held());

    // After Wake, Keep awake is still active so block FD is re-acquired.
    service.handle_sleep_signal(SleepSignal::Wake).await;
    assert!(inhibitor.is_sleep_block_held());
    assert_eq!(
        service.idle_snapshot().sleep_block_status,
        SleepBlockStatus::Held
    );
}

#[tokio::test]
async fn idle_lock_and_suspend_cancelled_if_caffeine_enabled_while_lock_ack_pending() {
    let (service, inhibitor, hub) = service(Arc::new(MockAuthenticator::new([])));
    service.arm_sleep_delay().await.expect("arm delay");
    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.session-register",
        json!({ "ui_session_generation": 9 }),
    )
    .await
    .expect("register");

    let config = IdleConfig {
        rules: vec![IdleRule {
            name: "sleep".into(),
            enabled: true,
            timeout_seconds: 60,
            locked_timeout_seconds: None,
            action: IdleAction::LockAndSuspend,
            resume_command: None,
            pre_action_fade_seconds: 0,
        }],
    };
    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "idle.configure",
        serde_json::to_value(config).expect("config JSON"),
    )
    .await
    .expect("configure");

    let (rule_index, token, _) = service
        .active_idle_watches()
        .into_iter()
        .next()
        .expect("active watch");
    service
        .handle_wayland_idle(WaylandIdleEvent::Idled { rule_index, token })
        .await;
    assert_eq!(service.lock_snapshot().phase, LockPhaseName::Engaging);
    assert!(service.lock_snapshot().sleep_hold);
    let lock_id = service.lock_snapshot().lock_id.expect("lock ID");

    // Enable Keep awake while lock ACK is still pending.
    invoke(
        &hub,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": true }),
    )
    .await
    .expect("caffeine on");
    assert!(inhibitor.is_sleep_block_held());

    // Host acknowledges lock; IdleSuspend must abort cleanly while staying locked!
    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.lock-ack",
        json!({ "lock_id": lock_id, "ui_session_generation": 9 }),
    )
    .await
    .expect("ACK succeeds cleanly even when idle suspend is cancelled");

    assert_eq!(*inhibitor.suspends.lock().expect("suspends"), 0);
    assert_eq!(service.lock_snapshot().phase, LockPhaseName::Locked);
    assert!(!service.lock_snapshot().sleep_hold);
    assert!(inhibitor.is_held(), "delay inhibitor must be re-armed");
    assert!(
        inhibitor.is_sleep_block_held(),
        "sleep:block inhibitor must stay held"
    );
}

#[tokio::test]
async fn stale_suspend_failure_does_not_clear_newer_external_prepare_for_sleep_hold() {
    let (service, inhibitor, hub) = service(Arc::new(MockAuthenticator::new([])));
    service.arm_sleep_delay().await.expect("arm delay");
    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.session-register",
        json!({ "ui_session_generation": 3 }),
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
        json!({ "lock_id": lock_id, "ui_session_generation": 3 }),
    )
    .await
    .expect("ack");

    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    *inhibitor.suspend_gate.lock().expect("suspend gate") =
        Some((entered.clone(), release.clone()));
    *inhibitor.suspend_fail.lock().expect("suspend fail") =
        Some("polkit denied Suspend(false)".into());

    let entered_wait = entered.notified();
    let suspend_hub = hub.clone();
    let suspend_task = tokio::spawn(async move {
        invoke(
            &suspend_hub,
            ClientRole::PrivilegedHost,
            "host.suspend",
            json!({}),
        )
        .await
    });
    entered_wait.await;

    // A newer external PrepareForSleep arrives before the earlier Suspend(false) fails.
    service
        .handle_sleep_signal(SleepSignal::PrepareForSleep)
        .await;
    assert!(service.lock_snapshot().sleep_hold);
    assert!(!inhibitor.is_held());

    // Now the stale Suspend(false) fails.
    release.notify_waiters();
    let err = suspend_task
        .await
        .expect("suspend join")
        .expect_err("suspend failed");
    assert_eq!(err.code, ErrorCode::Internal);

    // The newer external PrepareForSleep hold MUST remain intact!
    assert!(
        service.lock_snapshot().sleep_hold,
        "stale suspend failure must not clear newer external PrepareForSleep hold"
    );
    assert!(
        !inhibitor.is_held(),
        "stale suspend failure must not re-arm delay FD during newer PrepareForSleep"
    );
}

#[tokio::test]
async fn lock_authenticate_resolves_daemon_uid_account_and_rejects_mismatched_username() {
    let authenticator = Arc::new(MockAuthenticator::new([
        AuthOutcome::Authenticated,
        AuthOutcome::Authenticated,
    ]));
    let inhibitor = Arc::new(MockSleep::default());
    let service = Arc::new(SessionService::new(
        "daemon-uid-test",
        authenticator.clone(),
        inhibitor,
        &IdleSettings::default(),
    ));
    let hub = hub();
    service.install_on_bus(&hub);

    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.session-register",
        json!({ "ui_session_generation": 1 }),
    )
    .await
    .expect("register host");
    invoke(&hub, ClientRole::Public, "lock.request", json!({}))
        .await
        .expect("lock");
    let lock_id = service.lock_snapshot().lock_id.expect("lock ID");
    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.lock-ack",
        json!({ "lock_id": lock_id, "ui_session_generation": 1 }),
    )
    .await
    .expect("ack");

    // Non-empty mismatched username (e.g. UI fallback or display name) must be denied without calling PAM.
    for mismatched in [
        "__definitely_not_daemon_owner__",
        "Display Name With Spaces",
    ] {
        let err = invoke(
            &hub,
            ClientRole::PrivilegedHost,
            "host.lock-authenticate",
            json!({
                "username": mismatched,
                "password": "secret-password",
                "lock_id": lock_id,
                "ui_session_generation": 1,
            }),
        )
        .await
        .expect_err("mismatched username must fail");
        assert_eq!(err.code, ErrorCode::PermissionDenied);
        assert!(!err.message.contains("secret-password"));
    }
    assert!(
        authenticator.recorded_usernames().is_empty(),
        "mismatched username must never reach the PAM authenticator"
    );

    // Omitting `username` authenticates against the daemon owner's effective UID account.
    let approval = invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.lock-authenticate",
        json!({
            "password": "secret-password",
            "lock_id": lock_id,
            "ui_session_generation": 1,
        }),
    )
    .await
    .expect("omitted username must authenticate daemon owner");
    assert!(approval["token"].as_str().is_some());

    // Empty string `username` also resolves to the daemon owner's effective UID account.
    let second_approval = invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "host.lock-authenticate",
        json!({
            "username": "",
            "password": "secret-password",
            "lock_id": lock_id,
            "ui_session_generation": 1,
        }),
    )
    .await
    .expect("empty username must authenticate daemon owner");
    assert!(second_approval["token"].as_str().is_some());

    let expected_owner = resolve_effective_username().expect("current effective uid username");
    let recorded = authenticator.recorded_usernames();
    assert_eq!(recorded, [expected_owner.clone(), expected_owner]);

    // If account resolution fails, authentication fails closed without calling PAM or leaking secrets.
    let failing_auth = Arc::new(MockAuthenticator::new([AuthOutcome::Authenticated]));
    let failing_service = Arc::new(
        SessionService::new(
            "daemon-uid-missing",
            failing_auth.clone(),
            Arc::new(MockSleep::default()),
            &IdleSettings::default(),
        )
        .with_account_resolver(|| Err("uid missing from passwd".to_owned())),
    );
    let failing_hub = BusHub::new("test", PathBuf::from("/tmp/z-shell-session-test-media"));
    failing_service.install_on_bus(&failing_hub);
    invoke(
        &failing_hub,
        ClientRole::PrivilegedHost,
        "host.session-register",
        json!({ "ui_session_generation": 1 }),
    )
    .await
    .expect("register");
    invoke(&failing_hub, ClientRole::Public, "lock.request", json!({}))
        .await
        .expect("lock");
    let fail_lock_id = failing_service.lock_snapshot().lock_id.expect("lock ID");
    invoke(
        &failing_hub,
        ClientRole::PrivilegedHost,
        "host.lock-ack",
        json!({ "lock_id": fail_lock_id, "ui_session_generation": 1 }),
    )
    .await
    .expect("ack");
    let unavailable = invoke(
        &failing_hub,
        ClientRole::PrivilegedHost,
        "host.lock-authenticate",
        json!({
            "password": "unresolvable-secret",
            "lock_id": fail_lock_id,
            "ui_session_generation": 1,
        }),
    )
    .await
    .expect_err("unresolvable daemon owner must fail closed");
    assert_eq!(unavailable.code, ErrorCode::Internal);
    assert!(!unavailable.message.contains("unresolvable-secret"));
    assert!(failing_auth.recorded_usernames().is_empty());
}

#[tokio::test]
async fn power_suspend_and_idle_suspend_route_through_lock_coordinator_and_lock_guard() {
    let observed_phases = Arc::new(Mutex::new(Vec::new()));
    let observed_clone = Arc::clone(&observed_phases);
    let inhibitor = Arc::new(MockSleep::default());
    let service = Arc::new(
        SessionService::new(
            "daemon-suspend-test",
            Arc::new(MockAuthenticator::new([AuthOutcome::Authenticated])),
            inhibitor.clone(),
            &IdleSettings {
                fallback_locker: Some(vec!["/bin/true".into()]),
                ..IdleSettings::default()
            },
        )
        .with_account_resolver(|| Ok("alice".to_owned()))
        .with_lock_guard(move |phase| {
            observed_clone.lock().expect("observed phases").push(phase);
        }),
    );
    let bus = hub();
    service.install_on_bus(&bus);
    service.arm_sleep_delay().await.expect("arm delay");

    // External PrepareForSleep with no host connected and a fallback locker sets phase=FallbackSpawned
    // and sleep_hold=true: lock_guard MUST still observe a non-unlocked phase!
    service
        .handle_sleep_signal(SleepSignal::PrepareForSleep)
        .await;
    assert_eq!(
        service.lock_snapshot().phase,
        LockPhaseName::FallbackSpawned
    );
    assert!(service.lock_snapshot().sleep_hold);
    assert_eq!(
        observed_phases.lock().expect("phases").last().copied(),
        Some(LockPhaseName::Engaging),
        "sleep_hold=true must notify lock_guard as non-unlocked even when phase is FallbackSpawned"
    );
    service.handle_sleep_signal(SleepSignal::Wake).await;
    assert!(!service.lock_snapshot().sleep_hold);
    assert_eq!(
        observed_phases.lock().expect("phases").last().copied(),
        Some(LockPhaseName::FallbackSpawned)
    );

    // Register host and unlock cleanly via lock.request + ack + auth + consume.
    invoke(
        &bus,
        ClientRole::PrivilegedHost,
        "host.session-register",
        json!({ "ui_session_generation": 2 }),
    )
    .await
    .expect("register");
    invoke(&bus, ClientRole::Public, "lock.request", json!({}))
        .await
        .expect("lock");
    let first_lock = service.lock_snapshot().lock_id.expect("lock ID");
    invoke(
        &bus,
        ClientRole::PrivilegedHost,
        "host.lock-ack",
        json!({ "lock_id": first_lock, "ui_session_generation": 2 }),
    )
    .await
    .expect("ack");
    let approval = invoke(
        &bus,
        ClientRole::PrivilegedHost,
        "host.lock-authenticate",
        json!({
            "password": "pw",
            "lock_id": first_lock,
            "ui_session_generation": 2,
        }),
    )
    .await
    .expect("auth");
    invoke(
        &bus,
        ClientRole::PrivilegedHost,
        "host.lock-consume-unlock",
        json!({
            "token": approval["token"],
            "lock_id": first_lock,
            "ui_session_generation": 2,
        }),
    )
    .await
    .expect("unlock");
    assert_eq!(service.lock_snapshot().phase, LockPhaseName::Unlocked);

    // `power.suspend` rejects unexpected arguments/payload, enters Engaging + sleep_hold, and waits for ACK.
    let bad_args = bus
        .invoke_command(
            CallerContext {
                client_id: 99,
                role: ClientRole::PrivilegedHost,
            },
            CommandInvokeParams {
                name: CommandName::try_new("power.suspend").expect("cmd"),
                args: vec!["extra".into()],
                payload: None,
            },
        )
        .await
        .expect_err("power.suspend must reject positional args");
    assert_eq!(bad_args.code, ErrorCode::InvalidParams);

    let bad_payload = invoke(
        &bus,
        ClientRole::PrivilegedHost,
        "power.suspend",
        json!({ "unexpected": true }),
    )
    .await
    .expect_err("power.suspend must reject unknown payload fields");
    assert_eq!(bad_payload.code, ErrorCode::InvalidParams);

    bus.invoke_command(
        CallerContext {
            client_id: 99,
            role: ClientRole::PrivilegedHost,
        },
        CommandInvokeParams {
            name: CommandName::try_new("power.suspend").expect("cmd"),
            args: Vec::new(),
            payload: None,
        },
    )
    .await
    .expect("power.suspend with None payload");
    assert_eq!(service.lock_snapshot().phase, LockPhaseName::Engaging);
    assert!(service.lock_snapshot().sleep_hold);
    assert_eq!(*inhibitor.suspends.lock().expect("suspends"), 0);

    let power_lock_id = service.lock_snapshot().lock_id.expect("lock ID");
    invoke(
        &bus,
        ClientRole::PrivilegedHost,
        "host.lock-ack",
        json!({ "lock_id": power_lock_id, "ui_session_generation": 2 }),
    )
    .await
    .expect("power.suspend ACK");
    assert_eq!(*inhibitor.suspends.lock().expect("suspends"), 1);
    assert_eq!(service.lock_snapshot().phase, LockPhaseName::Locked);

    // Test IdleAction::Suspend from Unlocked state on a fresh service instance.
    let (idle_service, idle_inhibitor, idle_bus) =
        crate::service(Arc::new(MockAuthenticator::new([])));
    idle_service.arm_sleep_delay().await.expect("arm delay");
    invoke(
        &idle_bus,
        ClientRole::PrivilegedHost,
        "host.session-register",
        json!({ "ui_session_generation": 4 }),
    )
    .await
    .expect("register");
    let config = IdleConfig {
        rules: vec![IdleRule {
            name: "plain-suspend".into(),
            enabled: true,
            timeout_seconds: 30,
            locked_timeout_seconds: None,
            action: IdleAction::Suspend,
            resume_command: None,
            pre_action_fade_seconds: 0,
        }],
    };
    invoke(
        &idle_bus,
        ClientRole::PrivilegedHost,
        "idle.configure",
        serde_json::to_value(config).expect("config JSON"),
    )
    .await
    .expect("configure");
    let (rule_index, token, _) = idle_service
        .active_idle_watches()
        .into_iter()
        .next()
        .expect("watch");
    idle_service
        .handle_wayland_idle(WaylandIdleEvent::Idled { rule_index, token })
        .await;
    assert_eq!(
        idle_service.lock_snapshot().phase,
        LockPhaseName::Engaging,
        "IdleAction::Suspend must enter Engaging and wait for host ACK before suspending"
    );
    assert!(idle_service.lock_snapshot().sleep_hold);
    assert_eq!(*idle_inhibitor.suspends.lock().expect("suspends"), 0);

    let idle_lock_id = idle_service.lock_snapshot().lock_id.expect("lock ID");
    invoke(
        &idle_bus,
        ClientRole::PrivilegedHost,
        "host.lock-ack",
        json!({ "lock_id": idle_lock_id, "ui_session_generation": 4 }),
    )
    .await
    .expect("idle suspend ACK");
    assert_eq!(*idle_inhibitor.suspends.lock().expect("suspends"), 1);

    // Enabling Caffeine while `IdleAction::Suspend` is Engaging must cancel suspend on ACK
    // instead of overriding the sleep:block inhibitor!
    let (cancel_service, cancel_inhibitor, cancel_bus) =
        crate::service(Arc::new(MockAuthenticator::new([])));
    cancel_service.arm_sleep_delay().await.expect("arm delay");
    invoke(
        &cancel_bus,
        ClientRole::PrivilegedHost,
        "host.session-register",
        json!({ "ui_session_generation": 8 }),
    )
    .await
    .expect("register");
    let cancel_config = IdleConfig {
        rules: vec![IdleRule {
            name: "plain-suspend-cancelled".into(),
            enabled: true,
            timeout_seconds: 30,
            locked_timeout_seconds: None,
            action: IdleAction::Suspend,
            resume_command: None,
            pre_action_fade_seconds: 0,
        }],
    };
    invoke(
        &cancel_bus,
        ClientRole::PrivilegedHost,
        "idle.configure",
        serde_json::to_value(cancel_config).expect("config JSON"),
    )
    .await
    .expect("configure");
    let (c_rule, c_token, _) = cancel_service
        .active_idle_watches()
        .into_iter()
        .next()
        .expect("watch");
    cancel_service
        .handle_wayland_idle(WaylandIdleEvent::Idled {
            rule_index: c_rule,
            token: c_token,
        })
        .await;
    assert_eq!(
        cancel_service.lock_snapshot().phase,
        LockPhaseName::Engaging
    );
    assert!(cancel_service.lock_snapshot().sleep_hold);
    let cancel_lock_id = cancel_service.lock_snapshot().lock_id.expect("lock ID");

    invoke(
        &cancel_bus,
        ClientRole::Public,
        "idle.caffeine",
        json!({ "enabled": true }),
    )
    .await
    .expect("caffeine on while IdleAction::Suspend is Engaging");
    assert!(cancel_inhibitor.is_sleep_block_held());

    invoke(
        &cancel_bus,
        ClientRole::PrivilegedHost,
        "host.lock-ack",
        json!({ "lock_id": cancel_lock_id, "ui_session_generation": 8 }),
    )
    .await
    .expect("ACK succeeds cleanly when IdleAction::Suspend is inhibited");
    assert_eq!(
        *cancel_inhibitor.suspends.lock().expect("suspends"),
        0,
        "IdleAction::Suspend must not suspend when Caffeine was enabled before ACK"
    );
    assert_eq!(cancel_service.lock_snapshot().phase, LockPhaseName::Locked);
    assert!(!cancel_service.lock_snapshot().sleep_hold);
    assert!(
        cancel_inhibitor.is_held(),
        "delay inhibitor must be re-armed"
    );
    assert!(
        cancel_inhibitor.is_sleep_block_held(),
        "sleep:block inhibitor must stay held"
    );
}
