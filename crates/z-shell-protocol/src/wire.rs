//! Strict z-shell NDJSON JSON-RPC 2.0 envelope types and bounded framing helpers.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Map, Value};
use std::fmt;
use thiserror::Error;

/// JSON-RPC protocol tag required on every bus envelope.
pub const JSONRPC_VERSION: &str = "2.0";

/// Monotonic schema version for the z-shell bus protocol.
pub const PROTOCOL_VERSION: u32 = 1;

/// Maximum serialized byte length of one NDJSON line (1 MiB).
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Maximum integer representable losslessly as an IEEE-754 JavaScript `number` (`2^53 - 1`).
pub const MAX_SAFE_JS_INT: u64 = (1u64 << 53) - 1;

/// Error returned while encoding or decoding an NDJSON bus frame.
#[derive(Debug, Error)]
pub enum WireError {
    /// Encoded or received line exceeds [`MAX_FRAME_BYTES`].
    #[error("bus frame exceeds maximum size of {MAX_FRAME_BYTES} bytes: got {actual} bytes")]
    FrameTooLarge {
        /// Observed frame size in bytes.
        actual: usize,
    },
    /// Frame contains an embedded newline that violates NDJSON framing.
    #[error("encoded frame unexpectedly contained a newline")]
    EmbeddedNewline,
    /// Envelope violated protocol invariants (`jsonrpc != "2.0"`, invalid ID range, ambiguous response).
    #[error("invalid protocol envelope: {0}")]
    InvalidEnvelope(String),
    /// JSON serialization or deserialization failed.
    #[error("invalid JSON frame: {0}")]
    Json(#[from] serde_json::Error),
}

/// JSON-RPC correlation identifier chosen by the caller (numeric IDs bounded to [`MAX_SAFE_JS_INT`]).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RequestId {
    /// Safe integer request identifier (`<= 2^53 - 1`).
    Number(u64),
    /// Non-empty string request identifier.
    String(String),
}

impl RequestId {
    /// Creates a validated numeric [`RequestId`].
    ///
    /// # Errors
    ///
    /// Returns [`WireError::InvalidEnvelope`] if `n > MAX_SAFE_JS_INT`.
    pub fn try_number(n: u64) -> Result<Self, WireError> {
        if n > MAX_SAFE_JS_INT {
            return Err(WireError::InvalidEnvelope(format!(
                "numeric request id {n} exceeds MAX_SAFE_JS_INT ({MAX_SAFE_JS_INT})"
            )));
        }
        Ok(Self::Number(n))
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Number(n) => write!(f, "{n}"),
            Self::String(s) => f.write_str(s),
        }
    }
}

impl Serialize for RequestId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Number(n) => {
                if *n > MAX_SAFE_JS_INT {
                    return Err(serde::ser::Error::custom(
                        "numeric request id exceeds MAX_SAFE_JS_INT",
                    ));
                }
                serializer.serialize_u64(*n)
            }
            Self::String(s) => serializer.serialize_str(s),
        }
    }
}

impl<'de> Deserialize<'de> for RequestId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let val = Value::deserialize(deserializer)?;
        match val {
            Value::Number(num) => {
                let Some(n) = num.as_u64() else {
                    return Err(serde::de::Error::custom(
                        "request id number must be a non-negative integer",
                    ));
                };
                Self::try_number(n).map_err(serde::de::Error::custom)
            }
            Value::String(s) if !s.is_empty() && s.len() <= 128 => Ok(Self::String(s)),
            _ => Err(serde::de::Error::custom(
                "request id must be a safe non-negative integer or non-empty string",
            )),
        }
    }
}

