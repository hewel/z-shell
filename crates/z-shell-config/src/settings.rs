//! Declarative user settings stored in `$XDG_CONFIG_HOME/z-shell/settings.toml`.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use z_shell_protocol::PluginId;

/// Default outer spacing in logical pixels between screen edges and shell islands.
pub const DEFAULT_GAPS_PX: u16 = 14;

/// Maximum configurable outer gap in logical pixels.
pub const MAX_GAPS_PX: u16 = 64;

/// Maximum configurable per-edge spacing override in logical pixels.
pub const MAX_EDGE_OVERRIDE_PX: u16 = 512;

/// Default pre-action fade warning duration in seconds before idle rules execute.
pub const DEFAULT_PRE_ACTION_FADE_SECONDS: u32 = 2;

/// Maximum number of declarative idle rules allowed in `settings.toml`.
pub const MAX_IDLE_RULES: usize = 64;

/// Maximum idle rule timeout in seconds (24 hours).
pub const MAX_IDLE_TIMEOUT_SECONDS: u32 = 86_400;

/// Maximum pre-action fade duration in seconds.
pub const MAX_PRE_ACTION_FADE_SECONDS: u32 = 60;

/// Log verbosity for the shell daemon.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum LogLevel {
    /// Only errors.
    Error,
    /// Warnings and errors.
    Warn,
    /// Standard operational logs.
    #[default]
    Info,
    /// Detailed debug logs.
    Debug,
    /// Verbose trace logs.
    Trace,
}

/// Output edge occupied by the shell bar.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum BarPosition {
    /// Horizontal bar along the top edge.
    #[default]
    Top,
    /// Vertical bar along the left edge.
    Left,
    /// Vertical bar along the right edge.
    Right,
}

/// Light/dark scheduling mode for dynamic palettes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ThemeMode {
    /// Dark color scheme.
    #[default]
    Dark,
    /// Light color scheme.
    Light,
    /// Automatic light/dark switching based on local time.
    Auto,
}

/// Material 3 scheme variant.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ThemeVariant {
    /// Balanced Material 3 tonal spot scheme.
    #[default]
    Tonal,
    /// High-chroma vibrant accents.
    Vibrant,
    /// Expressive hue-shifted palette.
    Expressive,
    /// Closer adherence to source seed chroma.
    Fidelity,
    /// Low-chroma neutral surfaces.
    Neutral,
    /// Monochrome grayscale palette.
    Mono,
}

/// Palette generation backend.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ThemeBackend {
    /// Deterministic pure-Rust Material 3 HCT generator.
    #[default]
    Builtin,
    /// Optional external `matugen` CLI backend.
    Matugen,
}

/// General daemon-wide switches.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GeneralSettings {
    /// Disables all outbound HTTP traffic (album art downloads, optional plugin feeds).
    pub offline_mode: bool,
    /// Daemon log verbosity.
    pub log_level: LogLevel,
}

/// Optional per-edge clearance overrides matching compositor struts or gaps (`0..=512` px).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct EdgeOverrides {
    /// Override for top edge clearance in logical pixels.
    pub top: Option<u16>,
    /// Override for right edge clearance in logical pixels.
    pub right: Option<u16>,
    /// Override for bottom edge clearance in logical pixels.
    pub bottom: Option<u16>,
    /// Override for left edge clearance in logical pixels.
    pub left: Option<u16>,
}

/// Bar, dock, launcher, and clock preferences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BarSettings {
    /// Screen edge where the bar is anchored.
    pub position: BarPosition,
    /// Shared gap spacing in logical pixels (`0..=64`).
    pub gaps: u16,
    /// Optional per-edge spacing overrides.
    pub edge_overrides: EdgeOverrides,
    /// Enables launcher entry points and commands.
    pub launcher_enabled: bool,
    /// Enables the auto-hiding bottom dock.
    pub dock_enabled: bool,
    /// Uses 24-hour clock format when true.
    pub clock_24h: bool,
    /// Displays seconds in the bar clock when true.
    pub clock_seconds: bool,
}

impl Default for BarSettings {
    fn default() -> Self {
        Self {
            position: BarPosition::Top,
            gaps: DEFAULT_GAPS_PX,
            edge_overrides: EdgeOverrides::default(),
            launcher_enabled: true,
            dock_enabled: true,
            clock_24h: true,
            clock_seconds: false,
        }
    }
}

/// Dynamic palette and optional GTK linking preferences.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ThemeSettings {
    /// Light, dark, or automatic theme mode.
    pub mode: ThemeMode,
    /// Material 3 scheme variant.
    pub variant: ThemeVariant,
    /// Optional `#rrggbb` seed color overriding wallpaper extraction.
    pub seed_color: Option<String>,
    /// Palette generator backend (`builtin` or `matugen`).
    pub backend: ThemeBackend,
    /// Reversible opt-in GTK 3/4 theme linking (off by default).
    pub gtk_linking: bool,
}

