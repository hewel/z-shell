//! Cross-process v2 plugin registry, immutable bundle pins, upgrade staging, and health checks.

use std::collections::{BTreeMap, BTreeSet, btree_map::Entry};
use std::fs::{self, DirBuilder, File, OpenOptions, Permissions};
use std::io::{self, BufWriter, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use rustix::fs::{FlockOperation, flock};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use thiserror::Error;
use z_shell_config::{ConfigError, ConfigStore, ShellPaths};
use z_shell_protocol::PluginId;

use crate::archive::{self, ArchiveError};
use crate::bundle::{
    BundleError, bundle_dir_for, materialize_bundle, remove_bundle_tree, verify_bundle,
};
use crate::capabilities::{
    CapabilityBundle, CapabilityDiff, CapabilityMergeError, HostCapabilities,
    merge_host_capabilities, net_added_host_capabilities,
};
use crate::catalog::{CatalogArtifact, CatalogError, ResolvedCatalogRelease};
use crate::digest::{DigestError, content_digest};
use crate::git;
use crate::manifest::{
    CompatibilityError, HOST_SHARED_RUNTIME_ABI, Manifest, ManifestError,
    SUPPORTED_PLUGIN_API_LEVEL, SharedRuntimeAbi,
};

const SCHEMA_VERSION_V1: u32 = 1;
const SCHEMA_VERSION_V2: u32 = 2;

/// Whether remote Git, HTTP archive, and remote catalog fetches are allowed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfflinePolicy {
    /// Allow network or remote Git operations.
    Online,
    /// Forbid network or remote Git operations; permit local seeds and verified bundle caches only.
    Offline,
}

/// Whether `remove` also deletes `[plugin_settings."<id>"]` in user settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoveSettingsPolicy {
    /// Retain user configuration for the removed plugin.
    KeepSettings,
    /// Delete the plugin's `[plugin_settings."<id>"]` entry if present.
    PurgeSettings,
}

/// How [`PluginManager::commit_upgrade`] handles capability changes on upgrade.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpgradeApprovalMode {
    /// Refuse if the upgrade expands capabilities beyond existing explicit approval.
    KeepExistingOnly,
    /// Record an explicit fresh approval covering all requested capabilities of the new version.
    ApproveExpanded,
}

/// Where a catalog installation or upgrade artifact was sourced from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ResolvedFrom {
    /// Reused an already-verified immutable local bundle matching the pinned `content_digest`.
    LocalVerifiedCache,
    /// Installed from the local bundled official seed directory.
    BundledOfficialSeed,
    /// Fetched from a remote HTTP archive or Git remote.
    Remote,
    /// Unpacked from a local archive file on disk.
    LocalArtifact,
}

/// Error returned by plugin registry, installation, upgrade, or lifecycle operations.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum PluginError {
    /// Filesystem I/O failure.
    #[error("plugin I/O error at {path}: {source}")]
    Io {
        /// Path involved in the operation.
        path: PathBuf,
        /// Underlying OS error.
        #[source]
        source: io::Error,
    },
    /// Registry JSON deserialization or serialization failed.
    #[error("invalid plugin registry JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// Registry schema version is unsupported.
    #[error("unsupported plugin registry schema version {0}")]
    RegistryVersion(u32),
    /// Map key inside `registry.json` does not match `record.id`.
    #[error("plugin registry key does not match the record id: {0}")]
    RegistryId(PluginId),
    /// Static manifest validation failed.
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    /// Runtime API/ABI compatibility check failed.
    #[error(transparent)]
    Compatibility(#[from] CompatibilityError),
    /// Content digest calculation failed.
    #[error(transparent)]
    Digest(#[from] DigestError),
    /// Immutable bundle materialization or verification failed.
    #[error(transparent)]
    Bundle(#[from] BundleError),
    /// Git fetch or export failed.
    #[error(transparent)]
    Git(#[from] git::GitError),
    /// Archive download, digest check, or unpacking failed.
    #[error(transparent)]
    Archive(#[from] ArchiveError),
    /// Catalog lookup or resolution failed.
    #[error(transparent)]
    Catalog(#[from] CatalogError),
    /// Merging host capabilities across enabled plugins failed.
    #[error(transparent)]
    CapabilityMerge(#[from] CapabilityMergeError),
    /// Reading or updating user settings during purge failed.
    #[error(transparent)]
    Config(#[from] ConfigError),
    /// Plugin ID is not present in the registry.
    #[error("plugin {0} is not installed")]
    NotFound(PluginId),
    /// Plugin ID is already installed in the registry.
    #[error("plugin {0} is already installed; use sync or upgrade to update it")]
    AlreadyInstalled(PluginId),
    /// Operation requested a remote fetch while offline and no verified local cache matched.
    #[error("operation blocked in offline mode without a verified local bundle cache")]
    OfflineModeBlocked,
    /// Cross-source installation or upgrade attempted for an existing `PluginId`.
    #[error(
        "plugin {id} is already bound to source {existing_source}; \
         refusing automatic switch to {incoming_source}"
    )]
    SourceConflict {
        /// Conflicting plugin ID.
        id: PluginId,
        /// Existing canonical `source_identity`.
        existing_source: String,
        /// Incoming canonical `source_identity`.
        incoming_source: String,
    },
    /// Catalog release content digest did not match the unpacked/exported bundle.
    #[error("catalog release content digest mismatch: expected {expected}, got {actual}")]
    CatalogDigestMismatch {
        /// Expected `sha256:<64-hex>` digest from catalog metadata.
        expected: String,
        /// Computed digest from actual bundle tree.
        actual: String,
    },
    /// Registry state changed between `stage_upgrade` and `commit_upgrade`.
    #[error("registry changed concurrently between upgrade staging and commit (TOCTOU mismatch)")]
    ToctouMismatch,
    /// Upgrade adds capabilities beyond current approval and caller did not authorize expansion.
    #[error("upgrading plugin {0} expands capabilities and requires explicit approval")]
    CapabilityExpansionRequiresApproval(PluginId),
    /// Source update attempted to change the manifest's `id`.
    #[error("plugin source id changed from {expected} to {actual}")]
    IdChanged {
        /// Installed plugin ID.
        expected: PluginId,
        /// ID observed in updated source.
        actual: PluginId,
    },
    /// Plugin lacks valid non-revoked approval covering its requested capabilities.
    #[error("plugin {0} requires explicit capability approval before enabling")]
    ApprovalRequired(PluginId),
    /// Plugin approval was explicitly revoked and cannot be implicitly restored.
    #[error("plugin {0} approval was revoked")]
    Revoked(PluginId),
    /// On-disk bundle or `--path` source drifted from the pinned digest.
    #[error("plugin {0} content digest has drifted; sync and audit the source first")]
    DigestDrift(PluginId),
}

/// Public plugin metadata without source paths, credentials, or user settings values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct PluginSummary {
    /// Canonical plugin identifier.
    pub id: PluginId,
    /// Display name from manifest.
    pub name: String,
    /// Package version.
    pub version: String,
    /// Manifest `plugin_api` level.
    pub plugin_api: u32,
    /// Required `shared_runtime_abi`.
    pub shared_runtime_abi: SharedRuntimeAbi,
    /// Canonical source provenance binding.
    pub source_identity: String,
    /// Bound catalog source ID when installed from a catalog source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_source_id: Option<String>,
    /// Pinned bundle content digest.
    pub content_digest: String,
    /// Whether composition is enabled.
    pub enabled: bool,
    /// Whether approval has been explicitly revoked.
    pub revoked: bool,
    /// Whether the plugin requires fresh human re-approval after v1 → v2 migration.
    pub migration_reapproval_required: bool,
    /// Whether a valid, non-revoked explicit approval currently covers requested capabilities.
    pub approved: bool,
}

impl PluginSummary {
    /// Returns a public-bus-safe projection that redacts raw local filesystem paths from
    /// `source_identity` while preserving deterministic provenance hashes for comparison.
    #[must_use]
    pub fn redacted_for_public(&self) -> Self {
        let mut copy = self.clone();
        copy.source_identity = redact_source_identity(&self.source_identity);
        copy
    }
}

/// Consistent single-read snapshot of `desired_revision` and installed plugin summaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct PluginRegistrySnapshot {
    /// Monotonic desired registry revision read atomically with `plugins`.
    pub desired_revision: u64,
    /// Installed plugin summaries at `desired_revision`.
    pub plugins: Vec<PluginSummary>,
}

/// Audit breakdown of installed authority, net host expansion, and bundle integrity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct AuditReport {
    /// Installed plugin summary.
    pub plugin: PluginSummary,
    /// Requested authority diff against the plugin's own explicit approval.
    pub diff: CapabilityDiff,
    /// Net host capabilities this plugin would add to the baseline of other currently enabled plugins.
    pub net_added_host_capabilities: HostCapabilities,
    /// Content digest currently observed on disk.
    pub current_content_digest: String,
    /// True when the on-disk bundle (and `--path` source, if applicable) matches the pinned digest.
    pub digest_matches: bool,
}

impl AuditReport {
    /// Returns a public-bus-safe projection with redacted `plugin.source_identity`.
    #[must_use]
    pub fn redacted_for_public(&self) -> Self {
        Self {
            plugin: self.plugin.redacted_for_public(),
            diff: self.diff.clone(),
            net_added_host_capabilities: self.net_added_host_capabilities.clone(),
            current_content_digest: self.current_content_digest.clone(),
            digest_matches: self.digest_matches,
        }
    }
}

/// Prepared candidate new installation awaiting explicit user confirmation via
/// [`PluginManager::commit_install`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct StagedInstall {
    /// Target plugin identifier.
    pub id: PluginId,
    /// Display name from manifest.
    pub name: String,
    /// Candidate package version.
    pub version: String,
    /// Candidate `plugin_api` level.
    pub plugin_api: u32,
    /// Candidate `shared_runtime_abi`.
    pub shared_runtime_abi: SharedRuntimeAbi,
    /// Verified bundle content digest.
    pub content_digest: String,
    /// Canonical `source_identity` bound at install.
    pub source_identity: String,
    /// Requested capabilities declared by the staged manifest.
    pub requested_capabilities: CapabilityBundle,
    /// Net host capabilities added relative to currently enabled plugins.
    pub net_added_host_capabilities: HostCapabilities,
    /// Provenance of the staged candidate bundle.
    pub resolved_from: ResolvedFrom,
    #[serde(skip)]
    source: Source,
}

/// Result of installing a plugin from a catalog source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct InstallOutcome {
    /// Installed plugin summary (initially disabled and unapproved).
    pub summary: PluginSummary,
    /// Where the verified bundle originated.
    pub resolved_from: ResolvedFrom,
}

