use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use z_shell_session::coordinator::{
    Coordinator, CoordinatorAction, CoordinatorError, LockPhase, LockPhaseName, SleepInhibitor,
    SleepInhibitorError, SleepSignal,
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
