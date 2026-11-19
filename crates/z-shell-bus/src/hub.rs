//! Central topic, command, and inhibitor broker with strictly ordered per-client delivery.

use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Notify, oneshot};
use z_shell_protocol::{
    BusHelloParams, BusHelloResult, ClientMessage, ClientRole, CommandDispatchNotification,
    CommandInvokeParams, CommandInvokeResult, CommandName, CommandRegisterParams,
    CommandReplyParams, CommandSummary, CommandUnregisterParams, ErrorCode, InhibitorAcquireParams,
    InhibitorAcquireResult, InhibitorEntry, InhibitorReleaseParams, MAX_FRAME_BYTES,
    MAX_SAFE_JS_INT, PROTOCOL_VERSION, PluginId, RequestId, RpcError, ServerMessage,
    TopicListEntry, TopicName, TopicOwner, TopicPublishParams, TopicRegisterParams,
    TopicRemovedNotification, TopicResetNotification, TopicSnapshot, TopicSubscribeParams,
    TopicUnregisterParams, TopicUnsubscribeParams, TopicUpdate, encode_line, methods,
};

/// Maximum duration the hub waits for a plugin to reply to a dispatched control command.
pub const PLUGIN_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

/// Canonical topic name publishing active idle/sleep/lock inhibitors.
pub const INHIBITORS_TOPIC: &str = "inhibitors";

static DAEMON_INSTANCE_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Resource limits enforced per daemon and per connected client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BusLimits {
    /// Maximum concurrent authenticated bus connections.
    pub max_clients: usize,
    /// Maximum custom topics registered simultaneously by one connection.
    pub max_topics_per_client: usize,
    /// Maximum custom commands registered simultaneously by one connection.
    pub max_commands_per_client: usize,
    /// Maximum active inhibitors held simultaneously by one connection.
    pub max_inhibitors_per_client: usize,
    /// Maximum queued outbound frames per connection before slow-consumer topic reset.
    pub max_queued_frames: usize,
    /// Maximum queued outbound bytes per connection before slow-consumer topic reset.
    pub max_queued_bytes: usize,
    /// Maximum concurrent async `command.invoke` requests per connection.
    pub max_in_flight_per_client: usize,
}

impl Default for BusLimits {
    fn default() -> Self {
        Self {
            max_clients: 64,
            max_topics_per_client: 32,
            max_commands_per_client: 32,
            max_inhibitors_per_client: 16,
            max_queued_frames: 256,
            max_queued_bytes: 2 * 1024 * 1024,
            max_in_flight_per_client: 32,
        }
    }
}

/// Distinguishes initial external data-source baselines from live transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateKind {
    /// External data source settled its initial or re-synced baseline (suppress OSDs/hooks).
    SourceBaseline,
    /// Live state transition after source baseline initialization.
    Live,
}

/// Authenticated caller metadata derived strictly from the accepting socket connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallerContext {
    /// Unique connection identifier assigned by the daemon.
    pub client_id: u64,
    /// Trust tier assigned by the accepting socket (`Public` vs `PrivilegedHost`).
    pub role: ClientRole,
}

/// Invocation context supplied to daemon-owned core command handlers without creating `Arc` cycles.
pub struct CommandCall {
    /// Authenticated caller identity and role.
    pub caller: CallerContext,
    /// Command name, positional arguments, and optional JSON payload.
    pub params: CommandInvokeParams,
    /// Clone of the [`BusHub`] valid for the duration of this call.
    pub hub: BusHub,
}

/// Async handler type for daemon-owned core control commands.
pub type CommandHandler = Arc<
    dyn Fn(
            CommandCall,
        ) -> Pin<Box<dyn Future<Output = Result<CommandInvokeResult, RpcError>> + Send>>
        + Send
        + Sync,
>;

/// A single pre-encoded outbound NDJSON line stored in a client's strictly ordered queue.
struct QueuedFrame {
    line: String,
    is_topic_update: bool,
}

struct ClientRecord {
    role: ClientRole,
    handshake_complete: bool,
    queue: VecDeque<QueuedFrame>,
    queued_bytes: usize,
    closed: bool,
    notify: Arc<Notify>,
}

impl ClientRecord {
    fn new(role: ClientRole) -> Self {
        Self {
            role,
            handshake_complete: false,
            queue: VecDeque::new(),
            queued_bytes: 0,
            closed: false,
            notify: Arc::new(Notify::new()),
        }
    }

    fn push_control(&mut self, msg: &ServerMessage, limits: BusLimits) -> bool {
        if self.closed {
            return false;
        }
        let encoded = match encode_line(msg) {
            Ok(line) => line,
            Err(err) => {
                // Never silently drop a correlated RPC response that exceeded MAX_FRAME_BYTES.
                let fallback = match msg {
                    ServerMessage::Ok { id, .. } | ServerMessage::Err { id: Some(id), .. } => {
                        ServerMessage::err(
                            id.clone(),
                            RpcError::new(
                                ErrorCode::ResourceExhausted,
                                format!("response exceeds maximum frame budget: {err}"),
                            ),
                        )
                    }
                    _ => return true,
                };
                match encode_line(&fallback) {
                    Ok(line) => line,
                    Err(_) => return false,
                }
            }
        };
        let bytes = encoded.len();
        // Allow control frames 2x soft byte budget before closing an unresponsive peer.
        let hard_bytes = limits
            .max_queued_bytes
            .saturating_mul(2)
            .max(MAX_FRAME_BYTES);
        let hard_frames = limits.max_queued_frames.saturating_mul(2).max(16);
        if self.queue.len() >= hard_frames || self.queued_bytes + bytes > hard_bytes {
            self.closed = true;
            self.queue.clear();
            self.queued_bytes = 0;
            self.notify.notify_one();
            return false;
        }
        self.queued_bytes += bytes;
        self.queue.push_back(QueuedFrame {
            line: encoded,
            is_topic_update: false,
        });
        self.notify.notify_one();
        true
    }