/// Result of removing a plugin from the registry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct RemovedPlugin {
    /// Removed plugin identifier.
    pub id: PluginId,
    /// Updated registry `desired_revision`.
    pub desired_revision: u64,
    /// True when `[plugin_settings."<id>"]` existed and was removed.
    pub settings_purged: bool,
}

/// Prepared candidate upgrade awaiting explicit user confirmation via [`PluginManager::commit_upgrade`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct StagedUpgrade {
    /// Target plugin identifier.
    pub id: PluginId,
    /// Display name in the new manifest.
    pub name: String,
    /// Currently installed version.
    pub from_version: String,
    /// Candidate new version.
    pub to_version: String,
    /// Candidate `plugin_api` level.
    pub plugin_api: u32,
    /// Candidate `shared_runtime_abi`.
    pub shared_runtime_abi: SharedRuntimeAbi,
    /// Pinned digest observed when staging began (TOCTOU guard).
    pub from_digest: String,
    /// Verified bundle digest of the staged candidate.
    pub to_digest: String,
    /// Bound `source_identity` shared by existing record and incoming release.
    pub source_identity: String,
    /// Candidate capability diff relative to current explicit approval.
    pub diff: CapabilityDiff,
    /// Net host capabilities added relative to other currently enabled plugins.
    pub net_added_host_capabilities: HostCapabilities,
    /// True when approval does not cover the new version (or migration/revocation is active).
    pub requires_reapproval: bool,
    /// Provenance of the staged candidate bundle.
    pub resolved_from: ResolvedFrom,
    #[serde(skip)]
    new_source: Source,
    #[serde(skip)]
    requested_capabilities: CapabilityBundle,
    #[serde(skip)]
    was_revoked: bool,
}

/// Diagnostic severity reported by [`PluginManager::doctor`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum DoctorSeverity {
    /// Informational note.
    Info,
    /// Action recommended before enabling or upgrading.
    Warning,
    /// Broken state requiring remediation or re-sync.
    Error,
}

/// One diagnostic finding from [`PluginManager::doctor`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct DoctorFinding {
    /// Stable machine-readable finding code.
    pub code: String,
    /// Severity level.
    pub severity: DoctorSeverity,
    /// Related plugin identifier, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<PluginId>,
    /// Human-readable description and remediation hint.
    pub message: String,
}

impl DoctorFinding {
    /// Returns a public-bus-safe projection that strips raw filesystem paths from diagnostic messages.
    #[must_use]
    pub fn redacted_for_public(&self) -> Self {
        let message = match self.code.as_str() {
            "path_source_drifted" => self.plugin_id.as_ref().map_or_else(
                || "local path source changed since pinned digest".to_owned(),
                |id| {
                    format!(
                        "local path source changed since pinned digest; run `z-shell plugin sync {id}`"
                    )
                },
            ),
            "path_source_unreadable" => self.plugin_id.as_ref().map_or_else(
                || "local path source is missing or unreadable".to_owned(),
                |id| format!("local path source for {id} is missing or unreadable"),
            ),
            "orphan_bundle" => "unreferenced bundle directory on disk".to_owned(),
            "stale_staging_dir" => "leftover staging entry on disk".to_owned(),
            _ => self.message.clone(),
        };
        Self {
            code: self.code.clone(),
            severity: self.severity,
            plugin_id: self.plugin_id.clone(),
            message,
        }
    }
}

/// Manages v2 static plugin bundles, catalog installs, upgrades, and durable approvals.
#[derive(Debug, Clone)]
pub struct PluginManager {
    paths: ShellPaths,
}

impl PluginManager {
    /// Creates a plugin manager backed by `paths` without opening sockets or modifying runtime files.
    #[must_use]
    pub fn new(paths: ShellPaths) -> Self {
        Self { paths }
    }

