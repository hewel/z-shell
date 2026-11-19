//! `org.freedesktop.ScreenSaver` connection-cookie inhibition service.

use crate::idle::{IdleInhibitor, InhibitorSource};
use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use thiserror::Error;
use z_shell_protocol::InhibitorScope;
use zbus::message::Header;
use zbus::{Connection, fdo};

/// Well-known session-bus name owned by the idle inhibitor service.
pub const SCREENSAVER_NAME: &str = "org.freedesktop.ScreenSaver";
/// Standard object path used by ScreenSaver clients.
pub const SCREENSAVER_PATH: &str = "/org/freedesktop/ScreenSaver";
/// Compatibility object path used by existing ScreenSaver clients.
pub const SCREENSAVER_COMPAT_PATH: &str = "/ScreenSaver";

/// ScreenSaver cookie operation failure.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
pub enum ScreenSaverError {
    /// Cookie belongs to a different D-Bus connection.
    #[error("inhibition belongs to another caller")]
    AccessDenied,
    /// Cookie is unknown or was already released.
    #[error("unknown inhibition cookie")]
    UnknownCookie,
    /// Service is shut down or does not own the well-known name.
    #[error("ScreenSaver inhibition service is unavailable")]
    Unavailable,
    /// All nonzero `u32` cookie values are occupied.
    #[error("ScreenSaver cookie space exhausted")]
    CookieSpaceExhausted,
    /// D-Bus setup or monitoring failed.
    #[error("ScreenSaver D-Bus error: {0}")]
    Bus(String),
}

#[derive(Debug)]
struct CookieRecord {
    owner: String,
    application: String,
    reason: String,
}

#[derive(Debug, Default)]
struct CookieState {
    next: u32,
    accepting: bool,
    records: BTreeMap<u32, CookieRecord>,
}

/// Connection-scoped cookie registry, independent of D-Bus transport.
#[derive(Clone, Debug, Default)]
pub struct ScreenSaverRegistry {
    state: Arc<Mutex<CookieState>>,
}

impl ScreenSaverRegistry {
    /// Creates a closed registry; [`open`](Self::open) enables cookie acquisition.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts accepting inhibitors after the well-known name is acquired.
    pub fn open(&self) {
        self.state
            .lock()
            .expect("ScreenSaver registry lock poisoned")
            .accepting = true;
    }

    /// Allocates a cookie owned by one D-Bus unique connection name.
    ///
    /// # Errors
    ///
    /// Returns an error when closed or when the complete cookie space is occupied.
    pub fn inhibit(
        &self,
        owner: &str,
        application: &str,
        reason: &str,
    ) -> Result<u32, ScreenSaverError> {
        let mut state = self
            .state
            .lock()
            .expect("ScreenSaver registry lock poisoned");
        if !state.accepting {
            return Err(ScreenSaverError::Unavailable);
        }
        let first = state.next.wrapping_add(1).max(1);
        let mut cookie = first;
        loop {
            if let std::collections::btree_map::Entry::Vacant(entry) = state.records.entry(cookie) {
                entry.insert(CookieRecord {
                    owner: owner.to_owned(),
                    application: application.to_owned(),
                    reason: reason.to_owned(),
                });
                state.next = cookie;
                return Ok(cookie);
            }
            cookie = cookie.wrapping_add(1).max(1);
            if cookie == first {
                return Err(ScreenSaverError::CookieSpaceExhausted);
            }
        }
    }

    /// Releases a cookie only when its owning connection requests release.
    ///
    /// # Errors
    ///
    /// Rejects foreign cookies and unknown or already released cookies.
    pub fn uninhibit(&self, owner: &str, cookie: u32) -> Result<(), ScreenSaverError> {
        let mut state = self
            .state
            .lock()
            .expect("ScreenSaver registry lock poisoned");
        match state.records.get(&cookie) {
            Some(record) if record.owner == owner => {
                state.records.remove(&cookie);
                Ok(())
            }
            Some(_) => Err(ScreenSaverError::AccessDenied),
            None => Err(ScreenSaverError::UnknownCookie),
        }
    }

    /// Releases every cookie owned by a disconnected D-Bus connection.
    pub fn disconnect(&self, owner: &str) {
        self.state
            .lock()
            .expect("ScreenSaver registry lock poisoned")
            .records
            .retain(|_, record| record.owner != owner);
    }

    /// Clears all cookies and rejects subsequent acquisition.
    pub fn shutdown(&self) {
        let mut state = self
            .state
            .lock()
            .expect("ScreenSaver registry lock poisoned");
        state.accepting = false;
        state.records.clear();
    }

    /// Returns the number of active connection cookies.
    #[must_use]
    pub fn active_count(&self) -> usize {
        self.state
            .lock()
            .expect("ScreenSaver registry lock poisoned")
            .records
            .len()
    }

    /// Returns public inhibitor entries in deterministic cookie order.
    #[must_use]
    pub fn inhibitors(&self) -> Vec<IdleInhibitor> {
        self.state
            .lock()
            .expect("ScreenSaver registry lock poisoned")
            .records
            .iter()
            .map(|(&cookie, record)| IdleInhibitor {
                source: InhibitorSource::ScreenSaver {
                    connection: record.owner.clone(),
                    cookie,
                },
                scope: InhibitorScope::Idle,
                reason: format!("{}: {}", record.application, record.reason),
            })
            .collect()
    }
}

#[derive(Clone)]
struct ScreenSaverInterface {
    registry: ScreenSaverRegistry,
}

