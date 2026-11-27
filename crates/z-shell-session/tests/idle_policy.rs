use z_shell_protocol::{InhibitorEntry, InhibitorScope, TopicOwner};
use z_shell_session::idle::{
    ActionCompletion, Caffeine, IdleAction, IdleConfig, IdleEffect, IdlePolicy, IdleRule,
    LockState, MediaPlayback, SleepState,
};

fn rule(name: &str, action: IdleAction, fade: u32) -> IdleRule {
    IdleRule {
        name: name.into(),
        enabled: true,
        timeout_seconds: 60,
        locked_timeout_seconds: None,
        action,
        resume_command: None,
        pre_action_fade_seconds: fade,
    }
}

fn watch(effects: &[IdleEffect], index: usize) -> u64 {
    effects
        .iter()
        .find_map(|effect| match effect {
            IdleEffect::StartWatch {
                rule_index, token, ..
            } if *rule_index == index => Some(*token),
            _ => None,
        })
        .expect("rule watch")
}

#[test]
fn presets_exist_but_every_automatic_action_is_disabled_by_default() {
    let config = IdleConfig::default();
    assert_eq!(config.rules.len(), 3);
    assert!(config.rules.iter().all(|rule| !rule.enabled));
    assert_eq!(config.rules[0].timeout_seconds, 600);
    assert_eq!(config.rules[1].timeout_seconds, 660);
    assert_eq!(config.rules[2].timeout_seconds, 900);
    let mut policy = IdlePolicy::default();
    assert!(policy.configure(config).expect("default config").is_empty());
}

#[test]
fn caffeine_and_mpris_playing_cancel_idle_work_and_restart_on_release() {
    let mut policy = IdlePolicy::default();
    let effects = policy
        .configure(IdleConfig {
            rules: vec![rule("suspend", IdleAction::Suspend, 0)],
        })
        .expect("config");
    let token = watch(&effects, 0);
    let action = policy.idle(0, token);
    let action_id = match action.as_slice() {
        [IdleEffect::RunAction { action_id, .. }] => *action_id,
        other => panic!("unexpected action: {other:?}"),
    };

    let inhibited = policy.set_caffeine(Caffeine::Enabled);
    assert!(policy.snapshot().caffeine);
    assert_eq!(policy.snapshot().caffeine_scope, InhibitorScope::Sleep);
    assert!(
        !inhibited
            .iter()
            .any(|effect| matches!(effect, IdleEffect::ResumeAction { .. }))
    );
    assert!(policy.idle(0, token).is_empty());
    assert!(matches!(
        policy
            .action_completed(action_id, ActionCompletion::Succeeded)
            .as_slice(),
        [IdleEffect::ResumeAction { .. }]
    ));

    let still_inhibited = policy.set_caffeine(Caffeine::Disabled);
    let token = watch(&still_inhibited, 0);
    policy.set_media_playing(MediaPlayback::Playing);
    assert!(policy.idle(0, token).is_empty());
    assert_eq!(policy.snapshot().active_inhibitors.len(), 1);
    let resumed = policy.set_media_playing(MediaPlayback::Idle);
    let token = watch(&resumed, 0);
    assert!(matches!(
        policy.idle(0, token).as_slice(),
        [IdleEffect::RunAction { .. }]
    ));
}

