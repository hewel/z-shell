//! Atomic, crash-safe TOML persistence for [`UserSettings`] and [`RuntimeState`].

use crate::paths::{PathError, ShellPaths};
use crate::settings::UserSettings;
use crate::state::RuntimeState;
use rustix::fs::{FlockOperation, flock};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use thiserror::Error;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Error returned while reading, validating, or persisting configuration and state files.
#[derive(Debug, Error)]
pub enum ConfigError {
    /// XDG directory initialization or security verification failed.
    #[error(transparent)]
    Path(#[from] PathError),
    /// Filesystem read, lock, or atomic write failed.
    #[error("config I/O error at {path}: {source}")]
    Io {
        /// Affected file path.
        path: PathBuf,
        /// Underlying OS error.
        #[source]
        source: io::Error,
    },
    /// Parsing TOML failed.
    #[error("failed to parse TOML at {path}: {source}")]
    TomlRead {
        /// Affected file path.
        path: PathBuf,
        /// Underlying TOML parse error.
        #[source]
        source: toml::de::Error,
    },
    /// Serializing TOML failed.
    #[error("failed to serialize TOML: {0}")]
    TomlWrite(#[from] toml::ser::Error),
    /// Semantic validation of settings failed.
    #[error("invalid settings: {0}")]
    Validation(String),
}

/// Owns the filesystem paths and atomic TOML read/write operations for one daemon instance.
#[derive(Debug, Clone)]
pub struct ConfigStore {
    paths: ShellPaths,
}

impl ConfigStore {
    /// Creates a store backed by the given [`ShellPaths`].
    #[must_use]
    pub fn new(paths: ShellPaths) -> Self {
        Self { paths }
    }

    /// Returns the resolved [`ShellPaths`].
    #[must_use]
    pub fn paths(&self) -> &ShellPaths {
        &self.paths
    }

    /// Loads and validates `settings.toml`, returning [`UserSettings::default()`] when absent.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] if the file exists but cannot be read, parsed, or validated.
    pub fn load_settings(&self) -> Result<UserSettings, ConfigError> {
        let path = self.paths.settings_file();
        let settings: UserSettings = match fs::read_to_string(&path) {
            Ok(raw) => toml::from_str(&raw).map_err(|source| ConfigError::TomlRead {
                path: path.clone(),
                source,
            })?,
            Err(err) if err.kind() == io::ErrorKind::NotFound => UserSettings::default(),
            Err(source) => return Err(ConfigError::Io { path, source }),
        };
        settings.validate().map_err(ConfigError::Validation)?;
        Ok(settings)
    }

    /// Validates and atomically writes `settings.toml` with `0600` temp file + parent dir fsync.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] if validation, serialization, or atomic rename fails.
    pub fn save_settings(&self, settings: &UserSettings) -> Result<(), ConfigError> {
        settings.validate().map_err(ConfigError::Validation)?;
        self.paths.ensure_dirs()?;
        let body = toml::to_string_pretty(settings)?;
        atomic_write(&self.paths.settings_file(), body.as_bytes())
    }

    /// Loads `state.toml`, returning [`RuntimeState::default()`] when absent.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] if the file exists but cannot be read or parsed.
    pub fn load_state(&self) -> Result<RuntimeState, ConfigError> {
        let path = self.paths.state_file();
        match fs::read_to_string(&path) {
            Ok(raw) => toml::from_str(&raw).map_err(|source| ConfigError::TomlRead {
                path: path.clone(),
                source,
            }),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(RuntimeState::default()),
            Err(source) => Err(ConfigError::Io { path, source }),
        }
    }

    /// Atomically writes `state.toml` while holding the cross-display `state.lock` flock.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] if locking, serialization, or atomic rename fails.
    pub fn save_state(&self, state: &RuntimeState) -> Result<(), ConfigError> {
        self.paths.ensure_dirs()?;
        let _lock = self.lock_state_file()?;
        let body = toml::to_string_pretty(state)?;
        atomic_write(&self.paths.state_file(), body.as_bytes())
    }

    /// Performs a cross-display locked read-modify-write on `state.toml`, returning the newly
    /// committed [`RuntimeState`] only after disk persistence succeeds.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] if locking, reading, mutating, or atomic persistence fails.
    pub fn update_state<F>(&self, mutate: F) -> Result<RuntimeState, ConfigError>
    where
        F: FnOnce(&mut RuntimeState) -> Result<(), ConfigError>,
    {
        self.paths.ensure_dirs()?;
        let _lock = self.lock_state_file()?;
        let mut candidate = self.load_state()?;
        mutate(&mut candidate)?;
        let body = toml::to_string_pretty(&candidate)?;
        atomic_write(&self.paths.state_file(), body.as_bytes())?;
        Ok(candidate)
    }

    fn lock_state_file(&self) -> Result<File, ConfigError> {
        let lock_path = self.paths.state_lock_file();
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .mode(0o600)
            .open(&lock_path)
            .map_err(|source| ConfigError::Io {
                path: lock_path.clone(),
                source,
            })?;
        flock(&file, FlockOperation::LockExclusive).map_err(|err| ConfigError::Io {
            path: lock_path,
            source: io::Error::from(err),
        })?;
        Ok(file)
    }
}

fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), ConfigError> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let file_name = target.file_name().and_then(|n| n.to_str()).unwrap_or("tmp");
    let pid = std::process::id();
    let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = parent.join(format!(".{file_name}.{pid}.{seq}.tmp"));

