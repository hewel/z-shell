//! Dedicated native Wayland data-control capture, backup ownership, and nonblocking transfers.

use crate::payload::looks_complete;
use crate::{PASSWORD_MANAGER_HINT, Payload, choose_mime, offer_is_sensitive};
use rustix::event::{PollFd, PollFlags, Timespec, poll};
use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::os::fd::{AsFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use thiserror::Error;
use wayland_client::backend::{ObjectId, WaylandError};
use wayland_client::protocol::{wl_callback, wl_registry, wl_seat};
use wayland_client::{Connection, Dispatch, EventQueue, Proxy, QueueHandle};
use wayland_protocols::ext::data_control::v1::client::{
    ext_data_control_device_v1 as ext_device, ext_data_control_manager_v1 as ext_manager,
    ext_data_control_offer_v1 as ext_offer, ext_data_control_source_v1 as ext_source,
};
use wayland_protocols_wlr::data_control::v1::client::{
    zwlr_data_control_device_v1 as wlr_device, zwlr_data_control_manager_v1 as wlr_manager,
    zwlr_data_control_offer_v1 as wlr_offer, zwlr_data_control_source_v1 as wlr_source,
};

const MAX_TRANSPORT_BYTES: usize = 200 * 1024 * 1024;
const MAX_COMMANDS: usize = 8;
const MAX_WRITES: usize = 8;
const MAX_OFFERS: usize = 64;
const MAX_MIMES: usize = 128;
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(10);
const INIT_TIMEOUT: Duration = Duration::from_secs(5);
const IO_QUANTUM: usize = 256 * 1024;

/// Native transport failure without clipboard content in diagnostics.
#[derive(Clone, Debug, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct TransportError(String);

impl TransportError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

/// Events emitted by the dedicated Wayland worker.
#[derive(Debug)]
pub enum Event {
    /// Protocol initialization succeeded or transport became unavailable.
    Availability(Result<(), TransportError>),
    /// A single transfer failed while the connection remains usable.
    TransferError(TransportError),
    /// A complete validated non-sensitive selection was received.
    Selection(Payload),
    /// A previously accepted copy request was flushed or failed.
    Copied(u64, Result<(), TransportError>),
}

struct Inbox {
    commands: VecDeque<(u64, Payload)>,
    stopped: bool,
}

/// Running native transport; dropping it wakes and joins its Wayland worker.
pub struct Transport {
    inbox: Arc<Mutex<Inbox>>,
    wake: UnixStream,
    worker: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for Transport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Transport").finish_non_exhaustive()
    }
}

impl Transport {
    /// Connects to the session compositor without consuming `WAYLAND_SOCKET`.
    ///
    /// # Errors
    ///
    /// Returns an I/O error if the wake socket or worker cannot be created. Protocol connection
    /// failures are delivered asynchronously through [`Event::Availability`].
    pub fn connect_from_env(notify: impl Fn(Event) + Send + 'static) -> io::Result<Self> {
        Self::spawn(notify, connect_environment)
    }

    /// Connects over an existing Wayland stream, including a mock server socket pair.
    ///
    /// # Errors
    ///
    /// Returns an I/O error if the wake socket or worker cannot be created.
    pub fn connect_stream(
        stream: UnixStream,
        notify: impl Fn(Event) + Send + 'static,
    ) -> io::Result<Self> {
        Self::spawn(notify, move || Connection::from_socket(stream))
    }

