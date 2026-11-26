//! Configurable idle rules and inhibition policy without clocks or platform I/O.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use z_shell_config::{IdleRuleAction, IdleSettings};
use z_shell_protocol::{InhibitorEntry, InhibitorScope};

const MAX_RULES: usize = 64;
const MAX_TIMEOUT_SECONDS: u32 = 86_400;
const MAX_FADE_SECONDS: u32 = 60;
/// Default remembered duration preset for manual Keep awake (`1h`).
pub const DEFAULT_CAFFEINE_DURATION_SECONDS: u32 = 3_600;

/// Action executed after one idle timeout and optional warning fade.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdleAction {
    /// Request a host-verified compositor lock.
    Lock,
    /// Turn outputs off through the desktop output-power integration.
    ScreenOff,
    /// Request system suspend without an additional lock request.
    Suspend,
    /// Lock, wait for host ACK, and then suspend.
    LockAndSuspend,
    /// Execute an exact argv without shell interpolation.
    CustomCommand(Vec<String>),
}

impl IdleAction {
    fn includes_lock(&self) -> bool {
        matches!(self, Self::Lock | Self::LockAndSuspend)
    }

    fn includes_sleep(&self) -> bool {
        matches!(self, Self::Suspend | Self::LockAndSuspend)
    }
}

/// One named idle behavior; no rule is enabled unless explicitly configured.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct IdleRule {
    /// Unique human-readable rule name.
    pub name: String,
    /// Whether this rule can acquire an idle notification.
    pub enabled: bool,
    /// Inactivity timeout while unlocked.
    pub timeout_seconds: u32,
    /// Optional alternate inactivity timeout while locked.
    pub locked_timeout_seconds: Option<u32>,
    /// Action run after timeout and warning.
    pub action: IdleAction,
    /// Optional exact argv run when activity resumes this action.
    pub resume_command: Option<Vec<String>>,
    /// Warning fade duration before running the action.
    pub pre_action_fade_seconds: u32,
}

impl Default for IdleRule {
    fn default() -> Self {
        Self {
            name: String::new(),
            enabled: false,
            timeout_seconds: 0,
            locked_timeout_seconds: None,
            action: IdleAction::Lock,
            resume_command: None,
            pre_action_fade_seconds: 0,
        }
    }
}

/// Complete idle policy configuration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct IdleConfig {
    /// Named rules evaluated independently.
    pub rules: Vec<IdleRule>,
}

impl Default for IdleConfig {
    fn default() -> Self {
        let preset = |name: &str, timeout_seconds, action| IdleRule {
            name: name.into(),
            timeout_seconds,
            action,
            ..IdleRule::default()
        };
        Self {
            rules: vec![
                preset("lock", 600, IdleAction::Lock),
                preset("screen-off", 660, IdleAction::ScreenOff),
                preset("lock-and-suspend", 900, IdleAction::LockAndSuspend),
            ],
        }
    }
}

impl IdleConfig {
    /// Builds an [`IdleConfig`] from declarative `settings.toml` [`IdleSettings`].
    ///
    /// When `settings.rules` is empty, the built-in disabled presets are used with
    /// `settings.pre_action_fade_seconds` applied as their warning fade duration.
    #[must_use]
    pub fn from_settings(settings: &IdleSettings) -> Self {
        if settings.rules.is_empty() {
            let mut config = Self::default();
            for rule in &mut config.rules {
                rule.pre_action_fade_seconds = settings.pre_action_fade_seconds;
            }
            return config;
        }
        let rules = settings
            .rules
            .iter()
            .map(|rule| IdleRule {
                name: rule.name.clone(),
                enabled: rule.enabled,
                timeout_seconds: rule.timeout_seconds,
                locked_timeout_seconds: rule.locked_timeout_seconds,
                action: match &rule.action {
                    IdleRuleAction::Lock => IdleAction::Lock,
                    IdleRuleAction::ScreenOff => IdleAction::ScreenOff,
                    IdleRuleAction::Suspend => IdleAction::Suspend,
                    IdleRuleAction::LockAndSuspend => IdleAction::LockAndSuspend,
                    IdleRuleAction::CustomCommand(argv) => IdleAction::CustomCommand(argv.clone()),
                    _ => IdleAction::Lock,
                },
                resume_command: rule.resume_command.clone(),
                pre_action_fade_seconds: rule
                    .pre_action_fade_seconds
                    .unwrap_or(settings.pre_action_fade_seconds),
            })
            .collect();
        Self { rules }
    }

