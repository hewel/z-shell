use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;

use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot};
use zeroize::{Zeroize, Zeroizing};

const DEFAULT_SOCKET_PATH: &str = "/run/polkit/agent-helper.socket";
const SYSTEM_HELPERS: [&str; 4] = [
    "/run/wrappers/bin/polkit-agent-helper-1",
    "/usr/lib/polkit-1/polkit-agent-helper-1",
    "/usr/libexec/polkit-agent-helper-1",
    "/usr/lib64/polkit-1/polkit-agent-helper-1",
];
const MAX_LINE_BYTES: usize = 8 * 1024;
/// Linux PAM's 512-byte response buffer also needs room for LF and NUL.
pub(super) const MAX_RESPONSE_BYTES: usize = 510;

/// Selects the trusted helper socket, executable fallback, and local passwd source for Polkit PAM conversations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolkitHelperConfig {
    socket_path: Option<PathBuf>,
    path: Option<PathBuf>,
    passwd_path: PathBuf,
}

impl PolkitHelperConfig {
    /// Uses the specified trusted executable path without probing system locations or sockets.
    #[must_use]
    pub fn with_path(path: PathBuf) -> Self {
        Self {
            socket_path: None,
            path: Some(path),
            passwd_path: PathBuf::from("/etc/passwd"),
        }
    }

    /// Uses an explicit helper socket path without a binary fallback.
    #[must_use]
    pub fn with_socket(socket_path: impl Into<PathBuf>) -> Self {
        Self::with_socket_and_binary(socket_path, None)
    }

    /// Uses an explicit helper socket path with an optional binary fallback.
    #[must_use]
    pub fn with_socket_and_binary(
        socket_path: impl Into<PathBuf>,
        binary_path: Option<PathBuf>,
    ) -> Self {
        Self {
            socket_path: Some(socket_path.into()),
            path: binary_path,
            passwd_path: PathBuf::from("/etc/passwd"),
        }
    }

    /// Overrides the local `passwd` file path checked before falling back to `getpwuid_r`.
    #[must_use]
    pub fn with_passwd_path(mut self, passwd_path: impl Into<PathBuf>) -> Self {
        self.passwd_path = passwd_path.into();
        self
    }

    /// Configures the default Polkit socket and probes standard, NixOS, and multiarch helper paths.
    #[must_use]
    pub fn resolve_system_helper() -> Self {
        Self {
            socket_path: Some(PathBuf::from(DEFAULT_SOCKET_PATH)),
            path: resolve_helper_binary(),
            passwd_path: PathBuf::from("/etc/passwd"),
        }
    }

    pub(super) fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub(super) fn socket_path(&self) -> Option<&Path> {
        self.socket_path.as_deref()
    }

    pub(super) fn passwd_path(&self) -> &Path {
        &self.passwd_path
    }
}

fn is_executable_file(path: &Path) -> bool {
    path.is_absolute()
        && path
            .metadata()
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

fn resolve_helper_binary() -> Option<PathBuf> {
    if let Some(env_path) = option_env!("POLKIT_AGENT_HELPER_1")
        .map(Path::new)
        .filter(|path| is_executable_file(path))
    {
        return Some(env_path.to_path_buf());
    }
    if let Some(fixed) = SYSTEM_HELPERS
        .into_iter()
        .map(Path::new)
        .find(|path| is_executable_file(path))
    {
        return Some(fixed.to_path_buf());
    }
    let mut multiarch_dirs: Vec<PathBuf> = std::fs::read_dir("/usr/lib")
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with("-linux-gnu"))
        })
        .collect();
    multiarch_dirs.sort();
    multiarch_dirs
        .into_iter()
        .map(|dir| dir.join("polkit-1/polkit-agent-helper-1"))
        .find(|candidate| is_executable_file(candidate))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Echo {
    On,
    Off,
}

