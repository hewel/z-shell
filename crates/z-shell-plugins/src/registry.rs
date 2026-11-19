//! Cross-process plugin source and approval registry.

use crate::capabilities::{CapabilityBundle, CapabilityDiff};
use crate::digest::{DigestError, content_digest};
use crate::git;
use crate::manifest::{Manifest, ManifestError};
use rustix::fs::{FlockOperation, flock};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, btree_map::Entry};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;
use thiserror::Error;
use z_shell_config::ShellPaths;
use z_shell_protocol::PluginId;

const SCHEMA_VERSION: u32 = 1;

/// Whether a Git operation may contact a remote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfflinePolicy {
    /// Allow fresh Git clones and fetches.
    Online,
    /// Reject Git clones and fetches before invoking Git.
    Offline,
}

/// A plugin source, approval, or persistence operation failed.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum PluginError {
    /// The registry or source could not be accessed on disk.
    #[error("plugin I/O error at {path}: {source}")]
    Io {
        /// Path involved in the operation.
        path: PathBuf,
        /// Underlying filesystem failure.
        source: io::Error,
    },
    /// The registry does not match its JSON schema.
    #[error("invalid plugin registry JSON: {0}")]
    Json(#[from] serde_json::Error),
    /// The registry was written in a format this program does not support.
    #[error("unsupported plugin registry schema version {0}")]
    RegistryVersion(u32),
    /// The registry has an inconsistent record key.
    #[error("plugin registry key does not match the record id: {0}")]
    RegistryId(PluginId),
    /// A path source did not contain a valid manifest.
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    /// The source could not be hashed.
    #[error(transparent)]
    Digest(#[from] DigestError),
    /// Git clone, resolution, export, or validation failed.
    #[error(transparent)]
    Git(#[from] git::GitError),
    /// The plugin ID is not installed.
    #[error("plugin {0} is not installed")]
    NotFound(PluginId),
    /// The plugin ID is already installed.
    #[error("plugin {0} is already installed; use sync to update it")]
    AlreadyInstalled(PluginId),
    /// A source update attempted to change plugin identity.
    #[error("plugin source id changed from {expected} to {actual}")]
    IdChanged {
        /// Installed plugin ID.
        expected: PluginId,
        /// ID found in the updated source.
        actual: PluginId,
    },
    /// The plugin has no sufficient non-revoked approval.
    #[error("plugin {0} requires explicit capability approval before enabling")]
    ApprovalRequired(PluginId),
    /// Current files no longer match the pinned digest.
    #[error("plugin {0} content digest has drifted; sync and audit the source first")]
    DigestDrift(PluginId),
}

/// Public plugin metadata without source paths, Git credentials, or settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct PluginSummary {
    /// Canonical plugin identifier.
    pub id: PluginId,
    /// Display name from the manifest.
    pub name: String,
    /// Installed package version.
    pub version: String,
    /// Installed plugin API level.
    pub plugin_api: u32,
    /// Installed content digest.
    pub content_digest: String,
    /// Whether composition is enabled.
    pub enabled: bool,
    /// Whether approval has been explicitly revoked.
    pub revoked: bool,
    /// Whether an explicit approval covers the installed capabilities.
    pub approved: bool,
}

/// Comparison of installed authority and disk content against the registry pin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct AuditReport {
    /// Installed plugin metadata.
    pub plugin: PluginSummary,
    /// Installed requested authority compared to explicit approval.
    pub diff: CapabilityDiff,
    /// Digest computed from the source currently on disk.
    pub current_content_digest: String,
    /// Whether the source currently matches the registry pin.
    pub digest_matches: bool,
}

/// Manages static plugin sources and durable approvals for one shell state directory.
#[derive(Debug, Clone)]
pub struct PluginManager {
    paths: ShellPaths,
}

impl PluginManager {
    /// Uses the state directory in `paths`; does not open sockets or create runtime directories.
    #[must_use]
    pub fn new(paths: ShellPaths) -> Self {
        Self { paths }
    }

    /// Lists installed plugins without reading plugin source or exposing settings.
    ///
    /// # Errors
    ///
    /// Returns an error if the registry cannot be read or does not match the v1 schema.
    pub fn list(&self) -> Result<Vec<PluginSummary>, PluginError> {
        Ok(self.load()?.plugins.values().map(Record::summary).collect())
    }

