//! Private D-Bus Authority, real helper pipes, and host control channel tests.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tempfile::TempDir;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::timeout;
use z_shell_bus::hub::ClientOutbound;
use z_shell_bus::{BusHub, CallerContext};
use z_shell_config::PolkitSettings;
use z_shell_protocol::{
    ClientMessage, ClientRole, CommandInvokeParams, CommandName, ErrorCode, PROTOCOL_VERSION,
    RequestId, RpcError, methods,
};
use z_shell_session::polkit::{
    POLKIT_TOPIC, PolkitBus, PolkitEnabled, PolkitHelperConfig, PolkitLockState,
    PolkitRegistration, PolkitService,
};
use zbus::connection::Builder;
use zbus::message::Header;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};
use zbus::{Connection, Proxy};

const AUTHORITY_NAME: &str = "org.freedesktop.PolicyKit1";
const AUTHORITY_PATH: &str = "/org/freedesktop/PolicyKit1/Authority";
const AGENT: &str = "org.freedesktop.PolicyKit1.AuthenticationAgent";
const AGENT_PATH: &str = "/org/zshell/PolicyKit1/AuthenticationAgent";
const LOGIND_PATH: &str = "/org/freedesktop/login1";
const SESSION_PATH: &str = "/org/freedesktop/login1/session/test";
const CANCELLED: &str = "org.freedesktop.PolicyKit1.Error.Cancelled";
const FAILED: &str = "org.freedesktop.PolicyKit1.Error.Failed";
const CORRECT: &str = "correct-private-response";
const WRONG: &str = "wrong-private-response";
const WAIT: Duration = Duration::from_secs(5);

type Dict = HashMap<String, OwnedValue>;
type Subject = (String, Dict);

struct TestBus(Child);

impl TestBus {
    fn start() -> (Self, String) {
        let mut bus = Self(
            Command::new("dbus-daemon")
                .args(["--session", "--nofork", "--nosyslog", "--print-address=1"])
                .stdout(Stdio::piped())
                .spawn()
                .expect("start private dbus-daemon"),
        );
        let mut address = String::new();
        BufReader::new(bus.0.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        assert!(!address.is_empty(), "private bus gave no address");
        (bus, address.trim().to_owned())
    }
}

impl Drop for TestBus {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[derive(Debug)]
enum RegistrationEvent {
    Register(String),
    Unregister(String),
}

struct MockAuthority(mpsc::UnboundedSender<RegistrationEvent>);

#[zbus::interface(name = "org.freedesktop.PolicyKit1.Authority")]
impl MockAuthority {
    fn register_authentication_agent(
        &self,
        subject: Subject,
        locale: String,
        path: String,
        #[zbus(header)] header: Header<'_>,
    ) {
        assert_eq!(subject.0, "unix-session");
        assert_eq!(
            <&str>::try_from(&subject.1["session-id"]).unwrap(),
            "test-session"
        );
        assert!(!locale.is_empty());
        assert_eq!(path, AGENT_PATH);
        self.0
            .send(RegistrationEvent::Register(
                header.sender().unwrap().to_string(),
            ))
            .unwrap();
    }

