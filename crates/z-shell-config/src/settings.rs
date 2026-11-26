//! Declarative user settings stored in `$XDG_CONFIG_HOME/z-shell/settings.toml`.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use z_shell_protocol::{PluginEntryId, PluginId};

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

/// Maximum number of per-application system tray rules allowed in `[bar.tray]`.
pub const MAX_BAR_TRAY_RULES: usize = 256;

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

/// Visual chrome mode for the shell bar (`DESIGN.md` Floating Islands vs Docked Flush Bar).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum BarStyle {
    /// Separate floating pill islands with outer screen margins (`46px` top / `54px` vertical strut).
    #[default]
    Floating,
    /// Full-bleed edge-to-edge flush strip with an inner hairline (`38px` top / `44px` vertical strut).
    Docked,
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

/// Material Design 3 motion physics scheme (`[theme].motion_scheme`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum MotionScheme {
    /// Crisp high-damping springs for everyday desktop productivity.
    #[default]
    Standard,
    /// Livelier Material 3 Expressive spatial springs.
    Expressive,
    /// Accessibility reduced motion: zero spatial displacement, fast opacity fades (`WCAG 2.2 SC 2.3.3`).
    Reduced,
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

/// Explicit bar widget instance placement and optional per-instance setting overrides.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BarPluginInstance {
    /// Canonical `author/plugin:entry` identifier.
    pub entry: PluginEntryId,
    /// Unique instance slug within `(entry, output)`.
    pub instance: String,
    /// Optional Wayland output connector name (for example, `"DP-1"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// Optional per-instance setting overrides (redacted from public settings topics).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub settings: BTreeMap<String, toml::Value>,
}

/// One slot in `[bar.plugins]` (`left`, `center`, `right`, or `hidden`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BarPluginSlot {
    /// Shorthand `author/plugin:entry` mapping to implicit instance `"default"`.
    Entry(PluginEntryId),
    /// Explicit multi-instance and/or output-scoped placement.
    Instance(BarPluginInstance),
}

impl BarPluginSlot {
    fn redacted_for_public(&self) -> Self {
        match self {
            Self::Entry(entry) => Self::Entry(entry.clone()),
            Self::Instance(instance) => Self::Instance(BarPluginInstance {
                entry: instance.entry.clone(),
                instance: instance.instance.clone(),
                output: instance.output.clone(),
                settings: BTreeMap::new(),
            }),
        }
    }
}

/// Declarative bar plugin zone layout (`[bar.plugins]`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BarPluginsSettings {
    /// Left bar zone entries/instances.
    pub left: Vec<BarPluginSlot>,
    /// Center bar zone entries/instances.
    pub center: Vec<BarPluginSlot>,
    /// Right bar zone entries/instances.
    pub right: Vec<BarPluginSlot>,
    /// Explicitly hidden bar widget entries/instances.
    pub hidden: Vec<BarPluginSlot>,
}

impl BarPluginsSettings {
    fn redacted_for_public(&self) -> Self {
        Self {
            left: self
                .left
                .iter()
                .map(BarPluginSlot::redacted_for_public)
                .collect(),
            center: self
                .center
                .iter()
                .map(BarPluginSlot::redacted_for_public)
                .collect(),
            right: self
                .right
                .iter()
                .map(BarPluginSlot::redacted_for_public)
                .collect(),
            hidden: self
                .hidden
                .iter()
                .map(BarPluginSlot::redacted_for_public)
                .collect(),
        }
    }
}

/// Default visibility applied to newly appearing system tray items without an explicit rule.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum TrayDefaultAction {
    /// Display new tray items directly in the bar.
    #[default]
    Show,
    /// Collapse new tray items into the bar overflow popover (`09E`).
    Collapse,
}

/// Per-application visibility rule in `[bar.tray.rules]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum TrayItemRule {
    /// Display the item directly in the bar.
    Show,
    /// Collapse the item into the bar overflow popover (`09E`).
    Collapse,
    /// Hide the item from both the bar and the overflow popover.
    Hide,
}

