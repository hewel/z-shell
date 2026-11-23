use std::ffi::{c_char, c_int, c_void};
use std::fs;
use std::io::ErrorKind;
use std::process::Command;
use tempfile::TempDir;
use z_shell_config::ThemeVariant;
use z_shell_theme::{ColorScheme, GtkLinkStatus, GtkLinker, parse_seed};

#[test]
fn gtk_link_detects_external_edits_and_reverts_original_files() {
    if !in_isolated_gsettings(
        "gtk_link_detects_external_edits_and_reverts_original_files",
        None,
    ) {
        return;
    }
    let temp = TempDir::new().unwrap();
    let config = temp.path().join("config");
    let state = temp.path().join("state");
    let gtk3 = config.join("gtk-3.0/gtk.css");
    let gtk4 = config.join("gtk-4.0/gtk.css");
    fs::create_dir_all(gtk3.parent().unwrap()).unwrap();
    fs::write(&gtk3, "/* user theme */\n").unwrap();
    let linker = GtkLinker::new(config.clone(), state.clone());
    let scheme = ColorScheme::generate(parse_seed("#006e1c").unwrap(), ThemeVariant::Tonal, true);

    assert_eq!(linker.link(&scheme, true), GtkLinkStatus::Linked);
    assert!(fs::read_to_string(&gtk4).unwrap().contains(&scheme.primary));
    let managed_gtk3 = fs::read(&gtk3).unwrap();
    assert_ne!(managed_gtk3, b"/* user theme */\n");
    let recovery = state.join("z-shell/theme/gtk-recovery.json");
    assert!(recovery.is_file());

    fs::write(&gtk3, "/* external edit */\n").unwrap();
    let next = ColorScheme::generate(parse_seed("#984061").unwrap(), ThemeVariant::Vibrant, false);
    assert_eq!(
        linker.link(&next, false),
        GtkLinkStatus::Conflict { path: gtk3.clone() }
    );
    assert_eq!(fs::read_to_string(&gtk3).unwrap(), "/* external edit */\n");
    assert_eq!(
        linker.revert(),
        GtkLinkStatus::Conflict { path: gtk3.clone() }
    );
    assert_eq!(fs::read_to_string(&gtk3).unwrap(), "/* external edit */\n");

    // Resolve the external edit by restoring the managed bytes, then undo cleanly.
    fs::write(&gtk3, managed_gtk3).unwrap();
    assert_eq!(linker.revert(), GtkLinkStatus::Unlinked);
    assert_eq!(fs::read_to_string(&gtk3).unwrap(), "/* user theme */\n");
    assert!(!gtk4.exists());
    assert!(!recovery.exists());
}

#[test]
fn gtk_linking_is_opt_in_and_io_failures_are_diagnostic() {
    if !in_isolated_gsettings("gtk_linking_is_opt_in_and_io_failures_are_diagnostic", None) {
        return;
    }
    let temp = TempDir::new().unwrap();
    let linker = GtkLinker::new(temp.path().join("config"), temp.path().join("state"));
    assert_eq!(linker.revert(), GtkLinkStatus::Unlinked);
    let scheme =
        ColorScheme::generate(parse_seed("#6750a4").unwrap(), ThemeVariant::Neutral, false);

    let blocked = temp.path().join("blocked");
    fs::write(&blocked, "not a directory").unwrap();
    let linker = GtkLinker::new(blocked, temp.path().join("state"));
    assert!(matches!(
        linker.link(&scheme, false),
        GtkLinkStatus::Error { .. }
    ));
}

#[test]
fn gtk_link_succeeds_when_color_scheme_key_is_missing() {
    let schema = r#"
<schemalist>
  <schema id="org.gnome.desktop.interface" path="/org/gnome/desktop/interface/">
    <key name="gtk-theme" type="s">
      <default>'Adwaita'</default>
    </key>
  </schema>
</schemalist>
"#;
    if !in_isolated_gsettings(
        "gtk_link_succeeds_when_color_scheme_key_is_missing",
        Some(schema),
    ) {
        return;
    }

    let linker = GtkLinker::from_environment();
    let scheme = ColorScheme::generate(parse_seed("#006e1c").unwrap(), ThemeVariant::Tonal, true);
    assert_eq!(linker.link(&scheme, true), GtkLinkStatus::Linked);
}

