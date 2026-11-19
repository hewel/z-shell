//! Dual-socket Unix domain socket server with flock single-instance ownership and bounded drain.

use crate::hub::{BusHub, ClientOutbound, invalid_request_frame};
use rustix::fs::{FlockOperation, flock};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Semaphore, watch};
use tokio::task::JoinSet;
use tracing::{debug, warn};
use z_shell_protocol::{
    ClientRole, ErrorCode, MAX_FRAME_BYTES, RpcError, ServerMessage, decode_client_line,
};

/// Maximum duration [`BusServer::serve`] waits for active connections to flush replies on shutdown.
pub const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// Error returned when starting or running the bus Unix domain socket server.
#[derive(Debug, Error)]
pub enum BusError {
    /// Another live daemon instance holds the exclusive single-instance flock.
    #[error("another z-shelld instance holds lock {0}")]
    AlreadyRunning(PathBuf),
    /// Existing path at socket location is not a stale Unix socket and will not be unlinked.
    #[error("refusing to remove non-socket path at {0}")]
    RefusingToRemoveNonSocket(PathBuf),
    /// Filesystem or Unix socket I/O error.
    #[error("bus socket I/O error at {path}: {source}")]
    Io {
        /// Affected socket or directory path.
        path: PathBuf,
        /// Underlying OS error.
        #[source]
        source: io::Error,
    },
}

/// Cloneable handle that triggers graceful shutdown of a running [`BusServer`].
#[derive(Clone)]
pub struct ShutdownHandle {
    tx: watch::Sender<bool>,
}

impl ShutdownHandle {
    /// Signals the bus server to stop accepting new connections and drain active replies.
    pub fn shutdown(&self) {
        let _ = self.tx.send(true);
    }
}

/// Async Unix domain socket server hosting a [`BusHub`] over separate public and host sockets.
pub struct BusServer {
    _lock_file: File,
    public_socket_path: PathBuf,
    host_socket_path: PathBuf,
    public_listener: UnixListener,
    host_listener: UnixListener,
    hub: BusHub,
    expected_uid: u32,
    shutdown_tx: watch::Sender<bool>,
    shutdown_rx: watch::Receiver<bool>,
}

impl BusServer {
    /// Acquires the exclusive single-instance `flock` at `lock_path` and binds both the public bus
    /// socket (`ClientRole::Public`) and the privileged host control socket
    /// (`ClientRole::PrivilegedHost`) with `0600` permissions.
    ///
    /// # Errors
    ///
    /// Returns [`BusError::AlreadyRunning`] if another live daemon holds `lock_path`,
    /// [`BusError::RefusingToRemoveNonSocket`] if a non-socket occupies a target path, or
    /// [`BusError::Io`] on I/O failures.
    pub fn bind(
        public_socket_path: PathBuf,
        host_socket_path: PathBuf,
        lock_path: PathBuf,
        hub: BusHub,
    ) -> Result<Self, BusError> {
        let lock_file = acquire_single_instance_lock(&lock_path)?;
        let public_listener = bind_private_socket(&public_socket_path)?;
        let host_listener = match bind_private_socket(&host_socket_path) {
            Ok(listener) => listener,
            Err(err) => {
                let _ = fs::remove_file(&public_socket_path);
                return Err(err);
            }
        };

        let expected_uid = current_process_uid()?;
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        Ok(Self {
            _lock_file: lock_file,
            public_socket_path,
            host_socket_path,
            public_listener,
            host_listener,
            hub,
            expected_uid,
            shutdown_tx,
            shutdown_rx,
        })
    }

    /// Returns a [`ShutdownHandle`] that stops [`Self::serve`].
    #[must_use]
    pub fn shutdown_handle(&self) -> ShutdownHandle {
        ShutdownHandle {
            tx: self.shutdown_tx.clone(),
        }
    }

    /// Returns the bound public bus Unix socket path.
    #[must_use]
    pub fn public_socket_path(&self) -> &Path {
        &self.public_socket_path
    }

    /// Returns the bound privileged host control Unix socket path.
    #[must_use]
    pub fn host_socket_path(&self) -> &Path {
        &self.host_socket_path
    }

