use std::io;
use std::os::fd::{AsFd, OwnedFd};
use std::thread;

use tokio::io::{Interest, unix::AsyncFd};
use tokio::runtime::Builder;
use tokio::sync::{mpsc, oneshot};
use wayland_client::backend::WaylandError;
use wayland_client::{Connection, DispatchError};
use z_shell_bus::{BusHub, UpdateKind};
use z_shell_protocol::{ErrorCode, RpcError};

use crate::commands::Request;
use crate::state::{Barrier, State, publish_disconnected};
use crate::{ConnectError, WaylandHandle};

const COMMAND_QUEUE_CAPACITY: usize = 32;

pub(crate) fn spawn(conn: Connection) -> Result<WaylandHandle, ConnectError> {
    let runtime = Builder::new_current_thread().enable_io().build()?;
    let fd = conn.as_fd().try_clone_to_owned()?;
    let fd = {
        let _entered = runtime.enter();
        // SAFETY: AsyncFd owns the duplicate, which stays open until deregistration.
        unsafe { AsyncFd::register(fd) }.map_err(io::Error::from)?
    };
    let (commands, recv_commands) = mpsc::channel(COMMAND_QUEUE_CAPACITY);
    let (install, recv_install) = oneshot::channel();
    let (stop, recv_stop) = oneshot::channel();
    let thread = thread::Builder::new()
        .name("z-shell-wayland".into())
        .spawn(move || {
            runtime.block_on(run(conn, fd, recv_install, recv_stop, recv_commands));
        })?;
    Ok(WaylandHandle {
        commands,
        install: Some(install),
        stop: Some(stop),
        thread: Some(thread),
    })
}

async fn run(
    conn: Connection,
    fd: AsyncFd<OwnedFd>,
    install: oneshot::Receiver<BusHub>,
    mut stop: oneshot::Receiver<()>,
    commands: mpsc::Receiver<Request>,
) {
    let hub = tokio::select! {
        biased;
        result = install => match result {
            Ok(hub) => hub,
            Err(_) => return,
        },
        _ = &mut stop => return,
    };
    let mut state = State::new();
    tokio::select! {
        biased;
        _ = &mut stop => {}
        result = dispatch(&conn, &fd, &hub, &mut state, commands) => {
            if let Err(error) = result {
                tracing::debug!(%error, "Wayland connection closed");
            }
        }
    }
    let kind = if state.published {
        UpdateKind::Live
    } else {
        UpdateKind::SourceBaseline
    };
    publish_disconnected(&hub, kind);
}

async fn dispatch(
    conn: &Connection,
    fd: &AsyncFd<OwnedFd>,
    hub: &BusHub,
    state: &mut State,
    mut commands: mpsc::Receiver<Request>,
) -> Result<(), DispatchError> {
    let mut queue = conn.new_event_queue::<State>();
    let qh = queue.handle();
    let display = conn.display();
    let registry = display.get_registry(&qh, ());
    display.sync(&qh, Barrier::Registry(registry));

    loop {
        queue.dispatch_pending(state)?;
        state.publish(hub);
        flush(conn, fd).await?;
        let Some(read) = queue.prepare_read() else {
            continue;
        };
        tokio::select! {
            biased;
            ready = fd.readable() => {
                let mut ready = ready.map_err(WaylandError::Io)?;
                // An owned read guard must precede the readiness check.
                if let Ok(result) = ready.try_io(|_| io_result(read.read())) {
                    result.map_err(WaylandError::Io)??;
                }
            }
            request = commands.recv() => {
                drop(read);
                let Some(request) = request else { return Ok(()) };
                if !request.reply.is_closed() {
                    let result = if state.settled {
                        request.command.execute(state)
                    } else {
                        Err(RpcError::new(ErrorCode::Disabled, "wayland is initializing"))
                    };
                    if result.is_ok() {
                        flush(conn, fd).await?;
                    }
                    let _ = request.reply.send(result);
                }
            }
        }
    }
}

async fn flush(conn: &Connection, fd: &AsyncFd<OwnedFd>) -> Result<(), WaylandError> {
    match io_result(conn.flush()) {
        Ok(result) => result,
        Err(_) => {
            fd.async_io(Interest::WRITABLE, |_| io_result(conn.flush()))
                .await?
        }
    }
}

// Tokio should clear readiness only for WouldBlock, not for Wayland protocol errors.
fn io_result<T>(result: Result<T, WaylandError>) -> io::Result<Result<T, WaylandError>> {
    match result {
        Err(WaylandError::Io(error)) if error.kind() == io::ErrorKind::WouldBlock => Err(error),
        result => Ok(result),
    }
}
