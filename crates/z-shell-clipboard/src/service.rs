//! Clipboard topic snapshots and authenticated core control commands.

use crate::transport::{Event, Transport};
use crate::{Blob, History, ImageDimensions, Payload, PayloadKind, PersistenceMode};
use serde::Deserialize;
use serde_json::{Value, json};
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex, Weak};
use z_shell_bus::{BusHub, CommandCall, CommandHandler, UpdateKind};
use z_shell_protocol::{
    ClientRole, CommandInvokeResult, CommandName, ErrorCode, MediaRef, RpcError, TopicName,
};

const TOPIC: &str = "clipboard";
const DEFAULT_LIST_LIMIT: usize = 50;
const MAX_LIST_LIMIT: usize = 100;
const PREVIEW_CHARACTERS: usize = 160;
/// Keeps the worst-case decimal byte-array response below the 1 MiB bus frame limit.
pub const MAX_BLOB_RESPONSE_BYTES: usize = 200_000;

/// Lock-screen state used to gate public clipboard reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LockedState {
    /// Public list and copy operations are permitted.
    #[default]
    Unlocked,
    /// Public list and copy operations are denied.
    Locked,
}

/// Native Wayland transport availability shown in the clipboard topic.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TransportStatus {
    /// A data-control device is ready to capture and serve selections.
    Ready,
    /// No usable native transport exists; history remains available in memory.
    Unavailable {
        /// Connection or protocol diagnostic.
        reason: String,
    },
}

/// Metadata-only clipboard entry published on the bus.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ClipboardEntrySummary {
    /// Stable history entry identifier.
    pub id: u64,
    /// Text or image classification.
    pub kind: PayloadKind,
    /// Original MIME type.
    pub mime: String,
    /// Character-bounded text preview; empty for images.
    pub preview: String,
    /// Pin state.
    pub pinned: bool,
    /// Exact original byte length.
    pub byte_len: u64,
    /// Validated image dimensions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<ImageDimensions>,
    /// Revocable out-of-band image token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<MediaRef>,
}

/// Current metadata-only state published as the `clipboard` topic.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ClipboardSnapshot {
    /// Encrypted or memory-only persistence status.
    pub persistence: PersistenceMode,
    /// Native Wayland transport status.
    pub transport: TransportStatus,
    /// Current lock-screen gate.
    pub locked: LockedState,
    /// Total retained entry count, including entries outside this page.
    pub entry_count: usize,
    /// First metadata page, empty while locked.
    pub entries: Vec<ClipboardEntrySummary>,
}

#[derive(Debug)]
struct State {
    history: History,
    locked: LockedState,
    transport: TransportStatus,
    wayland: Option<Transport>,
    next_request: u64,
}

/// Thread-safe clipboard state owner and bus command provider.
pub struct ClipboardService {
    state: Mutex<State>,
    hub: Mutex<Option<BusHub>>,
}

impl std::fmt::Debug for ClipboardService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ClipboardService")
            .field("snapshot", &self.snapshot())
            .finish_non_exhaustive()
    }
}

impl Default for ClipboardService {
    fn default() -> Self {
        Self::new(History::memory())
    }
}

impl ClipboardService {
    /// Creates a clipboard service over existing history without starting Wayland I/O.
    #[must_use]
    pub fn new(history: History) -> Self {
        Self {
            state: Mutex::new(State {
                history,
                locked: LockedState::Unlocked,
                transport: TransportStatus::Unavailable {
                    reason: "native Wayland transport is not connected".to_owned(),
                },
                wayland: None,
                next_request: 1,
            }),
            hub: Mutex::new(None),
        }
    }

    /// Returns a bounded metadata snapshot; locked snapshots contain no entries.
    #[must_use]
    pub fn snapshot(&self) -> ClipboardSnapshot {
        let state = self.state.lock().expect("clipboard state lock poisoned");
        snapshot(&state)
    }