    /// Lists all installed plugins without reading secret plugin settings.
    ///
    /// If an untouched v1 registry exists on disk, migrates it safely to v2 (disabling plugins,
    /// clearing implicit approvals, and writing `registry.v1.bak.json` with mode `0600`).
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] if loading or migrating the registry fails.
    pub fn list(&self) -> Result<Vec<PluginSummary>, PluginError> {
        Ok(self.snapshot()?.plugins)
    }

    /// Reads `desired_revision` and all plugin summaries in a single atomic registry load.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] if loading or migrating the registry fails.
    pub fn snapshot(&self) -> Result<PluginRegistrySnapshot, PluginError> {
        let registry = self.load_with_migration()?;
        Ok(PluginRegistrySnapshot {
            desired_revision: registry.desired_revision,
            plugins: registry.plugins.values().map(Record::summary).collect(),
        })
    }

    /// Returns the monotonic `desired_revision` counter of the current registry.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] if the registry cannot be loaded or migrated.
    pub fn desired_revision(&self) -> Result<u64, PluginError> {
        Ok(self.load_with_migration()?.desired_revision)
    }

    /// Installs a validated local directory, cloning an immutable bundle snapshot.
    ///
    /// The plugin starts disabled without capability approval. Never modifies or deletes `root`.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on invalid manifest, `.qjsb` rejection, duplicate/conflicting ID,
    /// or filesystem I/O failure.
    pub fn add_path(&self, root: impl AsRef<Path>) -> Result<PluginSummary, PluginError> {
        let _lock = self.lock()?;
        let registry = self.load_migrated_locked()?;
        let root = at(root.as_ref(), fs::canonicalize(root.as_ref()))?;
        let manifest = Manifest::load(&root)?;
        manifest.check_runtime_compatibility(HOST_SHARED_RUNTIME_ABI)?;
        let digest = content_digest(&root)?;
        let source_identity = format!("path:{}", root.display());
        if let Some(existing) = registry.plugins.get(&manifest.id) {
            return Err(conflict_or_already_installed(existing, &source_identity));
        }
        let bundle_path = materialize_bundle(
            &self.paths.plugins_bundles_dir(),
            &manifest.id,
            &root,
            &digest,
        )?;
        self.install(
            registry,
            manifest,
            Source::Path { root, bundle_path },
            source_identity,
            digest,
        )
    }

    /// Installs a pinned export from a Git remote root, disabled and unapproved.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on offline policy, fetch/export error, invalid manifest, or
    /// duplicate/conflicting ID.
    pub fn add_git(
        &self,
        url: &str,
        ref_name: &str,
        policy: OfflinePolicy,
    ) -> Result<PluginSummary, PluginError> {
        self.add_git_impl(url, ref_name, None, policy)
    }

    /// Installs a pinned export from a monorepo `subdir` inside a Git remote, disabled and unapproved.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on invalid `subdir`, offline policy, fetch/export error, or
    /// duplicate/conflicting ID.
    pub fn add_git_subdir(
        &self,
        url: &str,
        ref_name: &str,
        subdir: &str,
        policy: OfflinePolicy,
    ) -> Result<PluginSummary, PluginError> {
        let validated = git::validate_subdir(subdir)?;
        self.add_git_impl(url, ref_name, Some(&validated), policy)
    }

    fn add_git_impl(
        &self,
        url: &str,
        ref_name: &str,
        subdir: Option<&str>,
        policy: OfflinePolicy,
    ) -> Result<PluginSummary, PluginError> {
        let _lock = self.lock()?;
        let registry = self.load_migrated_locked()?;
        let plugins_dir = at(
            &self.paths.plugins_dir(),
            fs::canonicalize(self.paths.plugins_dir()),
        )?;
        let bundles_dir = self.paths.plugins_bundles_dir();
        let staging_dir = self.paths.plugins_staging_dir();
        let prepared = git::prepare_bundle(
            git::GitWorkspace {
                plugins_dir: &plugins_dir,
                bundles_dir: &bundles_dir,
                staging_dir: &staging_dir,
            },
            url,
            ref_name,
            subdir,
            policy,
            None,
        )?;
        let source_identity = format!(
            "git:{}|{}",
            prepared.url,
            prepared.subdir.as_deref().unwrap_or("")
        );
        if let Err(err) = prepared
            .manifest
            .check_runtime_compatibility(HOST_SHARED_RUNTIME_ABI)
        {
            cleanup_unreferenced_bundle(&bundles_dir, &registry, &prepared.root);
            return Err(err.into());
        }
        if let Some(existing) = registry.plugins.get(&prepared.manifest.id) {
            cleanup_unreferenced_bundle(&bundles_dir, &registry, &prepared.root);
            return Err(conflict_or_already_installed(existing, &source_identity));
        }
        let source = Source::Git {
            url: prepared.url,
            ref_name: ref_name.to_owned(),
            subdir: prepared.subdir,
            rev: prepared.rev,
            bundle_path: prepared.root,
        };
        self.install(
            registry,
            prepared.manifest,
            source,
            source_identity,
            prepared.content_digest,
        )
    }

    /// Installs a `.tar.gz` or `.tar.zst` archive pinned by SHA-256, disabled and unapproved.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on offline policy, HTTP/digest/tar-bomb errors, incompatible manifest,
    /// or duplicate/conflicting ID.
    pub fn add_archive(
        &self,
        source: &str,
        expected_sha256: &str,
        policy: OfflinePolicy,
    ) -> Result<PluginSummary, PluginError> {
        let _lock = self.lock()?;
        let registry = self.load_migrated_locked()?;
        let bundles_dir = self.paths.plugins_bundles_dir();
        let unpacked = archive::unpack_archive_bundle(
            &self.paths.plugins_staging_dir(),
            &bundles_dir,
            source,
            expected_sha256,
            policy,
        )?;
        let source_identity = format!("archive:{}", unpacked.source);
        if let Err(err) = unpacked
            .manifest
            .check_runtime_compatibility(HOST_SHARED_RUNTIME_ABI)
        {
            cleanup_unreferenced_bundle(&bundles_dir, &registry, &unpacked.bundle_root);
            return Err(err.into());
        }
        if let Some(existing) = registry.plugins.get(&unpacked.manifest.id) {
            cleanup_unreferenced_bundle(&bundles_dir, &registry, &unpacked.bundle_root);
            return Err(conflict_or_already_installed(existing, &source_identity));
        }
        let digest = unpacked.content_digest;
        let rec_source = Source::Archive {
            url: unpacked.source,
            archive_sha256: unpacked.archive_sha256,
            bundle_path: unpacked.bundle_root,
        };
        self.install(
            registry,
            unpacked.manifest,
            rec_source,
            source_identity,
            digest,
        )
    }

    /// Installs a release resolved from a catalog source, preferring any matching verified local bundle.
    ///
    /// Hard-rejects cross-source collisions via [`PluginError::SourceConflict`]. Starts disabled and
    /// unapproved.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on source conflict, offline mode without local verified cache,
    /// ABI/API incompatibility, digest mismatch, or artifact fetch/unpack failures.
    pub fn install_from_catalog(
        &self,
        resolved: &ResolvedCatalogRelease,
        policy: OfflinePolicy,
    ) -> Result<InstallOutcome, PluginError> {
        let _lock = self.lock()?;
        let registry = self.load_migrated_locked()?;
        if let Some(existing) = registry.plugins.get(&resolved.plugin.id) {
            return Err(conflict_or_already_installed(
                existing,
                &resolved.source_identity,
            ));
        }

        let (manifest, source, digest, resolved_from) =
            self.materialize_catalog_release(&registry, resolved, policy)?;
        let summary = self.install(
            registry,
            manifest,
            source,
            resolved.source_identity.clone(),
            digest,
        )?;
        Ok(InstallOutcome {
            summary,
            resolved_from,
        })
    }

    /// Stages a catalog plugin installation without mutating `registry.json` until [`Self::commit_install`].
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on already-installed conflict, offline block, digest mismatch, or
    /// compatibility errors.
    pub fn stage_install_from_catalog(
        &self,
        resolved: &ResolvedCatalogRelease,
        policy: OfflinePolicy,
    ) -> Result<StagedInstall, PluginError> {
        let registry = self.load_with_migration()?;
        if let Some(existing) = registry.plugins.get(&resolved.plugin.id) {
            return Err(conflict_or_already_installed(
                existing,
                &resolved.source_identity,
            ));
        }
        let (manifest, source, content_digest, resolved_from) =
            self.materialize_catalog_release(&registry, resolved, policy)?;
        build_staged_install(
            &registry,
            manifest,
            source,
            resolved.source_identity.clone(),
            content_digest,
            resolved_from,
        )
    }

    /// Stages a local directory installation without mutating `registry.json` until [`Self::commit_install`].
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on invalid manifest, compatibility failure, or existing plugin conflict.
    pub fn stage_install_path(&self, root: impl AsRef<Path>) -> Result<StagedInstall, PluginError> {
        let registry = self.load_with_migration()?;
        let root = at(root.as_ref(), fs::canonicalize(root.as_ref()))?;
        let manifest = Manifest::load(&root)?;
        manifest.check_runtime_compatibility(HOST_SHARED_RUNTIME_ABI)?;
        let digest = content_digest(&root)?;
        let source_identity = format!("path:{}", root.display());
        if let Some(existing) = registry.plugins.get(&manifest.id) {
            return Err(conflict_or_already_installed(existing, &source_identity));
        }
        let bundle_path = materialize_bundle(
            &self.paths.plugins_bundles_dir(),
            &manifest.id,
            &root,
            &digest,
        )?;
        build_staged_install(
            &registry,
            manifest,
            Source::Path { root, bundle_path },
            source_identity,
            digest,
            ResolvedFrom::LocalArtifact,
        )
    }

    /// Stages a Git source installation without mutating `registry.json` until [`Self::commit_install`].
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on offline policy, fetch/export failure, compatibility failure, or
    /// existing plugin conflict.
    pub fn stage_install_git(
        &self,
        url: &str,
        ref_name: &str,
        subdir: Option<&str>,
        policy: OfflinePolicy,
    ) -> Result<StagedInstall, PluginError> {
        let validated_subdir = subdir.map(git::validate_subdir).transpose()?;
        let registry = self.load_with_migration()?;
        let plugins_dir = self.paths.plugins_dir();
        at(
            &plugins_dir,
            DirBuilder::new()
                .mode(0o700)
                .recursive(true)
                .create(&plugins_dir),
        )?;
        let plugins_canon = at(&plugins_dir, fs::canonicalize(&plugins_dir))?;
        let bundles_dir = self.paths.plugins_bundles_dir();
        let staging_dir = self.paths.plugins_staging_dir();
        let prepared = git::prepare_bundle(
            git::GitWorkspace {
                plugins_dir: &plugins_canon,
                bundles_dir: &bundles_dir,
                staging_dir: &staging_dir,
            },
            url,
            ref_name,
            validated_subdir.as_deref(),
            policy,
            None,
        )
        .map_err(|err| match err {
            git::GitError::Offline => PluginError::OfflineModeBlocked,
            other => PluginError::Git(other),
        })?;
        let source_identity = format!(
            "git:{}|{}",
            prepared.url,
            prepared.subdir.as_deref().unwrap_or("")
        );
        if let Err(err) = prepared
            .manifest
            .check_runtime_compatibility(HOST_SHARED_RUNTIME_ABI)
        {
            cleanup_unreferenced_bundle(&bundles_dir, &registry, &prepared.root);
            return Err(err.into());
        }
        if let Some(existing) = registry.plugins.get(&prepared.manifest.id) {
            cleanup_unreferenced_bundle(&bundles_dir, &registry, &prepared.root);
            return Err(conflict_or_already_installed(existing, &source_identity));
        }
        let resolved_from = if prepared.url.starts_with("http://")
            || prepared.url.starts_with("https://")
            || prepared.url.starts_with("ssh://")
            || prepared.url.starts_with("git://")
        {
            ResolvedFrom::Remote
        } else {
            ResolvedFrom::LocalArtifact
        };
        let source = Source::Git {
            url: prepared.url,
            ref_name: ref_name.to_owned(),
            subdir: prepared.subdir,
            rev: prepared.rev,
            bundle_path: prepared.root,
        };
        build_staged_install(
            &registry,
            prepared.manifest,
            source,
            source_identity,
            prepared.content_digest,
            resolved_from,
        )
    }

    /// Stages a `.tar.gz`/`.tar.zst` archive installation without mutating `registry.json` until
    /// [`Self::commit_install`].
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on offline policy, archive verification error, compatibility failure,
    /// or existing plugin conflict.
    pub fn stage_install_archive(
        &self,
        source: &str,
        expected_sha256: &str,
        policy: OfflinePolicy,
    ) -> Result<StagedInstall, PluginError> {
        let registry = self.load_with_migration()?;
        let bundles_dir = self.paths.plugins_bundles_dir();
        let unpacked = archive::unpack_archive_bundle(
            &self.paths.plugins_staging_dir(),
            &bundles_dir,
            source,
            expected_sha256,
            policy,
        )
        .map_err(|err| match err {
            ArchiveError::Offline => PluginError::OfflineModeBlocked,
            other => PluginError::Archive(other),
        })?;
        let source_identity = format!("archive:{}", unpacked.source);
        if let Err(err) = unpacked
            .manifest
            .check_runtime_compatibility(HOST_SHARED_RUNTIME_ABI)
        {
            cleanup_unreferenced_bundle(&bundles_dir, &registry, &unpacked.bundle_root);
            return Err(err.into());
        }
        if let Some(existing) = registry.plugins.get(&unpacked.manifest.id) {
            cleanup_unreferenced_bundle(&bundles_dir, &registry, &unpacked.bundle_root);
            return Err(conflict_or_already_installed(existing, &source_identity));
        }
        let resolved_from =
            if unpacked.source.starts_with("http://") || unpacked.source.starts_with("https://") {
                ResolvedFrom::Remote
            } else {
                ResolvedFrom::LocalArtifact
            };
        let digest = unpacked.content_digest;
        let rec_source = Source::Archive {
            url: unpacked.source,
            archive_sha256: unpacked.archive_sha256,
            bundle_path: unpacked.bundle_root,
        };
        build_staged_install(
            &registry,
            unpacked.manifest,
            rec_source,
            source_identity,
            digest,
            resolved_from,
        )
    }

    /// Atomically commits a staged installation under exclusive `plugins.lock`, verifying reviewed
    /// source identity, content digest, and requested capabilities.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on TOCTOU/capability mismatch, concurrent conflict, bundle verification
    /// error, or persistence failure.
    pub fn commit_install(
        &self,
        staged: &StagedInstall,
        expected_source_identity: &str,
        expected_content_digest: &str,
        expected_capabilities: &CapabilityBundle,
        approve_on_commit: bool,
    ) -> Result<InstallOutcome, PluginError> {
        if staged.source_identity != expected_source_identity
            || staged.content_digest != expected_content_digest
            || &staged.requested_capabilities != expected_capabilities
        {
            return Err(PluginError::ToctouMismatch);
        }
        let _lock = self.lock()?;
        let mut registry = self.load_migrated_locked()?;
        if let Some(existing) = registry.plugins.get(&staged.id) {
            return Err(conflict_or_already_installed(
                existing,
                &staged.source_identity,
            ));
        }
        verify_bundle(staged.source.bundle_path(), &staged.content_digest)?;
        let approval = approve_on_commit.then(|| ApprovalRecord {
            content_digest: staged.content_digest.clone(),
            source_identity: staged.source_identity.clone(),
            capabilities: staged.requested_capabilities.clone(),
        });
        let record = Record {
            id: staged.id.clone(),
            name: staged.name.clone(),
            version: staged.version.clone(),
            plugin_api: staged.plugin_api,
            shared_runtime_abi: staged.shared_runtime_abi,
            source: staged.source.clone(),
            source_identity: staged.source_identity.clone(),
            content_digest: staged.content_digest.clone(),
            enabled: false,
            revoked: false,
            migration_reapproval_required: false,
            requested_capabilities: staged.requested_capabilities.clone(),
            approval,
        };
        let summary = record.summary();
        registry.plugins.insert(staged.id.clone(), record);
        registry.desired_revision = registry.desired_revision.saturating_add(1);
        self.save(&registry)?;
        Ok(InstallOutcome {
            summary,
            resolved_from: staged.resolved_from,
        })
    }

    /// Stages a catalog upgrade without mutating `registry.json` or live approvals.
    ///
    /// Rejects cross-source switches with [`PluginError::SourceConflict`] and computes capability
    /// diffs and net new host authority before returning [`StagedUpgrade`].
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] if the plugin is missing, source conflicts, ABI/API check fails,
    /// offline mode blocks fetching without cache, or artifact verification fails.
    pub fn stage_upgrade(
        &self,
        id: &PluginId,
        resolved: &ResolvedCatalogRelease,
        policy: OfflinePolicy,
    ) -> Result<StagedUpgrade, PluginError> {
        if &resolved.plugin.id != id {
            return Err(PluginError::IdChanged {
                expected: id.clone(),
                actual: resolved.plugin.id.clone(),
            });
        }
        let registry = self.load_with_migration()?;
        let existing = registry
            .plugins
            .get(id)
            .ok_or_else(|| PluginError::NotFound(id.clone()))?;
        if existing.source_identity != resolved.source_identity {
            return Err(PluginError::SourceConflict {
                id: id.clone(),
                existing_source: existing.source_identity.clone(),
                incoming_source: resolved.source_identity.clone(),
            });
        }

        let (manifest, new_source, to_digest, resolved_from) =
            self.materialize_catalog_release(&registry, resolved, policy)?;
        let shared_runtime_abi = manifest
            .build
            .as_ref()
            .map_or(HOST_SHARED_RUNTIME_ABI, |b| b.shared_runtime_abi);
        let diff = manifest
            .capabilities
            .diff(existing.approval.as_ref().map(|a| &a.capabilities));
        let requires_reapproval = existing.migration_reapproval_required
            || existing.revoked
            || existing.approval.is_none()
            || diff.requires_approval();
        let baseline = merged_enabled_host_baseline(&registry, Some(id))?;
        let net_added_host_capabilities =
            net_added_host_capabilities(&baseline, &manifest.capabilities.host);

        let was_revoked = existing.revoked;

        Ok(StagedUpgrade {
            id: id.clone(),
            name: manifest.name,
            from_version: existing.version.clone(),
            to_version: manifest.version,
            plugin_api: manifest.plugin_api,
            shared_runtime_abi,
            from_digest: existing.content_digest.clone(),
            to_digest,
            source_identity: resolved.source_identity.clone(),
            diff,
            net_added_host_capabilities,
            requires_reapproval,
            resolved_from,
            new_source,
            requested_capabilities: manifest.capabilities,
            was_revoked,
        })
    }

    /// Commits a previously staged upgrade atomically under exclusive registry lock.
    ///
    /// Enforces TOCTOU verification (`expected_from_digest` & `expected_to_digest`), rejects
    /// concurrent revocation between staging and commit, rejects unapproved capability expansion
    /// under [`UpgradeApprovalMode::KeepExistingOnly`], and cleans up replaced immutable bundles
    /// that are no longer referenced.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on TOCTOU mismatch, missing plugin, source conflict, revocation,
    /// unapproved capability expansion, corrupted staged bundle, or persistence failure.
    pub fn commit_upgrade(
        &self,
        staged: &StagedUpgrade,
        expected_from_digest: &str,
        expected_to_digest: &str,
        approval_mode: UpgradeApprovalMode,
    ) -> Result<PluginSummary, PluginError> {
        let allow_unrevoke =
            staged.was_revoked && matches!(approval_mode, UpgradeApprovalMode::ApproveExpanded);
        self.commit_upgrade_reviewed(
            staged,
            expected_from_digest,
            expected_to_digest,
            &staged.requested_capabilities,
            approval_mode,
            allow_unrevoke,
        )
    }

    /// Commits a staged upgrade under exclusive lock while additionally verifying the reviewed
    /// capability bundle and explicit `allow_unrevoke` flag.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on TOCTOU/capability mismatch, revocation when `allow_unrevoke` is
    /// false, source conflict, missing plugin, or persistence failure.
    pub fn commit_upgrade_reviewed(
        &self,
        staged: &StagedUpgrade,
        expected_from_digest: &str,
        expected_to_digest: &str,
        expected_capabilities: &CapabilityBundle,
        approval_mode: UpgradeApprovalMode,
        allow_unrevoke: bool,
    ) -> Result<PluginSummary, PluginError> {
        if &staged.requested_capabilities != expected_capabilities {
            return Err(PluginError::ToctouMismatch);
        }
        let _lock = self.lock()?;
        let mut registry = self.load_migrated_locked()?;
        let bundles_dir = self.paths.plugins_bundles_dir();
        let old_bundle: PathBuf;
        let summary;
        {
            let record = registry
                .plugins
                .get_mut(&staged.id)
                .ok_or_else(|| PluginError::NotFound(staged.id.clone()))?;
            if record.content_digest != expected_from_digest
                || record.content_digest != staged.from_digest
                || staged.to_digest != expected_to_digest
            {
                return Err(PluginError::ToctouMismatch);
            }
            if record.revoked && (!staged.was_revoked || !allow_unrevoke) {
                return Err(PluginError::Revoked(staged.id.clone()));
            }
            if record.source_identity != staged.source_identity {
                return Err(PluginError::SourceConflict {
                    id: staged.id.clone(),
                    existing_source: record.source_identity.clone(),
                    incoming_source: staged.source_identity.clone(),
                });
            }
            verify_bundle(staged.new_source.bundle_path(), &staged.to_digest)?;

            let diff = staged
                .requested_capabilities
                .diff(record.approval.as_ref().map(|a| &a.capabilities));
            let was_enabled = record.enabled;
            match approval_mode {
                UpgradeApprovalMode::KeepExistingOnly => {
                    if diff.requires_approval() {
                        return Err(PluginError::CapabilityExpansionRequiresApproval(
                            staged.id.clone(),
                        ));
                    }
                    if !record.has_covering_approval() {
                        record.enabled = false;
                    } else if let Some(approval) = record.approval.as_mut() {
                        approval.content_digest = staged.to_digest.clone();
                    }
                }
                UpgradeApprovalMode::ApproveExpanded => {
                    record.approval = Some(ApprovalRecord {
                        content_digest: staged.to_digest.clone(),
                        source_identity: staged.source_identity.clone(),
                        capabilities: staged.requested_capabilities.clone(),
                    });
                    record.revoked = false;
                    record.migration_reapproval_required = false;
                }
            }

            old_bundle = record.source.bundle_path().to_path_buf();
            record.name = staged.name.clone();
            record.version = staged.to_version.clone();
            record.plugin_api = staged.plugin_api;
            record.shared_runtime_abi = staged.shared_runtime_abi;
            record.source = staged.new_source.clone();
            record.content_digest = staged.to_digest.clone();
            record.requested_capabilities = staged.requested_capabilities.clone();
            if matches!(approval_mode, UpgradeApprovalMode::ApproveExpanded) {
                record.enabled = was_enabled && record.is_approved();
            }
            summary = record.summary();
        }

        registry.desired_revision = registry.desired_revision.saturating_add(1);
        self.save(&registry)?;
        if old_bundle != staged.new_source.bundle_path() && old_bundle.starts_with(&bundles_dir) {
            cleanup_unreferenced_bundle(&bundles_dir, &registry, &old_bundle);
        }
        Ok(summary)
    }

    /// Returns the summary and requested capabilities of one installed plugin.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError::NotFound`] if `id` is not installed.
    pub fn plugin_capabilities(
        &self,
        id: &PluginId,
    ) -> Result<(PluginSummary, CapabilityBundle), PluginError> {
        let registry = self.load_with_migration()?;
        let record = registry
            .plugins
            .get(id)
            .ok_or_else(|| PluginError::NotFound(id.clone()))?;
        Ok((record.summary(), record.requested_capabilities.clone()))
    }

    /// Audits an installed plugin's capabilities, net host expansion, and pinned bundle integrity.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] if the plugin is missing or its bundle/source cannot be hashed.
    pub fn audit(&self, id: &PluginId) -> Result<AuditReport, PluginError> {
        let registry = self.load_with_migration()?;
        let record = registry
            .plugins
            .get(id)
            .ok_or_else(|| PluginError::NotFound(id.clone()))?;
        let current_content_digest = record.current_digest_for_audit()?;
        let digest_matches =
            current_content_digest == record.content_digest && record.verify_digest().is_ok();
        let baseline = merged_enabled_host_baseline(&registry, Some(id))?;
        let net_added = net_added_host_capabilities(&baseline, &record.requested_capabilities.host);
        Ok(AuditReport {
            plugin: record.summary(),
            diff: record
                .requested_capabilities
                .diff(record.approval.as_ref().map(|a| &a.capabilities)),
            net_added_host_capabilities: net_added,
            current_content_digest,
            digest_matches,
        })
    }

    /// Grants explicit capability approval bound to the current content digest and `source_identity`.
    ///
    /// Clears any prior revocation or migration re-approval requirement without enabling the plugin.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on missing plugin, digest drift, corrupted bundle, or save failure.
    pub fn approve(&self, id: &PluginId) -> Result<PluginSummary, PluginError> {
        self.change(id, |record| {
            record.verify_digest()?;
            record.approval = Some(ApprovalRecord {
                content_digest: record.content_digest.clone(),
                source_identity: record.source_identity.clone(),
                capabilities: record.requested_capabilities.clone(),
            });
            record.revoked = false;
            record.migration_reapproval_required = false;
            Ok(())
        })
    }

    /// Grants reviewed capability approval under exclusive `plugins.lock` only when the plugin's
    /// live `source_identity`, `content_digest`, requested capabilities, and revocation policy match.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError::Revoked`] if revoked and `allow_unrevoke` is false,
    /// [`PluginError::ToctouMismatch`] if source/digest/capabilities changed since preview, or
    /// [`PluginError`] on missing plugin, digest drift, or save failure.
    pub fn approve_reviewed(
        &self,
        id: &PluginId,
        expected_source_identity: &str,
        expected_content_digest: &str,
        expected_capabilities: &CapabilityBundle,
        allow_unrevoke: bool,
    ) -> Result<PluginSummary, PluginError> {
        self.change(id, |record| {
            if record.revoked && !allow_unrevoke {
                return Err(PluginError::Revoked(id.clone()));
            }
            if (record.source_identity != expected_source_identity
                && redact_source_identity(&record.source_identity) != expected_source_identity)
                || record.content_digest != expected_content_digest
                || &record.requested_capabilities != expected_capabilities
            {
                return Err(PluginError::ToctouMismatch);
            }
            record.verify_digest()?;
            record.approval = Some(ApprovalRecord {
                content_digest: record.content_digest.clone(),
                source_identity: record.source_identity.clone(),
                capabilities: record.requested_capabilities.clone(),
            });
            record.revoked = false;
            record.migration_reapproval_required = false;
            Ok(())
        })
    }

    /// Revokes explicit approval and disables composition.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] if the plugin is missing or saving fails.
    pub fn revoke(&self, id: &PluginId) -> Result<PluginSummary, PluginError> {
        self.change(id, |record| {
            record.approval = None;
            record.revoked = true;
            record.enabled = false;
            Ok(())
        })
    }

    /// Enables composition only when explicitly approved and bundle/source digests match the pin.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on missing approval, revocation, pending migration re-approval,
    /// digest drift, or missing plugin.
    pub fn enable(&self, id: &PluginId) -> Result<PluginSummary, PluginError> {
        self.change(id, |record| {
            if !record.is_approved() {
                return Err(PluginError::ApprovalRequired(id.clone()));
            }
            record.verify_digest()?;
            record.enabled = true;
            Ok(())
        })
    }

    /// Disables composition while preserving existing explicit approval.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] if the plugin is missing or saving fails.
    pub fn disable(&self, id: &PluginId) -> Result<PluginSummary, PluginError> {
        self.change(id, |record| {
            record.enabled = false;
            Ok(())
        })
    }

    /// Re-reads and re-materializes the bundle from the plugin's bound source (`path` or `git`).
    ///
    /// Automatically disables composition if existing approval no longer covers the synced manifest.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] on offline policy, changed ID, invalid manifest, ABI incompatibility,
    /// or missing plugin.
    pub fn sync(&self, id: &PluginId, policy: OfflinePolicy) -> Result<PluginSummary, PluginError> {
        let bundles_dir = self.paths.plugins_bundles_dir();
        let staging_dir = self.paths.plugins_staging_dir();
        let plugins_dir = self.paths.plugins_dir();
        let _lock = self.lock()?;
        let mut registry = self.load_migrated_locked()?;
        let summary;
        {
            let record = registry
                .plugins
                .get_mut(id)
                .ok_or_else(|| PluginError::NotFound(id.clone()))?;

            let (manifest, new_source, digest) = match &record.source {
                Source::Path { root, .. } => {
                    let root = at(root, fs::canonicalize(root))?;
                    let manifest = Manifest::load(&root)?;
                    if manifest.id != *id {
                        return Err(PluginError::IdChanged {
                            expected: id.clone(),
                            actual: manifest.id,
                        });
                    }
                    manifest.check_runtime_compatibility(HOST_SHARED_RUNTIME_ABI)?;
                    let digest = content_digest(&root)?;
                    let bundle_path =
                        materialize_bundle(&bundles_dir, &manifest.id, &root, &digest)?;
                    (manifest, Source::Path { root, bundle_path }, digest)
                }
                Source::Git {
                    url,
                    ref_name,
                    subdir,
                    ..
                } => {
                    let plugins_canon = at(&plugins_dir, fs::canonicalize(&plugins_dir))?;
                    let prepared = git::prepare_bundle(
                        git::GitWorkspace {
                            plugins_dir: &plugins_canon,
                            bundles_dir: &bundles_dir,
                            staging_dir: &staging_dir,
                        },
                        url,
                        ref_name,
                        subdir.as_deref(),
                        policy,
                        Some(id),
                    )?;
                    prepared
                        .manifest
                        .check_runtime_compatibility(HOST_SHARED_RUNTIME_ABI)?;
                    let source = Source::Git {
                        url: prepared.url,
                        ref_name: ref_name.clone(),
                        subdir: prepared.subdir,
                        rev: prepared.rev,
                        bundle_path: prepared.root,
                    };
                    (prepared.manifest, source, prepared.content_digest)
                }
                Source::Archive {
                    url,
                    archive_sha256,
                    ..
                } => {
                    let unpacked = archive::unpack_archive_bundle(
                        &staging_dir,
                        &bundles_dir,
                        url,
                        archive_sha256,
                        policy,
                    )?;
                    if unpacked.manifest.id != *id {
                        return Err(PluginError::IdChanged {
                            expected: id.clone(),
                            actual: unpacked.manifest.id,
                        });
                    }
                    unpacked
                        .manifest
                        .check_runtime_compatibility(HOST_SHARED_RUNTIME_ABI)?;
                    let digest = unpacked.content_digest;
                    let source = Source::Archive {
                        url: unpacked.source,
                        archive_sha256: unpacked.archive_sha256,
                        bundle_path: unpacked.bundle_root,
                    };
                    (unpacked.manifest, source, digest)
                }
                Source::Catalog {
                    catalog_source_id,
                    catalog_source_identity,
                    version,
                    transport,
                    bundle_path,
                } => {
                    verify_bundle(bundle_path, &record.content_digest)?;
                    let manifest = Manifest::load(bundle_path)?;
                    if manifest.id != *id {
                        return Err(PluginError::IdChanged {
                            expected: id.clone(),
                            actual: manifest.id,
                        });
                    }
                    let source = Source::Catalog {
                        catalog_source_id: catalog_source_id.clone(),
                        catalog_source_identity: catalog_source_identity.clone(),
                        version: version.clone(),
                        transport: transport.clone(),
                        bundle_path: bundle_path.clone(),
                    };
                    (manifest, source, record.content_digest.clone())
                }
            };

            record.shared_runtime_abi = manifest
                .build
                .as_ref()
                .map_or(HOST_SHARED_RUNTIME_ABI, |b| b.shared_runtime_abi);
            record.content_digest = digest.clone();
            record.name = manifest.name;
            record.version = manifest.version;
            record.plugin_api = manifest.plugin_api;
            record.requested_capabilities = manifest.capabilities;
            record.source = new_source;
            // Keep approval valid across sync only if non-revoked, same source, and covering
            // requested capabilities (allowing reductions without re-approval).
            if record.has_covering_approval() {
                if let Some(approval) = record.approval.as_mut() {
                    approval.content_digest = digest;
                }
            } else {
                record.enabled = false;
            }
            summary = record.summary();
        }

        registry.desired_revision = registry.desired_revision.saturating_add(1);
        self.save(&registry)?;
        Ok(summary)
    }

    /// Removes a plugin from the registry and deletes its immutable bundle tree.
    ///
    /// Never modifies or deletes user `--path` source directories. Optionally purges
    /// `[plugin_settings."<id>"]` when `settings_policy` is [`RemoveSettingsPolicy::PurgeSettings`].
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] if the plugin is not installed, saving fails, or settings removal fails.
    pub fn remove(
        &self,
        id: &PluginId,
        settings_policy: RemoveSettingsPolicy,
    ) -> Result<RemovedPlugin, PluginError> {
        let bundles_dir = self.paths.plugins_bundles_dir();
        let bundle_to_delete: PathBuf;
        let desired_revision: u64;
        {
            let _lock = self.lock()?;
            let mut registry = self.load_migrated_locked()?;
            let record = registry
                .plugins
                .remove(id)
                .ok_or_else(|| PluginError::NotFound(id.clone()))?;
            bundle_to_delete = record.source.bundle_path().to_path_buf();
            registry.desired_revision = registry.desired_revision.saturating_add(1);
            desired_revision = registry.desired_revision;
            self.save(&registry)?;
            if bundle_to_delete.starts_with(&bundles_dir)
                && !registry
                    .plugins
                    .values()
                    .any(|r| r.source.bundle_path() == bundle_to_delete)
            {
                let _ = remove_bundle_tree(&bundle_to_delete);
            }
        }

        let settings_purged = match settings_policy {
            RemoveSettingsPolicy::KeepSettings => false,
            RemoveSettingsPolicy::PurgeSettings => {
                ConfigStore::new(self.paths.clone()).remove_plugin_settings(id)?
            }
        };
        Ok(RemovedPlugin {
            id: id.clone(),
            desired_revision,
            settings_purged,
        })
    }

    /// Inspects registry consistency, bundle digests, v1 migration flags, orphan bundles, and staging dirs.
    ///
    /// # Errors
    ///
    /// Returns [`PluginError`] if the registry cannot be loaded or migrated.
    pub fn doctor(&self) -> Result<Vec<DoctorFinding>, PluginError> {
        let registry = self.load_with_migration()?;
        let mut findings = Vec::new();
        let mut active_bundles = BTreeSet::new();

        for record in registry.plugins.values() {
            active_bundles.insert(record.source.bundle_path().to_path_buf());
            if record.migration_reapproval_required {
                findings.push(DoctorFinding {
                    code: "migration_reapproval_required".to_owned(),
                    severity: DoctorSeverity::Warning,
                    plugin_id: Some(record.id.clone()),
                    message: format!(
                        "plugin {} was migrated from registry v1 with approvals cleared; run `z-shell plugin audit {}` and `z-shell plugin approve {}`",
                        record.id, record.id, record.id
                    ),
                });
            }
            if let Err(err) = verify_bundle(record.source.bundle_path(), &record.content_digest) {
                findings.push(DoctorFinding {
                    code: "bundle_invalid".to_owned(),
                    severity: DoctorSeverity::Error,
                    plugin_id: Some(record.id.clone()),
                    message: format!("immutable bundle verification failed: {err}"),
                });
            } else {
                match Manifest::load(record.source.bundle_path()) {
                    Ok(manifest) => {
                        if let Err(err) =
                            manifest.check_runtime_compatibility(HOST_SHARED_RUNTIME_ABI)
                        {
                            findings.push(DoctorFinding {
                                code: "incompatible_runtime".to_owned(),
                                severity: DoctorSeverity::Error,
                                plugin_id: Some(record.id.clone()),
                                message: err.to_string(),
                            });
                        }
                    }
                    Err(err) => findings.push(DoctorFinding {
                        code: "manifest_invalid".to_owned(),
                        severity: DoctorSeverity::Error,
                        plugin_id: Some(record.id.clone()),
                        message: err.to_string(),
                    }),
                }
            }

            if let Source::Path { root, .. } = &record.source {
                match content_digest(root) {
                    Ok(digest) if digest != record.content_digest => findings.push(DoctorFinding {
                        code: "path_source_drifted".to_owned(),
                        severity: DoctorSeverity::Warning,
                        plugin_id: Some(record.id.clone()),
                        message: format!(
                            "local path source {} changed since pinned digest; run `z-shell plugin sync {}`",
                            root.display(),
                            record.id
                        ),
                    }),
                    Ok(_) => {}
                    Err(err) => findings.push(DoctorFinding {
                        code: "path_source_unreadable".to_owned(),
                        severity: DoctorSeverity::Error,
                        plugin_id: Some(record.id.clone()),
                        message: format!("local path source {} is unreadable: {err}", root.display()),
                    }),
                }
            }

            if record.enabled && !record.is_approved() {
                findings.push(DoctorFinding {
                    code: "enabled_without_approval".to_owned(),
                    severity: DoctorSeverity::Error,
                    plugin_id: Some(record.id.clone()),
                    message: "plugin is marked enabled without a valid approval".to_owned(),
                });
            }
        }

        let bundles_dir = self.paths.plugins_bundles_dir();
        if bundles_dir.is_dir()
            && let Ok(plugin_dirs) = fs::read_dir(&bundles_dir)
        {
            for plugin_entry in plugin_dirs.flatten() {
                let plugin_path = plugin_entry.path();
                if !plugin_path.is_dir() {
                    continue;
                }
                if let Ok(digest_dirs) = fs::read_dir(&plugin_path) {
                    for digest_entry in digest_dirs.flatten() {
                        let candidate = digest_entry.path();
                        if !active_bundles.contains(&candidate) {
                            findings.push(DoctorFinding {
                                code: "orphan_bundle".to_owned(),
                                severity: DoctorSeverity::Info,
                                plugin_id: None,
                                message: format!(
                                    "unreferenced bundle directory at {}",
                                    candidate.display()
                                ),
                            });
                        }
                    }
                }
            }
        }

        let staging_dir = self.paths.plugins_staging_dir();
        if staging_dir.is_dir()
            && let Ok(entries) = fs::read_dir(&staging_dir)
        {
            for entry in entries.flatten() {
                findings.push(DoctorFinding {
                    code: "stale_staging_dir".to_owned(),
                    severity: DoctorSeverity::Info,
                    plugin_id: None,
                    message: format!("leftover staging entry at {}", entry.path().display()),
                });
            }
        }

        Ok(findings)
    }

    fn materialize_catalog_release(
        &self,
        registry: &Registry,
        resolved: &ResolvedCatalogRelease,
        policy: OfflinePolicy,
    ) -> Result<(Manifest, Source, String, ResolvedFrom), PluginError> {
        if resolved.release.plugin_api > SUPPORTED_PLUGIN_API_LEVEL {
            return Err(CompatibilityError::UnsupportedPluginApi {
                plugin_api: resolved.release.plugin_api,
                max_supported: SUPPORTED_PLUGIN_API_LEVEL,
            }
            .into());
        }
        if !resolved
            .release
            .shared_runtime_abi
            .is_compatible_with_host(HOST_SHARED_RUNTIME_ABI)
        {
            return Err(CompatibilityError::IncompatibleRuntimeAbi {
                required: resolved.release.shared_runtime_abi,
                host: HOST_SHARED_RUNTIME_ABI,
            }
            .into());
        }

        let bundles_dir = self.paths.plugins_bundles_dir();
        let staging_dir = self.paths.plugins_staging_dir();
        let plugins_dir = self.paths.plugins_dir();
        let transport = catalog_transport_from_artifact(&resolved.release.artifact);

        let cached_bundle = bundle_dir_for(
            &bundles_dir,
            &resolved.plugin.id,
            &resolved.release.content_digest,
        );
        if verify_bundle(&cached_bundle, &resolved.release.content_digest).is_ok()
            && let Ok(manifest) = Manifest::load(&cached_bundle)
            && manifest.id == resolved.plugin.id
            && manifest
                .check_runtime_compatibility(HOST_SHARED_RUNTIME_ABI)
                .is_ok()
        {
            let source = Source::Catalog {
                catalog_source_id: resolved.source_id.clone(),
                catalog_source_identity: resolved.source_identity.clone(),
                version: resolved.release.version.clone(),
                transport,
                bundle_path: cached_bundle,
            };
            return Ok((
                manifest,
                source,
                resolved.release.content_digest.clone(),
                ResolvedFrom::LocalVerifiedCache,
            ));
        }

        let (bundle_path, manifest, actual_digest, resolved_from) = match &resolved.release.artifact
        {
            CatalogArtifact::LocalSeed { bundle_dir } => {
                let manifest = Manifest::load(bundle_dir)?;
                let digest = content_digest(bundle_dir)?;
                let committed = materialize_bundle(
                    &bundles_dir,
                    &resolved.plugin.id,
                    bundle_dir,
                    &resolved.release.content_digest,
                )?;
                (
                    committed,
                    manifest,
                    digest,
                    ResolvedFrom::BundledOfficialSeed,
                )
            }
            CatalogArtifact::Archive {
                url,
                archive_sha256,
                ..
            } => {
                let unpacked = archive::unpack_archive_bundle(
                    &staging_dir,
                    &bundles_dir,
                    url,
                    archive_sha256,
                    policy,
                )
                .map_err(|err| match err {
                    ArchiveError::Offline => PluginError::OfflineModeBlocked,
                    other => PluginError::Archive(other),
                })?;
                let origin = if url.starts_with("http://") || url.starts_with("https://") {
                    ResolvedFrom::Remote
                } else {
                    ResolvedFrom::LocalArtifact
                };
                (
                    unpacked.bundle_root,
                    unpacked.manifest,
                    unpacked.content_digest,
                    origin,
                )
            }
            CatalogArtifact::Git { url, rev, subdir } => {
                at(
                    &plugins_dir,
                    DirBuilder::new()
                        .mode(0o700)
                        .recursive(true)
                        .create(&plugins_dir),
                )?;
                let plugins_canon = at(&plugins_dir, fs::canonicalize(&plugins_dir))?;
                let prepared = git::prepare_bundle(
                    git::GitWorkspace {
                        plugins_dir: &plugins_canon,
                        bundles_dir: &bundles_dir,
                        staging_dir: &staging_dir,
                    },
                    url,
                    rev,
                    subdir.as_deref(),
                    policy,
                    Some(&resolved.plugin.id),
                )
                .map_err(|err| match err {
                    git::GitError::Offline => PluginError::OfflineModeBlocked,
                    other => PluginError::Git(other),
                })?;
                (
                    prepared.root,
                    prepared.manifest,
                    prepared.content_digest,
                    ResolvedFrom::Remote,
                )
            }
        };

        if manifest.id != resolved.plugin.id {
            cleanup_unreferenced_bundle(&bundles_dir, registry, &bundle_path);
            return Err(PluginError::IdChanged {
                expected: resolved.plugin.id.clone(),
                actual: manifest.id,
            });
        }
        if actual_digest != resolved.release.content_digest {
            cleanup_unreferenced_bundle(&bundles_dir, registry, &bundle_path);
            return Err(PluginError::CatalogDigestMismatch {
                expected: resolved.release.content_digest.clone(),
                actual: actual_digest,
            });
        }
        if let Err(err) = manifest.check_runtime_compatibility(HOST_SHARED_RUNTIME_ABI) {
            cleanup_unreferenced_bundle(&bundles_dir, registry, &bundle_path);
            return Err(err.into());
        }

        let source = Source::Catalog {
            catalog_source_id: resolved.source_id.clone(),
            catalog_source_identity: resolved.source_identity.clone(),
            version: resolved.release.version.clone(),
            transport,
            bundle_path,
        };
        Ok((manifest, source, actual_digest, resolved_from))
    }

    fn install(
        &self,
        mut registry: Registry,
        manifest: Manifest,
        source: Source,
        source_identity: String,
        content_digest: String,
    ) -> Result<PluginSummary, PluginError> {
        let id = manifest.id;
        let Entry::Vacant(entry) = registry.plugins.entry(id.clone()) else {
            return Err(PluginError::AlreadyInstalled(id));
        };
        let shared_runtime_abi = manifest
            .build
            .as_ref()
            .map_or(HOST_SHARED_RUNTIME_ABI, |b| b.shared_runtime_abi);
        let summary = entry
            .insert(Record {
                id,
                name: manifest.name,
                version: manifest.version,
                plugin_api: manifest.plugin_api,
                shared_runtime_abi,
                source,
                source_identity,
                content_digest,
                enabled: false,
                revoked: false,
                migration_reapproval_required: false,
                requested_capabilities: manifest.capabilities,
                approval: None,
            })
            .summary();
        registry.desired_revision = registry.desired_revision.saturating_add(1);
        self.save(&registry)?;
        Ok(summary)
    }

    fn change(
        &self,
        id: &PluginId,
        change: impl FnOnce(&mut Record) -> Result<(), PluginError>,
    ) -> Result<PluginSummary, PluginError> {
        let _lock = self.lock()?;
        let mut registry = self.load_migrated_locked()?;
        let record = registry
            .plugins
            .get_mut(id)
            .ok_or_else(|| PluginError::NotFound(id.clone()))?;
        change(record)?;
        let summary = record.summary();
        registry.desired_revision = registry.desired_revision.saturating_add(1);
        self.save(&registry)?;
        Ok(summary)
    }

    fn load_with_migration(&self) -> Result<Registry, PluginError> {
        let path = self.paths.plugins_registry_file();
        let raw_bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Registry::default()),
            Err(source) => return Err(PluginError::Io { path, source }),
        };
        let peek: VersionPeek = serde_json::from_slice(&raw_bytes)?;
        match peek.schema_version {
            SCHEMA_VERSION_V2 => parse_and_validate_v2(&raw_bytes),
            SCHEMA_VERSION_V1 => {
                let _lock = self.lock()?;
                self.load_migrated_locked()
            }
            other => Err(PluginError::RegistryVersion(other)),
        }
    }

    fn load_migrated_locked(&self) -> Result<Registry, PluginError> {
        let path = self.paths.plugins_registry_file();
        let raw_bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Registry::default()),
            Err(source) => return Err(PluginError::Io { path, source }),
        };
        let peek: VersionPeek = serde_json::from_slice(&raw_bytes)?;
        match peek.schema_version {
            SCHEMA_VERSION_V2 => parse_and_validate_v2(&raw_bytes),
            SCHEMA_VERSION_V1 => self.migrate_v1_to_v2(&raw_bytes),
            other => Err(PluginError::RegistryVersion(other)),
        }
    }

    fn migrate_v1_to_v2(&self, v1_bytes: &[u8]) -> Result<Registry, PluginError> {
        let v1: RegistryV1 = serde_json::from_slice(v1_bytes)?;
        let plugins_dir = self.paths.plugins_dir();
        let bundles_dir = self.paths.plugins_bundles_dir();
        let backup_path = plugins_dir.join("registry.v1.bak.json");
        write_atomic_0600(&plugins_dir, &backup_path, v1_bytes)?;

        let mut migrated = BTreeMap::new();
        for (id, rec) in v1.plugins {
            if id != rec.id {
                return Err(PluginError::RegistryId(id));
            }
            let (source, source_identity, shared_runtime_abi) = match rec.source {
                SourceV1::Path { root } => {
                    let canonical = fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
                    let abi = Manifest::load(&canonical)
                        .ok()
                        .and_then(|m| m.build.map(|b| b.shared_runtime_abi))
                        .unwrap_or(HOST_SHARED_RUNTIME_ABI);
                    let bundle_path =
                        materialize_bundle(&bundles_dir, &id, &canonical, &rec.content_digest)
                            .unwrap_or_else(|_| {
                                bundle_dir_for(&bundles_dir, &id, &rec.content_digest)
                            });
                    let identity = format!("path:{}", canonical.display());
                    (Source::Path { root, bundle_path }, identity, abi)
                }
                SourceV1::Git {
                    url,
                    rev,
                    ref_name,
                    root,
                } => {
                    let abi = Manifest::load(&root)
                        .ok()
                        .and_then(|m| m.build.map(|b| b.shared_runtime_abi))
                        .unwrap_or(HOST_SHARED_RUNTIME_ABI);
                    let bundle_path =
                        materialize_bundle(&bundles_dir, &id, &root, &rec.content_digest)
                            .unwrap_or_else(|_| {
                                bundle_dir_for(&bundles_dir, &id, &rec.content_digest)
                            });
                    let identity = format!("git:{url}|");
                    (
                        Source::Git {
                            url,
                            ref_name,
                            subdir: None,
                            rev,
                            bundle_path,
                        },
                        identity,
                        abi,
                    )
                }
            };

            migrated.insert(
                id,
                Record {
                    id: rec.id,
                    name: rec.name,
                    version: rec.version,
                    plugin_api: rec.plugin_api,
                    shared_runtime_abi,
                    source,
                    source_identity,
                    content_digest: rec.content_digest,
                    // Non-escalating migration: never preserve enabled or v1 approvals implicitly.
                    enabled: false,
                    revoked: rec.revoked,
                    migration_reapproval_required: true,
                    requested_capabilities: rec.requested_capabilities,
                    approval: None,
                },
            );
        }

        let v2 = Registry {
            schema_version: SCHEMA_VERSION_V2,
            desired_revision: 1,
            plugins: migrated,
        };
        self.save(&v2)?;
        Ok(v2)
    }

    fn lock(&self) -> Result<File, PluginError> {
        let dir = self.paths.plugins_dir();
        at(
            &dir,
            DirBuilder::new().mode(0o700).recursive(true).create(&dir),
        )?;
        let path = self.paths.plugins_lock_file();
        let file = at(
            &path,
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .open(&path),
        )?;
        at(
            &path,
            flock(&file, FlockOperation::LockExclusive).map_err(io::Error::from),
        )?;
        Ok(file)
    }

    fn save(&self, registry: &Registry) -> Result<(), PluginError> {
        let dir = self.paths.plugins_dir();
        let dir_handle = at(&dir, File::open(&dir))?;
        let temp = at(&dir, NamedTempFile::new_in(&dir))?;
        let path = temp.path();
        at(
            path,
            fs::set_permissions(path, Permissions::from_mode(0o600)),
        )?;
        let mut writer = BufWriter::new(temp.as_file());
        serde_json::to_writer_pretty(&mut writer, registry)?;
        at(path, writer.write_all(b"\n"))?;
        at(path, writer.flush())?;
        drop(writer);
        at(path, temp.as_file().sync_all())?;
        let target = self.paths.plugins_registry_file();
        at(&target, temp.persist(&target).map_err(|err| err.error))?;
        at(&dir, dir_handle.sync_all())
    }
}