    /// Tries to enqueue a topic update within soft frame/byte budgets; returns `false` if saturated.
    fn try_push_topic_update(&mut self, encoded_line: &str, limits: BusLimits) -> bool {
        if self.closed {
            return false;
        }
        let bytes = encoded_line.len();
        if self.queue.len() >= limits.max_queued_frames
            || self.queued_bytes + bytes > limits.max_queued_bytes
        {
            return false;
        }
        self.queued_bytes += bytes;
        self.queue.push_back(QueuedFrame {
            line: encoded_line.to_owned(),
            is_topic_update: true,
        });
        self.notify.notify_one();
        true
    }

    fn purge_topic_updates(&mut self) {
        let mut kept = VecDeque::with_capacity(self.queue.len());
        let mut bytes = 0usize;
        while let Some(frame) = self.queue.pop_front() {
            if !frame.is_topic_update {
                bytes += frame.line.len();
                kept.push_back(frame);
            }
        }
        self.queue = kept;
        self.queued_bytes = bytes;
    }
}

/// Async pull handle used by one connection's writer task to drain strictly ordered NDJSON lines.
pub struct ClientOutbound {
    hub: BusHub,
    client_id: u64,
    notify: Arc<Notify>,
}

impl ClientOutbound {
    /// Waits for and pops the next serialized NDJSON line, returning `None` when closed and drained.
    pub async fn next_line(&self) -> Option<String> {
        loop {
            let notified = self.notify.notified();
            {
                let mut state = self
                    .hub
                    .inner
                    .state
                    .lock()
                    .expect("hub state lock poisoned");
                let client = state.clients.get_mut(&self.client_id)?;
                if let Some(frame) = client.queue.pop_front() {
                    client.queued_bytes = client.queued_bytes.saturating_sub(frame.line.len());
                    return Some(frame.line);
                }
                if client.closed {
                    return None;
                }
            }
            notified.await;
        }
    }
}

struct TopicRecord {
    topic_instance_id: u64,
    revision: u64,
    data: Value,
    owner: TopicOwner,
    subscribers: BTreeSet<u64>,
}

enum CommandTarget {
    Core(CommandHandler),
    Plugin { client_id: u64 },
}

struct CommandRecord {
    description: String,
    owner: TopicOwner,
    target: CommandTarget,
}

struct PendingPluginCall {
    owner_client_id: u64,
    reply: oneshot::Sender<Result<CommandInvokeResult, RpcError>>,
}

struct HubState {
    clients: HashMap<u64, ClientRecord>,
    topics: BTreeMap<TopicName, TopicRecord>,
    commands: BTreeMap<CommandName, CommandRecord>,
    pending_calls: HashMap<u64, PendingPluginCall>,
    inhibitors: BTreeMap<u64, InhibitorEntry>,
}

struct HubInner {
    daemon_version: String,
    daemon_instance_id: String,
    media_dir: PathBuf,
    limits: BusLimits,
    next_client_id: AtomicU64,
    next_topic_instance_id: AtomicU64,
    next_call_id: AtomicU64,
    next_inhibitor_cookie: AtomicU64,
    retired_clients: tokio::sync::broadcast::Sender<CallerContext>,
    state: Mutex<HubState>,
}

/// Thread-safe, cheaply cloneable bus broker managing topics, commands, inhibitors, and ordered queues.
#[derive(Clone)]
pub struct BusHub {
    inner: Arc<HubInner>,
}

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<BusHub>();
};

impl BusHub {
    /// Creates a new [`BusHub`] with default [`BusLimits`] and an initialized `inhibitors` core topic.
    #[must_use]
    pub fn new(daemon_version: impl Into<String>, media_dir: PathBuf) -> Self {
        Self::with_limits(daemon_version, media_dir, BusLimits::default())
    }

    /// Creates a new [`BusHub`] with explicit [`BusLimits`].
    #[must_use]
    pub fn with_limits(
        daemon_version: impl Into<String>,
        media_dir: PathBuf,
        limits: BusLimits,
    ) -> Self {
        let mut topics = BTreeMap::new();
        let inhibitors_topic =
            TopicName::try_new(INHIBITORS_TOPIC).expect("INHIBITORS_TOPIC is a valid TopicName");
        topics.insert(
            inhibitors_topic,
            TopicRecord {
                topic_instance_id: 1,
                revision: 1,
                data: json!([]),
                owner: TopicOwner::Core,
                subscribers: BTreeSet::new(),
            },
        );
        let boot_seq = DAEMON_INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let daemon_instance_id = format!("zsd-{}-{boot_seq}-{nanos:x}", std::process::id());

        let (retired_clients, _) = tokio::sync::broadcast::channel(64);
        Self {
            inner: Arc::new(HubInner {
                daemon_version: daemon_version.into(),
                daemon_instance_id,
                media_dir,
                limits,
                next_client_id: AtomicU64::new(1),
                next_topic_instance_id: AtomicU64::new(2),
                next_call_id: AtomicU64::new(1),
                next_inhibitor_cookie: AtomicU64::new(1),
                retired_clients,
                state: Mutex::new(HubState {
                    clients: HashMap::new(),
                    topics,
                    commands: BTreeMap::new(),
                    pending_calls: HashMap::new(),
                    inhibitors: BTreeMap::new(),
                }),
            }),
        }
    }

