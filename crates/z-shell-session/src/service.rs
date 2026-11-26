//! Session topics, privileged host commands, and runtime effect dispatch.

use crate::coordinator::{
    Coordinator, CoordinatorAction, CoordinatorError, LockPhaseName, LockSnapshot, SleepInhibitor,
    SleepInhibitorError, SleepSignal,
};
use crate::idle::{
    ActionCompletion, Caffeine, IdleConfig, IdleEffect, IdleInhibitor, IdlePolicy,
    IdleServiceStatus, IdleSnapshot, LockState, MediaPlayback, SleepBlockStatus, SleepState,
    current_epoch_ms,
};
use crate::pam::{Authenticator, Credentials};
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use std::fmt;
use std::pin::Pin;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use z_shell_bus::{BusHub, CommandCall, CommandHandler, UpdateKind};
use z_shell_config::IdleSettings;
use z_shell_protocol::{
    ClientMessage, ClientRole, CommandInvokeResult, CommandName, ErrorCode, InhibitorEntry,
    PROTOCOL_VERSION, RequestId, RpcError, ServerMessage, TopicName, TopicSubscribeParams,
    decode_server_line, methods,
};
use zeroize::Zeroizing;

/// Non-secret lock state topic.
pub const LOCK_TOPIC: &str = "session.lock";
/// Idle rules, inhibitors, Caffeine, and warning state topic.
pub const IDLE_TOPIC: &str = "session.idle";

const COMMANDS: [(&str, &str); 10] = [
    ("lock.request", "Request a host-verified session lock"),
    (
        "idle.caffeine",
        "Set the temporary sleep-only Keep awake toggle and optional duration preset",
    ),
    ("idle.status", "Return current idle policy and inhibitors"),
    ("idle.configure", "Atomically replace named idle rules"),
    (
        "host.session-register",
        "Register the active privileged host generation",
    ),
    (
        "host.lock-ack",
        "Acknowledge compositor ext_session_lock_v1.locked",
    ),
    (
        "host.lock-failed",
        "Report finished before compositor locked",
    ),
    (
        "host.lock-authenticate",
        "Authenticate through the isolated PAM helper",
    ),
    (
        "host.lock-consume-unlock",
        "Consume one scoped unlock approval",
    ),
    ("host.suspend", "Lock, await host ACK, and suspend"),
];

const MAX_CAFFEINE_DURATION_SECONDS: u32 = 86_400;

#[derive(Debug, Default)]
struct CaffeineTimer {
    generation: u64,
    task: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Debug)]
struct Subscription {
    client_id: u64,
    task: tokio::task::JoinHandle<()>,
    disconnect_task: tokio::task::JoinHandle<()>,
}

struct ExplicitSuspendGuard<'a>(&'a AtomicUsize);

impl<'a> ExplicitSuspendGuard<'a> {
    fn enter(counter: &'a AtomicUsize) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for ExplicitSuspendGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Owns session state and all public/privileged bus command handlers.
pub struct SessionService {
    coordinator: tokio::sync::Mutex<Coordinator>,
    lock_snapshot: Mutex<LockSnapshot>,
    lock_guard: Option<Box<dyn Fn(LockPhaseName) + Send + Sync>>,
    sleep_guard: Option<Box<dyn Fn(SleepState) + Send + Sync>>,
    host_client_id: Mutex<Option<u64>>,
    idle: Mutex<IdlePolicy>,
    caffeine_timer: Mutex<CaffeineTimer>,
    sleep_block_sync: tokio::sync::Mutex<()>,
    shutting_down: AtomicBool,
    explicit_suspend_in_flight: AtomicUsize,
    authenticator: Arc<dyn Authenticator>,
    sleep_inhibitor: Arc<dyn SleepInhibitor>,
    hub: Mutex<Option<BusHub>>,
    subscription: Mutex<Option<Subscription>>,
    effects: tokio::sync::broadcast::Sender<IdleEffect>,
}

impl fmt::Debug for SessionService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionService")
            .field("lock", &self.lock_snapshot())
            .field("idle", &self.idle_snapshot())
            .finish_non_exhaustive()
    }
}

impl SessionService {
    /// Creates session state without opening Wayland or D-Bus connections.
    #[must_use]
    pub fn new(
        daemon_instance_id: impl Into<String>,
        authenticator: Arc<dyn Authenticator>,
        sleep_inhibitor: Arc<dyn SleepInhibitor>,
        settings: &IdleSettings,
    ) -> Self {
        let coordinator = Coordinator::new(
            daemon_instance_id,
            sleep_inhibitor.clone(),
            settings.fallback_locker.clone(),
        );
        let lock_snapshot = coordinator.snapshot();
        let mut idle = IdlePolicy::default();
        let config = IdleConfig::from_settings(settings);
        if let Err(error) = idle.configure(config) {
            tracing::warn!(%error, "invalid idle rules in settings.toml; falling back to disabled presets");
            let mut fallback = IdleConfig::default();
            for rule in &mut fallback.rules {
                rule.pre_action_fade_seconds = settings.pre_action_fade_seconds;
            }
            idle.configure(fallback)
                .expect("built-in idle presets are valid");
        }
        let (effects, _) = tokio::sync::broadcast::channel(256);
        Self {
            coordinator: tokio::sync::Mutex::new(coordinator),
            lock_snapshot: Mutex::new(lock_snapshot),
            lock_guard: None,
            sleep_guard: None,
            host_client_id: Mutex::new(None),
            idle: Mutex::new(idle),
            caffeine_timer: Mutex::new(CaffeineTimer::default()),
            sleep_block_sync: tokio::sync::Mutex::new(()),
            shutting_down: AtomicBool::new(false),
            explicit_suspend_in_flight: AtomicUsize::new(0),
            authenticator,
            sleep_inhibitor,
            hub: Mutex::new(None),
            subscription: Mutex::new(None),
            effects,
        }
    }