    /// Validates all rules atomically before any live policy is changed.
    ///
    /// # Errors
    ///
    /// Returns a diagnostic for unsafe timeouts, duplicate names, or incomplete argv rules.
    pub fn validate(&self) -> Result<(), IdleConfigError> {
        if self.rules.len() > MAX_RULES {
            return Err(IdleConfigError::new("at most 64 idle rules are allowed"));
        }
        let mut names = BTreeSet::new();
        for rule in &self.rules {
            let name = rule.name.trim();
            if name.is_empty() || rule.name.len() > 128 || rule.name.chars().any(char::is_control) {
                return Err(IdleConfigError::new(
                    "each rule needs a non-empty name of at most 128 bytes without controls",
                ));
            }
            if name != rule.name {
                return Err(IdleConfigError::new(
                    "rule names cannot have surrounding whitespace",
                ));
            }
            if !names.insert(rule.name.as_str()) {
                return Err(IdleConfigError::new(format!(
                    "duplicate idle rule name {:?}",
                    rule.name
                )));
            }
            if rule.timeout_seconds > MAX_TIMEOUT_SECONDS
                || rule
                    .locked_timeout_seconds
                    .is_some_and(|timeout| timeout == 0 || timeout > MAX_TIMEOUT_SECONDS)
            {
                return Err(IdleConfigError::new(format!(
                    "timeouts for {:?} must be within 1..=86400 seconds",
                    rule.name
                )));
            }
            if rule.enabled && rule.timeout_seconds == 0 {
                return Err(IdleConfigError::new(format!(
                    "enabled rule {:?} needs a non-zero timeout",
                    rule.name
                )));
            }
            if rule.pre_action_fade_seconds > MAX_FADE_SECONDS {
                return Err(IdleConfigError::new(format!(
                    "warning fade for {:?} cannot exceed 60 seconds",
                    rule.name
                )));
            }
            if matches!(&rule.action, IdleAction::CustomCommand(argv) if !valid_argv(argv)) {
                return Err(IdleConfigError::new(format!(
                    "custom action {:?} needs a non-empty argv and executable",
                    rule.name
                )));
            }
            if rule
                .resume_command
                .as_deref()
                .is_some_and(|argv| !valid_argv(argv))
            {
                return Err(IdleConfigError::new(format!(
                    "resume command for {:?} needs a non-empty argv and executable",
                    rule.name
                )));
            }
        }
        Ok(())
    }
}

fn valid_argv(argv: &[String]) -> bool {
    argv.first()
        .is_some_and(|program| !program.trim().is_empty())
}

/// Invalid idle configuration rejected without partial application.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct IdleConfigError {
    message: String,
}

impl IdleConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Temporary non-persisted Keep awake (Caffeine) state (sleep-only inhibit).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caffeine {
    /// Inhibit automatic sleep actions while permitting screen-off and lock rules.
    Enabled,
    /// Allow configured idle actions.
    Disabled,
}

/// MPRIS playback state used as an idle inhibitor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaPlayback {
    /// At least one media player is playing.
    Playing,
    /// No media player is playing.
    Idle,
}

/// Session lock state selecting normal or locked idle timeouts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockState {
    /// Use normal idle timeouts.
    Unlocked,
    /// Use each rule's optional locked timeout.
    Locked,
}

/// System sleep state used to defer resume actions until wake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SleepState {
    /// Idle watches can run normally.
    Awake,
    /// Idle watches are suspended and resume commands are deferred.
    Sleeping,
}

/// Attribution for one active idle inhibitor.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum InhibitorSource {
    /// Temporary Caffeine toggle.
    Caffeine,
    /// Active MPRIS playback.
    MediaPlayback,
    /// One `org.freedesktop.ScreenSaver` connection cookie.
    ScreenSaver {
        /// D-Bus unique connection name.
        connection: String,
        /// Connection-scoped cookie.
        cookie: u32,
    },
    /// One bus plugin inhibitor cookie.
    BusPlugin {
        /// Hub-issued inhibitor cookie.
        cookie: u64,
    },
}

