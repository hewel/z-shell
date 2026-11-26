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
    assert_eq!(disk["schema_version"], 2);
    assert!(disk["desired_revision"].as_u64().unwrap() >= 1);
    let record = &disk["plugins"][id.as_str()];
    assert!(record.get("quarantine").is_none());
    assert!(record.get("accepted_build_id").is_none());
    assert_eq!(record["source"]["root"], root.to_str().unwrap());
    assert!(
        record["source"]["bundle_path"]
            .as_str()
            .unwrap()
            .contains("/plugins/bundles/demo__hello/")
    );
    assert_eq!(
        record["requested_capabilities"]["host"]["imagePrefixes"],
        serde_json::json!([])
    );
    assert_eq!(
        record["requested_capabilities"]["bus"]["topicsRead"],
        serde_json::json!([])
    );
    assert!(record["approval"].is_null());

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

#[test]
fn v1_to_v2_migration_never_escalates_privileges_and_preserves_local_source() {
    let work = tempdir().unwrap();
    let state = tempdir().unwrap();
    let state_path = state.path();
    let src_dir = work.path().join("legacy-plugin");
    fs::create_dir_all(&src_dir).unwrap();
    fs::write(src_dir.join("worker.ts"), "export default 0").unwrap();
    manifest(&src_dir, r#""legacy-tool""#);
    let digest = z_shell_plugins::digest::content_digest(&src_dir).unwrap();

    let plugins_dir = state_path.join("plugins");
    fs::create_dir_all(&plugins_dir).unwrap();
    let legacy = serde_json::json!({
        "schema_version": 1,
        "plugins": {
            "demo/hello": {
                "id": "demo/hello",
                "name": "Hello",
                "version": "1.0.0",
                "plugin_api": 1,
                "source": { "kind": "path", "root": src_dir },
                "content_digest": digest,
                "enabled": true,
                "revoked": false,
                "requested_capabilities": {
                    "host": {
                        "commands": ["legacy-tool"],
                        "imagePrefixes": [],
                        "unixSockets": [],
                        "namedSockets": [],
                        "shellSurfaces": false,
                        "controlChannel": false
                    },
                    "bus": {
                        "topicsRead": [],
                        "topicsPublish": [],
                        "commandsRegister": [],
                        "inhibitors": false
                    }
                },
                "approved_capabilities": {
                    "host": {
                        "commands": ["legacy-tool"],
                        "imagePrefixes": [],
                        "unixSockets": [],
                        "namedSockets": [],
                        "shellSurfaces": false,
                        "controlChannel": false
                    },
                    "bus": {
                        "topicsRead": [],
                        "topicsPublish": [],
                        "commandsRegister": [],
                        "inhibitors": false
                    }
                },
                "accepted_build_id": "legacy-build"
            }
        }
    });
    fs::write(
        plugins_dir.join("registry.json"),
        serde_json::to_vec_pretty(&legacy).unwrap(),
    )
    .unwrap();

    let paths = ShellPaths::from_roots(
        state_path.join("config"),
        state_path.to_owned(),
        state_path.join("run"),
        state_path.join("run/bus.sock"),
    );
    let manager = PluginManager::new(paths);
    let list = manager.list().unwrap();
    assert_eq!(list.len(), 1);
    let item = &list[0];
    assert!(
        !item.enabled,
        "v1 enabled plugin must be disabled on v2 migration"
    );
    assert!(
        !item.approved,
        "v1 approval must not silently carry over to v2"
    );
    assert!(item.migration_reapproval_required);
    assert!(plugins_dir.join("registry.v1.bak.json").is_file());
    assert!(src_dir.join("worker.ts").is_file());
    assert!(manager.enable(&item.id).is_err());

    let doctor = manager.doctor().unwrap();
    assert!(
        doctor
            .iter()
            .any(|f| f.code == "migration_reapproval_required")
    );
}

#[test]
fn cross_source_conflict_safe_remove_bundled_upgrade_offline_cache_and_toctou_upgrade() {
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeSet;
    use std::fs::File;
    use tar::{Builder, Header};
    use z_shell_config::{ConfigStore, PluginSourceKind, PluginSourceSettings};
    use z_shell_plugins::StoreCategory;
    use z_shell_plugins::catalog::{CatalogStore, catalog_cache_paths};
    use z_shell_plugins::registry::{
        PluginError, RemoveSettingsPolicy, ResolvedFrom, UpgradeApprovalMode,
    };

    let work = tempdir().unwrap();
    let root = work.path();
    let paths = ShellPaths::from_roots(
        root.join("config"),
        root.join("state"),
        root.join("run"),
        root.join("run/bus.sock"),
    )
    .with_cache_dir(root.join("cache"));

    // Prepare official bundled local seed v0.1.0 for z-shell/sample-keep
    let seed_dir = root.join("bundled-plugins");
    let nosleep_v1 = seed_dir.join("sample-keep");
    fs::create_dir_all(nosleep_v1.join("dist/entries")).unwrap();
    let svc1 = b"export default { v: 1, setup() {} };\n";
    let svc1_sha = format!("sha256:{:x}", Sha256::digest(svc1));
    fs::write(nosleep_v1.join("dist/entries/service.mjs"), svc1).unwrap();
    fs::write(
        nosleep_v1.join("dist/manifest.build.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "shared_runtime_abi": "1.0",
            "files": { "dist/entries/service.mjs": svc1_sha }
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        nosleep_v1.join("plugin.toml"),
        r#"
id = "z-shell/sample-keep"
name = "SampleKeep"
version = "0.1.0"
plugin_api = 2
[build]
manifest = "dist/manifest.build.json"
shared_runtime_abi = "1.0"
[host_capabilities]
commands = ["caffeinate"]
[[service]]
id = "service"
bundle = "dist/entries/service.mjs"
"#,
    )
    .unwrap();

    let sources = vec![PluginSourceSettings {
        id: "official".to_owned(),
        name: "Official".to_owned(),
        kind: PluginSourceKind::HttpsJson,
        url: "https://plugins.z-shell.org/catalog-v1.json".to_owned(),
        ref_name: None,
        index_path: None,
        local_seed_dir: Some(seed_dir.clone()),
        enabled: true,
        priority: 100,
    }];

    let catalog = CatalogStore::new(paths.clone());
    let manager = PluginManager::new(paths.clone());
    let resolved_seed = catalog
        .resolve_install(
            &sources,
            &"z-shell/sample-keep".parse().unwrap(),
            None,
            Some("official"),
            OfflinePolicy::Offline,
        )
        .unwrap();

    let outcome = manager
        .install_from_catalog(&resolved_seed, OfflinePolicy::Offline)
        .unwrap();
    assert_eq!(outcome.resolved_from, ResolvedFrom::BundledOfficialSeed);
    let nosleep_id = outcome.summary.id.clone();
    manager.approve(&nosleep_id).unwrap();
    manager.enable(&nosleep_id).unwrap();

    // Cross-source takeover with same PluginId via --path must hard-fail with SourceConflict.
    let rogue_path = root.join("rogue-nosleep");
    fs::create_dir_all(&rogue_path).unwrap();
    fs::write(rogue_path.join("worker.ts"), "export default 1").unwrap();
    manifest(&rogue_path, "");
    fs::write(
        rogue_path.join("plugin.toml"),
        fs::read_to_string(rogue_path.join("plugin.toml"))
            .unwrap()
            .replace("demo/hello", "z-shell/sample-keep"),
    )
    .unwrap();
    let err = manager.add_path(&rogue_path).unwrap_err();
    assert!(matches!(err, PluginError::SourceConflict { .. }));

    // Build online official v0.2.0 archive (same source_identity, NO capability expansion).
    let v2_stage = root.join("v2-stage");
    fs::create_dir_all(v2_stage.join("dist/entries")).unwrap();
    let svc2 = b"export default { v: 2, setup() {} };\n";
    let svc2_sha = format!("sha256:{:x}", Sha256::digest(svc2));
    let bm2 = serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": 1,
        "shared_runtime_abi": "1.0",
        "files": { "dist/entries/service.mjs": svc2_sha }
    }))
    .unwrap();
    let toml2 = br#"
