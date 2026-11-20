//! Normalized capability sets and exact approval differences.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Requested authority in the native zgui-js host.
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
        self.host.commands.is_subset(&approved.host.commands)
            && self
                .host
                .image_prefixes
                .is_subset(&approved.host.image_prefixes)
            && self
                .host
                .unix_sockets
                .is_subset(&approved.host.unix_sockets)
            && self
                .host
                .named_sockets
                .is_subset(&approved.host.named_sockets)
            && (!self.host.shell_surfaces || approved.host.shell_surfaces)
            && (!self.host.control_channel || approved.host.control_channel)
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
            host: HostCapabilities {
                commands: difference(&self.host.commands, &other.host.commands),
                image_prefixes: difference(&self.host.image_prefixes, &other.host.image_prefixes),
                unix_sockets: difference(&self.host.unix_sockets, &other.host.unix_sockets),
                named_sockets: difference(&self.host.named_sockets, &other.host.named_sockets),
                shell_surfaces: self.host.shell_surfaces && !other.host.shell_surfaces,
                control_channel: self.host.control_channel && !other.host.control_channel,
            },
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

fn difference(left: &BTreeSet<String>, right: &BTreeSet<String>) -> BTreeSet<String> {
    left.difference(right).cloned().collect()
}
