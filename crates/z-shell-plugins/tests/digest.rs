use std::fs;
use std::os::unix::fs::symlink;
use tempfile::tempdir;
use z_shell_plugins::digest::content_digest;

#[test]
fn digest_frames_sorted_paths_and_raw_bytes_and_excludes_git_metadata() {
    let root = tempdir().unwrap();
    let root = root.path();
    fs::create_dir(root.join("dir")).unwrap();
    fs::create_dir(root.join(".git")).unwrap();
    fs::write(root.join("dir/z"), []).unwrap();
    fs::write(root.join("a"), [0, 255]).unwrap();
    fs::write(root.join(".hidden"), b"xyz").unwrap();
    fs::write(root.join(".git/config"), b"not plugin content").unwrap();

    assert_eq!(
        content_digest(root).unwrap(),
        "sha256:b9a0e48806cf1bf808dd5cc9fa95fa89d001ca24e634bd5fa41681ae224a6f5c"
    );
}

#[test]
fn internal_aliases_contribute_at_their_logical_paths() {
    let root = tempdir().unwrap();
    let root = root.path();
    fs::create_dir(root.join("dir")).unwrap();
    fs::write(root.join("dir/x"), b"B").unwrap();
    fs::write(root.join("a"), b"A").unwrap();
    symlink("dir", root.join("alias")).unwrap();
    symlink("a", root.join("entry.ts")).unwrap();
    assert_eq!(
        content_digest(root).unwrap(),
        "sha256:7a26a61b9492d51f52cd3c796f15afae21ffbb6857481e73d20ecec1450b5666"
    );
    fs::remove_file(root.join("entry.ts")).unwrap();
    symlink("dir/x", root.join("entry.ts")).unwrap();
    assert_eq!(
        content_digest(root).unwrap(),
        "sha256:c5a4c5f37cbc277750bf55481b2766f0eea4cd6d54ed9b95e1a25ff7be853883"
    );
}

#[test]
fn rejects_external_symlinks_even_outside_manifest_entries() {
    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    symlink(outside.path(), root.path().join("assets")).unwrap();
    assert!(content_digest(root.path()).is_err());
}
