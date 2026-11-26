//! Strictly separated TOML user settings (`settings.toml`) and durable state (`state.toml`).

pub mod paths;
pub mod settings;
pub mod state;
pub mod store;

pub use paths::{PathError, ShellPaths};
pub use settings::{
    BarPluginInstance, BarPluginSlot, BarPluginsSettings, BarPosition, BarSettings, BarStyle,
    BarTraySettings, CandidateLayout, EdgeOverrides, GeneralSettings, IdleRuleAction,
    IdleRuleSettings, IdleSettings, ImeMode, ImeSettings, LogLevel, MotionScheme, PluginSourceKind,
    PluginSourceSettings, PluginsSettings, PolkitSettings, PublicSettingsSummary, ThemeBackend,
    ThemeMode, ThemeSettings, ThemeVariant, TrayDefaultAction, TrayItemRule, UserSettings,
    WallpaperFit, WallpaperSettings,
};
pub use state::{PublicStateSummary, RuntimeState};
pub use store::{ConfigError, ConfigStore};