    /// Returns the unique boot incarnation ID of this daemon hub.
    #[must_use]
    pub fn daemon_instance_id(&self) -> &str {
        &self.inner.daemon_instance_id
    }

    /// Returns the configured [`BusLimits`].
    #[must_use]
    pub fn limits(&self) -> BusLimits {
        self.inner.limits
    }

    /// Registers a newly accepted connection with its socket-derived [`ClientRole`].
    ///
    /// Returns `None` if `limits.max_clients` is already reached.
    #[must_use]
    pub fn register_client(&self, role: ClientRole) -> Option<(u64, ClientOutbound)> {
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        if state.clients.len() >= self.inner.limits.max_clients {
            return None;
        }
        let client_id = next_safe_id(&self.inner.next_client_id);
        let record = ClientRecord::new(role);
        let notify = Arc::clone(&record.notify);
        state.clients.insert(client_id, record);
        Some((
            client_id,
            ClientOutbound {
                hub: self.clone(),
                client_id,
                notify,
            },
        ))
    }

    /// Marks a client's outbound queue closed so its writer drains remaining queued responses and exits.
    pub fn close_client_outbound(&self, client_id: u64) {
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        if let Some(client) = state.clients.get_mut(&client_id) {
            client.closed = true;
            client.notify.notify_one();
        }
    }

    /// Subscribes to connection retirement events carrying the disconnected client's ID and role.
    #[must_use]
    pub fn subscribe_client_retired(&self) -> tokio::sync::broadcast::Receiver<CallerContext> {
        self.inner.retired_clients.subscribe()
    }

    /// Retires a connection owner atomically, rejecting any future commits from it, notifying
    /// subscribers of removed plugin topics, failing its in-flight delegated commands, and releasing
    /// all inhibitors it acquired.
    pub fn retire_client(&self, client_id: u64) {
        let mut failed_calls = Vec::new();
        let mut retired_caller = None;

        {
            let mut state = self.inner.state.lock().expect("hub state lock poisoned");
            if let Some(mut client) = state.clients.remove(&client_id) {
                retired_caller = Some(CallerContext {
                    client_id,
                    role: client.role,
                });
                client.closed = true;
                client.notify.notify_one();
            }

            // Collect plugin topics owned by this retiring client before removing them.
            let owned_topics: Vec<(TopicName, u64, Vec<u64>)> = state
                .topics
                .iter()
                .filter_map(|(name, rec)| match rec.owner {
                    TopicOwner::Plugin {
                        client_id: owner, ..
                    } if owner == client_id => Some((
                        name.clone(),
                        rec.topic_instance_id,
                        rec.subscribers
                            .iter()
                            .copied()
                            .filter(|&sub| sub != client_id)
                            .collect(),
                    )),
                    _ => None,
                })
                .collect();

            for (name, topic_instance_id, subscribers) in owned_topics {
                state.topics.remove(&name);
                let removed = TopicRemovedNotification {
                    daemon_instance_id: self.inner.daemon_instance_id.clone(),
                    topic_instance_id,
                    topic: name,
                };
                let msg = ServerMessage::notification(
                    methods::TOPIC_REMOVED,
                    serde_json::to_value(removed).expect("TopicRemovedNotification serializes"),
                );
                for sub_id in subscribers {
                    if let Some(client) = state.clients.get_mut(&sub_id) {
                        client.push_control(&msg, self.inner.limits);
                    }
                }
            }

            for record in state.topics.values_mut() {
                record.subscribers.remove(&client_id);
            }

            state.commands.retain(|_, record| {
                !matches!(record.target, CommandTarget::Plugin { client_id: owner } if owner == client_id)
            });

            let owned_calls: Vec<u64> = state
                .pending_calls
                .iter()
                .filter_map(|(&call_id, pending)| {
                    (pending.owner_client_id == client_id).then_some(call_id)
                })
                .collect();
            for call_id in owned_calls {
                if let Some(pending) = state.pending_calls.remove(&call_id) {
                    failed_calls.push(pending.reply);
                }
            }

            let before_inhibitors = state.inhibitors.len();
            state.inhibitors.retain(|_, entry| {
                !matches!(entry.owner, TopicOwner::Plugin { client_id: owner, .. } if owner == client_id)
            });
            if state.inhibitors.len() != before_inhibitors {
                publish_inhibitors_locked(
                    &mut state,
                    &self.inner.daemon_instance_id,
                    self.inner.limits,
                );
            }
        }

        for reply in failed_calls {
            let _ = reply.send(Err(RpcError::new(
                ErrorCode::NotFound,
                "command owner disconnected before replying",
            )));
        }

        if let Some(caller) = retired_caller {
            let _ = self.inner.retired_clients.send(caller);
        }
    }

    /// Enqueues a single control/error frame directly onto one active client's ordered queue.
    pub fn enqueue_control(&self, client_id: u64, msg: &ServerMessage) {
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        if let Some(client) = state.clients.get_mut(&client_id) {
            client.push_control(msg, self.inner.limits);
        }
    }

