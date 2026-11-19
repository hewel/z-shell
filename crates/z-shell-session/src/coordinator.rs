//! Fail-closed cross-process lock, unlock, and sleep state machine.

use crate::pam::AuthOutcome;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use thiserror::Error;
use zbus::zvariant::OwnedFd;

const LOGIND_NAME: &str = "org.freedesktop.login1";
const LOGIND_PATH: &str = "/org/freedesktop/login1";
const LOGIND_INTERFACE: &str = "org.freedesktop.login1.Manager";
const LOGIND_SESSION_INTERFACE: &str = "org.freedesktop.login1.Session";

/// Asynchronous lifecycle signal received from `systemd-logind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogindEvent {
    /// `org.freedesktop.login1.Manager.PrepareForSleep(true)`.
    PrepareForSleep,
    /// `org.freedesktop.login1.Manager.PrepareForSleep(false)`.
    Wake,
    /// `org.freedesktop.login1.Session.Lock` for the current user session.
    SessionLock,
}

/// Error acquiring or using a logind sleep inhibitor.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct SleepInhibitorError {
    message: String,
}

impl SleepInhibitorError {
    /// Creates an inhibitor diagnostic without sensitive data.
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Future returned by asynchronous inhibitor operations.
pub type InhibitorFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), SleepInhibitorError>> + Send + 'a>>;

/// Mockable logind sleep-delay and suspend boundary.
pub trait SleepInhibitor: fmt::Debug + Send + Sync {
    /// Acquires or retains the delay inhibitor before sleep can be announced.
    fn acquire(&self) -> InhibitorFuture<'_>;

    /// Releases the delay inhibitor, closing its underlying file descriptor.
    fn release(&self);

    /// Reports whether a delay inhibitor is currently held.
    fn is_held(&self) -> bool;

    /// Requests system suspend after a verified lock acknowledgement.
    fn suspend(&self) -> InhibitorFuture<'_> {
        Box::pin(async {
            Err(SleepInhibitorError::new(
                "suspend is unavailable through this inhibitor",
            ))
        })
    }
}

/// Real logind delay-inhibitor owner backed by one system-bus connection.
pub struct LogindSleepInhibitor {
    connection: zbus::Connection,
    held: Mutex<Option<OwnedFd>>,
    acquisition: tokio::sync::Mutex<()>,
}

impl fmt::Debug for LogindSleepInhibitor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LogindSleepInhibitor")
            .field("held", &self.is_held())
            .finish_non_exhaustive()
    }
}

impl LogindSleepInhibitor {
    /// Connects to the system bus without yet acquiring an inhibitor.
    ///
    /// # Errors
    ///
    /// Returns a diagnostic when the system bus cannot be reached.
    pub async fn connect_system() -> Result<Self, SleepInhibitorError> {
        let connection = zbus::connection::Builder::system()
            .map_err(|error| SleepInhibitorError::new(error.to_string()))?
            .build()
            .await
            .map_err(|error| SleepInhibitorError::new(error.to_string()))?;
        Ok(Self::from_connection(connection))
    }

    /// Wraps an existing system-bus connection.
    #[must_use]
    pub fn from_connection(connection: zbus::Connection) -> Self {
        Self {
            connection,
            held: Mutex::new(None),
            acquisition: tokio::sync::Mutex::new(()),
        }
    }

