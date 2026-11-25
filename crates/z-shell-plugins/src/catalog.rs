//! Decentralized multi-source static plugin catalogs and bundled official local seeds.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, DirBuilder};
use std::io::{self, Write};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;
use thiserror::Error;
use z_shell_config::{PluginSourceKind, PluginSourceSettings, ShellPaths};
use z_shell_protocol::PluginId;

use super::digest::content_digest;
use super::git;
use super::manifest::{Manifest, SharedRuntimeAbi, StoreCategory};
use super::registry::OfflinePolicy;

const CATALOG_SCHEMA_VERSION: u32 = 1;

/// Security advisory published inside a static catalog index.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[non_exhaustive]
pub struct CatalogAdvisory {
    /// Advisory identifier (for example, `ZSA-2026-001`).
    pub id: String,
    /// Severity level (`"low" | "medium" | "high" | "critical"`).
    pub severity: String,
    /// Affected package version range or list.
    pub affected_versions: String,
    /// Human-readable guidance.
    pub message: String,
}

/// Screenshot entry declared inside a catalog plugin record.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[non_exhaustive]
pub struct CatalogScreenshot {
    /// Screenshot URL or local asset reference.
    pub url: String,
    /// SHA-256 digest (`sha256:<64-hex>`).
    pub sha256: String,
    /// Optional caption.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
}

/// Downloadable or local-seed artifact pointer for one catalog release.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum CatalogArtifact {
    /// `.tar.gz` or `.tar.zst` archive pinned by SHA-256.
    Archive {
        /// Archive URL or local file path.
        url: String,
        /// Expected archive SHA-256 (`sha256:<64-hex>`).
        archive_sha256: String,
        /// Declared compressed byte size.
        size_bytes: u64,
    },
    /// Pinned Git commit and optional monorepo subdirectory.
    Git {
        /// Git repository URL.
        url: String,
        /// Exact 40-hex commit SHA.
        rev: String,
        /// Optional relative monorepo subdirectory.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subdir: Option<String>,
    },
    /// Built-in read-only bundled local seed directory (shares `official` source identity).
    LocalSeed {
        /// Prebuilt read-only plugin directory inside `/usr/share/z-shell/bundled-plugins/`.
        bundle_dir: PathBuf,
    },
}

/// One published release inside a catalog plugin entry.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[non_exhaustive]
pub struct CatalogRelease {
    /// Semver package version.
    pub version: String,
    /// Required `plugin_api` level.
    pub plugin_api: u32,
    /// Required `shared_runtime_abi` (`major.minor`).
    pub shared_runtime_abi: SharedRuntimeAbi,
    /// Optional informational minimum shell version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_shell_version: Option<String>,
    /// Deterministic `sha256:<64-hex>` content digest of the verified plugin bundle.
    pub content_digest: String,
    /// Artifact location & pinning metadata.
    pub artifact: CatalogArtifact,
    /// Informational capabilities preview displayed before staging.
    #[serde(default)]
    pub declared_capabilities_preview: serde_json::Value,
}

/// One plugin entry inside a `catalog-v1.json` document.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[non_exhaustive]
pub struct CatalogPlugin {
    /// Canonical `author/plugin` identifier.
    pub id: PluginId,
    /// Display name.
    pub name: String,
    /// Author name.
    pub author: String,
    /// Short summary.
    pub summary: String,
    /// Catalog category.
    pub category: StoreCategory,
    /// Searchable tags.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Optional homepage URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    /// Optional icon URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    /// Optional icon SHA-256.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_sha256: Option<String>,
    /// Optional screenshots.
    #[serde(default)]
    pub screenshots: Vec<CatalogScreenshot>,
    /// Latest recommended version.
    pub latest_version: String,
    /// Whether the plugin has been yanked from the catalog.
    #[serde(default)]
    pub yanked: bool,
    /// Active security advisories.
    #[serde(default)]
    pub advisories: Vec<CatalogAdvisory>,
    /// Available releases.
    pub releases: Vec<CatalogRelease>,
}

