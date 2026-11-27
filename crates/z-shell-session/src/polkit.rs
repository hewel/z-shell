//! Session Polkit agent, non-secret prompt state, and privileged host controls.

mod dbus;
mod helper;

pub use dbus::{PolkitBus, PolkitRegistration};
pub use helper::PolkitHelperConfig;

use helper::{Echo, HelperError, HelperEvent, HelperOutcome};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fmt;
use std::fs;
use std::sync::{Arc, Mutex};
use tokio::runtime::Handle;
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use z_shell_bus::{BusHub, CommandHandler, UpdateKind};
use z_shell_config::PolkitSettings;
use z_shell_protocol::{
    ClientRole, CommandInvokeResult, CommandName, ErrorCode, MAX_SAFE_JS_INT, RpcError, TopicName,
};
use zbus::names::{OwnedUniqueName, UniqueName};
use zbus::zvariant::OwnedValue;
use zeroize::{Zeroize, Zeroizing};

/// Public topic containing non-secret agent state and, when unlocked, the current prompt.
pub const POLKIT_TOPIC: &str = "session.polkit";

const MAX_ATTEMPTS: u8 = 3;
const MAX_REQUESTS: usize = 32;
const MAX_RESPONSES: usize = 32;
const AUTHENTICATION_FAILED: &str = "Authentication failed";
const RESPOND: &str = "host.polkit-respond";

/// Controls whether elevation prompts can be displayed or answered.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PolkitLockState {
    /// Allow prompts and host responses.
    #[default]
    Unlocked,
    /// Suppress prompts and block responses without discarding the request.
    Locked,
}

/// Controls whether the daemon acts as the session's Polkit agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolkitEnabled {
    /// Register and accept authorization requests.
    Enabled,
    /// Cancel existing requests and unregister.
    Disabled,
}

impl From<&PolkitSettings> for PolkitEnabled {
    fn from(settings: &PolkitSettings) -> Self {
        if settings.enabled {
            Self::Enabled
        } else {
            Self::Disabled
        }
    }
}

/// Non-secret state exposed on [`POLKIT_TOPIC`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct PolkitSnapshot {
    /// Whether the agent is enabled in daemon settings.
    pub enabled: bool,
    /// Whether the agent has registered with the current Authority.
    pub registered: bool,
    /// Whether prompts are suppressed by the lock screen.
    pub locked_suppressed: bool,
    /// Most recent agent or helper failure, without credentials.
    pub last_error: Option<String>,
    /// Current request, omitted when locked or idle.
    pub active: Option<PolkitPromptView>,
}

/// Public display data for one authorization request, excluding its cookie and responses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct PolkitPromptView {
    /// Monotonic daemon-local identifier for host commands.
    pub request_id: u64,
    /// Polkit action being authorized.
    pub action_id: String,
    /// Localized description supplied by the Authority.
    pub message: String,
    /// Icon hint supplied by the Authority.
    pub icon_name: String,
    /// Additional display metadata supplied by the Authority.
    pub details: BTreeMap<String, String>,
    /// Locally resolved user identities that may answer the challenge.
    pub identities: Vec<PolkitIdentity>,
    /// UID currently selected for authentication.
    pub selected_uid: Option<u32>,
    /// A helper question awaiting a response.
    pub prompt: Option<String>,
    /// Whether the current question permits echoing input.
    pub echo_on: bool,
    /// Most recent informational PAM message.
    pub info_message: Option<String>,
    /// Most recent PAM error or retry message.
    pub error_message: Option<String>,
    /// Whether the agent is waiting for the helper rather than for the host.
    pub authenticating: bool,
}

/// A Polkit user identity resolved against the local account database.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct PolkitIdentity {
    /// Unix user ID supplied by Polkit.
    pub uid: u32,
    /// Local account name passed to the helper.
    pub username: String,
}

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.freedesktop.PolicyKit1.Error")]
enum PolkitError {
    Cancelled(String),
    Failed(String),
    NotAuthorized(String),
}