    async fn proxy(&self) -> Result<zbus::Proxy<'_>, SleepInhibitorError> {
        zbus::Proxy::new(&self.connection, LOGIND_NAME, LOGIND_PATH, LOGIND_INTERFACE)
            .await
            .map_err(|error| SleepInhibitorError::new(error.to_string()))
    }

    /// Waits for the next `PrepareForSleep` signal from logind.
    ///
    /// # Errors
    ///
    /// Returns an error if signal subscription, reception, or decoding fails.
    pub async fn next_sleep_signal(&self) -> Result<SleepSignal, SleepInhibitorError> {
        use zbus::export::futures_core::Stream;

        let stream = self
            .proxy()
            .await?
            .receive_signal("PrepareForSleep")
            .await
            .map_err(|error| SleepInhibitorError::new(error.to_string()))?;
        let mut stream = std::pin::pin!(stream);
        let message = std::future::poll_fn(|context| stream.as_mut().poll_next(context))
            .await
            .ok_or_else(|| SleepInhibitorError::new("logind sleep signal stream ended"))?;
        let (sleeping,) = message
            .body()
            .deserialize::<(bool,)>()
            .map_err(|error| SleepInhibitorError::new(error.to_string()))?;
        Ok(if sleeping {
            SleepSignal::PrepareForSleep
        } else {
            SleepSignal::Wake
        })
    }

    /// Resolves the current logind session object path via PID or `XDG_SESSION_ID`.
    async fn resolve_session_path(&self) -> Option<zbus::zvariant::OwnedObjectPath> {
        let proxy = self.proxy().await.ok()?;
        if let Ok(path) = proxy
            .call::<_, _, zbus::zvariant::OwnedObjectPath>(
                "GetSessionByPID",
                &(std::process::id(),),
            )
            .await
        {
            return Some(path);
        }
        if let Ok(session_id) = std::env::var("XDG_SESSION_ID")
            && !session_id.trim().is_empty()
            && let Ok(path) = proxy
                .call::<_, _, zbus::zvariant::OwnedObjectPath>("GetSession", &(session_id,))
                .await
        {
            return Some(path);
        }
        None
    }

    /// Monitors `org.freedesktop.login1.Manager.PrepareForSleep` and (when a session path resolves)
    /// `org.freedesktop.login1.Session.Lock`, delivering every [`LogindEvent`] into `sender`.
    ///
    /// # Errors
    ///
    /// Returns an error if match-rule registration or D-Bus signal reception fails.
    pub async fn monitor_events(
        &self,
        sender: tokio::sync::mpsc::Sender<LogindEvent>,
    ) -> Result<(), SleepInhibitorError> {
        use zbus::export::futures_core::Stream;

        let sleep_rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface(LOGIND_INTERFACE)
            .map_err(|error| SleepInhibitorError::new(error.to_string()))?
            .path(LOGIND_PATH)
            .map_err(|error| SleepInhibitorError::new(error.to_string()))?
            .member("PrepareForSleep")
            .map_err(|error| SleepInhibitorError::new(error.to_string()))?
            .build();
        let sleep_stream = zbus::MessageStream::for_match_rule(sleep_rule, &self.connection, None)
            .await
            .map_err(|error| SleepInhibitorError::new(error.to_string()))?;
        let mut sleep_stream = std::pin::pin!(sleep_stream);

        let lock_stream = if let Some(session_path) = self.resolve_session_path().await {
            let lock_rule = zbus::MatchRule::builder()
                .msg_type(zbus::message::Type::Signal)
                .interface(LOGIND_SESSION_INTERFACE)
                .map_err(|error| SleepInhibitorError::new(error.to_string()))?
                .path(session_path.as_str())
                .map_err(|error| SleepInhibitorError::new(error.to_string()))?
                .member("Lock")
                .map_err(|error| SleepInhibitorError::new(error.to_string()))?
                .build();
            zbus::MessageStream::for_match_rule(lock_rule, &self.connection, None)
                .await
                .ok()
        } else {
            None
        };
        let mut lock_stream = lock_stream.map(Box::pin);

        loop {
            let event = tokio::select! {
                sleep_msg = std::future::poll_fn(|cx| sleep_stream.as_mut().poll_next(cx)) => {
                    let message = sleep_msg
                        .ok_or_else(|| SleepInhibitorError::new("logind PrepareForSleep stream ended"))?
                        .map_err(|error| SleepInhibitorError::new(error.to_string()))?;
                    let (sleeping,) = message
                        .body()
                        .deserialize::<(bool,)>()
                        .map_err(|error| SleepInhibitorError::new(error.to_string()))?;
                    if sleeping {
                        LogindEvent::PrepareForSleep
                    } else {
                        LogindEvent::Wake
                    }
                }
                lock_msg = async {
                    match lock_stream.as_mut() {
                        Some(stream) => std::future::poll_fn(|cx| stream.as_mut().poll_next(cx)).await,
                        None => std::future::pending().await,
                    }
                } => {
                    match lock_msg {
                        Some(Ok(_)) => LogindEvent::SessionLock,
                        Some(Err(error)) => {
                            tracing::debug!(%error, "logind Session.Lock stream failed; disabling session lock monitor");
                            lock_stream = None;
                            continue;
                        }
                        None => {
                            lock_stream = None;
                            continue;
                        }
                    }
                }
            };
            if sender.send(event).await.is_err() {
                return Ok(());
            }
        }
    }
}

