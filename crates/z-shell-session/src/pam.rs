//! Isolated PAM authentication and deterministic authenticator implementations.

use libloading::Library;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::VecDeque;
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::fmt;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Command, Stdio};
use std::ptr;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

const HELPER_IO_LIMIT: u64 = 64 * 1024;
const DEFAULT_HELPER_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const PAM_SERVICE: &[u8] = b"login\0";
const PAM_SUCCESS: c_int = 0;
const PAM_BUF_ERR: c_int = 5;
const PAM_AUTH_ERR: c_int = 7;
const PAM_MAXTRIES: c_int = 11;
const PAM_CONV_ERR: c_int = 19;
const PAM_PROMPT_ECHO_OFF: c_int = 1;
const PAM_PROMPT_ECHO_ON: c_int = 2;
const PAM_ERROR_MSG: c_int = 3;
const PAM_TEXT_INFO: c_int = 4;

/// Credentials passed directly to one authentication attempt.
///
/// The password is zeroized on drop and redacted from [`Debug`](fmt::Debug).
pub struct Credentials {
    username: String,
    password: Zeroizing<String>,
}

impl Credentials {
    /// Creates credentials for one authentication attempt.
    #[must_use]
    pub fn new(username: impl Into<String>, password: impl Into<String>) -> Self {
        Self {
            username: username.into(),
            password: Zeroizing::new(password.into()),
        }
    }

    /// Returns the account name.
    #[must_use]
    pub fn username(&self) -> &str {
        &self.username
    }

    /// Returns the password for immediate use by an authenticator.
    #[must_use]
    pub fn password(&self) -> &str {
        &self.password
    }
}

impl fmt::Debug for Credentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Credentials")
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .finish()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialsWire {
    username: String,
    password: String,
}

impl Serialize for Credentials {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeStruct;

        let mut credentials = serializer.serialize_struct("Credentials", 2)?;
        credentials.serialize_field("username", &self.username)?;
        credentials.serialize_field("password", self.password())?;
        credentials.end()
    }
}

impl<'de> Deserialize<'de> for Credentials {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = CredentialsWire::deserialize(deserializer)?;
        Ok(Self::new(wire.username, wire.password))
    }
}

/// Result emitted by the standalone helper and by every [`Authenticator`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AuthOutcome {
    /// PAM accepted the account credentials.
    Authenticated,
    /// PAM rejected the credentials or account.
    Denied {
        /// Safe user-facing PAM information, including faillock explanations.
        message: String,
    },
    /// Authentication could not be performed reliably.
    Unavailable {
        /// Diagnostic describing the helper, protocol, or PAM failure.
        reason: String,
    },
}

/// Future returned by an authentication attempt.
pub type AuthFuture<'a> = Pin<Box<dyn Future<Output = AuthOutcome> + Send + 'a>>;

/// Object-safe authentication interface used by the lock coordinator.
pub trait Authenticator: fmt::Debug + Send + Sync {
    /// Authenticates one owned, zeroizing credential bundle.
    fn authenticate(&self, credentials: Credentials) -> AuthFuture<'_>;
}

/// Authenticator spawning the short-lived standalone PAM helper.
#[derive(Clone, Debug)]
pub struct HelperAuthenticator {
    helper_path: Option<PathBuf>,
    timeout: Duration,
}

/// Type alias matching daemon configuration terminology for [`HelperAuthenticator`].
pub type PamHelperAuthenticator = HelperAuthenticator;

impl HelperAuthenticator {
    /// Creates a helper authenticator with a thirty-second process bound.
    #[must_use]
    pub fn new(helper_path: impl Into<PathBuf>) -> Self {
        Self::with_timeout(helper_path, DEFAULT_HELPER_TIMEOUT)
    }

    /// Creates a helper authenticator from an optional pre-resolved absolute executable path.
    ///
    /// When `None`, authentication fails closed with [`AuthOutcome::Unavailable`] without spawning.
    #[must_use]
    pub fn from_resolved(helper_path: Option<PathBuf>) -> Self {
        Self {
            helper_path,
            timeout: DEFAULT_HELPER_TIMEOUT,
        }
    }

