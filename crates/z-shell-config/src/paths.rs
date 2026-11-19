//! Secure XDG directory resolution for settings, durable state, bus sockets, and media cache.

use std::env;
use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use thiserror::Error;

const APP_DIR_NAME: &str = "z-shell";
const SETTINGS_FILE_NAME: &str = "settings.toml";
const STATE_FILE_NAME: &str = "state.toml";
const STATE_LOCK_FILE_NAME: &str = "state.lock";
const MEDIA_DIR_NAME: &str = "media";

/// Error returned while resolving or validating XDG shell directories.
#[derive(Debug, Error)]
pub enum PathError {
    /// Required environment directory could not be resolved (no silent `/tmp` fallback).
    #[error("unable to resolve required directory: {0}")]
    MissingBaseDir(&'static str),
    /// A runtime directory failed ownership, symlink, or permission security verification.
    #[error("insecure runtime directory {path}: {reason}")]
    InsecureRuntimeDir {
        /// Rejected path.
        path: PathBuf,
        /// Explanation of the security check that failed.
        reason: String,
    },
    /// Filesystem directory creation or metadata inspection failed.
    #[error("failed to prepare directory {path}: {source}")]
    Io {
        /// Directory path that failed.
        path: PathBuf,
        /// Underlying OS error.
        #[source]
        source: io::Error,
    },
}

/// Resolved filesystem locations for a single shell daemon instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellPaths {
    config_dir: PathBuf,
    state_dir: PathBuf,
    runtime_dir: PathBuf,
    socket_path: PathBuf,
    host_socket_path: PathBuf,
    daemon_lock_path: PathBuf,
}

impl ShellPaths {
    /// Resolves paths from standard XDG environment variables (`XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
    /// `XDG_RUNTIME_DIR`, and `WAYLAND_DISPLAY`).
    ///
    /// Refuses to silently fall back to a shared `/tmp` directory when `XDG_RUNTIME_DIR` is missing.
    ///
    /// # Errors
    ///
    /// Returns [`PathError::MissingBaseDir`] if `XDG_RUNTIME_DIR` or config/state roots are unset.
    pub fn from_env() -> Result<Self, PathError> {
        let home = env::var_os("HOME").map(PathBuf::from);
        let config_base = env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|h| h.join(".config")))
            .ok_or(PathError::MissingBaseDir("XDG_CONFIG_HOME or HOME"))?;
        let state_base = env::var_os("XDG_STATE_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|h| h.join(".local/state")))
            .ok_or(PathError::MissingBaseDir("XDG_STATE_HOME or HOME"))?;
        let runtime_base = env::var_os("XDG_RUNTIME_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .ok_or(PathError::MissingBaseDir("XDG_RUNTIME_DIR"))?;
        let display = env::var("WAYLAND_DISPLAY")
            .ok()
            .filter(|s| !s.is_empty() && !s.contains('/') && !s.contains(".."))
            .unwrap_or_else(|| "wayland-0".to_owned());

        let config_dir = config_base.join(APP_DIR_NAME);
        let state_dir = state_base.join(APP_DIR_NAME);
        let runtime_dir = runtime_base.join(APP_DIR_NAME);
        let socket_path = runtime_dir.join(format!("bus-{display}.sock"));
        let host_socket_path = runtime_dir.join(format!("host-{display}.sock"));
        let daemon_lock_path = runtime_dir.join(format!("daemon-{display}.lock"));

        Ok(Self {
            config_dir,
            state_dir,
            runtime_dir,
            socket_path,
            host_socket_path,
            daemon_lock_path,
        })
    }

    /// Constructs explicit paths for tests or custom daemon invocations without consulting env vars.
    #[must_use]
    pub fn from_roots(
        config_dir: PathBuf,
        state_dir: PathBuf,
        runtime_dir: PathBuf,
        socket_path: PathBuf,
    ) -> Self {
        let host_socket_path = socket_path
            .parent()
            .unwrap_or(&runtime_dir)
            .join("host.sock");
        let daemon_lock_path = socket_path
            .parent()
            .unwrap_or(&runtime_dir)
            .join("daemon.lock");
        Self {
            config_dir,
            state_dir,
            runtime_dir,
            socket_path,
            host_socket_path,
            daemon_lock_path,
        }
    }

    /// Returns a copy with an overridden privileged host control socket path.
    #[must_use]
    pub fn with_host_socket_path(mut self, host_socket_path: PathBuf) -> Self {
        self.host_socket_path = host_socket_path;
        self
    }

    /// Returns the configuration directory (`$XDG_CONFIG_HOME/z-shell`).
    #[must_use]
    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    /// Returns the `settings.toml` file path.
    #[must_use]
    pub fn settings_file(&self) -> PathBuf {
        self.config_dir.join(SETTINGS_FILE_NAME)
    }

    /// Returns the state directory (`$XDG_STATE_HOME/z-shell`).
    #[must_use]
    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    /// Returns the `state.toml` file path.
    #[must_use]
    pub fn state_file(&self) -> PathBuf {
        self.state_dir.join(STATE_FILE_NAME)
    }

    /// Returns the cross-display `flock` lockfile path protecting `state.toml` mutations.
    #[must_use]
    pub fn state_lock_file(&self) -> PathBuf {
        self.state_dir.join(STATE_LOCK_FILE_NAME)
    }

    /// Returns the runtime directory (`$XDG_RUNTIME_DIR/z-shell`).
    #[must_use]
    pub fn runtime_dir(&self) -> &Path {
        &self.runtime_dir
    }

    /// Returns the restricted host media cache directory (`$XDG_RUNTIME_DIR/z-shell/media`).
    #[must_use]
    pub fn media_dir(&self) -> PathBuf {
        self.runtime_dir.join(MEDIA_DIR_NAME)
    }

    /// Returns the public bus Unix domain socket path.
    #[must_use]
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// Returns the privileged host control Unix domain socket path.
    #[must_use]
    pub fn host_socket_path(&self) -> &Path {
        &self.host_socket_path
    }

    /// Returns the single-instance `flock` lockfile path for this daemon display.
    #[must_use]
    pub fn daemon_lock_path(&self) -> &Path {
        &self.daemon_lock_path
    }

    /// Ensures directories exist and verifies that runtime directories are absolute, real (non-symlink)
    /// directories owned by the current UID with strict `0700` permissions.
    ///
    /// # Errors
    ///
    /// Returns [`PathError::InsecureRuntimeDir`] or [`PathError::Io`] on security or I/O failure.
    pub fn ensure_dirs(&self) -> Result<(), PathError> {
        let uid = current_uid()?;
        for dir in [&self.config_dir, &self.state_dir] {
            create_dir_all(dir)?;
        }
        ensure_private_dir(&self.runtime_dir, uid)?;
        ensure_private_dir(&self.media_dir(), uid)?;
        for sock in [&self.socket_path, &self.host_socket_path] {
            if let Some(parent) = sock.parent()
                && parent != self.runtime_dir
            {
                ensure_private_dir(parent, uid)?;
            }
        }
        Ok(())
    }
}