/// Declarative action executed when a named idle rule triggers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum IdleRuleAction {
    /// Request a host-verified compositor session lock.
    Lock,
    /// Power off outputs via `wlr-output-power`.
    ScreenOff,
    /// Request system suspend without an additional lock request.
    Suspend,
    /// Lock, await host acknowledgement, and then suspend.
    LockAndSuspend,
    /// Spawn an exact argv without shell interpolation.
    CustomCommand(Vec<String>),
}

/// One declarative idle rule entry in `[[idle.rules]]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct IdleRuleSettings {
    /// Unique human-readable rule name (1..=128 bytes, no control chars or surrounding whitespace).
    pub name: String,
    /// Whether this rule is active (disabled by default).
    pub enabled: bool,
    /// Inactivity timeout in seconds while unlocked (`1..=86400` when enabled).
    pub timeout_seconds: u32,
    /// Optional alternate inactivity timeout in seconds while locked (`1..=86400`).
    pub locked_timeout_seconds: Option<u32>,
    /// Action executed after timeout and warning fade.
    pub action: IdleRuleAction,
    /// Optional exact argv executed when user activity resumes after this action.
    pub resume_command: Option<Vec<String>>,
    /// Optional per-rule warning fade duration in seconds (defaults to `idle.pre_action_fade_seconds`).
    pub pre_action_fade_seconds: Option<u32>,
}

impl Default for IdleRuleSettings {
    fn default() -> Self {
        Self {
            name: String::new(),
            enabled: false,
            timeout_seconds: 0,
            locked_timeout_seconds: None,
            action: IdleRuleAction::Lock,
            resume_command: None,
            pre_action_fade_seconds: None,
        }
    }
}

/// Idle and lock coordination preferences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct IdleSettings {
    /// Default warning fade duration in seconds before idle rules fire (`0..=60`).
    pub pre_action_fade_seconds: u32,
    /// Optional fallback locker argv used only when no `zgui-js` UI host is connected.
    pub fallback_locker: Option<Vec<String>>,
    /// Optional declarative named idle rules (`[[idle.rules]]`). When empty, built-in disabled presets apply.
    pub rules: Vec<IdleRuleSettings>,
}

impl Default for IdleSettings {
    fn default() -> Self {
        Self {
            pre_action_fade_seconds: DEFAULT_PRE_ACTION_FADE_SECONDS,
            fallback_locker: None,
            rules: Vec::new(),
        }
    }
}

/// Runtime mode for Fcitx5 input method integration.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ImeMode {
    /// Observe Fcitx5 via SNI + Controller1 without claiming `org.kde.impanel`.
    #[default]
    IndicatorOnly,
    /// Claim `org.kde.impanel` (`DoNotQueue`) to render themed candidate panels and indicators.
    Kimpanel,
    /// Disable Fcitx5 input method integration completely.
    Disabled,
}

/// Preferred layout direction for `kimpanel` candidate lists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum CandidateLayout {
    /// Follow the input method engine's layout hint (`SetLookupTable`).
    #[default]
    Auto,
    /// Always arrange candidates horizontally.
    Horizontal,
    /// Always arrange candidates vertically.
    Vertical,
}

/// Input method display and protocol preferences (`[ime]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ImeSettings {
    /// Integration mode (`indicator_only`, `kimpanel`, or `disabled`).
    pub mode: ImeMode,
    /// Candidate list layout preference for `kimpanel` mode.
    pub candidate_layout: CandidateLayout,
    /// Whether live input method switches should emit transient OSD hints.
    pub switch_osd: bool,
}

impl Default for ImeSettings {
    fn default() -> Self {
        Self {
            mode: ImeMode::IndicatorOnly,
            candidate_layout: CandidateLayout::Auto,
            switch_osd: true,
        }
    }
}

/// Polkit authentication agent preferences (`[polkit]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PolkitSettings {
    /// Registers `z-shelld` as the session Polkit authentication agent when true.
    pub enabled: bool,
}

impl Default for PolkitSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// Public non-secret settings view broadcast on the `settings` topic (excludes plugin settings tables).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicSettingsSummary {
    /// General daemon settings.
    pub general: GeneralSettings,
    /// Bar and layout preferences.
    pub bar: BarSettings,
    /// Dynamic theme preferences.
    pub theme: ThemeSettings,
    /// Input method display preferences.
    pub ime: ImeSettings,
    /// Polkit authentication agent preferences.
    pub polkit: PolkitSettings,
    /// Idle warning duration (omits host-only fallback argv).
    pub pre_action_fade_seconds: u32,
    /// Sorted list of plugin IDs that have configuration overrides in `settings.toml`.
    pub configured_plugins: Vec<PluginId>,
}

/// Root schema for `$XDG_CONFIG_HOME/z-shell/settings.toml`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct UserSettings {
    /// General daemon behavior.
    pub general: GeneralSettings,
    /// Bar, dock, launcher, and clock preferences.
    pub bar: BarSettings,
    /// Dynamic theme preferences.
    pub theme: ThemeSettings,
    /// Input method integration preferences.
    pub ime: ImeSettings,
    /// Polkit authentication agent preferences.
    pub polkit: PolkitSettings,
    /// Idle and lock preferences.
    pub idle: IdleSettings,
    /// Per-plugin configuration overrides keyed by canonical `author/plugin` ID.
    pub plugin_settings: BTreeMap<PluginId, toml::Value>,
}