    /// Installs a synchronous privacy guard before the service starts handling lock transitions.
    ///
    /// The guard runs before each lock snapshot is committed. It must not reenter the session
    /// service or block on asynchronous work.
    #[must_use]
    pub fn with_lock_guard(
        mut self,
        guard: impl Fn(LockPhaseName) + Send + Sync + 'static,
    ) -> Self {
        self.lock_guard = Some(Box::new(guard));
        self
    }

    /// Installs a synchronous guard for changes to the coordinator's sleep hold.
    ///
    /// The callback runs before the lock snapshot is published and must not reenter the service.
    #[must_use]
    pub fn with_sleep_guard(mut self, guard: impl Fn(SleepState) + Send + Sync + 'static) -> Self {
        self.sleep_guard = Some(Box::new(guard));
        self
    }

    /// Publishes topic baselines, registers all commands, and follows hub inhibitor changes.
    pub fn install_on_bus(self: &Arc<Self>, hub: &BusHub) {
        *self.hub.lock().expect("session hub lock poisoned") = Some(hub.clone());
        hub.publish_core_topic(
            TopicName::try_new(LOCK_TOPIC).expect("session.lock is a valid topic"),
            serde_json::to_value(self.lock_snapshot()).expect("lock snapshot serializes"),
            UpdateKind::SourceBaseline,
        );
        hub.publish_core_topic(
            TopicName::try_new(IDLE_TOPIC).expect("session.idle is a valid topic"),
            serde_json::to_value(self.idle_snapshot()).expect("idle snapshot serializes"),
            UpdateKind::SourceBaseline,
        );
        for (name, description) in COMMANDS {
            register_command(hub, Arc::downgrade(self), name, description);
        }
        self.start_inhibitor_sync(hub);
    }

    /// Returns the current non-secret lock topic state.
    #[must_use]
    pub fn lock_snapshot(&self) -> LockSnapshot {
        self.lock_snapshot
            .lock()
            .expect("session lock snapshot poisoned")
            .clone()
    }

    /// Returns the current non-secret idle topic state.
    #[must_use]
    pub fn idle_snapshot(&self) -> IdleSnapshot {
        self.idle
            .lock()
            .expect("idle policy lock poisoned")
            .snapshot()
    }

    /// Subscribes a native Wayland/action adapter to policy effects.
    pub fn subscribe_idle_effects(&self) -> tokio::sync::broadcast::Receiver<IdleEffect> {
        self.effects.subscribe()
    }

    /// Returns currently active `(rule_index, token, timeout_seconds)` watches for initial driver arming.
    #[must_use]
    pub fn active_idle_watches(&self) -> Vec<(usize, u64, u32)> {
        self.idle
            .lock()
            .expect("idle policy lock poisoned")
            .active_watches()
    }

    /// Applies updated declarative `settings.toml` [`IdleSettings`] atomically on reload.
    pub async fn apply_settings(self: &Arc<Self>, settings: &IdleSettings) {
        {
            let mut coordinator = self.coordinator.lock().await;
            coordinator.set_fallback_locker(settings.fallback_locker.clone());
        }
        let config = IdleConfig::from_settings(settings);
        let result = self
            .idle
            .lock()
            .expect("idle policy lock poisoned")
            .configure(config);
        match result {
            Ok(effects) => {
                self.publish_idle();
                self.apply_idle_effects(effects).await;
            }
            Err(error) => {
                tracing::warn!(%error, "ignoring invalid idle rules on settings reload");
            }
        }
    }

    /// Requests a host-verified session lock (used by `lock.request` and `logind` `Session.Lock`).
    ///
    /// # Errors
    ///
    /// Returns an [`RpcError`] if an immediate fallback action fails.
    pub async fn request_lock(self: &Arc<Self>) -> Result<Value, RpcError> {
        let (actions, hold_generation) = {
            let mut coordinator = self.coordinator.lock().await;
            let actions = coordinator.request_lock();
            let hold_generation = coordinator.sleep_hold_generation();
            let snapshot = coordinator.snapshot();
            self.publish_lock(snapshot);
            (actions, hold_generation)
        };
        self.finish_coordinator_actions(actions, hold_generation)
            .await
    }

