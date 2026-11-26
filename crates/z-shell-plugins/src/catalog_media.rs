//! Bounded, SHA-256 verified, provenance-cached preview media loader for plugin catalogs.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Cursor, Read, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use image::imageops::FilterType;
use image::{ImageFormat, ImageReader, Limits};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use thiserror::Error;
use z_shell_config::{PluginSourceKind, PluginSourceSettings, ShellPaths};

use super::catalog::source_provenance_key;
use super::digest::is_valid_sha256;
use super::net::{self, CancelToken};
use super::registry::OfflinePolicy;

/// Maximum preview thumbnail width in pixels.
pub const MAX_PREVIEW_WIDTH: u32 = 640;
/// Maximum preview thumbnail height in pixels.
pub const MAX_PREVIEW_HEIGHT: u32 = 360;
/// Maximum encoded PNG payload size in bytes (matching the 200 KB bus asset budget).
pub const MAX_PREVIEW_PNG_BYTES: usize = 200_000;
const MAX_RAW_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const MAX_INPUT_DIMENSION: u32 = 4096;

/// Error returned while fetching, verifying, or transcoding catalog preview media.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum CatalogMediaError {
    /// Invalid asset reference or expected SHA-256 digest.
    #[error("invalid catalog preview parameter: {0}")]
    InvalidInput(String),
    /// Remote preview media cannot be fetched in offline mode without a verified cache entry.
    #[error("preview asset unavailable in offline mode")]
    OfflineBlocked,
    /// Cooperative cancellation was triggered (for example, `offline_mode` switched to true).
    #[error("preview fetch cancelled")]
    Cancelled,
    /// Local preview asset resolved outside configured source roots.
    #[error("local preview asset {0} escapes configured catalog source root")]
    PathEscapesRoot(PathBuf),
    /// Remote HTTP fetch failed.
    #[error("failed to fetch preview asset: {0}")]
    Fetch(String),
    /// Downloaded or read bytes did not match the declared SHA-256 digest.
    #[error("preview asset sha256 mismatch: expected {expected}, got {actual}")]
    DigestMismatch {
        /// Expected `sha256:<64-hex>` digest.
        expected: String,
        /// Actual `sha256:<64-hex>` digest.
        actual: String,
    },
    /// Decoded asset is not a supported raster image (`png`, `jpeg`, `webp`).
    #[error("unsupported preview image: {0}")]
    UnsupportedImage(String),
    /// Encoded PNG could not fit within [`MAX_PREVIEW_PNG_BYTES`].
    #[error("encoded preview PNG ({actual} bytes) exceeds {max} byte budget")]
    ExceedsByteBudget {
        /// Encoded size in bytes.
        actual: usize,
        /// Configured limit in bytes.
        max: usize,
    },
    /// Filesystem I/O failure.
    #[error("catalog media I/O error at {path}: {source}")]
    Io {
        /// Affected filesystem path.
        path: PathBuf,
        /// Underlying OS error.
        #[source]
        source: io::Error,
    },
}

/// Computes the deterministic provenance-bound cache file path for a catalog preview asset.
#[must_use]
pub fn preview_cache_path(
    paths: &ShellPaths,
    source: &PluginSourceSettings,
    asset_url: &str,
    expected_sha256: &str,
) -> PathBuf {
    let mut hasher = Sha256::new();
    hasher.update(b"preview-v1|");
    hasher.update(source_provenance_key(source).as_bytes());
    hasher.update(b"|");
    hasher.update(asset_url.as_bytes());
    hasher.update(b"|");
    hasher.update(expected_sha256.as_bytes());
    paths
        .plugin_catalog_cache_dir()
        .join("media")
        .join(format!("{:x}.png", hasher.finalize()))
}