    /// Installs the topic baseline and all `clipboard.*` core commands.
    pub fn install_on_bus(self: &Arc<Self>, hub: &BusHub) {
        *self.hub.lock().expect("clipboard hub lock poisoned") = Some(hub.clone());
        hub.publish_core_topic(
            TopicName::try_new(TOPIC).expect("clipboard is a valid topic"),
            serde_json::to_value(self.snapshot()).expect("clipboard snapshot serializes"),
            UpdateKind::SourceBaseline,
        );
        let commands: [(&str, &str, Operation); 7] = [
            ("clipboard.list", "List and search clipboard metadata", list),
            (
                "clipboard.copy",
                "Copy a history entry through Wayland",
                copy,
            ),
            ("clipboard.pin", "Pin a clipboard history entry", pin),
            ("clipboard.unpin", "Unpin a clipboard history entry", unpin),
            (
                "clipboard.forget",
                "Forget one clipboard history entry",
                forget,
            ),
            ("clipboard.clear", "Clear all clipboard history", clear),
            (
                "clipboard.fetch-blob",
                "Fetch a bounded image blob on the host control channel",
                fetch_blob,
            ),
        ];
        for (name, description, operation) in commands {
            register(hub, Arc::downgrade(self), name, description, operation);
        }
    }

    /// Starts native Wayland transport from the session environment.
    ///
    /// # Errors
    ///
    /// Returns only worker/socket setup failures; compositor failures degrade through the topic.
    pub fn connect_from_env(self: &Arc<Self>) -> std::io::Result<()> {
        let weak = Arc::downgrade(self);
        let transport = Transport::connect_from_env(move |event| {
            if let Some(service) = weak.upgrade() {
                service.handle_transport_event(event);
            }
        })?;
        self.attach_transport(transport);
        Ok(())
    }

    /// Starts native Wayland transport over a supplied stream, including mock server tests.
    ///
    /// # Errors
    ///
    /// Returns only worker/socket setup failures; protocol failures degrade through the topic.
    pub fn connect_stream(self: &Arc<Self>, stream: UnixStream) -> std::io::Result<()> {
        let weak = Arc::downgrade(self);
        let transport = Transport::connect_stream(stream, move |event| {
            if let Some(service) = weak.upgrade() {
                service.handle_transport_event(event);
            }
        })?;
        self.attach_transport(transport);
        Ok(())
    }

    /// Captures a newly received selection and publishes its metadata.
    pub fn ingest(self: &Arc<Self>, payload: Payload) {
        let changed = {
            let mut state = self.state.lock().expect("clipboard state lock poisoned");
            match state.history.capture(payload) {
                Ok(id) => Some(id),
                Err(error) => {
                    tracing::warn!(%error, "clipboard selection was not admitted");
                    None
                }
            }
        };
        if changed.is_some() {
            self.publish();
        }
    }

    /// Changes the public read gate and publishes a redacted locked snapshot when needed.
    pub fn set_locked(&self, locked: LockedState) {
        self.state
            .lock()
            .expect("clipboard state lock poisoned")
            .locked = locked;
        self.publish();
    }

    /// Updates transport availability for topic consumers.
    pub fn set_transport_status(&self, transport: TransportStatus) {
        self.state
            .lock()
            .expect("clipboard state lock poisoned")
            .transport = transport;
        self.publish();
    }

    fn publish(&self) {
        let hub = self
            .hub
            .lock()
            .expect("clipboard hub lock poisoned")
            .clone();
        if let Some(hub) = hub {
            hub.publish_core_topic(
                TopicName::try_new(TOPIC).expect("clipboard is a valid topic"),
                serde_json::to_value(self.snapshot()).expect("clipboard snapshot serializes"),
                UpdateKind::Live,
            );
        }
    }

    fn list(&self, params: ListParams) -> Value {
        let state = self.state.lock().expect("clipboard state lock poisoned");
        let matching = state
            .history
            .entries()
            .iter()
            .filter(|entry| entry.payload.matches_query(&params.query));
        let total = matching.clone().count();
        let entries = matching
            .skip(params.offset)
            .take(params.limit)
            .map(|entry| summary(&state.history, entry))
            .collect::<Vec<_>>();
        serde_json::to_value(ListResult {
            total,
            offset: params.offset,
            limit: params.limit,
            entries,
        })
        .expect("clipboard list serializes")
    }