    /// Installs a validated local directory, disabled and without approval.
    ///
    /// # Errors
    ///
    /// Returns an error on invalid source, duplicate identity, or a registry failure.
    pub fn add_path(&self, root: &Path) -> Result<PluginSummary, PluginError> {
        let _lock = self.lock()?;
        let registry = self.load()?;
        let root = at(root, fs::canonicalize(root))?;
        let manifest = Manifest::load(&root)?;
        let digest = content_digest(&root)?;
        self.install(registry, manifest, Source::Path { root }, digest)
    }

    /// Installs a pinned export of a Git ref, disabled and without approval.
    ///
    /// # Errors
    ///
    /// Returns an error on offline policy, failed fetch or export, invalid source,
    /// duplicate identity, or a registry failure.
    pub fn add_git(
        &self,
        url: &str,
        ref_name: &str,
        policy: OfflinePolicy,
    ) -> Result<PluginSummary, PluginError> {
        let _lock = self.lock()?;
        let registry = self.load()?;
        let (manifest, source, digest) = self.prepare_git(url, ref_name, policy, None)?;
        self.install(registry, manifest, source, digest)
    }

    /// Compares installed capabilities against approval and checks the pinned on-disk digest.
    ///
    /// # Errors
    ///
    /// Returns an error if the plugin is missing or its registry or files cannot be read.
    pub fn audit(&self, id: &PluginId) -> Result<AuditReport, PluginError> {
        let registry = self.load()?;
        let record = registry
            .plugins
            .get(id)
            .ok_or_else(|| PluginError::NotFound(id.clone()))?;
        let current_content_digest = content_digest(record.source.root())?;
        Ok(AuditReport {
            digest_matches: record.content_digest == current_content_digest,
            current_content_digest,
            plugin: record.summary(),
            diff: record
                .requested_capabilities
                .diff(record.approved_capabilities.as_ref()),
        })
    }

    /// Approves the installed requested capabilities and clears revocation without enabling.
    ///
    /// # Errors
    ///
    /// Returns an error on digest drift, missing plugin, or source or registry failure.
    pub fn approve(&self, id: &PluginId) -> Result<PluginSummary, PluginError> {
        self.change(id, |record| {
            record.verify_digest()?;
            record.approved_capabilities = Some(record.requested_capabilities.clone());
            record.revoked = false;
            Ok(())
        })
    }

    /// Clears approval, revokes the plugin, and disables composition.
    ///
    /// # Errors
    ///
    /// Returns an error if the plugin is missing or its registry update fails.
    pub fn revoke(&self, id: &PluginId) -> Result<PluginSummary, PluginError> {
        self.change(id, |record| {
            record.approved_capabilities = None;
            record.revoked = true;
            record.enabled = false;
            Ok(())
        })
    }

    /// Enables composition only with sufficient approval and unchanged content.
    ///
    /// # Errors
    ///
    /// Returns an error on missing approval, revocation, digest drift, missing plugin,
    /// or a source or registry failure.
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

    /// Disables composition without removing existing approval.
    ///
    /// # Errors
    ///
    /// Returns an error if the plugin is missing or its registry update fails.
    pub fn disable(&self, id: &PluginId) -> Result<PluginSummary, PluginError> {
        self.change(id, |record| {
            record.enabled = false;
            Ok(())
        })
    }

    /// Updates a source pin, disabling composition when the previous approval no longer covers it.
    ///
    /// # Errors
    ///
    /// Returns an error on invalid source or changed identity, a failed or forbidden Git fetch,
    /// a missing plugin, or a registry failure.
    pub fn sync(&self, id: &PluginId, policy: OfflinePolicy) -> Result<PluginSummary, PluginError> {
        self.change(id, |record| {
            let (manifest, digest) = match &record.source {
                Source::Path { root } => (Manifest::load(root)?, content_digest(root)?),
                Source::Git { url, ref_name, .. } => {
                    let (manifest, source, digest) =
                        self.prepare_git(url, ref_name, policy, Some(id))?;
                    record.source = source;
                    (manifest, digest)
                }
            };
            if manifest.id != *id {
                return Err(PluginError::IdChanged {
                    expected: id.clone(),
                    actual: manifest.id,
                });
            }
            record.content_digest = digest;
            record.name = manifest.name;
            record.version = manifest.version;
            record.plugin_api = manifest.plugin_api;
            record.requested_capabilities = manifest.capabilities;
            record.enabled &= record.is_approved();
            Ok(())
        })
    }