impl PolkitError {
    fn cancelled() -> Self {
        Self::Cancelled("authentication cancelled".into())
    }
}

type Identities = Vec<(String, HashMap<String, OwnedValue>)>;
type Response = Arc<Zeroizing<String>>;
type Completion = Result<(), PolkitError>;

struct AuthenticationRequest {
    action_id: String,
    message: String,
    icon_name: String,
    details: HashMap<String, String>,
    cookie: Zeroizing<String>,
    identities: Identities,
}

struct Request {
    view: PolkitPromptView,
    cookie: Arc<Zeroizing<String>>,
    complete: oneshot::Sender<Completion>,
    // Keep bounded, zeroized references to submitted responses so PAM cannot echo them into a topic.
    responses: Vec<Response>,
}

impl Request {
    fn display_text(&self, mut text: Zeroizing<String>) -> String {
        if contains_secret(&text, &self.cookie)
            || self
                .responses
                .iter()
                .any(|response| contains_secret(&text, response))
        {
            String::new()
        } else {
            std::mem::take(&mut *text)
        }
    }
}

struct Attempt {
    cancel: Option<oneshot::Sender<()>>,
    responses: mpsc::Sender<Response>,
    reaped: watch::Receiver<()>,
}

impl Attempt {
    fn stop(&mut self) -> watch::Receiver<()> {
        // Closing the cancellation channel also interrupts a blocked stdin or stdout operation.
        self.cancel.take();
        self.reaped.clone()
    }
}

struct Active {
    request: Request,
    attempt: Attempt,
    attempts: u8,
    cancelled: Option<PolkitError>,
}

impl Active {
    fn cancel(&mut self) -> watch::Receiver<()> {
        self.cancelled.get_or_insert_with(PolkitError::cancelled);
        self.attempt.stop()
    }
}

#[derive(Clone, Copy)]
struct RegistrationSettings {
    enabled: PolkitEnabled,
    generation: u64,
}

struct State {
    hub: Option<BusHub>,
    owner: Option<OwnedUniqueName>,
    settings: RegistrationSettings,
    lock: PolkitLockState,
    last_error: Option<String>,
    next_id: u64,
    queue: VecDeque<Request>,
    active: Option<Active>,
}

impl State {
    fn publish(&self, kind: UpdateKind) {
        let Some(hub) = &self.hub else { return };
        let locked = self.lock == PolkitLockState::Locked;
        let active = if locked {
            None
        } else {
            self.active
                .as_ref()
                .filter(|active| active.cancelled.is_none())
                .map(|active| &active.request.view)
        };
        hub.publish_core_topic(
            TopicName::try_new(POLKIT_TOPIC).expect("session.polkit is a valid topic name"),
            json!({
                "enabled": self.settings.enabled == PolkitEnabled::Enabled,
                "registered": self.owner.is_some(),
                "locked_suppressed": locked,
                "last_error": self.last_error,
                "active": active,
            }),
            kind,
        );
    }

    fn authorize(&self, sender: Option<&UniqueName<'_>>) -> Result<(), PolkitError> {
        if sender.is_some() && self.owner.as_ref().map(OwnedUniqueName::inner) == sender {
            Ok(())
        } else {
            Err(PolkitError::NotAuthorized(
                "caller is not the registered Polkit Authority".into(),
            ))
        }
    }

    fn cancel_all(&mut self) -> Option<watch::Receiver<()>> {
        for request in self.queue.drain(..) {
            let _ = request.complete.send(Err(PolkitError::cancelled()));
        }
        self.active.as_mut().map(Active::cancel)
    }

    fn active_for_host(&mut self, request_id: u64) -> Result<&mut Active, RpcError> {
        self.active
            .as_mut()
            .filter(|active| {
                active.cancelled.is_none() && active.request.view.request_id == request_id
            })
            .ok_or_else(|| RpcError::new(ErrorCode::NotFound, "no matching active Polkit request"))
    }