/// Declarative system tray visibility and overflow preferences (`[bar.tray]`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BarTraySettings {
    /// Default action applied to tray items without an explicit entry in `rules`.
    pub default_action: TrayDefaultAction,
    /// Per-application rules keyed by stable non-transient identifier (SNI `app_id`, etc.).
    pub rules: BTreeMap<String, TrayItemRule>,
}

impl BarTraySettings {
    /// Returns true when both `default_action` and `rules` match the default configuration.
    ///
    /// Used with `#[serde(skip_serializing_if)]` so untouched configs remain rollback-compatible
    /// with older daemons that use `deny_unknown_fields` on `BarSettings`.
    #[must_use]
    pub fn is_default(&self) -> bool {
        self.default_action == TrayDefaultAction::Show && self.rules.is_empty()
    }
}

/// Bar, dock, launcher, and clock preferences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BarSettings {
    /// Screen edge where the bar is anchored.
    pub position: BarPosition,
    /// Floating islands or flush docked strip.
    pub style: BarStyle,
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
    /// Displays workspace numbers instead of custom workspace names in the bar pill when true.
    #[serde(default = "default_true", skip_serializing_if = "is_true")]
    pub workspace_numbers: bool,
    /// Declarative left/center/right/hidden plugin widget placement (`[bar.plugins]`).
    pub plugins: BarPluginsSettings,
    /// Declarative system tray visibility and overflow rules (`[bar.tray]`).
    #[serde(default, skip_serializing_if = "BarTraySettings::is_default")]
    pub tray: BarTraySettings,
}

impl BarSettings {
    fn redacted_for_public(&self) -> Self {
        Self {
            position: self.position,
            style: self.style,
            gaps: self.gaps,
            edge_overrides: self.edge_overrides.clone(),
            launcher_enabled: self.launcher_enabled,
            dock_enabled: self.dock_enabled,
            clock_24h: self.clock_24h,
            clock_seconds: self.clock_seconds,
            workspace_numbers: self.workspace_numbers,
            plugins: self.plugins.redacted_for_public(),
            tray: self.tray.clone(),
        }
    }
}

impl Default for BarSettings {
    fn default() -> Self {
        Self {
            position: BarPosition::Top,
            style: BarStyle::Floating,
            gaps: DEFAULT_GAPS_PX,
            edge_overrides: EdgeOverrides::default(),
            launcher_enabled: true,
            dock_enabled: true,
            clock_24h: true,
            clock_seconds: false,
            workspace_numbers: true,
            plugins: BarPluginsSettings::default(),
            tray: BarTraySettings::default(),
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
    /// Material Design 3 motion physics scheme (`standard`, `expressive`, or `reduced`).
    pub motion_scheme: MotionScheme,
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

/// Image scaling strategy for desktop wallpaper surfaces.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum WallpaperFit {
    /// Scale uniformly to fill the output, cropping overflow.
    #[default]
    Cover,
    /// Scale uniformly to fit inside the output without cropping.
    Contain,
    /// Stretch non-uniformly to fill the exact output bounds.
    Fill,
    /// Render at native dimensions centered on the output.
    Center,
}

/// Maximum number of configured wallpaper scan directories.
pub const MAX_WALLPAPER_DIRECTORIES: usize = 32;

/// Maximum slideshow interval in seconds (24 hours).
pub const MAX_WALLPAPER_SLIDESHOW_SECONDS: u32 = 86_400;

/// Desktop wallpaper catalog, fit, theme linkage, and slideshow preferences (`[wallpaper]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct WallpaperSettings {
    /// Directories scanned for PNG, JPEG, and WebP wallpapers (`~/` is expanded at runtime).
    pub directories: Vec<String>,
    /// Default scaling strategy for wallpaper background surfaces.
    pub fit: WallpaperFit,
    /// Automatically re-derives the Material 3 theme palette from the active wallpaper when `theme.seed_color` is unset.
    pub sync_theme: bool,
    /// Optional slideshow rotation interval in seconds (`0` disables automatic rotation).
    pub slideshow_seconds: u32,
}

impl Default for WallpaperSettings {
    fn default() -> Self {
        Self {
            directories: vec!["~/Pictures/wallpapers".to_owned()],
            fit: WallpaperFit::Cover,
            sync_theme: true,
            slideshow_seconds: 0,
        }
    }
}

/// Transport kind for a declarative plugin catalog source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum PluginSourceKind {
    /// Static `catalog-v1.json` served over HTTPS.
    HttpsJson,
    /// Git repository containing a static `catalog-v1.json` index.
    GitJson,
    /// Local static `catalog-v1.json` file.
    LocalFile,
}