/// Parsed static `catalog-v1.json` index.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[non_exhaustive]
pub struct CatalogIndex {
    /// Index schema version (must be `1`).
    pub schema_version: u32,
    /// Source identifier matching the configured source.
    pub source_id: String,
    /// ISO-8601 timestamp when the index was published.
    pub updated_at: String,
    /// Catalog plugin listings.
    pub plugins: Vec<CatalogPlugin>,
}

/// Offering from one enabled catalog source for an aggregated plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct CatalogSourceOffering {
    /// Configured source identifier.
    pub source_id: String,
    /// Human-readable source name.
    pub source_name: String,
    /// Priority (lower takes visual precedence).
    pub priority: u32,
    /// Canonical `source_identity` string.
    pub source_identity: String,
    /// Latest version offered by this source.
    pub latest_version: String,
    /// Whether this offering is yanked.
    pub yanked: bool,
    /// Advisories reported by this source.
    pub advisories: Vec<CatalogAdvisory>,
    /// Full catalog plugin record from this source.
    pub plugin: CatalogPlugin,
}

/// Aggregated search/detail view grouped by [`PluginId`] across all enabled catalog sources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct AggregatedCatalogEntry {
    /// Canonical plugin identifier.
    pub id: PluginId,
    /// Preferred source ID (lowest `priority`, tie-broken by `source_id`).
    pub preferred_source_id: String,
    /// Display name from the preferred source.
    pub name: String,
    /// Summary from the preferred source.
    pub summary: String,
    /// Category from the preferred source.
    pub category: StoreCategory,
    /// Latest version from the preferred source.
    pub latest_version: String,
    /// All enabled sources providing this `PluginId`, sorted by priority.
    pub available_sources: Vec<CatalogSourceOffering>,
}

/// Resolved release selected from a specific catalog source for installation.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ResolvedCatalogRelease {
    /// Selected catalog source ID.
    pub source_id: String,
    /// Canonical `source_identity` bound into approvals and cross-source takeover checks.
    pub source_identity: String,
    /// Parent plugin metadata.
    pub plugin: CatalogPlugin,
    /// Selected release metadata.
    pub release: CatalogRelease,
}

/// Result of refreshing one configured catalog source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct CatalogRefreshResult {
    /// Configured source ID.
    pub source_id: String,
    /// True when the response came from local cache/seed rather than a fresh remote fetch.
    pub cached: bool,
    /// True when offline mode prevented checking upstream for newer metadata.
    pub stale: bool,
    /// Number of plugins available in the loaded source view.
    pub plugin_count: usize,
}

/// Error returned while refreshing, querying, or resolving catalog sources.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum CatalogError {
    /// Filesystem I/O failed.
    #[error("catalog I/O error at {path}: {source}")]
    Io {
        /// Affected filesystem path.
        path: PathBuf,
        /// Underlying OS error.
        #[source]
        source: io::Error,
    },
    /// Invalid `catalog-v1.json` syntax or schema.
    #[error("invalid catalog index JSON for source {source_id:?}: {reason}")]
    InvalidIndex {
        /// Offending source ID.
        source_id: String,
        /// Failure summary.
        reason: String,
    },
    /// Remote HTTP catalog refresh failed.
    #[error("failed to fetch catalog {source_id:?}: {reason}")]
    Fetch {
        /// Source ID.
        source_id: String,
        /// Underlying error message.
        reason: String,
    },
    /// Git catalog refresh failed.
    #[error(transparent)]
    Git(#[from] git::GitError),
    /// Remote catalog unavailable while `offline_mode` is active and no local cache/seed exists.
    #[error("catalog source {0:?} has no local cache in offline mode")]
    OfflineNoCache(String),
    /// Named source was not found or is disabled.
    #[error("catalog source {0:?} not found or disabled")]
    SourceNotFound(String),
    /// Requested plugin does not exist in enabled sources.
    #[error("plugin {0} not found in enabled catalog sources")]
    PluginNotFound(PluginId),
    /// Requested release version does not exist for the plugin.
    #[error("plugin {id} version {version:?} not found in source {source_id:?}")]
    VersionNotFound {
        /// Plugin ID.
        id: PluginId,
        /// Source ID.
        source_id: String,
        /// Requested version.
        version: String,
    },
    /// Multiple enabled sources provide the same `PluginId`; caller must pass `--source`.
    #[error("plugin {id} exists in multiple sources ({sources:?}); specify --source explicitly")]
    AmbiguousPluginSource {
        /// Conflicting plugin ID.
        id: PluginId,
        /// Candidate source IDs.
        sources: Vec<String>,
    },
}