    /// Accepts and serves connections on both sockets until shutdown is signaled, then drains active
    /// connection tasks within [`SHUTDOWN_DRAIN_TIMEOUT`] before removing its owned sockets.
    ///
    /// # Errors
    ///
    /// Returns [`BusError::Io`] on unrecoverable accept errors.
    pub async fn serve(mut self) -> Result<(), BusError> {
        let mut connections = JoinSet::new();

        loop {
            tokio::select! {
                changed = self.shutdown_rx.changed() => {
                    if changed.is_err() || *self.shutdown_rx.borrow() {
                        break;
                    }
                }
                accepted = self.public_listener.accept() => {
                    let (stream, _) = accepted.map_err(|source| BusError::Io {
                        path: self.public_socket_path.clone(),
                        source,
                    })?;
                    self.spawn_accepted(stream, ClientRole::Public, &mut connections);
                }
                accepted = self.host_listener.accept() => {
                    let (stream, _) = accepted.map_err(|source| BusError::Io {
                        path: self.host_socket_path.clone(),
                        source,
                    })?;
                    self.spawn_accepted(stream, ClientRole::PrivilegedHost, &mut connections);
                }
                Some(_) = connections.join_next(), if !connections.is_empty() => {}
            }
        }

        // Bounded drain so pending replies (such as `quit`) flush cleanly before exit.
        let _ = tokio::time::timeout(SHUTDOWN_DRAIN_TIMEOUT, async {
            while connections.join_next().await.is_some() {}
        })
        .await;
        connections.abort_all();

        let _ = fs::remove_file(&self.public_socket_path);
        let _ = fs::remove_file(&self.host_socket_path);
        Ok(())
    }

    fn spawn_accepted(&self, stream: UnixStream, role: ClientRole, connections: &mut JoinSet<()>) {
        let Ok(cred) = stream.peer_cred() else {
            warn!("rejecting bus client: failed to read SO_PEERCRED");
            return;
        };
        if cred.uid() != self.expected_uid {
            warn!(
                peer_uid = cred.uid(),
                expected_uid = self.expected_uid,
                "rejecting bus client with mismatched UID"
            );
            return;
        }
        let Some((client_id, outbound)) = self.hub.register_client(role) else {
            warn!("rejecting bus client: max_clients budget reached");
            return;
        };
        let hub = self.hub.clone();
        let shutdown_rx = self.shutdown_rx.clone();
        connections.spawn(async move {
            serve_connection(stream, client_id, outbound, hub, shutdown_rx).await;
        });
    }
}

impl Drop for BusServer {
    fn drop(&mut self) {
        // Because `_lock_file` is still held until after `drop`, we own both socket paths.
        let _ = fs::remove_file(&self.public_socket_path);
        let _ = fs::remove_file(&self.host_socket_path);
    }
}

fn acquire_single_instance_lock(lock_path: &Path) -> Result<File, BusError> {
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent).map_err(|source| BusError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .mode(0o600)
        .open(lock_path)
        .map_err(|source| BusError::Io {
            path: lock_path.to_path_buf(),
            source,
        })?;
    match flock(&file, FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => Ok(file),
        Err(err) if err == rustix::io::Errno::WOULDBLOCK || err == rustix::io::Errno::AGAIN => {
            Err(BusError::AlreadyRunning(lock_path.to_path_buf()))
        }
        Err(err) => Err(BusError::Io {
            path: lock_path.to_path_buf(),
            source: io::Error::from(err),
        }),
    }
}