const fn default_true() -> bool {
    true
}

#[allow(clippy::trivially_copy_pass_by_ref)]
const fn is_true(value: &bool) -> bool {
    *value
}

const fn default_source_priority() -> u32 {
    100
}

/// One configured catalog source in `[[plugins.sources]]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginSourceSettings {
    /// Unique lowercase slug identifier (for example, `"official"`).
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Transport kind.
    pub kind: PluginSourceKind,
    /// Index URL (for `https_json` / `git_json`) or local file path (for `local_file`).
    pub url: String,
    /// Optional Git ref for `git_json` sources.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_name: Option<String>,
    /// Optional relative path to `catalog-v1.json` inside a `git_json` repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index_path: Option<String>,
    /// Optional read-only local bundled plugin seed directory (for example, `/usr/share/z-shell/bundled-plugins`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_seed_dir: Option<PathBuf>,
    /// Whether this source participates in catalog refresh and search.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Display priority (lower numbers take precedence).
    #[serde(default = "default_source_priority")]
    pub priority: u32,
}

/// Plugin store and catalog source preferences (`[plugins]`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PluginsSettings {
    /// Configured static catalog sources (`[[plugins.sources]]`).
    pub sources: Vec<PluginSourceSettings>,
}

/// Public non-secret settings view broadcast on the `settings` topic (excludes plugin settings tables).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PublicSettingsSummary {
    /// General daemon settings.
    pub general: GeneralSettings,
    /// Bar and layout preferences (with per-instance plugin settings redacted).
    pub bar: BarSettings,
    /// Dynamic theme preferences.
    pub theme: ThemeSettings,
    /// Input method display preferences.
    pub ime: ImeSettings,
    /// Polkit authentication agent preferences.
    pub polkit: PolkitSettings,
    /// Wallpaper catalog and slideshow preferences.
    pub wallpaper: WallpaperSettings,
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
    /// Desktop wallpaper preferences.
    pub wallpaper: WallpaperSettings,
    /// Idle and lock preferences.
    pub idle: IdleSettings,
    /// Plugin store catalog sources (`[[plugins.sources]]`).
    pub plugins: PluginsSettings,
    /// Per-plugin configuration overrides keyed by canonical `author/plugin` ID.
    pub plugin_settings: BTreeMap<PluginId, toml::Value>,
}

impl UserSettings {
    /// Projects a non-secret public view safe for broadcasting on the `settings` bus topic.
    #[must_use]
    pub fn public_summary(&self) -> PublicSettingsSummary {
        PublicSettingsSummary {
            general: self.general.clone(),
            bar: self.bar.redacted_for_public(),
            theme: self.theme.clone(),
            ime: self.ime.clone(),
            polkit: self.polkit.clone(),
            wallpaper: self.wallpaper.clone(),
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
        if self.wallpaper.directories.len() > MAX_WALLPAPER_DIRECTORIES {
            return Err(format!(
                "wallpaper.directories supports at most {MAX_WALLPAPER_DIRECTORIES} entries, got {}",
                self.wallpaper.directories.len()
            ));
        }
        if self
            .wallpaper
            .directories
            .iter()
            .any(|dir| dir.trim().is_empty() || dir.chars().any(char::is_control))
        {
            return Err(
                "wallpaper.directories entries must be non-empty paths without control characters"
                    .to_owned(),
            );
        }
        if self.wallpaper.slideshow_seconds > MAX_WALLPAPER_SLIDESHOW_SECONDS {
            return Err(format!(
                "wallpaper.slideshow_seconds must be <= {MAX_WALLPAPER_SLIDESHOW_SECONDS}, got {}",
                self.wallpaper.slideshow_seconds
            ));
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
        validate_bar_plugins(&self.bar.plugins)?;
        validate_bar_tray(&self.bar.tray)?;
        validate_plugin_sources(&self.plugins.sources)?;
        Ok(())
    }
}

fn is_valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
}

fn validate_bar_plugins(plugins: &BarPluginsSettings) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for (zone, slots) in [
        ("left", &plugins.left),
        ("center", &plugins.center),
        ("right", &plugins.right),
        ("hidden", &plugins.hidden),
    ] {
        for slot in slots {
            let (entry, instance, output) = match slot {
                BarPluginSlot::Entry(entry) => (entry, "default", None),
                BarPluginSlot::Instance(inst) => {
                    if !is_valid_slug(&inst.instance) {
                        return Err(format!(
                            "bar.plugins.{zone} has invalid instance slug {:?}",
                            inst.instance
                        ));
                    }
                    if let Some(output) = &inst.output
                        && (output.trim().is_empty()
                            || output.contains('/')
                            || output.chars().any(char::is_control))
                    {
                        return Err(format!(
                            "bar.plugins.{zone} has invalid output selector {output:?}"
                        ));
                    }
                    (&inst.entry, inst.instance.as_str(), inst.output.as_deref())
                }
            };
            let key = (
                entry.to_string(),
                instance.to_owned(),
                output.map(ToOwned::to_owned),
            );
            if !seen.insert(key) {
                return Err(format!(
                    "duplicate bar plugin instance ({entry}, {instance:?}, {output:?})"
                ));
            }
        }
    }
    Ok(())
}

