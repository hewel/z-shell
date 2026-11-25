use flate2::Compression;
use flate2::write::GzEncoder;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use tar::{Builder, EntryType, Header};
use tempfile::tempdir;
use z_shell_plugins::archive::{ArchiveError, unpack_archive_bundle};
use z_shell_plugins::digest::content_digest;
use z_shell_plugins::registry::OfflinePolicy;

fn sha256_file(path: &Path) -> String {
    let bytes = fs::read(path).unwrap();
    format!("sha256:{:x}", Sha256::digest(&bytes))
}

fn valid_v2_manifest_toml() -> &'static str {
    r#"
id = "acme/archive-demo"
name = "Archive Demo"
version = "1.0.0"
plugin_api = 2

[build]
manifest = "dist/manifest.build.json"
shared_runtime_abi = "1.0"

[[service]]
id = "worker"
bundle = "dist/entries/worker.mjs"
"#
}

fn write_tar_payload<W: Write>(writer: W, files: &[(&str, &[u8])]) {
    let mut builder = Builder::new(writer);
    for (path, content) in files {
        let mut header = Header::new_gnu();
        header.set_size(content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, path, *content).unwrap();
    }
    builder.finish().unwrap();
}

fn build_valid_v2_files() -> Vec<(String, Vec<u8>)> {
    let worker = b"export default { setup() {} };\n".to_vec();
    let worker_digest = format!("sha256:{:x}", Sha256::digest(&worker));
    let build_manifest = serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": 1,
        "shared_runtime_abi": "1.0",
        "files": {
            "dist/entries/worker.mjs": worker_digest
        }
    }))
    .unwrap();
    vec![
        (
            "plugin.toml".to_owned(),
            valid_v2_manifest_toml().as_bytes().to_vec(),
        ),
        ("dist/entries/worker.mjs".to_owned(), worker),
        ("dist/manifest.build.json".to_owned(), build_manifest),
    ]
}

#[test]
fn unpacks_valid_tar_gz_and_tar_zst_into_readonly_bundles() {
    let dir = tempdir().unwrap();
    let files = build_valid_v2_files();
    let refs: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_slice()))
        .collect();

    // .tar.gz
    let tgz_path = dir.path().join("plugin.tar.gz");
    let gz = GzEncoder::new(File::create(&tgz_path).unwrap(), Compression::default());
    write_tar_payload(gz, &refs);
    let tgz_sha = sha256_file(&tgz_path);

    let state_gz = dir.path().join("state-gz");
    let unpacked_gz = unpack_archive_bundle(
        &state_gz.join("staging"),
        &state_gz.join("bundles"),
        tgz_path.to_str().unwrap(),
        &tgz_sha,
        OfflinePolicy::Offline,
    )
    .unwrap();
    assert_eq!(unpacked_gz.manifest.id.as_str(), "acme/archive-demo");
    assert_eq!(
        fs::metadata(&unpacked_gz.bundle_root)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o500
    );
    assert_eq!(
        content_digest(&unpacked_gz.bundle_root).unwrap(),
        unpacked_gz.content_digest
    );

    // .tar.zst
    let tzst_path = dir.path().join("plugin.tar.zst");
    let zst = zstd::stream::Encoder::new(File::create(&tzst_path).unwrap(), 3).unwrap();
    write_tar_payload(zst.auto_finish(), &refs);
    let tzst_sha = sha256_file(&tzst_path);

    let state_zst = dir.path().join("state-zst");
    let unpacked_zst = unpack_archive_bundle(
        &state_zst.join("staging"),
        &state_zst.join("bundles"),
        tzst_path.to_str().unwrap(),
        &tzst_sha,
        OfflinePolicy::Offline,
    )
    .unwrap();
    assert_eq!(unpacked_zst.content_digest, unpacked_gz.content_digest);
}

