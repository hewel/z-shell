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
            rules: vec![rule("lock", IdleAction::Lock, 0)],
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
