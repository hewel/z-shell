use flate2::Compression;
use flate2::write::GzEncoder;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use tar::{Builder, Header};
use tempfile::tempdir;
use z_shell_bus::{BusHub, BusServer, UpdateKind};
use z_shell_protocol::{PluginId, TopicName};

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_z-shell")
}

fn run(
    args: &[&str],
    config_dir: &Path,
    state_dir: &Path,
    cache_dir: &Path,
    bus_sock: Option<&Path>,
    stdin_input: Option<&str>,
) -> Output {
    let mut cmd = Command::new(bin());
    cmd.args([
        "--config-dir",
        config_dir.to_str().unwrap(),
        "--state-dir",
        state_dir.to_str().unwrap(),
        "--cache-dir",
        cache_dir.to_str().unwrap(),
        "--json",
    ])
    .args(args)
    .env_remove("Z_SHELL_BUS_SOCKET")
    .env_remove("WAYLAND_DISPLAY");
    if let Some(sock) = bus_sock {
        cmd.env("Z_SHELL_BUS_SOCKET", sock);
    }
    if let Some(input) = stdin_input {
        cmd.stdin(Stdio::piped());
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn z-shell");
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    } else {
        cmd.stdin(Stdio::null());
        cmd.output().expect("run z-shell")
    }
}

fn parse_stdout(out: &Output) -> Value {
    let text = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(&text).unwrap_or_else(|e| {
        panic!(
            "invalid JSON stdout ({e}):\nstdout:\n{text}\nstderr:\n{}",
            String::from_utf8_lossy(&out.stderr)
        )
    })
}

fn write_tar_gz(dest: &Path, files: &[(&str, &[u8])]) -> String {
    let gz = GzEncoder::new(File::create(dest).unwrap(), Compression::default());
    let mut builder = Builder::new(gz);
    for (rel, data) in files {
        let mut header = Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, rel, *data).unwrap();
    }
    let gz = builder.into_inner().unwrap();
    gz.finish().unwrap();
    format!("sha256:{:x}", Sha256::digest(fs::read(dest).unwrap()))
}

fn content_digest_of(files: &[(&str, &[u8])]) -> String {
    let tmp = tempdir().unwrap();
    for (rel, data) in files {
        let full = tmp.path().join(rel);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, data).unwrap();
    }
    z_shell_plugins::digest::content_digest(tmp.path()).unwrap()
}

#[test]
fn rejects_host_and_socket_flags_on_plugin_subcommands() {
    let tmp = tempdir().unwrap();
    let cfg = tmp.path().join("config");
    let state = tmp.path().join("state");
    let cache = tmp.path().join("cache");

    for flag in ["--host", "--socket"] {
        let mut args = Vec::new();
        args.push(flag);
        if flag == "--socket" {
            args.push("/tmp/forbidden.sock");
        }
        args.extend(["plugin", "list"]);
        let out = run(&args, &cfg, &state, &cache, None, None);
        assert_eq!(out.status.code(), Some(2), "{flag} must exit 2");
    }
}