    /// Atomically commits a daemon-owned core topic revision and enqueues strictly ordered updates
    /// onto every subscriber (triggering explicit `topic.reset` for any saturated subscriber).
    pub fn publish_core_topic(&self, topic: TopicName, data: Value, kind: UpdateKind) -> u64 {
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        let next_instance = &self.inner.next_topic_instance_id;
        let (topic_instance_id, revision, subscribers) = {
            let entry = state
                .topics
                .entry(topic.clone())
                .or_insert_with(|| TopicRecord {
                    topic_instance_id: next_safe_id(next_instance),
                    revision: 0,
                    data: Value::Null,
                    owner: TopicOwner::Core,
                    subscribers: BTreeSet::new(),
                });
            entry.revision = entry.revision.checked_add(1).expect("revision overflow");
            entry.data = data.clone();
            let subs: Vec<u64> = entry.subscribers.iter().copied().collect();
            (entry.topic_instance_id, entry.revision, subs)
        };
        let update = TopicUpdate {
            daemon_instance_id: self.inner.daemon_instance_id.clone(),
            topic_instance_id,
            topic,
            revision,
            source_baseline: matches!(kind, UpdateKind::SourceBaseline),
            data,
        };
        deliver_topic_update_locked(
            &mut state,
            &subscribers,
            &update,
            &self.inner.daemon_instance_id,
            self.inner.limits,
        );
        revision
    }

    /// Registers a daemon-owned core control command.
    pub fn register_core_command(
        &self,
        name: CommandName,
        description: impl Into<String>,
        handler: CommandHandler,
    ) {
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        state.commands.insert(
            name,
            CommandRecord {
                description: description.into(),
                owner: TopicOwner::Core,
                target: CommandTarget::Core(handler),
            },
        );
    }

    /// Returns the number of currently connected clients.
    #[must_use]
    pub fn connected_clients(&self) -> usize {
        self.inner
            .state
            .lock()
            .expect("hub state lock poisoned")
            .clients
            .len()
    }

    /// Returns all currently registered topics and their revisions.
    #[must_use]
    pub fn list_topics(&self) -> Vec<TopicListEntry> {
        let state = self.inner.state.lock().expect("hub state lock poisoned");
        state
            .topics
            .iter()
            .map(|(topic, record)| TopicListEntry {
                topic: topic.clone(),
                topic_instance_id: record.topic_instance_id,
                revision: record.revision,
                owner: record.owner.clone(),
            })
            .collect()
    }

    /// Returns all currently registered control commands.
    #[must_use]
    pub fn list_commands(&self) -> Vec<CommandSummary> {
        let state = self.inner.state.lock().expect("hub state lock poisoned");
        state
            .commands
            .iter()
            .map(|(name, record)| CommandSummary {
                name: name.clone(),
                description: record.description.clone(),
                owner: record.owner.clone(),
            })
            .collect()
    }

    /// Handles a fast, non-blocking bus request synchronously inside the connection reader loop
    /// so ordering (especially `topic.subscribe` snapshot vs subsequent `topic.update`) is exact.
    ///
    /// Returns `Some((req_id, CallerContext, CommandInvokeParams))` when the message is an async
    /// `command.invoke` that must be spawned on a bounded cancellable task.
    pub fn handle_inline_message(
        &self,
        client_id: u64,
        msg: ClientMessage,
    ) -> Option<(RequestId, CallerContext, CommandInvokeParams)> {
        let Some(id) = msg.id else {
            if msg.method == methods::COMMAND_REPLY
                && let Some(params) = msg.params
                && let Ok(reply) = serde_json::from_value::<CommandReplyParams>(params)
            {
                let _ = self.complete_plugin_command(client_id, reply);
            }
            return None;
        };

        // `bus.hello` is the sole method allowed before handshake completion.
        if msg.method == methods::BUS_HELLO {
            let response = match self.handle_hello(client_id, msg.params) {
                Ok(val) => ServerMessage::ok(id, val),
                Err(err) => ServerMessage::err(id, err),
            };
            self.enqueue_control(client_id, &response);
            return None;
        }

        // Enforce mandatory handshake and active owner before dispatching any other method.
        let caller = {
            let mut state = self.inner.state.lock().expect("hub state lock poisoned");
            let client = state.clients.get_mut(&client_id)?;
            if !client.handshake_complete {
                let err = ServerMessage::err(
                    id,
                    RpcError::new(
                        ErrorCode::HandshakeRequired,
                        "client must complete bus.hello before issuing requests",
                    ),
                );
                client.push_control(&err, self.inner.limits);
                return None;
            }
            CallerContext {
                client_id,
                role: client.role,
            }
        };

        if msg.method == methods::COMMAND_INVOKE {
            match parse_params::<CommandInvokeParams>(msg.params) {
                Ok(params) => return Some((id, caller, params)),
                Err(err) => {
                    self.enqueue_control(client_id, &ServerMessage::err(id, err));
                    return None;
                }
            }
        }

        // `topic.subscribe` commits subscription + enqueues its snapshot response under ONE lock.
        if msg.method == methods::TOPIC_SUBSCRIBE {
            match parse_params::<TopicSubscribeParams>(msg.params) {
                Ok(parsed) => self.subscribe_and_enqueue_snapshot(client_id, id, parsed.topic),
                Err(err) => self.enqueue_control(client_id, &ServerMessage::err(id, err)),
            }
            return None;
        }

        let outcome =
            match msg.method.as_str() {
                methods::TOPIC_LIST => {
                    Ok(serde_json::to_value(self.list_topics()).expect("topic list serializes"))
                }
                methods::TOPIC_UNSUBSCRIBE => parse_params::<TopicUnsubscribeParams>(msg.params)
                    .map(|parsed| {
                        self.unsubscribe(client_id, &parsed.topic);
                        json!({ "unsubscribed": parsed.topic })
                    }),
                methods::TOPIC_REGISTER => parse_params::<TopicRegisterParams>(msg.params)
                    .and_then(|parsed| {
                        let (topic_instance_id, revision) = self.register_plugin_topic(
                            client_id,
                            parsed.plugin_id,
                            parsed.topic,
                            parsed.initial,
                        )?;
                        Ok(json!({
                            "topic_instance_id": topic_instance_id,
                            "revision": revision,
                        }))
                    }),
                methods::TOPIC_PUBLISH => {
                    parse_params::<TopicPublishParams>(msg.params).and_then(|parsed| {
                        let revision =
                            self.publish_plugin_topic(client_id, parsed.topic, parsed.data)?;
                        Ok(json!({ "revision": revision }))
                    })
                }
                methods::TOPIC_UNREGISTER => parse_params::<TopicUnregisterParams>(msg.params)
                    .and_then(|parsed| {
                        self.unregister_plugin_topic(client_id, &parsed.topic)?;
                        Ok(json!({ "unregistered": parsed.topic }))
                    }),
                methods::COMMAND_LIST => Ok(
                    serde_json::to_value(self.list_commands()).expect("command list serializes")
                ),
                methods::COMMAND_REGISTER => parse_params::<CommandRegisterParams>(msg.params)
                    .and_then(|parsed| {
                        self.register_plugin_command(
                            client_id,
                            parsed.plugin_id,
                            parsed.name,
                            parsed.description,
                        )?;
                        Ok(json!({ "registered": true }))
                    }),
                methods::COMMAND_UNREGISTER => parse_params::<CommandUnregisterParams>(msg.params)
                    .and_then(|parsed| {
                        self.unregister_plugin_command(client_id, &parsed.name)?;
                        Ok(json!({ "unregistered": parsed.name }))
                    }),
                methods::COMMAND_REPLY => {
                    parse_params::<CommandReplyParams>(msg.params).and_then(|parsed| {
                        self.complete_plugin_command(client_id, parsed)?;
                        Ok(json!({ "accepted": true }))
                    })
                }
                methods::INHIBITOR_ACQUIRE => parse_params::<InhibitorAcquireParams>(msg.params)
                    .and_then(|parsed| {
                        let res = self.acquire_inhibitor(client_id, parsed)?;
                        Ok(serde_json::to_value(res).expect("InhibitorAcquireResult serializes"))
                    }),
                methods::INHIBITOR_RELEASE => parse_params::<InhibitorReleaseParams>(msg.params)
                    .and_then(|parsed| {
                        self.release_inhibitor(client_id, parsed.cookie)?;
                        Ok(json!({ "released": parsed.cookie }))
                    }),
                other => Err(RpcError::new(
                    ErrorCode::MethodNotFound,
                    format!("unknown RPC method {other:?}"),
                )),
            };

        let response = match outcome {
            Ok(val) => ServerMessage::ok(id, val),
            Err(err) => ServerMessage::err(id, err),
        };
        self.enqueue_control(client_id, &response);
        None
    }