/// Reads, caches, aggregates, and resolves multi-source static plugin catalogs.
#[derive(Debug, Clone)]
pub struct CatalogStore {
    paths: ShellPaths,
}

impl CatalogStore {
    /// Creates a catalog store backed by `paths`.
    #[must_use]
    pub fn new(paths: ShellPaths) -> Self {
        Self { paths }
    }

    /// Refreshes all enabled catalog sources according to `policy`.
    ///
    /// # Errors
    ///
    /// Returns [`CatalogError`] if a source index is malformed, offline with no local cache/seed,
    /// or unreachable when online.
    pub fn refresh(
        &self,
        sources: &[PluginSourceSettings],
        policy: OfflinePolicy,
    ) -> Result<Vec<CatalogRefreshResult>, CatalogError> {
        let mut results = Vec::new();
        for source in sources.iter().filter(|s| s.enabled) {
            let loaded = self.load_source(source, policy, true)?;
            results.push(CatalogRefreshResult {
                source_id: source.id.clone(),
                cached: loaded.cached,
                stale: loaded.stale,
                plugin_count: loaded.plugins.len(),
            });
        }
        Ok(results)
    }

    /// Searches and aggregates plugins across enabled catalog sources by `PluginId`.
    ///
    /// # Errors
    ///
    /// Returns [`CatalogError`] if reading or parsing an enabled source fails.
    pub fn search(
        &self,
        sources: &[PluginSourceSettings],
        query: &str,
        category: Option<StoreCategory>,
        source_filter: Option<&str>,
        policy: OfflinePolicy,
    ) -> Result<Vec<AggregatedCatalogEntry>, CatalogError> {
        let needle = query.trim().to_ascii_lowercase();
        let aggregated = self.aggregate_sources(sources, source_filter, policy)?;
        Ok(aggregated
            .into_iter()
            .filter(|entry| {
                if let Some(cat) = category
                    && entry.category != cat
                {
                    return false;
                }
                if needle.is_empty() {
                    return true;
                }
                entry.id.as_str().to_ascii_lowercase().contains(&needle)
                    || entry.name.to_ascii_lowercase().contains(&needle)
                    || entry.summary.to_ascii_lowercase().contains(&needle)
                    || entry.available_sources.iter().any(|off| {
                        off.plugin
                            .tags
                            .iter()
                            .any(|t| t.to_ascii_lowercase().contains(&needle))
                    })
            })
            .collect())
    }

    /// Returns aggregated metadata and all source offerings for a single [`PluginId`].
    ///
    /// # Errors
    ///
    /// Returns [`CatalogError::PluginNotFound`] if no enabled source offers `id`.
    pub fn detail(
        &self,
        sources: &[PluginSourceSettings],
        id: &PluginId,
        policy: OfflinePolicy,
    ) -> Result<AggregatedCatalogEntry, CatalogError> {
        let mut entries = self.aggregate_sources(sources, None, policy)?;
        entries
            .drain(..)
            .find(|entry| &entry.id == id)
            .ok_or_else(|| CatalogError::PluginNotFound(id.clone()))
    }