    fn require_unlocked(&self) -> Result<(), RpcError> {
        if self.lock == PolkitLockState::Locked || self.settings.enabled == PolkitEnabled::Disabled
        {
            return Err(RpcError::new(
                ErrorCode::Disabled,
                "Polkit responses are disabled",
            ));
        }
        Ok(())
    }
}

/// Owns prompt state and helper lifetimes independently of the Authority connection.
pub struct PolkitService {
    state: Mutex<State>,
    helper: PolkitHelperConfig,
    registration: watch::Sender<RegistrationSettings>,
    disconnect: Mutex<Option<JoinHandle<()>>>,
}

impl fmt::Debug for PolkitService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PolkitService")
            .finish_non_exhaustive()
    }
}

impl PolkitService {
    /// Creates agent state and probes the standard locations of the system Polkit helper.
    #[must_use]
    pub fn new(settings: &PolkitSettings) -> Self {
        Self::with_helper(settings, PolkitHelperConfig::resolve_system_helper())
    }

    /// Creates agent state with an explicit helper configuration, without connecting to D-Bus.
    #[must_use]
    pub fn with_helper(settings: &PolkitSettings, helper: PolkitHelperConfig) -> Self {
        let settings = RegistrationSettings {
            enabled: settings.into(),
            generation: 0,
        };
        let (registration, _) = watch::channel(settings);
        Self {
            state: Mutex::new(State {
                hub: None,
                owner: None,
                settings,
                lock: PolkitLockState::Unlocked,
                last_error: None,
                next_id: 1,
                queue: VecDeque::new(),
                active: None,
            }),
            helper,
            registration,
            disconnect: Mutex::new(None),
        }
    }