    fn handle_hello(&self, client_id: u64, params: Option<Value>) -> Result<Value, RpcError> {
        let parsed: BusHelloParams = parse_params(params)?;
        if parsed.protocol_version != PROTOCOL_VERSION {
            return Err(RpcError::new(
                ErrorCode::VersionMismatch,
                format!(
                    "unsupported protocol version {}, daemon requires {PROTOCOL_VERSION}",
                    parsed.protocol_version
                ),
            ));
        }
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        let Some(client) = state.clients.get_mut(&client_id) else {
            return Err(RpcError::new(
                ErrorCode::PermissionDenied,
                "connection retired",
            ));
        };
        client.handshake_complete = true;
        let result = BusHelloResult {
            protocol_version: PROTOCOL_VERSION,
            daemon_version: self.inner.daemon_version.clone(),
            daemon_instance_id: self.inner.daemon_instance_id.clone(),
            client_id,
            role: client.role,
            media_dir: self.inner.media_dir.clone(),
        };
        Ok(serde_json::to_value(result).expect("BusHelloResult serializes"))
    }

    /// Registers subscription and pushes the `TopicSnapshot` response inside the SAME mutex lock
    /// so no concurrent `topic.update` can ever overtake the baseline snapshot on the wire.
    fn subscribe_and_enqueue_snapshot(&self, client_id: u64, req_id: RequestId, topic: TopicName) {
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        if !state.clients.contains_key(&client_id) {
            return;
        }
        let response = match state.topics.get_mut(&topic) {
            Some(record) => {
                record.subscribers.insert(client_id);
                let snapshot = TopicSnapshot {
                    daemon_instance_id: self.inner.daemon_instance_id.clone(),
                    topic_instance_id: record.topic_instance_id,
                    topic,
                    revision: record.revision,
                    data: record.data.clone(),
                };
                ServerMessage::ok(
                    req_id,
                    serde_json::to_value(snapshot).expect("TopicSnapshot serializes"),
                )
            }
            None => ServerMessage::err(
                req_id,
                RpcError::new(ErrorCode::NotFound, format!("unknown topic {topic}")),
            ),
        };
        if let Some(client) = state.clients.get_mut(&client_id) {
            client.push_control(&response, self.inner.limits);
        }
    }

    fn unsubscribe(&self, client_id: u64, topic: &TopicName) {
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        if let Some(record) = state.topics.get_mut(topic) {
            record.subscribers.remove(&client_id);
        }
    }