    /// Resolves a trusted helper path via [`resolve_trusted_pam_helper_path`] and constructs an
    /// authenticator that fails closed when no verified executable exists.
    #[must_use]
    pub fn resolve(override_path: Option<&Path>) -> Self {
        Self::from_resolved(resolve_trusted_pam_helper_path(override_path))
    }

    /// Creates a helper authenticator with an explicit process bound.
    #[must_use]
    pub fn with_timeout(helper_path: impl Into<PathBuf>, timeout: Duration) -> Self {
        Self {
            helper_path: Some(helper_path.into()),
            timeout,
        }
    }

    /// Returns the executable path configured for authentication attempts, if any.
    #[must_use]
    pub fn helper_path(&self) -> Option<&Path> {
        self.helper_path.as_deref()
    }
}

/// Resolves the standalone `z-shell-pam-helper` executable without ever consulting `$PATH`.
///
/// Checks in order:
/// 1. An explicit override path, accepted only if it is a verified absolute regular executable.
/// 2. A sibling `z-shell-pam-helper` adjacent to [`std::env::current_exe`].
/// 3. A compile-time `Z_SHELL_PAM_HELPER` absolute installation path.
#[must_use]
pub fn resolve_trusted_pam_helper_path(override_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = override_path {
        return validate_trusted_helper_path(path).ok();
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
        && let Ok(sibling) = validate_trusted_helper_path(&dir.join("z-shell-pam-helper"))
    {
        return Some(sibling);
    }
    option_env!("Z_SHELL_PAM_HELPER")
        .map(Path::new)
        .and_then(|path| validate_trusted_helper_path(path).ok())
}

fn validate_trusted_helper_path(path: &Path) -> Result<PathBuf, String> {
    if path.as_os_str().is_empty() {
        return Err("no trusted PAM helper executable found".to_owned());
    }
    if !path.is_absolute() {
        return Err("PAM helper path must be an absolute path".to_owned());
    }
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("PAM helper executable is unavailable: {error}"))?;
    if !metadata.is_file() {
        return Err("PAM helper path is not a regular file".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if metadata.permissions().mode() & 0o111 == 0 {
            return Err("PAM helper path is not executable".to_owned());
        }
    }
    Ok(path.to_path_buf())
}

impl Authenticator for HelperAuthenticator {
    fn authenticate(&self, credentials: Credentials) -> AuthFuture<'_> {
        let path = self.helper_path.clone();
        let timeout = self.timeout;
        Box::pin(async move {
            let Some(path) = path else {
                return AuthOutcome::Unavailable {
                    reason: "no trusted PAM helper executable found".to_owned(),
                };
            };
            let verified_path = match validate_trusted_helper_path(&path) {
                Ok(verified) => verified,
                Err(reason) => return AuthOutcome::Unavailable { reason },
            };
            let request = match serde_json::to_vec(&credentials) {
                Ok(bytes) => Zeroizing::new(bytes),
                Err(error) => {
                    return AuthOutcome::Unavailable {
                        reason: format!("could not encode helper request: {error}"),
                    };
                }
            };
            match tokio::task::spawn_blocking(move || {
                run_helper_process(&verified_path, timeout, &request)
            })
            .await
            {
                Ok(outcome) => outcome,
                Err(error) => AuthOutcome::Unavailable {
                    reason: format!("PAM helper worker failed: {error}"),
                },
            }
        })
    }
}

