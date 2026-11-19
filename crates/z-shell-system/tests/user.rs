use std::fs::{self, File, FileTimes};
use std::os::unix::fs::{MetadataExt, symlink};
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};
use z_shell_config::ShellPaths;
use z_shell_protocol::MediaRef;
use z_shell_system::user::{Account, AvatarCache};

// A one-pixel GIF whose palette can be changed without changing its length.
fn avatar(red: u8) -> Vec<u8> {
    let mut bytes = b"GIF89a\x01\0\x01\0\x80\0\0\0\0\0\xff\xff\xff\x2c\0\0\0\0\x01\0\x01\0\0\x02\x02\x44\x01\0\x3b".to_vec();
    bytes[13] = red;
    bytes
}

fn paths(root: &Path) -> ShellPaths {
    ShellPaths::from_roots(
        root.join("config"),
        root.join("state"),
        root.join("runtime"),
        root.join("runtime/bus.sock"),
    )
}

fn runtime_ref(reference: MediaRef) -> (PathBuf, u64) {
    let MediaRef::RuntimePath {
        path,
        mime,
        revision,
    } = reference
    else {
        panic!("an avatar must be a runtime path, not an in-band payload");
    };
    assert_eq!(mime, "image/gif");
    (path, revision)
}

#[test]
fn passwd_uses_numeric_uid_and_falls_back_to_login_when_gecos_is_empty() {
    let root = tempfile::tempdir().unwrap();
    let passwd = root.path().join("passwd");
    fs::write(
        &passwd,
        "other:x:900:1:Unrelated:/home/other:/bin/sh\nmalformed\nalex:x:1000:1:Alex Doe,Room 1:/home/alex:/bin/sh\nsam:x:1001:1:,Room 2:/home/sam:/bin/sh\n",
    )
    .unwrap();
    let alex = Account::from_passwd(&passwd, 1000).unwrap().unwrap();
    assert_eq!(alex.username, "alex");
    assert_eq!(alex.display_name, "Alex Doe");
    assert_eq!(alex.home.as_deref(), Some(Path::new("/home/alex")));
    assert_eq!(
        Account::from_passwd(&passwd, 1001)
            .unwrap()
            .unwrap()
            .display_name,
        "sam"
    );
    assert!(Account::from_passwd(&passwd, 1002).unwrap().is_none());
}

#[test]
fn avatar_priority_and_same_length_edits_update_the_media_ref_without_rewriting_unchanged_files() {
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    let home = root.path().join("home");
    let fallback = root.path().join("accounts-icon");
    fs::create_dir(&home).unwrap();
    fs::create_dir(paths.state_dir()).unwrap();
    let overrides = [
        paths.state_dir().join("avatar"),
        home.join(".face.icon"),
        home.join(".face"),
    ];
    for (index, file) in overrides.iter().enumerate() {
        fs::write(file, avatar(u8::try_from(index).unwrap())).unwrap();
    }
    fs::write(&fallback, avatar(3)).unwrap();

    let mut cache = AvatarCache::new(paths.clone());
    let first = cache
        .refresh(Some(&home), Some(&fallback))
        .unwrap()
        .unwrap();
    let (path, revision) = runtime_ref(first.clone());
    assert_eq!(path.parent(), Some(paths.media_dir().as_path()));
    assert_eq!(
        fs::metadata(paths.media_dir()).unwrap().mode() & 0o777,
        0o700
    );
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
    assert_eq!(fs::read(&path).unwrap(), avatar(0));
    let cached = fs::metadata(&path).unwrap();
    let old_mtime = UNIX_EPOCH + Duration::from_secs(42);
    let times = FileTimes::new().set_modified(old_mtime);
    File::open(&path).unwrap().set_times(times).unwrap();
    assert_eq!(
        cache.refresh(Some(&home), Some(&fallback)).unwrap(),
        Some(first)
    );
    let unchanged = fs::metadata(&path).unwrap();
    assert_eq!(unchanged.ino(), cached.ino());
    assert_eq!(unchanged.modified().unwrap(), old_mtime);

    File::open(&overrides[0]).unwrap().set_times(times).unwrap();
    fs::write(&overrides[0], avatar(99)).unwrap();
    File::open(&overrides[0]).unwrap().set_times(times).unwrap();
    let changed = cache
        .refresh(Some(&home), Some(&fallback))
        .unwrap()
        .unwrap();
    let (changed_path, mut next_revision) = runtime_ref(changed);
    assert!(next_revision > revision);
    assert_eq!(fs::read(changed_path).unwrap(), avatar(99));

    for (index, file) in overrides.iter().enumerate() {
        fs::remove_file(file).unwrap();
        let selected = cache
            .refresh(Some(&home), Some(&fallback))
            .unwrap()
            .unwrap();
        let (selected_path, revision) = runtime_ref(selected);
        assert!(revision > next_revision);
        assert_eq!(
            fs::read(selected_path).unwrap(),
            avatar(u8::try_from(index + 1).unwrap())
        );
        next_revision = revision;
    }
    fs::remove_file(fallback).unwrap();
    assert!(cache.refresh(Some(&home), None).unwrap().is_none());
}

#[test]
fn a_symlink_in_the_runtime_cache_is_never_published_or_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let mut cache = AvatarCache::new(paths(root.path()));
    let source = root.path().join("source");
    fs::write(&source, avatar(10)).unwrap();
    let (path, _) = runtime_ref(cache.refresh(None, Some(&source)).unwrap().unwrap());
    fs::remove_file(&path).unwrap();
    let unrelated = root.path().join("unrelated");
    fs::write(&unrelated, b"keep this file unchanged").unwrap();
    symlink(&unrelated, &path).unwrap();

    assert!(cache.refresh(None, Some(&source)).is_err());
    assert_eq!(fs::read_link(&path).unwrap(), unrelated);
    assert_eq!(fs::read(&unrelated).unwrap(), b"keep this file unchanged");
}

#[test]
fn unreadable_or_oversized_sources_do_not_hide_lower_priority_avatars() {
    let root = tempfile::tempdir().unwrap();
    let paths = paths(root.path());
    let home = root.path().join("home");
    fs::create_dir(&home).unwrap();
    fs::create_dir(paths.state_dir()).unwrap();
    File::create(paths.state_dir().join("avatar"))
        .unwrap()
        .set_len(8 * 1024 * 1024 + 1)
        .unwrap();
    symlink("missing", home.join(".face.icon")).unwrap();
    fs::write(home.join(".face"), avatar(17)).unwrap();

    let (path, _) = runtime_ref(
        AvatarCache::new(paths)
            .refresh(Some(&home), None)
            .unwrap()
            .unwrap(),
    );
    assert_eq!(fs::read(path).unwrap(), avatar(17));
}