    /// Acquires the initial logind delay FD before sleep monitoring begins.
    ///
    /// # Errors
    ///
    /// Returns the underlying logind acquisition error.
    pub async fn arm_sleep_delay(&self) -> Result<(), SleepInhibitorError> {
        self.coordinator.lock().await.arm_sleep_delay().await
    }

    /// Reconciles the OS-level `systemd-logind` `sleep:block` FD with active sleep blockers.
    ///
    /// Serialized under `sleep_block_sync` and rechecked across the async acquisition boundary so
    /// rapid toggles, timed expiry, shutdown, or explicit `host.suspend` never leak or reinstall
    /// the block FD.
    pub async fn sync_sleep_block_inhibitor(&self) {
        let _sync = self.sleep_block_sync.lock().await;
        let Some(reason) = self.desired_sleep_block_reason() else {
            self.sleep_inhibitor.release_sleep_block();
            self.update_sleep_block_status(SleepBlockStatus::Inactive);
            return;
        };
        if self.sleep_inhibitor.is_sleep_block_held() {
            self.update_sleep_block_status(SleepBlockStatus::Held);
            return;
        }
        let result = self.sleep_inhibitor.acquire_sleep_block(&reason).await;
        if self.desired_sleep_block_reason().is_none() {
            self.sleep_inhibitor.release_sleep_block();
            self.update_sleep_block_status(SleepBlockStatus::Inactive);
            return;
        }
        match result {
            Ok(()) => self.update_sleep_block_status(SleepBlockStatus::Held),
            Err(error) => {
                tracing::warn!(%error, "could not acquire logind sleep block inhibitor");
                self.sleep_inhibitor.release_sleep_block();
                self.update_sleep_block_status(SleepBlockStatus::Unavailable {
                    reason: error.to_string(),
                });
            }
        }
    }

    fn desired_sleep_block_reason(&self) -> Option<String> {
        if self.shutting_down.load(Ordering::SeqCst)
            || self.explicit_suspend_in_flight.load(Ordering::SeqCst) > 0
        {
            return None;
        }
        self.idle
            .lock()
            .expect("idle policy lock poisoned")
            .sleep_block_reason()
    }

    fn update_sleep_block_status(&self, status: SleepBlockStatus) {
        let changed = self
            .idle
            .lock()
            .expect("idle policy lock poisoned")
            .set_sleep_block_status(status);
        if changed {
            self.publish_idle();
        }
    }

    /// Applies a logind `PrepareForSleep` or wake transition.
    pub async fn handle_sleep_signal(self: &Arc<Self>, signal: SleepSignal) {
        let (actions, hold_generation) = {
            let mut coordinator = self.coordinator.lock().await;
            let actions = coordinator.on_sleep_signal(signal).await;
            let hold_generation = coordinator.sleep_hold_generation();
            self.publish_lock(coordinator.snapshot());
            (actions, hold_generation)
        };
        let sleep = match signal {
            SleepSignal::PrepareForSleep => SleepState::Sleeping,
            SleepSignal::Wake => SleepState::Awake,
        };
        let effects = self
            .idle
            .lock()
            .expect("idle policy lock poisoned")
            .set_sleep_state(sleep);
        self.publish_idle();
        self.apply_idle_effects(effects).await;
        if let Err(error) = self
            .execute_coordinator_actions(actions, hold_generation)
            .await
        {
            tracing::warn!(%error, "sleep transition action failed");
        }
        if signal == SleepSignal::Wake {
            self.sync_sleep_block_inhibitor().await;
        }
    }

    /// Applies MPRIS playback inhibition without persisting it.
    pub async fn set_media_playing(self: &Arc<Self>, playback: MediaPlayback) {
        let effects = self
            .idle
            .lock()
            .expect("idle policy lock poisoned")
            .set_media_playing(playback);
        self.publish_idle();
        self.apply_idle_effects(effects).await;
    }

    /// Applies temporary Keep awake state using remembered preset without persisting it.
    pub async fn set_caffeine(self: &Arc<Self>, caffeine: Caffeine) {
        self.set_caffeine_schedule(Some(caffeine == Caffeine::Enabled), None)
            .await;
    }

