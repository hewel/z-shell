use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;
use z_shell_session::pam::{
    AuthOutcome, Authenticator, Credentials, HelperAuthenticator, MockAuthenticator,
    PamHelperAuthenticator, resolve_trusted_pam_helper_path, run_pam_helper_with_pam_dirs,
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

    let hanging_script = directory.path().join("hanging-helper");
    std::fs::write(&hanging_script, "#!/bin/sh\nsleep 5\n").expect("write hanging helper");
    let mut hanging_permissions = std::fs::metadata(&hanging_script)
        .expect("hanging script metadata")
        .permissions();
    hanging_permissions.set_mode(0o700);
    std::fs::set_permissions(&hanging_script, hanging_permissions)
        .expect("executable hanging helper");
    let authenticator =
        HelperAuthenticator::with_timeout(&hanging_script, Duration::from_millis(40));
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

fn compile_fake_libpam(dir: &std::path::Path) -> std::path::PathBuf {
    let fake_pam_src = dir.join("fake_pam.rs");
    let libpam_so = dir.join("libpam.so.0");
    std::fs::write(
        &fake_pam_src,
        r#"
use std::ffi::{CStr, c_char, c_int, c_void};
use std::io::Write;

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pam_start(
    service_name: *const c_char,
    _user: *const c_char,
    _conv: *const c_void,
    pamh: *mut *mut c_void,
) -> c_int {
    if let Ok(path) = std::env::var("FAKE_PAM_SERVICE_OUT") {
        let svc = unsafe { CStr::from_ptr(service_name) }.to_string_lossy().into_owned();
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{svc}");
        }
    }
    let token = Box::into_raw(Box::new(1_u8)).cast::<c_void>();
    unsafe { *pamh = token };
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pam_authenticate(_pamh: *mut c_void, _flags: c_int) -> c_int {
    std::env::var("FAKE_PAM_CODE")
        .ok()
        .and_then(|v| v.parse::<c_int>().ok())
        .unwrap_or(7)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pam_acct_mgmt(_pamh: *mut c_void, _flags: c_int) -> c_int {
    if let Ok(path) = std::env::var("FAKE_PAM_ACCT_CALLED") {
        let _ = std::fs::write(path, "called");
    }
    7
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pam_end(pamh: *mut c_void, _status: c_int) -> c_int {
    if !pamh.is_null() {
        let _ = unsafe { Box::from_raw(pamh.cast::<u8>()) };
    }
    0
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn pam_strerror(_pamh: *mut c_void, _errnum: c_int) -> *const c_char {
    c"mock pam unavailable".as_ptr()
}
"#,
    )
    .expect("write fake_pam.rs");

    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let compile = Command::new(rustc)
        .args(["--edition=2024", "--crate-type=cdylib"])
        .arg(&fake_pam_src)
        .arg("-o")
        .arg(&libpam_so)
        .output()
        .expect("compile fake libpam.so.0");
    assert!(
        compile.status.success(),
        "rustc cdylib failed: {}",
        String::from_utf8_lossy(&compile.stderr)
    );
    libpam_so
}

#[test]
fn pam_helper_maps_denial_codes_enforces_500ms_failure_floor_and_skips_acct_mgmt() {
    use std::time::Instant;

    let dir = tempfile::tempdir().expect("tempdir for fake libpam");
    compile_fake_libpam(dir.path());

    let service_out = dir.path().join("service.txt");
    let acct_called = dir.path().join("acct_called.txt");

    let run_with_code = |code: i32| -> (AuthOutcome, Duration, Vec<String>) {
        let _ = std::fs::remove_file(&service_out);
        let started = Instant::now();
        let mut child = Command::new(helper())
            .env("LD_LIBRARY_PATH", dir.path())
            .env("FAKE_PAM_CODE", code.to_string())
            .env("FAKE_PAM_SERVICE_OUT", &service_out)
            .env("FAKE_PAM_ACCT_CALLED", &acct_called)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn helper");
        serde_json::to_writer(
            child.stdin.as_mut().expect("stdin"),
            &json!({"username": "alice", "password": "pw"}),
        )
        .expect("write json");
        drop(child.stdin.take());
        let out = child.wait_with_output().expect("wait");
        let elapsed = started.elapsed();
        let outcome: AuthOutcome = serde_json::from_slice(&out.stdout).expect("json outcome");
        let services = std::fs::read_to_string(&service_out)
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect();
        (outcome, elapsed, services)
    };

    // Success (0) returns Authenticated without artificial 500ms delay and never calls pam_acct_mgmt.
    let (ok_outcome, ok_elapsed, ok_services) = run_with_code(0);
    assert_eq!(ok_outcome, AuthOutcome::Authenticated);
    assert!(
        ok_elapsed < Duration::from_millis(450),
        "successful PAM auth must not be throttled (took {ok_elapsed:?})"
    );
    assert!(
        !acct_called.exists(),
        "pam_acct_mgmt must never be called per ADR-0004"
    );
    assert_eq!(ok_services.len(), 1);
    assert!(
        ok_services[0] == "z-shell" || ok_services[0] == "login",
        "unexpected PAM service stack: {:?}",
        ok_services
    );

    // PAM_PERM_DENIED(6), PAM_AUTH_ERR(7), PAM_CRED_INSUFFICIENT(8), PAM_USER_UNKNOWN(10), PAM_MAXTRIES(11)
    // must ALL map to AuthOutcome::Denied, enforce >= 500ms failure floor, and never retry another stack!
    for code in [6, 7, 8, 10, 11] {
        let (outcome, elapsed, services) = run_with_code(code);
        assert!(
            matches!(outcome, AuthOutcome::Denied { .. }),
            "PAM code {code} must map to AuthOutcome::Denied, got {outcome:?}"
        );
        assert!(
            elapsed >= Duration::from_millis(500),
            "failed PAM code {code} must be padded to >= 500ms, took {elapsed:?}"
        );
        assert_eq!(
            services.len(),
            1,
            "PAM helper must never retry another PAM stack after failure: {services:?}"
        );
        assert!(!acct_called.exists());
    }

    // PAM_AUTHINFO_UNAVAIL(9) stays Unavailable while still enforcing the >= 500ms failure floor.
    let (unavail_outcome, unavail_elapsed, unavail_services) = run_with_code(9);
    assert!(
        matches!(unavail_outcome, AuthOutcome::Unavailable { .. }),
        "PAM code 9 must remain Unavailable, got {unavail_outcome:?}"
    );
    assert!(
        unavail_elapsed >= Duration::from_millis(500),
        "Unavailable PAM failure must also enforce >= 500ms floor, took {unavail_elapsed:?}"
    );
    assert_eq!(unavail_services.len(), 1);
}

#[test]
fn pam_helper_probes_pam_d_z_shell_before_falling_back_to_login() {
    if std::env::var_os("Z_SHELL_TEST_PAM_PROBE_CHILD").is_some() {
        let root = tempfile::tempdir().expect("tempdir for pam.d roots");
        let etc_pam = root.path().join("etc-pam.d");
        let usr_pam = root.path().join("usr-lib-pam.d");
        let lib_pam = root.path().join("lib-pam.d");
        std::fs::create_dir_all(&etc_pam).expect("mkdir etc");
        std::fs::create_dir_all(&usr_pam).expect("mkdir usr");
        std::fs::create_dir_all(&lib_pam).expect("mkdir lib");

        let service_log = root.path().join("services.log");
        let dirs = [etc_pam.as_path(), usr_pam.as_path(), lib_pam.as_path()];

        let invoke = |code: i32| -> (AuthOutcome, Vec<String>) {
            let _ = std::fs::remove_file(&service_log);
            // SAFETY: Single-threaded child test process spawned specifically for this probe check.
            unsafe {
                std::env::set_var("FAKE_PAM_SERVICE_OUT", &service_log);
                std::env::set_var("FAKE_PAM_CODE", code.to_string());
            }
            let req = serde_json::to_vec(&json!({"username": "alice", "password": "pw"}))
                .expect("encode request");
            let mut out = Vec::new();
            run_pam_helper_with_pam_dirs(req.as_slice(), &mut out, &dirs);
            let outcome: AuthOutcome = serde_json::from_slice(&out).expect("decode outcome");
            let services = std::fs::read_to_string(&service_log)
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect();
            (outcome, services)
        };

        // 1. Neither /etc/pam.d/z-shell nor /usr/lib/pam.d/z-shell exists -> falls back to "login"
        // so pam_start never silently hits /etc/pam.d/other.
        let (outcome, services) = invoke(0);
        assert_eq!(outcome, AuthOutcome::Authenticated);
        assert_eq!(services, vec!["login"]);

        // 2. A directory named z-shell is not a readable regular PAM config file -> falls back to "login".
        std::fs::create_dir(etc_pam.join("z-shell")).expect("mkdir z-shell dir");
        let (_, services) = invoke(0);
        assert_eq!(services, vec!["login"]);
        std::fs::remove_dir(etc_pam.join("z-shell")).expect("rmdir z-shell dir");

        // 3. /usr/lib/pam.d/z-shell exists as a readable regular file -> selects "z-shell".
        std::fs::write(
            usr_pam.join("z-shell"),
            "#%PAM-1.0\nauth include system-auth\n",
        )
        .expect("write usr pam z-shell");
        let (outcome, services) = invoke(0);
        assert_eq!(outcome, AuthOutcome::Authenticated);
        assert_eq!(services, vec!["z-shell"]);

        // 4. /etc/pam.d/z-shell exists and auth fails -> calls "z-shell" once and never retries "login".
        std::fs::write(
            etc_pam.join("z-shell"),
            "#%PAM-1.0\nauth include system-auth\n",
        )
        .expect("write etc pam z-shell");
        let (outcome, services) = invoke(6);
        assert!(matches!(outcome, AuthOutcome::Denied { .. }));
        assert_eq!(services, vec!["z-shell"]);
        return;
    }

    let dir = tempfile::tempdir().expect("tempdir for fake libpam");
    compile_fake_libpam(dir.path());
    let current_test_bin = std::env::current_exe().expect("current test binary");
    let output = Command::new(current_test_bin)
        .args([
            "--exact",
            "pam_helper_probes_pam_d_z_shell_before_falling_back_to_login",
            "--nocapture",
        ])
        .env("LD_LIBRARY_PATH", dir.path())
        .env("Z_SHELL_TEST_PAM_PROBE_CHILD", "1")
        .output()
        .expect("run child PAM probe test");
    assert!(
        output.status.success(),
        "child PAM probe test failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