    fn unregister_authentication_agent(
        &self,
        subject: Subject,
        path: String,
        #[zbus(header)] header: Header<'_>,
    ) {
        assert_eq!(subject.0, "unix-session");
        assert_eq!(
            <&str>::try_from(&subject.1["session-id"]).unwrap(),
            "test-session"
        );
        assert_eq!(path, AGENT_PATH);
        self.0
            .send(RegistrationEvent::Unregister(
                header.sender().unwrap().to_string(),
            ))
            .unwrap();
    }
}

struct MockLogind;

#[zbus::interface(name = "org.freedesktop.login1.Manager")]
impl MockLogind {
    #[zbus(name = "GetSessionByPID")]
    fn get_session_by_pid(&self, pid: u32) -> OwnedObjectPath {
        assert_eq!(pid, std::process::id());
        OwnedObjectPath::try_from(SESSION_PATH).unwrap()
    }
}

struct MockSession;

#[zbus::interface(name = "org.freedesktop.login1.Session")]
impl MockSession {
    #[zbus(property)]
    fn id(&self) -> &str {
        "test-session"
    }
}

struct Fixture {
    registration: PolkitRegistration,
    service: Arc<PolkitService>,
    events: mpsc::UnboundedReceiver<RegistrationEvent>,
    authority: Connection,
    address: String,
    destination: String,
    hub: BusHub,
    outbound: ClientOutbound,
    host: CallerContext,
    attempts: std::path::PathBuf,
    _dir: TempDir,
    _bus: TestBus,
}

impl Fixture {
    async fn new() -> Self {
        let (bus, address) = TestBus::start();
        let (tx, events) = mpsc::unbounded_channel();
        let authority = timeout(
            WAIT,
            Builder::address(address.as_str())
                .unwrap()
                .name(AUTHORITY_NAME)
                .unwrap()
                .name("org.freedesktop.login1")
                .unwrap()
                .serve_at(AUTHORITY_PATH, MockAuthority(tx))
                .unwrap()
                .serve_at(LOGIND_PATH, MockLogind)
                .unwrap()
                .serve_at(SESSION_PATH, MockSession)
                .unwrap()
                .build(),
        )
        .await
        .unwrap()
        .unwrap();
        let dir = TempDir::new().unwrap();
        let helper = dir.path().join("helper");
        let attempts = dir.path().join("attempts");
        fs::write(
            &helper,
            r#"#!/bin/sh
IFS= read -r cookie || exit 2
case "$cookie" in cookie-secret-*) ;; *) exit 3 ;; esac
printf '%s %s\n' "$$" "$1" >> "${0%/*}/attempts"
if [ "$cookie" = cookie-secret-oversize ]; then
    printf 'PAM_TEXT_INFO %08192d\n' 0
    exit 7
fi
printf 'PAM_TEXT_INFO identity\\040%s\\nready\n' "$1"
printf 'PAM_PROMPT_ECHO_OFF Password: \n'
IFS= read -r response || exit 4
if [ "$response" = correct-private-response ]; then
    printf 'PAM_PROMPT_ECHO_ON Verification code: \n'
    IFS= read -r code || exit 5
    [ "$code" = 123456 ] || exit 6
    printf 'SUCCESS\n'
else
    printf 'PAM_TEXT_INFO %s %s\n' "$cookie" "$response"
    printf 'PAM_ERROR_MSG Denied by PAM\nFAILURE\n'
fi
"#,
        )
        .unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        let service = Arc::new(PolkitService::with_helper(
            &PolkitSettings::default(),
            PolkitHelperConfig::with_path(helper),
        ));
        let hub = BusHub::new("test", dir.path().join("media"));
        service.install_on_bus(&hub);
        let (observer, outbound) = hub.register_client(ClientRole::Public).unwrap();
        hub.handle_inline_message(
            observer,
            ClientMessage::request(
                RequestId::Number(1),
                methods::BUS_HELLO,
                Some(json!({"protocol_version": PROTOCOL_VERSION})),
            ),
        );
        outbound.next_line().await.unwrap();
        hub.handle_inline_message(
            observer,
            ClientMessage::request(
                RequestId::Number(2),
                methods::TOPIC_SUBSCRIBE,
                Some(json!({"topic": POLKIT_TOPIC})),
            ),
        );
        let baseline: Value = serde_json::from_str(&outbound.next_line().await.unwrap()).unwrap();
        assert_eq!(baseline["result"]["data"]["registered"], false);
        let (client_id, _) = hub.register_client(ClientRole::PrivilegedHost).unwrap();
        let host = CallerContext {
            client_id,
            role: ClientRole::PrivilegedHost,
        };
        let registration = service.start_registration(
            PolkitBus::Address(address.clone()),
            &tokio::runtime::Handle::current(),
        );
        let mut fixture = Self {
            registration,
            service,
            events,
            authority,
            address,
            destination: String::new(),
            hub,
            outbound,
            host,
            attempts,
            _dir: dir,
            _bus: bus,
        };
        fixture.destination = fixture.registered().await;
        fixture.until(|state| state["registered"] == true).await;
        fixture
    }

    async fn registered(&mut self) -> String {
        let RegistrationEvent::Register(sender) = self.event().await else {
            panic!("expected Authority RegisterAuthenticationAgent");
        };
        sender
    }