fn run_helper_process(path: &Path, timeout: Duration, request: &[u8]) -> AuthOutcome {
    let result = (|| {
        let verified_path = validate_trusted_helper_path(path)?;
        let mut child = Command::new(&verified_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("could not spawn PAM helper: {error}"))?;
        child
            .stdin
            .take()
            .ok_or_else(|| "PAM helper stdin was not piped".to_owned())
            .and_then(|mut stdin| {
                stdin
                    .write_all(request)
                    .map_err(|error| format!("could not write PAM helper request: {error}"))
            })?;

        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL_INTERVAL),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("PAM helper timed out".to_owned());
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("could not wait for PAM helper: {error}"));
                }
            }
        };
        if !status.success() {
            return Err(format!("PAM helper exited with status {status}"));
        }
        let mut bytes = Vec::new();
        child
            .stdout
            .take()
            .ok_or_else(|| "PAM helper stdout was not piped".to_owned())?
            .take(HELPER_IO_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("could not read PAM helper response: {error}"))?;
        if bytes.len() as u64 > HELPER_IO_LIMIT {
            return Err("PAM helper response exceeded the size limit".to_owned());
        }
        serde_json::from_slice::<AuthOutcome>(&bytes)
            .map_err(|error| format!("invalid PAM helper response: {error}"))
    })();
    result.unwrap_or_else(|reason| AuthOutcome::Unavailable { reason })
}

/// Deterministic authenticator returning queued outcomes in order.
#[derive(Debug)]
pub struct MockAuthenticator {
    outcomes: Mutex<VecDeque<AuthOutcome>>,
    usernames: Mutex<Vec<String>>,
}

impl MockAuthenticator {
    /// Creates a mock returning each supplied outcome once.
    #[must_use]
    pub fn new(outcomes: impl IntoIterator<Item = AuthOutcome>) -> Self {
        Self {
            outcomes: Mutex::new(outcomes.into_iter().collect()),
            usernames: Mutex::new(Vec::new()),
        }
    }

    /// Returns account names in authentication order, never passwords.
    #[must_use]
    pub fn recorded_usernames(&self) -> Vec<String> {
        self.usernames
            .lock()
            .expect("mock username lock poisoned")
            .clone()
    }
}

impl Authenticator for MockAuthenticator {
    fn authenticate(&self, credentials: Credentials) -> AuthFuture<'_> {
        Box::pin(async move {
            self.usernames
                .lock()
                .expect("mock username lock poisoned")
                .push(credentials.username().to_owned());
            self.outcomes
                .lock()
                .expect("mock outcome lock poisoned")
                .pop_front()
                .unwrap_or(AuthOutcome::Unavailable {
                    reason: "mock authenticator has no queued outcome".into(),
                })
        })
    }
}

#[repr(C)]
struct PamMessage {
    style: c_int,
    text: *const c_char,
}

#[repr(C)]
struct PamResponse {
    text: *mut c_char,
    code: c_int,
}

type Converse =
    extern "C" fn(c_int, *mut *const PamMessage, *mut *mut PamResponse, *mut c_void) -> c_int;

#[repr(C)]
struct PamConversation {
    converse: Converse,
    data: *mut c_void,
}

type PamStart = unsafe extern "C" fn(
    *const c_char,
    *const c_char,
    *const PamConversation,
    *mut *mut c_void,
) -> c_int;
type PamAuthenticate = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;
type PamEnd = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;
type PamStrerror = unsafe extern "C" fn(*mut c_void, c_int) -> *const c_char;

struct PamApi {
    _library: Library,
    start: PamStart,
    authenticate: PamAuthenticate,
    end: PamEnd,
    strerror: PamStrerror,
}

impl PamApi {
    fn load() -> Result<Self, String> {
        // SAFETY: The helper loads only libpam and keeps the library alive while its symbols run.
        let library = unsafe { Library::new("libpam.so.0") }
            .map_err(|error| format!("could not load libpam.so.0: {error}"))?;
        // SAFETY: Symbol names and signatures are defined by the stable Linux-PAM C ABI.
        let (start, authenticate, end, strerror) = unsafe {
            (
                *library
                    .get::<PamStart>(b"pam_start\0")
                    .map_err(|error| format!("missing pam_start: {error}"))?,
                *library
                    .get::<PamAuthenticate>(b"pam_authenticate\0")
                    .map_err(|error| format!("missing pam_authenticate: {error}"))?,
                *library
                    .get::<PamEnd>(b"pam_end\0")
                    .map_err(|error| format!("missing pam_end: {error}"))?,
                *library
                    .get::<PamStrerror>(b"pam_strerror\0")
                    .map_err(|error| format!("missing pam_strerror: {error}"))?,
            )
        };
        Ok(Self {
            _library: library,
            start,
            authenticate,
            end,
            strerror,
        })
    }
}

