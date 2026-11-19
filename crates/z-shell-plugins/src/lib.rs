//! Static plugin manifests and durable capability approval for z-shell.

pub mod capabilities;
pub mod digest;
mod git;
mod manifest;
pub mod registry;

pub use git::GitError;
pub use manifest::{Manifest, ManifestEntry, ManifestError, SUPPORTED_PLUGIN_API_LEVEL};