    async fn event(&mut self) -> RegistrationEvent {
        timeout(WAIT, self.events.recv())
            .await
            .expect("Authority event within timeout")
            .unwrap()
    }

    async fn until(&self, predicate: impl Fn(&Value) -> bool) -> Value {
        timeout(WAIT, async {
            loop {
                let line = self.outbound.next_line().await.unwrap();
                for secret in ["cookie-secret-", CORRECT, WRONG, "123456"] {
                    assert!(!line.contains(secret), "session.polkit leaked a secret");
                }
                let frame: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(frame["params"]["topic"], POLKIT_TOPIC);
                let state = &frame["params"]["data"];
                if predicate(state) {
                    return state.clone();
                }
            }
        })
        .await
        .expect("expected session.polkit update within timeout")
    }

    async fn prompt(&self, action: &str) -> Value {
        self.until(|state| {
            state["active"]["action_id"] == action && state["active"]["prompt"] == "Password: "
        })
        .await["active"]
            .clone()
    }

    fn begin(&self, action: &str, cookie: &str, uids: &[u32]) -> JoinHandle<zbus::Result<()>> {
        let (connection, destination) = (self.authority.clone(), self.destination.clone());
        let (action, cookie) = (action.to_owned(), cookie.to_owned());
        let ids = identities(uids);
        tokio::spawn(async move { begin(&connection, &destination, &action, &cookie, ids).await })
    }

    async fn cancel(&self, cookie: &str) {
        timeout(
            WAIT,
            agent(&self.authority, &self.destination)
                .await
                .call::<_, _, ()>("CancelAuthentication", &(cookie,)),
        )
        .await
        .unwrap()
        .unwrap();
    }

    async fn invoke(&self, name: &str, payload: Value) -> Result<(), RpcError> {
        invoke(&self.hub, self.host, name, payload).await
    }

    async fn respond(&self, id: &Value, response: &str) {
        self.invoke(
            "host.polkit-respond",
            json!({"request_id": id, "response": response}),
        )
        .await
        .unwrap();
    }

    fn runs(&self) -> Vec<(u32, String)> {
        fs::read_to_string(&self.attempts)
            .unwrap()
            .lines()
            .map(|line| {
                let (pid, user) = line.split_once(' ').unwrap();
                (pid.parse().unwrap(), user.to_owned())
            })
            .collect()
    }
}

async fn agent<'a>(connection: &Connection, destination: &'a str) -> Proxy<'a> {
    Proxy::new(connection, destination, AGENT_PATH, AGENT)
        .await
        .unwrap()
}

async fn begin(
    connection: &Connection,
    destination: &str,
    action: &str,
    cookie: &str,
    ids: Vec<Subject>,
) -> zbus::Result<()> {
    let details = HashMap::from([("test-detail", "detail-value")]);
    agent(connection, destination)
        .await
        .call(
            "BeginAuthentication",
            &(action, "An action", "dialog-password", details, cookie, ids),
        )
        .await
}

fn identities(uids: &[u32]) -> Vec<Subject> {
    let mut ids: Vec<_> = uids
        .iter()
        .map(|&uid| {
            (
                "unix-user".to_owned(),
                HashMap::from([("uid".to_owned(), OwnedValue::from(uid))]),
            )
        })
        .collect();
    ids.push(("unix-group".to_owned(), Dict::new()));
    ids.push(("unix-user".to_owned(), Dict::new()));
    ids
}

fn users() -> ((u32, String), (u32, String)) {
    let passwd = fs::read_to_string("/etc/passwd").unwrap();
    let mut users = passwd.lines().filter_map(|line| {
        let mut fields = line.split(':');
        let name = fields.next()?;
        let uid = fields.nth(1)?.parse::<u32>().ok()?;
        Some((uid, name.to_owned()))
    });
    let first = users.next().unwrap();
    let second = users.find(|user| user.0 != first.0).unwrap();
    (first, second)
}

async fn invoke(
    hub: &BusHub,
    caller: CallerContext,
    name: &str,
    payload: Value,
) -> Result<(), RpcError> {
    hub.invoke_command(
        caller,
        CommandInvokeParams {
            name: CommandName::try_new(name).unwrap(),
            args: Vec::new(),
            payload: Some(payload),
        },
    )
    .await
    .map(|_| ())
}