    let write_res = (|| -> Result<(), ConfigError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp_path)
            .map_err(|source| ConfigError::Io {
                path: tmp_path.clone(),
                source,
            })?;
        file.write_all(bytes).map_err(|source| ConfigError::Io {
            path: tmp_path.clone(),
            source,
        })?;
        file.sync_all().map_err(|source| ConfigError::Io {
            path: tmp_path.clone(),
            source,
        })?;
        drop(file);

        fs::rename(&tmp_path, target).map_err(|source| ConfigError::Io {
            path: target.to_path_buf(),
            source,
        })?;

        if let Ok(dir_handle) = File::open(parent) {
            let _ = dir_handle.sync_all();
        }
        Ok(())
    })();

    if write_res.is_err() {
        let _ = fs::remove_file(&tmp_path);
    }
    write_res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{BarPosition, ThemeMode};
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;
    use z_shell_protocol::PluginId;

    fn test_store() -> (TempDir, ConfigStore) {
        let dir = TempDir::new().unwrap();
        let paths = ShellPaths::from_roots(
            dir.path().join("config"),
            dir.path().join("state"),
            dir.path().join("runtime"),
            dir.path().join("runtime/bus.sock"),
        );
        (dir, ConfigStore::new(paths))
    }

    #[test]
    fn loads_defaults_when_files_absent() {
        let (_dir, store) = test_store();
        assert_eq!(store.load_settings().unwrap(), UserSettings::default());
        assert_eq!(store.load_state().unwrap(), RuntimeState::default());
    }

    #[test]
    fn round_trips_settings_and_state_and_projects_public_summaries() {
        let (_dir, store) = test_store();
        let mut settings = UserSettings::default();
        settings.general.offline_mode = true;
        settings.bar.position = BarPosition::Left;
        settings.theme.mode = ThemeMode::Auto;
        settings.theme.seed_color = Some("#A6C8FF".to_owned());
        settings.plugin_settings.insert(
            PluginId::try_new("z-shell/ai-usage").unwrap(),
            toml::Value::Table(toml::map::Map::from_iter([(
                "secret_token".to_owned(),
                toml::Value::String("do-not-broadcast".to_owned()),
            )])),
        );
        store.save_settings(&settings).unwrap();

        let summary = settings.public_summary();
        assert_eq!(summary.configured_plugins.len(), 1);
        let summary_json = serde_json::to_string(&summary).unwrap();
        assert!(!summary_json.contains("do-not-broadcast"));

        let committed = store
            .update_state(|state| {
                state.pinned_apps.push("org.mozilla.firefox".to_owned());
                state.dnd_enabled = true;
                state.tables.insert(
                    "private_panel".to_owned(),
                    toml::Value::String("internal".to_owned()),
                );
                Ok(())
            })
            .unwrap();
        let state_summary = committed.public_summary();
        assert_eq!(state_summary.table_keys, vec!["private_panel"]);
        assert_eq!(store.load_state().unwrap(), committed);
    }

    #[test]
    fn rejects_symlink_runtime_directory() {
        let dir = TempDir::new().unwrap();
        let real_target = dir.path().join("real");
        fs::create_dir_all(&real_target).unwrap();
        let symlink_runtime = dir.path().join("runtime-link");
        symlink(&real_target, &symlink_runtime).unwrap();

        let paths = ShellPaths::from_roots(
            dir.path().join("config"),
            dir.path().join("state"),
            symlink_runtime.clone(),
            symlink_runtime.join("bus.sock"),
        );
        assert!(matches!(
            paths.ensure_dirs(),
            Err(PathError::InsecureRuntimeDir { .. })
        ));
    }

    #[test]
    fn rejects_invalid_seed_color_gap_and_empty_fallback_locker() {
        let (_dir, store) = test_store();
        let mut settings = UserSettings::default();
        settings.theme.seed_color = Some("not-a-color".to_owned());
        assert!(matches!(
            store.save_settings(&settings),
            Err(ConfigError::Validation(_))
        ));

        settings.theme.seed_color = None;
        settings.bar.gaps = 999;
        assert!(matches!(
            store.save_settings(&settings),
            Err(ConfigError::Validation(_))
        ));

        settings.bar.gaps = 14;
        settings.idle.fallback_locker = Some(vec![]);
        assert!(matches!(
            store.save_settings(&settings),
            Err(ConfigError::Validation(_))
        ));
    }
}
