//! Immutable, read-only, content-addressed plugin bundle storage.

use std::fs::{self, File, Permissions};
use std::io;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};

use tempfile::tempdir_in;
use thiserror::Error;
use z_shell_protocol::PluginId;

use super::digest::{DigestError, content_digest, is_valid_sha256};
use super::manifest::{ManifestError, verify_no_qjsb};

const DIR_MODE_WRITABLE: u32 = 0o700;
const DIR_MODE_READONLY: u32 = 0o500;
const FILE_MODE_READONLY: u32 = 0o400;
const FILE_MODE_WRITABLE: u32 = 0o600;

/// Error returned while materializing, verifying, or removing a plugin bundle.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum BundleError {
    /// Filesystem I/O failed while preparing or cleaning a bundle.
    #[error("bundle I/O error at {path}: {source}")]
    Io {
        /// Affected filesystem path.
        path: PathBuf,
        /// Underlying OS error.
        #[source]
        source: io::Error,
    },
    /// Content digest calculation failed.
    #[error(transparent)]
    Digest(#[from] DigestError),
    /// Manifest or `.qjsb` verification failed.
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    /// The supplied content digest is malformed.
    #[error("invalid bundle content digest {0:?}")]
    InvalidDigest(String),
    /// The materialized or verified files did not match the expected digest.
    #[error("bundle digest mismatch: expected {expected}, got {actual}")]
    DigestMismatch {
        /// Expected `sha256:<64-hex>` digest.
        expected: String,
        /// Observed `sha256:<64-hex>` digest.
        actual: String,
    },
}

/// Computes the deterministic content-addressed path for a plugin bundle.
#[must_use]
pub fn bundle_dir_for(bundles_dir: &Path, id: &PluginId, content_digest: &str) -> PathBuf {
    let plugin_slug = format!("{}__{}", id.author(), id.name());
    let digest_slug = content_digest.replace(':', "_");
    bundles_dir.join(plugin_slug).join(digest_slug)
}

/// Materializes `source_dir` into a read-only (`0500`/`0400`) content-addressed bundle directory.
///
/// Never mutates `source_dir`. Rejects `.qjsb` files and verifies `content_digest` before commit.
///
/// # Errors
///
/// Returns [`BundleError`] if `expected_digest` is invalid, `.qjsb` files exist, content digest
/// does not match, or filesystem operations fail.
pub fn materialize_bundle(
    bundles_dir: &Path,
    id: &PluginId,
    source_dir: &Path,
    expected_digest: &str,
) -> Result<PathBuf, BundleError> {
    if !is_valid_sha256(expected_digest) {
        return Err(BundleError::InvalidDigest(expected_digest.to_owned()));
    }
    let source = at(source_dir, fs::canonicalize(source_dir))?;
    verify_no_qjsb(&source)?;
    let actual = content_digest(&source)?;
    if actual != expected_digest {
        return Err(BundleError::DigestMismatch {
            expected: expected_digest.to_owned(),
            actual,
        });
    }

    ensure_dir_mode(bundles_dir, DIR_MODE_WRITABLE)?;
    let plugin_parent = bundles_dir.join(format!("{}__{}", id.author(), id.name()));
    ensure_dir_mode(&plugin_parent, DIR_MODE_WRITABLE)?;

    let target = bundle_dir_for(bundles_dir, id, expected_digest);
    match fs::symlink_metadata(&target) {
        Ok(meta) => {
            if meta.is_dir() && verify_bundle(&target, expected_digest).is_ok() {
                return Ok(target);
            }
            remove_bundle_tree(&target)?;
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(BundleError::Io {
                path: target,
                source,
            });
        }
    }

    let staging = at(&plugin_parent, tempdir_in(&plugin_parent))?;
    let staged_bundle = staging.path().join("bundle");
    at(&staged_bundle, fs::create_dir(&staged_bundle))?;
    copy_tree_readonly(&source, &source, &staged_bundle, true)?;

    let staged_digest = content_digest(&staged_bundle)?;
    if staged_digest != expected_digest {
        let _ = remove_bundle_tree(&staged_bundle);
        return Err(BundleError::DigestMismatch {
            expected: expected_digest.to_owned(),
            actual: staged_digest,
        });
    }
    if let Err(err) = fs::rename(&staged_bundle, &target) {
        let _ = remove_bundle_tree(&staged_bundle);
        return Err(BundleError::Io {
            path: target,
            source: err,
        });
    }
    if let Err(err) = fs::set_permissions(&target, Permissions::from_mode(DIR_MODE_READONLY)) {
        let _ = remove_bundle_tree(&target);
        return Err(BundleError::Io {
            path: target,
            source: err,
        });
    }
    Ok(target)
}

