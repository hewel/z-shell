//! Deterministic content identity shared with the plugin composer.

use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// A plugin tree could not be hashed as a v1 content digest.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum DigestError {
    /// A path in the tree could not be inspected or read.
    #[error("cannot read plugin content at {path}: {source}")]
    Io {
        /// Path being inspected.
        path: PathBuf,
        /// Underlying filesystem failure.
        source: io::Error,
    },
    /// A symbolic link points outside the plugin root.
    #[error("symlink escapes plugin root: {0}")]
    SymlinkEscape(PathBuf),
    /// A directory symlink recurses into an ancestor.
    #[error("plugin directory cycle at {0}")]
    DirectoryCycle(PathBuf),
    /// A file name cannot be encoded as required by the digest format.
    #[error("plugin path is not UTF-8: {0}")]
    NonUtf8(PathBuf),
    /// The file's actual length did not match the framed length.
    #[error("plugin file changed while hashing: {0}")]
    Changed(PathBuf),
}

/// Hashes regular files by their logical UTF-8 paths, including contained symlink targets.
///
/// The root `.git` path is not plugin content.
///
/// # Errors
///
/// Returns an error for escaping or unresolvable symlinks, directory cycles, non-UTF-8
/// file paths, files changing size during hashing, or unreadable content.
pub fn content_digest(root: &Path) -> Result<String, DigestError> {
    let root = at(root, fs::canonicalize(root))?;
    let mut files = Vec::new();
    collect_files(&root, &root, Path::new(""), &mut Vec::new(), &mut files)?;
    files.sort_unstable();
    let mut hash = Sha256::new();
    for relative in files {
        let path = root.join(&relative);
        let mut file = at(&path, File::open(&path))?;
        let len = at(&path, file.metadata())?.len();
        hash.update(relative.as_bytes());
        hash.update(b"\0");
        at(&path, write!(hash, "{len}\0"))?;
        if at(&path, io::copy(&mut file, &mut hash))? != len {
            return Err(DigestError::Changed(path));
        }
        hash.update(b"\0");
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}

fn collect_files(
    root: &Path,
    dir: &Path,
    relative: &Path,
    ancestors: &mut Vec<PathBuf>,
    files: &mut Vec<String>,
) -> Result<(), DigestError> {
    ancestors.push(dir.to_owned());
    for entry in at(dir, fs::read_dir(dir))? {
        let entry = at(dir, entry)?;
        let path = entry.path();
        let mut kind = at(&path, entry.file_type())?;
        let name = entry.file_name();
        let target = if kind.is_symlink() {
            let target = at(&path, fs::canonicalize(&path))?;
            if !target.starts_with(root) {
                return Err(DigestError::SymlinkEscape(path));
            }
            kind = at(&target, fs::metadata(&target))?.file_type();
            if kind.is_dir() && ancestors.contains(&target) {
                return Err(DigestError::DirectoryCycle(path));
            }
            target
        } else {
            path
        };
        if relative.as_os_str().is_empty() && name == ".git" {
            continue;
        }
        if kind.is_dir() {
            collect_files(root, &target, &relative.join(name), ancestors, files)?;
        } else if kind.is_file() {
            let relative = relative.join(name);
            files.push(
                relative
                    .into_os_string()
                    .into_string()
                    .map_err(|_| DigestError::NonUtf8(target))?,
            );
        }
    }
    ancestors.pop();
    Ok(())
}

fn at<T>(path: &Path, result: io::Result<T>) -> Result<T, DigestError> {
    result.map_err(|source| DigestError::Io {
        path: path.to_owned(),
        source,
    })
}