async fn finished(call: JoinHandle<zbus::Result<()>>) -> zbus::Result<()> {
    timeout(WAIT, call)
        .await
        .expect("BeginAuthentication resolved")
        .unwrap()
}

fn assert_dbus_error(result: zbus::Result<()>, name: &str) {
    assert!(
        matches!(&result, Err(zbus::Error::MethodError(got, _, _)) if got.as_str() == name),
        "expected {name}, got {result:?}"
    );
}

fn assert_reaped(pid: u32) {
    assert!(
        !std::path::Path::new(&format!("/proc/{pid}")).exists(),
        "helper {pid} not reaped"
    );
}

#[tokio::test]
async fn prompt_retry_and_multi_step_success_keep_credentials_off_topic() {
    let f = Fixture::new().await;
    let ((uid, username), _) = users();
    let call = f.begin("prompt", "cookie-secret-prompt", &[uid, uid, u32::MAX]);
    let prompt = f.prompt("prompt").await;
    assert_eq!(prompt["message"], "An action");
    assert_eq!(prompt["icon_name"], "dialog-password");
    assert_eq!(prompt["details"], json!({"test-detail": "detail-value"}));
    assert_eq!(
        prompt["identities"],
        json!([{"uid": uid, "username":username}])
    );
    assert_eq!(prompt["selected_uid"], uid);
    assert_eq!(prompt["echo_on"], false);
    assert_eq!(prompt["authenticating"], false);
    assert_eq!(
        prompt["info_message"],
        format!("identity {username}\nready")
    );
    let id = &prompt["request_id"];
    let invalid = f
        .invoke(
            "host.polkit-respond",
            json!({
                "request_id": id, "response": "newline\ninjection",
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(invalid.code, ErrorCode::InvalidParams);
    f.respond(id, WRONG).await;
    let retry = f.prompt("prompt").await;
    assert_eq!(retry["error_message"], "Denied by PAM");
    assert_eq!(&retry["request_id"], id);
    let runs = f.runs();
    assert_eq!(runs.len(), 2);
    assert_ne!(runs[0].0, runs[1].0);
    assert_reaped(runs[0].0);
    f.respond(id, CORRECT).await;
    let echo = f.until(|state| state["active"]["echo_on"] == true).await;
    assert_eq!(echo["active"]["prompt"], "Verification code: ");
    f.respond(id, "123456").await;
    finished(call).await.unwrap();
    f.until(|state| state["active"].is_null()).await;
    assert_reaped(runs[1].0);
}

#[tokio::test]
async fn retry_exhaustion_reaps_child_and_fails_request() {
    let f = Fixture::new().await;
    let ((uid, _), _) = users();
    let call = f.begin("exhaust", "cookie-secret-exhaust", &[uid]);
    for _ in 0..3 {
        let prompt = f.prompt("exhaust").await;
        f.respond(&prompt["request_id"], WRONG).await;
    }
    assert_dbus_error(finished(call).await, FAILED);
    f.until(|state| state["active"].is_null()).await;
    let runs = f.runs();
    assert_eq!(runs.len(), 3);
    for (pid, _) in runs {
        assert_reaped(pid);
    }
}

#[tokio::test]
async fn oversized_helper_output_fails_without_retry_and_reaps_child() {
    let f = Fixture::new().await;
    let ((uid, _), _) = users();
    let call = f.begin("oversize", "cookie-secret-oversize", &[uid]);
    assert_dbus_error(finished(call).await, FAILED);
    f.until(|state| {
        state["active"].is_null() && state["last_error"] == "invalid Polkit helper protocol frame"
    })
    .await;
    let runs = f.runs();
    assert_eq!(runs.len(), 1);
    assert_reaped(runs[0].0);
}

#[tokio::test]
async fn identity_switch_reaps_old_helper_and_host_cancel_reaps_replacement() {
    let f = Fixture::new().await;
    let (first, second) = users();
    let call = f.begin("switch", "cookie-secret-switch", &[first.0, second.0]);
    let old = f.prompt("switch").await;
    let target = if old["selected_uid"] == first.0 {
        second
    } else {
        first
    };
    let id = &old["request_id"];
    f.invoke(
        "host.polkit-select-identity",
        json!({"request_id": id, "uid": target.0}),
    )
    .await
    .unwrap();
    let new = f.prompt("switch").await;
    assert_eq!(new["selected_uid"], target.0);
    assert_eq!(&new["request_id"], id);
    let runs = f.runs();
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[1].1, target.1);
    assert_reaped(runs[0].0);
    f.invoke("host.polkit-cancel", json!({"request_id": id}))
        .await
        .unwrap();
    assert_dbus_error(finished(call).await, CANCELLED);
    assert_reaped(runs[1].0);
}

#[tokio::test]
async fn dbus_and_host_cancellation_advance_the_queue() {
    let f = Fixture::new().await;
    let ((uid, _), _) = users();
    let first = f.begin("first", "cookie-secret-first", &[uid]);
    let old = f.prompt("first").await;
    let queued = f.begin("queued", "cookie-secret-queued", &[uid]);
    // A cancellation sent ahead of the spawned Begin is harmless; repeat until the queued call
    // resolves while the first request still owns the one helper slot.
    let mut queued = queued;
    let result = timeout(WAIT, async {
        loop {
            f.cancel("cookie-secret-queued").await;
            tokio::select! {
                result = &mut queued => break result.unwrap(),
                _ = tokio::time::sleep(Duration::from_millis(2)) => {}
            }
        }
    })
    .await
    .unwrap();
    assert_dbus_error(result, CANCELLED);
    assert_eq!(f.runs().len(), 1);
    let next = f.begin("next", "cookie-secret-next", &[uid]);
    f.cancel("cookie-secret-first").await;
    assert_dbus_error(finished(first).await, CANCELLED);
    assert_reaped(f.runs()[0].0);
    let current = f.prompt("next").await;
    assert!(current["request_id"].as_u64() > old["request_id"].as_u64());
    let last = f.begin("last", "cookie-secret-last", &[uid]);
    f.invoke(
        "host.polkit-cancel",
        json!({"request_id": current["request_id"]}),
    )
    .await
    .unwrap();
    assert_dbus_error(finished(next).await, CANCELLED);
    assert_reaped(f.runs()[1].0);
    f.prompt("last").await;
    f.cancel("cookie-secret-last").await;
    assert_dbus_error(finished(last).await, CANCELLED);
}

#[tokio::test]
async fn public_commands_are_denied_and_lock_hides_active_prompt_until_unlock() {
    let f = Fixture::new().await;
    let ((uid, _), _) = users();
    let call = f.begin("locked", "cookie-secret-lock", &[uid]);
    let prompt = f.prompt("locked").await;
    let id = &prompt["request_id"];
    let commands = [
        (
            "host.polkit-respond",
            json!({"request_id": id, "response": CORRECT}),
        ),
        (
            "host.polkit-select-identity",
            json!({"request_id": id, "uid": uid}),
        ),
        ("host.polkit-cancel", json!({"request_id": id})),
    ];
    for (name, payload) in &commands {
        let public = CallerContext {
            role: ClientRole::Public,
            ..f.host
        };
        assert_eq!(
            invoke(&f.hub, public, name, payload.clone())
                .await
                .unwrap_err()
                .code,
            ErrorCode::PermissionDenied
        );
    }
    f.service.set_locked(PolkitLockState::Locked);
    let hidden = f.until(|state| state["locked_suppressed"] == true).await;
    assert!(hidden["active"].is_null());
    for (name, payload) in &commands[..2] {
        assert_eq!(
            f.invoke(name, payload.clone()).await.unwrap_err().code,
            ErrorCode::Disabled
        );
    }
    f.service.set_locked(PolkitLockState::Unlocked);
    assert_eq!(f.prompt("locked").await, prompt);
    f.service.set_locked(PolkitLockState::Locked);
    let (cancel, payload) = &commands[2];
    f.invoke(cancel, payload.clone()).await.unwrap();
    assert_dbus_error(finished(call).await, CANCELLED);
    assert_reaped(f.runs()[0].0);
}

#[tokio::test]
async fn authority_only_and_clean_unregister_on_disable_and_shutdown() {
    let mut f = Fixture::new().await;
    let outsider = Builder::address(f.address.as_str())
        .unwrap()
        .build()
        .await
        .unwrap();
    let ((uid, _), _) = users();
    let denied = timeout(
        WAIT,
        begin(
            &outsider,
            &f.destination,
            "forged",
            "cookie-secret-forged",
            identities(&[uid]),
        ),
    )
    .await
    .unwrap();
    assert_dbus_error(denied, "org.freedesktop.PolicyKit1.Error.NotAuthorized");
    let call = f.begin("cancel", "cookie-secret-authority", &[uid]);
    f.prompt("cancel").await;
    let denied = agent(&outsider, &f.destination)
        .await
        .call::<_, _, ()>("CancelAuthentication", &("cookie-secret-authority",))
        .await;
    assert_dbus_error(denied, "org.freedesktop.PolicyKit1.Error.NotAuthorized");
    f.cancel("cookie-secret-authority").await;
    assert_dbus_error(finished(call).await, CANCELLED);

    let call = f.begin("disable", "cookie-secret-disable", &[uid]);
    f.prompt("disable").await;
    f.service.set_enabled(PolkitEnabled::Disabled);
    assert_dbus_error(finished(call).await, CANCELLED);
    let RegistrationEvent::Unregister(sender) = f.event().await else {
        panic!("expected unregister on disable");
    };
    assert_eq!(sender, f.destination);
    f.until(|state| state["enabled"] == false && state["registered"] == false)
        .await;
    assert_reaped(f.runs()[1].0);

    f.service.set_enabled(PolkitEnabled::Enabled);
    f.destination = f.registered().await;
    f.until(|state| state["registered"] == true).await;
    let active = f.begin("disconnect", "cookie-secret-disconnect", &[uid]);
    f.prompt("disconnect").await;
    f.hub.retire_client(f.host.client_id);
    assert_dbus_error(finished(active).await, CANCELLED);
    assert_reaped(f.runs()[2].0);

    let Fixture {
        registration,
        mut events,
        destination,
        _bus,
        ..
    } = f;
    registration.shutdown().await;
    let RegistrationEvent::Unregister(sender) =
        timeout(WAIT, events.recv()).await.unwrap().unwrap()
    else {
        panic!("expected unregister on shutdown");
    };
    assert_eq!(sender, destination);
}

#[tokio::test]
async fn losing_the_authority_cancels_authentication_and_reports_unavailability() {
    let mut f = Fixture::new().await;
    let ((uid, _), _) = users();
    let call = f.begin("owner-loss", "cookie-secret-owner-loss", &[uid]);
    f.prompt("owner-loss").await;
    assert!(f.authority.release_name(AUTHORITY_NAME).await.unwrap());
    assert_dbus_error(finished(call).await, CANCELLED);
    f.until(|state| {
        state["enabled"] == true
            && state["registered"] == false
            && state["last_error"].as_str().is_some()
    })
    .await;
    assert_reaped(f.runs()[0].0);
    assert!(matches!(f.event().await, RegistrationEvent::Unregister(_)));

    f.service.set_enabled(PolkitEnabled::Disabled);
    f.until(|state| state["enabled"] == false).await;
    f.service.set_enabled(PolkitEnabled::Enabled);
    f.until(|state| {
        state["enabled"] == true
            && state["registered"] == false
            && state["last_error"].as_str().is_some()
    })
    .await;
}

#[tokio::test]
async fn dropping_the_service_cancels_the_helper_and_unregisters() {
    let f = Fixture::new().await;
    let ((uid, _), _) = users();
    let call = f.begin("drop", "cookie-secret-drop", &[uid]);
    f.prompt("drop").await;
    let process = std::path::PathBuf::from(format!("/proc/{}", f.runs()[0].0));
    let Fixture {
        registration,
        service,
        mut events,
        destination,
        authority: _authority,
        _bus,
        ..
    } = f;
    drop(service);
    assert_dbus_error(finished(call).await, CANCELLED);
    let event = timeout(WAIT, events.recv()).await.unwrap().unwrap();
    assert!(matches!(event, RegistrationEvent::Unregister(sender) if sender == destination));
    timeout(WAIT, async {
        while process.exists() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("dropped service reaped its helper");
    registration.shutdown().await;
}
