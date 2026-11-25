//! Bounded, zip-slip/tar-bomb-hardened `.tar.gz` and `.tar.zst` archive unpacking.

use std::fs::{self, File, Permissions};
use std::io::{self, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use tar::{Archive, EntryType};
use tempfile::tempdir_in;
use thiserror::Error;

use super::bundle::{BundleError, materialize_bundle};
use super::digest::{DigestError, content_digest, is_valid_sha256};
use super::manifest::{Manifest, ManifestError};
use super::net;
use super::registry::OfflinePolicy;

/// Maximum compressed archive download/read size (`32 MiB`).
pub const MAX_ARCHIVE_BYTES: u64 = 32 * 1024 * 1024;
/// Maximum total unpacked payload size across all entries (`64 MiB`).
pub const MAX_UNPACKED_BYTES: u64 = 64 * 1024 * 1024;
/// Maximum number of entries allowed inside a single plugin archive.
pub const MAX_ARCHIVE_FILES: usize = 2048;
/// Maximum size of a single unpacked file (`16 MiB`).
pub const MAX_SINGLE_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// Maximum compression expansion ratio permitted above [`EXPANSION_RATIO_FLOOR_BYTES`].
pub const MAX_EXPANSION_RATIO: u64 = 20;
/// Minimum unpacked byte count before [`MAX_EXPANSION_RATIO`] is enforced.
pub const EXPANSION_RATIO_FLOOR_BYTES: u64 = 1024 * 1024;

/// Verified plugin bundle unpacked from a `.tar.gz` or `.tar.zst` archive.
#[derive(Debug)]
#[non_exhaustive]
pub struct UnpackedArchive {
    /// Original archive URL or canonical local path.
    pub source: String,
    /// Verified `sha256:<64-hex>` digest of the compressed archive bytes.
    pub archive_sha256: String,
    /// Path to the committed read-only plugin bundle.
    pub bundle_root: PathBuf,
    /// Statically validated manifest loaded from the bundle.
    pub manifest: Manifest,
    /// Deterministic `sha256:<64-hex>` content digest of the unpacked bundle tree.
    pub content_digest: String,
}

/// Error returned while fetching, verifying, or unpacking a plugin archive.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ArchiveError {
    /// Remote archive fetching is forbidden while offline mode is active.
    #[error("remote plugin archive cannot be fetched in offline mode")]
    Offline,
    /// The archive URL, path, or expected SHA-256 digest is invalid.
    #[error("invalid plugin archive parameter: {0}")]
    InvalidInput(String),
    /// Remote HTTP download failed.
    #[error("failed to download plugin archive: {0}")]
    Http(String),
    /// Compressed archive exceeded [`MAX_ARCHIVE_BYTES`].
    #[error("plugin archive exceeds maximum size of {max} bytes")]
    ArchiveTooLarge {
        /// Enforced byte limit.
        max: u64,
    },
    /// Compressed archive SHA-256 digest did not match the expected value.
    #[error("archive sha256 mismatch: expected {expected}, got {actual}")]
    ArchiveDigestMismatch {
        /// Expected `sha256:<64-hex>`.
        expected: String,
        /// Observed `sha256:<64-hex>`.
        actual: String,
    },
    /// Archive compression magic bytes were neither gzip nor zstd.
    #[error("unsupported archive format; expected .tar.gz or .tar.zst")]
    UnsupportedFormat,
    /// An entry inside the archive violated path, type, or permission safety rules.
    #[error("unsafe archive entry {path:?}: {reason}")]
    UnsafeEntry {
        /// Offending archive entry path.
        path: String,
        /// Human-readable violation summary.
        reason: &'static str,
    },
    /// Archive exceeded unpacked size, file count, or expansion ratio bounds.
    #[error("archive rejected as tar-bomb: {0}")]
    TarBomb(&'static str),
    /// Filesystem I/O failure during unpacking.
    #[error("archive I/O error at {path}: {source}")]
    Io {
        /// Affected filesystem path.
        path: PathBuf,
        /// Underlying OS error.
        #[source]
        source: io::Error,
    },
    /// Manifest validation failed on the unpacked bundle.
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    /// Content digest calculation failed on the unpacked bundle.
    #[error(transparent)]
    Digest(#[from] DigestError),
    /// Immutable bundle materialization failed.
    #[error(transparent)]
    Bundle(#[from] BundleError),
}

/// Fetches (when remote) or reads (when local) a `.tar.gz`/`.tar.zst` archive, verifies
/// `expected_archive_sha256`, safely unpacks it into `staging_dir`, validates `plugin.toml`,
/// and commits an immutable read-only bundle inside `bundles_dir`.
///
/// # Errors
///
/// Returns [`ArchiveError`] on offline policy, HTTP error, archive digest mismatch, zip-slip /
/// tar-bomb / unsafe entry violations, invalid manifest, or bundle I/O failure.
pub fn unpack_archive_bundle(
    staging_dir: &Path,
    bundles_dir: &Path,
    url_or_path: &str,
    expected_archive_sha256: &str,
    policy: OfflinePolicy,
) -> Result<UnpackedArchive, ArchiveError> {
    if !is_valid_sha256(expected_archive_sha256) {
        return Err(ArchiveError::InvalidInput(format!(
            "expected sha256:<64-hex>, got {expected_archive_sha256:?}"
        )));
    }
    if url_or_path.trim().is_empty() || url_or_path.chars().any(char::is_control) {
        return Err(ArchiveError::InvalidInput(
            "archive path or URL must be non-empty without control characters".to_owned(),
        ));
    }

    let is_remote = url_or_path.starts_with("https://") || url_or_path.starts_with("http://");
    if is_remote && matches!(policy, OfflinePolicy::Offline) {
        return Err(ArchiveError::Offline);
    }

    at(staging_dir, fs::create_dir_all(staging_dir))?;
    at(
        staging_dir,
        fs::set_permissions(staging_dir, Permissions::from_mode(0o700)),
    )?;
    let stage = at(staging_dir, tempdir_in(staging_dir))?;
    let archive_file_path = stage.path().join("archive.bin");
    let unpacked_dir = stage.path().join("unpacked");
    at(&unpacked_dir, fs::create_dir(&unpacked_dir))?;

    let (source_label, archive_size, actual_sha) = if is_remote {
        let resp = net::get_validated(url_or_path, None).map_err(ArchiveError::Http)?;
        if let Some(len) = resp
            .headers()
            .get("Content-Length")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            && len > MAX_ARCHIVE_BYTES
        {
            return Err(ArchiveError::ArchiveTooLarge {
                max: MAX_ARCHIVE_BYTES,
            });
        }
        let mut reader = resp.into_body().into_reader();
        let (size, sha) = stream_bounded_archive(&mut reader, &archive_file_path)?;
        (url_or_path.to_owned(), size, sha)
    } else {
        let canonical = at(Path::new(url_or_path), fs::canonicalize(url_or_path))?;
        let mut file = at(&canonical, File::open(&canonical))?;
        let (size, sha) = stream_bounded_archive(&mut file, &archive_file_path)?;
        (canonical.to_string_lossy().into_owned(), size, sha)
    };

    if actual_sha != expected_archive_sha256 {
        return Err(ArchiveError::ArchiveDigestMismatch {
            expected: expected_archive_sha256.to_owned(),
            actual: actual_sha,
        });
    }

    let format = sniff_format(&archive_file_path)?;
    let file = at(&archive_file_path, File::open(&archive_file_path))?;
    let buffered = BufReader::new(file);
    match format {
        ArchiveFormat::TarGz => {
            extract_tar(GzDecoder::new(buffered), &unpacked_dir, archive_size)?;
        }
        ArchiveFormat::TarZst => {
            let decoder = zstd::stream::Decoder::new(buffered).map_err(|err| ArchiveError::Io {
                path: archive_file_path.clone(),
                source: err,
            })?;
            extract_tar(decoder, &unpacked_dir, archive_size)?;
        }
    }

    let manifest = Manifest::load(&unpacked_dir)?;
    let content_digest = content_digest(&unpacked_dir)?;
    let bundle_root =
        materialize_bundle(bundles_dir, &manifest.id, &unpacked_dir, &content_digest)?;
    Ok(UnpackedArchive {
        source: source_label,
        archive_sha256: actual_sha,
        bundle_root,
        manifest,
        content_digest,
    })
}

enum ArchiveFormat {
    TarGz,
    TarZst,
}

fn sniff_format(path: &Path) -> Result<ArchiveFormat, ArchiveError> {
    let mut file = at(path, File::open(path))?;
    let mut magic = [0u8; 4];
    let n = at(path, file.read(&mut magic))?;
    if n >= 2 && magic[..2] == [0x1f, 0x8b] {
        return Ok(ArchiveFormat::TarGz);
    }
    if n == 4 && magic == [0x28, 0xb5, 0x2f, 0xfd] {
        return Ok(ArchiveFormat::TarZst);
    }
    Err(ArchiveError::UnsupportedFormat)
}

fn stream_bounded_archive(
    reader: &mut dyn Read,
    dest: &Path,
) -> Result<(u64, String), ArchiveError> {
    let mut out = at(dest, File::create_new(dest))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 16 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|source| ArchiveError::Io {
            path: dest.to_owned(),
            source,
        })?;
        if n == 0 {
            break;
        }
        total = total.saturating_add(n as u64);
        if total > MAX_ARCHIVE_BYTES {
            return Err(ArchiveError::ArchiveTooLarge {
                max: MAX_ARCHIVE_BYTES,
            });
        }
        hasher.update(&buf[..n]);
        at(dest, out.write_all(&buf[..n]))?;
    }
    at(dest, out.flush())?;
    Ok((total, format!("sha256:{:x}", hasher.finalize())))
}

fn extract_tar<R: Read>(
    reader: R,
    dest_root: &Path,
    archive_size: u64,
) -> Result<(), ArchiveError> {
    let mut archive = Archive::new(reader);
    let mut entry_count: usize = 0;
    let mut total_unpacked: u64 = 0;

    let entries = archive.entries().map_err(|source| ArchiveError::Io {
        path: dest_root.to_owned(),
        source,
    })?;
    for entry_res in entries {
        entry_count += 1;
        if entry_count > MAX_ARCHIVE_FILES {
            return Err(ArchiveError::TarBomb("exceeded maximum archive file count"));
        }
        let mut entry = entry_res.map_err(|source| ArchiveError::Io {
            path: dest_root.to_owned(),
            source,
        })?;
        let entry_type = entry.header().entry_type();
        if !matches!(entry_type, EntryType::Regular | EntryType::Directory) {
            let path = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
            return Err(ArchiveError::UnsafeEntry {
                path,
                reason: "only regular files and directories are permitted in plugin archives",
            });
        }
        let mode = entry.header().mode().map_err(|source| ArchiveError::Io {
            path: dest_root.to_owned(),
            source,
        })?;
        if mode & 0o7000 != 0 {
            let path = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
            return Err(ArchiveError::UnsafeEntry {
                path,
                reason: "setuid/setgid/sticky bits are forbidden",
            });
        }
        let rel = sanitize_tar_path(&entry.path_bytes())?;
        if rel.as_os_str().is_empty() {
            if entry_type == EntryType::Directory {
                continue;
            }
            return Err(ArchiveError::UnsafeEntry {
                path: String::new(),
                reason: "empty regular file path",
            });
        }
        if rel
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("qjsb"))
        {
            return Err(ArchiveError::UnsafeEntry {
                path: rel.to_string_lossy().into_owned(),
                reason: "bundled .qjsb bytecode files are forbidden",
            });
        }

        let target = dest_root.join(&rel);
        if entry_type == EntryType::Directory {
            at(&target, fs::create_dir_all(&target))?;
            continue;
        }
        let size = entry.header().size().map_err(|source| ArchiveError::Io {
            path: target.clone(),
            source,
        })?;
        if size > MAX_SINGLE_FILE_BYTES {
            return Err(ArchiveError::TarBomb("single file exceeds maximum size"));
        }
        let projected_total = total_unpacked.saturating_add(size);
        if projected_total > MAX_UNPACKED_BYTES {
            return Err(ArchiveError::TarBomb("total unpacked bytes exceeded limit"));
        }
        if projected_total > EXPANSION_RATIO_FLOOR_BYTES
            && projected_total > archive_size.saturating_mul(MAX_EXPANSION_RATIO)
        {
            return Err(ArchiveError::TarBomb(
                "archive expansion ratio exceeded 20:1",
            ));
        }
        if let Some(parent) = target.parent() {
            at(parent, fs::create_dir_all(parent))?;
        }
        let mut out = at(&target, File::create_new(&target))?;
        let mut limited = (&mut entry).take(MAX_SINGLE_FILE_BYTES + 1);
        let copied = at(&target, io::copy(&mut limited, &mut out))?;
        if copied > MAX_SINGLE_FILE_BYTES || copied != size {
            return Err(ArchiveError::TarBomb(
                "file payload exceeded header or limit",
            ));
        }
        total_unpacked = projected_total;
    }
    Ok(())
}

