use std::fs;
use tempfile::TempDir;
use z_shell_config::ThemeVariant;
use z_shell_theme::{ColorScheme, GtkLinkStatus, GtkLinker, parse_seed};

#[test]
fn gtk_link_detects_external_edits_and_reverts_original_files() {
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
