use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;
use z_shell_system::brightness::Backlights;

fn device(root: &Path, name: &str, brightness: &str, max: &str) {
    let path = root.join(name);
    fs::create_dir(&path).unwrap();
    fs::write(path.join("brightness"), brightness).unwrap();
    fs::write(path.join("max_brightness"), max).unwrap();
    fs::write(path.join("actual_brightness"), "1\n").unwrap();
}

#[test]
fn reads_requested_brightness_and_reports_direct_control() {
    let dir = tempfile::tempdir().unwrap();
    device(dir.path(), "panel-b", "14\n", "120\n");
    device(dir.path(), "panel-a", "9\n", "100\n");
    let entries = Backlights::new(dir.path()).devices().unwrap();

    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].device(), "panel-a");
    assert_eq!(entries[0].brightness(), 9);
    assert_eq!(entries[0].max_brightness(), 100);
    assert!(entries[0].controllable());
    assert_eq!(entries[1].device(), "panel-b");
}

#[test]
fn clamps_writes_and_never_changes_actual_brightness() {
    let dir = tempfile::tempdir().unwrap();
    device(dir.path(), "panel", "14\n", "120\n");
    let backlights = Backlights::new(dir.path());
    let path = dir.path().join("panel");

    backlights.set("panel", i64::MAX).unwrap();
    assert_eq!(backlights.devices().unwrap()[0].brightness(), 120);
    backlights.set("panel", -5).unwrap();
    assert_eq!(backlights.devices().unwrap()[0].brightness(), 0);
    assert_eq!(
        fs::read_to_string(path.join("actual_brightness")).unwrap(),
        "1\n"
    );
}

#[test]
fn skips_unusable_entries_and_rejects_paths_instead_of_device_names() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("class");
    fs::create_dir(&root).unwrap();
    device(&root, "panel", "15\n", "bad\n");
    device(&root, "disabled", "0\n", "0\n");
    device(dir.path(), "outside", "17\n", "40\n");
    let backlights = Backlights::new(&root);

    assert!(backlights.devices().unwrap().is_empty());
    assert_eq!(
        backlights.set("../outside", 2).unwrap_err().kind(),
        std::io::ErrorKind::InvalidInput
    );
    assert!(backlights.set("missing", 2).is_err());
    assert_eq!(
        fs::read_to_string(dir.path().join("outside/brightness")).unwrap(),
        "17\n"
    );
}

#[test]
fn follows_sysfs_device_links_when_reading_and_writing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("class");
    fs::create_dir(&root).unwrap();
    device(dir.path(), "kernel-device", "17\n", "40\n");
    symlink("../kernel-device", root.join("panel")).unwrap();
    let backlights = Backlights::new(root);

    assert_eq!(backlights.devices().unwrap()[0].device(), "panel");
    backlights.set("panel", 21).unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("kernel-device/brightness")).unwrap(),
        "21"
    );
}

#[test]
fn handles_no_backlight_class() {
    let dir = tempfile::tempdir().unwrap();
    assert!(
        Backlights::new(dir.path().join("unavailable"))
            .devices()
            .unwrap()
            .is_empty()
    );
}
