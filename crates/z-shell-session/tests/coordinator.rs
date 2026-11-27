use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use z_shell_session::coordinator::{
    Coordinator, CoordinatorAction, CoordinatorError, LockPhase, LockPhaseName, LogindEvent,
    LogindSleepInhibitor, SleepInhibitor, SleepInhibitorError, SleepSignal,
};
use z_shell_session::pam::AuthOutcome;

#[derive(Debug, Default)]
struct MockSleepInhibitor {
    held: Mutex<bool>,
    acquisitions: Mutex<u32>,
    releases: Mutex<u32>,
}

impl SleepInhibitor for MockSleepInhibitor {
    fn acquire(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<(), SleepInhibitorError>> + Send + '_>> {
        Box::pin(async move {
            *self.held.lock().expect("held lock") = true;
            *self.acquisitions.lock().expect("acquisition lock") += 1;
            Ok(())
        })
    }

    fn release(&self) {
        *self.held.lock().expect("held lock") = false;
        *self.releases.lock().expect("release lock") += 1;
    }

    fn is_held(&self) -> bool {
        *self.held.lock().expect("held lock")
    }
}

fn coordinator(fallback: Option<Vec<String>>) -> (Coordinator, Arc<MockSleepInhibitor>) {
    let inhibitor = Arc::new(MockSleepInhibitor::default());
    (
        Coordinator::new("daemon-a", inhibitor.clone(), fallback),
        inhibitor,
    )
}

fn locked(coordinator: &mut Coordinator) {
    coordinator.register_host(7);
    let lock_id = coordinator.snapshot().lock_id;
    if lock_id.is_none() {
        coordinator.request_lock();
    }
    let lock_id = coordinator.snapshot().lock_id.expect("lock ID");
    coordinator
        .on_host_lock_acknowledged(lock_id, 7)
        .expect("host ACK");
}

#[test]
fn only_matching_host_ack_transitions_to_locked_and_releases_sleep_delay() {
    let (mut coordinator, inhibitor) = coordinator(None);
    coordinator.register_host(3);
    let actions = coordinator.request_lock();
    let lock_id = coordinator.snapshot().lock_id.expect("lock ID");
    assert!(actions.iter().any(|action| matches!(
        action,
        CoordinatorAction::RequestHostLock { lock_id: id, ui_session_generation: 3 } if *id == lock_id
    )));
    assert_eq!(coordinator.snapshot().phase, LockPhaseName::Engaging);
    assert!(coordinator.on_host_lock_acknowledged(lock_id, 4).is_err());
    assert!(
        coordinator
            .on_host_lock_acknowledged(lock_id + 1, 3)
            .is_err()
    );
    assert_eq!(coordinator.snapshot().phase, LockPhaseName::Engaging);

    coordinator.request_suspend();
    assert!(coordinator.snapshot().sleep_hold);
    assert!(!inhibitor.is_held());
    let actions = coordinator
        .on_host_lock_acknowledged(lock_id, 3)
        .expect("valid ACK");
    assert_eq!(coordinator.snapshot().phase, LockPhaseName::Locked);
    assert!(actions.contains(&CoordinatorAction::ReleaseSleepDelayInhibitor));
    assert!(actions.contains(&CoordinatorAction::Suspend));
}

#[test]
fn unlock_approval_is_single_use_and_scoped_to_lock_and_ui_generation() {
    let (mut coordinator, _) = coordinator(None);
    locked(&mut coordinator);
    let lock_id = coordinator.snapshot().lock_id.expect("lock ID");
    let attempt = coordinator
        .begin_authentication(lock_id, 7)
        .expect("begin auth");
    let approval = coordinator
        .complete_authentication(attempt, lock_id, 7, AuthOutcome::Authenticated)
        .expect("approval");
    assert_eq!(approval.daemon_instance_id, "daemon-a");
    assert_eq!(approval.ui_session_generation, 7);
    assert_eq!(approval.lock_id, lock_id);
    assert_eq!(approval.auth_attempt_id, attempt);

    assert!(
        coordinator
            .consume_unlock(&approval.token, 8, lock_id)
            .is_err()
    );
    assert!(
        coordinator
            .consume_unlock(&approval.token, 7, lock_id + 1)
            .is_err()
    );
    coordinator
        .consume_unlock(&approval.token, 7, lock_id)
        .expect("first consumption");
    assert_eq!(coordinator.snapshot().phase, LockPhaseName::Unlocked);
    assert_eq!(
        coordinator.consume_unlock(&approval.token, 7, lock_id),
        Err(CoordinatorError::InvalidUnlockApproval)
    );
}