    /// Updates Keep awake state and/or remembered duration preset (`Some(None)` = indefinite,
    /// `None` = preserve remembered preset), scheduling or cancelling the expiry timer.
    pub async fn set_caffeine_schedule(
        self: &Arc<Self>,
        enabled: Option<bool>,
        duration_seconds: Option<Option<u32>>,
    ) {
        let generation = self.cancel_caffeine_timer();
        let (effects, is_enabled, active_duration) = {
            let mut policy = self.idle.lock().expect("idle policy lock poisoned");
            let current_enabled = policy.snapshot().caffeine;
            let target_enabled = enabled.unwrap_or(current_enabled);
            let caffeine = if target_enabled {
                Caffeine::Enabled
            } else {
                Caffeine::Disabled
            };
            let effects =
                policy.set_caffeine_with_schedule(caffeine, duration_seconds, current_epoch_ms());
            let active_duration = policy.snapshot().caffeine_duration_seconds;
            (effects, target_enabled, active_duration)
        };
        self.publish_idle();
        self.apply_idle_effects(effects).await;
        self.sync_sleep_block_inhibitor().await;

        if is_enabled
            && !self.shutting_down.load(Ordering::SeqCst)
            && let Some(secs) = active_duration
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let weak = Arc::downgrade(self);
            let handle = runtime.spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(u64::from(secs))).await;
                let Some(service) = weak.upgrade() else {
                    return;
                };
                let effects = {
                    let mut timer = service
                        .caffeine_timer
                        .lock()
                        .expect("caffeine timer lock poisoned");
                    if timer.generation != generation {
                        return;
                    }
                    timer.task = None;
                    drop(timer);
                    service
                        .idle
                        .lock()
                        .expect("idle policy lock poisoned")
                        .set_caffeine_with_schedule(Caffeine::Disabled, None, current_epoch_ms())
                };
                service.publish_idle();
                service.apply_idle_effects(effects).await;
                service.sync_sleep_block_inhibitor().await;
            });
            let mut timer = self
                .caffeine_timer
                .lock()
                .expect("caffeine timer lock poisoned");
            if timer.generation == generation {
                timer.task = Some(handle);
            } else {
                handle.abort();
            }
        }
    }

    fn cancel_caffeine_timer(&self) -> u64 {
        let mut timer = self
            .caffeine_timer
            .lock()
            .expect("caffeine timer lock poisoned");
        timer.generation = timer.generation.wrapping_add(1);
        if let Some(task) = timer.task.take() {
            task.abort();
        }
        timer.generation
    }

    /// Synchronizes live ScreenSaver cookie state into idle policy.
    pub async fn sync_screensaver_inhibitors(self: &Arc<Self>, inhibitors: Vec<IdleInhibitor>) {
        let effects = self
            .idle
            .lock()
            .expect("idle policy lock poisoned")
            .sync_screensaver_inhibitors(inhibitors);
        self.publish_idle();
        self.apply_idle_effects(effects).await;
    }

    /// Delivers one native Wayland idle or resumed event.
    pub async fn handle_wayland_idle(
        self: &Arc<Self>,
        event: crate::wayland_idle::WaylandIdleEvent,
    ) {
        let effects = match event {
            crate::wayland_idle::WaylandIdleEvent::Idled { rule_index, token } => self
                .idle
                .lock()
                .expect("idle policy lock poisoned")
                .idle(rule_index, token),
            crate::wayland_idle::WaylandIdleEvent::Resumed { .. } => self
                .idle
                .lock()
                .expect("idle policy lock poisoned")
                .activity(),
        };
        self.publish_idle();
        self.apply_idle_effects(effects).await;
    }

    /// Reports completion from a native output-power or custom action adapter.
    pub async fn complete_idle_action(
        self: &Arc<Self>,
        action_id: u64,
        completion: ActionCompletion,
    ) {
        let effects = self
            .idle
            .lock()
            .expect("idle policy lock poisoned")
            .action_completed(action_id, completion);
        self.publish_idle();
        self.apply_idle_effects(effects).await;
    }

    /// Marks native idle integration unavailable in the public topic.
    pub fn set_idle_unavailable(&self, reason: impl Into<String>) {
        self.idle
            .lock()
            .expect("idle policy lock poisoned")
            .set_service_status(IdleServiceStatus::Unavailable {
                reason: reason.into(),
            });
        self.publish_idle();
    }

    /// Stops hub synchronization, releases OS sleep-block inhibition, and marks idle stopped.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.cancel_caffeine_timer();
        self.stop_inhibitor_sync();
        self.sleep_inhibitor.release_sleep_block();
        {
            let mut policy = self.idle.lock().expect("idle policy lock poisoned");
            policy.set_service_status(IdleServiceStatus::Stopped);
            policy.set_sleep_block_status(SleepBlockStatus::Inactive);
        }
        self.publish_idle();
    }

    fn start_inhibitor_sync(self: &Arc<Self>, hub: &BusHub) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let Some((client_id, outbound)) = hub.register_client(ClientRole::Public) else {
            return;
        };
        hub.handle_inline_message(
            client_id,
            ClientMessage::request(
                RequestId::Number(1),
                methods::BUS_HELLO,
                Some(json!({"protocol_version": PROTOCOL_VERSION})),
            ),
        );
        hub.handle_inline_message(
            client_id,
            ClientMessage::request(
                RequestId::Number(2),
                methods::TOPIC_SUBSCRIBE,
                Some(
                    serde_json::to_value(TopicSubscribeParams {
                        topic: TopicName::try_new(z_shell_bus::hub::INHIBITORS_TOPIC)
                            .expect("inhibitors is a valid topic"),
                    })
                    .expect("subscription params serialize"),
                ),
            ),
        );
        let weak = Arc::downgrade(self);
        let task = runtime.spawn(async move {
            while let Some(line) = outbound.next_line().await {
                let Ok(message) = decode_server_line(&line) else {
                    continue;
                };
                let Some(data) = inhibitor_topic_data(message) else {
                    continue;
                };
                let Ok(entries) = serde_json::from_value::<Vec<InhibitorEntry>>(data) else {
                    continue;
                };
                let Some(service) = weak.upgrade() else {
                    break;
                };
                let effects = service
                    .idle
                    .lock()
                    .expect("idle policy lock poisoned")
                    .sync_plugin_inhibitors(&entries);
                service.publish_idle();
                service.apply_idle_effects(effects).await;
                service.sync_sleep_block_inhibitor().await;
            }
        });
        let weak_disconnect = Arc::downgrade(self);
        let mut retired_rx = hub.subscribe_client_retired();
        let disconnect_task = runtime.spawn(async move {
            loop {
                match retired_rx.recv().await {
                    Ok(caller) if caller.role == ClientRole::PrivilegedHost => {
                        let Some(service) = weak_disconnect.upgrade() else {
                            break;
                        };
                        let should_disconnect = {
                            let mut active = service
                                .host_client_id
                                .lock()
                                .expect("host client id lock poisoned");
                            if *active == Some(caller.client_id) {
                                *active = None;
                                true
                            } else {
                                false
                            }
                        };
                        if should_disconnect {
                            service.handle_host_disconnected().await;
                        }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        *self
            .subscription
            .lock()
            .expect("subscription lock poisoned") = Some(Subscription {
            client_id,
            task,
            disconnect_task,
        });
    }

    /// Marks the active privileged host disconnected, immediately invalidating any pending unlock
    /// approval and aborting engaging suspends while keeping acknowledged locks fail-closed.
    pub async fn handle_host_disconnected(self: &Arc<Self>) {
        let (actions, hold_generation) = {
            let mut coordinator = self.coordinator.lock().await;
            let actions = coordinator.host_disconnected();
            let hold_generation = coordinator.sleep_hold_generation();
            let snapshot = coordinator.snapshot();
            self.publish_lock(snapshot);
            (actions, hold_generation)
        };
        if let Err(error) = self
            .finish_coordinator_actions(actions, hold_generation)
            .await
        {
            tracing::warn!(%error, "host disconnect coordinator action reported error");
        }
    }

    fn stop_inhibitor_sync(&self) {
        let subscription = self
            .subscription
            .lock()
            .expect("subscription lock poisoned")
            .take();
        if let Some(subscription) = subscription {
            subscription.task.abort();
            subscription.disconnect_task.abort();
            if let Some(hub) = self.hub.lock().expect("session hub lock poisoned").as_ref() {
                hub.retire_client(subscription.client_id);
            }
        }
    }

    fn publish_lock(&self, snapshot: LockSnapshot) {
        if let Some(guard) = &self.lock_guard {
            guard(snapshot.phase);
        }
        if let Some(guard) = &self.sleep_guard {
            guard(if snapshot.sleep_hold {
                SleepState::Sleeping
            } else {
                SleepState::Awake
            });
        }
        *self.lock_snapshot.lock().expect("lock snapshot poisoned") = snapshot.clone();
        if let Some(hub) = self.hub.lock().expect("session hub lock poisoned").as_ref() {
            hub.publish_core_topic(
                TopicName::try_new(LOCK_TOPIC).expect("session.lock is a valid topic"),
                serde_json::to_value(snapshot).expect("lock snapshot serializes"),
                UpdateKind::Live,
            );
        }
    }

    fn publish_idle(&self) {
        if let Some(hub) = self.hub.lock().expect("session hub lock poisoned").as_ref() {
            hub.publish_core_topic(
                TopicName::try_new(IDLE_TOPIC).expect("session.idle is a valid topic"),
                serde_json::to_value(self.idle_snapshot()).expect("idle snapshot serializes"),
                UpdateKind::Live,
            );
        }
    }

    async fn finish_coordinator_actions(
        self: &Arc<Self>,
        actions: Vec<CoordinatorAction>,
        hold_generation: u64,
    ) -> Result<Value, RpcError> {
        let locked = self.lock_snapshot().phase == LockPhaseName::Locked;
        let effects = self
            .idle
            .lock()
            .expect("idle policy lock poisoned")
            .set_lock_state(if locked {
                LockState::Locked
            } else {
                LockState::Unlocked
            });
        self.publish_idle();
        self.apply_idle_effects(effects).await;
        let value = serde_json::to_value(&actions).expect("coordinator actions serialize");
        self.execute_coordinator_actions(actions, hold_generation)
            .await?;
        Ok(value)
    }

    async fn execute_coordinator_actions(
        &self,
        actions: Vec<CoordinatorAction>,
        hold_generation: u64,
    ) -> Result<(), RpcError> {
        for action in actions {
            match action {
                CoordinatorAction::SpawnFallback(argv) => spawn_argv(&argv)?,
                CoordinatorAction::Suspend => {
                    let _in_flight = ExplicitSuspendGuard::enter(&self.explicit_suspend_in_flight);
                    {
                        let _sync = self.sleep_block_sync.lock().await;
                        self.sleep_inhibitor.release_sleep_block();
                        self.update_sleep_block_status(SleepBlockStatus::Inactive);
                    }
                    let result = self.sleep_inhibitor.suspend().await;
                    drop(_in_flight);
                    if let Err(error) = result {
                        let message = error.to_string();
                        let recovered = {
                            let mut coordinator = self.coordinator.lock().await;
                            let recovery = coordinator
                                .on_suspend_failed(hold_generation, message.clone())
                                .await;
                            let snapshot = coordinator.snapshot();
                            self.publish_lock(snapshot);
                            !recovery.is_empty()
                        };
                        if recovered {
                            self.sync_sleep_block_inhibitor().await;
                        }
                        return Err(internal(message));
                    }
                }
                CoordinatorAction::IdleSuspend => {
                    let inhibited = self
                        .idle
                        .lock()
                        .expect("idle policy lock poisoned")
                        .is_idle_sleep_inhibited();
                    if inhibited {
                        {
                            let mut coordinator = self.coordinator.lock().await;
                            let _ = coordinator
                                .on_suspend_failed(
                                    hold_generation,
                                    "idle suspend cancelled by active sleep inhibitor",
                                )
                                .await;
                            let snapshot = coordinator.snapshot();
                            self.publish_lock(snapshot);
                        }
                        self.sync_sleep_block_inhibitor().await;
                    } else if let Err(error) = self.sleep_inhibitor.suspend().await {
                        let message = error.to_string();
                        {
                            let mut coordinator = self.coordinator.lock().await;
                            let _ = coordinator
                                .on_suspend_failed(hold_generation, message.clone())
                                .await;
                            let snapshot = coordinator.snapshot();
                            self.publish_lock(snapshot);
                        }
                        return Err(internal(message));
                    }
                }
                CoordinatorAction::AbortSuspend { reason } => {
                    tracing::warn!(%reason, "shell-initiated suspend aborted");
                    return Err(RpcError::new(ErrorCode::Disabled, reason));
                }
                CoordinatorAction::UnacknowledgedSuspend { reason } => {
                    tracing::warn!(%reason, "external suspend is unacknowledged");
                }
                CoordinatorAction::RequestHostLock { .. }
                | CoordinatorAction::ReleaseSleepDelayInhibitor
                | CoordinatorAction::AcquireSleepDelayInhibitor => {}
            }
        }
        Ok(())
    }

    fn apply_idle_effects<'a>(
        self: &'a Arc<Self>,
        effects: Vec<IdleEffect>,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            for effect in effects {
                let _ = self.effects.send(effect.clone());
                match effect {
                    IdleEffect::WarningStarted {
                        token,
                        fade_seconds,
                        ..
                    } => {
                        let weak = Arc::downgrade(self);
                        tokio::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_secs(u64::from(
                                fade_seconds,
                            )))
                            .await;
                            if let Some(service) = weak.upgrade() {
                                let effects = service
                                    .idle
                                    .lock()
                                    .expect("idle policy lock poisoned")
                                    .fade_complete(token);
                                service.publish_idle();
                                service.apply_idle_effects(effects).await;
                            }
                        });
                    }
                    IdleEffect::RunAction {
                        action_id,
                        action,
                        resume_command: _,
                        rule_index: _,
                    } => {
                        let completion = match action {
                            crate::idle::IdleAction::Lock => {
                                let (actions, hold_generation) = {
                                    let mut coordinator = self.coordinator.lock().await;
                                    let actions = coordinator.request_lock();
                                    let hold_generation = coordinator.sleep_hold_generation();
                                    let snapshot = coordinator.snapshot();
                                    self.publish_lock(snapshot);
                                    (actions, hold_generation)
                                };
                                action_completion(
                                    self.finish_coordinator_actions(actions, hold_generation)
                                        .await,
                                )
                            }
                            crate::idle::IdleAction::LockAndSuspend => {
                                let (actions, hold_generation) = {
                                    let mut coordinator = self.coordinator.lock().await;
                                    let actions = coordinator.request_idle_suspend();
                                    let hold_generation = coordinator.sleep_hold_generation();
                                    let snapshot = coordinator.snapshot();
                                    self.publish_lock(snapshot);
                                    (actions, hold_generation)
                                };
                                action_completion(
                                    self.finish_coordinator_actions(actions, hold_generation)
                                        .await,
                                )
                            }
                            crate::idle::IdleAction::Suspend => {
                                if self
                                    .idle
                                    .lock()
                                    .expect("idle policy lock poisoned")
                                    .is_idle_sleep_inhibited()
                                {
                                    ActionCompletion::Failed
                                } else {
                                    action_completion(
                                        self.sleep_inhibitor
                                            .suspend()
                                            .await
                                            .map_err(|e| internal(e.to_string())),
                                    )
                                }
                            }
                            crate::idle::IdleAction::CustomCommand(argv) => {
                                action_completion(spawn_argv(&argv))
                            }
                            crate::idle::IdleAction::ScreenOff => continue,
                        };
                        let effects = self
                            .idle
                            .lock()
                            .expect("idle policy lock poisoned")
                            .action_completed(action_id, completion);
                        self.publish_idle();
                        self.apply_idle_effects(effects).await;
                    }
                    IdleEffect::ResumeAction {
                        resume_command: Some(argv),
                        ..
                    } => {
                        if let Err(error) = spawn_argv(&argv) {
                            tracing::warn!(%error, "idle resume command failed");
                        }
                    }
                    IdleEffect::StartWatch { .. }
                    | IdleEffect::CancelWatch { .. }
                    | IdleEffect::WarningCancelled { .. }
                    | IdleEffect::ResumeAction {
                        resume_command: None,
                        ..
                    } => {}
                }
            }
        })
    }
}