#[test]
fn keep_awake_inhibits_only_sleep_and_preserves_screen_off_and_fading_lock() {
    let mut policy = IdlePolicy::default();
    let effects = policy
        .configure(IdleConfig {
            rules: vec![
                rule("screen-off", IdleAction::ScreenOff, 0),
                rule("lock", IdleAction::Lock, 10),
                rule("suspend", IdleAction::LockAndSuspend, 10),
            ],
        })
        .expect("config");

    let screen_token = watch(&effects, 0);
    let lock_token = watch(&effects, 1);
    let suspend_token = watch(&effects, 2);

    // 1. Apply ScreenOff to completion.
    assert!(!policy.is_screen_off_applied());
    let screen_action_id = match policy.idle(0, screen_token).as_slice() {
        [IdleEffect::RunAction { action_id, .. }] => *action_id,
        other => panic!("expected ScreenOff RunAction, got {other:?}"),
    };
    assert!(
        policy
            .action_completed(screen_action_id, ActionCompletion::Succeeded)
            .is_empty()
    );
    assert!(policy.is_screen_off_applied());

    // 2. Start warning fade on Lock AND LockAndSuspend.
    let lock_fading = policy.idle(1, lock_token);
    let fade_token = match lock_fading.as_slice() {
        [IdleEffect::WarningStarted { token, .. }] => *token,
        other => panic!("expected WarningStarted for lock, got {other:?}"),
    };
    assert!(policy.idle(2, suspend_token).is_empty());

    // 3. Enabling Keep awake must NOT wake ScreenOff (ResumeAction) and must NOT cancel Lock's fade!
    let on_effects = policy.set_caffeine_with_schedule(Caffeine::Enabled, Some(Some(1_800)), 5_000);
    assert!(
        !on_effects
            .iter()
            .any(|e| matches!(e, IdleEffect::ResumeAction { .. })),
        "enabling Keep awake must never wake applied ScreenOff: {on_effects:?}"
    );
    assert!(
        !on_effects
            .iter()
            .any(|e| matches!(e, IdleEffect::WarningCancelled { .. })),
        "shared fade must stay active while Lock rule is still fading: {on_effects:?}"
    );
    assert!(
        !on_effects
            .iter()
            .any(|e| matches!(e, IdleEffect::CancelWatch { rule_index: 1, .. })),
        "Lock rule watch/fade must not be reset: {on_effects:?}"
    );
    assert!(
        on_effects
            .iter()
            .any(|e| matches!(e, IdleEffect::CancelWatch { rule_index: 2, .. })),
        "LockAndSuspend watch should be cancelled when Keep awake enables: {on_effects:?}"
    );

    let snap = policy.snapshot();
    assert!(snap.caffeine);
    assert_eq!(snap.caffeine_scope, InhibitorScope::Sleep);
    assert_eq!(snap.caffeine_duration_seconds, Some(1_800));
    assert_eq!(snap.caffeine_expires_at_ms, Some(5_000 + 1_800 * 1_000));
    assert_eq!(snap.active_inhibitors.len(), 1);
    assert_eq!(snap.active_inhibitors[0].scope, InhibitorScope::Sleep);

    // 4. When fade finishes, ONLY Lock runs (LockAndSuspend was moved out of Fading).
    let after_fade = policy.fade_complete(fade_token);
    assert!(matches!(
        after_fade.as_slice(),
        [IdleEffect::RunAction {
            rule_index: 1,
            action: IdleAction::Lock,
            ..
        }]
    ));

    // 5. Disabling Keep awake still must NOT emit ResumeAction for applied ScreenOff.
    let off_effects = policy.set_caffeine_with_schedule(Caffeine::Disabled, None, 10_000);
    assert!(
        !off_effects
            .iter()
            .any(|e| matches!(e, IdleEffect::ResumeAction { .. })),
        "disabling Keep awake must never wake applied ScreenOff: {off_effects:?}"
    );
    assert_eq!(policy.snapshot().caffeine_duration_seconds, Some(1_800));
    assert_eq!(policy.snapshot().caffeine_expires_at_ms, None);
    assert!(
        off_effects
            .iter()
            .any(|e| matches!(e, IdleEffect::StartWatch { rule_index: 2, .. })),
        "LockAndSuspend watch must restart when Keep awake disables: {off_effects:?}"
    );
}

#[test]
fn plugin_scopes_inhibit_only_their_matching_actions() {
    let owner = TopicOwner::Core;
    let mut policy = IdlePolicy::default();
    policy
        .configure(IdleConfig {
            rules: vec![
                rule("screen", IdleAction::ScreenOff, 0),
                rule("lock", IdleAction::Lock, 0),
                rule("sleep", IdleAction::Suspend, 0),
            ],
        })
        .expect("config");
    let effects = policy.sync_plugin_inhibitors(&[InhibitorEntry {
        cookie: 4,
        scope: InhibitorScope::Lock,
        reason: "meeting".into(),
        owner: owner.clone(),
    }]);
    let watched: Vec<usize> = effects
        .iter()
        .filter_map(|effect| match effect {
            IdleEffect::StartWatch { rule_index, .. } => Some(*rule_index),
            _ => None,
        })
        .collect();
    assert_eq!(watched, [0, 2]);
    assert!(matches!(
        policy.idle(0, watch(&effects, 0)).as_slice(),
        [IdleEffect::RunAction { .. }]
    ));
    assert!(matches!(
        policy.idle(2, watch(&effects, 2)).as_slice(),
        [IdleEffect::RunAction { .. }]
    ));

    let effects = policy.sync_plugin_inhibitors(&[InhibitorEntry {
        cookie: 5,
        scope: InhibitorScope::Sleep,
        reason: "build".into(),
        owner,
    }]);
    let watched: Vec<usize> = effects
        .iter()
        .filter_map(|effect| match effect {
            IdleEffect::StartWatch { rule_index, .. } => Some(*rule_index),
            _ => None,
        })
        .collect();
    assert_eq!(watched, [0, 1]);
    assert!(matches!(
        policy.idle(1, watch(&effects, 1)).as_slice(),
        [IdleEffect::RunAction { .. }]
    ));
}