    fn copy(&self, id: u64) -> Result<Value, RpcError> {
        let mut state = self.state.lock().expect("clipboard state lock poisoned");
        let payload = state
            .history
            .entry(id)
            .map(|entry| entry.payload.clone())
            .ok_or_else(|| not_found(id))?;
        let request = state.next_request;
        state.next_request = state
            .next_request
            .checked_add(1)
            .ok_or_else(|| RpcError::new(ErrorCode::Internal, "clipboard request IDs exhausted"))?;
        let transport = state.wayland.as_ref().ok_or_else(|| {
            RpcError::new(
                ErrorCode::Disabled,
                "native Wayland clipboard transport is unavailable",
            )
        })?;
        transport.copy(request, payload).map_err(|error| {
            RpcError::new(
                ErrorCode::Disabled,
                format!("clipboard copy failed: {error}"),
            )
        })?;
        Ok(json!({"id": id, "request": request}))
    }

    fn attach_transport(&self, transport: Transport) {
        let previous = self
            .state
            .lock()
            .expect("clipboard state lock poisoned")
            .wayland
            .replace(transport);
        // Joining a replaced worker outside the state lock avoids callback deadlock.
        drop(previous);
    }

    fn handle_transport_event(self: &Arc<Self>, event: Event) {
        match event {
            Event::Availability(Ok(())) => self.set_transport_status(TransportStatus::Ready),
            Event::Availability(Err(error)) => {
                self.set_transport_status(TransportStatus::Unavailable {
                    reason: error.to_string(),
                });
            }
            Event::Selection(payload) => self.ingest(payload),
            Event::TransferError(error) => {
                tracing::warn!(%error, "clipboard transfer failed");
            }
            Event::Copied(request, Err(error)) => {
                tracing::warn!(request, %error, "clipboard copy failed after queueing");
            }
            Event::Copied(_, Ok(())) => {}
        }
    }

    fn blob(&self, token: &str) -> Option<Blob> {
        self.state
            .lock()
            .expect("clipboard state lock poisoned")
            .history
            .fetch_blob(token)
            .cloned()
    }
}

fn snapshot(state: &State) -> ClipboardSnapshot {
    ClipboardSnapshot {
        persistence: state.history.persistence().clone(),
        transport: state.transport.clone(),
        locked: state.locked,
        entry_count: state.history.entries().len(),
        entries: if state.locked == LockedState::Locked {
            Vec::new()
        } else {
            state
                .history
                .entries()
                .iter()
                .take(DEFAULT_LIST_LIMIT)
                .map(|entry| summary(&state.history, entry))
                .collect()
        },
    }
}

fn summary(history: &History, entry: &crate::Entry) -> ClipboardEntrySummary {
    let kind = entry.payload.kind();
    ClipboardEntrySummary {
        id: entry.id,
        kind,
        mime: entry.payload.mime().to_owned(),
        preview: if kind == PayloadKind::Text {
            entry.payload.text_preview(PREVIEW_CHARACTERS)
        } else {
            String::new()
        },
        pinned: entry.pinned,
        byte_len: entry.payload.bytes().len() as u64,
        dimensions: entry.payload.dimensions(),
        media: history.media_ref(entry.id),
    }
}

#[derive(Debug, serde::Serialize)]
struct ListResult {
    total: usize,
    offset: usize,
    limit: usize,
    entries: Vec<ClipboardEntrySummary>,
}

type Operation = fn(&Arc<ClipboardService>, CommandCall) -> Result<Value, RpcError>;

fn register(
    hub: &BusHub,
    service: Weak<ClipboardService>,
    name: &str,
    description: &str,
    operation: Operation,
) {
    let handler: CommandHandler = Arc::new(move |call: CommandCall| {
        let service = service.clone();
        Box::pin(async move {
            let service = service.upgrade().ok_or_else(|| {
                RpcError::new(ErrorCode::Internal, "clipboard service has been shut down")
            })?;
            let data = operation(&service, call)?;
            Ok(CommandInvokeResult {
                message: None,
                data: Some(data),
            })
        })
    });
    hub.register_core_command(
        CommandName::try_new(name).expect("static clipboard command is valid"),
        description,
        handler,
    );
}

fn list(service: &Arc<ClipboardService>, call: CommandCall) -> Result<Value, RpcError> {
    deny_public_while_locked(service, &call)?;
    let mut params: ListParams = parse_params(call.params.payload)?;
    params.limit = params.limit.clamp(0, MAX_LIST_LIMIT);
    Ok(service.list(params))
}