fn current_uid() -> Result<u32, PathError> {
    fs::metadata("/proc/self")
        .map(|meta| meta.uid())
        .map_err(|source| PathError::Io {
            path: PathBuf::from("/proc/self"),
            source,
        })
}

fn create_dir_all(path: &Path) -> Result<(), PathError> {
    fs::create_dir_all(path).map_err(|source| PathError::Io {
        path: path.to_path_buf(),
        source,
    })
}

fn ensure_private_dir(path: &Path, expected_uid: u32) -> Result<(), PathError> {
    if !path.is_absolute() {
        return Err(PathError::InsecureRuntimeDir {
            path: path.to_path_buf(),
            reason: "runtime directory must be an absolute path".to_owned(),
        });
    }
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(PathError::InsecureRuntimeDir {
                    path: path.to_path_buf(),
                    reason: "path exists and is a symlink or non-directory".to_owned(),
                });
            }
            if meta.uid() != expected_uid {
                return Err(PathError::InsecureRuntimeDir {
                    path: path.to_path_buf(),
                    reason: format!("owned by uid {}, expected {expected_uid}", meta.uid()),
                });
            }
            let mode = meta.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|source| {
                    PathError::Io {
                        path: path.to_path_buf(),
                        source,
                    }
                })?;
            }
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(path)
                .map_err(|source| PathError::Io {
                    path: path.to_path_buf(),
                    source,
                })?;
            // Re-verify after creation in case of umask or pre-existing parent quirks.
            let meta = fs::symlink_metadata(path).map_err(|source| PathError::Io {
                path: path.to_path_buf(),
                source,
            })?;
            if meta.file_type().is_symlink() || !meta.is_dir() || meta.uid() != expected_uid {
                return Err(PathError::InsecureRuntimeDir {
                    path: path.to_path_buf(),
                    reason: "created directory failed post-creation ownership check".to_owned(),
                });
            }
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|source| {
                PathError::Io {
                    path: path.to_path_buf(),
                    source,
                }
            })?;
        }
        Err(source) => {
            return Err(PathError::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    }
    Ok(())
}
