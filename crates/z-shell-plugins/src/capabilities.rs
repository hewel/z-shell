//! Normalized capability sets, lossless per-origin merge, and exact approval diffs.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

/// Host clipboard authority requested by a plugin.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClipboardCapabilities {
    /// Allows reading clipboard contents outside an active UI gesture.
    #[serde(default)]
    pub read_outside_gesture: bool,
}

impl ClipboardCapabilities {
    /// Returns true when no elevated clipboard permissions are requested.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        !self.read_outside_gesture
    }
}

/// Host SQLite database authority requested by a plugin.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SqliteCapabilities {
    /// Named SQLite databases the plugin may open through the host service.
    #[serde(default)]
    pub databases: BTreeSet<String>,
}

impl SqliteCapabilities {
    /// Returns true when no SQLite databases are requested.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.databases.is_empty()
    }
}

/// Host filesystem directory authority requested by a plugin.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilesCapabilities {
    /// Canonical absolute paths or constrained runtime templates accessible to the plugin.
    #[serde(default)]
    pub directories: BTreeSet<String>,
}

impl FilesCapabilities {
    /// Returns true when no filesystem directories are requested.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.directories.is_empty()
    }
}

/// Per-origin outbound HTTP(S) policy (`[[host_capabilities.network_origins]]`).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkOriginRule {
    /// Normalized scheme + host (+ optional port) origin (for example, `https://api.open-meteo.com`).
    pub origin: String,
    /// Permits plaintext `http://` only for this exact origin.
    #[serde(default)]
    pub allow_insecure_http: bool,
    /// Permits loopback/private RFC1918/link-local addresses only for this exact origin.
    #[serde(default)]
    pub allow_private_networks: bool,
}

/// Error returned when merging multiple plugins' host capabilities losslessly.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum CapabilityMergeError {
    /// Two plugins declared incompatible network policies for the exact same origin.
    #[error("conflicting network origin policy for {origin}")]
    ConflictingOriginPolicy {
        /// Origin whose policies conflicted across plugins.
        origin: String,
    },
}

/// Requested authority in the native `zgui-js` host.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostCapabilities {
    /// Executable names or paths.
    pub commands: BTreeSet<String>,
    /// Canonical absolute host image paths or constrained runtime path templates.
    pub image_prefixes: BTreeSet<String>,
    /// Canonical absolute Unix socket paths or constrained runtime path templates.
    pub unix_sockets: BTreeSet<String>,
    /// Named Unix socket bindings resolved by the host (`zgui-js#24`).
    #[serde(default)]
    pub named_sockets: BTreeSet<String>,
    /// Permission to create shell surfaces.
    pub shell_surfaces: bool,
    /// Permission to access the host control channel.
    pub control_channel: bool,
    /// Clipboard capability declarations.
    #[serde(default, skip_serializing_if = "ClipboardCapabilities::is_empty")]
    pub clipboard: ClipboardCapabilities,
    /// SQLite database capability declarations.
    #[serde(default, skip_serializing_if = "SqliteCapabilities::is_empty")]
    pub sqlite: SqliteCapabilities,
    /// Filesystem directory capability declarations.
    #[serde(default, skip_serializing_if = "FilesCapabilities::is_empty")]
    pub files: FilesCapabilities,
    /// Per-origin outbound network policy declarations.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub network_origins: BTreeSet<NetworkOriginRule>,
}

impl HostCapabilities {
    fn is_covered_by(&self, approved: &Self) -> bool {
        self.commands.is_subset(&approved.commands)
            && self.image_prefixes.is_subset(&approved.image_prefixes)
            && self.unix_sockets.is_subset(&approved.unix_sockets)
            && self.named_sockets.is_subset(&approved.named_sockets)
            && (!self.shell_surfaces || approved.shell_surfaces)
            && (!self.control_channel || approved.control_channel)
            && (!self.clipboard.read_outside_gesture || approved.clipboard.read_outside_gesture)
            && self.sqlite.databases.is_subset(&approved.sqlite.databases)
            && self
                .files
                .directories
                .is_subset(&approved.files.directories)
            && self.network_origins.iter().all(|rule| {
                approved.network_origins.iter().any(|candidate| {
                    candidate.origin == rule.origin
                        && (!rule.allow_insecure_http || candidate.allow_insecure_http)
                        && (!rule.allow_private_networks || candidate.allow_private_networks)
                })
            })
    }

    fn difference_from(&self, other: &Self) -> Self {
        Self {
            commands: difference(&self.commands, &other.commands),
            image_prefixes: difference(&self.image_prefixes, &other.image_prefixes),
            unix_sockets: difference(&self.unix_sockets, &other.unix_sockets),
            named_sockets: difference(&self.named_sockets, &other.named_sockets),
            shell_surfaces: self.shell_surfaces && !other.shell_surfaces,
            control_channel: self.control_channel && !other.control_channel,
            clipboard: ClipboardCapabilities {
                read_outside_gesture: self.clipboard.read_outside_gesture
                    && !other.clipboard.read_outside_gesture,
            },
            sqlite: SqliteCapabilities {
                databases: difference(&self.sqlite.databases, &other.sqlite.databases),
            },
            files: FilesCapabilities {
                directories: difference(&self.files.directories, &other.files.directories),
            },
            network_origins: self
                .network_origins
                .iter()
                .filter(|rule| {
                    !other.network_origins.iter().any(|candidate| {
                        candidate.origin == rule.origin
                            && (!rule.allow_insecure_http || candidate.allow_insecure_http)
                            && (!rule.allow_private_networks || candidate.allow_private_networks)
                    })
                })
                .cloned()
                .collect(),
        }
    }
}

