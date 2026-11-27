use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;
use z_shell_session::pam::{
    AuthOutcome, Authenticator, Credentials, HelperAuthenticator, MockAuthenticator,
    PamHelperAuthenticator, resolve_trusted_pam_helper_path,
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

#[tokio::test]
async fn helper_authenticator_never_searches_path_or_spawns_unverified_targets() {
    use std::os::unix::fs::PermissionsExt;

    if let Ok(marker_path) = std::env::var("Z_SHELL_TEST_FAKE_PATH_MARKER") {
        let auth = HelperAuthenticator::new("z-shell-pam-helper");
        let outcome = auth
            .authenticate(Credentials::new("alice", "cleartext-lock-secret"))
            .await;
        assert!(
            matches!(outcome, AuthOutcome::Unavailable { .. }),
            "bare helper name must fail closed as Unavailable, got {outcome:?}"
        );
        assert!(
            !std::path::Path::new(&marker_path).exists(),
            "fake z-shell-pam-helper on $PATH was executed!"
        );
        return;
    }

    let directory = tempfile::tempdir().expect("tempdir");
    let fake_helper = directory.path().join("z-shell-pam-helper");
    let marker = directory.path().join("intercepted.txt");
    std::fs::write(
        &fake_helper,
        format!(
            "#!/bin/sh\ncat > '{}'\nprintf '%s\\n' '{{\"status\":\"authenticated\"}}'\n",
            marker.display()
        ),
    )
    .expect("write fake PATH helper");
    std::fs::set_permissions(&fake_helper, std::fs::Permissions::from_mode(0o700))
        .expect("chmod fake helper");

    let current_test_bin = std::env::current_exe().expect("current test binary");
    let path_env = format!(
        "{}:{}",
        directory.path().display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let child_output = Command::new(current_test_bin)
        .args([
            "--exact",
            "helper_authenticator_never_searches_path_or_spawns_unverified_targets",
            "--nocapture",
        ])
        .env("PATH", path_env)
        .env("Z_SHELL_TEST_FAKE_PATH_MARKER", &marker)
        .output()
        .expect("run child test with poisoned PATH");
    assert!(
        child_output.status.success(),
        "child test failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&child_output.stdout),
        String::from_utf8_lossy(&child_output.stderr)
    );
    assert!(
        !marker.exists(),
        "fake helper on $PATH must never receive credentials"
    );

    let non_exec = directory.path().join("non-executable");
    std::fs::write(&non_exec, "#!/bin/sh\nexit 0\n").expect("write non-exec");
    std::fs::set_permissions(&non_exec, std::fs::Permissions::from_mode(0o600))
        .expect("chmod 0600");
    let subdir = directory.path().join("subdir");
    std::fs::create_dir(&subdir).expect("mkdir");

    for invalid_target in [
        std::path::Path::new(""),
        std::path::Path::new("./z-shell-pam-helper"),
        non_exec.as_path(),
        subdir.as_path(),
    ] {
        let outcome = PamHelperAuthenticator::new(invalid_target)
            .authenticate(Credentials::new("alice", "secret"))
            .await;
        assert!(
            matches!(outcome, AuthOutcome::Unavailable { .. }),
            "target {invalid_target:?} must return Unavailable, got {outcome:?}"
        );
        assert_eq!(resolve_trusted_pam_helper_path(Some(invalid_target)), None);
    }

    assert_eq!(
        resolve_trusted_pam_helper_path(Some(fake_helper.as_path())),
        Some(fake_helper.clone())
    );
}

#[test]
fn resolve_trusted_pam_helper_path_discovers_sibling_next_to_current_exe() {
    use std::os::unix::fs::PermissionsExt;

    if let Ok(expected) = std::env::var("Z_SHELL_TEST_EXPECTED_SIBLING") {
        let resolved = resolve_trusted_pam_helper_path(None);
        assert_eq!(
            resolved.as_deref(),
            Some(std::path::Path::new(expected.as_str()))
        );
        return;
    }

    let current_exe = std::env::current_exe().expect("current test executable");
    let target_dir = current_exe.parent().expect("deps dir");
    let sibling_dir = tempfile::tempdir_in(target_dir).expect("tempdir in target deps");
    let linked_runner = sibling_dir.path().join("runner-bin");
    std::fs::hard_link(&current_exe, &linked_runner)
        .or_else(|_| std::fs::copy(&current_exe, &linked_runner).map(|_| ()))
        .expect("stage runner binary");

    // Without a sibling binary, None is returned (assuming compile-time Z_SHELL_PAM_HELPER is unset).
    if option_env!("Z_SHELL_PAM_HELPER").is_none() {
        assert_eq!(resolve_trusted_pam_helper_path(None), None);
    }

    // Place an executable sibling `z-shell-pam-helper` next to the staged runner.
    let sibling_helper = sibling_dir.path().join("z-shell-pam-helper");
    std::fs::write(&sibling_helper, "#!/bin/sh\nexit 0\n").expect("write sibling");
    std::fs::set_permissions(&sibling_helper, std::fs::Permissions::from_mode(0o755))
        .expect("chmod sibling");

    let output = Command::new(&linked_runner)
        .args([
            "--exact",
            "resolve_trusted_pam_helper_path_discovers_sibling_next_to_current_exe",
            "--nocapture",
        ])
        .env("Z_SHELL_TEST_EXPECTED_SIBLING", &sibling_helper)
        .output()
        .expect("run staged sibling test");
    assert!(
        output.status.success(),
        "sibling discovery child failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