#[test]
fn plugin_cli_lifecycle_archive_catalog_upgrade_remove_doctor_and_public_bus_convergence() {
    let tmp = tempdir().unwrap();
    let root = tmp.path();
    let cfg = root.join("config");
    let state = root.join("state");
    let cache = root.join("cache");
    fs::create_dir_all(&cfg).unwrap();

    // 1. Archive install + safe remove --purge-settings
    let arch_svc = b"export default { setup() {} };\n";
    let arch_toml = br#"
id = "acme/arch"
name = "Archive Demo"
version = "1.0.0"
plugin_api = 1
[[service]]
id = "worker"
entry = "worker.ts"
"#;
    let arch_path = root.join("arch.tar.gz");
    let arch_sha = write_tar_gz(
        &arch_path,
        &[("plugin.toml", arch_toml), ("worker.ts", arch_svc)],
    );

    let add_arch = run(
        &[
            "plugin",
            "add",
            "--archive",
            arch_path.to_str().unwrap(),
            "--sha256",
            &arch_sha,
        ],
        &cfg,
        &state,
        &cache,
        None,
        None,
    );
    assert!(
        add_arch.status.success(),
        "add --archive failed: {}",
        String::from_utf8_lossy(&add_arch.stderr)
    );

    // Offline enable reports pending_apply when no daemon bus is running.
    let _ = run(
        &["plugin", "approve", "acme/arch"],
        &cfg,
        &state,
        &cache,
        None,
        None,
    );
    let enable_offline = run(
        &["plugin", "enable", "acme/arch"],
        &cfg,
        &state,
        &cache,
        None,
        None,
    );
    assert!(enable_offline.status.success());
    let enable_json = parse_stdout(&enable_offline);
    assert_eq!(enable_json["convergence"]["apply_status"], "pending_apply");
    assert!(enable_json["convergence"]["note"].as_str().is_some());

    // Seed plugin setting then remove with --purge-settings.
    let cfg_store = z_shell_config::ConfigStore::new(
        z_shell_config::ShellPaths::for_local_state(Some(cfg.clone()), Some(state.clone()))
            .unwrap(),
    );
    let mut patch = serde_json::Map::new();
    patch.insert("token".to_owned(), json!("secret"));
    cfg_store
        .patch_plugin_settings(&"acme/arch".parse::<PluginId>().unwrap(), &patch)
        .unwrap();

    let removed = run(
        &["plugin", "remove", "acme/arch", "--purge-settings"],
        &cfg,
        &state,
        &cache,
        None,
        None,
    );
    assert!(removed.status.success());
    let removed_json = parse_stdout(&removed);
    assert_eq!(removed_json["settings_purged"], true);
    assert!(
        !cfg_store
            .load_settings()
            .unwrap()
            .plugin_settings
            .contains_key(&"acme/arch".parse::<PluginId>().unwrap())
    );

    // 2. LocalFile catalog + install + upgrade confirmation prompt + active public-bus convergence
    let svc1 = b"export default { v: 1, setup() {} };\n";
    let svc1_sha = format!("sha256:{:x}", Sha256::digest(svc1));
    let bm1 = serde_json::to_vec(&json!({
        "schema_version": 1,
        "shared_runtime_abi": "1.0",
        "files": { "dist/entries/service.mjs": svc1_sha }
    }))
    .unwrap();
    let toml1 = br#"
id = "z-shell/store-demo"
name = "Store Demo"
version = "0.1.0"
plugin_api = 2
[build]
manifest = "dist/manifest.build.json"
shared_runtime_abi = "1.0"
[host_capabilities]
commands = ["tool-a"]
[[service]]
id = "svc"
bundle = "dist/entries/service.mjs"
"#;
    let files1 = [
        ("plugin.toml", toml1.as_slice()),
        ("dist/entries/service.mjs", svc1.as_slice()),
        ("dist/manifest.build.json", bm1.as_slice()),
    ];
    let digest1 = content_digest_of(&files1);
    let tgz1 = root.join("store-0.1.0.tar.gz");
    let tgz1_sha = write_tar_gz(&tgz1, &files1);

    let svc2 = b"export default { v: 2, setup() {} };\n";
    let svc2_sha = format!("sha256:{:x}", Sha256::digest(svc2));
    let bm2 = serde_json::to_vec(&json!({
        "schema_version": 1,
        "shared_runtime_abi": "1.0",
        "files": { "dist/entries/service.mjs": svc2_sha }
    }))
    .unwrap();
    let toml2 = br#"
id = "z-shell/store-demo"
name = "Store Demo"
version = "0.2.0"
plugin_api = 2
[build]
manifest = "dist/manifest.build.json"
shared_runtime_abi = "1.0"
[host_capabilities]
commands = ["tool-a", "tool-b"]
[[service]]
id = "svc"
bundle = "dist/entries/service.mjs"
"#;
    let files2 = [
        ("plugin.toml", toml2.as_slice()),
        ("dist/entries/service.mjs", svc2.as_slice()),
        ("dist/manifest.build.json", bm2.as_slice()),
    ];
    let digest2 = content_digest_of(&files2);
    let tgz2 = root.join("store-0.2.0.tar.gz");
    let tgz2_sha = write_tar_gz(&tgz2, &files2);

    let catalog_path = root.join("catalog-v1.json");
    let write_catalog = |latest: &str, include_v2: bool| {
        let mut releases = vec![json!({
            "version": "0.1.0",
            "plugin_api": 2,
            "shared_runtime_abi": "1.0",
            "content_digest": digest1,
            "artifact": {
                "kind": "archive",
                "url": tgz1.to_str().unwrap(),
                "archive_sha256": tgz1_sha,
                "size_bytes": fs::metadata(&tgz1).unwrap().len()
            }
        })];
        if include_v2 {
            releases.push(json!({
                "version": "0.2.0",
                "plugin_api": 2,
                "shared_runtime_abi": "1.0",
                "content_digest": digest2,
                "artifact": {
                    "kind": "archive",
                    "url": tgz2.to_str().unwrap(),
                    "archive_sha256": tgz2_sha,
                    "size_bytes": fs::metadata(&tgz2).unwrap().len()
                }
            }));
        }
        fs::write(
            &catalog_path,
            serde_json::to_vec_pretty(&json!({
                "schema_version": 1,
                "source_id": "local-test",
                "updated_at": "2026-11-25T00:00:00Z",
                "plugins": [{
                    "id": "z-shell/store-demo",
                    "name": "Store Demo",
                    "author": "z-shell",
                    "summary": "Demo store plugin",
                    "category": "system",
                    "tags": ["demo"],
                    "latest_version": latest,
                    "releases": releases
                }]
            }))
            .unwrap(),
        )
        .unwrap();
    };
    write_catalog("0.1.0", false);

    fs::write(
        cfg.join("settings.toml"),
        format!(
            r#"
[[plugins.sources]]
id = "local-test"
name = "Local Test"
kind = "local_file"
url = "{}"
enabled = true
priority = 10
"#,
            catalog_path.display()
        ),
    )
    .unwrap();

    let sources = run(
        &["plugin", "sources", "list"],
        &cfg,
        &state,
        &cache,
        None,
        None,
    );
    assert!(sources.status.success());
    let refresh = run(
        &["plugin", "sources", "refresh"],
        &cfg,
        &state,
        &cache,
        None,
        None,
    );
    assert!(refresh.status.success());

    let search = run(
        &["plugin", "search", "demo"],
        &cfg,
        &state,
        &cache,
        None,
        None,
    );
    assert!(search.status.success());
    assert_eq!(parse_stdout(&search)[0]["id"], "z-shell/store-demo");

    let info = run(
        &["plugin", "info", "z-shell/store-demo"],
        &cfg,
        &state,
        &cache,
        None,
        None,
    );
    assert!(info.status.success());

    // Reject install --enable without --approve before mutating state.
    let invalid_install = run(
        &[
            "plugin",
            "install",
            "z-shell/store-demo@0.1.0",
            "--source",
            "local-test",
            "--enable",
        ],
        &cfg,
        &state,
        &cache,
        None,
        None,
    );
    assert_eq!(invalid_install.status.code(), Some(2));

    let install = run(
        &[
            "plugin",
            "install",
            "z-shell/store-demo@0.1.0",
            "--source",
            "local-test",
            "--approve",
            "--enable",
        ],
        &cfg,
        &state,
        &cache,
        None,
        None,
    );
    assert!(
        install.status.success(),
        "install failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );

    // Publish v0.2.0 with expanded capability ["tool-b"].
    write_catalog("0.2.0", true);
    // Reject upgrade when --approve-capabilities is missing.
    let blocked_upgrade = run(
        &["plugin", "upgrade", "z-shell/store-demo", "--yes"],
        &cfg,
        &state,
        &cache,
        None,
        None,
    );
    assert!(!blocked_upgrade.status.success());

    // Prompt "n\n" aborts safely without mutating registry version.
    let declined_upgrade = run(
        &[
            "plugin",
            "upgrade",
            "z-shell/store-demo",
            "--approve-capabilities",
        ],
        &cfg,
        &state,
        &cache,
        None,
        Some("n\n"),
    );
    assert!(!declined_upgrade.status.success());

    // Start a mock public BusServer publishing `plugins` topic with applied_desired_revision so CLI sees `active`.
    let bus_sock = root.join("public-bus.sock");
    let hub = BusHub::new("test-daemon", root.join("media"));
    hub.publish_core_topic(
        TopicName::try_new("plugins").unwrap(),
        json!({
            "desired_revision": 100,
            "applied_desired_revision": 100,
            "plugins": [{
                "id": "z-shell/store-demo",
                "runtime_state": "active"
            }]
        }),
        UpdateKind::SourceBaseline,
    );
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let bind_sock = bus_sock.clone();
    let host_sock = root.join("host.sock");
    let lock_file = root.join("daemon.lock");
    let server_thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _guard = rt.enter();
        let server = BusServer::bind(bind_sock, host_sock, lock_file, hub).unwrap();
        ready_tx.send(server.shutdown_handle()).unwrap();
        let _ = rt.block_on(server.serve());
    });
    let shutdown = ready_rx.recv().unwrap();

    let accepted_upgrade = run(
        &[
            "plugin",
            "upgrade",
            "--all",
            "--approve-capabilities",
            "--yes",
        ],
        &cfg,
        &state,
        &cache,
        Some(&bus_sock),
        None,
    );
    assert!(
        accepted_upgrade.status.success(),
        "upgrade --all --yes failed: {}",
        String::from_utf8_lossy(&accepted_upgrade.stderr)
    );
    let upgrade_json = parse_stdout(&accepted_upgrade);
    assert_eq!(upgrade_json["upgraded"][0]["version"], "0.2.0");
    assert_eq!(upgrade_json["convergence"]["apply_status"], "active");
    assert_eq!(upgrade_json["convergence"]["applied_desired_revision"], 100);

    let doctor = run(&["plugin", "doctor"], &cfg, &state, &cache, None, None);
    assert!(doctor.status.success());

    shutdown.shutdown();
    let _ = server_thread.join();

    // When a live z-shelld reports runtime_overlay_supported = false and applied_desired_revision = null,
    // CLI must honestly report pending_apply with static build guidance rather than claiming active.
    let static_bus_sock = root.join("static-public-bus.sock");
    let static_hub = BusHub::new("test-static-daemon", root.join("static-media"));
    static_hub.publish_core_topic(
        TopicName::try_new("plugins").unwrap(),
        json!({
            "desired_revision": 200,
            "applied_desired_revision": null,
            "runtime_overlay_supported": false,
            "plugins": [{
                "id": "z-shell/store-demo",
                "runtime_state": "unknown"
            }]
        }),
        UpdateKind::SourceBaseline,
    );
    let (s_ready_tx, s_ready_rx) = std::sync::mpsc::channel();
    let s_bind_sock = static_bus_sock.clone();
    let s_host_sock = root.join("static-host.sock");
    let s_lock_file = root.join("static-daemon.lock");
    let s_server_thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _guard = rt.enter();
        let server = BusServer::bind(s_bind_sock, s_host_sock, s_lock_file, static_hub).unwrap();
        s_ready_tx.send(server.shutdown_handle()).unwrap();
        let _ = rt.block_on(server.serve());
    });
    let s_shutdown = s_ready_rx.recv().unwrap();

    let static_disable = run(
        &["plugin", "disable", "z-shell/store-demo"],
        &cfg,
        &state,
        &cache,
        Some(&static_bus_sock),
        None,
    );
    assert!(
        static_disable.status.success(),
        "disable failed: {}",
        String::from_utf8_lossy(&static_disable.stderr)
    );
    let disable_json = parse_stdout(&static_disable);
    assert_eq!(disable_json["convergence"]["apply_status"], "pending_apply");
    assert_eq!(
        disable_json["convergence"]["applied_desired_revision"],
        json!(null)
    );
    let note = disable_json["convergence"]["note"].as_str().unwrap();
    assert!(
        note.contains("bun run build:shell"),
        "convergence note must state rebuild is required: {note}"
    );

    s_shutdown.shutdown();
    let _ = s_server_thread.join();
}
