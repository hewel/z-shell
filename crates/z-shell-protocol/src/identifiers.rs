//! Validated domain identifiers shared across the shell daemon, CLI, and plugins.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::str::FromStr;
use thiserror::Error;

/// Maximum byte length allowed for a single validated full identifier.
pub const MAX_IDENTIFIER_LEN: usize = 128;

/// Maximum byte length allowed for a single slug segment within an identifier.
pub const MAX_SEGMENT_LEN: usize = 64;

/// Error returned when parsing or validating a domain identifier.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum IdentifierError {
    /// Identifier is empty or exceeds [`MAX_IDENTIFIER_LEN`].
    #[error("identifier length out of bounds: {len} bytes")]
    InvalidLength {
        /// Observed length in bytes.
        len: usize,
    },
    /// Identifier contains a disallowed character, oversized segment, or empty segment.
    #[error("invalid {kind} identifier: {value:?}")]
    InvalidFormat {
        /// Human-readable identifier kind (for example, `"topic"`).
        kind: &'static str,
        /// Rejected raw string.
        value: String,
    },
}

fn check_len(raw: &str) -> Result<(), IdentifierError> {
    if raw.is_empty() || raw.len() > MAX_IDENTIFIER_LEN {
        return Err(IdentifierError::InvalidLength { len: raw.len() });
    }
    Ok(())
}

fn is_slug_segment(seg: &str) -> bool {
    !seg.is_empty()
        && seg.len() <= MAX_SEGMENT_LEN
        && seg
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        && !seg.starts_with('-')
        && !seg.ends_with('-')
}

/// Validated dot-separated topic name published on the bus (for example, `settings` or `daemon.status`).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TopicName(String);

impl TopicName {
    /// Validates and constructs a [`TopicName`].
    ///
    /// # Errors
    ///
    /// Returns [`IdentifierError`] if `raw` is empty, too long, or has invalid dot-separated segments.
    pub fn try_new(raw: impl Into<String>) -> Result<Self, IdentifierError> {
        let raw = raw.into();
        check_len(&raw)?;
        if !raw.split('.').all(is_slug_segment) {
            return Err(IdentifierError::InvalidFormat {
                kind: "topic",
                value: raw,
            });
        }
        Ok(Self(raw))
    }

    /// Returns the validated topic string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns true if this topic resides under the `plugin.` namespace.
    #[must_use]
    pub fn is_plugin_namespace(&self) -> bool {
        self.0.starts_with("plugin.")
    }
}

impl fmt::Display for TopicName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for TopicName {
    type Err = IdentifierError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::try_new(s)
    }
}

impl TryFrom<String> for TopicName {
    type Error = IdentifierError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::try_new(value)
    }
}

impl Serialize for TopicName {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for TopicName {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::try_new(raw).map_err(serde::de::Error::custom)
    }
}

/// Validated dot-separated control command name (for example, `status` or `plugin.ai-usage.refresh`).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CommandName(String);

impl CommandName {
    /// Validates and constructs a [`CommandName`].
    ///
    /// # Errors
    ///
    /// Returns [`IdentifierError`] if `raw` is empty, too long, or has invalid segments.
    pub fn try_new(raw: impl Into<String>) -> Result<Self, IdentifierError> {
        let raw = raw.into();
        check_len(&raw)?;
        if !raw.split('.').all(is_slug_segment) {
            return Err(IdentifierError::InvalidFormat {
                kind: "command",
                value: raw,
            });
        }
        Ok(Self(raw))
    }

    /// Returns the validated command string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns true if this command resides under the `plugin.` namespace.
    #[must_use]
    pub fn is_plugin_namespace(&self) -> bool {
        self.0.starts_with("plugin.")
    }
}

impl fmt::Display for CommandName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for CommandName {
    type Err = IdentifierError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::try_new(s)
    }
}

impl TryFrom<String> for CommandName {
    type Error = IdentifierError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::try_new(value)
    }
}