#[test]
fn rejects_digest_mismatch_zip_slip_symlinks_qjsb_setuid_and_offline_remote_url() {
    let dir = tempdir().unwrap();
    let files = build_valid_v2_files();
    let refs: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_slice()))
        .collect();

    let tgz_path = dir.path().join("valid.tar.gz");
    write_tar_payload(
        GzEncoder::new(File::create(&tgz_path).unwrap(), Compression::default()),
        &refs,
    );

    let state = dir.path().join("state");
    // 1. Archive SHA mismatch
    let err = unpack_archive_bundle(
        &state.join("staging"),
        &state.join("bundles"),
        tgz_path.to_str().unwrap(),
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        OfflinePolicy::Online,
    )
    .unwrap_err();
    assert!(matches!(err, ArchiveError::ArchiveDigestMismatch { .. }));

    // 2. Offline remote HTTPS URL rejected
    let err = unpack_archive_bundle(
        &state.join("staging"),
        &state.join("bundles"),
        "https://plugins.example.invalid/demo.tar.zst",
        &sha256_file(&tgz_path),
        OfflinePolicy::Offline,
    )
    .unwrap_err();
    assert!(matches!(err, ArchiveError::Offline));

    // 3. Zip-slip (../escape)
    let slip_path = dir.path().join("slip.tar.gz");
    {
        let gz = GzEncoder::new(File::create(&slip_path).unwrap(), Compression::default());
        let mut builder = Builder::new(gz);
        let mut header = Header::new_gnu();
        header.set_size(4);
        header.set_mode(0o644);
        header.as_gnu_mut().unwrap().name[..11].copy_from_slice(b"../evil.txt");
        header.set_cksum();
        builder.append(&header, &b"evil"[..]).unwrap();
        builder.finish().unwrap();
    }
    let slip_sha = sha256_file(&slip_path);
    assert!(
        unpack_archive_bundle(
            &state.join("staging"),
            &state.join("bundles"),
            slip_path.to_str().unwrap(),
            &slip_sha,
            OfflinePolicy::Online,
        )
        .is_err()
    );

    // 4. Symlink entry rejected
    let sym_path = dir.path().join("sym.tar.gz");
    {
        let gz = GzEncoder::new(File::create(&sym_path).unwrap(), Compression::default());
        let mut builder = Builder::new(gz);
        let mut header = Header::new_gnu();
        header.set_entry_type(EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        builder
            .append_link(&mut header, "alias.mjs", "dist/entries/worker.mjs")
            .unwrap();
        builder.finish().unwrap();
    }
    let sym_sha = sha256_file(&sym_path);
    assert!(
        unpack_archive_bundle(
            &state.join("staging"),
            &state.join("bundles"),
            sym_path.to_str().unwrap(),
            &sym_sha,
            OfflinePolicy::Online,
        )
        .is_err()
    );

    // 5. .qjsb entry inside archive rejected
    let mut qjsb_files = files.clone();
    qjsb_files.push(("dist/entries/bad.qjsb".to_owned(), b"ZSQB".to_vec()));
    let qjsb_refs: Vec<(&str, &[u8])> = qjsb_files
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_slice()))
        .collect();
    let qjsb_path = dir.path().join("qjsb.tar.gz");
    write_tar_payload(
        GzEncoder::new(File::create(&qjsb_path).unwrap(), Compression::default()),
        &qjsb_refs,
    );
    let qjsb_sha = sha256_file(&qjsb_path);
    assert!(
        unpack_archive_bundle(
            &state.join("staging"),
            &state.join("bundles"),
            qjsb_path.to_str().unwrap(),
            &qjsb_sha,
            OfflinePolicy::Online,
        )
        .is_err()
    );

    // 6. Setuid permission bit rejected
    let suid_path = dir.path().join("suid.tar.gz");
    {
        let gz = GzEncoder::new(File::create(&suid_path).unwrap(), Compression::default());
        let mut builder = Builder::new(gz);
        let mut header = Header::new_gnu();
        header.set_size(1);
        header.set_mode(0o4755);
        header.set_cksum();
        builder
            .append_data(&mut header, "bin.sh", &b"x"[..])
            .unwrap();
        builder.finish().unwrap();
    }
    let suid_sha = sha256_file(&suid_path);
    assert!(
        unpack_archive_bundle(
            &state.join("staging"),
            &state.join("bundles"),
            suid_path.to_str().unwrap(),
            &suid_sha,
            OfflinePolicy::Online,
        )
        .is_err()
    );
}