fn sanitize_tar_path(raw_bytes: &[u8]) -> Result<PathBuf, ArchiveError> {
    let raw = std::str::from_utf8(raw_bytes).map_err(|_| ArchiveError::UnsafeEntry {
        path: String::from_utf8_lossy(raw_bytes).into_owned(),
        reason: "archive entry path must be valid UTF-8",
    })?;
    if raw.starts_with('/') || raw.contains('\\') || raw.contains('\0') {
        return Err(ArchiveError::UnsafeEntry {
            path: raw.to_owned(),
            reason: "archive entry path contains forbidden prefix or separator",
        });
    }
    let mut clean = PathBuf::new();
    for comp in Path::new(raw).components() {
        match comp {
            Component::CurDir => {}
            Component::Normal(seg) => {
                if seg.eq_ignore_ascii_case(".git") {
                    return Err(ArchiveError::UnsafeEntry {
                        path: raw.to_owned(),
                        reason: ".git metadata is forbidden inside archives",
                    });
                }
                clean.push(seg);
            }
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ArchiveError::UnsafeEntry {
                    path: raw.to_owned(),
                    reason: "path traversal is forbidden",
                });
            }
        }
    }
    Ok(clean)
}

fn at<T>(path: &Path, result: io::Result<T>) -> Result<T, ArchiveError> {
    result.map_err(|source| ArchiveError::Io {
        path: path.to_owned(),
        source,
    })
}