id = "z-shell/sample-keep"
name = "SampleKeep"
version = "0.2.0"
plugin_api = 2
[build]
manifest = "dist/manifest.build.json"
shared_runtime_abi = "1.0"
[host_capabilities]
commands = ["caffeinate"]
[[service]]
id = "service"
bundle = "dist/entries/service.mjs"
"#;
    fs::write(v2_stage.join("dist/entries/service.mjs"), svc2).unwrap();
    fs::write(v2_stage.join("dist/manifest.build.json"), &bm2).unwrap();
    fs::write(v2_stage.join("plugin.toml"), toml2).unwrap();
    let v2_content_digest = z_shell_plugins::digest::content_digest(&v2_stage).unwrap();

    let tgz2_path = root.join("nosleep-0.2.0.tar.gz");
    {
        let gz = GzEncoder::new(File::create(&tgz2_path).unwrap(), Compression::default());
        let mut builder = Builder::new(gz);
        for (rel, data) in [
            ("plugin.toml", toml2.as_slice()),
            ("dist/entries/service.mjs", svc2.as_slice()),
            ("dist/manifest.build.json", bm2.as_slice()),
        ] {
            let mut h = Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            builder.append_data(&mut h, rel, data).unwrap();
        }
        builder.finish().unwrap();
    }
    let tgz2_sha = format!("sha256:{:x}", Sha256::digest(fs::read(&tgz2_path).unwrap()));
    let _category_check: StoreCategory = StoreCategory::System;

    // Populate the official catalog cache on disk so CatalogStore::resolve_install produces v0.2.0.
    let cat_cache = paths.plugin_catalog_cache_dir();
    fs::create_dir_all(&cat_cache).unwrap();
    let official_cache_path = catalog_cache_paths(&paths, &sources[0]).0;
    fs::write(
        &official_cache_path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "source_id": "official",
            "updated_at": "2026-11-25T00:00:00Z",
            "plugins": [{
                "id": "z-shell/sample-keep",
                "name": "NoSleep",
                "author": "z-shell",
                "summary": "Keep display awake",
                "category": "system",
                "tags": [],
                "latest_version": "0.2.0",
                "releases": [{
                    "version": "0.2.0",
                    "plugin_api": 2,
                    "shared_runtime_abi": "1.0",
                    "content_digest": v2_content_digest,
                    "artifact": {
                        "kind": "archive",
                        "url": tgz2_path.to_string_lossy(),
                        "archive_sha256": tgz2_sha,
                        "size_bytes": fs::metadata(&tgz2_path).unwrap().len()
                    }
                }]
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let resolved_v2 = catalog
        .resolve_install(
            &sources,
            &nosleep_id,
            Some("0.2.0"),
            Some("official"),
            OfflinePolicy::Online,
        )
        .unwrap();

    let staged = manager
        .stage_upgrade(&nosleep_id, &resolved_v2, OfflinePolicy::Online)
        .unwrap();
    assert!(!staged.requires_reapproval);
    // TOCTOU mismatch rejected
    assert!(matches!(
        manager.commit_upgrade(
            &staged,
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            &staged.to_digest,
            UpgradeApprovalMode::KeepExistingOnly,
        ),
        Err(PluginError::ToctouMismatch)
    ));
    let upgraded = manager
        .commit_upgrade(
            &staged,
            &staged.from_digest,
            &staged.to_digest,
            UpgradeApprovalMode::KeepExistingOnly,
        )
        .unwrap();
    assert_eq!(upgraded.version, "0.2.0");
    assert!(upgraded.enabled);

    // Offline local verified bundle cache hit after remove (when bundle already exists on disk),
    // and OfflineModeBlocked when bundle is absent for a remote URL.
    manager
        .remove(&nosleep_id, RemoveSettingsPolicy::KeepSettings)
        .unwrap();
    let remote_sources = vec![PluginSourceSettings {
        id: "remote-test".to_owned(),
        name: "Remote Test".to_owned(),
        kind: PluginSourceKind::HttpsJson,
        url: "https://plugins.z-shell.org/remote-test.json".to_owned(),
        ref_name: None,
        index_path: None,
        local_seed_dir: None,
        enabled: true,
        priority: 200,
    }];
    fs::write(
        catalog_cache_paths(&paths, &remote_sources[0]).0,
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "source_id": "remote-test",
            "updated_at": "2026-11-25T00:00:00Z",
            "plugins": [{
                "id": "z-shell/sample-keep",
                "name": "NoSleep",
                "author": "z-shell",
                "summary": "Keep display awake",
                "category": "system",
                "tags": [],
                "latest_version": "0.3.0",
                "releases": [{
                    "version": "0.3.0",
                    "plugin_api": 2,
                    "shared_runtime_abi": "1.0",
                    "content_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "artifact": {
                        "kind": "archive",
                        "url": "https://plugins.z-shell.org/missing.tar.gz",
                        "archive_sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        "size_bytes": 100
                    }
                }]
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let remote_missing = catalog
        .resolve_install(
            &remote_sources,
            &nosleep_id,
            Some("0.3.0"),
            Some("remote-test"),
            OfflinePolicy::Offline,
        )
        .unwrap();
    assert!(matches!(
        manager.install_from_catalog(&remote_missing, OfflinePolicy::Offline),
        Err(PluginError::OfflineModeBlocked)
    ));

    // Re-install v0.2.0 via remote URL in offline mode when its staged bundle is cached on disk:
    // re-stage v0.2.0? No, v0.1.0 was cleaned up by commit_upgrade, so install v0.1.0 seed first,
    // pre-stage v0.2.0 into bundles_dir, remove v0.1.0, and verify offline remote install of v0.2.0
    // hits LocalVerifiedCache!
    let old_v1_bundle = z_shell_plugins::bundle::bundle_dir_for(
        &paths.plugins_bundles_dir(),
        &nosleep_id,
        &outcome.summary.content_digest,
    );
    assert!(
        !old_v1_bundle.exists(),
        "commit_upgrade must clean up replaced unreferenced bundle"
    );

    let reseed = manager
        .install_from_catalog(&resolved_seed, OfflinePolicy::Offline)
        .unwrap();
    assert_eq!(reseed.resolved_from, ResolvedFrom::BundledOfficialSeed);
    fs::write(
        &official_cache_path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "source_id": "official",
            "updated_at": "2026-11-25T00:00:00Z",
            "plugins": [{
                "id": "z-shell/sample-keep",
                "name": "NoSleep",
                "author": "z-shell",
                "summary": "Keep display awake",
                "category": "system",
                "tags": [],
                "latest_version": "0.2.0",
                "releases": [{
                    "version": "0.2.0",
                    "plugin_api": 2,
                    "shared_runtime_abi": "1.0",
                    "content_digest": v2_content_digest,
                    "artifact": {
                        "kind": "archive",
                        "url": tgz2_path.to_string_lossy(),
                        "archive_sha256": tgz2_sha,
                        "size_bytes": fs::metadata(&tgz2_path).unwrap().len()
                    }
                }]
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let v2_for_cache = catalog
        .resolve_install(
            &sources,
            &nosleep_id,
            Some("0.2.0"),
            Some("official"),
            OfflinePolicy::Online,
        )
        .unwrap();
    let _pre_staged_v2 = manager
        .stage_upgrade(&nosleep_id, &v2_for_cache, OfflinePolicy::Online)
        .unwrap();
    manager
        .remove(&nosleep_id, RemoveSettingsPolicy::KeepSettings)
        .unwrap();

    fs::write(
        &official_cache_path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "source_id": "official",
            "updated_at": "2026-11-25T00:00:00Z",
            "plugins": [{
                "id": "z-shell/sample-keep",
                "name": "NoSleep",
                "author": "z-shell",
                "summary": "Keep display awake",
                "category": "system",
                "tags": [],
                "latest_version": "0.2.0",
                "releases": [{
                    "version": "0.2.0",
                    "plugin_api": 2,
                    "shared_runtime_abi": "1.0",
                    "content_digest": v2_content_digest,
                    "artifact": {
                        "kind": "archive",
                        "url": "https://plugins.z-shell.org/cached-0.2.0.tar.gz",
                        "archive_sha256": tgz2_sha,
                        "size_bytes": fs::metadata(&tgz2_path).unwrap().len()
                    }
                }]
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let cached_remote = catalog
        .resolve_install(
            &sources,
            &nosleep_id,
            Some("0.2.0"),
            Some("official"),
            OfflinePolicy::Offline,
        )
        .unwrap();
    let cached_hit = manager
        .install_from_catalog(&cached_remote, OfflinePolicy::Offline)
        .unwrap();
    assert_eq!(cached_hit.resolved_from, ResolvedFrom::LocalVerifiedCache);
    manager.approve(&nosleep_id).unwrap();
    manager.enable(&nosleep_id).unwrap();

    // Test capability-expanding upgrade rejection under KeepExistingOnly vs success under ApproveExpanded.
    let v3_stage = root.join("v3-stage");
    fs::create_dir_all(v3_stage.join("dist/entries")).unwrap();
    let svc3 = b"export default { v: 3, setup() {} };\n";
    let svc3_sha = format!("sha256:{:x}", Sha256::digest(svc3));
    let bm3 = serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": 1,
        "shared_runtime_abi": "1.0",
        "files": { "dist/entries/service.mjs": svc3_sha }
    }))
    .unwrap();
    let toml3 = br#"
id = "z-shell/sample-keep"
name = "SampleKeep"
version = "0.3.0"
plugin_api = 2
[build]
manifest = "dist/manifest.build.json"
shared_runtime_abi = "1.0"
[host_capabilities]
commands = ["caffeinate", "systemd-inhibit"]
[[service]]
id = "service"
bundle = "dist/entries/service.mjs"
"#;
    fs::write(v3_stage.join("dist/entries/service.mjs"), svc3).unwrap();
    fs::write(v3_stage.join("dist/manifest.build.json"), &bm3).unwrap();
    fs::write(v3_stage.join("plugin.toml"), toml3).unwrap();
    let v3_content_digest = z_shell_plugins::digest::content_digest(&v3_stage).unwrap();
    let tgz3_path = root.join("nosleep-0.3.0.tar.gz");
    {
        let gz = GzEncoder::new(File::create(&tgz3_path).unwrap(), Compression::default());
        let mut builder = Builder::new(gz);
        for (rel, data) in [
            ("plugin.toml", toml3.as_slice()),
            ("dist/entries/service.mjs", svc3.as_slice()),
            ("dist/manifest.build.json", bm3.as_slice()),
        ] {
            let mut h = Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            builder.append_data(&mut h, rel, data).unwrap();
        }
        builder.finish().unwrap();
    }
    let tgz3_sha = format!("sha256:{:x}", Sha256::digest(fs::read(&tgz3_path).unwrap()));
    fs::write(
        &official_cache_path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "source_id": "official",
            "updated_at": "2026-11-25T00:00:00Z",
            "plugins": [{
                "id": "z-shell/sample-keep",
                "name": "NoSleep",
                "author": "z-shell",
                "summary": "Keep display awake",
                "category": "system",
                "tags": [],
                "latest_version": "0.3.0",
                "releases": [{
                    "version": "0.3.0",
                    "plugin_api": 2,
                    "shared_runtime_abi": "1.0",
                    "content_digest": v3_content_digest,
                    "artifact": {
                        "kind": "archive",
                        "url": tgz3_path.to_string_lossy(),
                        "archive_sha256": tgz3_sha,
                        "size_bytes": fs::metadata(&tgz3_path).unwrap().len()
                    }
                }]
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let resolved_v3 = catalog
        .resolve_install(
            &sources,
            &nosleep_id,
            Some("0.3.0"),
            Some("official"),
            OfflinePolicy::Online,
        )
        .unwrap();
    let staged_v3 = manager
        .stage_upgrade(&nosleep_id, &resolved_v3, OfflinePolicy::Online)
        .unwrap();
    assert!(staged_v3.requires_reapproval);
    assert!(matches!(
        manager.commit_upgrade(
            &staged_v3,
            &staged_v3.from_digest,
            &staged_v3.to_digest,
            UpgradeApprovalMode::KeepExistingOnly,
        ),
        Err(PluginError::CapabilityExpansionRequiresApproval(_))
    ));
    let upgraded_v3 = manager
        .commit_upgrade(
            &staged_v3,
            &staged_v3.from_digest,
            &staged_v3.to_digest,
            UpgradeApprovalMode::ApproveExpanded,
        )
        .unwrap();
    assert_eq!(upgraded_v3.version, "0.3.0");
    assert!(upgraded_v3.approved);
    assert!(upgraded_v3.enabled);

    // Safe remove for --path plugin never deletes user source dir and honors PurgeSettings.
    let dev_src = root.join("dev-plugin");
    fs::create_dir_all(&dev_src).unwrap();
    fs::write(dev_src.join("worker.ts"), "export default 0").unwrap();
    manifest(&dev_src, r#""dev-cmd""#);
    let dev_summary = manager.add_path(&dev_src).unwrap();
    let cfg_store = ConfigStore::new(paths.clone());
    let mut patch = serde_json::Map::new();
    patch.insert("token".to_owned(), serde_json::json!("dev-secret"));
    cfg_store
        .patch_plugin_settings(&dev_summary.id, &patch)
        .unwrap();
    assert!(
        cfg_store
            .load_settings()
            .unwrap()
            .plugin_settings
            .contains_key(&dev_summary.id)
    );

    // Check net_added_host_capabilities in audit when another plugin already covers a command.
    let audit = manager.audit(&dev_summary.id).unwrap();
    assert_eq!(
        audit.net_added_host_capabilities.commands,
        BTreeSet::from(["dev-cmd".to_owned()])
    );

    manager
        .remove(&dev_summary.id, RemoveSettingsPolicy::PurgeSettings)
        .unwrap();
    assert!(
        dev_src.join("worker.ts").is_file(),
        "--path remove must never delete user source"
    );
    assert!(
        !cfg_store
            .load_settings()
            .unwrap()
            .plugin_settings
            .contains_key(&dev_summary.id)
    );
}

#[test]
fn revocation_between_preview_and_confirmation_fails_without_mutating_registry_and_redacts_paths() {
    let work = tempdir().unwrap();
    let state = tempdir().unwrap();
    let root = work.path();
    let paths = ShellPaths::from_roots(
        state.path().join("config"),
        state.path().to_owned(),
        state.path().join("run"),
        state.path().join("run/bus.sock"),
    )
    .with_cache_dir(state.path().join("cache"));
    let manager = PluginManager::new(paths.clone());

    let local_dir = root.join("secret-local-plugin");
    fs::create_dir_all(&local_dir).unwrap();
    fs::write(local_dir.join("worker.ts"), "export default 0").unwrap();
    manifest(&local_dir, r#""local-tool""#);

    let staged = manager.stage_install_path(&local_dir).unwrap();
    let outcome = manager
        .commit_install(
            &staged,
            &staged.source_identity,
            &staged.content_digest,
            &staged.requested_capabilities,
            false,
        )
        .unwrap();
    let redacted = outcome.summary.redacted_for_public();
    assert!(
        !redacted.source_identity.contains("secret-local-plugin"),
        "public summary must redact raw filesystem path: {}",
        redacted.source_identity
    );

    let (preview_summary, preview_caps) = manager.plugin_capabilities(&outcome.summary.id).unwrap();
    manager.revoke(&outcome.summary.id).unwrap();
    let reg_before = fs::read(paths.plugins_registry_file()).unwrap();

    // Concurrent revocation before approve_reviewed must fail cleanly without mutating registry.json.
    let err = manager
        .approve_reviewed(
            &preview_summary.id,
            &preview_summary.source_identity,
            &preview_summary.content_digest,
            &preview_caps,
            false,
        )
        .unwrap_err();
    assert!(matches!(
        err,
        z_shell_plugins::registry::PluginError::Revoked(_)
    ));
    assert_eq!(fs::read(paths.plugins_registry_file()).unwrap(), reg_before);

    // Concurrent revocation between stage_upgrade and commit_upgrade must also fail without mutating registry.json.
    let seed_dir = root.join("seed");
    fs::create_dir_all(seed_dir.join("demo/dist/entries")).unwrap();
    let svc1 = b"export default { v: 1, setup() {} };\n";
    let svc1_sha = format!("sha256:{:x}", <sha2::Sha256 as sha2::Digest>::digest(svc1));
    fs::write(seed_dir.join("demo/dist/entries/service.mjs"), svc1).unwrap();
    fs::write(
        seed_dir.join("demo/dist/manifest.build.json"),
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 1,
            "shared_runtime_abi": "1.0",
            "files": { "dist/entries/service.mjs": svc1_sha }
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        seed_dir.join("demo/plugin.toml"),
        r#"
id = "acme/demo"
name = "Demo"
version = "0.1.0"
plugin_api = 2
[build]
manifest = "dist/manifest.build.json"
shared_runtime_abi = "1.0"
[[service]]
id = "service"
bundle = "dist/entries/service.mjs"
"#,
    )
    .unwrap();

    let v2_dir = root.join("v2");
    fs::create_dir_all(v2_dir.join("dist/entries")).unwrap();
    let svc2 = b"export default { v: 2, setup() {} };\n";
    let svc2_sha = format!("sha256:{:x}", <sha2::Sha256 as sha2::Digest>::digest(svc2));
    let bm2 = serde_json::to_vec(&serde_json::json!({
        "schema_version": 1,
        "shared_runtime_abi": "1.0",
        "files": { "dist/entries/service.mjs": svc2_sha }
    }))
    .unwrap();
    let toml2 = br#"
id = "acme/demo"
name = "Demo"
version = "0.2.0"
plugin_api = 2
[build]
manifest = "dist/manifest.build.json"
shared_runtime_abi = "1.0"
[[service]]
id = "service"
bundle = "dist/entries/service.mjs"
"#;
    fs::write(v2_dir.join("dist/entries/service.mjs"), svc2).unwrap();
    fs::write(v2_dir.join("dist/manifest.build.json"), &bm2).unwrap();
    fs::write(v2_dir.join("plugin.toml"), toml2).unwrap();
    let v2_digest = z_shell_plugins::digest::content_digest(&v2_dir).unwrap();

    let tgz2 = root.join("demo-0.2.0.tar.gz");
    {
        let gz = flate2::write::GzEncoder::new(
            fs::File::create(&tgz2).unwrap(),
            flate2::Compression::default(),
        );
        let mut builder = tar::Builder::new(gz);
        for (rel, data) in [
            ("plugin.toml", toml2.as_slice()),
            ("dist/entries/service.mjs", svc2.as_slice()),
            ("dist/manifest.build.json", bm2.as_slice()),
        ] {
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            builder.append_data(&mut h, rel, data).unwrap();
        }
        builder.finish().unwrap();
    }
    let tgz2_sha = format!(
        "sha256:{:x}",
        <sha2::Sha256 as sha2::Digest>::digest(fs::read(&tgz2).unwrap())
    );

    let index_path = root.join("catalog-v1.json");
    fs::write(
        &index_path,
        serde_json::to_vec(&serde_json::json!({
            "schema_version": 1,
            "source_id": "official",
            "updated_at": "2026-11-26T00:00:00Z",
            "plugins": [{
                "id": "acme/demo",
                "name": "Demo",
                "author": "acme",
                "summary": "Demo",
                "category": "system",
                "tags": [],
                "latest_version": "0.2.0",
                "releases": [{
                    "version": "0.2.0",
                    "plugin_api": 2,
                    "shared_runtime_abi": "1.0",
                    "content_digest": v2_digest,
                    "artifact": {
                        "kind": "archive",
                        "url": tgz2.to_string_lossy(),
                        "archive_sha256": tgz2_sha,
                        "size_bytes": fs::metadata(&tgz2).unwrap().len()
                    }
                }]
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    let sources = vec![z_shell_config::PluginSourceSettings {
        id: "official".to_owned(),
        name: "Official".to_owned(),
        kind: z_shell_config::PluginSourceKind::LocalFile,
        url: index_path.to_string_lossy().into_owned(),
        ref_name: None,
        index_path: None,
        local_seed_dir: Some(seed_dir),
        enabled: true,
        priority: 100,
    }];
    let catalog = z_shell_plugins::catalog::CatalogStore::new(paths.clone());
    let rel_v1 = catalog
        .resolve_install(
            &sources,
            &"acme/demo".parse().unwrap(),
            Some("0.1.0"),
            Some("official"),
            OfflinePolicy::Offline,
        )
        .unwrap();
    manager
        .install_from_catalog(&rel_v1, OfflinePolicy::Offline)
        .unwrap();
    manager.approve(&"acme/demo".parse().unwrap()).unwrap();

    let rel_v2 = catalog
        .resolve_install(
            &sources,
            &"acme/demo".parse().unwrap(),
            Some("0.2.0"),
            Some("official"),
            OfflinePolicy::Offline,
        )
        .unwrap();
    let staged_upgrade = manager
        .stage_upgrade(
            &"acme/demo".parse().unwrap(),
            &rel_v2,
            OfflinePolicy::Offline,
        )
        .unwrap();

    // Concurrent revocation after staging!
    manager.revoke(&"acme/demo".parse().unwrap()).unwrap();
    let reg_after_revoke = fs::read(paths.plugins_registry_file()).unwrap();
    let upgrade_err = manager
        .commit_upgrade_reviewed(
            &staged_upgrade,
            &staged_upgrade.from_digest,
            &staged_upgrade.to_digest,
            staged_upgrade.requested_capabilities(),
            z_shell_plugins::registry::UpgradeApprovalMode::ApproveExpanded,
            true,
        )
        .unwrap_err();
    assert!(matches!(
        upgrade_err,
        z_shell_plugins::registry::PluginError::Revoked(_)
    ));
    assert_eq!(
        fs::read(paths.plugins_registry_file()).unwrap(),
        reg_after_revoke
    );

    // Missing Source::Path root is cleanly reported by doctor() without panicking.
    fs::remove_dir_all(&local_dir).unwrap();
    let findings = manager.doctor().unwrap();
    assert!(findings.iter().any(|f| f.code == "path_source_unreadable"));
    let redacted_finding = findings
        .iter()
        .find(|f| f.code == "path_source_unreadable")
        .unwrap()
        .redacted_for_public();
    assert!(!redacted_finding.message.contains("secret-local-plugin"));
}