    fn spawn<E: std::fmt::Display + 'static>(
        notify: impl Fn(Event) + Send + 'static,
        connect: impl FnOnce() -> Result<Connection, E> + Send + 'static,
    ) -> io::Result<Self> {
        let (wake, reader) = UnixStream::pair()?;
        wake.set_nonblocking(true)?;
        reader.set_nonblocking(true)?;
        let inbox = Arc::new(Mutex::new(Inbox {
            commands: VecDeque::with_capacity(MAX_COMMANDS),
            stopped: false,
        }));
        let shared = Arc::clone(&inbox);
        let worker = thread::Builder::new()
            .name("z-shell-clipboard-wayland".to_owned())
            .spawn(move || {
                let mut state = State::new(Box::new(notify));
                let result = connect()
                    .map_err(|error| TransportError::new(error.to_string()))
                    .and_then(|connection| run(connection, &reader, &shared, &mut state));
                let error = result
                    .err()
                    .unwrap_or_else(|| TransportError::new("clipboard transport stopped"));
                let pending = {
                    let mut inbox = shared.lock().expect("clipboard inbox lock poisoned");
                    inbox.stopped = true;
                    std::mem::take(&mut inbox.commands)
                };
                for (request, _) in pending {
                    (state.notify)(Event::Copied(request, Err(error.clone())));
                }
                for request in state.acknowledgements.drain(..) {
                    (state.notify)(Event::Copied(request, Err(error.clone())));
                }
                if !state.shutdown {
                    (state.notify)(Event::Availability(Err(error)));
                }
            })?;
        Ok(Self {
            inbox,
            wake,
            worker: Some(worker),
        })
    }

    /// Queues original payload bytes for native ownership and returns a request token.
    ///
    /// # Errors
    ///
    /// Returns [`TransportError`] if the queue is full, stopped, or the payload is incomplete.
    pub fn copy(&self, request: u64, payload: Payload) -> Result<(), TransportError> {
        validate_payload(&payload)?;
        let mut inbox = self.inbox.lock().expect("clipboard inbox lock poisoned");
        if inbox.stopped {
            return Err(TransportError::new("clipboard transport is not running"));
        }
        if inbox.commands.len() == MAX_COMMANDS {
            return Err(TransportError::new("clipboard copy queue is full"));
        }
        inbox.commands.push_back((request, payload));
        wake(&self.wake);
        Ok(())
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.inbox
            .lock()
            .expect("clipboard inbox lock poisoned")
            .stopped = true;
        wake(&self.wake);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn wake(mut socket: &UnixStream) {
    // A full socket is already readable, so a coalesced wake cannot be lost.
    let _ = socket.write(&[1]);
}

#[derive(Clone)]
enum Manager {
    Ext(ext_manager::ExtDataControlManagerV1),
    Wlr(wlr_manager::ZwlrDataControlManagerV1),
}

#[derive(Clone)]
enum Device {
    Ext(ext_device::ExtDataControlDeviceV1),
    Wlr(wlr_device::ZwlrDataControlDeviceV1),
}

#[derive(Clone)]
enum Offer {
    Ext(ext_offer::ExtDataControlOfferV1),
    Wlr(wlr_offer::ZwlrDataControlOfferV1),
}

impl Offer {
    fn id(&self) -> ObjectId {
        match self {
            Self::Ext(offer) => offer.id(),
            Self::Wlr(offer) => offer.id(),
        }
    }

    fn receive(&self, mime: String, fd: &OwnedFd) {
        match self {
            Self::Ext(offer) => offer.receive(mime, fd.as_fd()),
            Self::Wlr(offer) => offer.receive(mime, fd.as_fd()),
        }
    }

    fn destroy(&self) {
        match self {
            Self::Ext(offer) => offer.destroy(),
            Self::Wlr(offer) => offer.destroy(),
        }
    }
}

#[derive(Clone)]
enum Source {
    Ext(ext_source::ExtDataControlSourceV1),
    Wlr(wlr_source::ZwlrDataControlSourceV1),
}

impl Source {
    fn id(&self) -> ObjectId {
        match self {
            Self::Ext(source) => source.id(),
            Self::Wlr(source) => source.id(),
        }
    }

    fn offer(&self, mime: String) {
        match self {
            Self::Ext(source) => source.offer(mime),
            Self::Wlr(source) => source.offer(mime),
        }
    }

    fn destroy(&self) {
        if !match self {
            Self::Ext(source) => source.is_alive(),
            Self::Wlr(source) => source.is_alive(),
        } {
            return;
        }
        match self {
            Self::Ext(source) => source.destroy(),
            Self::Wlr(source) => source.destroy(),
        }
    }
}

struct Offered {
    proxy: Offer,
    mimes: Vec<String>,
}

struct SourceData {
    payload: Payload,
    mimes: Vec<String>,
}

struct Incoming {
    fd: OwnedFd,
    generation: u64,
    mime: String,
    bytes: Vec<u8>,
    deadline: Instant,
}

struct Outgoing {
    fd: OwnedFd,
    bytes: Arc<[u8]>,
    offset: usize,
    deadline: Instant,
}

#[derive(Default)]
struct Selection {
    generation: u64,
    backup: Option<Payload>,
    pending_null: bool,
}

impl Selection {
    fn changed(&mut self, empty: bool) {
        self.generation = self.generation.wrapping_add(1);
        self.pending_null = empty;
        if !empty {
            // A new unsupported, sensitive, or failed offer must not resurrect old content.
            self.backup = None;
        }
    }

    fn complete(&mut self, generation: u64, payload: &Payload) -> bool {
        if generation != self.generation || self.pending_null {
            return false;
        }
        if looks_complete(payload.mime(), payload.bytes()) {
            self.backup = Some(payload.clone());
        }
        true
    }

    fn orphan(&mut self) -> Option<Payload> {
        if !std::mem::take(&mut self.pending_null) {
            return None;
        }
        self.backup.take()
    }
}

struct State {
    notify: Box<dyn Fn(Event) + Send>,
    globals: HashMap<u32, (String, u32)>,
    registry: Option<wl_registry::WlRegistry>,
    bound_globals: Vec<u32>,
    manager: Option<Manager>,
    device: Option<Device>,
    offers: HashMap<ObjectId, Offered>,
    source: Option<Source>,
    selection: Selection,
    incoming: Option<Incoming>,
    outgoing: Vec<Outgoing>,
    acknowledgements: Vec<u64>,
    ready: bool,
    shutdown: bool,
    failure: Option<TransportError>,
    initialization_deadline: Instant,
}

impl State {
    fn new(notify: Box<dyn Fn(Event) + Send>) -> Self {
        Self {
            notify,
            globals: HashMap::new(),
            registry: None,
            bound_globals: Vec::new(),
            manager: None,
            device: None,
            offers: HashMap::new(),
            source: None,
            selection: Selection::default(),
            incoming: None,
            outgoing: Vec::new(),
            acknowledgements: Vec::with_capacity(MAX_COMMANDS),
            ready: false,
            shutdown: false,
            failure: None,
            initialization_deadline: Instant::now() + INIT_TIMEOUT,
        }
    }

    fn bind(&mut self, connection: &Connection, qh: &QueueHandle<Self>) {
        let registry = self
            .registry
            .as_ref()
            .expect("registry precedes the discovery callback");
        let seat = self
            .globals
            .iter()
            .filter(|(_, (name, _))| name == "wl_seat")
            .min_by_key(|(id, _)| **id)
            .map(|(id, (_, version))| (*id, *version));
        let manager = [
            "ext_data_control_manager_v1",
            "zwlr_data_control_manager_v1",
        ]
        .into_iter()
        .find_map(|wanted| {
            self.globals
                .iter()
                .find(|(_, (name, _))| name == wanted)
                .map(|(id, (name, version))| (*id, name.clone(), *version))
        });
        let (Some((seat_id, seat_version)), Some((manager_id, name, version))) = (seat, manager)
        else {
            self.failure = Some(TransportError::new(
                "compositor does not expose a seat and ext-data-control or wlr-data-control",
            ));
            return;
        };
        let seat: wl_seat::WlSeat = registry.bind(seat_id, seat_version.min(2), qh, ());
        let (manager, device) = if name == "ext_data_control_manager_v1" {
            let manager: ext_manager::ExtDataControlManagerV1 =
                registry.bind(manager_id, version.min(1), qh, ());
            let device = manager.get_data_device(&seat, qh, ());
            (Manager::Ext(manager), Device::Ext(device))
        } else {
            let manager: wlr_manager::ZwlrDataControlManagerV1 =
                registry.bind(manager_id, version.min(2), qh, ());
            let device = manager.get_data_device(&seat, qh, ());
            (Manager::Wlr(manager), Device::Wlr(device))
        };
        self.bound_globals = vec![seat_id, manager_id];
        self.manager = Some(manager);
        self.device = Some(device);
        connection.display().sync(qh, 1_u8);
    }

    fn offer(&mut self, proxy: Offer) {
        if self.offers.len() >= MAX_OFFERS {
            proxy.destroy();
            return;
        }
        self.offers.insert(
            proxy.id(),
            Offered {
                proxy,
                mimes: Vec::new(),
            },
        );
    }

    fn mime(&mut self, id: ObjectId, mime: String) {
        if let Some(offer) = self.offers.get_mut(&id) {
            if offer.mimes.len() < MAX_MIMES && mime.len() <= 256 {
                offer.mimes.push(mime);
            } else if mime == PASSWORD_MANAGER_HINT {
                // A MIME flood must never hide the sensitive marker.
                offer.mimes.clear();
                offer.mimes.push(PASSWORD_MANAGER_HINT.to_owned());
            }
        }
    }

    fn selected(&mut self, offer: Option<Offer>) {
        self.incoming = None;
        self.selection.changed(offer.is_none());
        let Some(offer) = offer else { return };
        let Some(offered) = self.offers.remove(&offer.id()) else {
            offer.destroy();
            return;
        };
        let mime = if offer_is_sensitive(&offered.mimes) {
            None
        } else {
            choose_mime(&offered.mimes)
        };
        let offer = offered.proxy;
        if let Some(mime) = mime {
            match pipe() {
                Ok((reader, writer)) => {
                    if let Err(error) = nonblocking(&reader) {
                        self.report(TransportError::new(error.to_string()));
                    } else {
                        offer.receive(mime.clone(), &writer);
                        self.incoming = Some(Incoming {
                            fd: reader,
                            generation: self.selection.generation,
                            mime,
                            bytes: Vec::new(),
                            deadline: Instant::now() + TRANSFER_TIMEOUT,
                        });
                    }
                }
                Err(error) => self.report(TransportError::new(error.to_string())),
            }
        }
        offer.destroy();
    }

    fn primary(&mut self, offer: Option<Offer>) {
        if let Some(offer) = offer {
            self.offers.remove(&offer.id());
            offer.destroy();
        }
    }

    fn own(&mut self, payload: Payload, qh: &QueueHandle<Self>) -> Result<(), TransportError> {
        validate_payload(&payload)?;
        let data = Arc::new(SourceData {
            mimes: payload.copy_mimes(),
            payload,
        });
        let source = match self.manager.as_ref().zip(self.device.as_ref()) {
            Some((Manager::Ext(manager), Device::Ext(_))) => {
                Source::Ext(manager.create_data_source(qh, data.clone()))
            }
            Some((Manager::Wlr(manager), Device::Wlr(_))) => {
                Source::Wlr(manager.create_data_source(qh, data.clone()))
            }
            _ => {
                return Err(TransportError::new(
                    "clipboard data-control device is unavailable",
                ));
            }
        };
        for mime in &data.mimes {
            source.offer(mime.clone());
        }
        match (self.device.as_ref(), &source) {
            (Some(Device::Ext(device)), Source::Ext(source)) => device.set_selection(Some(source)),
            (Some(Device::Wlr(device)), Source::Wlr(source)) => device.set_selection(Some(source)),
            _ => unreachable!("manager and device always use the same protocol"),
        }
        if let Some(previous) = self.source.replace(source) {
            previous.destroy();
        }
        self.incoming = None;
        self.selection.changed(false);
        self.selection
            .complete(self.selection.generation, &data.payload);
        Ok(())
    }

    fn send(&mut self, data: &SourceData, mime: &str, fd: OwnedFd) {
        if !data.mimes.iter().any(|advertised| advertised == mime) {
            return;
        }
        if self.outgoing.len() == MAX_WRITES {
            self.report(TransportError::new(
                "too many simultaneous clipboard transfers",
            ));
            return;
        }
        if let Err(error) = nonblocking(&fd) {
            self.report(TransportError::new(error.to_string()));
            return;
        }
        self.outgoing.push(Outgoing {
            fd,
            bytes: Arc::clone(&data.payload.bytes),
            offset: 0,
            deadline: Instant::now() + TRANSFER_TIMEOUT,
        });
    }

    fn cancelled(&mut self, source: Source) {
        if self
            .source
            .as_ref()
            .is_some_and(|current| current.id() == source.id())
        {
            self.source = None;
        }
        source.destroy();
    }

    fn report(&self, error: TransportError) {
        (self.notify)(Event::TransferError(error));
    }

    fn transfer(&mut self, now: Instant) {
        if self
            .incoming
            .as_ref()
            .is_some_and(|read| read.deadline <= now)
        {
            self.incoming = None;
            self.report(TransportError::new("clipboard receive timed out"));
        }
        if let Some(read) = self.incoming.as_mut() {
            match read.progress(MAX_TRANSPORT_BYTES) {
                Ok(Some(payload)) => {
                    let generation = read.generation;
                    self.incoming = None;
                    if self.selection.complete(generation, &payload) {
                        (self.notify)(Event::Selection(payload));
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    self.incoming = None;
                    self.report(error);
                }
            }
        }
        let mut index = 0;
        while index < self.outgoing.len() {
            let result = if self.outgoing[index].deadline <= now {
                Err(TransportError::new("clipboard send timed out"))
            } else {
                self.outgoing[index].progress()
            };
            match result {
                Ok(false) => index += 1,
                result => {
                    self.outgoing.swap_remove(index);
                    if let Err(error) = result {
                        self.report(error);
                    }
                }
            }
        }
    }
}

fn run(
    connection: Connection,
    wake: &UnixStream,
    inbox: &Mutex<Inbox>,
    state: &mut State,
) -> Result<(), TransportError> {
    let mut queue = connection.new_event_queue::<State>();
    let qh = queue.handle();
    state.registry = Some(connection.display().get_registry(&qh, ()));
    connection.display().sync(&qh, 0_u8);
    loop {
        if inbox.lock().expect("clipboard inbox lock poisoned").stopped {
            state.shutdown = true;
            return Ok(());
        }
        let drained = drain(&mut queue, state)?;
        if let Some(error) = state.failure.take() {
            return Err(error);
        }
        if !state.ready && Instant::now() >= state.initialization_deadline {
            return Err(TransportError::new(
                "clipboard protocol initialization timed out",
            ));
        }
        for _ in 0..MAX_COMMANDS {
            let command = inbox
                .lock()
                .expect("clipboard inbox lock poisoned")
                .commands
                .pop_front();
            let Some((request, payload)) = command else {
                break;
            };
            let result = if !state.ready {
                Err(TransportError::new("clipboard protocol is not ready"))
            } else if state.acknowledgements.len() == MAX_COMMANDS {
                Err(TransportError::new(
                    "compositor is not accepting copy requests",
                ))
            } else {
                state.own(payload, &qh)
            };
            match result {
                Ok(()) => state.acknowledgements.push(request),
                Err(error) => (state.notify)(Event::Copied(request, Err(error))),
            }
        }
        if drained {
            if let Some(payload) = state.selection.orphan()
                && let Err(error) = state.own(payload, &qh)
            {
                state.report(error);
            }
            state.transfer(Instant::now());
        }
        let needs_flush = match connection.flush() {
            Ok(()) => {
                for request in state.acknowledgements.drain(..) {
                    (state.notify)(Event::Copied(request, Ok(())));
                }
                false
            }
            Err(WaylandError::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => true,
            Err(error) => return Err(TransportError::new(error.to_string())),
        };
        if !drained {
            continue;
        }
        let Some(guard) = queue.prepare_read() else {
            continue;
        };
        let mut fds: [PollFd<'_>; MAX_WRITES + 3] =
            std::array::from_fn(|_| PollFd::new(wake, PollFlags::empty()));
        fds[0] = PollFd::new(wake, PollFlags::IN);
        fds[1] = PollFd::new(
            &connection,
            PollFlags::IN
                | if needs_flush {
                    PollFlags::OUT
                } else {
                    PollFlags::empty()
                },
        );
        let mut fd_count = 2;
        if let Some(read) = &state.incoming {
            fds[fd_count] = PollFd::new(&read.fd, PollFlags::IN);
            fd_count += 1;
        }
        for write in &state.outgoing {
            fds[fd_count] = PollFd::new(&write.fd, PollFlags::OUT);
            fd_count += 1;
        }
        let deadline = state
            .incoming
            .iter()
            .map(|read| read.deadline)
            .chain(state.outgoing.iter().map(|write| write.deadline))
            .chain((!state.ready).then_some(state.initialization_deadline))
            .min();
        let timeout =
            deadline.map(|deadline| timespec(deadline.saturating_duration_since(Instant::now())));
        match poll(&mut fds[..fd_count], timeout.as_ref()) {
            Ok(_) => {}
            Err(rustix::io::Errno::INTR) => {
                drop(guard);
                continue;
            }
            Err(error) => return Err(TransportError::new(error.to_string())),
        }
        let wake_ready = !fds[0].revents().is_empty();
        let wayland_ready = fds[1]
            .revents()
            .intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR);
        if wayland_ready {
            match guard.read() {
                Ok(_) => {}
                Err(WaylandError::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => return Err(TransportError::new(error.to_string())),
            }
        } else {
            drop(guard);
        }
        if wake_ready {
            let mut socket = wake;
            let mut bytes = [0; 128];
            loop {
                match socket.read(&mut bytes) {
                    Ok(0) => return Err(TransportError::new("clipboard wake socket closed")),
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) => return Err(TransportError::new(error.to_string())),
                }
            }
        }
    }
}

fn drain(queue: &mut EventQueue<State>, state: &mut State) -> Result<bool, TransportError> {
    for _ in 0..64 {
        queue
            .dispatch_pending(state)
            .map_err(|error| TransportError::new(error.to_string()))?;
        let Some(guard) = queue.prepare_read() else {
            continue;
        };
        let ready = {
            let mut fds = [PollFd::from_borrowed_fd(
                guard.connection_fd(),
                PollFlags::IN,
            )];
            match poll(&mut fds, Some(&Timespec::default())) {
                Ok(_) => !fds[0].revents().is_empty(),
                Err(rustix::io::Errno::INTR) => continue,
                Err(error) => return Err(TransportError::new(error.to_string())),
            }
        };
        if !ready {
            drop(guard);
            return Ok(true);
        }
        match guard.read() {
            Ok(_) => {}
            Err(WaylandError::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => {
                return Ok(true);
            }
            Err(error) => return Err(TransportError::new(error.to_string())),
        }
    }
    Ok(false)
}

impl Incoming {
    fn progress(&mut self, limit: usize) -> Result<Option<Payload>, TransportError> {
        let mut buffer = [0; 16 * 1024];
        let mut processed = 0;
        while processed < IO_QUANTUM {
            match rustix::io::read(&self.fd, &mut buffer) {
                Ok(0) => {
                    if self.bytes.is_empty() {
                        return Err(TransportError::new(
                            "clipboard source sent an empty selection",
                        ));
                    }
                    if !looks_complete(&self.mime, &self.bytes) {
                        return Err(TransportError::new(
                            "clipboard source sent an incomplete image",
                        ));
                    }
                    return Payload::new(self.mime.clone(), std::mem::take(&mut self.bytes))
                        .map(Some)
                        .map_err(|error| TransportError::new(error.to_string()));
                }
                Ok(count) => {
                    if count > limit.saturating_sub(self.bytes.len()) {
                        return Err(TransportError::new(
                            "clipboard selection exceeds the 200 MiB transport limit",
                        ));
                    }
                    self.bytes.extend_from_slice(&buffer[..count]);
                    processed += count;
                }
                Err(rustix::io::Errno::INTR) => continue,
                Err(rustix::io::Errno::AGAIN) => return Ok(None),
                Err(error) => return Err(TransportError::new(error.to_string())),
            }
        }
        Ok(None)
    }
}

impl Outgoing {
    fn progress(&mut self) -> Result<bool, TransportError> {
        let end = self.bytes.len().min(self.offset.saturating_add(IO_QUANTUM));
        while self.offset < end {
            match rustix::io::write(&self.fd, &self.bytes[self.offset..end]) {
                Ok(0) => {
                    return Err(TransportError::new(
                        "clipboard target stopped accepting bytes",
                    ));
                }
                Ok(count) => self.offset += count,
                Err(rustix::io::Errno::INTR) => continue,
                Err(rustix::io::Errno::AGAIN) => return Ok(false),
                Err(error) => return Err(TransportError::new(error.to_string())),
            }
        }
        Ok(self.offset == self.bytes.len())
    }
}

fn connect_environment() -> Result<Connection, TransportError> {
    let display = std::env::var_os("WAYLAND_DISPLAY").unwrap_or_else(|| "wayland-0".into());
    let mut path = PathBuf::from(display);
    if !path.is_absolute() {
        let runtime = std::env::var_os("XDG_RUNTIME_DIR").ok_or_else(|| {
            TransportError::new("XDG_RUNTIME_DIR is not set for the clipboard connection")
        })?;
        let runtime = PathBuf::from(runtime);
        if !runtime.is_absolute() {
            return Err(TransportError::new("XDG_RUNTIME_DIR must be absolute"));
        }
        path = runtime.join(path);
    }
    let socket = rustix::net::socket_with(
        rustix::net::AddressFamily::UNIX,
        rustix::net::SocketType::STREAM,
        rustix::net::SocketFlags::NONBLOCK | rustix::net::SocketFlags::CLOEXEC,
        None,
    )
    .map_err(|error| TransportError::new(error.to_string()))?;
    let address = rustix::net::SocketAddrUnix::new(&path)
        .map_err(|error| TransportError::new(error.to_string()))?;
    rustix::net::connect(&socket, &address)
        .map_err(|error| TransportError::new(format!("clipboard connection failed: {error}")))?;
    Connection::from_socket(UnixStream::from(socket))
        .map_err(|error| TransportError::new(error.to_string()))
}

fn nonblocking(fd: &OwnedFd) -> io::Result<()> {
    let flags = rustix::fs::fcntl_getfl(fd)?;
    rustix::fs::fcntl_setfl(fd, flags | rustix::fs::OFlags::NONBLOCK)?;
    Ok(())
}

fn timespec(duration: Duration) -> Timespec {
    Timespec {
        tv_sec: duration.as_secs() as _,
        tv_nsec: duration.subsec_nanos() as _,
    }
}

fn validate_payload(payload: &Payload) -> Result<(), TransportError> {
    if payload.bytes.is_empty() || payload.bytes.len() > MAX_TRANSPORT_BYTES {
        return Err(TransportError::new(
            "clipboard payload is empty or exceeds 200 MiB",
        ));
    }
    if !looks_complete(payload.mime(), payload.bytes()) {
        return Err(TransportError::new("clipboard image is incomplete"));
    }
    Ok(())
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    unsafe extern "C" {
        fn pipe2(fds: *mut i32, flags: i32) -> i32;
    }
    const O_CLOEXEC: i32 = 0o2000000;
    let mut fds = [0_i32; 2];
    // SAFETY: `fds` is valid writable storage for two descriptors and pipe2 has no pointers
    // beyond that array. On success both returned descriptors are newly owned by this call.
    if unsafe { pipe2(fds.as_mut_ptr(), O_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful pipe2 returned two distinct open descriptors whose ownership transfers
    // here; neither descriptor has another owner in this process.
    let reader = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    // SAFETY: same as above for the write descriptor.
    let writer = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    Ok((reader, writer))
}

impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(
        state: &mut Self,
        _: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } => {
                state.globals.insert(name, (interface, version));
            }
            wl_registry::Event::GlobalRemove { name } => {
                state.globals.remove(&name);
                if state.bound_globals.contains(&name) {
                    state.failure = Some(TransportError::new("clipboard global was removed"));
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<wl_callback::WlCallback, u8> for State {
    fn event(
        state: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        stage: &u8,
        connection: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if *stage == 0 {
            state.bind(connection, qh);
        } else if state.failure.is_none() {
            state.ready = true;
            (state.notify)(Event::Availability(Ok(())));
        }
    }
}

wayland_client::delegate_noop!(State: ignore wl_seat::WlSeat);
wayland_client::delegate_noop!(State: ignore ext_manager::ExtDataControlManagerV1);
wayland_client::delegate_noop!(State: ignore wlr_manager::ZwlrDataControlManagerV1);

macro_rules! protocol_dispatch {
    ($device:ident, $device_type:ident, $offer:ident, $offer_type:ident, $source:ident, $source_type:ident, $variant:ident) => {
        impl Dispatch<$device::$device_type, ()> for State {
            fn event(state: &mut Self, _: &$device::$device_type, event: $device::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
                match event {
                    $device::Event::DataOffer { id } => state.offer(Offer::$variant(id)),
                    $device::Event::Selection { id } => state.selected(id.map(Offer::$variant)),
                    $device::Event::PrimarySelection { id } => state.primary(id.map(Offer::$variant)),
                    $device::Event::Finished => state.failure = Some(TransportError::new("clipboard data-control device finished")),
                    _ => {}
                }
            }
            wayland_client::event_created_child!(State, $device::$device_type, [
                0 => ($offer::$offer_type, ())
            ]);
        }
        impl Dispatch<$offer::$offer_type, ()> for State {
            fn event(state: &mut Self, proxy: &$offer::$offer_type, event: $offer::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
                if let $offer::Event::Offer { mime_type } = event { state.mime(proxy.id(), mime_type); }
            }
        }
        impl Dispatch<$source::$source_type, Arc<SourceData>> for State {
            fn event(state: &mut Self, proxy: &$source::$source_type, event: $source::Event, data: &Arc<SourceData>, _: &Connection, _: &QueueHandle<Self>) {
                match event {
                    $source::Event::Send { mime_type, fd } => state.send(data, &mime_type, fd),
                    $source::Event::Cancelled => state.cancelled(Source::$variant(proxy.clone())),
                    _ => {}
                }
            }
        }
    };
}

protocol_dispatch!(
    ext_device,
    ExtDataControlDeviceV1,
    ext_offer,
    ExtDataControlOfferV1,
    ext_source,
    ExtDataControlSourceV1,
    Ext
);
protocol_dispatch!(
    wlr_device,
    ZwlrDataControlDeviceV1,
    wlr_offer,
    ZwlrDataControlOfferV1,
    wlr_source,
    ZwlrDataControlSourceV1,
    Wlr
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outgoing_eagain_retains_exact_position_and_open_descriptor() {
        let (reader, writer) = pipe().expect("pipe");
        nonblocking(&writer).expect("nonblocking writer");
        let bytes: Arc<[u8]> = vec![b'x'; 1024 * 1024].into();
        let mut outgoing = Outgoing {
            fd: writer,
            bytes,
            offset: 0,
            deadline: Instant::now() + TRANSFER_TIMEOUT,
        };
        assert!(!outgoing.progress().expect("progress"));
        let offset = outgoing.offset;
        assert!(offset > 0 && offset < 1024 * 1024);
        assert!(!outgoing.progress().expect("EAGAIN is not completion"));
        assert_eq!(outgoing.offset, offset);
        drop(reader);
    }
}