impl StagedUpgrade {
    /// Returns the requested capability bundle declared by the staged upgrade manifest.
    #[must_use]
    pub const fn requested_capabilities(&self) -> &CapabilityBundle {
        &self.requested_capabilities
    }
}

fn build_staged_install(
    registry: &Registry,
    manifest: Manifest,
    source: Source,
    source_identity: String,
    content_digest: String,
    resolved_from: ResolvedFrom,
) -> Result<StagedInstall, PluginError> {
    let shared_runtime_abi = manifest
        .build
        .as_ref()
        .map_or(HOST_SHARED_RUNTIME_ABI, |b| b.shared_runtime_abi);
    let baseline = merged_enabled_host_baseline(registry, None)?;
    let net_added_host_capabilities =
        net_added_host_capabilities(&baseline, &manifest.capabilities.host);
    Ok(StagedInstall {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        plugin_api: manifest.plugin_api,
        shared_runtime_abi,
        content_digest,
        source_identity,
        requested_capabilities: manifest.capabilities,
        net_added_host_capabilities,
        resolved_from,
        source,
    })
}

fn redact_source_identity(source_identity: &str) -> String {
    if let Some(rest) = source_identity.strip_prefix("path:") {
        let hash = format!("{:x}", Sha256::digest(rest.as_bytes()));
        return format!("path:sha256:{hash}");
    }
    if let Some(rest) = source_identity.strip_prefix("archive:")
        && rest.starts_with('/')
    {
        let hash = format!("{:x}", Sha256::digest(rest.as_bytes()));
        return format!("archive:sha256:{hash}");
    }
    if let Some(rest) = source_identity.strip_prefix("git:")
        && rest.starts_with('/')
    {
        let hash = format!("{:x}", Sha256::digest(rest.as_bytes()));
        return format!("git:sha256:{hash}");
    }
    if let Some(rest) = source_identity.strip_prefix("catalog:")
        && let Some((src_id, tail)) = rest.split_once('|')
        && tail.starts_with('/')
    {
        let hash = format!("{:x}", Sha256::digest(tail.as_bytes()));
        return format!("catalog:{src_id}|local:sha256:{hash}|");
    }
    source_identity.to_owned()
}