impl SleepInhibitor for LogindSleepInhibitor {
    fn acquire(&self) -> InhibitorFuture<'_> {
        Box::pin(async move {
            let _acquisition = self.acquisition.lock().await;
            if self.is_held() {
                return Ok(());
            }
            let fd = self
                .proxy()
                .await?
                .call(
                    "Inhibit",
                    &(
                        "sleep",
                        "z-shell",
                        "Acknowledge the compositor lock before sleep",
                        "delay",
                    ),
                )
                .await
                .map_err(|error| SleepInhibitorError::new(error.to_string()))?;
            *self.held.lock().expect("logind inhibitor lock poisoned") = Some(fd);
            Ok(())
        })
    }

    fn release(&self) {
        self.held
            .lock()
            .expect("logind inhibitor lock poisoned")
            .take();
    }

    fn is_held(&self) -> bool {
        self.held
            .lock()
            .expect("logind inhibitor lock poisoned")
            .is_some()
    }

    fn suspend(&self) -> InhibitorFuture<'_> {
        Box::pin(async move {
            self.proxy()
                .await?
                .call("Suspend", &false)
                .await
                .map_err(|error| SleepInhibitorError::new(error.to_string()))
        })
    }
}

/// Single-use capability returned only over the privileged host channel.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UnlockApproval {
    /// Cryptographically random, single-use capability.
    pub token: String,
    /// Daemon boot incarnation to which this approval is scoped.
    pub daemon_instance_id: String,
    /// Active `zgui-js` host incarnation to which this approval is scoped.
    pub ui_session_generation: u64,
    /// Compositor lock object to which this approval is scoped.
    pub lock_id: u64,
    /// Authentication attempt whose fresh success created this approval.
    pub auth_attempt_id: u64,
}

impl fmt::Debug for UnlockApproval {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UnlockApproval")
            .field("token", &"[REDACTED]")
            .field("daemon_instance_id", &self.daemon_instance_id)
            .field("ui_session_generation", &self.ui_session_generation)
            .field("lock_id", &self.lock_id)
            .field("auth_attempt_id", &self.auth_attempt_id)
            .finish()
    }
}

/// Full internal lock state, including any unconsumed unlock capability.
#[derive(Clone, Debug)]
pub enum LockPhase {
    /// No compositor lock or fallback lock is active.
    Unlocked,
    /// Host lock was requested but the compositor has not acknowledged it.
    Engaging {
        /// Active lock request identifier.
        lock_id: u64,
        /// Host incarnation expected to acknowledge this lock.
        ui_session_generation: u64,
        /// Whether sleep is pending and authentication must be suppressed.
        sleep_hold: bool,
    },
    /// The compositor acknowledged `ext_session_lock_v1.locked`.
    Locked {
        /// Acknowledged lock identifier.
        lock_id: u64,
        /// Host incarnation that acknowledged this lock.
        ui_session_generation: u64,
        /// Whether sleep is pending and authentication must be suppressed.
        sleep_hold: bool,
        /// Fresh, scoped approval awaiting one consumption.
        pending_unlock: Option<UnlockApproval>,
    },
    /// Configured fallback argv was spawned without a host verification claim.
    FallbackSpawned {
        /// Fallback execution identifier; never a verified lock acknowledgement.
        lock_id: u64,
    },
}

impl LockPhase {
    /// Returns the non-secret phase discriminator.
    #[must_use]
    pub fn name(&self) -> LockPhaseName {
        match self {
            Self::Unlocked => LockPhaseName::Unlocked,
            Self::Engaging { .. } => LockPhaseName::Engaging,
            Self::Locked { .. } => LockPhaseName::Locked,
            Self::FallbackSpawned { .. } => LockPhaseName::FallbackSpawned,
        }
    }
}

/// Non-secret lock phase published on `session.lock`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LockPhaseName {
    /// No lock is active.
    Unlocked,
    /// Lock acknowledgement is pending.
    Engaging,
    /// Compositor lock is verified.
    Locked,
    /// Fallback locker was spawned but is not host-verified.
    FallbackSpawned,
}