    /// Resolves a specific plugin release from `sources`, refusing to guess across multi-source
    /// `PluginId` collisions when `explicit_source` is `None`.
    ///
    /// # Errors
    ///
    /// Returns [`CatalogError::AmbiguousPluginSource`] if multiple enabled sources contain `id` and
    /// `explicit_source` is `None`, or [`CatalogError::PluginNotFound`] / [`CatalogError::VersionNotFound`].
    pub fn resolve_install(
        &self,
        sources: &[PluginSourceSettings],
        id: &PluginId,
        version: Option<&str>,
        explicit_source: Option<&str>,
        policy: OfflinePolicy,
    ) -> Result<ResolvedCatalogRelease, CatalogError> {
        if let Some(src_id) = explicit_source
            && !sources.iter().any(|s| s.enabled && s.id == src_id)
        {
            return Err(CatalogError::SourceNotFound(src_id.to_owned()));
        }
        let entry = self.detail(sources, id, policy)?;
        let matching: Vec<&CatalogSourceOffering> = entry
            .available_sources
            .iter()
            .filter(|off| explicit_source.is_none_or(|src| off.source_id == src))
            .collect();
        let offering = match matching.as_slice() {
            [] => return Err(CatalogError::PluginNotFound(id.clone())),
            [only] => *only,
            many => {
                return Err(CatalogError::AmbiguousPluginSource {
                    id: id.clone(),
                    sources: many.iter().map(|o| o.source_id.clone()).collect(),
                });
            }
        };

        let target_ver = version.unwrap_or(offering.latest_version.as_str());
        let release = offering
            .plugin
            .releases
            .iter()
            .find(|r| r.version == target_ver)
            .cloned()
            .ok_or_else(|| CatalogError::VersionNotFound {
                id: id.clone(),
                source_id: offering.source_id.clone(),
                version: target_ver.to_owned(),
            })?;

        let source_identity = match &release.artifact {
            CatalogArtifact::Git { subdir, .. } => sources
                .iter()
                .find(|s| s.id == offering.source_id)
                .map_or_else(
                    || offering.source_identity.clone(),
                    |src| canonical_catalog_source_identity(src, subdir.as_deref()),
                ),
            CatalogArtifact::Archive { .. } | CatalogArtifact::LocalSeed { .. } => {
                offering.source_identity.clone()
            }
        };

        Ok(ResolvedCatalogRelease {
            source_id: offering.source_id.clone(),
            source_identity,
            plugin: offering.plugin.clone(),
            release,
        })
    }

    fn aggregate_sources(
        &self,
        sources: &[PluginSourceSettings],
        source_filter: Option<&str>,
        policy: OfflinePolicy,
    ) -> Result<Vec<AggregatedCatalogEntry>, CatalogError> {
        if let Some(src_id) = source_filter
            && !sources.iter().any(|s| s.enabled && s.id == src_id)
        {
            return Err(CatalogError::SourceNotFound(src_id.to_owned()));
        }
        let mut by_id: BTreeMap<PluginId, Vec<CatalogSourceOffering>> = BTreeMap::new();
        for source in sources
            .iter()
            .filter(|s| s.enabled && source_filter.is_none_or(|f| s.id == f))
        {
            let loaded = self.load_source(source, policy, false)?;
            let source_identity = canonical_catalog_source_identity(source, None);
            for plugin in loaded.plugins {
                by_id
                    .entry(plugin.id.clone())
                    .or_default()
                    .push(CatalogSourceOffering {
                        source_id: source.id.clone(),
                        source_name: source.name.clone(),
                        priority: source.priority,
                        source_identity: source_identity.clone(),
                        latest_version: plugin.latest_version.clone(),
                        yanked: plugin.yanked,
                        advisories: plugin.advisories.clone(),
                        plugin,
                    });
            }
        }

        let mut aggregated = Vec::with_capacity(by_id.len());
        for (id, mut offerings) in by_id {
            offerings.sort_by(|a, b| {
                a.priority
                    .cmp(&b.priority)
                    .then(a.source_id.cmp(&b.source_id))
            });
            let primary = &offerings[0];
            aggregated.push(AggregatedCatalogEntry {
                id,
                preferred_source_id: primary.source_id.clone(),
                name: primary.plugin.name.clone(),
                summary: primary.plugin.summary.clone(),
                category: primary.plugin.category,
                latest_version: primary.latest_version.clone(),
                available_sources: offerings,
            });
        }
        Ok(aggregated)
    }