#[zbus::interface(name = "org.freedesktop.ScreenSaver")]
impl ScreenSaverInterface {
    async fn inhibit(
        &self,
        application: &str,
        reason: &str,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
    ) -> fdo::Result<u32> {
        let owner = header
            .sender()
            .ok_or(fdo::Error::AccessDenied("missing caller identity".into()))?;
        let cookie = self
            .registry
            .inhibit(owner.as_str(), application, reason)
            .map_err(fdo_error)?;
        let proxy = fdo::DBusProxy::new(connection).await?;
        match proxy.name_has_owner(owner.clone().into()).await {
            Ok(true) => Ok(cookie),
            Ok(false) => {
                self.registry.disconnect(owner.as_str());
                Err(fdo::Error::Failed("inhibiting caller disconnected".into()))
            }
            Err(error) => {
                self.registry.disconnect(owner.as_str());
                Err(error)
            }
        }
    }

    #[zbus(name = "UnInhibit")]
    fn uninhibit(&self, cookie: u32, #[zbus(header)] header: Header<'_>) -> fdo::Result<()> {
        let owner = header
            .sender()
            .ok_or(fdo::Error::AccessDenied("missing caller identity".into()))?;
        self.registry
            .uninhibit(owner.as_str(), cookie)
            .map_err(fdo_error)
    }

    fn get_active(&self) -> bool {
        false
    }
}

fn fdo_error(error: ScreenSaverError) -> fdo::Error {
    match error {
        ScreenSaverError::AccessDenied => fdo::Error::AccessDenied(error.to_string()),
        ScreenSaverError::UnknownCookie => fdo::Error::InvalidArgs(error.to_string()),
        ScreenSaverError::CookieSpaceExhausted => fdo::Error::LimitsExceeded(error.to_string()),
        ScreenSaverError::Unavailable | ScreenSaverError::Bus(_) => {
            fdo::Error::Failed(error.to_string())
        }
    }
}

/// Installed ScreenSaver service with explicit name and cookie teardown.
pub struct ScreenSaverServer {
    connection: Connection,
    registry: ScreenSaverRegistry,
}

impl fmt::Debug for ScreenSaverServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ScreenSaverServer")
            .field("active_cookies", &self.registry.active_count())
            .finish_non_exhaustive()
    }
}

impl ScreenSaverServer {
    /// Registers both standard paths and acquires the name without replacing or queuing behind an owner.
    ///
    /// # Errors
    ///
    /// Returns an error if object registration fails or another process already owns the name.
    pub async fn install(
        connection: Connection,
        registry: ScreenSaverRegistry,
    ) -> Result<Self, ScreenSaverError> {
        let interface = ScreenSaverInterface {
            registry: registry.clone(),
        };
        connection
            .object_server()
            .at(SCREENSAVER_PATH, interface.clone())
            .await
            .map_err(bus_error)?;
        connection
            .object_server()
            .at(SCREENSAVER_COMPAT_PATH, interface)
            .await
            .map_err(bus_error)?;
        connection
            .request_name_with_flags(SCREENSAVER_NAME, fdo::RequestNameFlags::DoNotQueue.into())
            .await
            .map_err(bus_error)?;
        registry.open();
        Ok(Self {
            connection,
            registry,
        })
    }

    /// Monitors unique-name departures and releases their cookies immediately.
    ///
    /// # Errors
    ///
    /// Returns an error if match registration, signal monitoring, or decoding fails.
    pub async fn monitor_disconnects(&self) -> Result<(), ScreenSaverError> {
        use zbus::export::futures_core::Stream;

        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .sender("org.freedesktop.DBus")
            .map_err(bus_error)?
            .path("/org/freedesktop/DBus")
            .map_err(bus_error)?
            .interface("org.freedesktop.DBus")
            .map_err(bus_error)?
            .member("NameOwnerChanged")
            .map_err(bus_error)?
            .build();
        let stream = zbus::MessageStream::for_match_rule(rule, &self.connection, None)
            .await
            .map_err(bus_error)?;
        let mut stream = std::pin::pin!(stream);
        loop {
            let message = std::future::poll_fn(|context| stream.as_mut().poll_next(context))
                .await
                .ok_or(ScreenSaverError::Unavailable)?
                .map_err(bus_error)?;
            let (name, old_owner, new_owner) = message
                .body()
                .deserialize::<(String, String, String)>()
                .map_err(bus_error)?;
            if name == SCREENSAVER_NAME
                && self
                    .connection
                    .unique_name()
                    .is_some_and(|owner| owner.as_str() == old_owner)
                && new_owner != old_owner
            {
                self.registry.shutdown();
                return Err(ScreenSaverError::Bus(
                    "ScreenSaver service ownership was lost".into(),
                ));
            }
            if name.starts_with(':') && new_owner.is_empty() {
                self.registry.disconnect(&name);
            }
        }
    }

    /// Clears cookies and releases the well-known name without affecting another owner.
    ///
    /// # Errors
    ///
    /// Returns any D-Bus error encountered while releasing the owned name.
    pub async fn shutdown(self) -> Result<(), ScreenSaverError> {
        self.registry.shutdown();
        self.connection
            .release_name(SCREENSAVER_NAME)
            .await
            .map_err(bus_error)?;
        Ok(())
    }
}

fn bus_error(error: impl std::error::Error) -> ScreenSaverError {
    ScreenSaverError::Bus(error.to_string())
}