/// Non-secret lock state safe for topic publication.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LockSnapshot {
    /// Current lock phase discriminator.
    pub phase: LockPhaseName,
    /// Current request, verified lock, or fallback execution identifier.
    pub lock_id: Option<u64>,
    /// Whether sleep is pending and fresh authentication is suppressed.
    pub sleep_hold: bool,
    /// Whether a privileged host control channel is registered.
    pub host_connected: bool,
    /// Currently registered host incarnation.
    pub ui_session_generation: Option<u64>,
    /// Latest non-secret lock or sleep diagnostic.
    pub last_error: Option<String>,
}

/// Effects produced by coordinator transitions for the daemon runtime to execute.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "action", content = "data", rename_all = "snake_case")]
pub enum CoordinatorAction {
    /// Ask the active host to create an `ext-session-lock-v1` object.
    RequestHostLock {
        /// New lock request identifier.
        lock_id: u64,
        /// Host incarnation that must acknowledge it.
        ui_session_generation: u64,
    },
    /// Close the logind sleep-delay FD after verified lock acknowledgement.
    ReleaseSleepDelayInhibitor,
    /// Re-acquire the logind sleep-delay FD after wake.
    AcquireSleepDelayInhibitor,
    /// Spawn the explicitly configured fallback argv without claiming ACK.
    SpawnFallback(Vec<String>),
    /// Execute logind suspend after a verified lock.
    Suspend,
    /// Cancel a shell-initiated suspend because lock verification failed.
    AbortSuspend {
        /// Failure explaining why suspend was not attempted.
        reason: String,
    },
    /// Warn that external sleep may proceed without a verified lock.
    UnacknowledgedSuspend {
        /// Failure explaining the missing acknowledgement.
        reason: String,
    },
}

/// Lock or authentication request rejected by the state machine.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum CoordinatorError {
    /// Operation is invalid in the current lock phase.
    #[error("operation is invalid while lock phase is {0:?}")]
    WrongState(LockPhaseName),
    /// Lock identifier is stale or unknown.
    #[error("lock identifier is stale or unknown")]
    StaleLock,
    /// Host session generation is stale or unknown.
    #[error("host session generation is stale or unknown")]
    StaleHostSession,
    /// Authentication is suppressed while sleep is pending.
    #[error("authentication is suppressed by sleep hold")]
    SleepHold,
    /// No trusted host is currently registered.
    #[error("privileged host is disconnected")]
    HostDisconnected,
    /// Another authentication attempt is already in flight.
    #[error("another authentication attempt is already in flight")]
    AuthenticationInProgress,
    /// A result belongs to an invalidated authentication attempt.
    #[error("authentication attempt is stale or unknown")]
    StaleAuthentication,
    /// PAM rejected the credentials or account.
    #[error("authentication denied: {0}")]
    AuthenticationDenied(String),
    /// Authentication could not be performed reliably.
    #[error("authentication unavailable: {0}")]
    AuthenticationUnavailable(String),
    /// Unlock token is unknown, consumed, or incorrectly scoped.
    #[error("unlock approval is invalid, consumed, or incorrectly scoped")]
    InvalidUnlockApproval,
    /// Operating-system randomness was unavailable.
    #[error("could not generate unlock approval: {0}")]
    Randomness(String),
}

