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
const PLUGINS_DIR_NAME: &str = "plugins";
const PLUGINS_REGISTRY_FILE_NAME: &str = "registry.json";
const PLUGINS_LOCK_FILE_NAME: &str = "plugins.lock";
const PLUGINS_BUNDLES_DIR_NAME: &str = "bundles";
const PLUGINS_STAGING_DIR_NAME: &str = "staging";
const PLUGINS_GIT_CACHE_DIR_NAME: &str = "git-cache";
const PLUGIN_BYTECODE_CACHE_DIR_NAME: &str = "plugin-bytecode";
const PLUGIN_CATALOG_CACHE_DIR_NAME: &str = "catalog-cache";
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
    cache_dir: PathBuf,
    runtime_dir: PathBuf,
    display: String,
    socket_path: PathBuf,
    host_socket_path: PathBuf,
    daemon_lock_path: PathBuf,
}

impl ShellPaths {
    /// Resolves paths from standard XDG environment variables (`XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
    /// `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, and `WAYLAND_DISPLAY`).
    ///
    /// Refuses to silently fall back to a shared `/tmp` directory when `XDG_RUNTIME_DIR` is missing.
    ///
    /// # Errors
    ///
    /// Returns [`PathError::MissingBaseDir`] if `XDG_RUNTIME_DIR` or config/state/cache roots are unset.
    pub fn from_env() -> Result<Self, PathError> {
        let (config_dir, state_dir) = config_and_state_dirs(None, None)?;
        let cache_dir =
            env_cache_dir()?.ok_or(PathError::MissingBaseDir("XDG_CACHE_HOME or HOME"))?;
        let runtime_base = env::var_os("XDG_RUNTIME_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .ok_or(PathError::MissingBaseDir("XDG_RUNTIME_DIR"))?;
        let display = env_display();

        let runtime_dir = runtime_base.join(APP_DIR_NAME);
        let socket_path = runtime_dir.join(format!("bus-{display}.sock"));
        let host_socket_path = runtime_dir.join(format!("host-{display}.sock"));
        let daemon_lock_path = runtime_dir.join(format!("daemon-{display}.lock"));

        Ok(Self {
            config_dir,
            state_dir,
            cache_dir,
            runtime_dir,
            display,
            socket_path,
            host_socket_path,
            daemon_lock_path,
        })
    }

    /// Resolves settings and state for local commands without requiring `XDG_RUNTIME_DIR`.
    ///
    /// Overrides name the application directories directly. No sockets or runtime directories
    /// are created; the runtime paths are anchored in the state directory for this local layout.
    ///
    /// # Errors
    ///
    /// Returns [`PathError::MissingBaseDir`] if settings or state paths cannot be resolved.
    pub fn for_local_state(
        config_dir: Option<PathBuf>,
        state_dir: Option<PathBuf>,
    ) -> Result<Self, PathError> {
        let (config_dir, state_dir) = config_and_state_dirs(config_dir, state_dir)?;
        let cache_dir = env_cache_dir()?.unwrap_or_else(|| state_dir.join("cache"));
        let display = env_display();
        let runtime = state_dir.join("runtime");
        let socket = runtime.join("bus.sock");
        Ok(Self::from_roots(config_dir, state_dir, runtime, socket)
            .with_cache_dir(cache_dir)
            .with_display(display))
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
        let cache_dir = state_dir.join("cache");
        Self {
            config_dir,
            state_dir,
            cache_dir,
            runtime_dir,
            display: "default".to_owned(),
            socket_path,
            host_socket_path,
            daemon_lock_path,
        }
    }

    /// Returns a copy with an overridden cache directory (`$XDG_CACHE_HOME/z-shell`).
    #[must_use]
    pub fn with_cache_dir(mut self, cache_dir: PathBuf) -> Self {
        self.cache_dir = cache_dir;
        self
    }

    /// Returns a copy with an overridden Wayland display suffix for per-display runtime files.
    ///
    /// # Panics
    ///
    /// Panics if `display` is empty or contains path separators, `..`, or control characters.
    #[must_use]
    pub fn with_display(mut self, display: impl Into<String>) -> Self {
        let display = display.into();
        assert!(
            is_safe_display(&display),
            "invalid display identifier: {display:?}"
        );
        self.display = display;
        self
    }

    /// Returns a copy with an overridden privileged host control socket path.
    #[must_use]
    pub fn with_host_socket_path(mut self, host_socket_path: PathBuf) -> Self {
        self.host_socket_path = host_socket_path;
        self
    }

    /// Returns the Wayland display identifier associated with these paths.
    #[must_use]
    pub fn display(&self) -> &str {
        &self.display
    }

    /// Returns the cache directory (`$XDG_CACHE_HOME/z-shell`).
    #[must_use]
    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
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

    /// Returns the durable plugin directory.
    #[must_use]
    pub fn plugins_dir(&self) -> PathBuf {
        self.state_dir.join(PLUGINS_DIR_NAME)
    }

    /// Returns the shared plugin registry file path (`registry.json`).
    #[must_use]
    pub fn plugins_registry_file(&self) -> PathBuf {
        self.plugins_dir().join(PLUGINS_REGISTRY_FILE_NAME)
    }

    /// Returns the shared `flock` lockfile protecting plugin mutations.
    #[must_use]
    pub fn plugins_lock_file(&self) -> PathBuf {
        self.plugins_dir().join(PLUGINS_LOCK_FILE_NAME)
    }

    /// Returns the content-addressed immutable plugin bundles directory.
    #[must_use]
    pub fn plugins_bundles_dir(&self) -> PathBuf {
        self.plugins_dir().join(PLUGINS_BUNDLES_DIR_NAME)
    }

    /// Returns the temporary staging directory used during plugin bundle installation.
    #[must_use]
    pub fn plugins_staging_dir(&self) -> PathBuf {
        self.plugins_dir().join(PLUGINS_STAGING_DIR_NAME)
    }

    /// Returns the bare Git repository cache directory for Git plugin/catalog sources.
    #[must_use]
    pub fn plugins_git_cache_dir(&self) -> PathBuf {
        self.plugins_dir().join(PLUGINS_GIT_CACHE_DIR_NAME)
    }

    /// Returns the per-display plugin runtime state/quarantine guard file (`runtime-<display>.json`).
    #[must_use]
    pub fn plugins_runtime_state_file(&self) -> PathBuf {
        self.plugins_dir()
            .join(format!("runtime-{}.json", self.display))
    }

    /// Returns the per-display runtime plugin overlay path (`plugins-overlay-<display>.json`).
    #[must_use]
    pub fn plugins_overlay_file(&self) -> PathBuf {
        self.runtime_dir
            .join(format!("plugins-overlay-{}.json", self.display))
    }

    /// Returns the local QuickJS `.qjsb` bytecode cache directory (`$XDG_CACHE_HOME/z-shell/plugin-bytecode`).
    #[must_use]
    pub fn plugin_bytecode_cache_dir(&self) -> PathBuf {
        self.cache_dir.join(PLUGIN_BYTECODE_CACHE_DIR_NAME)
    }

    /// Returns the cached static catalog index directory (`$XDG_CACHE_HOME/z-shell/catalog-cache`).
    #[must_use]
    pub fn plugin_catalog_cache_dir(&self) -> PathBuf {
        self.cache_dir.join(PLUGIN_CATALOG_CACHE_DIR_NAME)
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

fn config_and_state_dirs(
    config_dir: Option<PathBuf>,
    state_dir: Option<PathBuf>,
) -> Result<(PathBuf, PathBuf), PathError> {
    let home = env::var_os("HOME").map(PathBuf::from);
    let resolve = |variable, fallback| {
        env::var_os(variable)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|home| home.join(fallback)))
            .map(|base| base.join(APP_DIR_NAME))
    };
    let config_dir = config_dir
        .or_else(|| resolve("XDG_CONFIG_HOME", ".config"))
        .ok_or(PathError::MissingBaseDir("XDG_CONFIG_HOME or HOME"))?;
    let state_dir = state_dir
        .or_else(|| resolve("XDG_STATE_HOME", ".local/state"))
        .ok_or(PathError::MissingBaseDir("XDG_STATE_HOME or HOME"))?;
    Ok((config_dir, state_dir))
}

fn env_cache_dir() -> Result<Option<PathBuf>, PathError> {
    let home = env::var_os("HOME").map(PathBuf::from);
    Ok(env::var_os("XDG_CACHE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| home.as_ref().map(|home| home.join(".cache")))
        .map(|base| base.join(APP_DIR_NAME)))
}

fn env_display() -> String {
    env::var("WAYLAND_DISPLAY")
        .ok()
        .filter(|s| is_safe_display(s))
        .unwrap_or_else(|| "wayland-0".to_owned())
}

fn is_safe_display(display: &str) -> bool {
    !display.is_empty()
        && !display.contains('/')
        && !display.contains('\\')
        && !display.contains("..")
        && !display.chars().any(char::is_control)
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