/// Public active inhibitor shown on `session.idle`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct IdleInhibitor {
    /// Source and connection/cookie attribution.
    pub source: InhibitorSource,
    /// Policy scope deferred by this inhibitor.
    pub scope: InhibitorScope,
    /// Human-readable reason.
    pub reason: String,
}

/// Current warning fade shown on `session.idle`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct WarningFade {
    /// Token required by the matching fade completion callback.
    pub token: u64,
    /// Configured warning duration.
    pub fade_seconds: u32,
    /// Rules waiting for this warning to finish.
    pub rules: Vec<String>,
}

/// Availability of idle integration backends.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum IdleServiceStatus {
    /// Idle policy is available.
    #[default]
    Running,
    /// One or more native backends are unavailable.
    Unavailable {
        /// Non-secret diagnostic.
        reason: String,
    },
    /// Idle integration has shut down.
    Stopped,
}

/// Non-secret idle topic snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct IdleSnapshot {
    /// Whether temporary Keep awake is enabled.
    pub caffeine: bool,
    /// Policy scope inhibited by Keep awake (fixed to sleep-only).
    pub caffeine_scope: InhibitorScope,
    /// Remembered Keep awake duration preset in seconds (`None` = indefinite).
    pub caffeine_duration_seconds: Option<u32>,
    /// Unix epoch timestamp in milliseconds when timed Keep awake expires (`None` if disabled/indefinite).
    pub caffeine_expires_at_ms: Option<u64>,
    /// Whether MPRIS currently inhibits idle.
    pub media_playing: bool,
    /// All active Caffeine, media, ScreenSaver, and plugin inhibitors.
    pub active_inhibitors: Vec<IdleInhibitor>,
    /// Current pre-action warning fade, if any.
    pub warning: Option<WarningFade>,
    /// Complete non-secret configured rule set.
    pub rules: Vec<IdleRule>,
    /// Native idle integration status.
    pub service_status: IdleServiceStatus,
}

/// Timer and action effects emitted by the pure idle policy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "effect", rename_all = "snake_case")]
pub enum IdleEffect {
    /// Acquire one Wayland idle notification for a rule.
    StartWatch {
        /// Stable rule index until the next configuration.
        rule_index: usize,
        /// Callback token rejecting stale notifications.
        token: u64,
        /// Notification timeout in seconds.
        timeout_seconds: u32,
    },
    /// Destroy a replaced or inhibited idle notification.
    CancelWatch {
        /// Rule index whose watch is cancelled.
        rule_index: usize,
        /// Watch token being cancelled.
        token: u64,
    },
    /// Start the user-visible warning fade.
    WarningStarted {
        /// Fade completion token.
        token: u64,
        /// Warning duration in seconds.
        fade_seconds: u32,
        /// Rules sharing this warning.
        rules: Vec<String>,
    },
    /// Cancel warning because activity, inhibition, sleep, or reload intervened.
    WarningCancelled {
        /// Invalidated fade token.
        token: u64,
    },
    /// Execute an idle action and later report its completion.
    RunAction {
        /// Unique action completion identifier.
        action_id: u64,
        /// Rule index that triggered this action.
        rule_index: usize,
        /// Action to execute.
        action: IdleAction,
        /// Optional resume argv associated with this action.
        resume_command: Option<Vec<String>>,
    },
    /// Restore outputs or run a resume argv after activity or inhibition.
    ResumeAction {
        /// Name of the rule being resumed.
        rule_name: String,
        /// Action being undone.
        action: IdleAction,
        /// Optional exact resume argv.
        resume_command: Option<Vec<String>>,
    },
}

/// Completion of an asynchronous idle action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionCompletion {
    /// Action completed successfully and can later be resumed.
    Succeeded,
    /// Action failed; do not retry until a fresh activity cycle.
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RulePhase {
    Waiting,
    Fading,
    Running(u64),
    Applied,
    Failed,
}

#[derive(Debug)]
struct RuleState {
    watch: u64,
    phase: RulePhase,
}

#[derive(Debug)]
struct PendingAction {
    id: u64,
    rule_name: String,
    action: IdleAction,
    resume_command: Option<Vec<String>>,
    cancelled: bool,
}

