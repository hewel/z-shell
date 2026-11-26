//! Atomic, crash-safe TOML persistence for [`UserSettings`] and [`RuntimeState`].

use crate::paths::{PathError, ShellPaths};
use crate::settings::UserSettings;
use crate::state::RuntimeState;
use rustix::fs::{FlockOperation, flock};
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use thiserror::Error;
use toml_edit::{
    Array as TomlArray, ArrayOfTables, DocumentMut, InlineTable, Item as TomlItem,
    Table as TomlTable, Value as TomlValue,
};
use z_shell_protocol::PluginId;

const ALLOWED_PATCH_SECTIONS: [&str; 8] = [
    "general",
    "bar",
    "theme",
    "ime",
    "polkit",
    "wallpaper",
    "idle",
    "plugins",
];

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
    /// Lossless TOML document parsing failed while patching.
    #[error("failed to parse TOML document at {path}: {source}")]
    TomlEdit {
        /// Affected file path.
        path: PathBuf,
        /// Underlying `toml_edit` parse error (boxed to keep `ConfigError` small).
        #[source]
        source: Box<toml_edit::TomlError>,
    },
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

    /// Merges a partial JSON patch into `settings.toml` while preserving user comments and key
    /// ordering via `toml_edit`, validating the full [`UserSettings`] before atomic commit.
    ///
    /// Only top-level core sections (`general`, `bar`, `theme`, `ime`, `polkit`, `wallpaper`,
    /// `idle`) are accepted; plugin overrides must go through [`Self::patch_plugin_settings`].
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] if any section is unknown, parsing or validation fails, or atomic
    /// persistence fails. On error, `settings.toml` on disk is left untouched.
    pub fn patch_settings(
        &self,
        patch: &JsonMap<String, JsonValue>,
    ) -> Result<UserSettings, ConfigError> {
        let path = self.paths.settings_file();
        let mut doc = load_toml_document(&path)?;
        for (section, value) in patch {
            if !ALLOWED_PATCH_SECTIONS.contains(&section.as_str()) {
                return Err(ConfigError::Validation(format!(
                    "unsupported settings patch section {section:?}"
                )));
            }
            let Some(section_map) = value.as_object() else {
                return Err(ConfigError::Validation(format!(
                    "settings patch section {section:?} must be an object"
                )));
            };
            let table = ensure_table(doc.as_table_mut(), section, false)?;
            merge_json_into_table(table, section_map)?;
        }
        self.commit_patched_document(&path, &doc)
    }

    /// Merges a partial JSON patch into `[plugin_settings."<plugin_id>"]` in `settings.toml` while
    /// preserving comments and unrelated sections, validating the full [`UserSettings`] before
    /// atomic commit.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] if parsing, validation, or atomic persistence fails.
    pub fn patch_plugin_settings(
        &self,
        plugin_id: &PluginId,
        patch: &JsonMap<String, JsonValue>,
    ) -> Result<UserSettings, ConfigError> {
        let path = self.paths.settings_file();
        let mut doc = load_toml_document(&path)?;
        let plugins_table = ensure_table(doc.as_table_mut(), "plugin_settings", true)?;
        let plugin_table = ensure_table(plugins_table, plugin_id.as_str(), false)?;
        merge_json_into_table(plugin_table, patch)?;
        self.commit_patched_document(&path, &doc)
    }

    /// Removes `[plugin_settings."<plugin_id>"]` from `settings.toml` when present, returning
    /// whether an entry existed and was removed.
    ///
    /// # Errors
    ///
    /// Returns [`ConfigError`] if parsing, validation, or atomic persistence fails.
    pub fn remove_plugin_settings(&self, plugin_id: &PluginId) -> Result<bool, ConfigError> {
        let path = self.paths.settings_file();
        let mut doc = load_toml_document(&path)?;
        let Some(plugins_table) = doc
            .as_table_mut()
            .get_mut("plugin_settings")
            .and_then(TomlItem::as_table_like_mut)
        else {
            return Ok(false);
        };
        let removed = plugins_table.remove(plugin_id.as_str()).is_some();
        if !removed {
            return Ok(false);
        }
        self.commit_patched_document(&path, &doc)?;
        Ok(true)
    }

    fn commit_patched_document(
        &self,
        path: &Path,
        doc: &DocumentMut,
    ) -> Result<UserSettings, ConfigError> {
        let rendered = doc.to_string();
        let validated: UserSettings =
            toml::from_str(&rendered).map_err(|source| ConfigError::TomlRead {
                path: path.to_path_buf(),
                source,
            })?;
        validated.validate().map_err(ConfigError::Validation)?;
        self.paths.ensure_dirs()?;
        atomic_write(path, rendered.as_bytes())?;
        Ok(validated)
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

fn load_toml_document(path: &Path) -> Result<DocumentMut, ConfigError> {
    let raw = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => String::new(),
        Err(source) => {
            return Err(ConfigError::Io {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    raw.parse::<DocumentMut>()
        .map_err(|source| ConfigError::TomlEdit {
            path: path.to_path_buf(),
            source: Box::new(source),
        })
}

fn ensure_table<'a>(
    parent: &'a mut TomlTable,
    key: &str,
    implicit: bool,
) -> Result<&'a mut TomlTable, ConfigError> {
    if !parent.contains_key(key) {
        let mut table = TomlTable::new();
        table.set_implicit(implicit);
        parent.insert(key, TomlItem::Table(table));
    }
    parent
        .get_mut(key)
        .and_then(TomlItem::as_table_mut)
        .ok_or_else(|| ConfigError::Validation(format!("expected TOML table at {key:?}")))
}

fn merge_json_into_table(
    table: &mut TomlTable,
    patch: &JsonMap<String, JsonValue>,
) -> Result<(), ConfigError> {
    for (key, value) in patch {
        match value {
            JsonValue::Null => {
                table.remove(key);
            }
            JsonValue::Object(nested) => {
                let subtable = ensure_table(table, key, false)?;
                merge_json_into_table(subtable, nested)?;
            }
            JsonValue::Array(items)
                if !items.is_empty() && items.iter().all(JsonValue::is_object) =>
            {
                let mut aot = ArrayOfTables::new();
                for item in items {
                    let obj = item
                        .as_object()
                        .expect("array of objects element is an object");
                    aot.push(json_object_to_table(obj)?);
                }
                table.insert(key, TomlItem::ArrayOfTables(aot));
            }
            JsonValue::Array(items) if items.is_empty() => {
                // Keep empty arrays as `key = []` (also clears prior [[array.of.tables]] cleanly).
                set_preserving_decor(table, key, TomlValue::Array(TomlArray::new()));
            }
            _ => {
                let toml_value = json_to_toml_value(value, key)?;
                set_preserving_decor(table, key, toml_value);
            }
        }
    }
    Ok(())
}

fn set_preserving_decor(table: &mut TomlTable, key: &str, mut value: TomlValue) {
    if let Some(existing) = table.get(key).and_then(TomlItem::as_value) {
        *value.decor_mut() = existing.decor().clone();
    }
    table.insert(key, TomlItem::Value(value));
}

fn json_object_to_table(obj: &JsonMap<String, JsonValue>) -> Result<TomlTable, ConfigError> {
    let mut table = TomlTable::new();
    for (key, value) in obj {
        if value.is_null() {
            continue;
        }
        let toml_value = json_to_toml_value(value, key)?;
        table.insert(key, TomlItem::Value(toml_value));
    }
    Ok(table)
}

fn json_to_toml_value(value: &JsonValue, context: &str) -> Result<TomlValue, ConfigError> {
    match value {
        JsonValue::Null => Err(ConfigError::Validation(format!(
            "null is not allowed inside array/inline table at {context:?}"
        ))),
        JsonValue::Bool(b) => Ok(TomlValue::from(*b)),
        JsonValue::Number(num) => {
            if let Some(i) = num.as_i64() {
                Ok(TomlValue::from(i))
            } else if let Some(u) = num.as_u64() {
                i64::try_from(u).map(TomlValue::from).map_err(|_| {
                    ConfigError::Validation(format!(
                        "integer out of TOML range at {context:?}: {u}"
                    ))
                })
            } else if let Some(f) = num.as_f64().filter(|f| f.is_finite()) {
                Ok(TomlValue::from(f))
            } else {
                Err(ConfigError::Validation(format!(
                    "non-finite number at {context:?}"
                )))
            }
        }
        JsonValue::String(s) => Ok(TomlValue::from(s.as_str())),
        JsonValue::Array(items) => {
            let mut arr = TomlArray::new();
            for item in items {
                arr.push(json_to_toml_value(item, context)?);
            }
            Ok(TomlValue::Array(arr))
        }
        JsonValue::Object(map) => {
            let mut inline = InlineTable::new();
            for (k, v) in map {
                if v.is_null() {
                    continue;
                }
                inline.insert(k, json_to_toml_value(v, k)?);
            }
            Ok(TomlValue::InlineTable(inline))
        }
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
    fn loads_and_validates_wallpaper_settings_and_output_state() {
        let (_dir, store) = test_store();
        store.paths().ensure_dirs().unwrap();
        let path = store.paths().settings_file();
        fs::write(
            &path,
            "[wallpaper]\ndirectories = ['~/Pictures', '/srv/wallpapers']\nfit = 'contain'\nsync_theme = false\nslideshow_seconds = 60\n",
        )
        .unwrap();
        let settings = store.load_settings().unwrap();
        assert_eq!(
            settings.wallpaper.directories,
            ["~/Pictures", "/srv/wallpapers"]
        );
        assert_eq!(
            settings.wallpaper.fit,
            crate::settings::WallpaperFit::Contain
        );
        assert!(!settings.wallpaper.sync_theme);
        assert_eq!(settings.wallpaper.slideshow_seconds, 60);
        assert_eq!(settings.public_summary().wallpaper, settings.wallpaper);

        for (field, value) in [("directories", "[' ']"), ("slideshow_seconds", "86401")] {
            fs::write(&path, format!("[wallpaper]\n{field} = {value}\n")).unwrap();
            assert!(matches!(
                store.load_settings(),
                Err(ConfigError::Validation(message)) if message.contains(field)
            ));
        }

        fs::write(
            store.paths().state_file(),
            "last_wallpaper = '/pictures/global.png'\n[output_wallpapers]\nDP-1 = '/pictures/monitor.webp'\n",
        )
        .unwrap();
        let committed = store
            .update_state(|state| {
                state
                    .output_wallpapers
                    .insert("HDMI-A-1".into(), "/pictures/other.jpg".into());
                Ok(())
            })
            .unwrap();
        let summary = store.load_state().unwrap().public_summary();
        assert_eq!(summary.last_wallpaper, Some("/pictures/global.png".into()));
        assert_eq!(
            summary.output_wallpapers["DP-1"],
            Path::new("/pictures/monitor.webp")
        );
        assert_eq!(
            summary.output_wallpapers["HDMI-A-1"],
            Path::new("/pictures/other.jpg")
        );
        assert_eq!(summary, committed.public_summary());
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

    #[test]
    fn loads_and_validates_declarative_idle_rules() {
        let (_dir, store) = test_store();
        fs::create_dir_all(store.paths().config_dir()).unwrap();
        fs::write(
            store.paths().settings_file(),
            r#"
[idle]
pre_action_fade_seconds = 5

[[idle.rules]]
name = "lock"
enabled = true
timeout_seconds = 300
action = "lock"

[[idle.rules]]
name = "screen-off"
enabled = true
timeout_seconds = 360
locked_timeout_seconds = 60
action = "screen_off"

[[idle.rules]]
name = "notify-idle"
enabled = false
timeout_seconds = 120
action = { custom_command = ["notify-send", "idle"] }
resume_command = ["notify-send", "back"]
pre_action_fade_seconds = 1
"#,
        )
        .unwrap();

        let loaded = store.load_settings().unwrap();
        assert_eq!(loaded.idle.pre_action_fade_seconds, 5);
        assert_eq!(loaded.idle.rules.len(), 3);
        assert_eq!(loaded.idle.rules[0].name, "lock");
        assert!(loaded.idle.rules[0].enabled);
        assert_eq!(loaded.idle.rules[1].locked_timeout_seconds, Some(60));
        assert_eq!(
            loaded.idle.rules[2].action,
            crate::settings::IdleRuleAction::CustomCommand(vec![
                "notify-send".to_owned(),
                "idle".to_owned()
            ])
        );

        // Duplicate names must fail validation.
        let mut invalid = loaded.clone();
        invalid.idle.rules.push(invalid.idle.rules[0].clone());
        assert!(matches!(
            store.save_settings(&invalid),
            Err(ConfigError::Validation(_))
        ));

        // Enabled rule with zero timeout must fail validation.
        let mut zero_timeout = loaded;
        zero_timeout.idle.rules[0].timeout_seconds = 0;
        assert!(matches!(
            store.save_settings(&zero_timeout),
            Err(ConfigError::Validation(_))
        ));
    }

    #[test]
    fn loads_ime_settings_with_indicator_only_default() {
        let (_dir, store) = test_store();
        let defaults = store.load_settings().unwrap();
        assert_eq!(defaults.ime.mode, crate::settings::ImeMode::IndicatorOnly);
        assert_eq!(
            defaults.ime.candidate_layout,
            crate::settings::CandidateLayout::Auto
        );
        assert!(defaults.ime.switch_osd);

        fs::create_dir_all(store.paths().config_dir()).unwrap();
        fs::write(
            store.paths().settings_file(),
            r#"
[ime]
mode = "kimpanel"
candidate_layout = "vertical"
switch_osd = false
"#,
        )
        .unwrap();
        let loaded = store.load_settings().unwrap();
        assert_eq!(loaded.ime.mode, crate::settings::ImeMode::Kimpanel);
        assert_eq!(
            loaded.ime.candidate_layout,
            crate::settings::CandidateLayout::Vertical
        );
        assert!(!loaded.ime.switch_osd);
        assert_eq!(loaded.public_summary().ime, loaded.ime);
    }

    #[test]
    fn loads_polkit_settings_with_enabled_default() {
        let (_dir, store) = test_store();
        assert!(store.load_settings().unwrap().polkit.enabled);

        fs::create_dir_all(store.paths().config_dir()).unwrap();
        fs::write(store.paths().settings_file(), "[polkit]\n").unwrap();
        assert!(store.load_settings().unwrap().polkit.enabled);

        fs::write(store.paths().settings_file(), "[polkit]\nenabled = false\n").unwrap();
        let settings = store.load_settings().unwrap();
        assert!(!settings.polkit.enabled);
        assert!(!settings.public_summary().polkit.enabled);
    }

    #[test]
    fn patches_settings_losslessly_preserving_comments_and_validating_before_write() {
        let (_dir, store) = test_store();
        store.paths().ensure_dirs().unwrap();
        let path = store.paths().settings_file();
        let initial = r##"# User top-level comment
[bar]
# Keep my bar comment
position = "top" # inline comment
gaps = 14

[theme]
mode = "dark"
seed_color = "#A6C8FF"
"##;
        fs::write(&path, initial).unwrap();

        let patch: JsonMap<String, JsonValue> = serde_json::from_value(serde_json::json!({
            "bar": { "style": "docked", "gaps": 10 },
            "theme": { "motion_scheme": "expressive", "seed_color": null },
            "idle": {
                "rules": [
                    { "name": "lock", "enabled": true, "timeout_seconds": 300, "action": "lock" }
                ]
            }
        }))
        .unwrap();
        let committed = store.patch_settings(&patch).unwrap();
        assert_eq!(committed.bar.style, crate::settings::BarStyle::Docked);
        assert_eq!(committed.bar.gaps, 10);
        assert_eq!(committed.bar.position, BarPosition::Top);
        assert_eq!(
            committed.theme.motion_scheme,
            crate::settings::MotionScheme::Expressive
        );
        assert_eq!(committed.theme.seed_color, None);
        assert_eq!(committed.idle.rules.len(), 1);
        assert_eq!(committed.idle.rules[0].name, "lock");

        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("# User top-level comment"), "{on_disk}");
        assert!(on_disk.contains("# Keep my bar comment"), "{on_disk}");
        assert!(on_disk.contains("# inline comment"), "{on_disk}");
        assert!(!on_disk.contains("seed_color"), "{on_disk}");

        // Invalid patch must fail validation without mutating the file on disk.
        let bad_patch: JsonMap<String, JsonValue> = serde_json::from_value(serde_json::json!({
            "bar": { "gaps": 999 }
        }))
        .unwrap();
        assert!(matches!(
            store.patch_settings(&bad_patch),
            Err(ConfigError::Validation(_))
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), on_disk);

        // Plugin settings must be rejected via patch_settings and written via patch_plugin_settings.
        let forbidden: JsonMap<String, JsonValue> = serde_json::from_value(serde_json::json!({
            "plugin_settings": {}
        }))
        .unwrap();
        assert!(matches!(
            store.patch_settings(&forbidden),
            Err(ConfigError::Validation(_))
        ));

        let plugin_id = PluginId::try_new("z-shell/ai-usage").unwrap();
        let plugin_patch: JsonMap<String, JsonValue> = serde_json::from_value(serde_json::json!({
            "refresh_seconds": 120,
            "codex_resets_url": "https://codex-resets.com/api"
        }))
        .unwrap();
        let with_plugin = store
            .patch_plugin_settings(&plugin_id, &plugin_patch)
            .unwrap();
        assert!(with_plugin.plugin_settings.contains_key(&plugin_id));
        let reloaded = store.load_settings().unwrap();
        assert_eq!(
            reloaded.plugin_settings[&plugin_id]["refresh_seconds"].as_integer(),
            Some(120)
        );
        assert!(
            fs::read_to_string(&path)
                .unwrap()
                .contains("# User top-level comment")
        );
    }
}
