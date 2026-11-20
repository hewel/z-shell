use std::fs;
use std::os::unix::fs::symlink;

use tempfile::{TempDir, tempdir};
use toml::{Table, Value};
use z_shell_plugins::Manifest;
use z_shell_protocol::PluginEntryKind;

const HEADER: &str = r#"
id = "z-shell/example"
name = "Example"
version = "1.2.3"
plugin_api = 1
"#;

fn fixture(body: &str) -> TempDir {
    let root = tempdir().unwrap();
    fs::write(root.path().join("plugin.toml"), format!("{HEADER}\n{body}")).unwrap();
    fs::write(root.path().join("main.tsx"), "throw 'not executed';").unwrap();
    root
}

#[test]
fn reads_metadata_and_all_seven_entry_kinds_statically() {
    let root = fixture(
        r#"
author = "Example Author"
description = "A statically parsed plugin"
dependencies = ["tool"]

[host_capabilities]
commands = ["tool", "/usr/bin/other"]
image_prefixes = ["/", "/opt/example/images", "$XDG_RUNTIME_DIR/z-shell/media", "$XDG_DATA_HOME/icons"]
unix_sockets = ["/run/example.sock", "$XDG_RUNTIME_DIR/z-shell/bus-${WAYLAND_DISPLAY}.sock", "$HOME/.cache/$WAYLAND_DISPLAY"]
named_sockets = ["niri", "hyprland_ipc-1"]
shell_surfaces = true
control_channel = true

[bus_permissions]
topics_read = ["settings"]
topics_publish = ["plugin.z-shell.example.state"]
commands_register = ["plugin.z-shell.example.ping"]
inhibitors = true

[[widget]]
id = "bar-clock"
entry = "main.tsx"

[[shortcut]]
id = "toggle"
entry = "main.tsx"

[[panel]]
id = "details"
entry = "main.tsx"

[[service]]
id = "worker"
entry = "main.tsx"
title = "Worker"
description = "An example worker"

[[launcher_provider]]
id = "search"
entry = "main.tsx"

[[settings_page]]
id = "appearance"
entry = "main.tsx"

[[layer]]
id = "surface"
entry = "main.tsx"
"#,
    );
    let manifest = Manifest::load(root.path()).unwrap();
    assert_eq!(manifest.id.as_str(), "z-shell/example");
    assert_eq!(manifest.version, "1.2.3");
    assert_eq!(manifest.plugin_api, 1);
    assert_eq!(manifest.author.as_deref(), Some("Example Author"));
    assert_eq!(manifest.license, "MIT");
    assert_eq!(
        manifest.description.as_deref(),
        Some("A statically parsed plugin")
    );
    assert_eq!(manifest.dependencies, ["tool"]);
    assert_eq!(manifest.entries.len(), 7);
    for (id, kind) in [
        ("bar-clock", PluginEntryKind::Widget),
        ("toggle", PluginEntryKind::Shortcut),
        ("details", PluginEntryKind::Panel),
        ("worker", PluginEntryKind::Service),
        ("search", PluginEntryKind::LauncherProvider),
        ("appearance", PluginEntryKind::SettingsPage),
        ("surface", PluginEntryKind::Layer),
    ] {
        let entry = manifest
            .entries
            .iter()
            .find(|entry| entry.id.entry() == id)
            .unwrap();
        assert_eq!(entry.id.plugin().as_str(), "z-shell/example");
        assert_eq!(entry.kind, kind);
        if id == "worker" {
            assert_eq!(entry.title.as_deref(), Some("Worker"));
            assert_eq!(entry.description.as_deref(), Some("An example worker"));
        }
    }
    assert!(manifest.capabilities.host.image_prefixes.contains("/"));
    assert!(
        manifest
            .capabilities
            .host
            .image_prefixes
            .contains("$XDG_RUNTIME_DIR/z-shell/media")
    );
    assert!(
        manifest
            .capabilities
            .host
            .unix_sockets
            .contains("$XDG_RUNTIME_DIR/z-shell/bus-${WAYLAND_DISPLAY}.sock")
    );
    assert!(manifest.capabilities.host.named_sockets.contains("niri"));
    assert!(manifest.capabilities.host.shell_surfaces);
    assert!(manifest.capabilities.bus.inhibitors);
    assert!(manifest.capabilities.bus.topics_read.contains("settings"));
    assert!(
        manifest
            .capabilities
            .bus
            .commands_register
            .contains("plugin.z-shell.example.ping")
    );
}