    fn register_plugin_topic(
        &self,
        client_id: u64,
        plugin_id: Option<PluginId>,
        topic: TopicName,
        initial: Value,
    ) -> Result<(u64, u64), RpcError> {
        if !topic.is_plugin_namespace() {
            return Err(RpcError::new(
                ErrorCode::PermissionDenied,
                format!("plugin topics must start with 'plugin.': got {topic}"),
            ));
        }
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        if !state.clients.contains_key(&client_id) {
            return Err(RpcError::new(
                ErrorCode::PermissionDenied,
                "connection retired",
            ));
        }
        let owned_count = state
            .topics
            .values()
            .filter(|rec| {
                matches!(rec.owner, TopicOwner::Plugin { client_id: owner, .. } if owner == client_id)
            })
            .count();
        if owned_count >= self.inner.limits.max_topics_per_client {
            return Err(RpcError::new(
                ErrorCode::ResourceExhausted,
                format!(
                    "client exceeded maximum of {} registered topics",
                    self.inner.limits.max_topics_per_client
                ),
            ));
        }
        if state.topics.contains_key(&topic) {
            return Err(RpcError::new(
                ErrorCode::AlreadyExists,
                format!("topic {topic} is already registered"),
            ));
        }
        let topic_instance_id = next_safe_id(&self.inner.next_topic_instance_id);
        state.topics.insert(
            topic,
            TopicRecord {
                topic_instance_id,
                revision: 1,
                data: initial,
                owner: TopicOwner::Plugin {
                    plugin_id,
                    client_id,
                },
                subscribers: BTreeSet::new(),
            },
        );
        Ok((topic_instance_id, 1))
    }

    fn publish_plugin_topic(
        &self,
        client_id: u64,
        topic: TopicName,
        data: Value,
    ) -> Result<u64, RpcError> {
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        if !state.clients.contains_key(&client_id) {
            return Err(RpcError::new(
                ErrorCode::PermissionDenied,
                "connection retired",
            ));
        }
        let (topic_instance_id, revision, subscribers) = {
            let Some(record) = state.topics.get_mut(&topic) else {
                return Err(RpcError::new(
                    ErrorCode::NotFound,
                    format!("unknown topic {topic}"),
                ));
            };
            match record.owner {
                TopicOwner::Plugin {
                    client_id: owner, ..
                } if owner == client_id => {}
                _ => {
                    return Err(RpcError::new(
                        ErrorCode::PermissionDenied,
                        format!("client does not own topic {topic}"),
                    ));
                }
            }
            record.revision = record.revision.checked_add(1).expect("revision overflow");
            record.data = data.clone();
            let subs: Vec<u64> = record.subscribers.iter().copied().collect();
            (record.topic_instance_id, record.revision, subs)
        };
        let update = TopicUpdate {
            daemon_instance_id: self.inner.daemon_instance_id.clone(),
            topic_instance_id,
            topic,
            revision,
            source_baseline: false,
            data,
        };
        deliver_topic_update_locked(
            &mut state,
            &subscribers,
            &update,
            &self.inner.daemon_instance_id,
            self.inner.limits,
        );
        Ok(revision)
    }

    fn unregister_plugin_topic(&self, client_id: u64, topic: &TopicName) -> Result<(), RpcError> {
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        let (topic_instance_id, subscribers) = {
            let Some(record) = state.topics.get(topic) else {
                return Err(RpcError::new(
                    ErrorCode::NotFound,
                    format!("unknown topic {topic}"),
                ));
            };
            match record.owner {
                TopicOwner::Plugin {
                    client_id: owner, ..
                } if owner == client_id => (
                    record.topic_instance_id,
                    record.subscribers.iter().copied().collect::<Vec<_>>(),
                ),
                _ => {
                    return Err(RpcError::new(
                        ErrorCode::PermissionDenied,
                        format!("client does not own topic {topic}"),
                    ));
                }
            }
        };
        state.topics.remove(topic);
        let removed = TopicRemovedNotification {
            daemon_instance_id: self.inner.daemon_instance_id.clone(),
            topic_instance_id,
            topic: topic.clone(),
        };
        let msg = ServerMessage::notification(
            methods::TOPIC_REMOVED,
            serde_json::to_value(removed).expect("TopicRemovedNotification serializes"),
        );
        for sub_id in subscribers {
            if let Some(client) = state.clients.get_mut(&sub_id) {
                client.push_control(&msg, self.inner.limits);
            }
        }
        Ok(())
    }

    fn register_plugin_command(
        &self,
        client_id: u64,
        plugin_id: Option<PluginId>,
        name: CommandName,
        description: String,
    ) -> Result<(), RpcError> {
        if !name.is_plugin_namespace() {
            return Err(RpcError::new(
                ErrorCode::PermissionDenied,
                format!("plugin commands must start with 'plugin.': got {name}"),
            ));
        }
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        if !state.clients.contains_key(&client_id) {
            return Err(RpcError::new(
                ErrorCode::PermissionDenied,
                "connection retired",
            ));
        }
        let owned_count = state
            .commands
            .values()
            .filter(|rec| matches!(rec.target, CommandTarget::Plugin { client_id: owner } if owner == client_id))
            .count();
        if owned_count >= self.inner.limits.max_commands_per_client {
            return Err(RpcError::new(
                ErrorCode::ResourceExhausted,
                format!(
                    "client exceeded maximum of {} registered commands",
                    self.inner.limits.max_commands_per_client
                ),
            ));
        }
        if state.commands.contains_key(&name) {
            return Err(RpcError::new(
                ErrorCode::AlreadyExists,
                format!("command {name} is already registered"),
            ));
        }
        state.commands.insert(
            name,
            CommandRecord {
                description,
                owner: TopicOwner::Plugin {
                    plugin_id,
                    client_id,
                },
                target: CommandTarget::Plugin { client_id },
            },
        );
        Ok(())
    }

