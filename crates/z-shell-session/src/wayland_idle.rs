//! Wayland `ext-idle-notify-v1` watches with stale-callback tokens.

use std::collections::HashMap;
use std::fmt;
use std::os::unix::net::UnixStream;
use thiserror::Error;
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::{wl_registry, wl_seat};
use wayland_client::{Connection, Dispatch, EventQueue, QueueHandle};
use wayland_protocols::ext::idle_notify::v1::client::{
    ext_idle_notification_v1 as notification, ext_idle_notifier_v1 as notifier,
};

/// Wayland idle setup or dispatch failure.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct WaylandIdleError {
    message: String,
}

impl WaylandIdleError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

/// Idle notification event bound to the policy rule and watch token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaylandIdleEvent {
    /// Seat inactivity reached the configured timeout.
    Idled {
        /// Idle policy rule index.
        rule_index: usize,
        /// Current watch token.
        token: u64,
    },
    /// Seat activity resumed after an idle event.
    Resumed {
        /// Idle policy rule index.
        rule_index: usize,
        /// Current watch token.
        token: u64,
    },
}

#[derive(Clone, Copy, Debug)]
struct Watch {
    rule_index: usize,
    token: u64,
}

#[derive(Default)]
struct State {
    events: Vec<WaylandIdleEvent>,
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(
        _state: &mut Self,
        _proxy: &wl_registry::WlRegistry,
        _event: wl_registry::Event,
        _data: &GlobalListContents,
        _connection: &Connection,
        _queue_handle: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<notification::ExtIdleNotificationV1, Watch> for State {
    fn event(
        state: &mut Self,
        _proxy: &notification::ExtIdleNotificationV1,
        event: notification::Event,
        watch: &Watch,
        _connection: &Connection,
        _queue_handle: &QueueHandle<Self>,
    ) {
        let event = match event {
            notification::Event::Idled => WaylandIdleEvent::Idled {
                rule_index: watch.rule_index,
                token: watch.token,
            },
            notification::Event::Resumed => WaylandIdleEvent::Resumed {
                rule_index: watch.rule_index,
                token: watch.token,
            },
            _ => return,
        };
        state.events.push(event);
    }
}

wayland_client::delegate_noop!(State: ignore notifier::ExtIdleNotifierV1);
wayland_client::delegate_noop!(State: ignore wl_seat::WlSeat);

/// Synchronous Wayland idle client suitable for a dedicated dispatch worker.
pub struct WaylandIdle {
    connection: Connection,
    queue: EventQueue<State>,
    notifier: notifier::ExtIdleNotifierV1,
    seat: wl_seat::WlSeat,
    watches: HashMap<u64, notification::ExtIdleNotificationV1>,
}

impl fmt::Debug for WaylandIdle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WaylandIdle")
            .field("watches", &self.watches.len())
            .finish_non_exhaustive()
    }
}

impl WaylandIdle {
    /// Connects using `WAYLAND_DISPLAY` or an inherited Wayland socket.
    ///
    /// # Errors
    ///
    /// Returns an error when connection, registry, or required global setup fails.
    pub fn connect_from_env() -> Result<Self, WaylandIdleError> {
        let connection = Connection::connect_to_env()
            .map_err(|error| WaylandIdleError::new(error.to_string()))?;
        Self::from_connection(connection)
    }

    /// Connects over an existing stream, including a mock `wayland-server` socket.
    ///
    /// # Errors
    ///
    /// Returns an error when connection, registry, or required global setup fails.
    pub fn connect_stream(stream: UnixStream) -> Result<Self, WaylandIdleError> {
        let connection = Connection::from_socket(stream)
            .map_err(|error| WaylandIdleError::new(error.to_string()))?;
        Self::from_connection(connection)
    }

    /// Binds the notifier and first seat from an existing Wayland connection.
    ///
    /// # Errors
    ///
    /// Returns an error if either required global is unavailable or binding fails.
    pub fn from_connection(connection: Connection) -> Result<Self, WaylandIdleError> {
        let (globals, queue) = registry_queue_init::<State>(&connection)
            .map_err(|error| WaylandIdleError::new(error.to_string()))?;
        let notifier = globals
            .bind(&queue.handle(), 1..=1, ())
            .map_err(|error| WaylandIdleError::new(error.to_string()))?;
        let seat = globals
            .bind(&queue.handle(), 1..=7, ())
            .map_err(|error| WaylandIdleError::new(error.to_string()))?;
        Ok(Self {
            connection,
            queue,
            notifier,
            seat,
            watches: HashMap::new(),
        })
    }

    /// Creates or replaces no watch; every token identifies exactly one notification.
    ///
    /// # Errors
    ///
    /// Rejects duplicate live tokens and Wayland request/flush failures.
    pub fn watch(
        &mut self,
        rule_index: usize,
        token: u64,
        timeout_seconds: u32,
    ) -> Result<(), WaylandIdleError> {
        if self.watches.contains_key(&token) {
            return Err(WaylandIdleError::new("duplicate live idle watch token"));
        }
        let notification = self.notifier.get_idle_notification(
            timeout_seconds.saturating_mul(1000),
            &self.seat,
            &self.queue.handle(),
            Watch { rule_index, token },
        );
        self.watches.insert(token, notification);
        self.connection
            .flush()
            .map_err(|error| WaylandIdleError::new(error.to_string()))
    }

    /// Destroys a live watch and returns whether its token was present.
    pub fn cancel(&mut self, token: u64) -> bool {
        if let Some(notification) = self.watches.remove(&token) {
            notification.destroy();
            true
        } else {
            false
        }
    }

    /// Performs a compositor roundtrip and drains all resulting idle events.
    ///
    /// # Errors
    ///
    /// Returns Wayland dispatch or connection errors.
    pub fn roundtrip(&mut self) -> Result<Vec<WaylandIdleEvent>, WaylandIdleError> {
        let mut state = State::default();
        self.queue
            .roundtrip(&mut state)
            .map_err(|error| WaylandIdleError::new(error.to_string()))?;
        self.queue
            .dispatch_pending(&mut state)
            .map_err(|error| WaylandIdleError::new(error.to_string()))?;
        Ok(std::mem::take(&mut state.events))
    }

    /// Blocks until at least one Wayland event is dispatched and drains idle events.
    ///
    /// # Errors
    ///
    /// Returns Wayland dispatch or connection errors.
    pub fn dispatch_blocking(&mut self) -> Result<Vec<WaylandIdleEvent>, WaylandIdleError> {
        let mut state = State::default();
        self.queue
            .blocking_dispatch(&mut state)
            .map_err(|error| WaylandIdleError::new(error.to_string()))?;
        Ok(std::mem::take(&mut state.events))
    }
}

impl Drop for WaylandIdle {
    fn drop(&mut self) {
        for (_, notification) in self.watches.drain() {
            notification.destroy();
        }
        self.notifier.destroy();
        let _ = self.connection.flush();
    }
}