/// Idle state machine with tokenized callbacks and explicit inhibition sources.
#[derive(Debug)]
pub struct IdlePolicy {
    config: IdleConfig,
    states: Vec<RuleState>,
    pending: Vec<PendingAction>,
    deferred_resume: Vec<PendingAction>,
    serial: u64,
    fade: Option<u64>,
    caffeine: Caffeine,
    caffeine_duration_seconds: Option<u32>,
    caffeine_expires_at_ms: Option<u64>,
    media: MediaPlayback,
    lock: LockState,
    sleep: SleepState,
    screensaver_inhibitors: Vec<IdleInhibitor>,
    plugin_inhibitors: Vec<IdleInhibitor>,
    service_status: IdleServiceStatus,
}

impl Default for IdlePolicy {
    fn default() -> Self {
        let config = IdleConfig::default();
        let states = config
            .rules
            .iter()
            .map(|_| RuleState {
                watch: 0,
                phase: RulePhase::Waiting,
            })
            .collect();
        Self {
            config,
            states,
            pending: Vec::new(),
            deferred_resume: Vec::new(),
            serial: 0,
            fade: None,
            caffeine: Caffeine::Disabled,
            caffeine_duration_seconds: Some(DEFAULT_CAFFEINE_DURATION_SECONDS),
            caffeine_expires_at_ms: None,
            media: MediaPlayback::Idle,
            lock: LockState::Unlocked,
            sleep: SleepState::Awake,
            screensaver_inhibitors: Vec::new(),
            plugin_inhibitors: Vec::new(),
            service_status: IdleServiceStatus::Running,
        }
    }
}

impl IdlePolicy {
    /// Returns currently active `(rule_index, token, timeout_seconds)` watches that a newly
    /// connected Wayland `ext-idle-notify-v1` driver should arm immediately.
    #[must_use]
    pub fn active_watches(&self) -> Vec<(usize, u64, u32)> {
        self.states
            .iter()
            .enumerate()
            .filter_map(|(index, state)| {
                if state.watch == 0 || self.rule_inhibited(index) {
                    return None;
                }
                let rule = &self.config.rules[index];
                let timeout_seconds = if self.lock == LockState::Locked {
                    rule.locked_timeout_seconds.unwrap_or(rule.timeout_seconds)
                } else {
                    rule.timeout_seconds
                };
                if rule.enabled && timeout_seconds > 0 {
                    Some((index, state.watch, timeout_seconds))
                } else {
                    None
                }
            })
            .collect()
    }

    /// Atomically replaces all rules and invalidates earlier watches and fade callbacks.
    ///
    /// # Errors
    ///
    /// Returns validation errors without changing the current policy.
    pub fn configure(&mut self, config: IdleConfig) -> Result<Vec<IdleEffect>, IdleConfigError> {
        config.validate()?;
        let mut effects = self.reset_all();
        self.config = config;
        self.states = self
            .config
            .rules
            .iter()
            .map(|_| RuleState {
                watch: 0,
                phase: RulePhase::Waiting,
            })
            .collect();
        for index in 0..self.states.len() {
            self.rearm(index, &mut effects);
        }
        Ok(effects)
    }

    /// Changes the non-persisted Keep awake toggle using the remembered duration preset.
    ///
    /// Performs targeted rule-only reconciliation so non-sleep rules (such as applied
    /// `ScreenOff` or pending/fading `Lock`) are never reset, woken, or postponed.
    pub fn set_caffeine(&mut self, caffeine: Caffeine) -> Vec<IdleEffect> {
        self.set_caffeine_with_schedule(caffeine, None, current_epoch_ms())
    }

