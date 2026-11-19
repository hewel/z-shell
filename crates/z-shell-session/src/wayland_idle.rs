//! Wayland `ext-idle-notify-v1` watches with stale-callback tokens.

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::thread;
use thiserror::Error;
use tokio::io::{Interest, unix::AsyncFd};
use tokio::sync::{broadcast, oneshot};
use wayland_client::backend::WaylandError;
use wayland_client::globals::{GlobalListContents, registry_queue_init};
use wayland_client::protocol::{wl_registry, wl_seat};
use wayland_client::{Connection, Dispatch, DispatchError, EventQueue, QueueHandle};
use wayland_protocols::ext::idle_notify::v1::client::{
    ext_idle_notification_v1 as notification, ext_idle_notifier_v1 as notifier,
};

use crate::idle::IdleEffect;
use crate::service::SessionService;

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
            let _ = self.connection.flush();
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

/// Owns the dedicated non-blocking `ext-idle-notify-v1` dispatch worker thread.
///
/// Dropping the driver stops the event loop cleanly and joins the worker thread.
#[must_use = "dropping the driver stops Wayland idle monitoring"]
pub struct WaylandIdleDriver {
    stop: Option<oneshot::Sender<()>>,
    thread: Option<thread::JoinHandle<()>>,
}

impl fmt::Debug for WaylandIdleDriver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WaylandIdleDriver")
            .field("running", &self.thread.is_some())
            .finish_non_exhaustive()
    }
}

impl WaylandIdleDriver {
    /// Spawns a dedicated `AsyncFd`-driven Wayland idle worker wired to `service`.
    ///
    /// Arms all currently active idle watches immediately, reacts to `StartWatch`/`CancelWatch`
    /// effects live, and forwards `idled`/`resumed` events onto `service` via `runtime`.
    ///
    /// # Errors
    ///
    /// Returns an I/O error if cloning the Wayland socket FD, building the worker runtime,
    /// or spawning the thread fails.
    pub fn spawn(
        idle: WaylandIdle,
        service: Arc<SessionService>,
        runtime: tokio::runtime::Handle,
    ) -> io::Result<Self> {
        let worker_rt = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()?;
        let fd = idle.connection.as_fd().try_clone_to_owned()?;
        let async_fd = {
            let _entered = worker_rt.enter();
            // SAFETY: AsyncFd owns the duplicated descriptor, which stays open until drop.
            unsafe { AsyncFd::register(fd) }.map_err(io::Error::from)?
        };
        let effects = service.subscribe_idle_effects();
        let (stop_tx, stop_rx) = oneshot::channel();
        let thread = thread::Builder::new()
            .name("z-shell-wayland-idle".into())
            .spawn(move || {
                worker_rt.block_on(run_idle_driver(
                    idle, async_fd, service, runtime, effects, stop_rx,
                ));
            })?;
        Ok(Self {
            stop: Some(stop_tx),
            thread: Some(thread),
        })
    }
}

impl Drop for WaylandIdleDriver {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            tracing::error!("Wayland idle worker thread panicked");
        }
    }
}

async fn run_idle_driver(
    mut idle: WaylandIdle,
    async_fd: AsyncFd<OwnedFd>,
    service: Arc<SessionService>,
    runtime: tokio::runtime::Handle,
    mut effects: broadcast::Receiver<IdleEffect>,
    mut stop: oneshot::Receiver<()>,
) {
    let mut state = State::default();
    for (rule_index, token, timeout_seconds) in service.active_idle_watches() {
        if let Err(error) = idle.watch(rule_index, token, timeout_seconds) {
            tracing::warn!(%error, rule_index, "failed to arm initial Wayland idle watch");
        }
    }

    loop {
        if let Err(error) = dispatch_pending(&mut idle, &mut state, &service, &runtime) {
            tracing::warn!(%error, "Wayland idle dispatch ended");
            service.set_idle_unavailable(format!("Wayland idle disconnected: {error}"));
            return;
        }
        let _ = idle.connection.flush();

        let Some(guard) = idle.queue.prepare_read() else {
            continue;
        };

        tokio::select! {
            biased;
            _ = &mut stop => {
                drop(guard);
                return;
            }
            effect = effects.recv() => {
                drop(guard);
                match effect {
                    Ok(IdleEffect::StartWatch { rule_index, token, timeout_seconds }) => {
                        if let Err(error) = idle.watch(rule_index, token, timeout_seconds) {
                            tracing::warn!(%error, rule_index, "failed to arm Wayland idle watch");
                        }
                    }
                    Ok(IdleEffect::CancelWatch { token, .. }) => {
                        idle.cancel(token);
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Re-sync live watches cleanly after an effect burst.
                        let active = service.active_idle_watches();
                        let desired: std::collections::HashSet<u64> =
                            active.iter().map(|(_, token, _)| *token).collect();
                        let stale: Vec<u64> = idle
                            .watches
                            .keys()
                            .copied()
                            .filter(|token| !desired.contains(token))
                            .collect();
                        for token in stale {
                            idle.cancel(token);
                        }
                        for (rule_index, token, timeout_seconds) in active {
                            if !idle.watches.contains_key(&token)
                                && let Err(error) = idle.watch(rule_index, token, timeout_seconds)
                            {
                                tracing::warn!(%error, rule_index, "failed to re-arm Wayland idle watch");
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
            ready = async_fd.ready(Interest::READABLE) => {
                let mut ready_guard = match ready {
                    Ok(ready_guard) => ready_guard,
                    Err(error) => {
                        drop(guard);
                        tracing::warn!(%error, "Wayland idle poll failed");
                        service.set_idle_unavailable(format!("Wayland idle poll failed: {error}"));
                        return;
                    }
                };
                match guard.read() {
                    Ok(_) => {}
                    Err(WaylandError::Io(io_err)) if io_err.kind() == io::ErrorKind::WouldBlock => {
                        ready_guard.clear_ready();
                    }
                    Err(error) => {
                        tracing::warn!(%error, "Wayland idle read failed");
                        service.set_idle_unavailable(format!("Wayland idle disconnected: {error}"));
                        return;
                    }
                }
            }
        }
    }
}

fn dispatch_pending(
    idle: &mut WaylandIdle,
    state: &mut State,
    service: &Arc<SessionService>,
    runtime: &tokio::runtime::Handle,
) -> Result<(), DispatchError> {
    idle.queue.dispatch_pending(state)?;
    for event in state.events.drain(..) {
        let svc = Arc::clone(service);
        runtime.spawn(async move {
            svc.handle_wayland_idle(event).await;
        });
    }
    Ok(())
}