fn conflict_or_already_installed(existing: &Record, incoming_source: &str) -> PluginError {
    if existing.source_identity == incoming_source {
        PluginError::AlreadyInstalled(existing.id.clone())
    } else {
        PluginError::SourceConflict {
            id: existing.id.clone(),
            existing_source: existing.source_identity.clone(),
            incoming_source: incoming_source.to_owned(),
        }
    }
}

fn cleanup_unreferenced_bundle(bundles_dir: &Path, registry: &Registry, bundle_path: &Path) {
    if bundle_path.starts_with(bundles_dir)
        && !registry
            .plugins
            .values()
            .any(|rec| rec.source.bundle_path() == bundle_path)
    {
        let _ = remove_bundle_tree(bundle_path);
    }
}

fn merged_enabled_host_baseline(
    registry: &Registry,
    excluding: Option<&PluginId>,
) -> Result<HostCapabilities, PluginError> {
    let items: Vec<HostCapabilities> = registry
        .plugins
        .values()
        .filter(|rec| excluding.is_none_or(|ex| &rec.id != ex) && rec.enabled && rec.is_approved())
        .map(|rec| rec.requested_capabilities.host.clone())
        .collect();
    Ok(merge_host_capabilities(&items)?)
}

fn catalog_transport_from_artifact(artifact: &CatalogArtifact) -> CatalogTransport {
    match artifact {
        CatalogArtifact::Archive {
            url,
            archive_sha256,
            ..
        } => CatalogTransport::Archive {
            url: url.clone(),
            archive_sha256: archive_sha256.clone(),
        },
        CatalogArtifact::Git { url, rev, subdir } => CatalogTransport::Git {
            url: url.clone(),
            rev: rev.clone(),
            subdir: subdir.clone(),
        },
        CatalogArtifact::LocalSeed { bundle_dir } => CatalogTransport::LocalSeed {
            bundle_dir: bundle_dir.clone(),
        },
    }
}

