//! Strongly typed RPC payloads and push notifications for the z-shell bus.

use crate::identifiers::{CommandName, PluginId, TopicName};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

/// Canonical JSON-RPC method and notification names on the bus.
pub mod methods {
    /// Mandatory handshake negotiating protocol version, daemon instance ID, client ID, and role.
    pub const BUS_HELLO: &str = "bus.hello";
    /// Lists all active topics, their topic instance IDs, and current revisions.
    pub const TOPIC_LIST: &str = "topic.list";
    /// Subscribes the calling client to a topic and returns its ordered subscription snapshot.
    pub const TOPIC_SUBSCRIBE: &str = "topic.subscribe";
    /// Unsubscribes the calling client from a topic.
    pub const TOPIC_UNSUBSCRIBE: &str = "topic.unsubscribe";
    /// Registers a plugin-owned custom topic under the `plugin.` namespace.
    pub const TOPIC_REGISTER: &str = "topic.register";
    /// Publishes a new revision for a plugin-owned custom topic.
    pub const TOPIC_PUBLISH: &str = "topic.publish";
    /// Unregisters a previously registered plugin-owned custom topic.
    pub const TOPIC_UNREGISTER: &str = "topic.unregister";
    /// Server push notification delivering a strictly ordered monotonic topic revision.
    pub const TOPIC_UPDATE: &str = "topic.update";
    /// Server push notification announcing that a plugin topic was removed or its owner disconnected.
    pub const TOPIC_REMOVED: &str = "topic.removed";
    /// Server push notification telling a slow subscriber its topic queue overflowed and must re-subscribe.
    pub const TOPIC_RESET: &str = "topic.reset";
    /// Lists all registered control commands (core and plugin).
    pub const COMMAND_LIST: &str = "command.list";
    /// Invokes a registered control command by name.
    pub const COMMAND_INVOKE: &str = "command.invoke";
    /// Registers a plugin-handled control command under the `plugin.` namespace.
    pub const COMMAND_REGISTER: &str = "command.register";
    /// Unregisters a previously registered plugin control command.
    pub const COMMAND_UNREGISTER: &str = "command.unregister";
    /// Server push notification forwarding a control command invocation to its owning plugin.
    pub const COMMAND_DISPATCH: &str = "command.dispatch";
    /// Client request returning the result of a dispatched control command.
    pub const COMMAND_REPLY: &str = "command.reply";
    /// Acquires a connection-scoped idle/sleep/lock inhibitor (auto-released on disconnect).
    pub const INHIBITOR_ACQUIRE: &str = "inhibitor.acquire";
    /// Releases a previously acquired inhibitor.
    pub const INHIBITOR_RELEASE: &str = "inhibitor.release";
}

/// Trust tier assigned strictly by which authenticated socket accepted the connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ClientRole {
    /// Connected over the public bus channel (`bus-<display>.sock`): CLI, observers, ordinary bus clients.
    Public,
    /// Connected over the host control channel (`host-<display>.sock`): trusted `zgui-js` native host.
    PrivilegedHost,
}

/// Parameters for the mandatory `bus.hello` handshake.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusHelloParams {
    /// Protocol version requested by the caller (must equal [`crate::PROTOCOL_VERSION`]).
    pub protocol_version: u32,
    /// Optional human-readable client label for diagnostics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
}

/// Response payload for `bus.hello`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusHelloResult {
    /// Negotiated wire protocol schema version.
    pub protocol_version: u32,
    /// Running shell daemon package version.
    pub daemon_version: String,
    /// Unique identifier for this shell daemon boot incarnation.
    pub daemon_instance_id: String,
    /// Unique identifier assigned to this client connection (safe JS integer).
    pub client_id: u64,
    /// Trust tier assigned by the daemon based on the accepting socket.
    pub role: ClientRole,
    /// Runtime media directory containing host-cached non-sensitive assets.
    pub media_dir: PathBuf,
}

/// Identifies whether a topic or command is owned by the daemon core or a connected plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum TopicOwner {
    /// Built-in daemon domain.
    Core,
    /// Registered dynamically by a connected bus client (`plugin_id` is attribution metadata only).
    Plugin {
        /// Optional attribution plugin identifier.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plugin_id: Option<PluginId>,
        /// Owning bus connection identifier.
        client_id: u64,
    },
}

/// Summary row returned by `topic.list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopicListEntry {
    /// Validated topic name.
    pub topic: TopicName,
    /// Monotonic topic lifecycle instance ID (changes when recreated).
    pub topic_instance_id: u64,
    /// Current monotonic revision number within this topic instance.
    pub revision: u64,
    /// Core or plugin owner.
    pub owner: TopicOwner,
}

/// Parameters for `topic.subscribe`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopicSubscribeParams {
    /// Topic to subscribe to.
    pub topic: TopicName,
}

/// Parameters for `topic.unsubscribe`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopicUnsubscribeParams {
    /// Topic to unsubscribe from.
    pub topic: TopicName,
}

/// Subscription snapshot returned synchronously by `topic.subscribe`, guaranteed ordered before any
/// subsequent `topic.update` frames on the same connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TopicSnapshot {
    /// Boot incarnation of the daemon serving this topic.
    pub daemon_instance_id: String,
    /// Monotonic lifecycle instance of this topic.
    pub topic_instance_id: u64,
    /// Subscribed topic name.
    pub topic: TopicName,
    /// Revision at the exact serialization point of subscription.
    pub revision: u64,
    /// Current committed JSON payload.
    pub data: Value,
}