fn copy(service: &Arc<ClipboardService>, call: CommandCall) -> Result<Value, RpcError> {
    deny_public_while_locked(service, &call)?;
    let params: IdParams = parse_params(call.params.payload)?;
    service.copy(params.id)
}

fn pin(service: &Arc<ClipboardService>, call: CommandCall) -> Result<Value, RpcError> {
    set_pin(service, call, true)
}

fn unpin(service: &Arc<ClipboardService>, call: CommandCall) -> Result<Value, RpcError> {
    set_pin(service, call, false)
}

fn set_pin(
    service: &Arc<ClipboardService>,
    call: CommandCall,
    pinned: bool,
) -> Result<Value, RpcError> {
    let params: IdParams = parse_params(call.params.payload)?;
    let changed = {
        let mut state = service.state.lock().expect("clipboard state lock poisoned");
        if pinned {
            state.history.pin(params.id)
        } else {
            state.history.unpin(params.id)
        }
    };
    if !changed {
        return Err(not_found(params.id));
    }
    service.publish();
    Ok(json!({"id": params.id, "pinned": pinned}))
}

fn forget(service: &Arc<ClipboardService>, call: CommandCall) -> Result<Value, RpcError> {
    let params: IdParams = parse_params(call.params.payload)?;
    let forgotten = service
        .state
        .lock()
        .expect("clipboard state lock poisoned")
        .history
        .forget(params.id);
    if !forgotten {
        return Err(not_found(params.id));
    }
    service.publish();
    Ok(json!({"id": params.id, "forgotten": true}))
}

fn clear(service: &Arc<ClipboardService>, call: CommandCall) -> Result<Value, RpcError> {
    parse_params::<EmptyParams>(call.params.payload)?;
    service
        .state
        .lock()
        .expect("clipboard state lock poisoned")
        .history
        .clear();
    service.publish();
    Ok(json!({"cleared": true}))
}

fn fetch_blob(service: &Arc<ClipboardService>, call: CommandCall) -> Result<Value, RpcError> {
    if call.caller.role != ClientRole::PrivilegedHost {
        return Err(RpcError::new(
            ErrorCode::PermissionDenied,
            "clipboard.fetch-blob requires the privileged host channel",
        ));
    }
    let params: TokenParams = parse_params(call.params.payload)?;
    let blob = service.blob(&params.token).ok_or_else(|| {
        RpcError::new(
            ErrorCode::NotFound,
            "clipboard blob token is unknown or revoked",
        )
    })?;
    if blob.bytes().len() > MAX_BLOB_RESPONSE_BYTES {
        return Err(RpcError::new(
            ErrorCode::ResourceExhausted,
            format!("clipboard blob exceeds {MAX_BLOB_RESPONSE_BYTES}-byte fetch limit"),
        ));
    }
    let bytes = blob
        .bytes()
        .iter()
        .map(|byte| Value::from(*byte))
        .collect::<Vec<_>>();
    Ok(json!({
        "entry_id": blob.entry_id(),
        "mime": blob.mime(),
        "byte_len": bytes.len(),
        "bytes": bytes,
    }))
}

fn deny_public_while_locked(
    service: &ClipboardService,
    call: &CommandCall,
) -> Result<(), RpcError> {
    if call.caller.role == ClientRole::Public
        && service
            .state
            .lock()
            .expect("clipboard state lock poisoned")
            .locked
            == LockedState::Locked
    {
        return Err(RpcError::new(
            ErrorCode::PermissionDenied,
            "public clipboard reads are denied while the screen is locked",
        ));
    }
    Ok(())
}

fn parse_params<T: serde::de::DeserializeOwned>(payload: Option<Value>) -> Result<T, RpcError> {
    serde_json::from_value(payload.unwrap_or_else(|| json!({}))).map_err(|error| {
        RpcError::new(
            ErrorCode::InvalidParams,
            format!("invalid clipboard parameters: {error}"),
        )
    })
}

fn not_found(id: u64) -> RpcError {
    RpcError::new(
        ErrorCode::NotFound,
        format!("clipboard entry {id} does not exist"),
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct EmptyParams {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdParams {
    id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenParams {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ListParams {
    offset: usize,
    limit: usize,
    query: String,
}

impl Default for ListParams {
    fn default() -> Self {
        Self {
            offset: 0,
            limit: DEFAULT_LIST_LIMIT,
            query: String::new(),
        }
    }
}
