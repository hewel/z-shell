//! Live `plugins` topic state, registry file watcher, cache-only public catalog reads, and
//! privileged host plugin-store commands.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use z_shell_bus::{BusHub, CommandCall, CommandHandler, UpdateKind};
use z_shell_config::{PluginSourceKind, PluginSourceSettings, ShellPaths, UserSettings};
use z_shell_plugins::capabilities::CapabilityBundle;
use z_shell_plugins::catalog::{
    CatalogError, CatalogStore, catalog_cache_paths, source_provenance_key,
};
use z_shell_plugins::catalog_media::{self, CatalogMediaError};
use z_shell_plugins::net::CancelToken;
use z_shell_plugins::registry::{
    OfflinePolicy, PluginError, PluginManager, PluginSummary, RemoveSettingsPolicy, StagedInstall,
    StagedUpgrade, UpgradeApprovalMode,
};
use z_shell_protocol::{
    ClientRole, CommandInvokeResult, CommandName, ErrorCode, MediaRef, PluginId, RpcError,
    TopicName,
};

use crate::topics;

const REGISTRY_WATCH_INTERVAL: Duration = Duration::from_millis(200);
const MAX_STAGED_OPS: usize = 64;
const MAX_PREVIEW_BLOBS: usize = 512;
const DEFAULT_CATALOG_PAGE_LIMIT: usize = 20;
const MAX_CATALOG_PAGE_LIMIT: usize = 50;

/// Live public `plugins` topic payload separating desired registry state from unknown runtime state.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct PluginsTopicSnapshot {
    desired_revision: u64,
    applied_desired_revision: Option<u64>,
    runtime_overlay_supported: bool,
    offline_mode: bool,
    plugins: Vec<PublicPluginEntry>,
    sources: Vec<PublicCatalogSource>,
    counts: PluginCounts,
}

#[derive(Debug, Clone, Serialize)]
struct PublicPluginEntry {
    #[serde(flatten)]
    summary: PluginSummary,
    runtime_state: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct PublicCatalogSource {
    id: String,
    name: String,
    kind: PluginSourceKind,
    url: String,
    enabled: bool,
    priority: u32,
    has_local_seed: bool,
    cached: bool,
}

#[derive(Debug, Clone, Serialize)]
struct PluginCounts {
    total: usize,
    enabled: usize,
    approved: usize,
    pending_approval: usize,
    revoked: usize,
}

#[derive(Debug, Clone)]
struct PreviewAssetRef {
    source: PluginSourceSettings,
    asset_url: String,
    sha256: String,
}

#[derive(Debug, Default)]
struct StoreState {
    offline_mode: bool,
    sources: Vec<PluginSourceSettings>,
    staged_seq: u64,
    staged_installs: HashMap<String, StagedInstall>,
    staged_install_order: VecDeque<String>,
    staged_upgrades: HashMap<String, StagedUpgrade>,
    staged_upgrade_order: VecDeque<String>,
    preview_blobs: HashMap<String, PreviewAssetRef>,
    preview_blob_order: VecDeque<String>,
    last_published_signature: Option<String>,
}

impl StoreState {
    fn insert_staged_install(&mut self, staged: StagedInstall) -> String {
        self.staged_seq = self.staged_seq.saturating_add(1);
        let token = format!("stg_in_{}", self.staged_seq);
        if self.staged_installs.len() >= MAX_STAGED_OPS
            && let Some(oldest) = self.staged_install_order.pop_front()
        {
            self.staged_installs.remove(&oldest);
        }
        self.staged_install_order.push_back(token.clone());
        self.staged_installs.insert(token.clone(), staged);
        token
    }

    fn insert_staged_upgrade(&mut self, staged: StagedUpgrade) -> String {
        self.staged_seq = self.staged_seq.saturating_add(1);
        let token = format!("stg_up_{}", self.staged_seq);
        if self.staged_upgrades.len() >= MAX_STAGED_OPS
            && let Some(oldest) = self.staged_upgrade_order.pop_front()
        {
            self.staged_upgrades.remove(&oldest);
        }
        self.staged_upgrade_order.push_back(token.clone());
        self.staged_upgrades.insert(token.clone(), staged);
        token
    }