    fn unregister_plugin_command(
        &self,
        client_id: u64,
        name: &CommandName,
    ) -> Result<(), RpcError> {
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        let Some(record) = state.commands.get(name) else {
            return Err(RpcError::new(
                ErrorCode::NotFound,
                format!("unknown command {name}"),
            ));
        };
        match record.target {
            CommandTarget::Plugin { client_id: owner } if owner == client_id => {
                state.commands.remove(name);
                Ok(())
            }
            _ => Err(RpcError::new(
                ErrorCode::PermissionDenied,
                format!("client does not own command {name}"),
            )),
        }
    }

    /// Invokes a core or plugin-registered control command with authenticated [`CallerContext`].
    ///
    /// # Errors
    ///
    /// Returns [`RpcError`] if the command is unknown, caller lacks permission, owner disconnects,
    /// or execution times out.
    pub async fn invoke_command(
        &self,
        caller: CallerContext,
        params: CommandInvokeParams,
    ) -> Result<CommandInvokeResult, RpcError> {
        enum Resolved {
            Core(CommandHandler),
            Plugin {
                call_id: u64,
                rx: oneshot::Receiver<Result<CommandInvokeResult, RpcError>>,
            },
        }

        let resolved = {
            let mut state = self.inner.state.lock().expect("hub state lock poisoned");
            let Some(record) = state.commands.get(&params.name) else {
                return Err(RpcError::new(
                    ErrorCode::NotFound,
                    format!("unknown command {}", params.name),
                ));
            };
            match &record.target {
                CommandTarget::Core(handler) => Resolved::Core(Arc::clone(handler)),
                CommandTarget::Plugin { client_id } => {
                    let owner_id = *client_id;
                    let call_id = next_safe_id(&self.inner.next_call_id);
                    let dispatch = CommandDispatchNotification {
                        call_id,
                        name: params.name.clone(),
                        args: params.args.clone(),
                        payload: params.payload.clone(),
                    };
                    let msg = ServerMessage::notification(
                        methods::COMMAND_DISPATCH,
                        serde_json::to_value(dispatch)
                            .expect("CommandDispatchNotification serializes"),
                    );
                    let Some(owner_client) = state.clients.get_mut(&owner_id) else {
                        return Err(RpcError::new(
                            ErrorCode::NotFound,
                            format!("owner of command {} is disconnected", params.name),
                        ));
                    };
                    if !owner_client.push_control(&msg, self.inner.limits) {
                        return Err(RpcError::new(
                            ErrorCode::ResourceExhausted,
                            "plugin client outbound queue full or closed",
                        ));
                    }
                    let (reply_tx, reply_rx) = oneshot::channel();
                    state.pending_calls.insert(
                        call_id,
                        PendingPluginCall {
                            owner_client_id: owner_id,
                            reply: reply_tx,
                        },
                    );
                    Resolved::Plugin {
                        call_id,
                        rx: reply_rx,
                    }
                }
            }
        };

        match resolved {
            Resolved::Core(handler) => {
                handler(CommandCall {
                    caller,
                    params,
                    hub: self.clone(),
                })
                .await
            }
            Resolved::Plugin { call_id, rx } => {
                match tokio::time::timeout(PLUGIN_COMMAND_TIMEOUT, rx).await {
                    Ok(Ok(outcome)) => outcome,
                    Ok(Err(_)) => Err(RpcError::new(
                        ErrorCode::Internal,
                        "plugin command reply channel dropped",
                    )),
                    Err(_) => {
                        self.inner
                            .state
                            .lock()
                            .expect("hub state lock poisoned")
                            .pending_calls
                            .remove(&call_id);
                        Err(RpcError::new(
                            ErrorCode::Timeout,
                            "plugin command timed out",
                        ))
                    }
                }
            }
        }
    }

    fn complete_plugin_command(
        &self,
        client_id: u64,
        reply: CommandReplyParams,
    ) -> Result<(), RpcError> {
        let pending = {
            let mut state = self.inner.state.lock().expect("hub state lock poisoned");
            match state.pending_calls.get(&reply.call_id) {
                Some(entry) if entry.owner_client_id != client_id => {
                    return Err(RpcError::new(
                        ErrorCode::PermissionDenied,
                        format!("client does not own command call {}", reply.call_id),
                    ));
                }
                None => {
                    return Err(RpcError::new(
                        ErrorCode::NotFound,
                        format!("unknown or expired command call {}", reply.call_id),
                    ));
                }
                Some(_) => state
                    .pending_calls
                    .remove(&reply.call_id)
                    .expect("checked present above"),
            }
        };

        let outcome = if let Some(err_msg) = reply.error {
            Err(RpcError::new(ErrorCode::Internal, err_msg))
        } else {
            Ok(reply.result.unwrap_or(CommandInvokeResult {
                message: None,
                data: None,
            }))
        };
        let _ = pending.reply.send(outcome);
        Ok(())
    }