/// Loads a cached preview PNG or fetches, SHA-256-verifies, downscales (`<= 640x360`), and
/// transcodes (`<= 200,000` bytes PNG) the asset into a `0600` provenance-keyed cache file.
///
/// # Errors
///
/// Returns [`CatalogMediaError`] on invalid digest, offline policy, cancellation, root escape,
/// HTTP error, digest mismatch, unsupported format, or oversized PNG encoding.
pub fn load_or_fetch_preview_png(
    paths: &ShellPaths,
    source: &PluginSourceSettings,
    asset_url: &str,
    expected_sha256: &str,
    policy: OfflinePolicy,
    cancel: Option<&Arc<CancelToken>>,
) -> Result<Vec<u8>, CatalogMediaError> {
    if !is_valid_sha256(expected_sha256) {
        return Err(CatalogMediaError::InvalidInput(format!(
            "expected sha256:<64-hex>, got {expected_sha256:?}"
        )));
    }
    if asset_url.trim().is_empty() || asset_url.chars().any(char::is_control) {
        return Err(CatalogMediaError::InvalidInput(
            "preview asset URL must be non-empty without control characters".to_owned(),
        ));
    }

    let cache_path = preview_cache_path(paths, source, asset_url, expected_sha256);
    if let Some(cached) = read_cached_png(&cache_path) {
        return Ok(cached);
    }

    if cancel.is_some_and(|token| token.is_cancelled()) {
        return Err(CatalogMediaError::Cancelled);
    }

    let is_remote = asset_url.starts_with("https://") || asset_url.starts_with("http://");
    let raw_bytes = if is_remote {
        if matches!(policy, OfflinePolicy::Offline) {
            return Err(CatalogMediaError::OfflineBlocked);
        }
        if source.kind == PluginSourceKind::HttpsJson
            && source.url.starts_with("https://")
            && !asset_url.starts_with("https://")
        {
            return Err(CatalogMediaError::InvalidInput(
                "https:// catalog source may only fetch https:// preview assets".to_owned(),
            ));
        }
        let resp = net::get_validated_cancellable(asset_url, None, cancel).map_err(|reason| {
            if cancel.is_some_and(|token| token.is_cancelled()) {
                CatalogMediaError::Cancelled
            } else {
                CatalogMediaError::Fetch(reason)
            }
        })?;
        net::read_body_bounded(resp, MAX_RAW_PREVIEW_BYTES, cancel).map_err(|reason| {
            if cancel.is_some_and(|token| token.is_cancelled()) {
                CatalogMediaError::Cancelled
            } else {
                CatalogMediaError::Fetch(reason)
            }
        })?
    } else {
        let local_path = resolve_contained_local_asset(source, asset_url)?;
        read_bounded_file(&local_path, MAX_RAW_PREVIEW_BYTES)?
    };

    let actual_sha = format!("sha256:{:x}", Sha256::digest(&raw_bytes));
    if actual_sha != expected_sha256 {
        return Err(CatalogMediaError::DigestMismatch {
            expected: expected_sha256.to_owned(),
            actual: actual_sha,
        });
    }

    let png_bytes = transcode_bounded_png(&raw_bytes)?;
    write_atomic_0600(&cache_path, &png_bytes)?;
    Ok(png_bytes)
}

fn read_cached_png(path: &Path) -> Option<Vec<u8>> {
    let bytes = read_bounded_file(path, MAX_PREVIEW_PNG_BYTES).ok()?;
    if image::guess_format(&bytes).ok()? == ImageFormat::Png {
        Some(bytes)
    } else {
        None
    }
}

fn resolve_contained_local_asset(
    source: &PluginSourceSettings,
    asset_ref: &str,
) -> Result<PathBuf, CatalogMediaError> {
    let mut allowed_roots = Vec::new();
    if let Some(seed_dir) = &source.local_seed_dir
        && let Ok(canon) = fs::canonicalize(seed_dir)
        && canon.is_dir()
    {
        allowed_roots.push(canon);
    }
    if source.kind == PluginSourceKind::LocalFile
        && let Ok(canon_index) = fs::canonicalize(&source.url)
        && let Some(parent) = canon_index.parent()
    {
        allowed_roots.push(parent.to_path_buf());
    }
    if allowed_roots.is_empty() {
        return Err(CatalogMediaError::PathEscapesRoot(PathBuf::from(asset_ref)));
    }

    let raw_path = Path::new(asset_ref);
    let candidate = if raw_path.is_absolute() {
        fs::canonicalize(raw_path).map_err(|err| CatalogMediaError::Io {
            path: raw_path.to_path_buf(),
            source: err,
        })?
    } else {
        let mut resolved = None;
        for root in &allowed_roots {
            let joined = root.join(raw_path);
            if let Ok(canon) = fs::canonicalize(&joined) {
                resolved = Some(canon);
                break;
            }
        }
        resolved.ok_or_else(|| CatalogMediaError::Io {
            path: raw_path.to_path_buf(),
            source: io::Error::new(io::ErrorKind::NotFound, "local preview asset not found"),
        })?
    };

    if !allowed_roots
        .iter()
        .any(|root| candidate.starts_with(root) && &candidate != root)
    {
        return Err(CatalogMediaError::PathEscapesRoot(candidate));
    }
    Ok(candidate)
}

