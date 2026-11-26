use serde_json::{Map as JsonMap, Value as JsonValue, json};
use std::collections::BTreeMap;
use std::path::PathBuf;
use tempfile::tempdir;
use z_shell_config::{
    BarPluginInstance, BarPluginSlot, ConfigError, ConfigStore, PluginSourceKind, ShellPaths,
    TrayDefaultAction, TrayItemRule, UserSettings,
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
  "z-shell/sample-keep:bar-indicator",
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

#[test]
fn bar_tray_omits_defaults_for_rollback_and_patches_with_plugins_sources() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    let paths = ShellPaths::from_roots(
        root.join("config"),
        root.join("state"),
        root.join("runtime"),
        root.join("runtime/bus.sock"),
    );
    let store = ConfigStore::new(paths);

    // Default UserSettings must omit [bar.tray] and workspace_numbers in TOML and PublicSettingsSummary JSON.
    let defaults = UserSettings::default();
    assert!(defaults.bar.workspace_numbers);
    let toml_text = toml::to_string_pretty(&defaults).unwrap();
    assert!(
        !toml_text.contains("tray"),
        "unexpected tray in default TOML:\n{toml_text}"
    );
    assert!(
        !toml_text.contains("workspace_numbers"),
        "unexpected workspace_numbers in default TOML:\n{toml_text}"
    );
    let summary_json = serde_json::to_value(defaults.public_summary()).unwrap();
    assert!(summary_json["bar"].get("tray").is_none());
    assert!(summary_json["bar"].get("workspace_numbers").is_none());

    // Patch [bar.tray] and [plugins.sources] losslessly.
    let patch: JsonMap<String, JsonValue> = serde_json::from_value(json!({
        "bar": {
            "tray": {
                "default_action": "collapse",
                "rules": {
                    "discord": "hide",
                    "nm-applet": "show"
                }
            }
        },
        "plugins": {
            "sources": [
                {
                    "id": "official",
                    "name": "Official",
                    "kind": "https_json",
                    "url": "https://plugins.z-shell.org/catalog-v1.json",
                    "enabled": true,
                    "priority": 100
                }
            ]
        }
    }))
    .unwrap();
    let patched = store.patch_settings(&patch).unwrap();
    assert_eq!(patched.bar.tray.default_action, TrayDefaultAction::Collapse);
    assert_eq!(
        patched.bar.tray.rules.get("discord"),
        Some(&TrayItemRule::Hide)
    );
    assert_eq!(
        patched.bar.tray.rules.get("nm-applet"),
        Some(&TrayItemRule::Show)
    );
    assert_eq!(patched.plugins.sources.len(), 1);
    assert_eq!(patched.plugins.sources[0].id, "official");

    // Reset one rule + reset default_action back to show.
    let reset_patch: JsonMap<String, JsonValue> = serde_json::from_value(json!({
        "bar": {
            "tray": {
                "default_action": "show",
                "rules": { "discord": null, "nm-applet": null }
            }
        },
        "plugins": { "sources": [] }
    }))
    .unwrap();
    let reset = store.patch_settings(&reset_patch).unwrap();
    assert!(reset.bar.tray.is_default());
    assert!(reset.plugins.sources.is_empty());

    // Invalid tray rule key must fail validation without mutating settings.toml.
    let bad_tray: JsonMap<String, JsonValue> = serde_json::from_value(json!({
        "bar": { "tray": { "rules": { " ": "hide" } } }
    }))
    .unwrap();
    assert!(matches!(
        store.patch_settings(&bad_tray),
        Err(ConfigError::Validation(_))
    ));

    // Secret plugin_settings remains forbidden in patch_settings.
    let bad_secret: JsonMap<String, JsonValue> = serde_json::from_value(json!({
        "plugin_settings": { "z-shell/ai-usage": { "token": "secret" } }
    }))
    .unwrap();
    assert!(matches!(
        store.patch_settings(&bad_secret),
        Err(ConfigError::Validation(_))
    ));

    // bar.workspace_numbers patches to false and restores cleanly to omitted default true.
    let ws_off: JsonMap<String, JsonValue> = serde_json::from_value(json!({
        "bar": { "workspace_numbers": false }
    }))
    .unwrap();
    let patched_ws_off = store.patch_settings(&ws_off).unwrap();
    assert!(!patched_ws_off.bar.workspace_numbers);
    let summary_ws_off = serde_json::to_value(patched_ws_off.public_summary()).unwrap();
    assert_eq!(summary_ws_off["bar"]["workspace_numbers"], json!(false));

    let ws_on: JsonMap<String, JsonValue> = serde_json::from_value(json!({
        "bar": { "workspace_numbers": true }
    }))
    .unwrap();
    let patched_ws_on = store.patch_settings(&ws_on).unwrap();
    assert!(patched_ws_on.bar.workspace_numbers);
    let summary_ws_on = serde_json::to_value(patched_ws_on.public_summary()).unwrap();
    assert!(summary_ws_on["bar"].get("workspace_numbers").is_none());
}