    /// Updates Keep awake state and optional remembered duration preset (`Some(None)` = indefinite,
    /// `None` = keep remembered preset) with deterministic `now_ms`, using targeted rule-only
    /// reconciliation.
    pub fn set_caffeine_with_schedule(
        &mut self,
        caffeine: Caffeine,
        duration_seconds: Option<Option<u32>>,
        now_ms: u64,
    ) -> Vec<IdleEffect> {
        if let Some(duration) = duration_seconds {
            self.caffeine_duration_seconds = duration;
        }
        self.caffeine_expires_at_ms = match caffeine {
            Caffeine::Enabled => self
                .caffeine_duration_seconds
                .map(|secs| now_ms.saturating_add(u64::from(secs) * 1_000)),
            Caffeine::Disabled => None,
        };
        if self.caffeine == caffeine {
            return Vec::new();
        }
        let prev_inhibited: Vec<bool> = (0..self.states.len())
            .map(|i| self.rule_inhibited(i))
            .collect();
        self.caffeine = caffeine;
        let mut effects = Vec::new();
        for (index, was_inhibited) in prev_inhibited.into_iter().enumerate() {
            if self.rule_inhibited(index) != was_inhibited {
                self.reset_rule(index, &mut effects);
                self.rearm(index, &mut effects);
            }
        }
        if let Some(token) = self.fade
            && !self
                .states
                .iter()
                .any(|state| state.phase == RulePhase::Fading)
        {
            self.fade = None;
            effects.insert(0, IdleEffect::WarningCancelled { token });
        }
        effects
    }

    /// Updates MPRIS playback inhibition.
    pub fn set_media_playing(&mut self, media: MediaPlayback) -> Vec<IdleEffect> {
        if self.media == media {
            return Vec::new();
        }
        self.media = media;
        self.reset_all()
    }

    /// Replaces the current ScreenSaver connection-cookie inhibitors.
    pub fn sync_screensaver_inhibitors(
        &mut self,
        inhibitors: Vec<IdleInhibitor>,
    ) -> Vec<IdleEffect> {
        if self.screensaver_inhibitors == inhibitors {
            return Vec::new();
        }
        self.screensaver_inhibitors = inhibitors;
        self.reset_all()
    }

    /// Synchronizes connection-scoped inhibitors from the bus hub.
    pub fn sync_plugin_inhibitors(&mut self, entries: &[InhibitorEntry]) -> Vec<IdleEffect> {
        let inhibitors = entries
            .iter()
            .map(|entry| IdleInhibitor {
                source: InhibitorSource::BusPlugin {
                    cookie: entry.cookie,
                },
                scope: entry.scope,
                reason: entry.reason.clone(),
            })
            .collect::<Vec<_>>();
        if self.plugin_inhibitors == inhibitors {
            return Vec::new();
        }
        self.plugin_inhibitors = inhibitors;
        self.reset_all()
    }

    /// Selects normal or locked idle timeouts.
    pub fn set_lock_state(&mut self, lock: LockState) -> Vec<IdleEffect> {
        if self.lock == lock {
            return Vec::new();
        }
        self.lock = lock;
        if lock == LockState::Unlocked {
            return self.reset_all();
        }
        let mut effects = Vec::new();
        for index in 0..self.states.len() {
            if self.states[index].phase == RulePhase::Waiting {
                self.rearm(index, &mut effects);
            }
        }
        effects
    }

    /// Suspends idle watches during sleep and resumes completed actions after wake.
    pub fn set_sleep_state(&mut self, sleep: SleepState) -> Vec<IdleEffect> {
        if self.sleep == sleep {
            return Vec::new();
        }
        self.sleep = sleep;
        if sleep == SleepState::Awake {
            let mut effects = self.reset_all();
            for pending in self.deferred_resume.drain(..) {
                effects.push(resume_effect(&pending));
            }
            return effects;
        }
        let mut effects = self.cancel_fade();
        for index in 0..self.states.len() {
            if self.states[index].phase != RulePhase::Applied {
                self.reset_rule(index, &mut effects);
            }
            self.unwatch(index, &mut effects);
        }
        effects
    }

    /// Records native idle backend availability for the public topic.
    pub fn set_service_status(&mut self, status: IdleServiceStatus) {
        self.service_status = status;
    }