    fn acquire_inhibitor(
        &self,
        client_id: u64,
        params: InhibitorAcquireParams,
    ) -> Result<InhibitorAcquireResult, RpcError> {
        if params.reason.trim().is_empty() {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "inhibitor reason must not be empty",
            ));
        }
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        if !state.clients.contains_key(&client_id) {
            return Err(RpcError::new(
                ErrorCode::PermissionDenied,
                "connection retired",
            ));
        }
        let owned_count = state
            .inhibitors
            .values()
            .filter(|entry| {
                matches!(entry.owner, TopicOwner::Plugin { client_id: owner, .. } if owner == client_id)
            })
            .count();
        if owned_count >= self.inner.limits.max_inhibitors_per_client {
            return Err(RpcError::new(
                ErrorCode::ResourceExhausted,
                format!(
                    "client exceeded maximum of {} active inhibitors",
                    self.inner.limits.max_inhibitors_per_client
                ),
            ));
        }
        let cookie = next_safe_id(&self.inner.next_inhibitor_cookie);
        state.inhibitors.insert(
            cookie,
            InhibitorEntry {
                cookie,
                scope: params.scope,
                reason: params.reason,
                owner: TopicOwner::Plugin {
                    plugin_id: params.plugin_id,
                    client_id,
                },
            },
        );
        publish_inhibitors_locked(
            &mut state,
            &self.inner.daemon_instance_id,
            self.inner.limits,
        );
        Ok(InhibitorAcquireResult { cookie })
    }

    fn release_inhibitor(&self, client_id: u64, cookie: u64) -> Result<(), RpcError> {
        let mut state = self.inner.state.lock().expect("hub state lock poisoned");
        let Some(entry) = state.inhibitors.get(&cookie) else {
            return Err(RpcError::new(
                ErrorCode::NotFound,
                format!("unknown inhibitor cookie {cookie}"),
            ));
        };
        match entry.owner {
            TopicOwner::Plugin {
                client_id: owner, ..
            } if owner == client_id => {
                state.inhibitors.remove(&cookie);
                publish_inhibitors_locked(
                    &mut state,
                    &self.inner.daemon_instance_id,
                    self.inner.limits,
                );
                Ok(())
            }
            _ => Err(RpcError::new(
                ErrorCode::PermissionDenied,
                format!("client does not own inhibitor cookie {cookie}"),
            )),
        }
    }
}

fn deliver_topic_update_locked(
    state: &mut HubState,
    subscribers: &[u64],
    update: &TopicUpdate,
    daemon_instance_id: &str,
    limits: BusLimits,
) {
    let msg = ServerMessage::notification(
        methods::TOPIC_UPDATE,
        serde_json::to_value(update).expect("TopicUpdate serializes"),
    );
    let Ok(encoded) = encode_line(&msg) else {
        return;
    };

    let mut overflowed_clients = Vec::new();
    for &sub_id in subscribers {
        if let Some(client) = state.clients.get_mut(&sub_id)
            && !client.try_push_topic_update(&encoded, limits)
        {
            overflowed_clients.push(sub_id);
        }
    }

    // For any slow subscriber that exceeded frame/byte budgets, clear its subscriptions, purge stale
    // queued topic updates, and enqueue an explicit `topic.reset` notification so it re-subscribes.
    for sub_id in overflowed_clients {
        let mut dropped_topics = Vec::new();
        for (name, rec) in &mut state.topics {
            if rec.subscribers.remove(&sub_id) {
                dropped_topics.push(name.clone());
            }
        }
        if let Some(client) = state.clients.get_mut(&sub_id) {
            client.purge_topic_updates();
            let reset = TopicResetNotification {
                daemon_instance_id: daemon_instance_id.to_owned(),
                reason:
                    "outbound topic queue budget exceeded; re-subscribe to recover latest state"
                        .to_owned(),
                topics: dropped_topics,
            };
            let reset_msg = ServerMessage::notification(
                methods::TOPIC_RESET,
                serde_json::to_value(reset).expect("TopicResetNotification serializes"),
            );
            client.push_control(&reset_msg, limits);
        }
    }
}

fn publish_inhibitors_locked(state: &mut HubState, daemon_instance_id: &str, limits: BusLimits) {
    let topic = TopicName::try_new(INHIBITORS_TOPIC).expect("INHIBITORS_TOPIC is valid");
    let entries: Vec<InhibitorEntry> = state.inhibitors.values().cloned().collect();
    let data = serde_json::to_value(entries).expect("inhibitor list serializes");
    let Some(record) = state.topics.get_mut(&topic) else {
        return;
    };
    record.revision = record.revision.checked_add(1).expect("revision overflow");
    record.data = data.clone();
    let topic_instance_id = record.topic_instance_id;
    let revision = record.revision;
    let subscribers: Vec<u64> = record.subscribers.iter().copied().collect();
    let update = TopicUpdate {
        daemon_instance_id: daemon_instance_id.to_owned(),
        topic_instance_id,
        topic,
        revision,
        source_baseline: false,
        data,
    };
    deliver_topic_update_locked(state, &subscribers, &update, daemon_instance_id, limits);
}

fn next_safe_id(counter: &AtomicU64) -> u64 {
    let id = counter.fetch_add(1, Ordering::Relaxed);
    assert!(
        id <= MAX_SAFE_JS_INT,
        "protocol identifier {id} exceeded MAX_SAFE_JS_INT"
    );
    id
}

fn parse_params<T: serde::de::DeserializeOwned>(params: Option<Value>) -> Result<T, RpcError> {
    let val = params.unwrap_or(Value::Null);
    serde_json::from_value(val).map_err(|err| {
        RpcError::new(
            ErrorCode::InvalidParams,
            format!("invalid RPC parameters: {err}"),
        )
    })
}

/// Builds an uncorrelatable (`id: null`) malformed-request error response.
#[must_use]
pub fn invalid_request_frame(message: impl Into<String>) -> ServerMessage {
    ServerMessage::parse_err(RpcError::new(ErrorCode::InvalidRequest, message))
}