#[test]
fn activity_cancels_warning_fade_and_rejects_stale_callbacks() {
    let mut policy = IdlePolicy::default();
    let effects = policy
        .configure(IdleConfig {
            rules: vec![rule("lock", IdleAction::Lock, 5)],
        })
        .expect("config");
    let token = watch(&effects, 0);
    let fading = policy.idle(0, token);
    let fade_token = match fading.as_slice() {
        [
            IdleEffect::WarningStarted {
                token,
                fade_seconds: 5,
                ..
            },
        ] => *token,
        other => panic!("unexpected warning effects: {other:?}"),
    };
    assert_eq!(
        policy.snapshot().warning.as_ref().map(|w| w.fade_seconds),
        Some(5)
    );
    let cancelled = policy.activity();
    assert!(cancelled.iter().any(|effect| matches!(
        effect,
        IdleEffect::WarningCancelled { token } if *token == fade_token
    )));
    assert!(policy.snapshot().warning.is_none());
    assert!(policy.fade_complete(fade_token).is_empty());
    assert!(policy.idle(0, token).is_empty());
}

#[test]
fn locked_timeout_and_resume_command_are_applied_once_per_activity_cycle() {
    let mut policy = IdlePolicy::default();
    let mut custom = rule(
        "custom",
        IdleAction::CustomCommand(vec!["/bin/true".into()]),
        0,
    );
    custom.locked_timeout_seconds = Some(10);
    custom.resume_command = Some(vec!["/bin/echo".into(), "resume".into()]);
    let effects = policy
        .configure(IdleConfig {
            rules: vec![custom],
        })
        .expect("config");
    let token = watch(&effects, 0);
    let locked = policy.set_lock_state(LockState::Locked);
    assert!(locked.iter().any(|effect| matches!(
        effect,
        IdleEffect::StartWatch {
            timeout_seconds: 10,
            ..
        }
    )));
    let locked_token = watch(&locked, 0);
    let action_id = match policy.idle(0, locked_token).as_slice() {
        [IdleEffect::RunAction { action_id, .. }] => *action_id,
        other => panic!("unexpected action: {other:?}"),
    };
    policy.action_completed(action_id, ActionCompletion::Succeeded);
    let resumed = policy.activity();
    assert_eq!(
        resumed
            .iter()
            .filter(|effect| matches!(effect, IdleEffect::ResumeAction { .. }))
            .count(),
        1
    );
    assert!(
        policy
            .activity()
            .iter()
            .all(|effect| !matches!(effect, IdleEffect::ResumeAction { .. }))
    );
    assert!(policy.idle(0, token).is_empty());
}

#[test]
fn sleep_defers_successful_resume_until_wake() {
    let mut policy = IdlePolicy::default();
    let effects = policy
        .configure(IdleConfig {
            rules: vec![rule("screen", IdleAction::ScreenOff, 0)],
        })
        .expect("config");
    let token = watch(&effects, 0);
    let action_id = match policy.idle(0, token).as_slice() {
        [IdleEffect::RunAction { action_id, .. }] => *action_id,
        other => panic!("unexpected action: {other:?}"),
    };
    policy.set_sleep_state(SleepState::Sleeping);
    assert!(
        policy
            .action_completed(action_id, ActionCompletion::Succeeded)
            .is_empty()
    );
    let wake = policy.set_sleep_state(SleepState::Awake);
    assert!(!policy.is_screen_off_applied());
    assert!(
        wake.iter()
            .any(|effect| matches!(effect, IdleEffect::ResumeAction { .. }))
    );
}

#[test]
fn invalid_rules_are_rejected_without_partial_reconfiguration() {
    let mut policy = IdlePolicy::default();
    let original = policy.snapshot().rules;
    let mut invalid = rule("custom", IdleAction::CustomCommand(Vec::new()), 0);
    invalid.timeout_seconds = 0;
    assert!(
        policy
            .configure(IdleConfig {
                rules: vec![invalid]
            })
            .is_err()
    );
    assert_eq!(policy.snapshot().rules, original);
}

