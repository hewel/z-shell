//! Wire protocol, validated domain identifiers, and NDJSON framing for the z-shell bus.

pub mod identifiers;
pub mod messages;
pub mod wire;

pub use identifiers::{
    CommandName, IdentifierError, MAX_IDENTIFIER_LEN, MAX_SEGMENT_LEN, PluginEntryId,
    PluginEntryKind, PluginId, TopicName,
};
pub use messages::{
    BusHelloParams, BusHelloResult, ClientRole, CommandDispatchNotification, CommandInvokeParams,
    CommandInvokeResult, CommandRegisterParams, CommandReplyParams, CommandSummary,
    CommandUnregisterParams, InhibitorAcquireParams, InhibitorAcquireResult, InhibitorEntry,
    InhibitorReleaseParams, InhibitorScope, MediaRef, TopicListEntry, TopicOwner,
    TopicPublishParams, TopicRegisterParams, TopicRemovedNotification, TopicResetNotification,
    TopicSnapshot, TopicSubscribeParams, TopicUnregisterParams, TopicUnsubscribeParams,
    TopicUpdate, methods,
};
pub use wire::{
    ClientMessage, ErrorCode, JSONRPC_VERSION, MAX_FRAME_BYTES, MAX_SAFE_JS_INT, PROTOCOL_VERSION,
    RequestId, RpcError, ServerMessage, WireError, decode_client_line, decode_server_line,
    encode_line,
};