    /// Handles an `idled` event only if its watch token is still current.
    pub fn idle(&mut self, rule_index: usize, token: u64) -> Vec<IdleEffect> {
        let Some(state) = self.states.get(rule_index) else {
            return Vec::new();
        };
        if state.watch != token
            || state.phase != RulePhase::Waiting
            || !self.config.rules[rule_index].enabled
            || self.rule_inhibited(rule_index)
        {
            return Vec::new();
        }
        let fade_seconds = self.config.rules[rule_index].pre_action_fade_seconds;
        if fade_seconds == 0 {
            let mut effects = Vec::new();
            self.run(rule_index, &mut effects);
            return effects;
        }
        self.states[rule_index].phase = RulePhase::Fading;
        if self.fade.is_some() {
            return Vec::new();
        }
        let token = self.token();
        self.fade = Some(token);
        vec![IdleEffect::WarningStarted {
            token,
            fade_seconds,
            rules: self.fading_rule_names(),
        }]
    }

    /// Handles `resumed` by cancelling warnings, pending actions, and stale watches.
    pub fn activity(&mut self) -> Vec<IdleEffect> {
        self.reset_all()
    }

    /// Runs fading actions only for the current, uncancelled warning token.
    pub fn fade_complete(&mut self, token: u64) -> Vec<IdleEffect> {
        if self.fade != Some(token) || self.sleep == SleepState::Sleeping {
            return Vec::new();
        }
        self.fade = None;
        let mut effects = Vec::new();
        for index in 0..self.states.len() {
            if self.states[index].phase != RulePhase::Fading {
                continue;
            }
            if self.rule_inhibited(index) {
                self.states[index].phase = RulePhase::Waiting;
                self.rearm(index, &mut effects);
            } else {
                self.run(index, &mut effects);
            }
        }
        effects
    }

    /// Marks a running action complete, resuming cancelled work at the safe boundary.
    pub fn action_completed(
        &mut self,
        action_id: u64,
        completion: ActionCompletion,
    ) -> Vec<IdleEffect> {
        let Some(index) = self
            .pending
            .iter()
            .position(|action| action.id == action_id)
        else {
            return Vec::new();
        };
        let pending = self.pending.remove(index);
        if pending.cancelled {
            if completion == ActionCompletion::Failed {
                return Vec::new();
            }
            if self.sleep == SleepState::Sleeping {
                self.deferred_resume.push(pending);
                return Vec::new();
            }
            return vec![resume_effect(&pending)];
        }
        if let Some(state) = self
            .states
            .iter_mut()
            .find(|state| matches!(state.phase, RulePhase::Running(id) if id == action_id))
        {
            state.phase = if completion == ActionCompletion::Succeeded {
                RulePhase::Applied
            } else {
                RulePhase::Failed
            };
        }
        Vec::new()
    }

    /// Returns the complete non-secret `session.idle` state.
    #[must_use]
    pub fn snapshot(&self) -> IdleSnapshot {
        let mut active_inhibitors = Vec::new();
        if self.caffeine == Caffeine::Enabled {
            active_inhibitors.push(IdleInhibitor {
                source: InhibitorSource::Caffeine,
                scope: InhibitorScope::Sleep,
                reason: "Keep awake is enabled".into(),
            });
        }
        if self.media == MediaPlayback::Playing {
            active_inhibitors.push(IdleInhibitor {
                source: InhibitorSource::MediaPlayback,
                scope: InhibitorScope::Idle,
                reason: "Media is playing".into(),
            });
        }
        active_inhibitors.extend(self.screensaver_inhibitors.iter().cloned());
        active_inhibitors.extend(self.plugin_inhibitors.iter().cloned());
        IdleSnapshot {
            caffeine: self.caffeine == Caffeine::Enabled,
            caffeine_scope: InhibitorScope::Sleep,
            caffeine_duration_seconds: self.caffeine_duration_seconds,
            caffeine_expires_at_ms: self.caffeine_expires_at_ms,
            media_playing: self.media == MediaPlayback::Playing,
            active_inhibitors,
            warning: self.fade.map(|token| WarningFade {
                token,
                fade_seconds: self
                    .config
                    .rules
                    .iter()
                    .zip(&self.states)
                    .find_map(|(rule, state)| {
                        (state.phase == RulePhase::Fading).then_some(rule.pre_action_fade_seconds)
                    })
                    .unwrap_or(0),
                rules: self.fading_rule_names(),
            }),
            rules: self.config.rules.clone(),
            service_status: self.service_status.clone(),
        }
    }

    fn reset_all(&mut self) -> Vec<IdleEffect> {
        let mut effects = self.cancel_fade();
        for index in 0..self.states.len() {
            self.reset_rule(index, &mut effects);
            self.rearm(index, &mut effects);
        }
        effects
    }

