//! Deterministically ordered, paginatable wallpaper discovery.

use crate::cache::{Cache, CacheError, StageError, short_hash};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use z_shell_protocol::MediaRef;

const MAX_ENTRIES: usize = 512;
// Limit decode work even in directories full of images with damaged headers or bodies.
const MAX_CANDIDATES: usize = 4096;

/// Picker entry for a supported image at its canonical source path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct CatalogEntry {
    /// Deterministic identifier derived from the canonical source path.
    pub id: String,
    /// Display name without the extension.
    pub name: String,
    /// Original image, not the runtime media copy.
    pub source_path: PathBuf,
    /// Natural image width in pixels.
    pub width: u32,
    /// Natural image height in pixels.
    pub height: u32,
    /// Bounded PNG preview staged in the runtime media directory.
    pub thumbnail: MediaRef,
}

pub(crate) fn scan(directories: &[String], cache: &Cache) -> Result<Vec<CatalogEntry>, CacheError> {
    scan_with_cancel(directories, cache, None)
}

pub(crate) fn scan_with_cancel(
    directories: &[String],
    cache: &Cache,
    cancelled: Option<&AtomicBool>,
) -> Result<Vec<CatalogEntry>, CacheError> {
    let is_cancelled = || cancelled.is_some_and(|flag| flag.load(Ordering::Relaxed));
    // Order by canonical filename, then by full canonical path. The same source reached
    // through different directories or symlinks has exactly the same key.
    let mut candidates = BTreeSet::new();
    let home = env::var_os("HOME").map(PathBuf::from);
    for raw in directories {
        if is_cancelled() {
            return Ok(Vec::new());
        }
        let expanded;
        let directory = if let Some(relative) = raw.strip_prefix("~/") {
            let Some(home) = &home else { continue };
            expanded = home.join(relative.trim_start_matches('/'));
            expanded.as_path()
        } else {
            Path::new(raw)
        };
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                tracing::warn!(path = %directory.display(), %error, "could not scan wallpaper directory");
                continue;
            }
        };
        for entry in entries.filter_map(Result::ok) {
            if is_cancelled() {
                return Ok(Vec::new());
            }
            let path = entry.path();
            if !has_image_extension(&path)
                || !entry
                    .file_type()
                    .is_ok_and(|kind| kind.is_file() || kind.is_symlink())
            {
                continue;
            }
            if let Ok(source) = cache.resolve_source(&path)
                && source.is_file()
                && let Some(name) = source.file_name()
            {
                candidates.insert((name.to_owned(), source));
                if candidates.len() > MAX_CANDIDATES {
                    candidates.pop_last();
                }
            }
        }
    }

    let mut catalog = Vec::with_capacity(candidates.len().min(MAX_ENTRIES));
    for (filename, source_path) in candidates {
        if is_cancelled() {
            return Ok(catalog);
        }
        let cached = match cache.thumbnail(&source_path) {
            Ok(cached) => cached,
            Err(StageError::Image(_)) => continue,
            Err(StageError::Cache(error)) => return Err(error),
        };
        catalog.push(CatalogEntry {
            id: short_hash(source_path.as_os_str().as_encoded_bytes()),
            name: source_path
                .file_stem()
                .unwrap_or(&filename)
                .to_string_lossy()
                .into_owned(),
            source_path,
            width: cached.width,
            height: cached.height,
            thumbnail: cached.media,
        });
        if catalog.len() == MAX_ENTRIES {
            break;
        }
    }
    Ok(catalog)
}

fn has_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            ["png", "jpg", "jpeg", "webp"]
                .iter()
                .any(|supported| extension.eq_ignore_ascii_case(supported))
        })
}