/// Structured machine-readable RPC error code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ErrorCode {
    /// Malformed request envelope or invalid JSON.
    InvalidRequest,
    /// Caller issued a non-handshake method before completing `bus.hello`.
    HandshakeRequired,
    /// Client requested an unsupported protocol version during `bus.hello`.
    VersionMismatch,
    /// Unknown RPC method name.
    MethodNotFound,
    /// Invalid or missing RPC method parameters.
    InvalidParams,
    /// Requested resource (topic, command, inhibitor, or blob) was not found.
    NotFound,
    /// Registration conflicts with an already-claimed name or resource.
    AlreadyExists,
    /// Caller does not own the resource or lacks permission for the operation.
    PermissionDenied,
    /// Connection exceeded a daemon resource budget (in-flight requests, registrations, or frame size).
    ResourceExhausted,
    /// Delegated plugin handler did not respond before the deadline.
    Timeout,
    /// Feature or remote action is disabled (for example, `offline_mode`).
    Disabled,
    /// Unexpected internal daemon error.
    Internal,
}

/// Error payload carried inside a failed JSON-RPC response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcError {
    /// Machine-readable error category.
    pub code: ErrorCode,
    /// Human-readable diagnostic message.
    pub message: String,
    /// Optional structured error details.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    /// Creates a new [`RpcError`] without extra data.
    #[must_use]
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    /// Attaches structured detail data to this error.
    #[must_use]
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

/// Inbound NDJSON frame sent from a client (UI, plugin, or CLI) to the shell daemon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientMessage {
    /// Must equal `"2.0"`.
    pub jsonrpc: String,
    /// Present for request frames; absent for fire-and-forget client notifications.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<RequestId>,
    /// Target RPC method name.
    pub method: String,
    /// Optional JSON parameters object or value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl ClientMessage {
    /// Builds a JSON-RPC request frame expecting a response.
    #[must_use]
    pub fn request(id: RequestId, method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id: Some(id),
            method: method.into(),
            params,
        }
    }

    /// Builds a JSON-RPC notification frame expecting no response.
    #[must_use]
    pub fn notification(method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_owned(),
            id: None,
            method: method.into(),
            params,
        }
    }
}

/// Outbound NDJSON frame sent from the shell daemon to a connected client.
///
/// Responses strictly enforce mutually exclusive `result` vs `error` fields, with `id: None`
/// (`null`) reserved exclusively for uncorrelatable parse/envelope errors.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerMessage {
    /// Successful response correlated to a prior client request (explicitly supports `Value::Null`).
    Ok {
        /// Correlated request identifier.
        id: RequestId,
        /// Successful JSON payload (including `Value::Null`).
        result: Value,
    },
    /// Failed response correlated to a request, or `id: None` (`null`) for uncorrelatable parse errors.
    Err {
        /// Correlated request identifier, or `None` when the inbound request ID could not be parsed.
        id: Option<RequestId>,
        /// Structured RPC error payload.
        error: RpcError,
    },
    /// Server-initiated push notification (topic updates, removals, resets, command dispatches).
    Notification {
        /// Notification method name.
        method: String,
        /// Structured notification payload.
        params: Value,
    },
}

impl ServerMessage {
    /// Constructs a successful response envelope.
    #[must_use]
    pub fn ok(id: RequestId, result: Value) -> Self {
        Self::Ok { id, result }
    }

    /// Constructs a correlated error response envelope.
    #[must_use]
    pub fn err(id: RequestId, error: RpcError) -> Self {
        Self::Err {
            id: Some(id),
            error,
        }
    }

    /// Constructs an uncorrelatable (`id: null`) error response envelope for malformed input frames.
    #[must_use]
    pub fn parse_err(error: RpcError) -> Self {
        Self::Err { id: None, error }
    }

    /// Constructs a push notification envelope.
    #[must_use]
    pub fn notification(method: impl Into<String>, params: Value) -> Self {
        Self::Notification {
            method: method.into(),
            params,
        }
    }

    /// Returns true if this frame is a `topic.update` notification eligible for slow-consumer reset.
    #[must_use]
    pub fn is_topic_update(&self) -> bool {
        matches!(self, Self::Notification { method, .. } if method == crate::messages::methods::TOPIC_UPDATE)
    }
}

