use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use tempfile::tempdir;
use z_shell_plugins::bundle::{
    bundle_dir_for, materialize_bundle, remove_bundle_tree, verify_bundle,
};
use z_shell_plugins::digest::content_digest;
use z_shell_protocol::PluginId;

#[test]
fn materialize_bundle_creates_read_only_content_addressed_dir_and_preserves_source() {
    let work = tempdir().unwrap();
    let src = work.path().join("src-plugin");
    let bundles_dir = work.path().join("bundles");
    fs::create_dir_all(src.join("dist/entries")).unwrap();
    fs::write(src.join("plugin.toml"), "id = \"acme/demo\"\n").unwrap();
    fs::write(src.join("dist/entries/svc.mjs"), "export default {};\n").unwrap();
    symlink("dist/entries/svc.mjs", src.join("alias.mjs")).unwrap();

    let id: PluginId = "acme/demo".parse().unwrap();
    let expected_digest = content_digest(&src).unwrap();
    let bundle_root = materialize_bundle(&bundles_dir, &id, &src, &expected_digest).unwrap();

    assert_eq!(
        bundle_root,
        bundle_dir_for(&bundles_dir, &id, &expected_digest)
    );
    assert_eq!(
        fs::metadata(&bundle_root).unwrap().permissions().mode() & 0o777,
        0o500
    );
    assert_eq!(
        fs::metadata(bundle_root.join("plugin.toml"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o400
    );
    assert_eq!(
        fs::read_link(bundle_root.join("alias.mjs")).unwrap(),
        std::path::Path::new("dist/entries/svc.mjs")
    );
    assert_eq!(
        verify_bundle(&bundle_root, &expected_digest).unwrap(),
        expected_digest
    );

    // Source directory must remain writable and untouched.
    assert!(
        fs::metadata(src.join("plugin.toml"))
            .unwrap()
            .permissions()
            .mode()
            & 0o200
            != 0
    );

    remove_bundle_tree(&bundle_root).unwrap();
    assert!(!bundle_root.exists());
}

#[test]
fn materialize_bundle_rejects_qjsb_and_digest_mismatch() {
    let work = tempdir().unwrap();
    let src = work.path().join("src-plugin");
    let bundles_dir = work.path().join("bundles");
    fs::create_dir_all(&src).unwrap();
    fs::write(src.join("evil.qjsb"), b"ZSQB").unwrap();
    let id: PluginId = "acme/demo".parse().unwrap();
    let digest = content_digest(&src).unwrap();

    assert!(materialize_bundle(&bundles_dir, &id, &src, &digest).is_err());

    fs::remove_file(src.join("evil.qjsb")).unwrap();
    fs::write(src.join("plugin.toml"), "id = \"acme/demo\"\n").unwrap();
    assert!(
        materialize_bundle(
            &bundles_dir,
            &id,
            &src,
            "sha256:0000000000000000000000000000000000000000000000000000000000000000"
        )
        .is_err()
    );
}