    fn register_preview_blob(
        &mut self,
        source: &PluginSourceSettings,
        asset_url: &str,
        sha256: &str,
    ) -> MediaRef {
        let mut hasher = Sha256::new();
        hasher.update(b"blob-handle-v1|");
        hasher.update(source_provenance_key(source).as_bytes());
        hasher.update(b"|");
        hasher.update(asset_url.as_bytes());
        hasher.update(b"|");
        hasher.update(sha256.as_bytes());
        let token = format!("{:x}", hasher.finalize());

        if !self.preview_blobs.contains_key(&token) {
            if self.preview_blobs.len() >= MAX_PREVIEW_BLOBS
                && let Some(oldest) = self.preview_blob_order.pop_front()
            {
                self.preview_blobs.remove(&oldest);
            }
            self.preview_blob_order.push_back(token.clone());
            self.preview_blobs.insert(
                token.clone(),
                PreviewAssetRef {
                    source: source.clone(),
                    asset_url: asset_url.to_owned(),
                    sha256: sha256.to_owned(),
                },
            );
        }
        MediaRef::BlobHandle {
            token,
            mime: "image/png".to_owned(),
            byte_len: 0,
        }
    }
}

/// Owns daemon-side plugin registry watching, cache-only catalog queries, and host store commands.
pub(crate) struct PluginService {
    paths: ShellPaths,
    hub: BusHub,
    manager: Arc<PluginManager>,
    catalog: Arc<CatalogStore>,
    cancel: Arc<CancelToken>,
    state: Mutex<StoreState>,
    stop_watch: watch::Sender<bool>,
    watch_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl PluginService {
    pub(crate) fn install(hub: &BusHub, paths: ShellPaths, settings: &UserSettings) -> Arc<Self> {
        let cancel = Arc::new(CancelToken::new());
        if settings.general.offline_mode {
            cancel.cancel();
        }
        let (stop_watch, stop_rx) = watch::channel(false);
        let service = Arc::new(Self {
            paths: paths.clone(),
            hub: hub.clone(),
            manager: Arc::new(PluginManager::new(paths.clone())),
            catalog: Arc::new(CatalogStore::new(paths)),
            cancel,
            state: Mutex::new(StoreState {
                offline_mode: settings.general.offline_mode,
                sources: settings.plugins.sources.clone(),
                ..StoreState::default()
            }),
            stop_watch,
            watch_task: Mutex::new(None),
        });

        service.publish_snapshot(UpdateKind::SourceBaseline);
        service.register_commands();
        service.start_registry_watcher(stop_rx);
        service
    }

    pub(crate) fn apply_settings(&self, settings: &UserSettings) {
        let offline = settings.general.offline_mode;
        if offline {
            self.cancel.cancel();
        } else {
            self.cancel.reset();
        }
        {
            let mut guard = self.state.lock().expect("plugin store state lock poisoned");
            guard.offline_mode = offline;
            guard.sources.clone_from(&settings.plugins.sources);
        }
        self.publish_snapshot(UpdateKind::Live);
    }

    pub(crate) fn shutdown(&self) {
        self.cancel.cancel();
        let _ = self.stop_watch.send(true);
        if let Some(task) = self
            .watch_task
            .lock()
            .expect("plugin watch task lock poisoned")
            .take()
        {
            task.abort();
        }
    }

    fn offline_policy(&self) -> OfflinePolicy {
        if self
            .state
            .lock()
            .expect("plugin store state lock poisoned")
            .offline_mode
        {
            OfflinePolicy::Offline
        } else {
            OfflinePolicy::Online
        }
    }

    fn snapshot_sources(&self) -> (bool, Vec<PluginSourceSettings>) {
        let guard = self.state.lock().expect("plugin store state lock poisoned");
        (guard.offline_mode, guard.sources.clone())
    }

    fn build_topic_snapshot(&self) -> PluginsTopicSnapshot {
        let (offline_mode, sources) = self.snapshot_sources();
        let (desired_revision, raw_plugins) = match self.manager.snapshot() {
            Ok(snap) => (snap.desired_revision, snap.plugins),
            Err(err) => {
                tracing::warn!(error = %err, "failed to load plugin registry; publishing empty snapshot");
                (0, Vec::new())
            }
        };

        let mut enabled_count = 0;
        let mut approved_count = 0;
        let mut pending_approval_count = 0;
        let mut revoked_count = 0;
        let plugins: Vec<PublicPluginEntry> = raw_plugins
            .into_iter()
            .map(|summary| {
                if summary.enabled {
                    enabled_count += 1;
                }
                if summary.approved {
                    approved_count += 1;
                } else if !summary.revoked {
                    pending_approval_count += 1;
                }
                if summary.revoked {
                    revoked_count += 1;
                }
                PublicPluginEntry {
                    summary: summary.redacted_for_public(),
                    runtime_state: "unknown",
                }
            })
            .collect();

        let public_sources = sources
            .iter()
            .map(|src| redact_source_for_public(&self.paths, src))
            .collect();

        PluginsTopicSnapshot {
            desired_revision,
            applied_desired_revision: None,
            runtime_overlay_supported: false,
            offline_mode,
            counts: PluginCounts {
                total: plugins.len(),
                enabled: enabled_count,
                approved: approved_count,
                pending_approval: pending_approval_count,
                revoked: revoked_count,
            },
            plugins,
            sources: public_sources,
        }
    }

    fn publish_snapshot(&self, kind: UpdateKind) {
        let snapshot = self.build_topic_snapshot();
        let value = serde_json::to_value(&snapshot).expect("PluginsTopicSnapshot serializes");
        let serialized = value.to_string();
        {
            let mut guard = self.state.lock().expect("plugin store state lock poisoned");
            if matches!(kind, UpdateKind::Live)
                && guard.last_published_signature.as_deref() == Some(serialized.as_str())
            {
                return;
            }
            guard.last_published_signature = Some(serialized);
        }
        self.hub.publish_core_topic(
            TopicName::try_new(topics::PLUGINS).expect("plugins is a valid core topic"),
            value,
            kind,
        );
    }

    fn start_registry_watcher(self: &Arc<Self>, mut stop_rx: watch::Receiver<bool>) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let weak = Arc::downgrade(self);
        let registry_path = self.paths.plugins_registry_file();
        let task = runtime.spawn(async move {
            let mut last_sig = read_file_stamp(&registry_path);
            loop {
                tokio::select! {
                    biased;
                    _ = stop_rx.changed() => break,
                    _ = tokio::time::sleep(REGISTRY_WATCH_INTERVAL) => {
                        let Some(service) = weak.upgrade() else {
                            break;
                        };
                        let current_sig = read_file_stamp(&registry_path);
                        if current_sig != last_sig {
                            last_sig = current_sig;
                            service.publish_snapshot(UpdateKind::Live);
                        }
                    }
                }
            }
        });
        *self
            .watch_task
            .lock()
            .expect("plugin watch task lock poisoned") = Some(task);
    }