    fn reset_rule(&mut self, index: usize, effects: &mut Vec<IdleEffect>) {
        match self.states[index].phase {
            RulePhase::Applied => {
                let rule = &self.config.rules[index];
                effects.push(IdleEffect::ResumeAction {
                    rule_name: rule.name.clone(),
                    action: rule.action.clone(),
                    resume_command: rule.resume_command.clone(),
                });
            }
            RulePhase::Running(id) => {
                if let Some(pending) = self.pending.iter_mut().find(|action| action.id == id) {
                    pending.cancelled = true;
                }
            }
            RulePhase::Waiting | RulePhase::Fading | RulePhase::Failed => {}
        }
        self.states[index].phase = RulePhase::Waiting;
    }

    fn rearm(&mut self, index: usize, effects: &mut Vec<IdleEffect>) {
        self.unwatch(index, effects);
        let token = self.token();
        self.states[index].watch = token;
        let rule = &self.config.rules[index];
        let timeout_seconds = if self.lock == LockState::Locked {
            rule.locked_timeout_seconds.unwrap_or(rule.timeout_seconds)
        } else {
            rule.timeout_seconds
        };
        if rule.enabled && timeout_seconds > 0 && !self.rule_inhibited(index) {
            effects.push(IdleEffect::StartWatch {
                rule_index: index,
                token,
                timeout_seconds,
            });
        }
    }

    fn unwatch(&mut self, index: usize, effects: &mut Vec<IdleEffect>) {
        let token = self.states[index].watch;
        if token != 0 {
            effects.push(IdleEffect::CancelWatch {
                rule_index: index,
                token,
            });
        }
        self.states[index].watch = 0;
    }

    fn run(&mut self, index: usize, effects: &mut Vec<IdleEffect>) {
        let id = self.token();
        let rule = &self.config.rules[index];
        let pending = PendingAction {
            id,
            rule_name: rule.name.clone(),
            action: rule.action.clone(),
            resume_command: rule.resume_command.clone(),
            cancelled: false,
        };
        effects.push(IdleEffect::RunAction {
            action_id: id,
            rule_index: index,
            action: pending.action.clone(),
            resume_command: pending.resume_command.clone(),
        });
        self.states[index].phase = RulePhase::Running(id);
        self.pending.push(pending);
    }

    fn cancel_fade(&mut self) -> Vec<IdleEffect> {
        let effects = self
            .fade
            .take()
            .map(|token| vec![IdleEffect::WarningCancelled { token }])
            .unwrap_or_default();
        for state in &mut self.states {
            if state.phase == RulePhase::Fading {
                state.phase = RulePhase::Waiting;
            }
        }
        effects
    }

    fn fading_rule_names(&self) -> Vec<String> {
        self.config
            .rules
            .iter()
            .zip(&self.states)
            .filter(|(_, state)| state.phase == RulePhase::Fading)
            .map(|(rule, _)| rule.name.clone())
            .collect()
    }

    fn rule_inhibited(&self, index: usize) -> bool {
        if self.sleep == SleepState::Sleeping || self.media == MediaPlayback::Playing {
            return true;
        }
        let action = &self.config.rules[index].action;
        if self.caffeine == Caffeine::Enabled && action.includes_sleep() {
            return true;
        }
        self.screensaver_inhibitors
            .iter()
            .chain(&self.plugin_inhibitors)
            .any(|inhibitor| match inhibitor.scope {
                InhibitorScope::Idle => true,
                InhibitorScope::Sleep => action.includes_sleep(),
                InhibitorScope::Lock => action.includes_lock(),
                _ => false,
            })
    }

    fn token(&mut self) -> u64 {
        self.serial = self
            .serial
            .checked_add(1)
            .expect("idle token space exhausted");
        self.serial
    }
}

/// Returns current wall-clock Unix epoch milliseconds.
#[must_use]
pub fn current_epoch_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

fn resume_effect(pending: &PendingAction) -> IdleEffect {
    IdleEffect::ResumeAction {
        rule_name: pending.rule_name.clone(),
        action: pending.action.clone(),
        resume_command: pending.resume_command.clone(),
    }
}