#[tokio::test]
async fn pre_sleep_authentication_can_never_unlock_the_woken_session() {
    let (mut coordinator, inhibitor) = coordinator(None);
    coordinator
        .arm_sleep_delay()
        .await
        .expect("initial inhibitor");
    locked(&mut coordinator);
    let lock_id = coordinator.snapshot().lock_id.expect("lock ID");
    let attempt = coordinator
        .begin_authentication(lock_id, 7)
        .expect("begin pre-sleep auth");

    coordinator
        .on_sleep_signal(SleepSignal::PrepareForSleep)
        .await;
    assert!(coordinator.snapshot().sleep_hold);
    assert_eq!(
        coordinator.complete_authentication(attempt, lock_id, 7, AuthOutcome::Authenticated,),
        Err(CoordinatorError::StaleAuthentication)
    );
    assert_eq!(
        coordinator.begin_authentication(lock_id, 7),
        Err(CoordinatorError::SleepHold)
    );

    coordinator.on_sleep_signal(SleepSignal::Wake).await;
    assert!(!coordinator.snapshot().sleep_hold);
    assert!(inhibitor.is_held());
    assert_eq!(*inhibitor.acquisitions.lock().expect("acquisitions"), 2);
    assert_eq!(
        coordinator.complete_authentication(attempt, lock_id, 7, AuthOutcome::Authenticated,),
        Err(CoordinatorError::StaleAuthentication)
    );
    assert_eq!(coordinator.snapshot().phase, LockPhaseName::Locked);
    let fresh = coordinator
        .begin_authentication(lock_id, 7)
        .expect("fresh post-wake auth");
    assert_ne!(fresh, attempt);
}

#[test]
fn sleep_hold_host_reconnect_and_lock_replacement_invalidate_approval() {
    let (mut coordinator, _) = coordinator(None);
    locked(&mut coordinator);
    let first_lock = coordinator.snapshot().lock_id.expect("lock ID");
    let attempt = coordinator
        .begin_authentication(first_lock, 7)
        .expect("auth");
    let approval = coordinator
        .complete_authentication(attempt, first_lock, 7, AuthOutcome::Authenticated)
        .expect("approval");

    coordinator.host_disconnected();
    assert_eq!(coordinator.snapshot().phase, LockPhaseName::Locked);
    coordinator.register_host(9);
    assert!(
        coordinator
            .consume_unlock(&approval.token, 7, first_lock)
            .is_err()
    );
    assert!(
        coordinator
            .consume_unlock(&approval.token, 9, first_lock)
            .is_err()
    );

    let second = coordinator
        .begin_authentication(first_lock, 9)
        .expect("fresh auth");
    let second = coordinator
        .complete_authentication(second, first_lock, 9, AuthOutcome::Authenticated)
        .expect("second approval");
    coordinator.request_lock();
    assert!(
        coordinator
            .consume_unlock(&second.token, 9, first_lock)
            .is_err()
    );
    assert_eq!(coordinator.snapshot().phase, LockPhaseName::Engaging);
}

#[test]
fn host_disconnect_and_fault_after_locked_fail_closed() {
    let (mut coordinator, _) = coordinator(None);
    locked(&mut coordinator);
    let lock_id = coordinator.snapshot().lock_id.expect("lock ID");
    let attempt = coordinator.begin_authentication(lock_id, 7).expect("auth");
    coordinator
        .complete_authentication(attempt, lock_id, 7, AuthOutcome::Authenticated)
        .expect("approval");
    coordinator.host_disconnected();
    assert_eq!(coordinator.snapshot().phase, LockPhaseName::Locked);
    assert!(matches!(
        coordinator.phase(),
        LockPhase::Locked {
            pending_unlock: None,
            ..
        }
    ));
    assert_eq!(
        coordinator.begin_authentication(lock_id, 7),
        Err(CoordinatorError::HostDisconnected)
    );
}

#[test]
fn failed_lock_aborts_shell_suspend_and_warns_for_external_suspend() {
    let (mut shell, _) = coordinator(None);
    shell.register_host(1);
    shell.request_suspend();
    let lock_id = shell.snapshot().lock_id.expect("lock ID");
    let actions = shell
        .on_host_lock_failed(lock_id, "finished before locked")
        .expect("failure");
    assert!(matches!(
        actions.as_slice(),
        [CoordinatorAction::AbortSuspend { .. }]
    ));
    assert_eq!(shell.snapshot().phase, LockPhaseName::Unlocked);

    let (mut external, _) = coordinator(None);
    external.register_host(1);
    external.request_lock();
    let lock_id = external.snapshot().lock_id.expect("lock ID");
    let actions = external
        .on_host_lock_failed(lock_id, "finished before locked")
        .expect("failure");
    assert!(actions.is_empty());
}