impl Serialize for CommandName {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for CommandName {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::try_new(raw).map_err(serde::de::Error::custom)
    }
}

/// Canonical plugin identifier in `author/plugin` form with flat, path-safe segments.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PluginId(String);

impl PluginId {
    /// Validates and constructs a [`PluginId`].
    ///
    /// # Errors
    ///
    /// Returns [`IdentifierError`] if `raw` is not two path-safe lowercase slug segments separated by `/`.
    pub fn try_new(raw: impl Into<String>) -> Result<Self, IdentifierError> {
        let raw = raw.into();
        check_len(&raw)?;
        let Some((author, name)) = raw.split_once('/') else {
            return Err(IdentifierError::InvalidFormat {
                kind: "plugin id",
                value: raw,
            });
        };
        if name.contains('/') || !is_slug_segment(author) || !is_slug_segment(name) {
            return Err(IdentifierError::InvalidFormat {
                kind: "plugin id",
                value: raw,
            });
        }
        Ok(Self(raw))
    }

    /// Returns the full `author/plugin` identifier.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Returns the `author` segment.
    #[must_use]
    pub fn author(&self) -> &str {
        self.0
            .split_once('/')
            .expect("validated PluginId contains '/'")
            .0
    }

    /// Returns the `plugin` name segment.
    #[must_use]
    pub fn name(&self) -> &str {
        self.0
            .split_once('/')
            .expect("validated PluginId contains '/'")
            .1
    }
}

impl fmt::Display for PluginId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for PluginId {
    type Err = IdentifierError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::try_new(s)
    }
}

impl Serialize for PluginId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for PluginId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::try_new(raw).map_err(serde::de::Error::custom)
    }
}

/// Canonical plugin entry identifier in `author/plugin:entry` form.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PluginEntryId {
    plugin: PluginId,
    entry: String,
}

impl PluginEntryId {
    /// Validates and constructs a [`PluginEntryId`] from `author/plugin:entry`.
    ///
    /// # Errors
    ///
    /// Returns [`IdentifierError`] if the plugin prefix or entry slug is invalid.
    pub fn try_new(raw: impl Into<String>) -> Result<Self, IdentifierError> {
        let raw = raw.into();
        check_len(&raw)?;
        let Some((plugin_part, entry_part)) = raw.split_once(':') else {
            return Err(IdentifierError::InvalidFormat {
                kind: "plugin entry id",
                value: raw,
            });
        };
        if !is_slug_segment(entry_part) {
            return Err(IdentifierError::InvalidFormat {
                kind: "plugin entry id",
                value: raw,
            });
        }
        let plugin = PluginId::try_new(plugin_part)?;
        Ok(Self {
            plugin,
            entry: entry_part.to_owned(),
        })
    }

    /// Returns the owning [`PluginId`].
    #[must_use]
    pub fn plugin(&self) -> &PluginId {
        &self.plugin
    }

    /// Returns the entry slug.
    #[must_use]
    pub fn entry(&self) -> &str {
        &self.entry
    }
}

impl fmt::Display for PluginEntryId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.plugin, self.entry)
    }
}

impl FromStr for PluginEntryId {
    type Err = IdentifierError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::try_new(s)
    }
}

impl Serialize for PluginEntryId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for PluginEntryId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::try_new(raw).map_err(serde::de::Error::custom)
    }
}

/// Fixed contribution kinds declared inside a `plugin.toml` manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum PluginEntryKind {
    /// Floating island or widget mounted inside the bar.
    Widget,
    /// Quick Settings toggle or shortcut tile.
    Shortcut,
    /// Anchored, floating, or centered transient shell panel.
    Panel,
    /// Headless background logic integrating external sockets, CLIs, or bus hooks.
    Service,
    /// Custom search or command provider inside the launcher.
    LauncherProvider,
    /// Settings page contributed to the shell settings UI.
    SettingsPage,
    /// Custom Wayland layer surface entry.
    Layer,
}
