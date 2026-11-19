use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;
use z_shell_session::pam::{
    AuthOutcome, Authenticator, Credentials, HelperAuthenticator, MockAuthenticator,
};

fn helper() -> &'static str {
    env!("CARGO_BIN_EXE_z-shell-pam-helper")
}

#[test]
fn standalone_helper_consumes_one_json_object_without_echoing_the_password() {
    let password = "do-not-echo-this-password-9f38e7";
    let mut child = Command::new(helper())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn PAM helper");
    serde_json::to_writer(
        child.stdin.as_mut().expect("helper stdin"),
        &json!({"username": "z-shell-nonexistent-user", "password": password}),
    )
    .expect("write credentials");
    drop(child.stdin.take());
    let output = child.wait_with_output().expect("wait for PAM helper");
    let stdout = String::from_utf8(output.stdout).expect("UTF-8 helper output");
    assert!(!stdout.contains(password), "helper echoed credentials");
    assert!(
        output.stderr.is_empty(),
        "helper wrote secrets or logs to stderr"
    );
    let outcome: AuthOutcome = serde_json::from_str(&stdout).expect("one AuthOutcome JSON value");
    assert!(matches!(
        outcome,
        AuthOutcome::Authenticated | AuthOutcome::Denied { .. } | AuthOutcome::Unavailable { .. }
    ));
}

#[test]
fn standalone_helper_reports_malformed_input_as_unavailable_json() {
    let mut child = Command::new(helper())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn PAM helper");
    child
        .stdin
        .as_mut()
        .expect("helper stdin")
        .write_all(b"{not json")
        .expect("write malformed request");
    drop(child.stdin.take());
    let output = child.wait_with_output().expect("wait for PAM helper");
    let outcome: AuthOutcome =
        serde_json::from_slice(&output.stdout).expect("malformed input still returns JSON");
    assert!(matches!(outcome, AuthOutcome::Unavailable { .. }));
}

#[tokio::test]
async fn mock_authenticator_returns_deterministic_outcomes() {
    let authenticator = MockAuthenticator::new([
        AuthOutcome::Denied {
            message: "account locked".into(),
        },
        AuthOutcome::Authenticated,
    ]);
    let first = authenticator
        .authenticate(Credentials::new("alice", "wrong"))
        .await;
    assert_eq!(
        first,
        AuthOutcome::Denied {
            message: "account locked".into()
        }
    );
    let second = authenticator
        .authenticate(Credentials::new("alice", "right"))
        .await;
    assert_eq!(second, AuthOutcome::Authenticated);
    assert_eq!(authenticator.recorded_usernames(), ["alice", "alice"]);
}

#[tokio::test]
async fn helper_authenticator_uses_private_stdio_and_bounds_helper_runtime() {
    let directory = tempfile::tempdir().expect("temporary helper directory");
    let script = directory.path().join("mock-helper");
    std::fs::write(
        &script,
        "#!/bin/sh\n[ \"$#\" -eq 0 ] || exit 9\nsecret=$(cat)\ncase \"$secret\" in *stdio-secret*) ;; *) exit 8 ;; esac\nprintf '%s\\n' '{\"status\":\"denied\",\"message\":\"locked by faillock\"}'\n",
    )
    .expect("write mock helper");
    let mut permissions = std::fs::metadata(&script)
        .expect("script metadata")
        .permissions();
    use std::os::unix::fs::PermissionsExt;
    permissions.set_mode(0o700);
    std::fs::set_permissions(&script, permissions).expect("executable helper");

    let authenticator = HelperAuthenticator::with_timeout(&script, Duration::from_secs(2));
    let outcome = authenticator
        .authenticate(Credentials::new("alice", "stdio-secret"))
        .await;
    assert_eq!(
        outcome,
        AuthOutcome::Denied {
            message: "locked by faillock".into()
        }
    );

    std::fs::write(&script, "#!/bin/sh\nsleep 5\n").expect("write hanging helper");
    let authenticator = HelperAuthenticator::with_timeout(&script, Duration::from_millis(40));
    let outcome = authenticator
        .authenticate(Credentials::new("alice", "timeout-secret"))
        .await;
    assert!(matches!(outcome, AuthOutcome::Unavailable { .. }));
}

#[test]
fn credentials_debug_and_outcome_serialization_never_expose_passwords() {
    let credentials = Credentials::new("alice", "very-secret");
    assert!(!format!("{credentials:?}").contains("very-secret"));
    let denied = serde_json::to_value(AuthOutcome::Denied {
        message: "denied".into(),
    })
    .expect("serialize outcome");
    assert_eq!(denied["status"], "denied");
    let value = serde_json::to_value(&credentials).expect("serialize credentials");
    let object: Value = value;
    assert_eq!(object["password"], "very-secret");
}
