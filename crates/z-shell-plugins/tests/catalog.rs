use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::thread;
use tempfile::tempdir;
use z_shell_config::{PluginSourceKind, PluginSourceSettings, ShellPaths};
use z_shell_plugins::catalog::{CatalogError, CatalogStore};
use z_shell_plugins::digest::content_digest;
use z_shell_plugins::registry::OfflinePolicy;

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn write_bundled_plugin(seed_root: &Path, plugin_dir_name: &str, version: &str) -> String {
    let dir = seed_root.join(plugin_dir_name);
    fs::create_dir_all(dir.join("dist/entries")).unwrap();
    let svc = format!("export default {{ version: {version:?}, setup() {{}} }};\n");
    let svc_sha = sha256_bytes(svc.as_bytes());
    fs::write(dir.join("dist/entries/service.mjs"), &svc).unwrap();
    fs::write(
        dir.join("dist/manifest.build.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "shared_runtime_abi": "1.0",
            "files": { "dist/entries/service.mjs": svc_sha }
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        dir.join("plugin.toml"),
        format!(
            r#"
id = "z-shell/nosleep"
name = "NoSleep"
version = "{version}"
plugin_api = 2
author = "z-shell"
description = "Keep system awake"

[store]
category = "system"
tags = ["power"]

[build]
manifest = "dist/manifest.build.json"
shared_runtime_abi = "1.0"

[[service]]
id = "service"
bundle = "dist/entries/service.mjs"
"#
        ),
    )
    .unwrap();
    content_digest(&dir).unwrap()
}

#[test]
fn bundled_official_seed_shares_official_source_identity_and_works_offline() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let seed_dir = root.join("bundled-plugins");
    let seed_digest = write_bundled_plugin(&seed_dir, "nosleep", "0.1.0");

    let paths = ShellPaths::from_roots(
        root.join("config"),
        root.join("state"),
        root.join("runtime"),
        root.join("runtime/bus.sock"),
    )
    .with_cache_dir(root.join("cache"));

    let sources = vec![PluginSourceSettings {
        id: "official".to_owned(),
        name: "z-shell Official Catalog".to_owned(),
        kind: PluginSourceKind::HttpsJson,
        url: "https://127.0.0.1:9/unreachable-catalog.json".to_owned(),
        ref_name: None,
        index_path: None,
        local_seed_dir: Some(seed_dir),
        enabled: true,
        priority: 100,
    }];

    let store = CatalogStore::new(paths);
    let results = store
        .search(&sources, "", None, None, OfflinePolicy::Offline)
        .unwrap();
    assert_eq!(results.len(), 1);
    let entry = &results[0];
    assert_eq!(entry.id.as_str(), "z-shell/nosleep");
    assert_eq!(entry.latest_version, "0.1.0");
    assert_eq!(entry.preferred_source_id, "official");

    let resolved = store
        .resolve_install(&sources, &entry.id, None, None, OfflinePolicy::Offline)
        .unwrap();
    assert_eq!(resolved.source_id, "official");
    assert_eq!(resolved.release.content_digest, seed_digest);
    assert_eq!(
        resolved.source_identity,
        "catalog:official|https://127.0.0.1:9/unreachable-catalog.json|"
    );
}

#[test]
fn multi_source_aggregates_without_shadowing_and_requires_explicit_source_on_conflict() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let official_index_body = serde_json::json!({
        "schema_version": 1,
        "source_id": "official",
        "updated_at": "2026-11-25T08:00:00Z",
        "plugins": [{
            "id": "acme/weather",
            "name": "Weather Official",
            "author": "acme",
            "summary": "Weather widget",
            "category": "widgets",
            "tags": ["weather"],
            "latest_version": "1.2.0",
            "yanked": false,
            "advisories": [],
            "releases": [{
                "version": "1.2.0",
                "plugin_api": 2,
                "shared_runtime_abi": "1.0",
                "content_digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
                "artifact": {
                    "kind": "archive",
                    "url": "https://plugins.z-shell.org/weather-1.2.0.tar.zst",
                    "archive_sha256": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
                    "size_bytes": 1024
                }
            }]
        }]
    });
    let community_index_path = root.join("community-catalog.json");
    fs::write(
        &community_index_path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": 1,
            "source_id": "community",
            "updated_at": "2026-11-25T09:00:00Z",
            "plugins": [{
                "id": "acme/weather",
                "name": "Weather Community",
                "author": "acme",
                "summary": "Weather fork",
                "category": "widgets",
                "tags": ["weather"],
                "latest_version": "2.0.0",
                "yanked": false,
                "advisories": [],
                "releases": [{
                    "version": "2.0.0",
                    "plugin_api": 2,
                    "shared_runtime_abi": "1.0",
                    "content_digest": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
                    "artifact": {
                        "kind": "archive",
                        "url": "https://community.example.invalid/weather-2.0.0.tar.zst",
                        "archive_sha256": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
                        "size_bytes": 2048
                    }
                }]
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    // Serve official index over a single-request local HTTP listener.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let payload = serde_json::to_vec(&official_index_body).unwrap();
    let server = thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut req = [0u8; 1024];
            let _ = stream.read(&mut req);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            let _ = stream.write_all(header.as_bytes());
            let _ = stream.write_all(&payload);
        }
    });

    let paths = ShellPaths::from_roots(
        root.join("config"),
        root.join("state"),
        root.join("runtime"),
        root.join("runtime/bus.sock"),
    )
    .with_cache_dir(root.join("cache"));
    let sources = vec![
        PluginSourceSettings {
            id: "community".to_owned(),
            name: "Community".to_owned(),
            kind: PluginSourceKind::LocalFile,
            url: community_index_path.to_string_lossy().into_owned(),
            ref_name: None,
            index_path: None,
            local_seed_dir: None,
            enabled: true,
            priority: 50,
        },
        PluginSourceSettings {
            id: "official".to_owned(),
            name: "Official".to_owned(),
            kind: PluginSourceKind::HttpsJson,
            url: format!("http://{addr}/catalog-v1.json"),
            ref_name: None,
            index_path: None,
            local_seed_dir: None,
            enabled: true,
            priority: 100,
        },
    ];

    let store = CatalogStore::new(paths);
    let refreshed = store.refresh(&sources, OfflinePolicy::Online).unwrap();
    server.join().unwrap();
    assert_eq!(refreshed.len(), 2);
    assert!(refreshed.iter().all(|r| !r.stale));

    // Offline refresh must hit local cache with zero HTTP calls and report stale: true.
    let offline_refresh = store.refresh(&sources, OfflinePolicy::Offline).unwrap();
    assert!(
        offline_refresh
            .iter()
            .any(|r| r.source_id == "official" && r.cached && r.stale)
    );

    // Search aggregates both offerings into one card while preserving all source choices.
    let found = store
        .search(&sources, "weather", None, None, OfflinePolicy::Offline)
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].preferred_source_id, "community");
    assert_eq!(found[0].available_sources.len(), 2);

    // Ambiguous install without --source must fail rather than silently pick priority 50 over official.
    let id = "acme/weather".parse().unwrap();
    let err = store
        .resolve_install(&sources, &id, None, None, OfflinePolicy::Offline)
        .unwrap_err();
    assert!(matches!(err, CatalogError::AmbiguousPluginSource { .. }));

    let explicit = store
        .resolve_install(
            &sources,
            &id,
            None,
            Some("official"),
            OfflinePolicy::Offline,
        )
        .unwrap();
    assert_eq!(explicit.source_id, "official");
    assert_eq!(explicit.release.version, "1.2.0");
}