impl Serialize for ServerMessage {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = Map::new();
        map.insert(
            "jsonrpc".to_owned(),
            Value::String(JSONRPC_VERSION.to_owned()),
        );
        match self {
            Self::Ok { id, result } => {
                map.insert(
                    "id".to_owned(),
                    serde_json::to_value(id).map_err(serde::ser::Error::custom)?,
                );
                map.insert("result".to_owned(), result.clone());
            }
            Self::Err { id, error } => {
                let id_val = match id {
                    Some(req_id) => {
                        serde_json::to_value(req_id).map_err(serde::ser::Error::custom)?
                    }
                    None => Value::Null,
                };
                map.insert("id".to_owned(), id_val);
                map.insert(
                    "error".to_owned(),
                    serde_json::to_value(error).map_err(serde::ser::Error::custom)?,
                );
            }
            Self::Notification { method, params } => {
                map.insert("method".to_owned(), Value::String(method.clone()));
                map.insert("params".to_owned(), params.clone());
            }
        }
        Value::Object(map).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ServerMessage {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut obj = Map::deserialize(deserializer)?;
        let Some(version) = obj.remove("jsonrpc").and_then(|v| match v {
            Value::String(s) => Some(s),
            _ => None,
        }) else {
            return Err(serde::de::Error::custom("missing string field 'jsonrpc'"));
        };
        if version != JSONRPC_VERSION {
            return Err(serde::de::Error::custom(format!(
                "unsupported jsonrpc version {version:?}"
            )));
        }

        if let Some(method_val) = obj.remove("method") {
            if obj.contains_key("id") || obj.contains_key("result") || obj.contains_key("error") {
                return Err(serde::de::Error::custom(
                    "notification frame cannot contain id, result, or error",
                ));
            }
            let Value::String(method) = method_val else {
                return Err(serde::de::Error::custom(
                    "notification method must be a string",
                ));
            };
            let Some(params) = obj.remove("params") else {
                return Err(serde::de::Error::custom("notification missing 'params'"));
            };
            if !obj.is_empty() {
                return Err(serde::de::Error::custom(
                    "unknown field in notification frame",
                ));
            }
            return Ok(Self::Notification { method, params });
        }

        let Some(id_val) = obj.remove("id") else {
            return Err(serde::de::Error::custom(
                "server frame must be either a response with 'id' or a notification with 'method'",
            ));
        };
        let has_result = obj.contains_key("result");
        let has_error = obj.contains_key("error");
        match (has_result, has_error) {
            (true, false) => {
                let id: RequestId =
                    serde_json::from_value(id_val).map_err(serde::de::Error::custom)?;
                let result = obj.remove("result").expect("checked present");
                if !obj.is_empty() {
                    return Err(serde::de::Error::custom("unknown field in ok response"));
                }
                Ok(Self::Ok { id, result })
            }
            (false, true) => {
                let id = if id_val.is_null() {
                    None
                } else {
                    Some(serde_json::from_value(id_val).map_err(serde::de::Error::custom)?)
                };
                let error: RpcError =
                    serde_json::from_value(obj.remove("error").expect("checked present"))
                        .map_err(serde::de::Error::custom)?;
                if !obj.is_empty() {
                    return Err(serde::de::Error::custom("unknown field in error response"));
                }
                Ok(Self::Err { id, error })
            }
            _ => Err(serde::de::Error::custom(
                "response frame must contain exactly one of 'result' or 'error'",
            )),
        }
    }
}

/// Serializes any frame as a single NDJSON line ending in `\n`.
///
/// # Errors
///
/// Returns [`WireError`] if JSON serialization fails or the frame exceeds [`MAX_FRAME_BYTES`].
pub fn encode_line<T: Serialize>(frame: &T) -> Result<String, WireError> {
    let mut line = serde_json::to_string(frame)?;
    if line.contains('\n') || line.contains('\r') {
        return Err(WireError::EmbeddedNewline);
    }
    line.push('\n');
    if line.len() > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge { actual: line.len() });
    }
    Ok(line)
}