    fn load_source(
        &self,
        source: &PluginSourceSettings,
        policy: OfflinePolicy,
        force_fetch_when_online: bool,
    ) -> Result<LoadedSource, CatalogError> {
        let mut loaded = match source.kind {
            PluginSourceKind::LocalFile => {
                let path = Path::new(&source.url);
                let bytes = fs::read(path).map_err(|err| CatalogError::Io {
                    path: path.to_path_buf(),
                    source: err,
                })?;
                let index = parse_catalog_index(&source.id, &bytes)?;
                LoadedSource {
                    cached: false,
                    stale: false,
                    plugins: index.plugins,
                }
            }
            PluginSourceKind::HttpsJson | PluginSourceKind::GitJson => {
                let cache_dir = self.paths.plugin_catalog_cache_dir();
                let cache_path = cache_dir.join(format!("{}.json", source.id));
                let etag_path = cache_dir.join(format!("{}.etag", source.id));
                let has_seed = source
                    .local_seed_dir
                    .as_ref()
                    .is_some_and(|dir| dir.is_dir());

                match policy {
                    OfflinePolicy::Offline => match fs::read(&cache_path) {
                        Ok(bytes) => {
                            let index = parse_catalog_index(&source.id, &bytes)?;
                            LoadedSource {
                                cached: true,
                                stale: true,
                                plugins: index.plugins,
                            }
                        }
                        Err(err) if err.kind() == io::ErrorKind::NotFound && has_seed => {
                            LoadedSource {
                                cached: true,
                                stale: true,
                                plugins: Vec::new(),
                            }
                        }
                        Err(err) if err.kind() == io::ErrorKind::NotFound => {
                            return Err(CatalogError::OfflineNoCache(source.id.clone()));
                        }
                        Err(err) => {
                            return Err(CatalogError::Io {
                                path: cache_path,
                                source: err,
                            });
                        }
                    },
                    OfflinePolicy::Online => {
                        if !force_fetch_when_online && cache_path.is_file() {
                            let bytes = fs::read(&cache_path).map_err(|err| CatalogError::Io {
                                path: cache_path.clone(),
                                source: err,
                            })?;
                            let index = parse_catalog_index(&source.id, &bytes)?;
                            LoadedSource {
                                cached: true,
                                stale: false,
                                plugins: index.plugins,
                            }
                        } else {
                            self.fetch_and_cache_remote(
                                source,
                                &cache_dir,
                                &cache_path,
                                &etag_path,
                            )?
                        }
                    }
                }
            }
            _ => {
                return Err(CatalogError::InvalidIndex {
                    source_id: source.id.clone(),
                    reason: "unsupported catalog source kind".to_owned(),
                });
            }
        };

        if let Some(seed_dir) = &source.local_seed_dir
            && seed_dir.is_dir()
        {
            let seed_plugins = scan_local_seed_dir(seed_dir)?;
            merge_seed_plugins(&mut loaded.plugins, seed_plugins);
        }

        Ok(loaded)
    }

