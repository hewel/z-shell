use std::collections::HashMap;
use std::env;
use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::runtime::Handle;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use zbus::connection::Builder;
use zbus::export::futures_core::Stream;
use zbus::fdo::{self, DBusProxy};
use zbus::message::{Header, Type};
use zbus::names::OwnedUniqueName;
use zbus::zvariant::{OwnedValue, Value};
use zbus::{Connection, MatchRule, MessageStream};
use zeroize::Zeroizing;

use super::{
    AuthenticationRequest, PolkitEnabled, PolkitError, PolkitService, RegistrationSettings,
};

const AUTHORITY_NAME: &str = "org.freedesktop.PolicyKit1";
const AUTHORITY_INTERFACE: &str = "org.freedesktop.PolicyKit1.Authority";
const AUTHORITY_PATH: &str = "/org/freedesktop/PolicyKit1/Authority";
const AGENT_PATH: &str = "/org/zshell/PolicyKit1/AuthenticationAgent";
const DBUS_NAME: &str = "org.freedesktop.DBus";
const DBUS_PATH: &str = "/org/freedesktop/DBus";
const BUS_TIMEOUT: Duration = Duration::from_secs(3);
const INITIAL_RETRY_BACKOFF: Duration = Duration::from_millis(250);
const MAX_RETRY_BACKOFF: Duration = Duration::from_secs(10);
const HEALTHY_REGISTRATION_WINDOW: Duration = Duration::from_secs(2);

type Subject = (&'static str, HashMap<&'static str, Value<'static>>);
type Identity = (String, HashMap<String, OwnedValue>);

/// Selects the bus used to contact logind and the Polkit Authority.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum PolkitBus {
    /// Use the system bus and prefer the current `XDG_SESSION_ID`.
    System,
    /// Use an explicit D-Bus address and resolve the session through its logind service.
    Address(String),
}

/// Owns the worker that registers and unregisters the agent as settings change.
#[derive(Debug)]
#[must_use = "dropping the handle shuts down the agent"]
pub struct PolkitRegistration {
    stop: Option<watch::Sender<()>>,
    worker: Option<JoinHandle<()>>,
}

impl PolkitRegistration {
    /// Stops the agent and waits for unregistration and authentication cleanup.
    pub async fn shutdown(mut self) {
        drop(self.stop.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.await;
        }
    }
}

impl Drop for PolkitRegistration {
    fn drop(&mut self) {
        // Closing the channel signals shutdown. Dropping a JoinHandle detaches, not aborts.
        drop(self.stop.take());
    }
}

pub(super) fn start(
    service: &Arc<PolkitService>,
    bus: PolkitBus,
    runtime: &Handle,
) -> PolkitRegistration {
    let changes = service.registration_changes();
    let (stop, stopped) = watch::channel(());
    let worker = runtime.spawn(run(Arc::downgrade(service), bus, changes, stopped));
    PolkitRegistration {
        stop: Some(stop),
        worker: Some(worker),
    }
}

struct Agent(Weak<PolkitService>);

