//! Strictly separated TOML user settings (`settings.toml`) and durable state (`state.toml`).

pub mod paths;
pub mod settings;
pub mod state;
pub mod store;

pub use paths::{PathError, ShellPaths};
pub use settings::{
    BarPosition, BarSettings, BarStyle, CandidateLayout, EdgeOverrides, GeneralSettings,
    IdleRuleAction, IdleRuleSettings, IdleSettings, ImeMode, ImeSettings, LogLevel, MotionScheme,
    PolkitSettings, PublicSettingsSummary, ThemeBackend, ThemeMode, ThemeSettings, ThemeVariant,
    UserSettings, WallpaperFit, WallpaperSettings,
};
pub use state::{PublicStateSummary, RuntimeState};
pub use store::{ConfigError, ConfigStore};