fn parse_and_validate_v2(raw_bytes: &[u8]) -> Result<Registry, PluginError> {
    let registry: Registry = serde_json::from_slice(raw_bytes)?;
    for (id, record) in &registry.plugins {
        if *id != record.id {
            return Err(PluginError::RegistryId(id.clone()));
        }
    }
    Ok(registry)
}

fn write_atomic_0600(dir: &Path, target: &Path, bytes: &[u8]) -> Result<(), PluginError> {
    let dir_handle = at(dir, File::open(dir))?;
    let mut temp = at(dir, NamedTempFile::new_in(dir))?;
    let temp_path = temp.path().to_owned();
    at(
        &temp_path,
        fs::set_permissions(&temp_path, Permissions::from_mode(0o600)),
    )?;
    at(&temp_path, temp.write_all(bytes))?;
    at(&temp_path, temp.flush())?;
    at(&temp_path, temp.as_file().sync_all())?;
    at(target, temp.persist(target).map_err(|err| err.error))?;
    at(dir, dir_handle.sync_all())
}

#[derive(Deserialize)]
struct VersionPeek {
    schema_version: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[expect(
    dead_code,
    reason = "enforces exact v1 schema key presence via deny_unknown_fields"
)]
struct RegistryV1 {
    schema_version: u32,
    plugins: BTreeMap<PluginId, RecordV1>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[expect(dead_code, reason = "validated during v1-to-v2 migration")]
struct RecordV1 {
    id: PluginId,
    name: String,
    version: String,
    plugin_api: u32,
    source: SourceV1,
    content_digest: String,
    enabled: bool,
    revoked: bool,
    requested_capabilities: CapabilityBundle,
    approved_capabilities: Option<CapabilityBundle>,
    #[serde(default)]
    accepted_build_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum SourceV1 {
    Path {
        root: PathBuf,
    },
    Git {
        url: String,
        rev: String,
        ref_name: String,
        root: PathBuf,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    schema_version: u32,
    desired_revision: u64,
    plugins: BTreeMap<PluginId, Record>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION_V2,
            desired_revision: 0,
            plugins: BTreeMap::new(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApprovalRecord {
    content_digest: String,
    source_identity: String,
    capabilities: CapabilityBundle,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: PluginId,
    name: String,
    version: String,
    plugin_api: u32,
    shared_runtime_abi: SharedRuntimeAbi,
    source: Source,
    source_identity: String,
    content_digest: String,
    enabled: bool,
    revoked: bool,
    migration_reapproval_required: bool,
    requested_capabilities: CapabilityBundle,
    approval: Option<ApprovalRecord>,
}

impl Record {
    fn has_covering_approval(&self) -> bool {
        !self.revoked
            && !self.migration_reapproval_required
            && self.approval.as_ref().is_some_and(|approved| {
                approved.source_identity == self.source_identity
                    && self
                        .requested_capabilities
                        .is_covered_by(&approved.capabilities)
            })
    }

    fn is_approved(&self) -> bool {
        self.has_covering_approval()
            && self
                .approval
                .as_ref()
                .is_some_and(|approved| approved.content_digest == self.content_digest)
    }

    fn verify_digest(&self) -> Result<(), PluginError> {
        verify_bundle(self.source.bundle_path(), &self.content_digest).map_err(
            |err| match err {
                BundleError::DigestMismatch { .. } | BundleError::Io { .. } => {
                    PluginError::DigestDrift(self.id.clone())
                }
                other => PluginError::Bundle(other),
            },
        )?;
        if let Source::Path { root, .. } = &self.source
            && self.content_digest != content_digest(root)?
        {
            return Err(PluginError::DigestDrift(self.id.clone()));
        }
        Ok(())
    }

    fn current_digest_for_audit(&self) -> Result<String, PluginError> {
        let bundle_digest = content_digest(self.source.bundle_path())?;
        if bundle_digest != self.content_digest {
            return Ok(bundle_digest);
        }
        if let Source::Path { root, .. } = &self.source {
            return Ok(content_digest(root)?);
        }
        Ok(bundle_digest)
    }

    fn summary(&self) -> PluginSummary {
        let catalog_source_id = match &self.source {
            Source::Catalog {
                catalog_source_id, ..
            } => Some(catalog_source_id.clone()),
            _ => None,
        };
        PluginSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            version: self.version.clone(),
            plugin_api: self.plugin_api,
            shared_runtime_abi: self.shared_runtime_abi,
            source_identity: self.source_identity.clone(),
            catalog_source_id,
            content_digest: self.content_digest.clone(),
            enabled: self.enabled,
            revoked: self.revoked,
            migration_reapproval_required: self.migration_reapproval_required,
            approved: self.is_approved(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum CatalogTransport {
    Archive {
        url: String,
        archive_sha256: String,
    },
    Git {
        url: String,
        rev: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
    },
    LocalSeed {
        bundle_dir: PathBuf,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Source {
    Path {
        root: PathBuf,
        bundle_path: PathBuf,
    },
    Git {
        url: String,
        ref_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
        rev: String,
        bundle_path: PathBuf,
    },
    Archive {
        url: String,
        archive_sha256: String,
        bundle_path: PathBuf,
    },
    Catalog {
        catalog_source_id: String,
        catalog_source_identity: String,
        version: String,
        transport: CatalogTransport,
        bundle_path: PathBuf,
    },
}

impl Source {
    fn bundle_path(&self) -> &Path {
        match self {
            Self::Path { bundle_path, .. }
            | Self::Git { bundle_path, .. }
            | Self::Archive { bundle_path, .. }
            | Self::Catalog { bundle_path, .. } => bundle_path,
        }
    }
}

fn at<T>(path: &Path, result: io::Result<T>) -> Result<T, PluginError> {
    result.map_err(|source| PluginError::Io {
        path: path.to_owned(),
        source,
    })
}