    fn prepare_git(
        &self,
        url: &str,
        ref_name: &str,
        policy: OfflinePolicy,
        expected_id: Option<&PluginId>,
    ) -> Result<(Manifest, Source, String), PluginError> {
        let dir = self.paths.plugins_dir();
        let dir = at(&dir, fs::canonicalize(&dir))?;
        let prepared =
            git::prepare(&dir, url, ref_name, policy, expected_id).map_err(PluginError::Git)?;
        let source = Source::Git {
            url: prepared.url,
            ref_name: ref_name.to_owned(),
            rev: prepared.rev,
            root: prepared.root,
        };
        Ok((prepared.manifest, source, prepared.content_digest))
    }

    fn install(
        &self,
        mut registry: Registry,
        manifest: Manifest,
        source: Source,
        content_digest: String,
    ) -> Result<PluginSummary, PluginError> {
        let id = manifest.id;
        let Entry::Vacant(entry) = registry.plugins.entry(id.clone()) else {
            return Err(PluginError::AlreadyInstalled(id));
        };
        let summary = entry
            .insert(Record {
                id,
                name: manifest.name,
                version: manifest.version,
                plugin_api: manifest.plugin_api,
                source,
                content_digest,
                enabled: false,
                revoked: false,
                requested_capabilities: manifest.capabilities,
                approved_capabilities: None,
                accepted_build_id: None,
            })
            .summary();
        self.save(&registry)?;
        Ok(summary)
    }

    fn change(
        &self,
        id: &PluginId,
        change: impl FnOnce(&mut Record) -> Result<(), PluginError>,
    ) -> Result<PluginSummary, PluginError> {
        let _lock = self.lock()?;
        let mut registry = self.load()?;
        let record = registry
            .plugins
            .get_mut(id)
            .ok_or_else(|| PluginError::NotFound(id.clone()))?;
        change(record)?;
        let summary = record.summary();
        self.save(&registry)?;
        Ok(summary)
    }

    fn load(&self) -> Result<Registry, PluginError> {
        let path = self.paths.plugins_registry_file();
        // An open descriptor sees either the old registry or the new one across rename.
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Registry::default()),
            Err(source) => return Err(PluginError::Io { path, source }),
        };
        let registry: Registry = serde_json::from_reader(BufReader::new(file))?;
        if registry.schema_version != SCHEMA_VERSION {
            return Err(PluginError::RegistryVersion(registry.schema_version));
        }
        for (id, record) in &registry.plugins {
            if *id != record.id {
                return Err(PluginError::RegistryId(id.clone()));
            }
        }
        Ok(registry)
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

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    schema_version: u32,
    plugins: BTreeMap<PluginId, Record>,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            plugins: BTreeMap::new(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    id: PluginId,
    name: String,
    version: String,
    plugin_api: u32,
    source: Source,
    content_digest: String,
    enabled: bool,
    revoked: bool,
    requested_capabilities: CapabilityBundle,
    approved_capabilities: Option<CapabilityBundle>,
    accepted_build_id: Option<String>,
}

impl Record {
    fn is_approved(&self) -> bool {
        !self.revoked
            && self
                .approved_capabilities
                .as_ref()
                .is_some_and(|approved| self.requested_capabilities.is_covered_by(approved))
    }

    fn verify_digest(&self) -> Result<(), PluginError> {
        if self.content_digest != content_digest(self.source.root())? {
            return Err(PluginError::DigestDrift(self.id.clone()));
        }
        Ok(())
    }

    fn summary(&self) -> PluginSummary {
        PluginSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            version: self.version.clone(),
            plugin_api: self.plugin_api,
            content_digest: self.content_digest.clone(),
            enabled: self.enabled,
            revoked: self.revoked,
            approved: self.is_approved(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Source {
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

impl Source {
    fn root(&self) -> &Path {
        match self {
            Self::Path { root } | Self::Git { root, .. } => root,
        }
    }
}

fn at<T>(path: &Path, result: io::Result<T>) -> Result<T, PluginError> {
    result.map_err(|source| PluginError::Io {
        path: path.to_owned(),
        source,
    })
}