struct Answers {
    username: CString,
    password: Zeroizing<Vec<u8>>,
    messages: std::cell::RefCell<Vec<String>>,
}

unsafe extern "C" {
    fn calloc(count: usize, size: usize) -> *mut c_void;
    fn strdup(value: *const c_char) -> *mut c_char;
    fn free(value: *mut c_void);
}

extern "C" fn converse(
    count: c_int,
    messages: *mut *const PamMessage,
    responses: *mut *mut PamResponse,
    data: *mut c_void,
) -> c_int {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        converse_inner(count, messages, responses, data)
    }))
    .unwrap_or(PAM_CONV_ERR)
}

fn converse_inner(
    count: c_int,
    messages: *mut *const PamMessage,
    responses: *mut *mut PamResponse,
    data: *mut c_void,
) -> c_int {
    if count <= 0 || messages.is_null() || responses.is_null() || data.is_null() {
        return PAM_CONV_ERR;
    }
    // SAFETY: PAM supplies a live Answers pointer for the duration of this conversation.
    let answers = unsafe { &*(data.cast::<Answers>()) };
    let count = count as usize;
    // SAFETY: calloc allocates zeroed storage for exactly count C-compatible responses.
    let output = unsafe { calloc(count, size_of::<PamResponse>()) }.cast::<PamResponse>();
    if output.is_null() {
        return PAM_BUF_ERR;
    }
    for index in 0..count {
        // SAFETY: Linux-PAM supplies an array of count message pointers.
        let message = unsafe { *messages.add(index) };
        if message.is_null() {
            continue;
        }
        // SAFETY: A non-null message points to a PAM-owned message for this callback.
        let style = unsafe { (*message).style };
        // SAFETY: The text pointer is read only while PAM owns the message.
        let text = unsafe { (*message).text };
        if matches!(style, PAM_ERROR_MSG | PAM_TEXT_INFO) && !text.is_null() {
            // SAFETY: Non-null PAM message text is NUL-terminated for this callback.
            let text = unsafe { CStr::from_ptr(text) }.to_string_lossy();
            let text = text.trim();
            if !text.is_empty()
                && let Ok(mut messages) = answers.messages.try_borrow_mut()
            {
                messages.push(text.to_owned());
            }
        }
        let answer = match style {
            PAM_PROMPT_ECHO_OFF => Some(answers.password.as_ptr().cast::<c_char>()),
            PAM_PROMPT_ECHO_ON => Some(answers.username.as_ptr()),
            _ => None,
        };
        if let Some(answer) = answer {
            // SAFETY: answer is NUL-terminated; PAM takes ownership of the duplicated response.
            let duplicate = unsafe { strdup(answer) };
            if duplicate.is_null() {
                for previous in 0..index {
                    // SAFETY: These response slots were initialized by this callback or calloc.
                    let response = unsafe { &mut *output.add(previous) };
                    if !response.text.is_null() {
                        // SAFETY: strdup allocated this response and it has not been freed.
                        unsafe { free(response.text.cast::<c_void>()) };
                    }
                }
                // SAFETY: output was allocated by calloc and ownership has not transferred to PAM.
                unsafe { free(output.cast::<c_void>()) };
                return PAM_BUF_ERR;
            }
            // SAFETY: index is within the allocated response array.
            unsafe { (*output.add(index)).text = duplicate };
        }
    }
    // SAFETY: responses is valid and PAM receives ownership of the allocated response array.
    unsafe { *responses = output };
    PAM_SUCCESS
}

/// Executes `pam_authenticate` directly in the current short-lived process.
///
/// Long-lived daemons should use [`HelperAuthenticator`] instead.
#[must_use]
pub fn authenticate_with_pam(credentials: Credentials) -> AuthOutcome {
    match authenticate_inner(&credentials) {
        Ok(outcome) => outcome,
        Err(reason) => AuthOutcome::Unavailable { reason },
    }
}