/// Decodes and validates a single NDJSON line into a [`ClientMessage`].
///
/// # Errors
///
/// Returns [`WireError`] if the line exceeds [`MAX_FRAME_BYTES`], is invalid JSON, or violates
/// `jsonrpc == "2.0"`.
pub fn decode_client_line(line: &str) -> Result<ClientMessage, WireError> {
    if line.len() > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge { actual: line.len() });
    }
    let msg: ClientMessage = serde_json::from_str(line.trim_end_matches(['\r', '\n']))?;
    if msg.jsonrpc != JSONRPC_VERSION {
        return Err(WireError::InvalidEnvelope(format!(
            "unsupported jsonrpc version {:?}",
            msg.jsonrpc
        )));
    }
    if msg.method.is_empty() {
        return Err(WireError::InvalidEnvelope(
            "method must not be empty".to_owned(),
        ));
    }
    Ok(msg)
}

/// Decodes and validates a single NDJSON line into a [`ServerMessage`].
///
/// # Errors
///
/// Returns [`WireError`] if the line exceeds [`MAX_FRAME_BYTES`], is invalid JSON, or violates
/// strict response/notification envelope invariants.
pub fn decode_server_line(line: &str) -> Result<ServerMessage, WireError> {
    if line.len() > MAX_FRAME_BYTES {
        return Err(WireError::FrameTooLarge { actual: line.len() });
    }
    Ok(serde_json::from_str(line.trim_end_matches(['\r', '\n']))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identifiers::{PluginId, TopicName};
    use serde_json::json;

    #[test]
    fn round_trips_client_and_server_frames() {
        let req = ClientMessage::request(
            RequestId::try_number(7).unwrap(),
            "topic.subscribe",
            Some(json!({ "topic": "settings" })),
        );
        let line = encode_line(&req).unwrap();
        assert!(line.ends_with('\n'));
        assert_eq!(decode_client_line(&line).unwrap(), req);

        let ok_null = ServerMessage::ok(RequestId::try_number(7).unwrap(), Value::Null);
        assert_eq!(
            decode_server_line(&encode_line(&ok_null).unwrap()).unwrap(),
            ok_null
        );

        let parse_err =
            ServerMessage::parse_err(RpcError::new(ErrorCode::InvalidRequest, "bad json"));
        let encoded_err = encode_line(&parse_err).unwrap();
        assert!(encoded_err.contains("\"id\":null"));
        assert_eq!(decode_server_line(&encoded_err).unwrap(), parse_err);
    }

    #[test]
    fn validates_shared_cross_language_protocol_vectors() {
        let raw = include_str!("../../../schemas/protocol-vectors.json");
        let vectors: Value = serde_json::from_str(raw).unwrap();

        for topic in vectors["valid_topics"].as_array().unwrap() {
            assert!(
                TopicName::try_new(topic.as_str().unwrap()).is_ok(),
                "expected valid topic: {topic}"
            );
        }
        for topic in vectors["invalid_topics"].as_array().unwrap() {
            assert!(
                TopicName::try_new(topic.as_str().unwrap()).is_err(),
                "expected invalid topic: {topic}"
            );
        }
        for pid in vectors["valid_plugin_ids"].as_array().unwrap() {
            assert!(
                PluginId::try_new(pid.as_str().unwrap()).is_ok(),
                "expected valid plugin id: {pid}"
            );
        }
        for pid in vectors["invalid_plugin_ids"].as_array().unwrap() {
            assert!(
                PluginId::try_new(pid.as_str().unwrap()).is_err(),
                "expected invalid plugin id: {pid}"
            );
        }
        for frame in vectors["valid_server_frames"].as_array().unwrap() {
            assert!(
                decode_server_line(frame.as_str().unwrap()).is_ok(),
                "expected valid server frame: {frame}"
            );
        }
        for frame in vectors["invalid_server_frames"].as_array().unwrap() {
            assert!(
                decode_server_line(frame.as_str().unwrap()).is_err(),
                "expected invalid server frame: {frame}"
            );
        }
    }

    #[test]
    fn rejects_oversized_frames() {
        let huge = "a".repeat(MAX_FRAME_BYTES + 1);
        let err = decode_client_line(&huge).unwrap_err();
        assert!(matches!(err, WireError::FrameTooLarge { .. }));
    }
}
