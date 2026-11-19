//! Session topics, privileged host commands, and runtime effect dispatch.

use crate::coordinator::{
    Coordinator, CoordinatorAction, CoordinatorError, LockPhaseName, LockSnapshot, SleepInhibitor,
    SleepInhibitorError, SleepSignal,
};
use crate::idle::{
    ActionCompletion, Caffeine, IdleConfig, IdleEffect, IdleInhibitor, IdlePolicy,
    IdleServiceStatus, IdleSnapshot, LockState, MediaPlayback, SleepState,
};
use crate::pam::{Authenticator, Credentials};
use serde::Deserialize;
use serde_json::{Value, json};
use std::fmt;
use std::pin::Pin;
use std::process::{Command, Stdio};
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
    ("idle.caffeine", "Set the temporary Caffeine toggle"),
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

#[derive(Debug)]
struct Subscription {
    client_id: u64,
    task: tokio::task::JoinHandle<()>,
}

/// Owns session state and all public/privileged bus command handlers.
pub struct SessionService {
    coordinator: tokio::sync::Mutex<Coordinator>,
    lock_snapshot: Mutex<LockSnapshot>,
    idle: Mutex<IdlePolicy>,
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
        let mut config = IdleConfig::default();
        for rule in &mut config.rules {
            rule.pre_action_fade_seconds = settings.pre_action_fade_seconds;
        }
        idle.configure(config)
            .expect("built-in idle presets are valid");
        let (effects, _) = tokio::sync::broadcast::channel(256);
        Self {
            coordinator: tokio::sync::Mutex::new(coordinator),
            lock_snapshot: Mutex::new(lock_snapshot),
            idle: Mutex::new(idle),
            authenticator,
            sleep_inhibitor,
            hub: Mutex::new(None),
            subscription: Mutex::new(None),
            effects,
        }
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

    /// Acquires the initial logind delay FD before sleep monitoring begins.
    ///
    /// # Errors
    ///
    /// Returns the underlying logind acquisition error.
    pub async fn arm_sleep_delay(&self) -> Result<(), SleepInhibitorError> {
        self.coordinator.lock().await.arm_sleep_delay().await
    }

    /// Applies a logind `PrepareForSleep` or wake transition.
    pub async fn handle_sleep_signal(self: &Arc<Self>, signal: SleepSignal) {
        let (actions, snapshot) = {
            let mut coordinator = self.coordinator.lock().await;
            let actions = coordinator.on_sleep_signal(signal).await;
            (actions, coordinator.snapshot())
        };
        self.publish_lock(snapshot);
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
        if let Err(error) = self.execute_coordinator_actions(actions).await {
            tracing::warn!(%error, "sleep transition action failed");
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

    /// Applies temporary Caffeine state without persisting it.
    pub async fn set_caffeine(self: &Arc<Self>, caffeine: Caffeine) {
        let effects = self
            .idle
            .lock()
            .expect("idle policy lock poisoned")
            .set_caffeine(caffeine);
        self.publish_idle();
        self.apply_idle_effects(effects).await;
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

    /// Stops hub synchronization and marks idle integration stopped.
    pub fn shutdown(&self) {
        self.stop_inhibitor_sync();
        self.idle
            .lock()
            .expect("idle policy lock poisoned")
            .set_service_status(IdleServiceStatus::Stopped);
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
            }
        });
        *self
            .subscription
            .lock()
            .expect("subscription lock poisoned") = Some(Subscription { client_id, task });
    }

    fn stop_inhibitor_sync(&self) {
        let subscription = self
            .subscription
            .lock()
            .expect("subscription lock poisoned")
            .take();
        if let Some(subscription) = subscription {
            subscription.task.abort();
            if let Some(hub) = self.hub.lock().expect("session hub lock poisoned").as_ref() {
                hub.retire_client(subscription.client_id);
            }
        }
    }

    fn publish_lock(&self, snapshot: LockSnapshot) {
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
        self.execute_coordinator_actions(actions).await?;
        Ok(value)
    }