impl Drop for SessionService {
    fn drop(&mut self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.cancel_caffeine_timer();
        self.stop_inhibitor_sync();
        self.sleep_inhibitor.release_sleep_block();
    }
}

fn action_completion<T>(result: Result<T, RpcError>) -> ActionCompletion {
    if result.is_ok() {
        ActionCompletion::Succeeded
    } else {
        ActionCompletion::Failed
    }
}

fn spawn_argv(argv: &[String]) -> Result<(), RpcError> {
    let Some((program, args)) = argv.split_first() else {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "empty command argv",
        ));
    };
    let child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| internal(format!("could not spawn {program}: {error}")))?;
    tokio::task::spawn_blocking(move || {
        let mut child = child;
        let _ = child.wait();
    });
    Ok(())
}

fn register_command(
    hub: &BusHub,
    service: Weak<SessionService>,
    name: &'static str,
    description: &str,
) {
    let handler: CommandHandler = Arc::new(move |call| {
        let service = service.clone();
        Box::pin(async move {
            let service = service
                .upgrade()
                .ok_or_else(|| internal("session service is shut down"))?;
            let data = dispatch(&service, name, call).await?;
            Ok(CommandInvokeResult {
                message: None,
                data: Some(data),
            })
        })
    });
    hub.register_core_command(
        CommandName::try_new(name).expect("session command name is valid"),
        description,
        handler,
    );
}