#[tokio::test]
async fn failed_external_sleep_lock_explicitly_reports_unacknowledged_suspend() {
    let (mut coordinator, _) = coordinator(None);
    coordinator.register_host(1);
    coordinator
        .on_sleep_signal(SleepSignal::PrepareForSleep)
        .await;
    let lock_id = coordinator.snapshot().lock_id.expect("lock ID");
    let actions = coordinator
        .on_host_lock_failed(lock_id, "finished")
        .expect("failure");
    assert!(matches!(
        actions.as_slice(),
        [CoordinatorAction::UnacknowledgedSuspend { .. }]
    ));
    assert_eq!(coordinator.snapshot().phase, LockPhaseName::Unlocked);
}

#[test]
fn no_host_fallback_is_execution_not_a_verified_lock_ack() {
    let argv = vec!["/usr/bin/swaylock".into(), "-f".into()];
    let (mut coordinator, _) = coordinator(Some(argv.clone()));
    let actions = coordinator.request_lock();
    assert!(actions.contains(&CoordinatorAction::SpawnFallback(argv)));
    assert_eq!(coordinator.snapshot().phase, LockPhaseName::FallbackSpawned);
    assert!(matches!(
        coordinator.phase(),
        LockPhase::FallbackSpawned { .. }
    ));
    assert!(coordinator.on_host_lock_acknowledged(1, 1).is_err());
    assert_eq!(coordinator.snapshot().phase, LockPhaseName::FallbackSpawned);
}

#[test]
fn approvals_do_not_survive_a_new_daemon_instance() {
    let (mut first, _) = coordinator(None);
    locked(&mut first);
    let lock_id = first.snapshot().lock_id.expect("lock ID");
    let attempt = first.begin_authentication(lock_id, 7).expect("auth");
    let approval = first
        .complete_authentication(attempt, lock_id, 7, AuthOutcome::Authenticated)
        .expect("approval");

    let (mut restarted, _) = coordinator(None);
    restarted.register_host(7);
    assert_eq!(
        restarted.consume_unlock(&approval.token, 7, lock_id),
        Err(CoordinatorError::InvalidUnlockApproval)
    );
}

#[test]
fn idle_suspend_produces_idle_suspend_action_separate_from_explicit_suspend() {
    let (mut coordinator, inhibitor) = coordinator(None);
    coordinator.register_host(3);
    let actions = coordinator.request_idle_suspend();
    assert!(coordinator.snapshot().sleep_hold);
    let lock_id = coordinator.snapshot().lock_id.expect("lock ID");
    assert!(actions.iter().any(|action| matches!(
        action,
        CoordinatorAction::RequestHostLock { lock_id: id, ui_session_generation: 3 } if *id == lock_id
    )));

    let ack_actions = coordinator
        .on_host_lock_acknowledged(lock_id, 3)
        .expect("valid ACK");
    assert_eq!(coordinator.snapshot().phase, LockPhaseName::Locked);
    assert!(!inhibitor.is_held());
    assert!(ack_actions.contains(&CoordinatorAction::ReleaseSleepDelayInhibitor));
    assert!(ack_actions.contains(&CoordinatorAction::IdleSuspend));
    assert!(!ack_actions.contains(&CoordinatorAction::Suspend));
}

#[tokio::test]
async fn on_suspend_failed_is_generation_guarded_against_newer_prepare_for_sleep() {
    let (mut coordinator, inhibitor) = coordinator(None);
    coordinator
        .arm_sleep_delay()
        .await
        .expect("initial delay lock");
    locked(&mut coordinator);

    // Explicit suspend engages hold generation 1 and releases delay FD.
    let actions = coordinator.request_suspend();
    assert!(actions.contains(&CoordinatorAction::Suspend));
    assert!(coordinator.snapshot().sleep_hold);
    assert!(!inhibitor.is_held());
    let first_gen = coordinator.sleep_hold_generation();

    // Newer external PrepareForSleep advances hold generation.
    coordinator
        .on_sleep_signal(SleepSignal::PrepareForSleep)
        .await;
    let second_gen = coordinator.sleep_hold_generation();
    assert!(second_gen > first_gen);
    assert!(coordinator.snapshot().sleep_hold);

    // Stale failure from generation 1 must NOT clear sleep_hold or re-arm delay.
    let stale_recovery = coordinator
        .on_suspend_failed(first_gen, "stale suspend error")
        .await;
    assert!(stale_recovery.is_empty());
    assert!(coordinator.snapshot().sleep_hold);
    assert!(!inhibitor.is_held());

    // Matching generation failure clears sleep_hold and re-arms delay while staying locked.
    let active_recovery = coordinator
        .on_suspend_failed(second_gen, "current suspend failed")
        .await;
    assert_eq!(
        active_recovery,
        vec![CoordinatorAction::AcquireSleepDelayInhibitor]
    );
    assert!(!coordinator.snapshot().sleep_hold);
    assert_eq!(coordinator.snapshot().phase, LockPhaseName::Locked);
    assert!(inhibitor.is_held());
}