fn validate_bar_tray(tray: &BarTraySettings) -> Result<(), String> {
    if tray.rules.len() > MAX_BAR_TRAY_RULES {
        return Err(format!(
            "bar.tray.rules supports at most {MAX_BAR_TRAY_RULES} entries, got {}",
            tray.rules.len()
        ));
    }
    for key in tray.rules.keys() {
        let trimmed = key.trim();
        if trimmed.is_empty()
            || trimmed != key
            || key.len() > 256
            || key.chars().any(char::is_control)
        {
            return Err(format!(
                "bar.tray.rules contains invalid key {key:?} (1..=256 bytes, no control chars or outer whitespace)"
            ));
        }
    }
    Ok(())
}

fn validate_plugin_sources(sources: &[PluginSourceSettings]) -> Result<(), String> {
    let mut seen_ids = BTreeSet::new();
    for source in sources {
        if !is_valid_slug(&source.id) {
            return Err(format!(
                "plugins.sources has invalid source id {:?}",
                source.id
            ));
        }
        if !seen_ids.insert(source.id.as_str()) {
            return Err(format!(
                "duplicate plugin catalog source id {:?}",
                source.id
            ));
        }
        if source.name.trim().is_empty() || source.name.chars().any(char::is_control) {
            return Err(format!(
                "plugins.sources[{:?}] name must be non-empty without control characters",
                source.id
            ));
        }
        if source.url.trim().is_empty() || source.url.chars().any(char::is_control) {
            return Err(format!(
                "plugins.sources[{:?}] url must be non-empty without control characters",
                source.id
            ));
        }
        if source.kind == PluginSourceKind::HttpsJson
            && !source.url.starts_with("https://")
            && !source.url.starts_with("http://127.0.0.1")
            && !source.url.starts_with("http://[::1]")
            && !source.url.starts_with("http://localhost")
        {
            return Err(format!(
                "plugins.sources[{:?}] https_json url must use https://",
                source.id
            ));
        }
        if let Some(ref_name) = &source.ref_name
            && (ref_name.trim().is_empty() || ref_name.chars().any(char::is_control))
        {
            return Err(format!(
                "plugins.sources[{:?}] ref_name must be non-empty without control characters",
                source.id
            ));
        }
        if let Some(index_path) = &source.index_path {
            let invalid = index_path.is_empty()
                || index_path.starts_with('/')
                || index_path.contains('\\')
                || index_path.chars().any(char::is_control)
                || index_path
                    .split('/')
                    .any(|seg| seg.is_empty() || seg == "." || seg == "..");
            if invalid {
                return Err(format!(
                    "plugins.sources[{:?}] index_path must be a safe relative path, got {index_path:?}",
                    source.id
                ));
            }
        }
    }
    Ok(())
}
