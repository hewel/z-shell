//! Static plugin manifests, immutable bundles, catalogs, and durable capability approval for z-shell.

pub mod archive;
pub mod bundle;
pub mod capabilities;
pub mod catalog;
pub mod catalog_media;
pub mod digest;
mod git;
mod manifest;
pub mod net;
pub mod registry;

pub use git::GitError;
pub use manifest::{
    BarZone, BuildManifest, BuildMetadata, CompatibilityError, HOST_SHARED_RUNTIME_ABI, Manifest,
    ManifestEntry, ManifestError, PanelWidthTier, SUPPORTED_PLUGIN_API_LEVEL, SharedRuntimeAbi,
    StoreCategory, StoreMetadata,
};