    fn fetch_and_cache_remote(
        &self,
        source: &PluginSourceSettings,
        cache_dir: &Path,
        cache_path: &Path,
        etag_path: &Path,
    ) -> Result<LoadedSource, CatalogError> {
        ensure_dir(cache_dir)?;
        match source.kind {
            PluginSourceKind::HttpsJson => {
                let etag_header = fs::read_to_string(etag_path)
                    .ok()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty());
                let resp = super::net::get_validated(&source.url, etag_header.as_deref()).map_err(
                    |reason| CatalogError::Fetch {
                        source_id: source.id.clone(),
                        reason,
                    },
                )?;
                if resp.status().as_u16() == 304 && cache_path.is_file() {
                    let bytes = fs::read(cache_path).map_err(|err| CatalogError::Io {
                        path: cache_path.to_path_buf(),
                        source: err,
                    })?;
                    let index = parse_catalog_index(&source.id, &bytes)?;
                    return Ok(LoadedSource {
                        cached: true,
                        stale: false,
                        plugins: index.plugins,
                    });
                }
                let etag = resp
                    .headers()
                    .get("ETag")
                    .and_then(|v| v.to_str().ok())
                    .map(ToOwned::to_owned);
                let bytes = resp
                    .into_body()
                    .read_to_vec()
                    .map_err(|err| CatalogError::Fetch {
                        source_id: source.id.clone(),
                        reason: err.to_string(),
                    })?;
                let index = parse_catalog_index(&source.id, &bytes)?;
                atomic_write(cache_path, &bytes)?;
                if let Some(etag) = etag {
                    let _ = atomic_write(etag_path, etag.as_bytes());
                }
                Ok(LoadedSource {
                    cached: false,
                    stale: false,
                    plugins: index.plugins,
                })
            }
            PluginSourceKind::GitJson => {
                let rel_path = source.index_path.as_deref().unwrap_or("catalog-v1.json");
                let ref_name = source.ref_name.as_deref().unwrap_or("HEAD");
                let bytes = git::read_file_at_ref(
                    &self.paths.plugins_dir(),
                    &source.url,
                    ref_name,
                    rel_path,
                    OfflinePolicy::Online,
                )?;
                let index = parse_catalog_index(&source.id, &bytes)?;
                atomic_write(cache_path, &bytes)?;
                Ok(LoadedSource {
                    cached: false,
                    stale: false,
                    plugins: index.plugins,
                })
            }
            PluginSourceKind::LocalFile | _ => Err(CatalogError::InvalidIndex {
                source_id: source.id.clone(),
                reason: "unsupported remote catalog source kind".to_owned(),
            }),
        }
    }
}

struct LoadedSource {
    cached: bool,
    stale: bool,
    plugins: Vec<CatalogPlugin>,
}

/// Computes the canonical `source_identity` string for a catalog plugin release.
#[must_use]
pub fn canonical_catalog_source_identity(
    source: &PluginSourceSettings,
    subdir: Option<&str>,
) -> String {
    let origin = match source.kind {
        PluginSourceKind::LocalFile => fs::canonicalize(&source.url)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| source.url.clone()),
        PluginSourceKind::HttpsJson | PluginSourceKind::GitJson | _ => source.url.clone(),
    };
    let sub = subdir.unwrap_or("");
    format!("catalog:{}|{origin}|{sub}", source.id)
}

fn parse_catalog_index(source_id: &str, bytes: &[u8]) -> Result<CatalogIndex, CatalogError> {
    let index: CatalogIndex =
        serde_json::from_slice(bytes).map_err(|err| CatalogError::InvalidIndex {
            source_id: source_id.to_owned(),
            reason: err.to_string(),
        })?;
    if index.schema_version != CATALOG_SCHEMA_VERSION {
        return Err(CatalogError::InvalidIndex {
            source_id: source_id.to_owned(),
            reason: format!(
                "unsupported catalog schema_version {}",
                index.schema_version
            ),
        });
    }
    if index.source_id != source_id {
        return Err(CatalogError::InvalidIndex {
            source_id: source_id.to_owned(),
            reason: format!(
                "catalog index source_id {:?} does not match configured source {:?}",
                index.source_id, source_id
            ),
        });
    }
    Ok(index)
}