async fn dispatch(
    service: &Arc<SessionService>,
    name: &str,
    call: CommandCall,
) -> Result<Value, RpcError> {
    if name.starts_with("host.") {
        require_host(call.caller.role)?;
    }
    match name {
        "lock.request" => {
            parse_params::<EmptyParams>(call.params.payload)?;
            service.request_lock().await
        }
        "idle.caffeine" => {
            let params: CaffeineParams = parse_params(call.params.payload)?;
            if matches!(params.duration_seconds, Some(Some(secs)) if secs == 0 || secs > MAX_CAFFEINE_DURATION_SECONDS)
            {
                return Err(RpcError::new(
                    ErrorCode::InvalidParams,
                    "duration_seconds must be within 1..=86400 seconds",
                ));
            }
            service
                .set_caffeine_schedule(params.enabled, params.duration_seconds)
                .await;
            Ok(serde_json::to_value(service.idle_snapshot()).expect("idle snapshot serializes"))
        }
        "idle.status" => {
            parse_params::<EmptyParams>(call.params.payload)?;
            Ok(serde_json::to_value(service.idle_snapshot()).expect("idle snapshot serializes"))
        }
        "idle.configure" => {
            require_host(call.caller.role)?;
            let config: IdleConfig = parse_params(call.params.payload)?;
            let effects = service
                .idle
                .lock()
                .expect("idle policy lock poisoned")
                .configure(config)
                .map_err(|error| RpcError::new(ErrorCode::InvalidParams, error.to_string()))?;
            service.publish_idle();
            service.apply_idle_effects(effects).await;
            Ok(serde_json::to_value(service.idle_snapshot()).expect("idle snapshot serializes"))
        }
        "host.session-register" => {
            let params: SessionRegisterParams = parse_params(call.params.payload)?;
            *service
                .host_client_id
                .lock()
                .expect("host client id lock poisoned") = Some(call.caller.client_id);
            let (actions, hold_generation) = {
                let mut coordinator = service.coordinator.lock().await;
                let actions = coordinator.register_host(params.ui_session_generation);
                let hold_generation = coordinator.sleep_hold_generation();
                let snapshot = coordinator.snapshot();
                service.publish_lock(snapshot);
                (actions, hold_generation)
            };
            service
                .finish_coordinator_actions(actions, hold_generation)
                .await?;
            Ok(serde_json::to_value(service.lock_snapshot()).expect("lock snapshot serializes"))
        }
        "host.lock-ack" => {
            let params: LockAckParams = parse_params(call.params.payload)?;
            let (actions, hold_generation) = {
                let mut coordinator = service.coordinator.lock().await;
                let actions = coordinator
                    .on_host_lock_acknowledged(params.lock_id, params.ui_session_generation)
                    .map_err(coordinator_error)?;
                let hold_generation = coordinator.sleep_hold_generation();
                let snapshot = coordinator.snapshot();
                service.publish_lock(snapshot);
                (actions, hold_generation)
            };
            service
                .finish_coordinator_actions(actions, hold_generation)
                .await
        }
        "host.lock-failed" => {
            let params: LockFailedParams = parse_params(call.params.payload)?;
            let (actions, hold_generation) = {
                let mut coordinator = service.coordinator.lock().await;
                let actions = coordinator
                    .on_host_lock_failed(params.lock_id, params.reason)
                    .map_err(coordinator_error)?;
                let hold_generation = coordinator.sleep_hold_generation();
                let snapshot = coordinator.snapshot();
                service.publish_lock(snapshot);
                (actions, hold_generation)
            };
            service
                .finish_coordinator_actions(actions, hold_generation)
                .await
        }
        "host.lock-authenticate" => {
            let params: AuthenticateParams = parse_params(call.params.payload)?;
            let AuthenticateParams {
                username,
                mut password,
                lock_id,
                ui_session_generation,
            } = params;
            let attempt = service
                .coordinator
                .lock()
                .await
                .begin_authentication(lock_id, ui_session_generation)
                .map_err(coordinator_error)?;
            let credentials = Credentials::new(username, std::mem::take(&mut *password.0));
            let outcome = service.authenticator.authenticate(credentials).await;
            let result = {
                let mut coordinator = service.coordinator.lock().await;
                let result = coordinator.complete_authentication(
                    attempt,
                    lock_id,
                    ui_session_generation,
                    outcome,
                );
                service.publish_lock(coordinator.snapshot());
                result
            };
            let approval = result.map_err(coordinator_error)?;
            Ok(serde_json::to_value(approval).expect("unlock approval serializes"))
        }
        "host.lock-consume-unlock" => {
            let params: ConsumeUnlockParams = parse_params(call.params.payload)?;
            {
                let mut coordinator = service.coordinator.lock().await;
                coordinator
                    .consume_unlock(&params.token, params.ui_session_generation, params.lock_id)
                    .map_err(coordinator_error)?;
                let snapshot = coordinator.snapshot();
                service.publish_lock(snapshot);
            }
            Ok(serde_json::to_value(service.lock_snapshot()).expect("lock snapshot serializes"))
        }
        "host.suspend" => {
            parse_params::<EmptyParams>(call.params.payload)?;
            let (actions, hold_generation) = {
                let mut coordinator = service.coordinator.lock().await;
                let actions = coordinator.request_suspend();
                let hold_generation = coordinator.sleep_hold_generation();
                let snapshot = coordinator.snapshot();
                service.publish_lock(snapshot);
                (actions, hold_generation)
            };
            service
                .finish_coordinator_actions(actions, hold_generation)
                .await
        }
        _ => Err(RpcError::new(
            ErrorCode::MethodNotFound,
            format!("unknown session command {name}"),
        )),
    }
}