    /// Publishes the baseline, installs host-only commands, and watches for host disconnects.
    pub fn install_on_bus(self: &Arc<Self>, hub: &BusHub) {
        {
            let mut state = self.state.lock().expect("Polkit agent state poisoned");
            state.hub = Some(hub.clone());
            state.publish(UpdateKind::SourceBaseline);
        }
        for (name, description) in [
            (
                "host.polkit-select-identity",
                "Select the active Polkit authentication identity",
            ),
            (RESPOND, "Answer the active Polkit authentication prompt"),
            (
                "host.polkit-cancel",
                "Cancel the active Polkit authentication request",
            ),
        ] {
            let weak = Arc::downgrade(self);
            let handler: CommandHandler = Arc::new(move |call| {
                let weak = weak.clone();
                Box::pin(async move {
                    let mut payload = call.params.payload;
                    let secret = if name == RESPOND {
                        payload
                            .as_mut()
                            .and_then(Value::as_object_mut)
                            .and_then(|fields| fields.remove("response"))
                            .and_then(|value| match value {
                                Value::String(text) => Some(Zeroizing::new(text)),
                                _ => None,
                            })
                    } else {
                        None
                    };
                    if call.caller.role != ClientRole::PrivilegedHost {
                        return Err(RpcError::new(
                            ErrorCode::PermissionDenied,
                            "command requires the privileged host control channel",
                        ));
                    }
                    let service = weak.upgrade().ok_or_else(|| {
                        RpcError::new(ErrorCode::Disabled, "Polkit agent is shut down")
                    })?;
                    let reaped = service.handle_host(name, payload, secret)?;
                    drop(service);
                    if let Some(mut reaped) = reaped {
                        let _ = reaped.changed().await;
                    }
                    Ok(CommandInvokeResult {
                        message: None,
                        data: None,
                    })
                })
            });
            hub.register_core_command(
                CommandName::try_new(name).expect("Polkit command name is valid"),
                description,
                handler,
            );
        }
        if let Ok(runtime) = Handle::try_current() {
            let mut disconnects = hub.subscribe_client_retired();
            let service = Arc::downgrade(self);
            let watcher = runtime.spawn(async move {
                loop {
                    match disconnects.recv().await {
                        Ok(client) if client.role == ClientRole::Public => continue,
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                    let Some(service) = service.upgrade() else {
                        break;
                    };
                    let mut state = service.state.lock().expect("Polkit agent state poisoned");
                    state.cancel_all();
                    state.publish(UpdateKind::Live);
                }
            });
            let mut task = self
                .disconnect
                .lock()
                .expect("Polkit disconnect task poisoned");
            if let Some(old) = task.replace(watcher) {
                old.abort();
            }
        }
    }

    /// Starts the Authority registration worker for the daemon's lifetime or until explicitly stopped.
    pub fn start_registration(
        self: &Arc<Self>,
        bus: PolkitBus,
        runtime: &Handle,
    ) -> PolkitRegistration {
        dbus::start(self, bus, runtime)
    }

    /// Synchronously suppresses or restores the prompt before a session lock transition commits.
    pub fn set_locked(&self, lock: PolkitLockState) {
        let mut state = self.state.lock().expect("Polkit agent state poisoned");
        if state.lock != lock {
            state.lock = lock;
            state.publish(UpdateKind::Live);
        }
    }

    /// Applies the configured enablement and cancels pending authentication on disable.
    pub fn set_enabled(&self, enabled: PolkitEnabled) {
        let mut state = self.state.lock().expect("Polkit agent state poisoned");
        if state.settings.enabled != enabled {
            state.settings.enabled = enabled;
            // Every toggle invalidates the previous registration, even if the receiver skips updates.
            state.settings.generation += 1;
            state.owner = None;
            state.last_error = None;
            state.cancel_all();
            state.publish(UpdateKind::Live);
            self.registration.send_replace(state.settings);
        }
    }

    fn registration_changes(&self) -> watch::Receiver<RegistrationSettings> {
        self.registration.subscribe()
    }

    fn register_owner(&self, generation: u64, owner: OwnedUniqueName) -> bool {
        let mut state = self.state.lock().expect("Polkit agent state poisoned");
        if state.settings.generation != generation
            || state.settings.enabled != PolkitEnabled::Enabled
        {
            return false;
        }
        state.owner = Some(owner);
        state.last_error = None;
        state.publish(UpdateKind::Live);
        true
    }

    fn registration_ended(&self, generation: u64, error: Option<String>) {
        let mut state = self.state.lock().expect("Polkit agent state poisoned");
        if state.settings.generation == generation {
            state.owner = None;
            state.last_error = error;
            state.cancel_all();
            state.publish(UpdateKind::Live);
        }
    }

    fn stop_registration(&self) -> Option<watch::Receiver<()>> {
        let mut state = self.state.lock().expect("Polkit agent state poisoned");
        state.owner = None;
        let reaped = state.cancel_all();
        state.publish(UpdateKind::Live);
        reaped
    }

    async fn enqueue(
        self: &Arc<Self>,
        sender: Option<&UniqueName<'_>>,
        input: AuthenticationRequest,
    ) -> Result<oneshot::Receiver<Completion>, PolkitError> {
        self.state
            .lock()
            .expect("Polkit agent state poisoned")
            .authorize(sender)?;
        let AuthenticationRequest {
            mut action_id,
            mut message,
            mut icon_name,
            mut details,
            cookie,
            identities,
        } = input;
        if cookie.is_empty() || !valid_frame(&cookie) {
            return Err(PolkitError::Failed("invalid authentication cookie".into()));
        }
        let identities = resolve_identities(identities, self.helper.passwd_path()).await;
        let selected_uid = crate::passwd::effective_uid()
            .filter(|uid| identities.iter().any(|identity| identity.uid == *uid))
            .or_else(|| identities.first().map(|identity| identity.uid))
            .ok_or_else(|| PolkitError::Failed("no usable local Polkit identities".into()))?;
        for text in [&mut action_id, &mut message, &mut icon_name] {
            if contains_secret(text, &cookie) {
                text.zeroize();
            }
        }
        details.retain(|key, value| {
            !contains_secret(key, &cookie) && !contains_secret(value, &cookie)
        });

        let mut state = self.state.lock().expect("Polkit agent state poisoned");
        state.authorize(sender)?;
        let duplicate = |request: &Request| request.cookie.as_str() == cookie.as_str();
        if state.queue.len() + usize::from(state.active.is_some()) >= MAX_REQUESTS
            || state.next_id > MAX_SAFE_JS_INT
            || state.queue.iter().any(duplicate)
            || state
                .active
                .as_ref()
                .is_some_and(|active| duplicate(&active.request))
        {
            return Err(PolkitError::Failed(
                "Polkit request limit reached or cookie already pending".into(),
            ));
        }
        let (complete, completion) = oneshot::channel();
        let view = PolkitPromptView {
            request_id: state.next_id,
            action_id,
            message,
            icon_name,
            details: details.into_iter().collect(),
            identities,
            selected_uid: Some(selected_uid),
            prompt: None,
            echo_on: false,
            info_message: None,
            error_message: None,
            authenticating: true,
        };
        state.next_id += 1;
        state.queue.push_back(Request {
            view,
            cookie: Arc::new(cookie),
            complete,
            responses: Vec::new(),
        });
        self.advance(&mut state);
        Ok(completion)
    }

    fn cancel_from_authority(
        &self,
        sender: Option<&UniqueName<'_>>,
        cookie: &str,
    ) -> Result<Option<watch::Receiver<()>>, PolkitError> {
        let mut state = self.state.lock().expect("Polkit agent state poisoned");
        state.authorize(sender)?;
        if let Some(active) = &mut state.active
            && active.request.cookie.as_str() == cookie
        {
            let reaped = active.cancel();
            state.publish(UpdateKind::Live);
            return Ok(Some(reaped));
        }
        if let Some(index) = state
            .queue
            .iter()
            .position(|request| request.cookie.as_str() == cookie)
            && let Some(request) = state.queue.remove(index)
        {
            let _ = request.complete.send(Err(PolkitError::cancelled()));
        }
        Ok(None)
    }

    fn handle_host(
        &self,
        name: &str,
        payload: Option<Value>,
        response: Option<Zeroizing<String>>,
    ) -> Result<Option<watch::Receiver<()>>, RpcError> {
        let mut state = self.state.lock().expect("Polkit agent state poisoned");
        let reaped = match name {
            RESPOND => {
                state.require_unlocked()?;
                let params: RequestParams = parse(payload)?;
                let response = response
                    .filter(|response| {
                        response.len() <= helper::MAX_RESPONSE_BYTES && valid_frame(response)
                    })
                    .ok_or_else(|| {
                        RpcError::new(ErrorCode::InvalidParams, "invalid Polkit response")
                    })?;
                let active = state.active_for_host(params.request_id)?;
                if active.attempt.cancel.is_none() || active.request.view.prompt.is_none() {
                    return Err(RpcError::new(
                        ErrorCode::InvalidRequest,
                        "Polkit helper is not awaiting a response",
                    ));
                }
                if active.request.responses.len() == MAX_RESPONSES {
                    return Err(RpcError::new(
                        ErrorCode::ResourceExhausted,
                        "too many Polkit responses",
                    ));
                }
                let response = Arc::new(response);
                active
                    .attempt
                    .responses
                    .try_send(Arc::clone(&response))
                    .map_err(|_| {
                        RpcError::new(
                            ErrorCode::InvalidRequest,
                            "Polkit helper is not awaiting a response",
                        )
                    })?;
                active.request.responses.push(response);
                active.request.view.authenticating = true;
                active.request.view.prompt = None;
                active.request.view.echo_on = false;
                None
            }
            "host.polkit-select-identity" => {
                state.require_unlocked()?;
                let params: SelectParams = parse(payload)?;
                let active = state.active_for_host(params.request_id)?;
                let view = &mut active.request.view;
                if !view
                    .identities
                    .iter()
                    .any(|identity| identity.uid == params.uid)
                {
                    return Err(RpcError::new(
                        ErrorCode::InvalidParams,
                        "uid is not a Polkit identity for this request",
                    ));
                }
                if view.selected_uid == Some(params.uid) {
                    return Ok(None);
                }
                view.selected_uid = Some(params.uid);
                view.prompt = None;
                view.echo_on = false;
                view.info_message = None;
                view.error_message = None;
                view.authenticating = true;
                Some(active.attempt.stop())
            }
            "host.polkit-cancel" => {
                let params: RequestParams = parse(payload)?;
                Some(state.active_for_host(params.request_id)?.cancel())
            }
            _ => {
                return Err(RpcError::new(
                    ErrorCode::MethodNotFound,
                    "unknown Polkit command",
                ));
            }
        };
        state.publish(UpdateKind::Live);
        Ok(reaped)
    }

    fn advance(self: &Arc<Self>, state: &mut State) {
        if state.active.is_none()
            && let Some(request) = state.queue.pop_front()
        {
            state.active = Some(self.start_attempt(request, 1));
            state.publish(UpdateKind::Live);
        }
    }

    fn start_attempt(self: &Arc<Self>, mut request: Request, attempts: u8) -> Active {
        let helper = self.helper.clone();
        let request_id = request.view.request_id;
        let username = request
            .view
            .identities
            .iter()
            .find(|identity| Some(identity.uid) == request.view.selected_uid)
            .expect("active Polkit request has a resolved, selected identity")
            .username
            .clone();
        let cookie = Arc::clone(&request.cookie);
        request.view.authenticating = true;
        request.view.prompt = None;
        request.view.echo_on = false;
        request.view.info_message = None;
        let (cancel, cancelled) = oneshot::channel();
        let (responses, input) = mpsc::channel(1);
        let (reap_complete, reaped) = watch::channel(());
        let service = Arc::downgrade(self);
        tokio::spawn(async move {
            let outcome = helper::run(&helper, &username, &cookie, input, cancelled, |event| {
                if let Some(service) = service.upgrade() {
                    service.helper_event(request_id, event);
                }
            })
            .await;
            if let Some(service) = service.upgrade() {
                service.helper_finished(request_id, outcome);
            }
            drop(reap_complete);
        });
        Active {
            request,
            attempt: Attempt {
                cancel: Some(cancel),
                responses,
                reaped,
            },
            attempts,
            cancelled: None,
        }
    }

    fn helper_event(&self, id: u64, event: HelperEvent) {
        let mut state = self.state.lock().expect("Polkit agent state poisoned");
        let Ok(active) = state.active_for_host(id) else {
            return;
        };
        if active.attempt.cancel.is_none() {
            return; // An identity switch is waiting on this helper's reap.
        }
        let request = &mut active.request;
        match event {
            HelperEvent::Prompt { text, echo } => {
                request.view.prompt = Some(request.display_text(text));
                request.view.echo_on = matches!(echo, Echo::On);
                request.view.authenticating = false;
            }
            HelperEvent::Info(text) => request.view.info_message = Some(request.display_text(text)),
            HelperEvent::Error(text) => {
                request.view.error_message = Some(request.display_text(text))
            }
        }
        if state.lock == PolkitLockState::Unlocked {
            state.publish(UpdateKind::Live);
        }
    }

    fn helper_finished(self: &Arc<Self>, id: u64, outcome: Result<HelperOutcome, HelperError>) {
        let mut state = self.state.lock().expect("Polkit agent state poisoned");
        if state
            .active
            .as_ref()
            .is_none_or(|active| active.request.view.request_id != id)
        {
            return;
        }
        let Some(Active {
            mut request,
            attempt,
            attempts,
            cancelled,
        }) = state.active.take()
        else {
            return;
        };
        let complete = if let Some(error) = cancelled {
            Err(error)
        } else if attempt.cancel.is_none() {
            state.active = Some(self.start_attempt(request, 1));
            state.publish(UpdateKind::Live);
            return;
        } else {
            match outcome {
                Ok(HelperOutcome::Success) => Ok(()),
                Ok(HelperOutcome::Cancelled) => Err(PolkitError::cancelled()),
                Ok(HelperOutcome::Failure) => {
                    if attempts < MAX_ATTEMPTS {
                        request
                            .view
                            .error_message
                            .get_or_insert_with(|| AUTHENTICATION_FAILED.into());
                        state.active = Some(self.start_attempt(request, attempts + 1));
                        state.publish(UpdateKind::Live);
                        return;
                    }
                    Err(PolkitError::Failed(AUTHENTICATION_FAILED.into()))
                }
                Err(error) => {
                    let message = error.to_string();
                    state.last_error = Some(message.clone());
                    Err(PolkitError::Failed(message))
                }
            }
        };
        let _ = request.complete.send(complete);
        self.advance(&mut state);
        if state.active.is_none() {
            state.publish(UpdateKind::Live);
        }
    }
}

impl Drop for PolkitService {
    fn drop(&mut self) {
        if let Ok(task) = self.disconnect.get_mut()
            && let Some(task) = task.take()
        {
            task.abort();
        }
        // Dropping the active attempt closes its cancellation channel without aborting the reap.
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestParams {
    request_id: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SelectParams {
    request_id: u64,
    uid: u32,
}

fn parse<T: serde::de::DeserializeOwned>(payload: Option<Value>) -> Result<T, RpcError> {
    payload
        .and_then(|value| serde_json::from_value(value).ok())
        .ok_or_else(|| {
            RpcError::new(
                ErrorCode::InvalidParams,
                "invalid Polkit command parameters",
            )
        })
}

fn valid_frame(text: &str) -> bool {
    !text.contains(['\n', '\r', '\0'])
}

fn contains_secret(text: &str, secret: &str) -> bool {
    !secret.is_empty() && text.contains(secret)
}

async fn resolve_identities(
    input: Identities,
    passwd_path: &std::path::Path,
) -> Vec<PolkitIdentity> {
    let mut candidate_uids = Vec::new();
    let mut seen_candidates = HashSet::new();
    for (kind, fields) in &input {
        if kind == "unix-user"
            && let Some(uid) = fields.get("uid").and_then(|val| u32::try_from(val).ok())
            && seen_candidates.insert(uid)
        {
            candidate_uids.push(uid);
        }
    }
    if candidate_uids.is_empty() {
        return Vec::new();
    }

    let passwd_path = passwd_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let mut accounts: HashMap<u32, String> = HashMap::new();
        if let Ok(passwd) = fs::read_to_string(&passwd_path) {
            for line in passwd.lines() {
                let mut fields = line.split(':');
                if let Some(username) = fields.next().filter(|name| !name.is_empty())
                    && let Some(uid) = fields.nth(1).and_then(|uid| uid.parse::<u32>().ok())
                {
                    accounts.entry(uid).or_insert_with(|| username.to_owned());
                }
            }
        }
        for &uid in &candidate_uids {
            if !accounts.contains_key(&uid)
                && let Ok(username) = crate::passwd::resolve_username_by_uid(uid)
            {
                accounts.insert(uid, username);
            }
        }
        candidate_uids
            .into_iter()
            .filter_map(|uid| {
                accounts
                    .remove(&uid)
                    .map(|username| PolkitIdentity { uid, username })
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}
