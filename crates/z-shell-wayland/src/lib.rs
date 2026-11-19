//! Compositor-agnostic Wayland client domain for z-shell.
//!
//! An installed connection publishes a source baseline after the registry and
//! initial protocol roundtrips. Later state changes, including a lost connection,
//! are live updates. The caller retains the installed [`WaylandHandle`] for as
//! long as it wants the service to run.
//!
//! Each topic reports its own `capability`. `wayland.outputs` lists `outputs` with
//! connector metadata, logical geometry, and the current physical mode (pixels
//! and millihertz). Without xdg-output, logical geometry is estimated from
//! `wl_output`. `wayland.workspaces` lists `groups` and `workspaces`;
//! `wayland.windows` lists `windows`; `wayland.display_power` lists `outputs`
//! with `on`, `off`, or `unknown` modes. Output associations and commands use
//! `output_instance_id`, never connector names or Wayland object IDs.

mod commands;
mod outputs;
mod state;
mod windows;
mod worker;
mod workspaces;

use std::fmt;
use std::io;
use std::os::unix::net::UnixStream;
use std::thread::JoinHandle;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use wayland_client::Connection;
use z_shell_bus::{BusHub, UpdateKind};

/// Live availability of one compositor protocol domain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityState {
    /// The compositor exposes state but no usable control in this domain.
    Readable,
    /// The compositor exposes state and at least one supported action in this domain.
    Controllable,
    /// The compositor does not expose the protocol domain.
    Unsupported,
    /// No compositor connection is active.
    Disconnected,
}

/// Failure to open the compositor connection or start its event thread.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum ConnectError {
    /// Opening the Wayland client socket failed.
    #[error("open Wayland connection: {0}")]
    Connect(#[from] wayland_client::ConnectError),
    /// Setting up the worker's reactor, socket polling, or thread failed.
    #[error("start Wayland event thread: {0}")]
    Worker(#[from] io::Error),
}

/// Owns the Wayland event thread. Dropping it stops and joins the worker.
#[must_use = "dropping the handle stops the Wayland service"]
pub struct WaylandHandle {
    commands: mpsc::Sender<commands::Request>,
    install: Option<oneshot::Sender<BusHub>>,
    stop: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl fmt::Debug for WaylandHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WaylandHandle")
            .field("installed", &self.install.is_none())
            .finish_non_exhaustive()
    }
}

impl Drop for WaylandHandle {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            tracing::error!("Wayland event thread panicked");
        }
    }
}

/// Opens the compositor socket selected by the Wayland environment.
///
/// The worker starts dispatching after [`install_on_bus`] is called. No caller
/// async runtime is required.
///
/// # Errors
/// Returns an error if no compositor socket is configured, connecting fails, or
/// the event thread cannot start.
pub fn connect_from_env() -> Result<WaylandHandle, ConnectError> {
    worker::spawn(Connection::connect_to_env()?)
}

/// Takes ownership of a connected Wayland socket, including a mock compositor socket.
///
/// # Errors
/// Returns an error if setting up the client connection or event thread fails.
pub fn connect_stream(stream: UnixStream) -> Result<WaylandHandle, ConnectError> {
    worker::spawn(Connection::from_socket(stream)?)
}

/// Registers Wayland commands and starts publishing compositor state on the hub.
///
/// Retain the returned handle. Commands queue requests on the event thread and
/// acknowledge sending them, not compositor acceptance; topic updates report
/// actual state. Install each connection only once.
///
/// Command parameters are JSON object fields or positional arguments in this order:
/// `workspace_id` for workspace activation; `window_id` for window activation and
/// close; `output_instance_id` (an ID or `"all"`) and `mode` (`"on"` or `"off"`)
/// for display power. `"all"` requires a power-control object for every output.
///
/// # Panics
/// Panics if the given handle is already installed.
pub fn install_on_bus(hub: &BusHub, mut handle: WaylandHandle) -> WaylandHandle {
    let install = handle
        .install
        .take()
        .expect("Wayland handle already installed");
    commands::register(hub, &handle.commands);
    let _ = install.send(hub.clone());
    handle
}

/// Initializes all Wayland topics with empty, disconnected source baselines.
///
/// Call this instead of installing a connection when running headless.
pub fn publish_disconnected_baselines(hub: &BusHub) {
    state::publish_disconnected(hub, UpdateKind::SourceBaseline);
}