    fn register_commands(self: &Arc<Self>) {
        register_cmd(
            &self.hub,
            self,
            "plugins.list",
            "List installed plugins with local paths redacted",
            |svc, _call| async move {
                let manager = Arc::clone(&svc.manager);
                let reg = spawn_plugin_op(move || manager.snapshot()).await?;
                let plugins: Vec<PluginSummary> = reg
                    .plugins
                    .into_iter()
                    .map(|p| p.redacted_for_public())
                    .collect();
                Ok(ok_data(json!({
                    "desired_revision": reg.desired_revision,
                    "applied_desired_revision": Value::Null,
                    "runtime_overlay_supported": false,
                    "plugins": plugins,
                })))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.audit",
            "Check a plugin's pinned digest and capability approval",
            |svc, call| async move {
                let id = extract_plugin_id(&call, "plugins.audit")?;
                let manager = Arc::clone(&svc.manager);
                let (audit, requested_capabilities) = spawn_plugin_op(move || {
                    let audit = manager.audit(&id)?.redacted_for_public();
                    let (_, caps) = manager.plugin_capabilities(&id)?;
                    Ok((audit, caps))
                })
                .await?;
                Ok(ok_data(json!({
                    "plugin": audit.plugin,
                    "diff": audit.diff,
                    "net_added_host_capabilities": audit.net_added_host_capabilities,
                    "current_content_digest": audit.current_content_digest,
                    "digest_matches": audit.digest_matches,
                    "requested_capabilities": requested_capabilities,
                })))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.doctor",
            "Check plugin registry, bundles, and staging health",
            |svc, _call| async move {
                let manager = Arc::clone(&svc.manager);
                let findings = spawn_plugin_op(move || manager.doctor()).await?;
                let redacted: Vec<_> = findings
                    .into_iter()
                    .map(|f| f.redacted_for_public())
                    .collect();
                Ok(ok_data(json!(redacted)))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.catalog.list",
            "List cached plugin catalog entries with pagination (cache-only)",
            |svc, call| async move {
                #[derive(Default, Deserialize)]
                #[serde(default, deny_unknown_fields)]
                struct Params {
                    query: String,
                    category: Option<z_shell_plugins::StoreCategory>,
                    source: Option<String>,
                    offset: usize,
                    limit: Option<usize>,
                }
                let params: Params = parse_payload(&call)?;
                let limit = params
                    .limit
                    .unwrap_or(DEFAULT_CATALOG_PAGE_LIMIT)
                    .clamp(1, MAX_CATALOG_PAGE_LIMIT);
                let (_, sources) = svc.snapshot_sources();
                let sources_for_blobs = sources.clone();
                let catalog = Arc::clone(&svc.catalog);
                let manager = Arc::clone(&svc.manager);
                let (entries, installed) = tokio::task::spawn_blocking(move || {
                    let entries = catalog
                        .search_cached(
                            &sources,
                            &params.query,
                            params.category,
                            params.source.as_deref(),
                        )
                        .map_err(catalog_rpc_error)?;
                    let installed = manager.list().unwrap_or_default();
                    Ok::<_, RpcError>((entries, installed))
                })
                .await
                .map_err(|_| internal_rpc("catalog query did not complete"))??;

                let installed_by_id: HashMap<PluginId, PluginSummary> = installed
                    .into_iter()
                    .map(|p| (p.id.clone(), p.redacted_for_public()))
                    .collect();
                let total = entries.len();
                let mut guard = svc.state.lock().expect("plugin store state lock poisoned");
                let page_items: Vec<Value> = entries
                    .into_iter()
                    .skip(params.offset)
                    .take(limit)
                    .map(|entry| {
                        let inst = installed_by_id.get(&entry.id);
                        let update_available =
                            inst.is_some_and(|s| s.version != entry.latest_version);
                        let preferred = entry
                            .available_sources
                            .iter()
                            .find(|o| o.source_id == entry.preferred_source_id)
                            .or_else(|| entry.available_sources.first());
                        let icon = preferred.and_then(|off| {
                            let src = sources_for_blobs.iter().find(|s| s.id == off.source_id)?;
                            let url = off.plugin.icon_url.as_deref()?;
                            let sha = off.plugin.icon_sha256.as_deref()?;
                            Some(guard.register_preview_blob(src, url, sha))
                        });
                        let has_icon = icon.is_some()
                            || entry
                                .available_sources
                                .iter()
                                .any(|o| o.plugin.icon_url.is_some());
                        let sources: Vec<Value> = entry
                            .available_sources
                            .iter()
                            .map(|o| {
                                json!({
                                    "source_id": o.source_id,
                                    "source_name": o.source_name,
                                    "priority": o.priority,
                                    "latest_version": o.latest_version,
                                    "yanked": o.yanked,
                                    "advisories": o.advisories,
                                })
                            })
                            .collect();
                        json!({
                            "id": entry.id,
                            "preferred_source_id": entry.preferred_source_id,
                            "name": entry.name,
                            "summary": entry.summary,
                            "category": entry.category,
                            "latest_version": entry.latest_version,
                            "icon": icon,
                            "has_icon": has_icon,
                            "update_available": update_available,
                            "installed": inst,
                            "sources": sources,
                        })
                    })
                    .collect();

                Ok(ok_data(json!({
                    "total": total,
                    "offset": params.offset,
                    "limit": limit,
                    "items": page_items,
                })))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.catalog.detail",
            "Return cached catalog detail and provenance-bound preview MediaRefs for one plugin",
            |svc, call| async move {
                let id = extract_plugin_id(&call, "plugins.catalog.detail")?;
                let (_, sources) = svc.snapshot_sources();
                let catalog = Arc::clone(&svc.catalog);
                let manager = Arc::clone(&svc.manager);
                let sources_for_lookup = sources.clone();
                let id_for_lookup = id.clone();
                let (entry, installed, capabilities) = tokio::task::spawn_blocking(move || {
                    let entry = catalog
                        .detail_cached(&sources_for_lookup, &id_for_lookup)
                        .map_err(catalog_rpc_error)?;
                    let installed = manager
                        .list()
                        .ok()
                        .and_then(|list| list.into_iter().find(|p| p.id == id_for_lookup))
                        .map(|p| p.redacted_for_public());
                    let capabilities = manager
                        .plugin_capabilities(&id_for_lookup)
                        .ok()
                        .map(|(_, c)| c);
                    Ok::<_, RpcError>((entry, installed, capabilities))
                })
                .await
                .map_err(|_| internal_rpc("catalog detail query did not complete"))??;

                let mut guard = svc.state.lock().expect("plugin store state lock poisoned");
                let offerings: Vec<Value> = entry
                    .available_sources
                    .iter()
                    .map(|off| {
                        let source_cfg = sources.iter().find(|s| s.id == off.source_id);
                        let icon = match (source_cfg, &off.plugin.icon_url, &off.plugin.icon_sha256)
                        {
                            (Some(src), Some(url), Some(sha)) => {
                                Some(guard.register_preview_blob(src, url, sha))
                            }
                            _ => None,
                        };
                        let screenshots: Vec<Value> = off
                            .plugin
                            .screenshots
                            .iter()
                            .filter_map(|shot| {
                                let src = source_cfg?;
                                let media = guard.register_preview_blob(src, &shot.url, &shot.sha256);
                                Some(json!({
                                    "media": media,
                                    "caption": shot.caption,
                                }))
                            })
                            .collect();
                        let releases: Vec<Value> = off
                            .plugin
                            .releases
                            .iter()
                            .map(|rel| {
                                json!({
                                    "version": rel.version,
                                    "plugin_api": rel.plugin_api,
                                    "shared_runtime_abi": rel.shared_runtime_abi,
                                    "min_shell_version": rel.min_shell_version,
                                    "content_digest": rel.content_digest,
                                    "declared_capabilities_preview": rel.declared_capabilities_preview,
                                })
                            })
                            .collect();
                        json!({
                            "source_id": off.source_id,
                            "source_name": off.source_name,
                            "priority": off.priority,
                            "source_identity": redact_catalog_identity(&off.source_identity),
                            "latest_version": off.latest_version,
                            "yanked": off.yanked,
                            "advisories": off.advisories,
                            "author": off.plugin.author,
                            "summary": off.plugin.summary,
                            "tags": off.plugin.tags,
                            "homepage": off.plugin.homepage,
                            "icon": icon,
                            "screenshots": screenshots,
                            "releases": releases,
                        })
                    })
                    .collect();

                Ok(ok_data(json!({
                    "id": entry.id,
                    "preferred_source_id": entry.preferred_source_id,
                    "name": entry.name,
                    "summary": entry.summary,
                    "category": entry.category,
                    "latest_version": entry.latest_version,
                    "installed": installed,
                    "installed_capabilities": capabilities,
                    "offerings": offerings,
                })))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.sources.list",
            "List configured plugin catalog sources (privileged host only)",
            |svc, call| async move {
                require_host(&call, "plugins.sources.list")?;
                let (offline_mode, sources) = svc.snapshot_sources();
                let list: Vec<Value> = sources
                    .iter()
                    .map(|src| {
                        let (cache_path, _) = catalog_cache_paths(&svc.paths, src);
                        json!({
                            "source": src,
                            "cached": cache_path.is_file(),
                        })
                    })
                    .collect();
                Ok(ok_data(json!({
                    "offline_mode": offline_mode,
                    "sources": list,
                })))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.catalog.refresh",
            "Refresh configured plugin catalog sources (privileged host only)",
            |svc, call| async move {
                require_host(&call, "plugins.catalog.refresh")?;
                #[derive(Default, Deserialize)]
                #[serde(default, deny_unknown_fields)]
                struct Params {
                    source_id: Option<String>,
                }
                let params: Params = parse_payload(&call)?;
                let (offline_mode, mut sources) = svc.snapshot_sources();
                if let Some(ref target_id) = params.source_id {
                    sources.retain(|s| &s.id == target_id);
                    if sources.is_empty() {
                        return Err(RpcError::new(
                            ErrorCode::NotFound,
                            format!("catalog source {target_id:?} not found"),
                        ));
                    }
                }
                let policy = if offline_mode {
                    OfflinePolicy::Offline
                } else {
                    OfflinePolicy::Online
                };
                let catalog = Arc::clone(&svc.catalog);
                let cancel = Arc::clone(&svc.cancel);
                let results = tokio::task::spawn_blocking(move || {
                    catalog
                        .refresh_with_cancel(&sources, policy, Some(&cancel))
                        .map_err(catalog_rpc_error)
                })
                .await
                .map_err(|_| internal_rpc("catalog refresh did not complete"))??;
                svc.publish_snapshot(UpdateKind::Live);
                Ok(ok_data(json!({ "results": results })))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.catalog.fetch-blob",
            "Fetch bounded <=200KB PNG bytes for a catalog preview token (privileged host only)",
            |svc, call| async move {
                require_host(&call, "plugins.catalog.fetch-blob")?;
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Params {
                    token: String,
                }
                let params: Params = parse_payload(&call)?;
                let asset_ref = svc
                    .state
                    .lock()
                    .expect("plugin store state lock poisoned")
                    .preview_blobs
                    .get(&params.token)
                    .cloned()
                    .ok_or_else(|| {
                        RpcError::new(
                            ErrorCode::NotFound,
                            "catalog preview token is unknown or expired",
                        )
                    })?;

                let paths = svc.paths.clone();
                let policy = svc.offline_policy();
                let cancel = Arc::clone(&svc.cancel);
                let png = tokio::task::spawn_blocking(move || {
                    catalog_media::load_or_fetch_preview_png(
                        &paths,
                        &asset_ref.source,
                        &asset_ref.asset_url,
                        &asset_ref.sha256,
                        policy,
                        Some(&cancel),
                    )
                    .map_err(media_rpc_error)
                })
                .await
                .map_err(|_| internal_rpc("preview fetch did not complete"))??;

                Ok(ok_data(json!({
                    "mime": "image/png",
                    "byte_len": png.len(),
                    "bytes": png,
                })))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.stage-install",
            "Stage a catalog, path, git, or archive plugin install for review (privileged host only)",
            |svc, call| async move {
                require_host(&call, "plugins.stage-install")?;
                #[derive(Deserialize)]
                #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
                enum Params {
                    Catalog {
                        id: PluginId,
                        version: Option<String>,
                        source_id: Option<String>,
                    },
                    Path {
                        path: String,
                    },
                    Git {
                        url: String,
                        ref_name: Option<String>,
                        subdir: Option<String>,
                    },
                    Archive {
                        url: String,
                        sha256: String,
                    },
                }
                let params: Params = parse_payload(&call)?;
                let (offline_mode, sources) = svc.snapshot_sources();
                let policy = if offline_mode {
                    OfflinePolicy::Offline
                } else {
                    OfflinePolicy::Online
                };
                let manager = Arc::clone(&svc.manager);
                let catalog = Arc::clone(&svc.catalog);
                let staged = spawn_plugin_op(move || match params {
                    Params::Catalog {
                        id,
                        version,
                        source_id,
                    } => {
                        let resolved = catalog.resolve_install(
                            &sources,
                            &id,
                            version.as_deref(),
                            source_id.as_deref(),
                            policy,
                        )?;
                        manager.stage_install_from_catalog(&resolved, policy)
                    }
                    Params::Path { path } => manager.stage_install_path(path),
                    Params::Git {
                        url,
                        ref_name,
                        subdir,
                    } => manager.stage_install_git(
                        &url,
                        ref_name.as_deref().unwrap_or("HEAD"),
                        subdir.as_deref(),
                        policy,
                    ),
                    Params::Archive { url, sha256 } => {
                        manager.stage_install_archive(&url, &sha256, policy)
                    }
                })
                .await?;

                let stage_token = svc
                    .state
                    .lock()
                    .expect("plugin store state lock poisoned")
                    .insert_staged_install(staged.clone());
                Ok(ok_data(json!({
                    "stage_token": stage_token,
                    "staged": staged,
                })))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.commit-install",
            "Atomically commit a staged install under flock (privileged host only)",
            |svc, call| async move {
                require_host(&call, "plugins.commit-install")?;
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Params {
                    stage_token: String,
                    expected_source_identity: String,
                    expected_content_digest: String,
                    expected_capabilities: CapabilityBundle,
                    #[serde(default)]
                    approve_on_commit: bool,
                }
                let params: Params = parse_payload(&call)?;
                let staged = svc
                    .state
                    .lock()
                    .expect("plugin store state lock poisoned")
                    .staged_installs
                    .remove(&params.stage_token)
                    .ok_or_else(|| {
                        RpcError::new(ErrorCode::NotFound, "staged install token not found")
                    })?;
                let manager = Arc::clone(&svc.manager);
                let outcome = spawn_plugin_op(move || {
                    manager.commit_install(
                        &staged,
                        &params.expected_source_identity,
                        &params.expected_content_digest,
                        &params.expected_capabilities,
                        params.approve_on_commit,
                    )
                })
                .await?;
                svc.publish_snapshot(UpdateKind::Live);
                Ok(ok_data(json!({
                    "summary": outcome.summary.redacted_for_public(),
                    "resolved_from": outcome.resolved_from,
                })))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.stage-upgrade",
            "Stage a catalog upgrade for capability review (privileged host only)",
            |svc, call| async move {
                require_host(&call, "plugins.stage-upgrade")?;
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Params {
                    id: PluginId,
                    version: Option<String>,
                    source_id: Option<String>,
                }
                let params: Params = parse_payload(&call)?;
                let (offline_mode, sources) = svc.snapshot_sources();
                let policy = if offline_mode {
                    OfflinePolicy::Offline
                } else {
                    OfflinePolicy::Online
                };
                let manager = Arc::clone(&svc.manager);
                let catalog = Arc::clone(&svc.catalog);
                let staged = spawn_plugin_op(move || {
                    let resolved = catalog.resolve_install(
                        &sources,
                        &params.id,
                        params.version.as_deref(),
                        params.source_id.as_deref(),
                        policy,
                    )?;
                    manager.stage_upgrade(&params.id, &resolved, policy)
                })
                .await?;

                let requested_capabilities = staged.requested_capabilities().clone();
                let stage_token = svc
                    .state
                    .lock()
                    .expect("plugin store state lock poisoned")
                    .insert_staged_upgrade(staged.clone());
                Ok(ok_data(json!({
                    "stage_token": stage_token,
                    "staged": staged,
                    "requested_capabilities": requested_capabilities,
                })))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.commit-upgrade",
            "Atomically commit a staged upgrade under flock (privileged host only)",
            |svc, call| async move {
                require_host(&call, "plugins.commit-upgrade")?;
                #[derive(Deserialize)]
                #[serde(rename_all = "snake_case")]
                enum Mode {
                    KeepExistingOnly,
                    ApproveExpanded,
                }
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Params {
                    stage_token: String,
                    expected_from_digest: String,
                    expected_to_digest: String,
                    expected_capabilities: CapabilityBundle,
                    approval_mode: Mode,
                    #[serde(default)]
                    allow_unrevoke: bool,
                }
                let params: Params = parse_payload(&call)?;
                let staged = svc
                    .state
                    .lock()
                    .expect("plugin store state lock poisoned")
                    .staged_upgrades
                    .remove(&params.stage_token)
                    .ok_or_else(|| {
                        RpcError::new(ErrorCode::NotFound, "staged upgrade token not found")
                    })?;
                let mode = match params.approval_mode {
                    Mode::KeepExistingOnly => UpgradeApprovalMode::KeepExistingOnly,
                    Mode::ApproveExpanded => UpgradeApprovalMode::ApproveExpanded,
                };
                let manager = Arc::clone(&svc.manager);
                let summary = spawn_plugin_op(move || {
                    manager.commit_upgrade_reviewed(
                        &staged,
                        &params.expected_from_digest,
                        &params.expected_to_digest,
                        &params.expected_capabilities,
                        mode,
                        params.allow_unrevoke,
                    )
                })
                .await?;
                svc.publish_snapshot(UpdateKind::Live);
                Ok(ok_data(json!(summary.redacted_for_public())))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.approve",
            "Grant reviewed capability approval bound to source and digest (privileged host only)",
            |svc, call| async move {
                require_host(&call, "plugins.approve")?;
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Params {
                    id: PluginId,
                    expected_source_identity: String,
                    expected_content_digest: String,
                    expected_capabilities: CapabilityBundle,
                    #[serde(default)]
                    allow_unrevoke: bool,
                }
                let params: Params = parse_payload(&call)?;
                let manager = Arc::clone(&svc.manager);
                let summary = spawn_plugin_op(move || {
                    manager.approve_reviewed(
                        &params.id,
                        &params.expected_source_identity,
                        &params.expected_content_digest,
                        &params.expected_capabilities,
                        params.allow_unrevoke,
                    )
                })
                .await?;
                svc.publish_snapshot(UpdateKind::Live);
                Ok(ok_data(json!(summary.redacted_for_public())))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.enable",
            "Enable an approved plugin in desired registry state (privileged host only)",
            |svc, call| async move {
                require_host(&call, "plugins.enable")?;
                let id = extract_plugin_id(&call, "plugins.enable")?;
                let manager = Arc::clone(&svc.manager);
                let summary = spawn_plugin_op(move || manager.enable(&id)).await?;
                svc.publish_snapshot(UpdateKind::Live);
                Ok(ok_data(json!(summary.redacted_for_public())))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.disable",
            "Disable a plugin in desired registry state (privileged host only)",
            |svc, call| async move {
                require_host(&call, "plugins.disable")?;
                let id = extract_plugin_id(&call, "plugins.disable")?;
                let manager = Arc::clone(&svc.manager);
                let summary = spawn_plugin_op(move || manager.disable(&id)).await?;
                svc.publish_snapshot(UpdateKind::Live);
                Ok(ok_data(json!(summary.redacted_for_public())))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.revoke",
            "Revoke plugin approval and disable it (privileged host only)",
            |svc, call| async move {
                require_host(&call, "plugins.revoke")?;
                let id = extract_plugin_id(&call, "plugins.revoke")?;
                let manager = Arc::clone(&svc.manager);
                let summary = spawn_plugin_op(move || manager.revoke(&id)).await?;
                svc.publish_snapshot(UpdateKind::Live);
                Ok(ok_data(json!(summary.redacted_for_public())))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.sync",
            "Re-sync a plugin from its bound source (privileged host only)",
            |svc, call| async move {
                require_host(&call, "plugins.sync")?;
                let id = extract_plugin_id(&call, "plugins.sync")?;
                let policy = svc.offline_policy();
                let manager = Arc::clone(&svc.manager);
                let summary = spawn_plugin_op(move || manager.sync(&id, policy)).await?;
                svc.publish_snapshot(UpdateKind::Live);
                Ok(ok_data(json!(summary.redacted_for_public())))
            },
        );

        register_cmd(
            &self.hub,
            self,
            "plugins.remove",
            "Uninstall a plugin from desired registry state (privileged host only)",
            |svc, call| async move {
                require_host(&call, "plugins.remove")?;
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Params {
                    id: PluginId,
                    #[serde(default)]
                    purge_settings: bool,
                }
                let params: Params = parse_payload(&call)?;
                let policy = if params.purge_settings {
                    RemoveSettingsPolicy::PurgeSettings
                } else {
                    RemoveSettingsPolicy::KeepSettings
                };
                let manager = Arc::clone(&svc.manager);
                let removed = spawn_plugin_op(move || manager.remove(&params.id, policy)).await?;
                svc.publish_snapshot(UpdateKind::Live);
                Ok(ok_data(json!(removed)))
            },
        );
    }
}

impl Drop for PluginService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn register_cmd<F, Fut>(
    hub: &BusHub,
    service: &Arc<PluginService>,
    name: &str,
    description: &str,
    handler: F,
) where
    F: Fn(Arc<PluginService>, CommandCall) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<CommandInvokeResult, RpcError>> + Send + 'static,
{
    let weak = Arc::downgrade(service);
    let wrapped: CommandHandler = Arc::new(move |call| {
        let weak = weak.clone();
        let fut = weak.upgrade().map(|svc| handler(svc, call));
        Box::pin(async move {
            let svc = fut.ok_or_else(|| internal_rpc("plugin service is shut down"))?;
            svc.await
        })
    });
    hub.register_core_command(
        CommandName::try_new(name).expect("hardcoded plugin command name is valid"),
        description,
        wrapped,
    );
}

async fn spawn_plugin_op<T: Send + 'static>(
    op: impl FnOnce() -> Result<T, PluginError> + Send + 'static,
) -> Result<T, RpcError> {
    let result = tokio::task::spawn_blocking(op)
        .await
        .map_err(|_| internal_rpc("plugin operation did not complete"))?;
    result.map_err(plugin_rpc_error)
}

fn require_host(call: &CommandCall, action: &str) -> Result<(), RpcError> {
    if call.caller.role != ClientRole::PrivilegedHost {
        return Err(RpcError::new(
            ErrorCode::PermissionDenied,
            format!("{action} requires the privileged host control channel"),
        ));
    }
    Ok(())
}

fn parse_payload<T: serde::de::DeserializeOwned>(call: &CommandCall) -> Result<T, RpcError> {
    serde_json::from_value(call.params.payload.clone().unwrap_or_else(|| json!({}))).map_err(|e| {
        RpcError::new(
            ErrorCode::InvalidParams,
            format!("invalid plugin command parameters: {e}"),
        )
    })
}

fn extract_plugin_id(call: &CommandCall, action: &str) -> Result<PluginId, RpcError> {
    let raw_id = match (call.params.args.as_slice(), call.params.payload.as_ref()) {
        ([id], None) => Some(id.as_str()),
        ([], Some(payload)) => payload.get("id").and_then(Value::as_str),
        _ => None,
    }
    .ok_or_else(|| {
        RpcError::new(
            ErrorCode::InvalidParams,
            format!("{action} requires one plugin id argument or payload.id"),
        )
    })?;
    raw_id
        .parse()
        .map_err(|_| RpcError::new(ErrorCode::InvalidParams, "invalid plugin id"))
}

fn ok_data(data: Value) -> CommandInvokeResult {
    CommandInvokeResult {
        message: None,
        data: Some(data),
    }
}

fn internal_rpc(msg: &str) -> RpcError {
    RpcError::new(ErrorCode::Internal, msg)
}

fn plugin_rpc_error(err: PluginError) -> RpcError {
    match err {
        PluginError::NotFound(_) | PluginError::Catalog(CatalogError::PluginNotFound(_)) => {
            RpcError::new(ErrorCode::NotFound, err.to_string())
        }
        PluginError::OfflineModeBlocked | PluginError::Catalog(CatalogError::OfflineNoCache(_)) => {
            RpcError::new(ErrorCode::Disabled, err.to_string())
        }
        PluginError::AlreadyInstalled(_)
        | PluginError::SourceConflict { .. }
        | PluginError::ToctouMismatch
        | PluginError::Revoked(_)
        | PluginError::ApprovalRequired(_)
        | PluginError::CapabilityExpansionRequiresApproval(_)
        | PluginError::DigestDrift(_)
        | PluginError::CatalogDigestMismatch { .. }
        | PluginError::IdChanged { .. }
        | PluginError::Manifest(_)
        | PluginError::Compatibility(_) => RpcError::new(ErrorCode::InvalidParams, err.to_string()),
        PluginError::Catalog(cat_err) => catalog_rpc_error(cat_err),
        other => {
            tracing::warn!(%other, "plugin command failed");
            RpcError::new(ErrorCode::Internal, other.to_string())
        }
    }
}

fn catalog_rpc_error(err: CatalogError) -> RpcError {
    match err {
        CatalogError::PluginNotFound(_)
        | CatalogError::VersionNotFound { .. }
        | CatalogError::SourceNotFound(_) => RpcError::new(ErrorCode::NotFound, err.to_string()),
        CatalogError::OfflineNoCache(_) => RpcError::new(ErrorCode::Disabled, err.to_string()),
        CatalogError::Fetch { ref reason, .. } if reason.contains("cancelled") => {
            RpcError::new(ErrorCode::Disabled, err.to_string())
        }
        CatalogError::AmbiguousPluginSource { .. } | CatalogError::InvalidIndex { .. } => {
            RpcError::new(ErrorCode::InvalidParams, err.to_string())
        }
        other => RpcError::new(ErrorCode::Internal, other.to_string()),
    }
}

fn media_rpc_error(err: CatalogMediaError) -> RpcError {
    match err {
        CatalogMediaError::OfflineBlocked | CatalogMediaError::Cancelled => {
            RpcError::new(ErrorCode::Disabled, err.to_string())
        }
        CatalogMediaError::InvalidInput(_)
        | CatalogMediaError::PathEscapesRoot(_)
        | CatalogMediaError::DigestMismatch { .. }
        | CatalogMediaError::UnsupportedImage(_)
        | CatalogMediaError::ExceedsByteBudget { .. } => {
            RpcError::new(ErrorCode::InvalidParams, err.to_string())
        }
        other => RpcError::new(ErrorCode::Internal, other.to_string()),
    }
}

fn redact_source_for_public(paths: &ShellPaths, src: &PluginSourceSettings) -> PublicCatalogSource {
    let url = if src.kind == PluginSourceKind::LocalFile || src.url.starts_with('/') {
        let hash = format!("{:x}", Sha256::digest(src.url.as_bytes()));
        format!("local:sha256:{hash}")
    } else {
        src.url.clone()
    };
    let (cache_path, _) = catalog_cache_paths(paths, src);
    PublicCatalogSource {
        id: src.id.clone(),
        name: src.name.clone(),
        kind: src.kind,
        url,
        enabled: src.enabled,
        priority: src.priority,
        has_local_seed: src.local_seed_dir.is_some(),
        cached: cache_path.is_file(),
    }
}

fn redact_catalog_identity(identity: &str) -> String {
    if let Some(rest) = identity.strip_prefix("catalog:")
        && let Some((src_id, tail)) = rest.split_once('|')
        && tail.starts_with('/')
    {
        let hash = format!("{:x}", Sha256::digest(tail.as_bytes()));
        return format!("catalog:{src_id}|local:sha256:{hash}|");
    }
    identity.to_owned()
}

#[derive(PartialEq, Eq)]
struct FileStamp {
    len: u64,
    ino: u64,
    modified_ns: u128,
}

fn read_file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = fs::metadata(path).ok()?;
    let modified_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    Some(FileStamp {
        len: meta.len(),
        ino: meta.ino(),
        modified_ns,
    })
}