pub(super) enum HelperEvent {
    Prompt { text: Zeroizing<String>, echo: Echo },
    Info(Zeroizing<String>),
    Error(Zeroizing<String>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum HelperOutcome {
    Success,
    Failure,
    Cancelled,
}

#[derive(Debug, Error)]
pub(super) enum HelperError {
    #[error("polkit-agent-helper-1 not found")]
    Unavailable,
    #[error("could not launch Polkit helper")]
    Launch(#[source] io::Error),
    #[error("Polkit helper pipe unavailable")]
    MissingPipe,
    #[error("Polkit helper pipe I/O failed")]
    PipeIo(#[source] io::Error),
    #[error("Polkit helper closed its output before completing authentication")]
    UnexpectedEof,
    #[error("invalid Polkit helper protocol frame")]
    InvalidFrame,
    #[error("could not reap Polkit helper")]
    Cleanup(#[source] io::Error),
    #[error("Polkit helper reap task stopped")]
    ReapTask(#[source] tokio::task::JoinError),
}

pub(super) async fn run(
    config: &PolkitHelperConfig,
    username: &str,
    cookie: &str,
    responses: mpsc::Receiver<Arc<Zeroizing<String>>>,
    mut cancel: oneshot::Receiver<()>,
    mut on_event: impl FnMut(HelperEvent),
) -> Result<HelperOutcome, HelperError> {
    if !matches!(cancel.try_recv(), Err(oneshot::error::TryRecvError::Empty)) {
        return Ok(HelperOutcome::Cancelled);
    }

    if let Some(socket_path) = config.socket_path() {
        let connected = tokio::select! {
            biased;
            _ = &mut cancel => return Ok(HelperOutcome::Cancelled),
            res = UnixStream::connect(socket_path) => res,
        };
        match connected {
            Ok(stream) => {
                let (reader, mut writer) = stream.into_split();
                return tokio::select! {
                    biased;
                    _ = &mut cancel => Ok(HelperOutcome::Cancelled),
                    result = async {
                        write_line(&mut writer, username).await?;
                        exchange(writer, reader, cookie, responses, &mut on_event).await
                    } => result,
                };
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
                ) => {}
            Err(error) => return Err(HelperError::Launch(error)),
        }
    }

    let path = config.path().ok_or(HelperError::Unavailable)?;
    let mut child = Command::new(path)
        .arg(username)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(HelperError::Launch)?;
    let pipes = (child.stdin.take(), child.stdout.take());
    let mut child = ReapChild(Some(child));
    let pipes = match pipes {
        (Some(stdin), Some(stdout)) => ChildStdin::from_std(stdin)
            .and_then(|stdin| ChildStdout::from_std(stdout).map(|stdout| (stdin, stdout)))
            .map_err(HelperError::PipeIo),
        _ => Err(HelperError::MissingPipe),
    };

    let result = match pipes {
        Ok((stdin, stdout)) => tokio::select! {
            biased;
            _ = &mut cancel => Ok(HelperOutcome::Cancelled),
            result = exchange(stdin, stdout, cookie, responses, &mut on_event) => result,
        },
        Err(error) => Err(error),
    };

    // The terminal frame is sent after the helper notifies the Authority. Do not wait
    // for protocol output (or the helper's post-frame flush delay) during teardown.
    child.kill();
    tokio::task::spawn_blocking(move || child.reap())
        .await
        .map_err(HelperError::ReapTask)??;
    result
}

struct ReapChild(Option<Child>);

impl ReapChild {
    fn kill(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
        }
    }

    fn reap(&mut self) -> Result<(), HelperError> {
        if let Some(mut child) = self.0.take() {
            child.wait().map_err(HelperError::Cleanup)?;
        }
        Ok(())
    }
}

impl Drop for ReapChild {
    fn drop(&mut self) {
        // Runtime shutdown can abort the async task before its blocking reaper is launched.
        self.kill();
        let _ = self.reap();
    }
}

async fn exchange<W, R>(
    mut stdin: W,
    stdout: R,
    cookie: &str,
    mut responses: mpsc::Receiver<Arc<Zeroizing<String>>>,
    on_event: &mut impl FnMut(HelperEvent),
) -> Result<HelperOutcome, HelperError>
where
    W: AsyncWrite + Unpin,
    R: AsyncRead + Unpin,
{
    write_line(&mut stdin, cookie).await?;
    let mut output = HelperOutput {
        stdout,
        bytes: Zeroizing::new([0; MAX_LINE_BYTES]),
        start: 0,
        end: 0,
    };
    loop {
        match output.read_frame().await? {
            Frame::Result(outcome) => return Ok(outcome),
            Frame::Event(event @ HelperEvent::Prompt { .. }) => {
                on_event(event);
                let response = loop {
                    tokio::select! {
                        biased;
                        frame = output.read_frame() => match frame? {
                            Frame::Result(outcome) => return Ok(outcome),
                            Frame::Event(HelperEvent::Prompt { .. }) => return Err(HelperError::InvalidFrame),
                            Frame::Event(event) => on_event(event),
                        },
                        response = responses.recv() => break response,
                    }
                };
                let Some(response) = response else {
                    return Ok(HelperOutcome::Cancelled);
                };
                write_line(&mut stdin, &response).await?;
            }
            Frame::Event(event) => on_event(event),
        }
    }
}

async fn write_line<W: AsyncWrite + Unpin>(stdin: &mut W, line: &str) -> Result<(), HelperError> {
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(HelperError::PipeIo)?;
    stdin.write_all(b"\n").await.map_err(HelperError::PipeIo)
}

struct HelperOutput<R> {
    stdout: R,
    bytes: Zeroizing<[u8; MAX_LINE_BYTES]>,
    start: usize,
    end: usize,
}

impl<R: AsyncRead + Unpin> HelperOutput<R> {
    async fn read_frame(&mut self) -> Result<Frame, HelperError> {
        let mut scan = self.start;
        loop {
            if let Some(offset) = self.bytes[scan..self.end].iter().position(|&b| b == b'\n') {
                let newline = scan + offset;
                let frame = parse_frame(&self.bytes[self.start..newline]);
                self.bytes[self.start..=newline].zeroize();
                self.start = newline + 1;
                return frame;
            }

            scan = self.end;
            if self.end == MAX_LINE_BYTES {
                if self.start == 0 {
                    return Err(HelperError::InvalidFrame);
                }
                self.bytes.copy_within(self.start..self.end, 0);
                self.end -= self.start;
                self.bytes[self.end..].zeroize();
                self.start = 0;
                scan = self.end;
            }
            let count = self
                .stdout
                .read(&mut self.bytes[self.end..])
                .await
                .map_err(HelperError::PipeIo)?;
            if count == 0 {
                return Err(HelperError::UnexpectedEof);
            }
            self.end += count;
        }
    }
}

enum Frame {
    Event(HelperEvent),
    Result(HelperOutcome),
}

fn parse_frame(line: &[u8]) -> Result<Frame, HelperError> {
    match line {
        b"SUCCESS" => return Ok(Frame::Result(HelperOutcome::Success)),
        b"FAILURE" => return Ok(Frame::Result(HelperOutcome::Failure)),
        _ => {}
    }
    let (command, payload) = line.split_at(
        line.iter()
            .position(|&b| b == b' ')
            .ok_or(HelperError::InvalidFrame)?,
    );
    let payload = &payload[1..];
    let event = match command {
        b"PAM_PROMPT_ECHO_ON" => HelperEvent::Prompt {
            text: decode_text(payload)?,
            echo: Echo::On,
        },
        b"PAM_PROMPT_ECHO_OFF" => HelperEvent::Prompt {
            text: decode_text(payload)?,
            echo: Echo::Off,
        },
        b"PAM_TEXT_INFO" => HelperEvent::Info(decode_text(payload)?),
        b"PAM_ERROR_MSG" => HelperEvent::Error(decode_text(payload)?),
        _ => return Err(HelperError::InvalidFrame),
    };
    Ok(Frame::Event(event))
}

// The PAM helper runs message bytes through GLib g_strescape, including octal
// escapes for individual non-ASCII bytes. Validate UTF-8 only after decoding.
fn decode_text(payload: &[u8]) -> Result<Zeroizing<String>, HelperError> {
    let mut decoded = Zeroizing::new(Vec::with_capacity(payload.len()));
    let mut bytes = payload.iter().copied();
    while let Some(byte) = bytes.next() {
        let byte = match byte {
            b'\\' => match bytes.next() {
                Some(b'\\') => b'\\',
                Some(b'"') => b'"',
                Some(b'b') => 0x08,
                Some(b'f') => 0x0c,
                Some(b'n') => b'\n',
                Some(b'r') => b'\r',
                Some(b't') => b'\t',
                Some(b'v') => 0x0b,
                Some(high @ b'0'..=b'3') => match (bytes.next(), bytes.next()) {
                    (Some(mid @ b'0'..=b'7'), Some(low @ b'0'..=b'7')) => {
                        (high - b'0') * 64 + (mid - b'0') * 8 + (low - b'0')
                    }
                    _ => return Err(HelperError::InvalidFrame),
                },
                _ => return Err(HelperError::InvalidFrame),
            },
            b' '..=b'~' => byte,
            _ => return Err(HelperError::InvalidFrame),
        };
        if byte == 0 {
            return Err(HelperError::InvalidFrame);
        }
        decoded.push(byte);
    }
    match String::from_utf8(std::mem::take(&mut *decoded)) {
        Ok(text) => Ok(Zeroizing::new(text)),
        Err(error) => {
            let _bytes = Zeroizing::new(error.into_bytes());
            Err(HelperError::InvalidFrame)
        }
    }
}