fn scan_local_seed_dir(seed_root: &Path) -> Result<Vec<CatalogPlugin>, CatalogError> {
    let mut plugins = Vec::new();
    let entries = fs::read_dir(seed_root).map_err(|err| CatalogError::Io {
        path: seed_root.to_path_buf(),
        source: err,
    })?;
    for entry in entries {
        let entry = entry.map_err(|err| CatalogError::Io {
            path: seed_root.to_path_buf(),
            source: err,
        })?;
        let path = entry.path();
        if !path.is_dir() || !path.join("plugin.toml").is_file() {
            continue;
        }
        let Ok(manifest) = Manifest::load(&path) else {
            continue;
        };
        let Ok(digest) = content_digest(&path) else {
            continue;
        };
        let shared_runtime_abi = manifest
            .build
            .as_ref()
            .map_or(super::manifest::HOST_SHARED_RUNTIME_ABI, |b| {
                b.shared_runtime_abi
            });
        let category = manifest
            .store
            .as_ref()
            .map_or(StoreCategory::System, |s| s.category);
        let tags = manifest
            .store
            .as_ref()
            .map(|s| s.tags.clone())
            .unwrap_or_default();
        let homepage = manifest.store.as_ref().and_then(|s| s.homepage.clone());
        let release = CatalogRelease {
            version: manifest.version.clone(),
            plugin_api: manifest.plugin_api,
            shared_runtime_abi,
            min_shell_version: manifest.min_shell_version.clone(),
            content_digest: digest,
            artifact: CatalogArtifact::LocalSeed { bundle_dir: path },
            declared_capabilities_preview: serde_json::to_value(&manifest.capabilities)
                .unwrap_or(serde_json::Value::Null),
        };
        plugins.push(CatalogPlugin {
            id: manifest.id,
            name: manifest.name,
            author: manifest.author.unwrap_or_else(|| "z-shell".to_owned()),
            summary: manifest.description.unwrap_or_default(),
            category,
            tags,
            homepage,
            icon_url: None,
            icon_sha256: None,
            screenshots: Vec::new(),
            latest_version: release.version.clone(),
            yanked: false,
            advisories: Vec::new(),
            releases: vec![release],
        });
    }
    Ok(plugins)
}

fn merge_seed_plugins(target: &mut Vec<CatalogPlugin>, seeds: Vec<CatalogPlugin>) {
    for seed in seeds {
        if let Some(existing) = target.iter_mut().find(|p| p.id == seed.id) {
            let mut existing_versions: BTreeSet<String> = existing
                .releases
                .iter()
                .map(|r| r.version.clone())
                .collect();
            for rel in seed.releases {
                if existing_versions.insert(rel.version.clone()) {
                    existing.releases.push(rel);
                }
            }
        } else {
            target.push(seed);
        }
    }
}

fn ensure_dir(dir: &Path) -> Result<(), CatalogError> {
    DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(dir)
        .map_err(|source| CatalogError::Io {
            path: dir.to_path_buf(),
            source,
        })
}

fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), CatalogError> {
    let dir = target.parent().unwrap_or(target);
    ensure_dir(dir)?;
    let mut temp = NamedTempFile::new_in(dir).map_err(|source| CatalogError::Io {
        path: dir.to_path_buf(),
        source,
    })?;
    temp.write_all(bytes).map_err(|source| CatalogError::Io {
        path: temp.path().to_path_buf(),
        source,
    })?;
    temp.as_file()
        .sync_all()
        .map_err(|source| CatalogError::Io {
            path: temp.path().to_path_buf(),
            source,
        })?;
    temp.persist(target).map_err(|err| CatalogError::Io {
        path: target.to_path_buf(),
        source: err.error,
    })?;
    Ok(())
}