/// Verifies that an existing bundle directory contains no `.qjsb` files and matches `expected_digest`.
///
/// # Errors
///
/// Returns [`BundleError`] on missing directory, `.qjsb` presence, or digest mismatch.
pub fn verify_bundle(bundle_root: &Path, expected_digest: &str) -> Result<String, BundleError> {
    if !is_valid_sha256(expected_digest) {
        return Err(BundleError::InvalidDigest(expected_digest.to_owned()));
    }
    let meta = at(bundle_root, fs::symlink_metadata(bundle_root))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(BundleError::Io {
            path: bundle_root.to_owned(),
            source: io::Error::new(
                io::ErrorKind::InvalidInput,
                "bundle root is not a directory",
            ),
        });
    }
    verify_no_qjsb(bundle_root)?;
    let actual = content_digest(bundle_root)?;
    if actual != expected_digest {
        return Err(BundleError::DigestMismatch {
            expected: expected_digest.to_owned(),
            actual,
        });
    }
    Ok(actual)
}

/// Recursively deletes a read-only (`0500`/`0400`) bundle directory or file.
///
/// # Errors
///
/// Returns [`BundleError`] if permissions cannot be relaxed or removal fails.
pub fn remove_bundle_tree(path: &Path) -> Result<(), BundleError> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(BundleError::Io {
                path: path.to_owned(),
                source,
            });
        }
    };
    if meta.file_type().is_symlink() {
        return at(path, fs::remove_file(path));
    }
    if meta.is_dir() {
        make_tree_writable(path)?;
        return at(path, fs::remove_dir_all(path));
    }
    at(
        path,
        fs::set_permissions(path, Permissions::from_mode(FILE_MODE_WRITABLE)),
    )?;
    at(path, fs::remove_file(path))
}

fn copy_tree_readonly(
    source_root: &Path,
    src_dir: &Path,
    dst_dir: &Path,
    is_root: bool,
) -> Result<(), BundleError> {
    for entry in at(src_dir, fs::read_dir(src_dir))? {
        let entry = at(src_dir, entry)?;
        let name = entry.file_name();
        if is_root && name == ".git" {
            continue;
        }
        let src_path = entry.path();
        let dst_path = dst_dir.join(&name);
        let file_type = at(&src_path, fs::symlink_metadata(&src_path))?.file_type();
        if file_type.is_symlink() {
            let resolved = at(&src_path, fs::canonicalize(&src_path))?;
            if !resolved.starts_with(source_root) {
                return Err(DigestError::SymlinkEscape(src_path).into());
            }
            let link_target = at(&src_path, fs::read_link(&src_path))?;
            at(&dst_path, symlink(link_target, &dst_path))?;
        } else if file_type.is_dir() {
            at(&dst_path, fs::create_dir(&dst_path))?;
            copy_tree_readonly(source_root, &src_path, &dst_path, false)?;
            at(
                &dst_path,
                fs::set_permissions(&dst_path, Permissions::from_mode(DIR_MODE_READONLY)),
            )?;
        } else if file_type.is_file() {
            let mut reader = at(&src_path, File::open(&src_path))?;
            let mut writer = at(&dst_path, File::create_new(&dst_path))?;
            at(&dst_path, io::copy(&mut reader, &mut writer))?;
            at(
                &dst_path,
                fs::set_permissions(&dst_path, Permissions::from_mode(FILE_MODE_READONLY)),
            )?;
        }
    }
    Ok(())
}

fn make_tree_writable(dir: &Path) -> Result<(), BundleError> {
    at(
        dir,
        fs::set_permissions(dir, Permissions::from_mode(DIR_MODE_WRITABLE)),
    )?;
    for entry in at(dir, fs::read_dir(dir))? {
        let entry = at(dir, entry)?;
        let path = entry.path();
        let meta = at(&path, fs::symlink_metadata(&path))?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            make_tree_writable(&path)?;
        } else {
            at(
                &path,
                fs::set_permissions(&path, Permissions::from_mode(FILE_MODE_WRITABLE)),
            )?;
        }
    }
    Ok(())
}

fn ensure_dir_mode(dir: &Path, mode: u32) -> Result<(), BundleError> {
    at(dir, fs::create_dir_all(dir))?;
    at(dir, fs::set_permissions(dir, Permissions::from_mode(mode)))
}

fn at<T>(path: &Path, result: io::Result<T>) -> Result<T, BundleError> {
    result.map_err(|source| BundleError::Io {
        path: path.to_owned(),
        source,
    })
}