#[zbus::interface(name = "org.freedesktop.PolicyKit1.AuthenticationAgent")]
impl Agent {
    #[expect(
        clippy::too_many_arguments,
        reason = "fixed Polkit D-Bus method signature"
    )]
    async fn begin_authentication(
        &self,
        action_id: String,
        message: String,
        icon_name: String,
        details: HashMap<String, String>,
        cookie: String,
        identities: Vec<Identity>,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(), PolkitError> {
        let request = AuthenticationRequest {
            action_id,
            message,
            icon_name,
            details,
            cookie: Zeroizing::new(cookie),
            identities,
        };
        let result = self
            .0
            .upgrade()
            .ok_or_else(agent_stopped)?
            .enqueue(header.sender(), request)
            .await?;
        result.await.map_err(|_| agent_stopped())?
    }

    async fn cancel_authentication(
        &self,
        cookie: &str,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(), PolkitError> {
        let reaped = self
            .0
            .upgrade()
            .ok_or_else(agent_stopped)?
            .cancel_from_authority(header.sender(), cookie)?;
        wait_for_reap(reaped).await;
        Ok(())
    }
}

fn agent_stopped() -> PolkitError {
    PolkitError::Cancelled("authentication agent stopped".into())
}

async fn wait_for_reap(reaped: Option<watch::Receiver<()>>) {
    if let Some(mut reaped) = reaped {
        let _ = reaped.changed().await;
    }
}

#[derive(Debug, thiserror::Error)]
enum RegistrationError {
    #[error("{operation}: {source}")]
    Bus {
        operation: &'static str,
        source: Box<zbus::Error>,
    },
    #[error("{0} timed out")]
    Timeout(&'static str),
    #[error("logind returned an empty session ID")]
    EmptySessionId,
    #[error("Polkit Authority owner disappeared")]
    AuthorityLost,
    #[error("Polkit agent lost its D-Bus connection")]
    Disconnected,
}

async fn bounded<T>(
    operation: &'static str,
    future: impl Future<Output = zbus::Result<T>>,
) -> Result<T, RegistrationError> {
    timeout(BUS_TIMEOUT, future)
        .await
        .map_err(|_| RegistrationError::Timeout(operation))?
        .map_err(|source| RegistrationError::Bus {
            operation,
            source: Box::new(source),
        })
}

async fn run(
    service: Weak<PolkitService>,
    bus: PolkitBus,
    mut changes: watch::Receiver<RegistrationSettings>,
    mut stopped: watch::Receiver<()>,
) {
    let mut consecutive_failures: u32 = 0;
    let mut tracked_generation = changes.borrow().generation;

    loop {
        let settings = *changes.borrow_and_update();
        if settings.generation != tracked_generation {
            tracked_generation = settings.generation;
            consecutive_failures = 0;
        }
        if settings.enabled == PolkitEnabled::Disabled {
            tokio::select! {
                biased;
                _ = stopped.changed() => break,
                changed = changes.wait_for(|current| current.generation != settings.generation) => {
                    if changed.is_err() {
                        break;
                    }
                    continue;
                }
            }
        }

        let prepared = tokio::select! {
            biased;
            _ = stopped.changed() => break,
            changed = changes.wait_for(|current| current.generation != settings.generation) => {
                if changed.is_err() {
                    break;
                }
                continue;
            }
            result = Attempt::prepare(&bus, service.clone()) => result,
        };

        let watch_authority_owner;
        match prepared {
            Ok(mut attempt) => {
                let serve_started = tokio::time::Instant::now();
                let result = attempt
                    .serve(&service, settings.generation, &mut changes, &mut stopped)
                    .await;
                if stopped.has_changed().is_err() || changes.has_changed().is_err() {
                    let reaped = service
                        .upgrade()
                        .and_then(|service| service.stop_registration());
                    attempt.cleanup().await;
                    wait_for_reap(reaped).await;
                    return;
                }
                let healthy = attempt.registration == RemoteRegistration::Confirmed
                    && serve_started.elapsed() >= HEALTHY_REGISTRATION_WINDOW;
                watch_authority_owner = matches!(result, Err(RegistrationError::AuthorityLost));
                end_generation(&service, settings.generation, result);
                attempt.cleanup().await;
                if changes.borrow().generation != settings.generation {
                    continue;
                }
                if healthy {
                    consecutive_failures = 1;
                } else {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                }
            }
            Err(error) => {
                watch_authority_owner = is_missing_authority(&error);
                end_generation(&service, settings.generation, Err(error));
                if changes.borrow().generation != settings.generation {
                    continue;
                }
                consecutive_failures = consecutive_failures.saturating_add(1);
            }
        }

        if service.upgrade().is_none() {
            break;
        }

        let delay = retry_backoff(consecutive_failures);
        let retry_mode = if !watch_authority_owner {
            RetryMode::FixedBackoff
        } else if consecutive_failures == 1 {
            RetryMode::WatchAuthorityImmediate
        } else {
            RetryMode::WatchAuthorityAfterQuietWindow
        };
        tokio::select! {
            biased;
            _ = stopped.changed() => break,
            changed = changes.wait_for(|current| current.generation != settings.generation) => {
                if changed.is_err() {
                    break;
                }
            }
            () = wait_for_retry(&bus, delay, retry_mode) => {}
        }
    }
    let reaped = service
        .upgrade()
        .and_then(|service| service.stop_registration());
    wait_for_reap(reaped).await;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RetryMode {
    FixedBackoff,
    WatchAuthorityImmediate,
    WatchAuthorityAfterQuietWindow,
}

fn retry_backoff(consecutive_failures: u32) -> Duration {
    let shift = consecutive_failures.saturating_sub(1).min(6);
    INITIAL_RETRY_BACKOFF
        .saturating_mul(1_u32 << shift)
        .min(MAX_RETRY_BACKOFF)
}

fn is_missing_authority(error: &RegistrationError) -> bool {
    match error {
        RegistrationError::AuthorityLost => true,
        RegistrationError::Bus {
            operation: "resolving the Polkit Authority owner",
            source,
        } => match source.as_ref() {
            zbus::Error::FDO(fdo_err) => matches!(
                fdo_err.as_ref(),
                fdo::Error::NameHasNoOwner(_) | fdo::Error::ServiceUnknown(_)
            ),
            zbus::Error::MethodError(name, _, _) => matches!(
                name.as_str(),
                "org.freedesktop.DBus.Error.NameHasNoOwner"
                    | "org.freedesktop.DBus.Error.ServiceUnknown"
            ),
            _ => false,
        },
        _ => false,
    }
}

async fn wait_for_retry(bus: &PolkitBus, delay: Duration, mode: RetryMode) {
    let remaining = match mode {
        RetryMode::FixedBackoff => {
            tokio::time::sleep(delay).await;
            return;
        }
        RetryMode::WatchAuthorityImmediate => delay,
        RetryMode::WatchAuthorityAfterQuietWindow => {
            let quiet = INITIAL_RETRY_BACKOFF.min(delay);
            tokio::time::sleep(quiet).await;
            match delay.checked_sub(quiet) {
                Some(rem) if !rem.is_zero() => rem,
                _ => return,
            }
        }
    };
    tokio::select! {
        () = tokio::time::sleep(remaining) => {}
        () = wait_for_authority_owner_appeared(bus) => {}
    }
}

async fn wait_for_authority_owner_appeared(bus: &PolkitBus) {
    let Ok(connection) = bounded("connecting Polkit retry watcher to D-Bus", async {
        let builder = match bus {
            PolkitBus::System => Builder::system()?,
            PolkitBus::Address(address) => Builder::address(address.as_str())?,
        };
        builder.build().await
    })
    .await
    else {
        std::future::pending::<()>().await;
        return;
    };

    let Ok(mut owner_changes) = bounded("watching Polkit Authority owner appearance", async {
        let rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(DBUS_NAME)?
            .path(DBUS_PATH)?
            .interface(DBUS_NAME)?
            .member("NameOwnerChanged")?
            .add_arg(AUTHORITY_NAME)?
            .build();
        MessageStream::for_match_rule(rule, &connection, None).await
    })
    .await
    else {
        std::future::pending::<()>().await;
        return;
    };

    if let Ok(dbus) = DBusProxy::new(&connection).await
        && let Ok(name) = AUTHORITY_NAME.try_into()
        && timeout(BUS_TIMEOUT, dbus.get_name_owner(name))
            .await
            .is_ok_and(|res| res.is_ok())
    {
        return;
    }

    loop {
        let Some(Ok(message)) = poll_fn(|cx| Pin::new(&mut owner_changes).poll_next(cx)).await
        else {
            std::future::pending::<()>().await;
            return;
        };
        let body = message.body();
        if let Ok((_, _, new_owner)) = body.deserialize::<(&str, &str, &str)>()
            && !new_owner.is_empty()
        {
            return;
        }
    }
}

fn end_generation(
    service: &Weak<PolkitService>,
    generation: u64,
    result: Result<(), RegistrationError>,
) {
    if let Some(service) = service.upgrade() {
        service.registration_ended(generation, result.err().map(|error| error.to_string()));
    }
}

struct Attempt {
    connection: Connection,
    owner_changes: MessageStream,
    owner: OwnedUniqueName,
    subject: Subject,
    registration: RemoteRegistration,
}

#[derive(Debug, PartialEq, Eq)]
enum RemoteRegistration {
    Absent,
    Confirmed,
    Uncertain,
}

impl Attempt {
    async fn prepare(
        bus: &PolkitBus,
        service: Weak<PolkitService>,
    ) -> Result<Self, RegistrationError> {
        let connection = bounded("connecting the Polkit agent to D-Bus", async {
            let builder = match bus {
                PolkitBus::System => Builder::system()?,
                PolkitBus::Address(address) => Builder::address(address.as_str())?,
            };
            builder.serve_at(AGENT_PATH, Agent(service))?.build().await
        })
        .await?;
        let session_id = session_id(&connection, bus).await?;
        let subject = (
            "unix-session",
            HashMap::from([("session-id", Value::from(session_id))]),
        );
        // Subscribe before resolving the name so a concurrent owner change cannot be missed.
        let owner_changes = bounded("subscribing to Polkit Authority owner changes", async {
            let rule = MatchRule::builder()
                .msg_type(Type::Signal)
                .sender(DBUS_NAME)?
                .path(DBUS_PATH)?
                .interface(DBUS_NAME)?
                .member("NameOwnerChanged")?
                .add_arg(AUTHORITY_NAME)?
                .build();
            MessageStream::for_match_rule(rule, &connection, None).await
        })
        .await?;
        let owner = bounded("resolving the Polkit Authority owner", async {
            let dbus = DBusProxy::new(&connection).await?;
            let name = AUTHORITY_NAME.try_into()?;
            match dbus.get_name_owner(name).await {
                Ok(owner) => Ok(owner),
                Err(fdo::Error::NameHasNoOwner(_)) => {
                    // GetNameOwner alone does not activate an installed, dormant polkitd.
                    dbus.start_service_by_name(AUTHORITY_NAME.try_into()?, 0)
                        .await?;
                    Ok(dbus.get_name_owner(AUTHORITY_NAME.try_into()?).await?)
                }
                Err(error) => Err(error.into()),
            }
        })
        .await?;
        Ok(Self {
            connection,
            owner_changes,
            owner,
            subject,
            registration: RemoteRegistration::Absent,
        })
    }

    async fn serve(
        &mut self,
        service: &Weak<PolkitService>,
        generation: u64,
        changes: &mut watch::Receiver<RegistrationSettings>,
        stopped: &mut watch::Receiver<()>,
    ) -> Result<(), RegistrationError> {
        let lost = wait_for_owner_loss(&mut self.owner_changes, &self.owner);
        tokio::pin!(lost);
        let registered = tokio::select! {
            biased;
            error = &mut lost => Err(error),
            _ = self.connection.closed() => Err(RegistrationError::Disconnected),
            result = bounded("registering the Polkit agent", async {
                self.connection
                    .call_method(
                        Some(&self.owner),
                        AUTHORITY_PATH,
                        Some(AUTHORITY_INTERFACE),
                        "RegisterAuthenticationAgent",
                        &(&self.subject, locale(), AGENT_PATH),
                    )
                    .await?;
                Ok(())
            }) => result,
        };
        // A timeout or interrupted call may already have reached the Authority. Try to undo it
        // on the same connection before closing it or beginning another settings generation.
        self.registration = match &registered {
            Ok(()) => RemoteRegistration::Confirmed,
            Err(RegistrationError::Bus { source, .. })
                if matches!(source.as_ref(), zbus::Error::MethodError(..)) =>
            {
                RemoteRegistration::Absent
            }
            Err(_) => RemoteRegistration::Uncertain,
        };
        registered?;
        if stopped.has_changed().is_err()
            || !service
                .upgrade()
                .is_some_and(|service| service.register_owner(generation, self.owner.clone()))
        {
            return Ok(());
        }
        tokio::select! {
            biased;
            _ = stopped.changed() => Ok(()),
            _ = changes.wait_for(|current| current.generation != generation) => Ok(()),
            error = &mut lost => Err(error),
            _ = self.connection.closed() => Err(RegistrationError::Disconnected),
        }
    }

    async fn cleanup(self) {
        if self.registration == RemoteRegistration::Absent || self.connection.is_closed() {
            return;
        }
        let unregistered = bounded("unregistering the Polkit agent", async {
            self.connection
                .call_method(
                    Some(&self.owner),
                    AUTHORITY_PATH,
                    Some(AUTHORITY_INTERFACE),
                    "UnregisterAuthenticationAgent",
                    &(&self.subject, AGENT_PATH),
                )
                .await?;
            Ok(())
        })
        .await;
        // After successful unregistration, in-flight handlers can use their own connection
        // refs to reply to cancelled calls. Disconnect if the transaction was uncertain or
        // unregistration failed, so even a registration that completed late cannot survive.
        if self.registration == RemoteRegistration::Uncertain || unregistered.is_err() {
            let _ = timeout(BUS_TIMEOUT, self.connection.close()).await;
        }
    }
}

async fn wait_for_owner_loss(
    changes: &mut MessageStream,
    owner: &OwnedUniqueName,
) -> RegistrationError {
    loop {
        let message = match poll_fn(|cx| Pin::new(&mut *changes).poll_next(cx)).await {
            Some(Ok(message)) => message,
            Some(Err(source)) => {
                return RegistrationError::Bus {
                    operation: "watching the Polkit Authority owner",
                    source: Box::new(source),
                };
            }
            None => return RegistrationError::Disconnected,
        };
        let body = message.body();
        let (_, old, new) = match body.deserialize::<(&str, &str, &str)>() {
            Ok(owners) => owners,
            Err(source) => {
                return RegistrationError::Bus {
                    operation: "decoding a Polkit Authority owner change",
                    source: Box::new(source),
                };
            }
        };
        if old == owner.as_str() && new != old {
            return RegistrationError::AuthorityLost;
        }
    }
}

async fn session_id(connection: &Connection, bus: &PolkitBus) -> Result<String, RegistrationError> {
    if matches!(bus, PolkitBus::System)
        && let Some(id) = nonempty_env("XDG_SESSION_ID").filter(|id| id != "auto")
    {
        return Ok(id);
    }
    let id = bounded(
        "resolving the current logind session",
        crate::logind_session::resolve_session_id(connection),
    )
    .await?;
    if id.is_empty() || id == "auto" {
        return Err(RegistrationError::EmptySessionId);
    }
    Ok(id)
}

fn locale() -> String {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(nonempty_env)
        .unwrap_or_else(|| "C".to_owned())
}

fn nonempty_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
}