#[tokio::test]
async fn logind_sleep_inhibitor_self_heals_late_session_lock_and_service_restart() {
    use std::io::{BufRead, BufReader};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tokio::time::timeout;
    use zbus::connection::Builder;
    use zbus::object_server::SignalEmitter;
    use zbus::zvariant::{OwnedFd, OwnedObjectPath};

    struct TestBus(Child);
    impl Drop for TestBus {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let mut daemon = Command::new("dbus-daemon")
        .args(["--session", "--nofork", "--nosyslog", "--print-address=1"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("start private dbus-daemon");
    let mut address = String::new();
    BufReader::new(daemon.stdout.take().expect("dbus stdout"))
        .read_line(&mut address)
        .expect("read dbus address");
    let _bus = TestBus(daemon);
    let address = address.trim().to_owned();

    struct MockLogindManager {
        session_ready: Arc<AtomicBool>,
        unready_observed: Arc<tokio::sync::Notify>,
        session_resolved: Arc<tokio::sync::Notify>,
        session_path: String,
    }

    #[zbus::interface(name = "org.freedesktop.login1.Manager")]
    impl MockLogindManager {
        #[zbus(name = "Inhibit")]
        fn inhibit(
            &self,
            _what: &str,
            _who: &str,
            _why: &str,
            _mode: &str,
        ) -> zbus::fdo::Result<OwnedFd> {
            let (reader, _writer) = std::os::unix::net::UnixStream::pair()
                .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?;
            Ok(OwnedFd::from(std::os::fd::OwnedFd::from(reader)))
        }

        #[zbus(name = "GetSessionByPID")]
        fn get_session_by_pid(&self, _pid: u32) -> zbus::fdo::Result<OwnedObjectPath> {
            if !self.session_ready.load(Ordering::SeqCst) {
                self.unready_observed.notify_waiters();
                return Err(zbus::fdo::Error::UnknownObject("session not ready".into()));
            }
            self.session_resolved.notify_waiters();
            Ok(OwnedObjectPath::try_from(self.session_path.as_str()).expect("valid path"))
        }

        #[zbus(signal)]
        async fn prepare_for_sleep(emitter: &SignalEmitter<'_>, start: bool) -> zbus::Result<()>;
    }

    struct MockLogindSession;

    #[zbus::interface(name = "org.freedesktop.login1.Session")]
    impl MockLogindSession {
        #[zbus(signal, name = "Lock")]
        async fn lock(emitter: &SignalEmitter<'_>) -> zbus::Result<()>;
    }

    let session_ready = Arc::new(AtomicBool::new(false));
    let unready_observed = Arc::new(tokio::sync::Notify::new());
    let session_1_resolved = Arc::new(tokio::sync::Notify::new());
    let logind_conn_1 = Builder::address(address.as_str())
        .expect("builder")
        .name("org.freedesktop.login1")
        .expect("name")
        .serve_at(
            "/org/freedesktop/login1",
            MockLogindManager {
                session_ready: Arc::clone(&session_ready),
                unready_observed: Arc::clone(&unready_observed),
                session_resolved: Arc::clone(&session_1_resolved),
                session_path: "/org/freedesktop/login1/session/s1".into(),
            },
        )
        .expect("serve manager")
        .serve_at("/org/freedesktop/login1/session/s1", MockLogindSession)
        .expect("serve session 1")
        .build()
        .await
        .expect("build logind 1");

    let client_conn = Builder::address(address.as_str())
        .expect("client builder")
        .build()
        .await
        .expect("client build");
    let inhibitor = Arc::new(LogindSleepInhibitor::from_connection(client_conn));
    inhibitor.acquire().await.expect("acquire delay inhibitor");
    assert!(inhibitor.is_held());

    let (tx, mut rx) = tokio::sync::mpsc::channel(16);
    let monitor_inhibitor = Arc::clone(&inhibitor);
    let first_unready = unready_observed.notified();
    let healed_session = session_1_resolved.notified();
    let monitor_task = tokio::spawn(async move { monitor_inhibitor.monitor_events(tx).await });

    // Deterministically wait for monitor_events to observe `session_ready == false`, then enable it.
    timeout(Duration::from_secs(2), first_unready)
        .await
        .expect("monitor_events must probe GetSessionByPID on startup");
    session_ready.store(true, Ordering::SeqCst);
    timeout(Duration::from_secs(3), healed_session)
        .await
        .expect("monitor_events must retry GetSessionByPID with backoff");

    // Emit Session.Lock until the newly registered match rule delivers it.
    let session_1_iface = logind_conn_1
        .object_server()
        .interface::<_, MockLogindSession>("/org/freedesktop/login1/session/s1")
        .await
        .expect("session 1 interface");
    let got_lock = timeout(Duration::from_secs(3), async {
        loop {
            MockLogindSession::lock(session_1_iface.signal_emitter())
                .await
                .expect("emit Lock");
            if let Ok(Some(event)) = timeout(Duration::from_millis(80), rx.recv()).await
                && event == LogindEvent::SessionLock
            {
                break;
            }
        }
    })
    .await;
    assert!(
        got_lock.is_ok(),
        "monitor_events must self-heal Session.Lock when session resolves after startup"
    );

    // Simulate systemd-logind restart by releasing org.freedesktop.login1.
    assert!(
        logind_conn_1
            .release_name("org.freedesktop.login1")
            .await
            .expect("release logind name")
    );

    let exit_res = timeout(Duration::from_secs(3), monitor_task)
        .await
        .expect("monitor_events must return promptly when logind loses bus name")
        .expect("join monitor task");
    assert!(
        exit_res.is_err(),
        "monitor_events must report error on logind owner loss so supervisor re-arms inhibitors"
    );
    assert!(
        !inhibitor.is_held(),
        "stale delay inhibitor FD must be cleared when logind owner disappears"
    );

    // Bring up a fresh systemd-logind instance with a new session object path and reconnect.
    let session_2_resolved = Arc::new(tokio::sync::Notify::new());
    let logind_conn_2 = Builder::address(address.as_str())
        .expect("builder 2")
        .name("org.freedesktop.login1")
        .expect("name 2")
        .serve_at(
            "/org/freedesktop/login1",
            MockLogindManager {
                session_ready: Arc::new(AtomicBool::new(true)),
                unready_observed: Arc::new(tokio::sync::Notify::new()),
                session_resolved: Arc::clone(&session_2_resolved),
                session_path: "/org/freedesktop/login1/session/s2".into(),
            },
        )
        .expect("serve manager 2")
        .serve_at("/org/freedesktop/login1/session/s2", MockLogindSession)
        .expect("serve session 2")
        .build()
        .await
        .expect("build logind 2");

    inhibitor
        .reconnect_address(&address)
        .await
        .expect("reconnect logind inhibitor");
    assert!(inhibitor.is_connected());
    inhibitor
        .acquire()
        .await
        .expect("re-acquire delay inhibitor after logind restart");
    assert!(inhibitor.is_held());

    let (tx2, mut rx2) = tokio::sync::mpsc::channel(16);
    let monitor_inhibitor_2 = Arc::clone(&inhibitor);
    let ready_2 = session_2_resolved.notified();
    let monitor_task_2 = tokio::spawn(async move { monitor_inhibitor_2.monitor_events(tx2).await });
    timeout(Duration::from_secs(2), ready_2)
        .await
        .expect("reconnected monitor_events must resolve session 2");

    let manager_2_iface = logind_conn_2
        .object_server()
        .interface::<_, MockLogindManager>("/org/freedesktop/login1")
        .await
        .expect("manager 2 interface");
    MockLogindManager::prepare_for_sleep(manager_2_iface.signal_emitter(), true)
        .await
        .expect("emit PrepareForSleep");
    assert_eq!(
        timeout(Duration::from_secs(2), rx2.recv())
            .await
            .expect("PrepareForSleep timeout"),
        Some(LogindEvent::PrepareForSleep)
    );

    let session_2_iface = logind_conn_2
        .object_server()
        .interface::<_, MockLogindSession>("/org/freedesktop/login1/session/s2")
        .await
        .expect("session 2 interface");
    let got_lock_2 = timeout(Duration::from_secs(2), async {
        loop {
            MockLogindSession::lock(session_2_iface.signal_emitter())
                .await
                .expect("emit Lock on session 2");
            if let Ok(Some(event)) = timeout(Duration::from_millis(80), rx2.recv()).await
                && event == LogindEvent::SessionLock
            {
                break;
            }
        }
    })
    .await;
    assert!(got_lock_2.is_ok(), "Session.Lock on session 2 must arrive");

    drop(rx2);
    monitor_task_2.abort();
}
