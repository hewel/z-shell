use serde_json::Value;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use tempfile::tempdir;
use z_shell_config::ShellPaths;
use z_shell_plugins::registry::{OfflinePolicy, PluginManager};

fn manifest(root: &Path, commands: &str) {
    fs::write(
        root.join("plugin.toml"),
        format!(
            r#"id = "demo/hello"
name = "Hello"
version = "1.0.0"
plugin_api = 1
[host_capabilities]
commands = [{commands}]
[[service]]
id = "worker"
entry = "worker.ts"
title = "Worker"
[[setting]]
key = "token"
type = "string"
default = "not-for-the-bus"
secret = true
"#
        ),
    )
    .unwrap();
}

#[test]
fn path_lifecycle_pins_content_and_never_restores_revoked_approval() {
    let work = tempdir().unwrap();
    let state = tempdir().unwrap();
    let state = state.path();
    let paths = ShellPaths::from_roots(
        state.join("config"),
        state.to_owned(),
        state.join("run"),
        state.join("run/bus.sock"),
    );
    let manager = PluginManager::new(paths);
    let root = work.path();
    fs::write(root.join("worker.ts"), "export default 0").unwrap();
    manifest(root, r#""tool", "tool""#);

    let added = manager.add_path(root).unwrap();
    let id = &added.id;
    assert!(!added.enabled);
    assert!(manager.enable(id).is_err());
    let audit = manager.audit(id).unwrap();
    assert!(audit.digest_matches);
    assert!(audit.diff.requires_approval());
    assert_eq!(
        audit.diff.added.host.commands.iter().collect::<Vec<_>>(),
        &["tool"]
    );

    manager.approve(id).unwrap();
    assert!(manager.enable(id).unwrap().enabled);
    manager.disable(id).unwrap();
    assert!(
        manager.enable(id).unwrap().enabled,
        "disable preserves approval"
    );
    fs::write(root.join("worker.ts"), "export default 1").unwrap();
    assert!(!manager.audit(id).unwrap().digest_matches);
    assert!(manager.enable(id).is_err());

    manager.revoke(id).unwrap();
    let synced = manager.sync(id, OfflinePolicy::Offline).unwrap();
    assert!(!synced.enabled);
    assert!(synced.revoked);
    assert!(manager.enable(id).is_err());
    assert!(manager.audit(id).unwrap().diff.requires_approval());
    assert!(
        !serde_json::to_string(&manager.list().unwrap())
            .unwrap()
            .contains("not-for-the-bus")
    );

    let file = state.join("plugins/registry.json");
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let disk: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
    assert_eq!(disk["schema_version"], 1);
    let record = &disk["plugins"][id.as_str()];
    assert_eq!(record["source"]["root"], root.to_str().unwrap());
    assert_eq!(
        record["requested_capabilities"]["host"]["imagePrefixes"],
        serde_json::json!([])
    );
    assert_eq!(
        record["requested_capabilities"]["bus"]["topicsRead"],
        serde_json::json!([])
    );
    assert!(record["approved_capabilities"].is_null());
    assert!(record["accepted_build_id"].is_null());

    manager.approve(id).unwrap();
    assert!(manager.enable(id).unwrap().enabled);
    manifest(root, r#""tool", "other""#);
    assert!(!manager.sync(id, OfflinePolicy::Offline).unwrap().enabled);
    assert!(manager.enable(id).is_err());
    assert_eq!(
        manager
            .audit(id)
            .unwrap()
            .diff
            .added
            .host
            .commands
            .iter()
            .collect::<Vec<_>>(),
        &["other"]
    );
    manifest(root, "");
    manager.sync(id, OfflinePolicy::Offline).unwrap();
    assert!(!manager.audit(id).unwrap().diff.requires_approval());
    assert!(
        manager.enable(id).unwrap().enabled,
        "approved superset covers a reduction"
    );
}

#[test]
fn empty_capabilities_still_require_explicit_initial_approval() {
    let work = tempdir().unwrap();
    let state = tempdir().unwrap();
    let paths = ShellPaths::from_roots(
        state.path().join("config"),
        state.path().to_owned(),
        state.path().join("run"),
        state.path().join("run/bus.sock"),
    );
    fs::write(work.path().join("worker.ts"), "export default 0").unwrap();
    manifest(work.path(), "");
    let manager = PluginManager::new(paths);
    let id = manager.add_path(work.path()).unwrap().id;
    assert!(!manager.audit(&id).unwrap().diff.requires_approval());
    assert!(manager.enable(&id).is_err());
    manager.approve(&id).unwrap();
    assert!(manager.enable(&id).unwrap().enabled);
}