/// Server notification pushed via `topic.update` on every strictly ordered revision commit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TopicUpdate {
    /// Boot incarnation of the daemon serving this topic.
    pub daemon_instance_id: String,
    /// Monotonic lifecycle instance of this topic.
    pub topic_instance_id: u64,
    /// Updated topic name.
    pub topic: TopicName,
    /// Strictly increasing revision number within `topic_instance_id`.
    pub revision: u64,
    /// `true` only when an external source first settles or re-syncs its baseline; `false` for live transitions.
    pub source_baseline: bool,
    /// Updated committed JSON payload.
    pub data: Value,
}

/// Server notification pushed via `topic.removed` when a plugin topic is unregistered or its owner disconnects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopicRemovedNotification {
    /// Boot incarnation of the daemon.
    pub daemon_instance_id: String,
    /// Lifecycle instance of the removed topic.
    pub topic_instance_id: u64,
    /// Removed topic name.
    pub topic: TopicName,
}

/// Server notification pushed via `topic.reset` when a slow subscriber exceeds its outbound topic queue budget.
///
/// The daemon clears the listed subscriptions so the client can explicitly re-subscribe and receive
/// a fresh consistent [`TopicSnapshot`] without silently stalling on stale state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopicResetNotification {
    /// Boot incarnation of the daemon.
    pub daemon_instance_id: String,
    /// Diagnostic explanation for the reset.
    pub reason: String,
    /// Topics whose subscriptions were dropped and must be re-subscribed.
    pub topics: Vec<TopicName>,
}

/// Parameters for `topic.register` (plugin-owned custom topic).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TopicRegisterParams {
    /// Custom topic name; must reside in the `plugin.` namespace.
    pub topic: TopicName,
    /// Optional attribution plugin identifier (not a security credential).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<PluginId>,
    /// Initial baseline payload.
    pub initial: Value,
}

/// Parameters for `topic.publish`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TopicPublishParams {
    /// Plugin-owned topic name.
    pub topic: TopicName,
    /// Replacement JSON payload for the new revision.
    pub data: Value,
}

/// Parameters for `topic.unregister`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TopicUnregisterParams {
    /// Plugin-owned topic name to remove.
    pub topic: TopicName,
}

/// Summary row returned by `command.list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandSummary {
    /// Validated control command name.
    pub name: CommandName,
    /// Concise human-readable description.
    pub description: String,
    /// Core or plugin owner.
    pub owner: TopicOwner,
}

/// Parameters for `command.register`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandRegisterParams {
    /// Control command name to claim; must reside in the `plugin.` namespace.
    pub name: CommandName,
    /// Concise human-readable description.
    pub description: String,
    /// Optional attribution plugin identifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<PluginId>,
}

/// Parameters for `command.unregister`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandUnregisterParams {
    /// Control command name to release.
    pub name: CommandName,
}

/// Parameters for `command.invoke`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandInvokeParams {
    /// Target control command name.
    pub name: CommandName,
    /// Optional positional CLI arguments.
    #[serde(default)]
    pub args: Vec<String>,
    /// Optional structured JSON payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

/// Successful response payload for `command.invoke`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandInvokeResult {
    /// Optional concise text output for CLI display.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Optional structured JSON result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Push notification (`command.dispatch`) sent by the daemon to a plugin owning an invoked command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandDispatchNotification {
    /// Unique call identifier to echo in `command.reply`.
    pub call_id: u64,
    /// Invoked control command name.
    pub name: CommandName,
    /// Positional arguments passed by the invoker.
    #[serde(default)]
    pub args: Vec<String>,
    /// Optional structured payload passed by the invoker.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

/// Client request (`command.reply`) sent by a plugin to complete a dispatched command.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandReplyParams {
    /// Call identifier received in [`CommandDispatchNotification`].
    pub call_id: u64,
    /// Successful command output, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<CommandInvokeResult>,
    /// Failure message if the plugin rejected or failed the command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Idle/sleep policy categories that an inhibitor can defer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum InhibitorScope {
    /// Defers automatic inactivity actions (such as screen-off or lock).
    Idle,
    /// Defers automatic suspend actions.
    Sleep,
    /// Defers automatic screen lock while allowing screen-off.
    Lock,
}

/// Parameters for `inhibitor.acquire`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InhibitorAcquireParams {
    /// Policy scope to inhibit.
    pub scope: InhibitorScope,
    /// Human-readable reason shown in status panels.
    pub reason: String,
    /// Optional attribution plugin identifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<PluginId>,
}

/// Response payload for `inhibitor.acquire`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InhibitorAcquireResult {
    /// Cookie uniquely identifying the acquired inhibitor.
    pub cookie: u64,
}

/// Parameters for `inhibitor.release`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InhibitorReleaseParams {
    /// Cookie returned by `inhibitor.acquire`.
    pub cookie: u64,
}

/// Public snapshot entry published on the `inhibitors` topic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InhibitorEntry {
    /// Unique inhibitor cookie.
    pub cookie: u64,
    /// Inhibited scope.
    pub scope: InhibitorScope,
    /// Human-readable reason.
    pub reason: String,
    /// Owner metadata.
    pub owner: TopicOwner,
}

/// Out-of-band daemon media token (never base64-inlined in JSON; resolved by native host to `zgui-blob://`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum MediaRef {
    /// Non-sensitive asset cached under `$XDG_RUNTIME_DIR/z-shell/media/` (`0700`).
    RuntimePath {
        /// Absolute path inside the shell daemon's restricted media cache.
        path: PathBuf,
        /// MIME type (for example, `image/png` or `image/svg+xml`).
        mime: String,
        /// Monotonic content revision so replacements at the same path invalidate UI caches.
        revision: u64,
    },
    /// Ephemeral or sensitive in-memory image bytes pulled out-of-band by the native host.
    BlobHandle {
        /// Short-lived session-scoped opaque token.
        token: String,
        /// MIME type of the encoded or raw pixel payload.
        mime: String,
        /// Exact byte length of the payload.
        byte_len: u64,
    },
}
