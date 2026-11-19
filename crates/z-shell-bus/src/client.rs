//! Hardened async Rust client with mandatory `bus.hello` handshake and non-blocking notifications.

use crate::server::read_bounded_line;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};
use tracing::warn;
use z_shell_protocol::{
    BusHelloParams, BusHelloResult, ClientMessage, CommandInvokeParams, CommandInvokeResult,
    CommandName, CommandRegisterParams, CommandReplyParams, CommandSummary,
    CommandUnregisterParams, InhibitorAcquireParams, InhibitorAcquireResult,
    InhibitorReleaseParams, PROTOCOL_VERSION, RequestId, RpcError, ServerMessage, TopicListEntry,
    TopicName, TopicPublishParams, TopicRegisterParams, TopicSnapshot, TopicSubscribeParams,
    TopicUnregisterParams, TopicUnsubscribeParams, WireError, decode_server_line, encode_line,
    methods,
};

const OUTBOUND_BUFFER: usize = 256;
const NOTIFICATION_BUFFER: usize = 256;

/// Error returned by [`BusClient`] operations.
#[derive(Debug, Error)]
pub enum ClientError {
    /// Unix socket connection or I/O failure.
    #[error("bus client I/O error: {0}")]
    Io(#[from] io::Error),
    /// Wire encoding/decoding error.
    #[error(transparent)]
    Wire(#[from] WireError),
    /// Remote RPC error returned by the shell daemon.
    #[error("daemon RPC error: {0}")]
    Rpc(#[from] RpcError),
    /// Response payload failed to deserialize into the expected type.
    #[error("unexpected RPC response shape: {0}")]
    Decode(#[from] serde_json::Error),
    /// Connection closed before a pending request received its response.
    #[error("bus connection closed before response arrived")]
    Disconnected,
}

type PendingMap = Arc<Mutex<HashMap<RequestId, oneshot::Sender<Result<Value, RpcError>>>>>;

/// Async client connected to a running `z-shelld` Unix domain socket.
pub struct BusClient {
    out_tx: mpsc::Sender<String>,
    pending: PendingMap,
    next_id: AtomicU64,
    notifications: mpsc::Receiver<ServerMessage>,
    hello_info: BusHelloResult,
}

const _: () = {
    const fn assert_send<T: Send>() {}
    assert_send::<BusClient>();
};

impl BusClient {
    /// Connects to a shell daemon Unix socket and completes the mandatory `bus.hello` handshake.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if connecting or version negotiation fails.
    pub async fn connect(socket_path: impl AsRef<Path>) -> Result<Self, ClientError> {
        let raw = Self::connect_raw(socket_path).await?;
        let hello_info: BusHelloResult = raw
            .request(
                methods::BUS_HELLO,
                Some(&BusHelloParams {
                    protocol_version: PROTOCOL_VERSION,
                    client_name: Some("z-shell-rust-client".to_owned()),
                }),
            )
            .await?;
        Ok(Self {
            out_tx: raw.out_tx,
            pending: raw.pending,
            next_id: raw.next_id,
            notifications: raw.notifications,
            hello_info,
        })
    }

    /// Connects without running `bus.hello` (useful for protocol handshake enforcement tests).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError::Io`] if connecting fails.
    pub async fn connect_without_handshake(
        socket_path: impl AsRef<Path>,
    ) -> Result<Self, ClientError> {
        let raw = Self::connect_raw(socket_path).await?;
        Ok(Self {
            out_tx: raw.out_tx,
            pending: raw.pending,
            next_id: raw.next_id,
            notifications: raw.notifications,
            hello_info: BusHelloResult {
                protocol_version: 0,
                daemon_version: String::new(),
                daemon_instance_id: String::new(),
                client_id: 0,
                role: z_shell_protocol::ClientRole::Public,
                media_dir: std::path::PathBuf::new(),
            },
        })
    }

    async fn connect_raw(socket_path: impl AsRef<Path>) -> Result<RawClientParts, ClientError> {
        let stream = UnixStream::connect(socket_path).await?;
        let (read_half, mut write_half) = stream.into_split();
        let (out_tx, mut out_rx) = mpsc::channel::<String>(OUTBOUND_BUFFER);
        let (notif_tx, notifications) = mpsc::channel::<ServerMessage>(NOTIFICATION_BUFFER);
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

        tokio::spawn(async move {
            while let Some(line) = out_rx.recv().await {
                if write_half.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });

        let pending_reader = Arc::clone(&pending);
        tokio::spawn(async move {
            let mut reader = BufReader::new(read_half);
            let mut buf = Vec::with_capacity(1024);
            loop {
                buf.clear();
                match read_bounded_line(&mut reader, &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let Ok(line) = std::str::from_utf8(&buf) else {
                            continue;
                        };
                        let Ok(server_msg) = decode_server_line(line) else {
                            continue;
                        };
                        match server_msg {
                            ServerMessage::Ok { id, result } => {
                                if let Some(tx) = pending_reader
                                    .lock()
                                    .expect("pending map lock poisoned")
                                    .remove(&id)
                                {
                                    let _ = tx.send(Ok(result));
                                }
                            }
                            ServerMessage::Err {
                                id: Some(id),
                                error,
                            } => {
                                if let Some(tx) = pending_reader
                                    .lock()
                                    .expect("pending map lock poisoned")
                                    .remove(&id)
                                {
                                    let _ = tx.send(Err(error));
                                }
                            }
                            ServerMessage::Err { id: None, error } => {
                                warn!(?error, "received uncorrelatable bus error frame");
                            }
                            notif @ ServerMessage::Notification { .. } => {
                                // Never block RPC response delivery on a slow notification consumer.
                                if notif_tx.try_send(notif).is_err() {
                                    warn!(
                                        "client notification channel full; dropping notification"
                                    );
                                }
                            }
                        }
                    }
                }
            }
            pending_reader
                .lock()
                .expect("pending map lock poisoned")
                .clear();
        });

        Ok(RawClientParts {
            out_tx,
            pending,
            next_id: AtomicU64::new(1),
            notifications,
        })
    }

    /// Returns the negotiated [`BusHelloResult`] from the initial handshake.
    #[must_use]
    pub fn hello_info(&self) -> &BusHelloResult {
        &self.hello_info
    }

    /// Sends a typed RPC request and awaits its decoded response.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] on transport, protocol, RPC, or decoding failures.
    pub async fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: Option<&P>,
    ) -> Result<R, ClientError> {
        let id = RequestId::try_number(self.next_id.fetch_add(1, Ordering::Relaxed))?;
        let params_val = match params {
            Some(p) => Some(serde_json::to_value(p)?),
            None => None,
        };
        let frame = ClientMessage::request(id.clone(), method, params_val);
        let line = encode_line(&frame)?;

        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending map lock poisoned")
            .insert(id.clone(), tx);

        if self.out_tx.send(line).await.is_err() {
            self.pending
                .lock()
                .expect("pending map lock poisoned")
                .remove(&id);
            return Err(ClientError::Disconnected);
        }

        let raw = rx.await.map_err(|_| ClientError::Disconnected)??;
        Ok(serde_json::from_value(raw)?)
    }

    /// Receives the next server push notification (`topic.update`, `topic.removed`, `topic.reset`, `command.dispatch`).
    pub async fn next_notification(&mut self) -> Option<ServerMessage> {
        self.notifications.recv().await
    }

    /// Lists all active topics on the bus.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if the RPC fails.
    pub async fn list_topics(&self) -> Result<Vec<TopicListEntry>, ClientError> {
        self.request::<(), _>(methods::TOPIC_LIST, None).await
    }

    /// Subscribes to a topic and returns its ordered subscription snapshot.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if the topic does not exist or the RPC fails.
    pub async fn subscribe(&self, topic: TopicName) -> Result<TopicSnapshot, ClientError> {
        self.request(
            methods::TOPIC_SUBSCRIBE,
            Some(&TopicSubscribeParams { topic }),
        )
        .await
    }

    /// Unsubscribes from a topic.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if the RPC fails.
    pub async fn unsubscribe(&self, topic: TopicName) -> Result<(), ClientError> {
        let _: Value = self
            .request(
                methods::TOPIC_UNSUBSCRIBE,
                Some(&TopicUnsubscribeParams { topic }),
            )
            .await?;
        Ok(())
    }

    /// Registers a plugin-owned topic under `plugin.*`.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if registration is rejected.
    pub async fn register_topic(&self, params: TopicRegisterParams) -> Result<Value, ClientError> {
        self.request(methods::TOPIC_REGISTER, Some(&params)).await
    }

    /// Publishes a new revision to a plugin-owned topic.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if the client does not own the topic or publishing fails.
    pub async fn publish_topic(&self, params: TopicPublishParams) -> Result<Value, ClientError> {
        self.request(methods::TOPIC_PUBLISH, Some(&params)).await
    }

    /// Unregisters a plugin-owned topic.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if unregistration fails.
    pub async fn unregister_topic(&self, topic: TopicName) -> Result<(), ClientError> {
        let _: Value = self
            .request(
                methods::TOPIC_UNREGISTER,
                Some(&TopicUnregisterParams { topic }),
            )
            .await?;
        Ok(())
    }

    /// Lists all registered control commands.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if the RPC fails.
    pub async fn list_commands(&self) -> Result<Vec<CommandSummary>, ClientError> {
        self.request::<(), _>(methods::COMMAND_LIST, None).await
    }

    /// Registers a plugin-handled control command under `plugin.*`.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if registration conflicts or fails.
    pub async fn register_command(&self, params: CommandRegisterParams) -> Result<(), ClientError> {
        let _: Value = self
            .request(methods::COMMAND_REGISTER, Some(&params))
            .await?;
        Ok(())
    }

    /// Unregisters a plugin-handled control command.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if unregistration fails.
    pub async fn unregister_command(&self, name: CommandName) -> Result<(), ClientError> {
        let _: Value = self
            .request(
                methods::COMMAND_UNREGISTER,
                Some(&CommandUnregisterParams { name }),
            )
            .await?;
        Ok(())
    }

    /// Invokes a core or plugin-registered control command.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if the command is unknown, denied, fails, or times out.
    pub async fn invoke_command(
        &self,
        params: CommandInvokeParams,
    ) -> Result<CommandInvokeResult, ClientError> {
        self.request(methods::COMMAND_INVOKE, Some(&params)).await
    }

    /// Completes a previously dispatched plugin command.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if the call ID is unknown or owned by another client.
    pub async fn reply_command(&self, params: CommandReplyParams) -> Result<(), ClientError> {
        let _: Value = self.request(methods::COMMAND_REPLY, Some(&params)).await?;
        Ok(())
    }

    /// Acquires a connection-scoped inhibitor automatically released on disconnect.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if parameters are invalid or budget is exceeded.
    pub async fn acquire_inhibitor(
        &self,
        params: InhibitorAcquireParams,
    ) -> Result<InhibitorAcquireResult, ClientError> {
        self.request(methods::INHIBITOR_ACQUIRE, Some(&params))
            .await
    }

    /// Releases a previously acquired inhibitor.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] if the cookie is unknown or owned by another client.
    pub async fn release_inhibitor(&self, cookie: u64) -> Result<(), ClientError> {
        let _: Value = self
            .request(
                methods::INHIBITOR_RELEASE,
                Some(&InhibitorReleaseParams { cookie }),
            )
            .await?;
        Ok(())
    }
}

struct RawClientParts {
    out_tx: mpsc::Sender<String>,
    pending: PendingMap,
    next_id: AtomicU64,
    notifications: mpsc::Receiver<ServerMessage>,
}

impl RawClientParts {
    async fn request<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: Option<&P>,
    ) -> Result<R, ClientError> {
        let id = RequestId::try_number(self.next_id.fetch_add(1, Ordering::Relaxed))?;
        let params_val = match params {
            Some(p) => Some(serde_json::to_value(p)?),
            None => None,
        };
        let frame = ClientMessage::request(id.clone(), method, params_val);
        let line = encode_line(&frame)?;

        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending map lock poisoned")
            .insert(id.clone(), tx);

        if self.out_tx.send(line).await.is_err() {
            self.pending
                .lock()
                .expect("pending map lock poisoned")
                .remove(&id);
            return Err(ClientError::Disconnected);
        }

        let raw = rx.await.map_err(|_| ClientError::Disconnected)??;
        Ok(serde_json::from_value(raw)?)
    }
}