#[test]
fn rejects_session_lock_without_disclosing_the_manifest_source() {
    for key in ["session_lock", "sessionLock"] {
        let root = fixture(&format!("[host_capabilities]\n{key} = 'private-value'"));
        let error = Manifest::load(root.path()).unwrap_err();
        assert!(error.to_string().contains(key), "{error}");
        assert!(!error.to_string().contains("private-value"), "{error}");
        assert!(!format!("{error:?}").contains("private-value"), "{error:?}");
    }
}

#[test]
fn settings_overrides_are_scoped_validated_and_redacted() {
    let root = fixture(
        r#"
[[setting]]
key = "interval"
type = "integer"
default = 60
min = 30
max = 300

[[setting]]
key = "token"
type = "string"
default = "private-default"
secret = true

[[widget]]
id = "clock"
entry = "main.tsx"

[[widget.setting]]
key = "interval"
type = "number"
default = 1
min = 0.5
max = 2.5

[[widget.setting]]
key = "compact"
type = "boolean"
default = false

[[widget.setting]]
key = "password"
type = "string"
default = "entry-private-default"
secret = true
"#,
    );
    let manifest = Manifest::load(root.path()).unwrap();
    let entry = &manifest.entries[0];
    let overrides: Table = toml::from_str("interval = 30\ntoken = 'private-override'").unwrap();
    assert_eq!(
        manifest.public_settings(&overrides).unwrap(),
        Table::from_iter([("interval".to_owned(), Value::Integer(30))]),
    );
    let overrides: Table =
        toml::from_str("interval = 2.5\npassword = 'entry-private-override'").unwrap();
    let public = entry.public_settings(&overrides).unwrap();
    assert_eq!(public.len(), 2);
    assert_eq!(public["compact"], Value::Boolean(false));
    assert_eq!(public["interval"], Value::Float(2.5));
    assert!(!format!("{manifest:?}").contains("private-default"));

    for (overrides, expected) in [
        ("compact = true", "undeclared"),
        ("interval = 29", "minimum"),
        ("interval = 301", "maximum"),
        ("interval = 60.0", "integer"),
        ("token = ['private-invalid-override']", "string"),
    ] {
        let error = manifest
            .public_settings(&toml::from_str(overrides).unwrap())
            .unwrap_err()
            .to_string();
        assert!(error.contains("plugin"), "{error}");
        assert!(error.contains(expected), "{error}");
        assert!(!error.contains("private-invalid-override"), "{error}");
    }
    let error = entry
        .public_settings(&toml::from_str("token = 'private-value'").unwrap())
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("undeclared") && error.contains("token") && error.contains(":clock"),
        "{error}"
    );
    assert!(!error.contains("private-value"), "{error}");
}

#[test]
fn invalid_settings_declarations_are_rejected_without_leaking_values() {
    for (setting, expected) in [
        (
            "type = 'integer'\ndefault = 'private-default'\nsecret = true",
            "integer",
        ),
        ("type = 'number'\ndefault = nan", "finite"),
        (
            "type = 'string'\ndefault = 'private-default'\nmin = 0",
            "numeric",
        ),
        (
            "type = 'integer'\ndefault = 5\nmin = 10\nmax = 0",
            "minimum",
        ),
        (
            "type = 'integer'\ndefault = 9007199254740993\nmax = 9007199254740992.0",
            "maximum",
        ),
        (
            "type = 'string'\ndefault = 'private-default'\nmisspelled = true",
            "misspelled",
        ),
        (
            "type = 'string'\ndefault = 'private-default'\nsecret = 'private-flag'",
            "plugin.toml",
        ),
    ] {
        let root = fixture(&format!("[[setting]]\nkey = 'test'\n{setting}"));
        let error = Manifest::load(root.path()).unwrap_err().to_string();
        assert!(error.contains(expected), "{error}");
        assert!(!error.contains("private-"), "{error}");
    }
}

#[test]
fn validates_entry_identity_path_and_regular_file() {
    for (body, expected) in [
        ("[[widget]]\nid = 'bad/slug'\nentry = 'main.tsx'", "id"),
        (
            "[[widget]]\nid = 'same'\nentry = 'main.tsx'\n[[service]]\nid = 'same'\nentry = 'main.tsx'",
            "duplicate",
        ),
        (
            "[[service]]\nid = 'example'\nentry = '../main.tsx'",
            "relative",
        ),
        (
            "[[service]]\nid = 'example'\nentry = '/main.tsx'",
            "relative",
        ),
        (
            "[[service]]\nid = 'example'\nentry = 'missing.tsx'",
            "entry",
        ),
        (
            "[[service]]\nid = 'example'\nentry = 'subdir'",
            "regular file",
        ),
        (
            "[[service]]\nid = 'example'\nentry = 'main.tsx'\ntypo = true",
            "typo",
        ),
        (
            "[[misspelled_kind]]\nid = 'example'\nentry = 'main.tsx'",
            "misspelled_kind",
        ),
    ] {
        let root = fixture(body);
        fs::create_dir(root.path().join("subdir")).unwrap();
        let error = Manifest::load(root.path()).unwrap_err().to_string();
        assert!(error.contains(expected), "{error}");
    }
    let root = fixture("[[service]]\nid = 'example'\nentry = 'link.tsx'");
    symlink("main.tsx", root.path().join("link.tsx")).unwrap();
    assert!(Manifest::load(root.path()).is_ok());
}