    async fn execute_coordinator_actions(
        &self,
        actions: Vec<CoordinatorAction>,
    ) -> Result<(), RpcError> {
        for action in actions {
            match action {
                CoordinatorAction::SpawnFallback(argv) => spawn_argv(&argv)?,
                CoordinatorAction::Suspend => self
                    .sleep_inhibitor
                    .suspend()
                    .await
                    .map_err(|error| internal(error.to_string()))?,
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
                                let actions = {
                                    let mut coordinator = self.coordinator.lock().await;
                                    let actions = coordinator.request_lock();
                                    let snapshot = coordinator.snapshot();
                                    self.publish_lock(snapshot);
                                    actions
                                };
                                action_completion(self.finish_coordinator_actions(actions).await)
                            }
                            crate::idle::IdleAction::LockAndSuspend => {
                                let actions = {
                                    let mut coordinator = self.coordinator.lock().await;
                                    let actions = coordinator.request_suspend();
                                    let snapshot = coordinator.snapshot();
                                    self.publish_lock(snapshot);
                                    actions
                                };
                                action_completion(self.finish_coordinator_actions(actions).await)
                            }
                            crate::idle::IdleAction::Suspend => action_completion(
                                self.sleep_inhibitor
                                    .suspend()
                                    .await
                                    .map_err(|e| internal(e.to_string())),
                            ),
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
        self.stop_inhibitor_sync();
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
            let actions = {
                let mut coordinator = service.coordinator.lock().await;
                let actions = coordinator.request_lock();
                let snapshot = coordinator.snapshot();
                service.publish_lock(snapshot);
                actions
            };
            service.finish_coordinator_actions(actions).await
        }
        "idle.caffeine" => {
            let params: CaffeineParams = parse_params(call.params.payload)?;
            service
                .set_caffeine(if params.enabled {
                    Caffeine::Enabled
                } else {
                    Caffeine::Disabled
                })
                .await;
            Ok(serde_json::to_value(service.idle_snapshot()).expect("idle snapshot serializes"))
        }
        "idle.status" => {
            parse_params::<EmptyParams>(call.params.payload)?;
            Ok(serde_json::to_value(service.idle_snapshot()).expect("idle snapshot serializes"))
        }
        "idle.configure" => {
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
            let actions = {
                let mut coordinator = service.coordinator.lock().await;
                let actions = coordinator.register_host(params.ui_session_generation);
                let snapshot = coordinator.snapshot();
                service.publish_lock(snapshot);
                actions
            };
            service.finish_coordinator_actions(actions).await?;
            Ok(serde_json::to_value(service.lock_snapshot()).expect("lock snapshot serializes"))
        }
        "host.lock-ack" => {
            let params: LockAckParams = parse_params(call.params.payload)?;
            let actions = {
                let mut coordinator = service.coordinator.lock().await;
                let actions = coordinator
                    .on_host_lock_acknowledged(params.lock_id, params.ui_session_generation)
                    .map_err(coordinator_error)?;
                let snapshot = coordinator.snapshot();
                service.publish_lock(snapshot);
                actions
            };
            service.finish_coordinator_actions(actions).await
        }
        "host.lock-failed" => {
            let params: LockFailedParams = parse_params(call.params.payload)?;
            let actions = {
                let mut coordinator = service.coordinator.lock().await;
                let actions = coordinator
                    .on_host_lock_failed(params.lock_id, params.reason)
                    .map_err(coordinator_error)?;
                let snapshot = coordinator.snapshot();
                service.publish_lock(snapshot);
                actions
            };
            service.finish_coordinator_actions(actions).await
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
            let result = service.coordinator.lock().await.complete_authentication(
                attempt,
                lock_id,
                ui_session_generation,
                outcome,
            );
            let snapshot = service.coordinator.lock().await.snapshot();
            service.publish_lock(snapshot);
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
            let actions = {
                let mut coordinator = service.coordinator.lock().await;
                let actions = coordinator.request_suspend();
                let snapshot = coordinator.snapshot();
                service.publish_lock(snapshot);
                actions
            };
            service.finish_coordinator_actions(actions).await
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CaffeineParams {
    enabled: bool,
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
        D: serde::Deserializer<'de>,
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