fn bind_private_socket(socket_path: &Path) -> Result<UnixListener, BusError> {
    if let Some(parent) = socket_path.parent() {
        fs::create_dir_all(parent).map_err(|source| BusError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    match fs::symlink_metadata(socket_path) {
        Ok(meta) => {
            use std::os::unix::fs::FileTypeExt;
            if !meta.file_type().is_socket() {
                return Err(BusError::RefusingToRemoveNonSocket(
                    socket_path.to_path_buf(),
                ));
            }
            fs::remove_file(socket_path).map_err(|source| BusError::Io {
                path: socket_path.to_path_buf(),
                source,
            })?;
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(BusError::Io {
                path: socket_path.to_path_buf(),
                source,
            });
        }
    }

    let listener = UnixListener::bind(socket_path).map_err(|source| BusError::Io {
        path: socket_path.to_path_buf(),
        source,
    })?;
    fs::set_permissions(socket_path, fs::Permissions::from_mode(0o600)).map_err(|source| {
        BusError::Io {
            path: socket_path.to_path_buf(),
            source,
        }
    })?;
    Ok(listener)
}

fn current_process_uid() -> Result<u32, BusError> {
    fs::metadata("/proc/self")
        .map(|meta| meta.uid())
        .map_err(|source| BusError::Io {
            path: PathBuf::from("/proc/self"),
            source,
        })
}

async fn serve_connection(
    stream: UnixStream,
    client_id: u64,
    outbound: ClientOutbound,
    hub: BusHub,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let (read_half, mut write_half) = stream.into_split();
    debug!(client_id, "bus client connected");

    let writer = tokio::spawn(async move {
        while let Some(line) = outbound.next_line().await {
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let in_flight_permits = Arc::new(Semaphore::new(hub.limits().max_in_flight_per_client));
    let mut invoke_tasks = JoinSet::new();
    let mut reader = BufReader::new(read_half);
    let mut buf = Vec::with_capacity(1024);

    loop {
        buf.clear();
        tokio::select! {
            changed = shutdown_rx.changed() => {
                if changed.is_err() || *shutdown_rx.borrow() {
                    break;
                }
            }
            Some(_) = invoke_tasks.join_next(), if !invoke_tasks.is_empty() => {}
            read_res = read_bounded_line(&mut reader, &mut buf) => {
                match read_res {
                    Ok(0) => break,
                    Ok(_) => {
                        let line = match std::str::from_utf8(&buf) {
                            Ok(s) => s,
                            Err(_) => {
                                hub.enqueue_control(client_id, &invalid_request_frame("frame is not valid UTF-8"));
                                continue;
                            }
                        };
                        match decode_client_line(line) {
                            Ok(client_msg) => {
                                if let Some((req_id, caller, params)) = hub.handle_inline_message(client_id, client_msg) {
                                    let Ok(permit) = Arc::clone(&in_flight_permits).try_acquire_owned() else {
                                        hub.enqueue_control(
                                            client_id,
                                            &ServerMessage::err(
                                                req_id,
                                                RpcError::new(
                                                    ErrorCode::ResourceExhausted,
                                                    "too many concurrent in-flight command invocations",
                                                ),
                                            ),
                                        );
                                        continue;
                                    };
                                    let hub_task = hub.clone();
                                    invoke_tasks.spawn(async move {
                                        let _permit = permit;
                                        let outcome = hub_task.invoke_command(caller, params).await;
                                        let resp = match outcome {
                                            Ok(res) => ServerMessage::ok(
                                                req_id,
                                                serde_json::to_value(res).expect("CommandInvokeResult serializes"),
                                            ),
                                            Err(err) => ServerMessage::err(req_id, err),
                                        };
                                        hub_task.enqueue_control(client_id, &resp);
                                    });
                                }
                            }
                            Err(err) => {
                                hub.enqueue_control(client_id, &invalid_request_frame(err.to_string()));
                            }
                        }
                    }
                    Err(err) if err.kind() == io::ErrorKind::InvalidData => {
                        hub.enqueue_control(client_id, &invalid_request_frame("frame exceeds maximum byte limit"));
                        break;
                    }
                    Err(_) => break,
                }
            }
        }
    }

    // On shutdown (for example, `quit`), briefly allow already-admitted command tasks to finish and
    // enqueue their reply before closing the outbound queue and retiring the client owner.
    if *shutdown_rx.borrow() {
        let _ = tokio::time::timeout(Duration::from_millis(500), async {
            while invoke_tasks.join_next().await.is_some() {}
        })
        .await;
    }
    invoke_tasks.abort_all();

    hub.close_client_outbound(client_id);
    let _ = tokio::time::timeout(Duration::from_millis(500), writer).await;
    hub.retire_client(client_id);
    debug!(client_id, "bus client disconnected and retired");
}

/// Reads one newline-terminated line with a strict [`MAX_FRAME_BYTES`] ceiling before allocation.
///
/// # Errors
///
/// Returns `io::ErrorKind::InvalidData` if the line exceeds [`MAX_FRAME_BYTES`].
pub(crate) async fn read_bounded_line<R: AsyncBufReadExt + Unpin>(
    reader: &mut R,
    buf: &mut Vec<u8>,
) -> io::Result<usize> {
    let mut total = 0usize;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(total);
        }
        let newline_pos = available.iter().position(|&b| b == b'\n');
        let take = newline_pos.map_or(available.len(), |idx| idx + 1);
        if total + take > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "NDJSON line exceeds MAX_FRAME_BYTES",
            ));
        }
        buf.extend_from_slice(&available[..take]);
        reader.consume(take);
        total += take;
        if newline_pos.is_some() {
            return Ok(total);
        }
    }
}