#[test]
fn rejects_entry_symlinks_that_escape_the_canonical_root() {
    let root = fixture("[[service]]\nid = 'example'\nentry = 'link.tsx'");
    let outside = fixture("");
    symlink(
        outside.path().join("main.tsx"),
        root.path().join("link.tsx"),
    )
    .unwrap();
    let error = Manifest::load(root.path()).unwrap_err().to_string();
    assert!(error.contains("strictly inside"), "{error}");
}

#[test]
fn rejects_invalid_package_versions_api_levels_and_capability_declarations() {
    let root = fixture("");
    for (valid, invalid, expected) in [
        ("1.2.3", "1.2", "version"),
        ("1.2.3", "01.2.3", "version"),
        ("1.2.3", "1.2.3-rc.1", "version"),
        ("1.2.3", "1.2.3+build", "version"),
        ("plugin_api = 1", "plugin_api = 0", "plugin_api"),
        ("plugin_api = 1", "plugin_api = 2", "plugin_api"),
        ("z-shell/example", "Z-shell/example", "id"),
        ("Example", " ", "name"),
    ] {
        fs::write(
            root.path().join("plugin.toml"),
            HEADER.replace(valid, invalid),
        )
        .unwrap();
        let error = Manifest::load(root.path()).unwrap_err().to_string();
        assert!(error.contains(expected), "{error}");
    }
    for (body, expected) in [
        ("[host_capabilities]\ncommands = [' ']", "commands"),
        (
            "[host_capabilities]\nimage_prefixes = ['//var']",
            "image_prefixes",
        ),
        (
            "[host_capabilities]\nimage_prefixes = ['/var/../tmp']",
            "image_prefixes",
        ),
        (
            "[host_capabilities]\nimage_prefixes = ['/var/.']",
            "image_prefixes",
        ),
        (
            "[host_capabilities]\nimage_prefixes = ['/var/']",
            "image_prefixes",
        ),
        (
            "[host_capabilities]\nunix_sockets = ['relative.sock']",
            "unix_sockets",
        ),
        (
            "[host_capabilities]\nunix_sockets = ['/run/file\\name']",
            "unix_sockets",
        ),
        (
            "[host_capabilities]\nunix_sockets = ['$OTHER_VAR/z-shell.sock']",
            "unix_sockets",
        ),
        (
            "[host_capabilities]\nunix_sockets = ['$XDG_RUNTIME_DIR/../escape.sock']",
            "unix_sockets",
        ),
        (
            "[host_capabilities]\nunix_sockets = ['$XDG_RUNTIME_DIR/foo$BAR.sock']",
            "unix_sockets",
        ),
        (
            "[host_capabilities]\nimage_prefixes = ['$XDG_RUNTIME_DIR/']",
            "image_prefixes",
        ),
        (
            "[host_capabilities]\nnamed_sockets = ['1bad']",
            "named_sockets",
        ),
        (
            "[host_capabilities]\nnamed_sockets = ['bad name']",
            "named_sockets",
        ),
        (
            "[bus_permissions]\ntopics_publish = ['settings']",
            "topics_publish",
        ),
        (
            "[bus_permissions]\ncommands_register = ['other.example']",
            "commands_register",
        ),
    ] {
        let root = fixture(body);
        let error = Manifest::load(root.path()).unwrap_err().to_string();
        assert!(error.contains(expected), "{error}");
    }
}

#[test]
fn rejects_positional_tables_and_non_string_setting_types() {
    for body in [
        "host_capabilities = [[], [], [], false, false]",
        "bus_permissions = [[], [], [], false]",
        "widget = [['clock', 'main.tsx', 'Clock', 'Description', []]]",
        "setting = [['token', 'string', 'private-default', 1, 2, true]]",
        "[[setting]]\nkey = 'token'\ntype = { string = {} }\ndefault = 'private-default'",
        "[[setting]]\nkey = 'token'\ntype = 'private-unknown-type'\ndefault = 'private-default'",
    ] {
        let root = fixture(body);
        let error = Manifest::load(root.path()).unwrap_err();
        assert!(!error.to_string().contains("private-"), "{error}");
    }
}