fn require_host(role: ClientRole) -> Result<(), RpcError> {
    if role == ClientRole::PrivilegedHost {
        Ok(())
    } else {
        Err(RpcError::new(
            ErrorCode::PermissionDenied,
            "command requires the privileged host control channel",
        ))
    }
}

fn coordinator_error(error: CoordinatorError) -> RpcError {
    let code = match error {
        CoordinatorError::AuthenticationDenied(_) => ErrorCode::PermissionDenied,
        CoordinatorError::AuthenticationUnavailable(_) | CoordinatorError::Randomness(_) => {
            ErrorCode::Internal
        }
        CoordinatorError::SleepHold
        | CoordinatorError::HostDisconnected
        | CoordinatorError::WrongState(_)
        | CoordinatorError::AuthenticationInProgress
        | CoordinatorError::StaleAuthentication => ErrorCode::Disabled,
        CoordinatorError::StaleLock
        | CoordinatorError::StaleHostSession
        | CoordinatorError::InvalidUnlockApproval => ErrorCode::InvalidParams,
    };
    RpcError::new(code, error.to_string())
}

fn internal(message: impl Into<String>) -> RpcError {
    RpcError::new(ErrorCode::Internal, message)
}

fn parse_params<T: serde::de::DeserializeOwned>(payload: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(payload.unwrap_or_else(|| json!({}))).map_err(|error| {
        RpcError::new(
            ErrorCode::InvalidParams,
            format!("invalid session parameters: {error}"),
        )
    })
}

