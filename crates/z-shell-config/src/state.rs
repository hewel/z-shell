//! Recoverable durable state stored in `$XDG_STATE_HOME/z-shell/state.toml`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Public non-secret summary published on the `state` topic (omits arbitrary owner tables).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicStateSummary {
    /// Desktop IDs of applications pinned in the dock.
    pub pinned_apps: Vec<String>,
    /// Path to the most recently applied wallpaper image.
    pub last_wallpaper: Option<PathBuf>,
    /// Whether Do Not Disturb mode is currently active.
    pub dnd_enabled: bool,
    /// Sorted list of persisted owner-scoped table keys.
    pub table_keys: Vec<String>,
}

/// Root schema for `$XDG_STATE_HOME/z-shell/state.toml`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RuntimeState {
    /// Desktop IDs of applications pinned in the dock.
    pub pinned_apps: Vec<String>,
    /// Path to the most recently applied wallpaper image.
    pub last_wallpaper: Option<PathBuf>,
    /// Whether Do Not Disturb mode is currently active.
    pub dnd_enabled: bool,
    /// Owner-scoped state tables (for example, `wallpaper_panel` or plugin state keys).
    pub tables: BTreeMap<String, toml::Value>,
}

impl RuntimeState {
    /// Projects a compact public view without broadcasting all owner-scoped table contents.
    #[must_use]
    pub fn public_summary(&self) -> PublicStateSummary {
        PublicStateSummary {
            pinned_apps: self.pinned_apps.clone(),
            last_wallpaper: self.last_wallpaper.clone(),
            dnd_enabled: self.dnd_enabled,
            table_keys: self.tables.keys().cloned().collect(),
        }
    }
}