fn authenticate_inner(credentials: &Credentials) -> Result<AuthOutcome, String> {
    if credentials.username().is_empty() {
        return Err("username is empty".into());
    }
    let username = CString::new(credentials.username())
        .map_err(|_| "username contains an interior NUL byte".to_owned())?;
    if credentials.password().as_bytes().contains(&0) {
        return Ok(AuthOutcome::Denied {
            message: "invalid credentials".into(),
        });
    }
    let mut password = Zeroizing::new(Vec::with_capacity(credentials.password().len() + 1));
    password.extend_from_slice(credentials.password().as_bytes());
    password.push(0);
    let api = PamApi::load()?;
    let answers = Answers {
        username,
        password,
        messages: std::cell::RefCell::new(Vec::new()),
    };
    let conversation = PamConversation {
        converse,
        data: (&answers as *const Answers).cast_mut().cast::<c_void>(),
    };
    let mut handle = ptr::null_mut();
    // SAFETY: All pointers remain valid for pam_start; PAM initializes handle on success.
    let started = unsafe {
        (api.start)(
            PAM_SERVICE.as_ptr().cast::<c_char>(),
            answers.username.as_ptr(),
            &conversation,
            &mut handle,
        )
    };
    if started != PAM_SUCCESS || handle.is_null() {
        return Err(format!("pam_start failed with status {started}"));
    }

    struct PamHandleGuard<'a> {
        api: &'a PamApi,
        handle: *mut c_void,
        status: c_int,
    }
    impl Drop for PamHandleGuard<'_> {
        fn drop(&mut self) {
            // SAFETY: Balances the successful pam_start exactly once on normal return or unwind.
            unsafe { (self.api.end)(self.handle, self.status) };
        }
    }

    let mut guard = PamHandleGuard {
        api: &api,
        handle,
        status: PAM_SUCCESS,
    };
    // SAFETY: handle came from pam_start and the conversation remains alive through this call.
    let code = unsafe { (api.authenticate)(guard.handle, 0) };
    guard.status = code;
    let outcome = match code {
        PAM_SUCCESS => AuthOutcome::Authenticated,
        PAM_AUTH_ERR | PAM_MAXTRIES => {
            let messages = answers.messages.borrow();
            AuthOutcome::Denied {
                message: if messages.is_empty() {
                    "authentication failed".into()
                } else {
                    messages.join(" ")
                },
            }
        }
        other => {
            // SAFETY: handle remains valid until PamHandleGuard drops and pam_strerror returns static/PAM text.
            let message = unsafe { (api.strerror)(guard.handle, other) };
            let reason = if message.is_null() {
                format!("pam_authenticate failed with status {other}")
            } else {
                // SAFETY: Non-null pam_strerror text is NUL-terminated.
                unsafe { CStr::from_ptr(message) }
                    .to_string_lossy()
                    .into_owned()
            };
            AuthOutcome::Unavailable { reason }
        }
    };
    drop(guard);
    Ok(outcome)
}

/// Runs the standalone helper's single-request stdin/stdout protocol.
///
/// Invalid requests produce one [`AuthOutcome::Unavailable`] JSON object. No credentials or PAM
/// messages are logged to stderr.
pub fn run_pam_helper(mut input: impl Read, mut output: impl Write) {
    let outcome = match read_helper_request(&mut input) {
        Ok(credentials) => authenticate_with_pam(credentials),
        Err(reason) => AuthOutcome::Unavailable { reason },
    };
    if serde_json::to_writer(&mut output, &outcome).is_ok() {
        let _ = output.write_all(b"\n");
    }
}

fn read_helper_request(input: impl Read) -> Result<Credentials, String> {
    let mut bytes = Zeroizing::new(Vec::new());
    input
        .take(HELPER_IO_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read helper request: {error}"))?;
    if bytes.len() as u64 > HELPER_IO_LIMIT {
        return Err("helper request exceeded the size limit".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "helper request is not a valid credential object".into())
}