#[test]
fn is_sleep_blocked_is_restricted_to_caffeine_and_explicit_sleep_plugin_leases() {
    let mut policy = IdlePolicy::default();
    assert!(!policy.is_sleep_blocked());

    // Media playback and Idle-scoped plugin inhibitors must NOT trigger OS sleep:block.
    policy.set_media_playing(MediaPlayback::Playing);
    assert!(!policy.is_sleep_blocked());

    policy.sync_plugin_inhibitors(&[InhibitorEntry {
        cookie: 1,
        scope: InhibitorScope::Idle,
        reason: "presentation".into(),
        owner: TopicOwner::Core,
    }]);
    assert!(!policy.is_sleep_blocked());

    policy.sync_plugin_inhibitors(&[InhibitorEntry {
        cookie: 2,
        scope: InhibitorScope::Lock,
        reason: "meeting".into(),
        owner: TopicOwner::Core,
    }]);
    assert!(!policy.is_sleep_blocked());

    // Explicit Sleep-scoped plugin lease triggers sleep block.
    policy.sync_plugin_inhibitors(&[InhibitorEntry {
        cookie: 3,
        scope: InhibitorScope::Sleep,
        reason: "compile".into(),
        owner: TopicOwner::Core,
    }]);
    assert!(policy.is_sleep_blocked());
    assert_eq!(policy.sleep_block_reason().as_deref(), Some("compile"));

    policy.sync_plugin_inhibitors(&[]);
    assert!(!policy.is_sleep_blocked());

    // Keep awake triggers sleep block independently of plugin leases.
    policy.set_caffeine(Caffeine::Enabled);
    assert!(policy.is_sleep_blocked());
    assert_eq!(
        policy.sleep_block_reason().as_deref(),
        Some("Keep awake is active")
    );
    policy.set_caffeine(Caffeine::Disabled);
    assert!(!policy.is_sleep_blocked());
}

#[test]
fn reconcile_lagged_screen_off_recovers_running_actions_and_prunes_cancelled_entries() {
    let mut policy = IdlePolicy::default();
    let effects = policy
        .configure(IdleConfig {
            rules: vec![rule("screen-off", IdleAction::ScreenOff, 0)],
        })
        .expect("valid screen-off rule");
    let token = match &effects[0] {
        IdleEffect::StartWatch { token, .. } => *token,
        other => panic!("expected StartWatch, got {other:?}"),
    };

    // 1. Uncancelled Running(action_id) is surfaced so lagged receiver can drive Off + complete.
    let idle_effects = policy.idle(0, token);
    let action_id = match &idle_effects[0] {
        IdleEffect::RunAction {
            action_id,
            action: IdleAction::ScreenOff,
            ..
        } => *action_id,
        other => panic!("expected RunAction(ScreenOff), got {other:?}"),
    };
    assert_eq!(
        policy.reconcile_lagged_screen_off(),
        (vec![action_id], false)
    );
    assert!(
        policy
            .action_completed(action_id, ActionCompletion::Succeeded)
            .is_empty()
    );
    assert_eq!(policy.reconcile_lagged_screen_off(), (Vec::new(), true));

    // Resume clears Applied and rearms a new watch.
    let resume_effects = policy.activity();
    assert!(resume_effects.iter().any(|effect| matches!(
        effect,
        IdleEffect::ResumeAction {
            action: IdleAction::ScreenOff,
            ..
        }
    )));
    let next_token = resume_effects
        .iter()
        .find_map(|effect| match effect {
            IdleEffect::StartWatch { token, .. } => Some(*token),
            _ => None,
        })
        .expect("rearmed watch");

    // 2. Cancelled Running(action_id) (activity before lag reconciliation) is pruned cleanly.
    let second_run = policy.idle(0, next_token);
    let cancelled_id = match &second_run[0] {
        IdleEffect::RunAction { action_id, .. } => *action_id,
        other => panic!("expected RunAction, got {other:?}"),
    };
    let _ = policy.activity();
    assert_eq!(policy.reconcile_lagged_screen_off(), (Vec::new(), false));
    // Even if a queued RunAction(cancelled_id) completes afterward, it immediately emits ResumeAction.
    let late_effects = policy.action_completed(cancelled_id, ActionCompletion::Succeeded);
    assert_eq!(
        late_effects,
        vec![IdleEffect::ResumeAction {
            rule_name: "screen-off".into(),
            action: IdleAction::ScreenOff,
            resume_command: None,
        }]
    );
}