fn read_bounded_file(path: &Path, max_bytes: usize) -> Result<Vec<u8>, CatalogMediaError> {
    let meta = fs::metadata(path).map_err(|source| CatalogMediaError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if !meta.is_file() {
        return Err(CatalogMediaError::Io {
            path: path.to_path_buf(),
            source: io::Error::new(io::ErrorKind::InvalidInput, "not a regular file"),
        });
    }
    if meta.len() > max_bytes as u64 {
        return Err(CatalogMediaError::ExceedsByteBudget {
            actual: usize::try_from(meta.len()).unwrap_or(usize::MAX),
            max: max_bytes,
        });
    }
    let file = fs::File::open(path).map_err(|source| CatalogMediaError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut bytes = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0));
    file.take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|source| CatalogMediaError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    if bytes.len() > max_bytes {
        return Err(CatalogMediaError::ExceedsByteBudget {
            actual: bytes.len(),
            max: max_bytes,
        });
    }
    Ok(bytes)
}

fn transcode_bounded_png(bytes: &[u8]) -> Result<Vec<u8>, CatalogMediaError> {
    let format = image::guess_format(bytes)
        .map_err(|err| CatalogMediaError::UnsupportedImage(err.to_string()))?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err(CatalogMediaError::UnsupportedImage(format!(
            "unsupported image format {format:?}"
        )));
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_INPUT_DIMENSION);
    limits.max_image_height = Some(MAX_INPUT_DIMENSION);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let mut img = reader
        .decode()
        .map_err(|err| CatalogMediaError::UnsupportedImage(err.to_string()))?;

    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err(CatalogMediaError::UnsupportedImage(
            "image has zero dimensions".to_owned(),
        ));
    }
    if w > MAX_PREVIEW_WIDTH || h > MAX_PREVIEW_HEIGHT {
        img = img.resize(MAX_PREVIEW_WIDTH, MAX_PREVIEW_HEIGHT, FilterType::Triangle);
    }

    for attempt in 0..8 {
        if attempt > 0 {
            let next_w = ((img.width() * 4) / 5).max(32);
            let next_h = ((img.height() * 4) / 5).max(32);
            if next_w == img.width() && next_h == img.height() {
                break;
            }
            img = img.resize(next_w, next_h, FilterType::Triangle);
        }
        let mut encoded = Vec::new();
        img.write_to(&mut Cursor::new(&mut encoded), ImageFormat::Png)
            .map_err(|err| CatalogMediaError::UnsupportedImage(err.to_string()))?;
        if encoded.len() <= MAX_PREVIEW_PNG_BYTES {
            return Ok(encoded);
        }
    }

    let mut final_encoded = Vec::new();
    img.write_to(&mut Cursor::new(&mut final_encoded), ImageFormat::Png)
        .map_err(|err| CatalogMediaError::UnsupportedImage(err.to_string()))?;
    Err(CatalogMediaError::ExceedsByteBudget {
        actual: final_encoded.len(),
        max: MAX_PREVIEW_PNG_BYTES,
    })
}

fn write_atomic_0600(target: &Path, bytes: &[u8]) -> Result<(), CatalogMediaError> {
    let dir = target.parent().unwrap_or(target);
    DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(dir)
        .map_err(|source| CatalogMediaError::Io {
            path: dir.to_path_buf(),
            source,
        })?;
    let mut temp = NamedTempFile::new_in(dir).map_err(|source| CatalogMediaError::Io {
        path: dir.to_path_buf(),
        source,
    })?;
    temp.as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|source| CatalogMediaError::Io {
            path: temp.path().to_path_buf(),
            source,
        })?;
    temp.write_all(bytes)
        .map_err(|source| CatalogMediaError::Io {
            path: temp.path().to_path_buf(),
            source,
        })?;
    temp.as_file()
        .sync_all()
        .map_err(|source| CatalogMediaError::Io {
            path: temp.path().to_path_buf(),
            source,
        })?;
    temp.persist(target).map_err(|err| CatalogMediaError::Io {
        path: target.to_path_buf(),
        source: err.error,
    })?;
    // Ensure target mode stays 0600 even on existing filesystems with different umask.
    let _ = OpenOptions::new().read(true).open(target).and_then(|file| {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
    });
    Ok(())
}