/// Logind sleep transition delivered to the coordinator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SleepSignal {
    /// `PrepareForSleep(true)`: engage sleep hold and require lock ACK.
    PrepareForSleep,
    /// `PrepareForSleep(false)`: invalidate old attempts and re-arm delay inhibition.
    Wake,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SuspendOrigin {
    Shell,
    External,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AuthenticationAttempt {
    id: u64,
    lock_id: u64,
    ui_session_generation: u64,
}

/// Owns every ADR-0004 lock and sleep transition without performing PAM I/O.
#[derive(Debug)]
pub struct Coordinator {
    daemon_instance_id: String,
    phase: LockPhase,
    host_connected: bool,
    active_ui_session_generation: Option<u64>,
    sleep_hold: bool,
    pending_suspend: Option<SuspendOrigin>,
    active_authentication: Option<AuthenticationAttempt>,
    next_lock_id: u64,
    next_auth_attempt_id: u64,
    fallback_locker: Option<Vec<String>>,
    sleep_inhibitor: Arc<dyn SleepInhibitor>,
    last_error: Option<String>,
}

impl Coordinator {
    /// Creates an unlocked coordinator with no host session registered.
    #[must_use]
    pub fn new(
        daemon_instance_id: impl Into<String>,
        sleep_inhibitor: Arc<dyn SleepInhibitor>,
        fallback_locker: Option<Vec<String>>,
    ) -> Self {
        Self {
            daemon_instance_id: daemon_instance_id.into(),
            phase: LockPhase::Unlocked,
            host_connected: false,
            active_ui_session_generation: None,
            sleep_hold: false,
            pending_suspend: None,
            active_authentication: None,
            next_lock_id: 1,
            next_auth_attempt_id: 1,
            fallback_locker,
            sleep_inhibitor,
            last_error: None,
        }
    }

    /// Updates the optional fallback locker argv used only when no privileged host is connected.
    pub fn set_fallback_locker(&mut self, fallback_locker: Option<Vec<String>>) {
        self.fallback_locker = fallback_locker;
    }

    /// Returns the full internal phase for trusted callers.
    #[must_use]
    pub fn phase(&self) -> &LockPhase {
        &self.phase
    }

    /// Returns a non-secret topic-safe state snapshot.
    #[must_use]
    pub fn snapshot(&self) -> LockSnapshot {
        let lock_id = match self.phase {
            LockPhase::Unlocked => None,
            LockPhase::Engaging { lock_id, .. }
            | LockPhase::Locked { lock_id, .. }
            | LockPhase::FallbackSpawned { lock_id } => Some(lock_id),
        };
        LockSnapshot {
            phase: self.phase.name(),
            lock_id,
            sleep_hold: self.sleep_hold,
            host_connected: self.host_connected,
            ui_session_generation: self.active_ui_session_generation,
            last_error: self.last_error.clone(),
        }
    }

    /// Acquires the initial delay FD before any `PrepareForSleep` subscription starts.
    ///
    /// # Errors
    ///
    /// Returns the logind acquisition error and records a non-secret diagnostic.
    pub async fn arm_sleep_delay(&mut self) -> Result<(), SleepInhibitorError> {
        match self.sleep_inhibitor.acquire().await {
            Ok(()) => Ok(()),
            Err(error) => {
                self.last_error = Some(error.to_string());
                Err(error)
            }
        }
    }

    /// Registers or reconnects the sole trusted host incarnation.
    pub fn register_host(&mut self, ui_session_generation: u64) -> Vec<CoordinatorAction> {
        self.invalidate_authentication();
        self.host_connected = true;
        self.active_ui_session_generation = Some(ui_session_generation);
        self.last_error = None;
        match &mut self.phase {
            LockPhase::Engaging {
                lock_id,
                ui_session_generation: generation,
                ..
            } => {
                *generation = ui_session_generation;
                vec![CoordinatorAction::RequestHostLock {
                    lock_id: *lock_id,
                    ui_session_generation,
                }]
            }
            LockPhase::Locked {
                ui_session_generation: generation,
                pending_unlock,
                ..
            } => {
                *generation = ui_session_generation;
                *pending_unlock = None;
                Vec::new()
            }
            LockPhase::Unlocked | LockPhase::FallbackSpawned { .. } => Vec::new(),
        }
    }

    /// Marks the host channel disconnected without ever unlocking a verified lock.
    pub fn host_disconnected(&mut self) -> Vec<CoordinatorAction> {
        self.invalidate_authentication();
        self.host_connected = false;
        self.active_ui_session_generation = None;
        if matches!(self.phase, LockPhase::Engaging { .. }) {
            let reason = "host disconnected before lock acknowledgement".to_owned();
            self.last_error = Some(reason.clone());
            return self.failed_suspend_actions(reason);
        }
        Vec::new()
    }

    /// Requests a new lock, replacing and invalidating every earlier lock scope.
    pub fn request_lock(&mut self) -> Vec<CoordinatorAction> {
        self.begin_lock(None)
    }

    /// Requests lock-then-suspend; only a verified ACK can produce [`CoordinatorAction::Suspend`].
    pub fn request_suspend(&mut self) -> Vec<CoordinatorAction> {
        self.invalidate_authentication();
        self.sleep_hold = true;
        self.set_phase_sleep_hold();
        match self.phase {
            LockPhase::Locked { .. } => {
                self.pending_suspend = None;
                self.sleep_inhibitor.release();
                vec![
                    CoordinatorAction::ReleaseSleepDelayInhibitor,
                    CoordinatorAction::Suspend,
                ]
            }
            LockPhase::Engaging { .. } => {
                self.pending_suspend = Some(SuspendOrigin::Shell);
                Vec::new()
            }
            LockPhase::FallbackSpawned { .. } => {
                self.pending_suspend = None;
                vec![CoordinatorAction::AbortSuspend {
                    reason: "fallback locker is not a verified compositor lock".into(),
                }]
            }
            LockPhase::Unlocked => self.begin_lock(Some(SuspendOrigin::Shell)),
        }
    }

    fn begin_lock(&mut self, suspend: Option<SuspendOrigin>) -> Vec<CoordinatorAction> {
        self.invalidate_authentication();
        let lock_id = self.allocate_lock_id();
        self.pending_suspend = suspend;
        if !self.host_connected
            && let Some(argv) = self.fallback_locker.clone()
        {
            self.phase = LockPhase::FallbackSpawned { lock_id };
            let mut actions = vec![CoordinatorAction::SpawnFallback(argv)];
            if let Some(origin) = suspend {
                self.pending_suspend = None;
                let reason = "fallback locker cannot acknowledge compositor lock".to_owned();
                self.last_error = Some(reason.clone());
                actions.push(match origin {
                    SuspendOrigin::Shell => CoordinatorAction::AbortSuspend { reason },
                    SuspendOrigin::External => CoordinatorAction::UnacknowledgedSuspend { reason },
                });
            }
            return actions;
        }

        let generation = self.active_ui_session_generation.unwrap_or(0);
        self.phase = LockPhase::Engaging {
            lock_id,
            ui_session_generation: generation,
            sleep_hold: self.sleep_hold,
        };
        if self.host_connected {
            vec![CoordinatorAction::RequestHostLock {
                lock_id,
                ui_session_generation: generation,
            }]
        } else {
            let reason = "no privileged host is connected".to_owned();
            self.last_error = Some(reason.clone());
            if let Some(origin) = suspend {
                self.pending_suspend = None;
                vec![match origin {
                    SuspendOrigin::Shell => CoordinatorAction::AbortSuspend { reason },
                    SuspendOrigin::External => CoordinatorAction::UnacknowledgedSuspend { reason },
                }]
            } else {
                Vec::new()
            }
        }
    }

    /// Applies `locked` only for the active engaging lock and host generation.
    ///
    /// # Errors
    ///
    /// Rejects stale lock IDs, stale host generations, and ACKs outside `Engaging`.
    pub fn on_host_lock_acknowledged(
        &mut self,
        lock_id: u64,
        ui_session_generation: u64,
    ) -> Result<Vec<CoordinatorAction>, CoordinatorError> {
        if !self.host_connected {
            return Err(CoordinatorError::HostDisconnected);
        }
        if self.active_ui_session_generation != Some(ui_session_generation) {
            return Err(CoordinatorError::StaleHostSession);
        }
        let sleep_hold = match self.phase {
            LockPhase::Engaging {
                lock_id: active,
                ui_session_generation: generation,
                sleep_hold,
            } if active == lock_id && generation == ui_session_generation => sleep_hold,
            LockPhase::Engaging { .. } => return Err(CoordinatorError::StaleLock),
            _ => return Err(CoordinatorError::WrongState(self.phase.name())),
        };
        self.invalidate_authentication();
        self.phase = LockPhase::Locked {
            lock_id,
            ui_session_generation,
            sleep_hold,
            pending_unlock: None,
        };
        self.last_error = None;
        let origin = self.pending_suspend.take();
        let mut actions = Vec::new();
        if sleep_hold {
            self.sleep_inhibitor.release();
            actions.push(CoordinatorAction::ReleaseSleepDelayInhibitor);
        }
        if origin == Some(SuspendOrigin::Shell) {
            actions.push(CoordinatorAction::Suspend);
        }
        Ok(actions)
    }

    /// Handles `finished` before `locked` without ever claiming a verified lock.
    ///
    /// # Errors
    ///
    /// Rejects stale lock IDs and failures outside `Engaging`.
    pub fn on_host_lock_failed(
        &mut self,
        lock_id: u64,
        reason: impl Into<String>,
    ) -> Result<Vec<CoordinatorAction>, CoordinatorError> {
        match self.phase {
            LockPhase::Engaging {
                lock_id: active, ..
            } if active == lock_id => {}
            LockPhase::Engaging { .. } => return Err(CoordinatorError::StaleLock),
            _ => return Err(CoordinatorError::WrongState(self.phase.name())),
        }
        let reason = reason.into();
        self.invalidate_authentication();
        self.phase = LockPhase::Unlocked;
        self.sleep_hold = false;
        self.last_error = Some(reason.clone());
        Ok(self.failed_suspend_actions(reason))
    }

    fn failed_suspend_actions(&mut self, reason: String) -> Vec<CoordinatorAction> {
        match self.pending_suspend.take() {
            Some(SuspendOrigin::Shell) => vec![CoordinatorAction::AbortSuspend { reason }],
            Some(SuspendOrigin::External) => {
                vec![CoordinatorAction::UnacknowledgedSuspend { reason }]
            }
            None => Vec::new(),
        }
    }

    /// Handles logind sleep transitions and invalidates all pre-transition authentication.
    pub async fn on_sleep_signal(&mut self, signal: SleepSignal) -> Vec<CoordinatorAction> {
        self.invalidate_authentication();
        match signal {
            SleepSignal::PrepareForSleep => {
                self.sleep_hold = true;
                self.set_phase_sleep_hold();
                match self.phase {
                    LockPhase::Locked { .. } => {
                        self.pending_suspend = None;
                        self.sleep_inhibitor.release();
                        vec![CoordinatorAction::ReleaseSleepDelayInhibitor]
                    }
                    LockPhase::Engaging { .. } => {
                        self.pending_suspend = Some(SuspendOrigin::External);
                        Vec::new()
                    }
                    LockPhase::FallbackSpawned { .. } => {
                        self.pending_suspend = None;
                        vec![CoordinatorAction::UnacknowledgedSuspend {
                            reason: "fallback locker cannot acknowledge external suspend".into(),
                        }]
                    }
                    LockPhase::Unlocked => self.begin_lock(Some(SuspendOrigin::External)),
                }
            }
            SleepSignal::Wake => {
                self.sleep_hold = false;
                self.set_phase_sleep_hold();
                self.pending_suspend = None;
                let mut actions = vec![CoordinatorAction::AcquireSleepDelayInhibitor];
                if let Err(error) = self.sleep_inhibitor.acquire().await {
                    self.last_error = Some(error.to_string());
                }
                if self.last_error.is_none() {
                    actions.shrink_to_fit();
                }
                actions
            }
        }
    }

    /// Starts a fresh authentication attempt only while verified-locked and awake.
    ///
    /// # Errors
    ///
    /// Rejects sleep hold, disconnected/stale hosts, stale locks, and concurrent attempts.
    pub fn begin_authentication(
        &mut self,
        lock_id: u64,
        ui_session_generation: u64,
    ) -> Result<u64, CoordinatorError> {
        if !self.host_connected {
            return Err(CoordinatorError::HostDisconnected);
        }
        if self.sleep_hold {
            return Err(CoordinatorError::SleepHold);
        }
        if self.active_ui_session_generation != Some(ui_session_generation) {
            return Err(CoordinatorError::StaleHostSession);
        }
        match self.phase {
            LockPhase::Locked {
                lock_id: active,
                ui_session_generation: generation,
                ..
            } if active == lock_id && generation == ui_session_generation => {}
            LockPhase::Locked { .. } => return Err(CoordinatorError::StaleLock),
            _ => return Err(CoordinatorError::WrongState(self.phase.name())),
        }
        if self.active_authentication.is_some() {
            return Err(CoordinatorError::AuthenticationInProgress);
        }
        let id = self.next_auth_attempt_id;
        self.next_auth_attempt_id = self
            .next_auth_attempt_id
            .checked_add(1)
            .expect("authentication attempt ID space exhausted");
        self.active_authentication = Some(AuthenticationAttempt {
            id,
            lock_id,
            ui_session_generation,
        });
        Ok(id)
    }

    /// Completes an in-flight attempt and creates at most one scoped unlock approval.
    ///
    /// # Errors
    ///
    /// Rejects stale attempts, including every pre-sleep result, and propagates safe PAM outcomes.
    pub fn complete_authentication(
        &mut self,
        auth_attempt_id: u64,
        lock_id: u64,
        ui_session_generation: u64,
        outcome: AuthOutcome,
    ) -> Result<UnlockApproval, CoordinatorError> {
        let expected = AuthenticationAttempt {
            id: auth_attempt_id,
            lock_id,
            ui_session_generation,
        };
        if self.active_authentication != Some(expected) || self.sleep_hold {
            return Err(CoordinatorError::StaleAuthentication);
        }
        match self.phase {
            LockPhase::Locked {
                lock_id: active,
                ui_session_generation: generation,
                ..
            } if active == lock_id && generation == ui_session_generation => {}
            _ => return Err(CoordinatorError::StaleAuthentication),
        }
        self.active_authentication = None;
        match outcome {
            AuthOutcome::Denied { message } => {
                self.last_error = Some(message.clone());
                Err(CoordinatorError::AuthenticationDenied(message))
            }
            AuthOutcome::Unavailable { reason } => {
                self.last_error = Some(reason.clone());
                Err(CoordinatorError::AuthenticationUnavailable(reason))
            }
            AuthOutcome::Authenticated => {
                let approval = UnlockApproval {
                    token: random_token()?,
                    daemon_instance_id: self.daemon_instance_id.clone(),
                    ui_session_generation,
                    lock_id,
                    auth_attempt_id,
                };
                if let LockPhase::Locked { pending_unlock, .. } = &mut self.phase {
                    *pending_unlock = Some(approval.clone());
                }
                self.last_error = None;
                Ok(approval)
            }
        }
    }

    /// Consumes a scoped unlock capability at most once.
    ///
    /// # Errors
    ///
    /// Returns the same error for unknown, consumed, stale-generation, and stale-lock tokens.
    pub fn consume_unlock(
        &mut self,
        token: &str,
        ui_session_generation: u64,
        lock_id: u64,
    ) -> Result<(), CoordinatorError> {
        if self.sleep_hold {
            return Err(CoordinatorError::InvalidUnlockApproval);
        }
        let valid = matches!(
            &self.phase,
            LockPhase::Locked {
                lock_id: active_lock,
                ui_session_generation: active_generation,
                pending_unlock: Some(approval),
                ..
            } if *active_lock == lock_id
                && *active_generation == ui_session_generation
                && approval.token == token
                && approval.daemon_instance_id == self.daemon_instance_id
                && approval.lock_id == lock_id
                && approval.ui_session_generation == ui_session_generation
        );
        if !valid {
            return Err(CoordinatorError::InvalidUnlockApproval);
        }
        self.active_authentication = None;
        self.phase = LockPhase::Unlocked;
        self.last_error = None;
        Ok(())
    }

    fn invalidate_authentication(&mut self) {
        self.active_authentication = None;
        if let LockPhase::Locked { pending_unlock, .. } = &mut self.phase {
            *pending_unlock = None;
        }
    }

    fn set_phase_sleep_hold(&mut self) {
        match &mut self.phase {
            LockPhase::Engaging { sleep_hold, .. } | LockPhase::Locked { sleep_hold, .. } => {
                *sleep_hold = self.sleep_hold;
            }
            LockPhase::Unlocked | LockPhase::FallbackSpawned { .. } => {}
        }
    }

    fn allocate_lock_id(&mut self) -> u64 {
        let id = self.next_lock_id;
        self.next_lock_id = self
            .next_lock_id
            .checked_add(1)
            .expect("lock ID space exhausted");
        id
    }
}

fn random_token() -> Result<String, CoordinatorError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| CoordinatorError::Randomness(error.to_string()))?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        token.push(char::from(HEX[usize::from(byte >> 4)]));
        token.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    Ok(token)
}