#[test]
fn gtk_link_updates_color_scheme_in_memory() {
    let schema = r#"
<schemalist>
  <enum id="org.gnome.desktop.GDesktopColorScheme">
    <value nick="default" value="0"/>
    <value nick="prefer-dark" value="1"/>
    <value nick="prefer-light" value="2"/>
  </enum>
  <schema id="org.gnome.desktop.interface" path="/org/gnome/desktop/interface/">
    <key name="color-scheme" enum="org.gnome.desktop.GDesktopColorScheme">
      <default>'default'</default>
    </key>
  </schema>
</schemalist>
"#;
    if !in_isolated_gsettings("gtk_link_updates_color_scheme_in_memory", Some(schema)) {
        return;
    }

    let linker = GtkLinker::from_environment();
    let scheme = ColorScheme::generate(parse_seed("#006e1c").unwrap(), ThemeVariant::Tonal, true);

    // SAFETY: GIO's initialization and finalizers can run; the library stays
    // loaded while all objects and symbols created through this handle are used.
    let gio = unsafe { libloading::Library::new("libgio-2.0.so.0") }.unwrap();
    // SAFETY: The symbol types match GIO/GObject's C ABI. The subprocess has
    // the compiled fixture schema and enum key, and owns one settings reference.
    unsafe {
        let new = gio
            .get::<unsafe extern "C" fn(*const c_char) -> *mut c_void>(b"g_settings_new\0")
            .unwrap();
        let get_enum = gio
            .get::<unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int>(
                b"g_settings_get_enum\0",
            )
            .unwrap();
        let unref = gio
            .get::<unsafe extern "C" fn(*mut c_void)>(b"g_object_unref\0")
            .unwrap();
        let settings = new(c"org.gnome.desktop.interface".as_ptr());
        assert!(!settings.is_null(), "could not open the fixture schema");
        let key = c"color-scheme".as_ptr();
        assert_eq!(get_enum(settings, key), 0);
        assert_eq!(linker.link(&scheme, true), GtkLinkStatus::Linked);
        assert_eq!(get_enum(settings, key), 1);
        assert_eq!(linker.link(&scheme, false), GtkLinkStatus::Linked);
        assert_eq!(get_enum(settings, key), 2);
        unref(settings);
    }
}

// GLib caches schema sources and backends process-wide. Set only the child's
// environment so parallel tests never change the runner's or user's settings.
fn in_isolated_gsettings(test: &str, schema: Option<&str>) -> bool {
    const CHILD: &str = "Z_SHELL_TEST_ISOLATED_GSETTINGS";
    if std::env::var(CHILD).as_deref() == Ok(test) {
        return true;
    }

    let temp = TempDir::new().unwrap();
    if let Some(schema) = schema {
        fs::write(temp.path().join("interface.gschema.xml"), schema).unwrap();
        match Command::new("glib-compile-schemas")
            .arg("--strict")
            .arg(temp.path())
            .output()
        {
            Ok(output) => assert!(
                output.status.success(),
                "fixture compilation failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                eprintln!("skipping GSettings fixture test: glib-compile-schemas unavailable");
                return false;
            }
            Err(error) => panic!("could not run glib-compile-schemas: {error}"),
        }
    }

    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env(CHILD, test)
        .env("GSETTINGS_BACKEND", "memory")
        .env("GSETTINGS_SCHEMA_DIR", temp.path())
        .env("XDG_DATA_DIRS", temp.path())
        .env("XDG_DATA_HOME", temp.path().join("data"))
        .env("XDG_CONFIG_HOME", temp.path().join("config"))
        .env("XDG_STATE_HOME", temp.path().join("state"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{test} subprocess failed ({}):\n{}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    false
}
