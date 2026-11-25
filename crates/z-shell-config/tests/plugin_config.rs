use std::collections::BTreeMap;
use std::path::PathBuf;
use tempfile::tempdir;
use z_shell_config::{
    BarPluginInstance, BarPluginSlot, PluginSourceKind, ShellPaths, UserSettings,
};

#[test]
fn shell_paths_resolve_bundle_overlay_runtime_and_cache_dirs() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let paths = ShellPaths::from_roots(
        root.join("config"),
        root.join("state"),
        root.join("runtime"),
        root.join("runtime/bus.sock"),
    )
    .with_display("wayland-2")
    .with_cache_dir(root.join("cache"));

    assert_eq!(paths.display(), "wayland-2");
    assert_eq!(paths.cache_dir(), root.join("cache"));
    assert_eq!(
        paths.plugins_bundles_dir(),
        root.join("state/plugins/bundles")
    );
    assert_eq!(
        paths.plugins_staging_dir(),
        root.join("state/plugins/staging")
    );
    assert_eq!(
        paths.plugins_git_cache_dir(),
        root.join("state/plugins/git-cache")
    );
    assert_eq!(
        paths.plugins_runtime_state_file(),
        root.join("state/plugins/runtime-wayland-2.json")
    );
    assert_eq!(
        paths.plugins_overlay_file(),
        root.join("runtime/plugins-overlay-wayland-2.json")
    );
    assert_eq!(
        paths.plugin_bytecode_cache_dir(),
        root.join("cache/plugin-bytecode")
    );
    assert_eq!(
        paths.plugin_catalog_cache_dir(),
        root.join("cache/catalog-cache")
    );

    let local = ShellPaths::for_local_state(Some(root.join("cfg")), Some(root.join("st"))).unwrap();
    assert_eq!(local.config_dir(), root.join("cfg"));
    assert_eq!(local.state_dir(), root.join("st"));
    assert!(!local.display().is_empty());
    assert!(local.cache_dir().is_absolute());
}

#[test]
fn settings_parse_plugin_sources_and_bar_plugin_instances_and_redact_public_summary() {
    let parsed: UserSettings = toml::from_str(
        r#"
[[plugins.sources]]
id = "official"
name = "Official Catalog"
kind = "https_json"
url = "https://plugins.z-shell.org/catalog-v1.json"
local_seed_dir = "/usr/share/z-shell/bundled-plugins"

[[plugins.sources]]
id = "community"
name = "Community"
kind = "git_json"
url = "https://git.example.invalid/catalog.git"
ref_name = "main"
index_path = "catalog-v1.json"
enabled = false
priority = 250

[bar.plugins]
left = ["z-shell/niri-overview:status"]
center = []
right = [
  "z-shell/nosleep:bar-indicator",
  { entry = "z-shell/ai-usage:bar-quota", instance = "primary", output = "DP-1", settings = { compact = true, api_token = "super-secret" } },
  { entry = "z-shell/ai-usage:bar-quota", instance = "secondary", output = "HDMI-A-1", settings = { compact = false } }
]
hidden = ["acme/weather:bar-temp"]
"#,
    )
    .unwrap();
    parsed.validate().unwrap();

    assert_eq!(parsed.plugins.sources.len(), 2);
    assert_eq!(parsed.plugins.sources[0].kind, PluginSourceKind::HttpsJson);
    assert!(parsed.plugins.sources[0].enabled);
    assert_eq!(parsed.plugins.sources[0].priority, 100);
    assert_eq!(
        parsed.plugins.sources[0].local_seed_dir.as_deref(),
        Some(PathBuf::from("/usr/share/z-shell/bundled-plugins").as_path())
    );
    assert_eq!(parsed.plugins.sources[1].kind, PluginSourceKind::GitJson);
    assert!(!parsed.plugins.sources[1].enabled);
    assert_eq!(parsed.plugins.sources[1].priority, 250);

    assert_eq!(parsed.bar.plugins.left.len(), 1);
    assert!(matches!(
        &parsed.bar.plugins.left[0],
        BarPluginSlot::Entry(entry) if entry.to_string() == "z-shell/niri-overview:status"
    ));
    assert_eq!(parsed.bar.plugins.right.len(), 3);
    assert!(matches!(
        &parsed.bar.plugins.right[1],
        BarPluginSlot::Instance(BarPluginInstance { instance, output, .. })
            if instance == "primary" && output.as_deref() == Some("DP-1")
    ));

    let summary = parsed.public_summary();
    let json = serde_json::to_string(&summary).unwrap();
    assert!(
        !json.contains("super-secret"),
        "public settings summary leaked per-instance settings: {json}"
    );
    assert!(matches!(
        &summary.bar.plugins.right[1],
        BarPluginSlot::Instance(inst) if inst.settings == BTreeMap::new()
    ));
}

#[test]
fn settings_reject_invalid_plugin_sources_and_duplicate_bar_instances() {
    for bad in [
        r#"
[[plugins.sources]]
id = "dup"
name = "One"
kind = "local_file"
url = "/tmp/a.json"
[[plugins.sources]]
id = "dup"
name = "Two"
kind = "local_file"
url = "/tmp/b.json"
"#,
        r#"
[[plugins.sources]]
id = "Bad/Slug"
name = "Bad"
kind = "local_file"
url = "/tmp/a.json"
"#,
        r#"
[[plugins.sources]]
id = "git-src"
name = "Git"
kind = "git_json"
url = "https://git.example.invalid/cat.git"
index_path = "../escape.json"
"#,
        r#"
[bar.plugins]
right = [
  { entry = "z-shell/ai-usage:bar-quota", instance = "Bad/Instance" }
]
"#,
        r#"
[bar.plugins]
left = [{ entry = "z-shell/ai-usage:bar-quota", instance = "dup", output = "DP-1" }]
right = [{ entry = "z-shell/ai-usage:bar-quota", instance = "dup", output = "DP-1" }]
"#,
    ] {
        let settings: UserSettings = toml::from_str(bad).unwrap();
        assert!(
            settings.validate().is_err(),
            "expected validation error for:\n{bad}"
        );
    }

    assert!(
        toml::from_str::<UserSettings>(
            r#"
[[plugins.sources]]
id = "x"
name = "X"
kind = "local_file"
url = "/tmp/a.json"
unknown_field = true
"#
        )
        .is_err()
    );
}