impl UserSettings {
    /// Projects a non-secret public view safe for broadcasting on the `settings` bus topic.
    #[must_use]
    pub fn public_summary(&self) -> PublicSettingsSummary {
        PublicSettingsSummary {
            general: self.general.clone(),
            bar: self.bar.clone(),
            theme: self.theme.clone(),
            ime: self.ime.clone(),
            polkit: self.polkit.clone(),
            pre_action_fade_seconds: self.idle.pre_action_fade_seconds,
            configured_plugins: self.plugin_settings.keys().cloned().collect(),
        }
    }

    /// Validates cross-field and numeric range constraints.
    ///
    /// # Errors
    ///
    /// Returns a descriptive validation error message if any field is out of range.
    pub fn validate(&self) -> Result<(), String> {
        if self.bar.gaps > MAX_GAPS_PX {
            return Err(format!(
                "bar.gaps must be <= {MAX_GAPS_PX}, got {}",
                self.bar.gaps
            ));
        }
        for (edge, value) in [
            ("top", self.bar.edge_overrides.top),
            ("right", self.bar.edge_overrides.right),
            ("bottom", self.bar.edge_overrides.bottom),
            ("left", self.bar.edge_overrides.left),
        ] {
            if let Some(px) = value
                && px > MAX_EDGE_OVERRIDE_PX
            {
                return Err(format!(
                    "bar.edge_overrides.{edge} must be <= {MAX_EDGE_OVERRIDE_PX}, got {px}"
                ));
            }
        }
        if let Some(seed) = &self.theme.seed_color {
            let hex = seed.strip_prefix('#').unwrap_or("");
            if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(format!(
                    "theme.seed_color must be a #rrggbb hex string, got {seed:?}"
                ));
            }
        }
        if self.idle.pre_action_fade_seconds > MAX_PRE_ACTION_FADE_SECONDS {
            return Err(format!(
                "idle.pre_action_fade_seconds must be <= {MAX_PRE_ACTION_FADE_SECONDS}, got {}",
                self.idle.pre_action_fade_seconds
            ));
        }
        if let Some(argv) = &self.idle.fallback_locker
            && argv.first().is_none_or(|arg| arg.trim().is_empty())
        {
            return Err(
                "idle.fallback_locker must be a non-empty argv with a non-empty executable"
                    .to_owned(),
            );
        }
        if self.idle.rules.len() > MAX_IDLE_RULES {
            return Err(format!(
                "idle.rules supports at most {MAX_IDLE_RULES} rules, got {}",
                self.idle.rules.len()
            ));
        }
        let mut seen_rule_names = BTreeSet::new();
        for rule in &self.idle.rules {
            let trimmed = rule.name.trim();
            if trimmed.is_empty()
                || rule.name.len() > 128
                || rule.name.chars().any(char::is_control)
                || trimmed != rule.name
            {
                return Err(format!(
                    "idle.rules entry has invalid name {:?} (1..=128 bytes, no controls or outer whitespace)",
                    rule.name
                ));
            }
            if !seen_rule_names.insert(rule.name.as_str()) {
                return Err(format!("duplicate idle rule name {:?}", rule.name));
            }
            if rule.timeout_seconds > MAX_IDLE_TIMEOUT_SECONDS
                || rule
                    .locked_timeout_seconds
                    .is_some_and(|t| t == 0 || t > MAX_IDLE_TIMEOUT_SECONDS)
            {
                return Err(format!(
                    "idle rule {:?} timeouts must be within 1..={MAX_IDLE_TIMEOUT_SECONDS} seconds",
                    rule.name
                ));
            }
            if rule.enabled && rule.timeout_seconds == 0 {
                return Err(format!(
                    "enabled idle rule {:?} requires a non-zero timeout_seconds",
                    rule.name
                ));
            }
            if rule
                .pre_action_fade_seconds
                .is_some_and(|fade| fade > MAX_PRE_ACTION_FADE_SECONDS)
            {
                return Err(format!(
                    "idle rule {:?} pre_action_fade_seconds must be <= {MAX_PRE_ACTION_FADE_SECONDS}",
                    rule.name
                ));
            }
            if let IdleRuleAction::CustomCommand(argv) = &rule.action
                && argv.first().is_none_or(|arg| arg.trim().is_empty())
            {
                return Err(format!(
                    "idle rule {:?} custom_command must be a non-empty argv",
                    rule.name
                ));
            }
            if let Some(argv) = &rule.resume_command
                && argv.first().is_none_or(|arg| arg.trim().is_empty())
            {
                return Err(format!(
                    "idle rule {:?} resume_command must be a non-empty argv",
                    rule.name
                ));
            }
        }
        Ok(())
    }
}