fn inhibitor_topic_data(message: ServerMessage) -> Option<Value> {
    match message {
        ServerMessage::Ok { result, .. }
            if result.get("topic").and_then(Value::as_str)
                == Some(z_shell_bus::hub::INHIBITORS_TOPIC) =>
        {
            result.get("data").cloned()
        }
        ServerMessage::Notification { method, params }
            if method == methods::TOPIC_UPDATE
                && params.get("topic").and_then(Value::as_str)
                    == Some(z_shell_bus::hub::INHIBITORS_TOPIC) =>
        {
            params.get("data").cloned()
        }
        _ => None,
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct EmptyParams {}

fn deserialize_double_option<'de, D>(deserializer: D) -> Result<Option<Option<u32>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<u32>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct CaffeineParams {
    enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    duration_seconds: Option<Option<u32>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionRegisterParams {
    ui_session_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LockAckParams {
    lock_id: u64,
    ui_session_generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LockFailedParams {
    lock_id: u64,
    reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthenticateParams {
    username: String,
    password: SecretPassword,
    lock_id: u64,
    ui_session_generation: u64,
}

struct SecretPassword(Zeroizing<String>);

impl<'de> Deserialize<'de> for SecretPassword {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer).map(|password| Self(Zeroizing::new(password)))
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConsumeUnlockParams {
    token: String,
    lock_id: u64,
    ui_session_generation: u64,
}