/// Requested authority on the shell bus.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BusPermissions {
    /// Topics the plugin may read.
    pub topics_read: BTreeSet<String>,
    /// Plugin-namespace topics the plugin may publish.
    pub topics_publish: BTreeSet<String>,
    /// Plugin-namespace commands the plugin may register.
    pub commands_register: BTreeSet<String>,
    /// Permission to acquire inhibitors.
    pub inhibitors: bool,
}

/// Host and bus authority recorded together as one approval.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityBundle {
    /// Native host authority.
    pub host: HostCapabilities,
    /// Shell bus authority.
    pub bus: BusPermissions,
}

/// Exact additions and removals relative to the last explicit approval.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct CapabilityDiff {
    /// Requested authority absent from the approval.
    pub added: CapabilityBundle,
    /// Approved authority no longer requested.
    pub removed: CapabilityBundle,
}

impl CapabilityBundle {
    /// Checks that the approval covers every requested capability by exact membership.
    #[must_use]
    pub fn is_covered_by(&self, approved: &Self) -> bool {
        self.host.is_covered_by(&approved.host)
            && self.bus.topics_read.is_subset(&approved.bus.topics_read)
            && self
                .bus
                .topics_publish
                .is_subset(&approved.bus.topics_publish)
            && self
                .bus
                .commands_register
                .is_subset(&approved.bus.commands_register)
            && (!self.bus.inhibitors || approved.bus.inhibitors)
    }

    /// Compares requested authority against an explicit approval, or against an empty bundle.
    #[must_use]
    pub fn diff(&self, approved: Option<&Self>) -> CapabilityDiff {
        let empty = Self::default();
        let approved = approved.unwrap_or(&empty);
        CapabilityDiff {
            added: self.difference(approved),
            removed: approved.difference(self),
        }
    }

    fn difference(&self, other: &Self) -> Self {
        Self {
            host: self.host.difference_from(&other.host),
            bus: BusPermissions {
                topics_read: difference(&self.bus.topics_read, &other.bus.topics_read),
                topics_publish: difference(&self.bus.topics_publish, &other.bus.topics_publish),
                commands_register: difference(
                    &self.bus.commands_register,
                    &other.bus.commands_register,
                ),
                inhibitors: self.bus.inhibitors && !other.bus.inhibitors,
            },
        }
    }
}

impl CapabilityDiff {
    /// Returns whether this diff introduces any new authority.
    #[must_use]
    pub fn requires_approval(&self) -> bool {
        self.added != CapabilityBundle::default()
    }
}

/// Losslessly merges multiple plugins' [`HostCapabilities`] without boolean-OR network pollution.
///
/// # Errors
///
/// Returns [`CapabilityMergeError::ConflictingOriginPolicy`] if two plugins specify different
/// `allow_insecure_http` or `allow_private_networks` flags for the exact same origin.
pub fn merge_host_capabilities(
    items: &[HostCapabilities],
) -> Result<HostCapabilities, CapabilityMergeError> {
    let mut merged = HostCapabilities::default();
    let mut by_origin: BTreeMap<&str, &NetworkOriginRule> = BTreeMap::new();
    for item in items {
        merged.commands.extend(item.commands.iter().cloned());
        merged
            .image_prefixes
            .extend(item.image_prefixes.iter().cloned());
        merged
            .unix_sockets
            .extend(item.unix_sockets.iter().cloned());
        merged
            .named_sockets
            .extend(item.named_sockets.iter().cloned());
        merged.shell_surfaces |= item.shell_surfaces;
        merged.control_channel |= item.control_channel;
        merged.clipboard.read_outside_gesture |= item.clipboard.read_outside_gesture;
        merged
            .sqlite
            .databases
            .extend(item.sqlite.databases.iter().cloned());
        merged
            .files
            .directories
            .extend(item.files.directories.iter().cloned());
        for rule in &item.network_origins {
            if let Some(existing) = by_origin.get(rule.origin.as_str()) {
                if *existing != rule {
                    return Err(CapabilityMergeError::ConflictingOriginPolicy {
                        origin: rule.origin.clone(),
                    });
                }
            } else {
                by_origin.insert(rule.origin.as_str(), rule);
            }
        }
    }
    merged.network_origins = by_origin.into_values().cloned().collect();
    Ok(merged)
}

/// Computes the net new host capabilities added to `baseline` by enabling `requested`.
#[must_use]
pub fn net_added_host_capabilities(
    baseline: &HostCapabilities,
    requested: &HostCapabilities,
) -> HostCapabilities {
    requested.difference_from(baseline)
}

fn difference(left: &BTreeSet<String>, right: &BTreeSet<String>) -> BTreeSet<String> {
    left.difference(right).cloned().collect()
}
