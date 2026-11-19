//! Committed wallpaper assignments, picker commands, and lock-aware rotation.

use crate::WALLPAPER_TOPIC;
use crate::cache::{Cache, CachedImage, ImageError, StageError};
use crate::catalog::{self, CatalogEntry};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;
use thiserror::Error;
use tokio::runtime::Handle;
use tokio::sync::{Mutex as AsyncMutex, watch};
use tokio::task::{JoinError, spawn_blocking};
use z_shell_bus::{BusHub, CommandHandler, UpdateKind};
use z_shell_config::{ConfigStore, RuntimeState, WallpaperFit, WallpaperSettings};
use z_shell_protocol::{
    ClientRole, CommandInvokeResult, CommandName, ErrorCode, MediaRef, RpcError, TopicName,
};

/// Whether public wallpaper mutations and the slideshow are blocked by the session lock.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum WallpaperLockState {
    /// Public commands and automatic rotation are allowed.
    #[default]
    Unlocked,
    /// Only read-only public commands are allowed; automatic rotation is paused.
    Locked,
}

/// Whether system sleep currently holds the slideshow paused.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum WallpaperSleepState {
    /// The slideshow can rotate unless session lock also prevents it.
    #[default]
    Awake,
    /// The slideshow is paused.
    Sleeping,
}

/// One assigned image with its confined runtime media token and effective fit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ActiveWallpaper {
    /// Canonical original file used for durable restoration.
    pub source_path: PathBuf,
    /// Content-addressed copy in the daemon media directory.
    pub media: MediaRef,
    /// Natural width in pixels.
    pub width: u32,
    /// Natural height in pixels.
    pub height: u32,
    /// Scaling strategy for this assignment.
    pub fit: WallpaperFit,
}

/// Current wallpaper assignments and picker status published on `wallpaper`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct WallpaperSnapshot {
    /// Whether initial discovery and restoration have completed.
    pub available: bool,
    /// Default fit for assignments without an explicit override.
    pub fit: WallpaperFit,
    /// Whether global image changes may drive the theme engine.
    pub sync_theme: bool,
    /// Rotation interval in seconds, or zero when disabled.
    pub slideshow_seconds: u32,
    /// Total number of picker entries before pagination.
    pub catalog_count: usize,
    /// Global fallback image, if one has been assigned.
    pub current: Option<ActiveWallpaper>,
    /// Overrides keyed by stable output/connector name.
    pub per_output: BTreeMap<String, ActiveWallpaper>,
    /// Most recent non-fatal initialization or background error.
    pub last_error: Option<String>,
}

/// A wallpaper settings update could not complete on the blocking worker.
#[derive(Debug, Error)]
#[error("wallpaper worker failed: {0}")]
pub struct WallpaperError(#[from] JoinError);

/// Owns wallpaper catalog, durable assignments, and optional slideshow for one daemon.
pub struct WallpaperService {
    inner: Arc<Inner>,
}

impl fmt::Debug for WallpaperService {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WallpaperService")
            .field("snapshot", &self.snapshot())
            .finish_non_exhaustive()
    }
}

struct Inner {
    store: ConfigStore,
    cache: Cache,
    // Scans and mutations run on blocking workers. Serialize them without making readers or
    // synchronous lock/sleep guards wait for image decoding or disk persistence.
    operation: Mutex<()>,
    live: Mutex<Live>,
    schedule: watch::Sender<Schedule>,
    timer_started: AtomicBool,
    hub: OnceLock<BusHub>,
    shared_state: Option<Arc<AsyncMutex<RuntimeState>>>,
    theme_sync: Option<Box<dyn Fn(PathBuf) + Send + Sync>>,
}

struct Live {
    settings: WallpaperSettings,
    catalog: Vec<CatalogEntry>,
    current: Option<Assignment>,
    per_output: BTreeMap<String, Assignment>,
    last_error: Option<String>,
}

impl Live {
    fn snapshot(&self) -> WallpaperSnapshot {
        let snapshot = |assignment: &Assignment| ActiveWallpaper {
            source_path: assignment.source_path.clone(),
            media: assignment.cached.media.clone(),
            width: assignment.cached.width,
            height: assignment.cached.height,
            fit: assignment.fit.unwrap_or(self.settings.fit),
        };
        WallpaperSnapshot {
            available: true,
            fit: self.settings.fit,
            sync_theme: self.settings.sync_theme,
            slideshow_seconds: self.settings.slideshow_seconds,
            catalog_count: self.catalog.len(),
            current: self.current.as_ref().map(snapshot),
            per_output: self
                .per_output
                .iter()
                .map(|(output, value)| (output.clone(), snapshot(value)))
                .collect(),
            last_error: self.last_error.clone(),
        }
    }
}

struct Assignment {
    source_path: PathBuf,
    cached: CachedImage,
    fit: Option<WallpaperFit>,
    _lease: File,
}

impl Assignment {
    fn stage(cache: &Cache, path: &Path, fit: Option<WallpaperFit>) -> Result<Self, StageError> {
        let source_path = cache.resolve_source(path)?;
        let (cached, lease) = cache.stage(&source_path)?;
        Ok(Self {
            source_path,
            cached,
            fit,
            _lease: lease,
        })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Schedule {
    seconds: u32,
    lock: WallpaperLockState,
    sleep: WallpaperSleepState,
    generation: u64,
}

impl Schedule {
    fn delay(self) -> Option<Duration> {
        (self.seconds != 0
            && self.lock == WallpaperLockState::Unlocked
            && self.sleep == WallpaperSleepState::Awake)
            .then(|| Duration::from_secs(u64::from(self.seconds)))
    }
}

impl WallpaperService {
    /// Scans configured directories and stages saved assignments without publishing to the bus.
    ///
    /// Bad persisted paths are skipped and reported in the snapshot; durable state is not changed.
    #[must_use]
    pub fn new(store: ConfigStore, settings: &WallpaperSettings, restored: &RuntimeState) -> Self {
        let cache = Cache::new(&store.paths().media_dir());
        let mut last_error = None;
        let catalog = catalog::scan(&settings.directories, &cache).unwrap_or_else(|error| {
            last_error = Some(error.to_string());
            Vec::new()
        });
        let mut restore = |path: &Path| match Assignment::stage(&cache, path, None) {
            Ok(assignment) => Some(assignment),
            Err(error) => {
                last_error = Some(format!(
                    "could not restore wallpaper {}: {error}",
                    path.display()
                ));
                None
            }
        };
        let current = restored.last_wallpaper.as_deref().and_then(&mut restore);
        let per_output = restored
            .output_wallpapers
            .iter()
            .filter_map(|(output, path)| {
                restore(path).map(|assignment| (output.clone(), assignment))
            })
            .collect();
        if let Err(error) = cache.collect() {
            last_error.get_or_insert_with(|| error.to_string());
        }
        let (schedule, _) = watch::channel(Schedule {
            seconds: settings.slideshow_seconds,
            ..Schedule::default()
        });
        Self {
            inner: Arc::new(Inner {
                store,
                cache,
                operation: Mutex::new(()),
                live: Mutex::new(Live {
                    settings: settings.clone(),
                    catalog,
                    current,
                    per_output,
                    last_error,
                }),
                schedule,
                timer_started: AtomicBool::new(false),
                hub: OnceLock::new(),
                shared_state: None,
                theme_sync: None,
            }),
        }
    }

    /// Shares the daemon's serialized durable state mirror, including publication order.
    ///
    /// # Panics
    ///
    /// Call before [`Self::install_on_bus`].
    #[must_use]
    pub fn with_shared_state(mut self, state: Arc<AsyncMutex<RuntimeState>>) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("configure wallpaper before installing its commands")
            .shared_state = Some(state);
        self
    }

    /// Installs a prompt callback receiving the canonical path of each new global image.
    ///
    /// Runs only with theme linkage enabled, including restoration on bus installation. The
    /// callback must not reenter wallpaper mutations. Clearing leaves the last good theme intact.
    ///
    /// # Panics
    ///
    /// Call before [`Self::install_on_bus`].
    #[must_use]
    pub fn with_theme_sync(mut self, callback: impl Fn(PathBuf) + Send + Sync + 'static) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("configure wallpaper before installing its commands")
            .theme_sync = Some(Box::new(callback));
        self
    }

    /// Publishes the startup source baseline, registers commands, and arms automatic rotation.
    pub fn install_on_bus(&self, hub: &BusHub) {
        if self.inner.hub.set(hub.clone()).is_err() {
            return;
        }
        let snapshot = self.snapshot();
        self.inner.publish(&snapshot, UpdateKind::SourceBaseline);
        if snapshot.sync_theme
            && let Some(current) = snapshot.current
        {
            self.inner.sync_theme(current.source_path);
        }
        for (name, description, command) in COMMANDS {
            let weak = Arc::downgrade(&self.inner);
            let handler: CommandHandler = Arc::new(move |call| {
                let weak = weak.clone();
                Box::pin(async move {
                    let inner = weak.upgrade().ok_or_else(|| {
                        RpcError::new(ErrorCode::Internal, "wallpaper service is shut down")
                    })?;
                    let data = if matches!(command, Command::List) {
                        inner.list(parse(call.params.payload)?)
                    } else {
                        let origin = Origin::Client(call.caller.role);
                        inner.authorize(origin)?;
                        let payload = call.params.payload;
                        spawn_blocking(move || inner.execute(command, origin, payload))
                            .await
                            .map_err(internal)??
                    };
                    Ok(CommandInvokeResult {
                        message: None,
                        data: Some(data),
                    })
                })
            });
            hub.register_core_command(
                CommandName::try_new(name).expect("static wallpaper command name is valid"),
                description,
                handler,
            );
        }
        self.inner.start_timer();
    }

    /// Returns the currently committed wallpaper view.
    #[must_use]
    pub fn snapshot(&self) -> WallpaperSnapshot {
        self.inner.live().snapshot()
    }

    /// Applies the session lock gate before public access and automatic rotation.
    pub fn set_locked(&self, state: WallpaperLockState) {
        self.inner.change_schedule(|schedule| schedule.lock = state);
    }

    /// Pauses automatic rotation during sleep independently of the session lock gate.
    pub fn set_sleeping(&self, state: WallpaperSleepState) {
        self.inner
            .change_schedule(|schedule| schedule.sleep = state);
    }

    /// Applies new defaults, rescans changed directories, and re-arms a changed interval.
    ///
    /// # Errors
    ///
    /// Returns an error if the worker cannot complete; scan errors are reported on the topic.
    pub async fn apply_settings(&self, settings: &WallpaperSettings) -> Result<(), WallpaperError> {
        let inner = Arc::clone(&self.inner);
        let settings = settings.clone();
        spawn_blocking(move || inner.apply_settings(settings)).await?;
        self.inner.start_timer();
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum Command {
    List,
    Set,
    Clear,
    Cycle(Cycle),
    Rescan,
}

#[derive(Clone, Copy)]
enum Cycle {
    Next,
    Previous,
    Random,
}

const COMMANDS: [(&str, &str, Command); 7] = [
    (
        "wallpaper.list",
        "List paginated wallpaper picker entries",
        Command::List,
    ),
    (
        "wallpaper.set",
        "Assign a global or per-output wallpaper",
        Command::Set,
    ),
    (
        "wallpaper.clear",
        "Clear a global or per-output assignment",
        Command::Clear,
    ),
    (
        "wallpaper.next",
        "Advance to the next wallpaper",
        Command::Cycle(Cycle::Next),
    ),
    (
        "wallpaper.previous",
        "Return to the previous wallpaper",
        Command::Cycle(Cycle::Previous),
    ),
    (
        "wallpaper.random",
        "Choose a different wallpaper from the catalog",
        Command::Cycle(Cycle::Random),
    ),
    (
        "wallpaper.rescan",
        "Rescan configured wallpaper directories",
        Command::Rescan,
    ),
];

#[derive(Clone, Copy)]
enum Origin {
    Client(ClientRole),
    Timer(Schedule),
}

impl Inner {
    fn live(&self) -> MutexGuard<'_, Live> {
        self.live
            .lock()
            .expect("wallpaper live state mutex poisoned")
    }

    fn operation(&self) -> MutexGuard<'_, ()> {
        self.operation
            .lock()
            .expect("wallpaper operation mutex poisoned")
    }

    fn publish(&self, snapshot: &WallpaperSnapshot, kind: UpdateKind) {
        if let Some(hub) = self.hub.get() {
            hub.publish_core_topic(topic(WALLPAPER_TOPIC), json!(snapshot), kind);
        }
    }

    fn sync_theme(&self, path: PathBuf) {
        if let Some(callback) = &self.theme_sync {
            callback(path);
        }
    }

    fn list(&self, ListParams { offset, limit }: ListParams) -> Value {
        let live = self.live();
        let total = live.catalog.len();
        let start = offset.unwrap_or_default().min(total);
        let end = start.saturating_add(limit.unwrap_or(total)).min(total);
        json!({ "items": &live.catalog[start..end], "total": total })
    }

    fn execute(
        &self,
        command: Command,
        origin: Origin,
        payload: Option<Value>,
    ) -> Result<Value, RpcError> {
        let _operation = self.operation();
        self.authorize(origin)?;
        let snapshot = match command {
            Command::List => return Ok(self.list(parse(payload)?)),
            Command::Set => {
                let SetParams { path, output, fit } = parse(payload)?;
                let candidate = self.stage(&path, fit)?;
                self.commit(origin, output, Some(candidate))?
            }
            Command::Clear => self.commit(origin, parse::<OutputParams>(payload)?.output, None)?,
            Command::Cycle(direction) => {
                self.cycle(origin, parse::<OutputParams>(payload)?.output, direction)?
            }
            Command::Rescan => {
                let _: EmptyParams = parse(payload)?;
                self.rescan(origin)?
            }
        };
        Ok(json!(snapshot))
    }

    fn apply_settings(&self, settings: WallpaperSettings) {
        let _operation = self.operation();
        let scan = (self.live().settings.directories != settings.directories)
            .then(|| catalog::scan(&settings.directories, &self.cache));
        self.change_schedule(|schedule| schedule.seconds = settings.slideshow_seconds);
        let snapshot = {
            let mut live = self.live();
            if live.settings == settings {
                return;
            }
            live.settings = settings;
            match scan {
                Some(Ok(catalog)) => {
                    live.catalog = catalog;
                    live.last_error = None;
                }
                Some(Err(error)) => {
                    live.catalog.clear();
                    live.last_error = Some(error.to_string());
                }
                None => {}
            }
            live.snapshot()
        };
        self.publish(&snapshot, UpdateKind::Live);
    }

    fn rescan(&self, origin: Origin) -> Result<WallpaperSnapshot, RpcError> {
        let directories = self.live().settings.directories.clone();
        let catalog = catalog::scan(&directories, &self.cache).map_err(internal)?;
        self.authorize(origin)?;
        let snapshot = {
            let mut live = self.live();
            live.catalog = catalog;
            live.last_error = None;
            live.snapshot()
        };
        self.publish(&snapshot, UpdateKind::Live);
        Ok(snapshot)
    }

    fn cycle(
        &self,
        origin: Origin,
        output: Option<String>,
        direction: Cycle,
    ) -> Result<WallpaperSnapshot, RpcError> {
        let path = {
            let live = self.live();
            let current = output
                .as_ref()
                .and_then(|output| live.per_output.get(output))
                .or(live.current.as_ref());
            let index = current.and_then(|assignment| {
                live.catalog
                    .iter()
                    .position(|entry| entry.source_path == assignment.source_path)
            });
            let count = live.catalog.len();
            if count == 0 {
                return Err(RpcError::new(
                    ErrorCode::NotFound,
                    "wallpaper catalog is empty",
                ));
            }
            let next = match direction {
                Cycle::Next => index.map_or(0, |i| (i + 1) % count),
                Cycle::Previous => index.filter(|i| *i != 0).map_or(count - 1, |i| i - 1),
                Cycle::Random => {
                    let excluded = index.filter(|_| count > 1);
                    let choice = random_index(count - usize::from(excluded.is_some()))?;
                    choice + usize::from(excluded.is_some_and(|old| choice >= old))
                }
            };
            live.catalog[next].source_path.clone()
        };
        let candidate = self.stage(&path, None)?;
        self.commit(origin, output, Some(candidate))
    }

    fn stage(&self, path: &Path, fit: Option<WallpaperFit>) -> Result<Assignment, RpcError> {
        Assignment::stage(&self.cache, path, fit).map_err(|error| {
            let code = match &error {
                StageError::Image(ImageError::Read(source))
                    if source.kind() == io::ErrorKind::NotFound =>
                {
                    ErrorCode::NotFound
                }
                StageError::Image(_) => ErrorCode::InvalidParams,
                StageError::Cache(_) => ErrorCode::Internal,
            };
            RpcError::new(code, format!("wallpaper {}: {error}", path.display()))
        })
    }

    fn authorize(&self, origin: Origin) -> Result<(), RpcError> {
        let active = *self.schedule.borrow();
        match origin {
            Origin::Client(role)
                if role != ClientRole::PrivilegedHost
                    && active.lock == WallpaperLockState::Locked =>
            {
                Err(RpcError::new(
                    ErrorCode::PermissionDenied,
                    "wallpaper mutations are disabled while locked",
                ))
            }
            Origin::Timer(scheduled) if active != scheduled || active.delay().is_none() => {
                Err(RpcError::new(
                    ErrorCode::PermissionDenied,
                    "wallpaper slideshow schedule changed",
                ))
            }
            _ => Ok(()),
        }
    }

    fn commit(
        &self,
        origin: Origin,
        output: Option<String>,
        assignment: Option<Assignment>,
    ) -> Result<WallpaperSnapshot, RpcError> {
        let result = self.persist_and_publish(origin, output, assignment);
        if let Err(error) = self.cache.collect() {
            tracing::warn!(%error, "could not collect stale active wallpapers");
        }
        result
    }

    fn persist_and_publish(
        &self,
        origin: Origin,
        output: Option<String>,
        assignment: Option<Assignment>,
    ) -> Result<WallpaperSnapshot, RpcError> {
        if output
            .as_ref()
            .is_some_and(|name| name.trim().is_empty() || name.chars().any(char::is_control))
        {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                "output must be a non-empty connector name without control characters",
            ));
        }
        let mut shared = self
            .shared_state
            .as_ref()
            .map(|state| state.blocking_lock());
        // Re-check after decoding and after acquiring the shared durable state writer.
        self.authorize(origin)?;
        let path = assignment.as_ref().map(|value| value.source_path.clone());
        let committed = self
            .store
            .update_state(|state| {
                match (&output, path) {
                    (None, path) => state.last_wallpaper = path,
                    (Some(output), Some(path)) => {
                        state.output_wallpapers.insert(output.clone(), path);
                    }
                    (Some(output), None) => {
                        state.output_wallpapers.remove(output);
                    }
                }
                Ok(())
            })
            .map_err(internal)?;
        let (snapshot, theme_path) = {
            let mut live = self.live();
            let mut theme_path = None;
            match (output, assignment) {
                (None, assignment) => {
                    if self.theme_sync.is_some()
                        && live.settings.sync_theme
                        && let Some(new) = &assignment
                        && live.current.as_ref().is_none_or(|old| {
                            old.source_path != new.source_path
                                || old.cached.media != new.cached.media
                        })
                    {
                        theme_path = Some(new.source_path.clone());
                    }
                    live.current = assignment;
                }
                (Some(output), Some(assignment)) => {
                    live.per_output.insert(output, assignment);
                }
                (Some(output), None) => {
                    live.per_output.remove(&output);
                }
            }
            live.last_error = None;
            (live.snapshot(), theme_path)
        };
        let summary = committed.public_summary();
        if let Some(guard) = &mut shared {
            **guard = committed;
        }
        if let Some(hub) = self.hub.get() {
            hub.publish_core_topic(topic("state"), json!(summary), UpdateKind::Live);
        }
        drop(shared);
        self.publish(&snapshot, UpdateKind::Live);
        if let Some(path) = theme_path {
            self.sync_theme(path);
        }
        Ok(snapshot)
    }

    fn change_schedule(&self, update: impl FnOnce(&mut Schedule)) {
        self.schedule.send_if_modified(|schedule| {
            let old = *schedule;
            update(schedule);
            if *schedule == old {
                return false;
            }
            schedule.generation = schedule.generation.wrapping_add(1);
            true
        });
    }

    fn start_timer(self: &Arc<Self>) {
        if self.hub.get().is_none() || self.schedule.borrow().seconds == 0 {
            return;
        }
        let Ok(runtime) = Handle::try_current() else {
            return;
        };
        if !self.timer_started.swap(true, Ordering::Relaxed) {
            runtime.spawn(slideshow(Arc::downgrade(self), self.schedule.subscribe()));
        }
    }

    fn tick(&self, schedule: Schedule) {
        let _operation = self.operation();
        let origin = Origin::Timer(schedule);
        if let Err(error) = self
            .authorize(origin)
            .and_then(|()| self.cycle(origin, None, Cycle::Next))
            && !matches!(
                error.code,
                ErrorCode::PermissionDenied | ErrorCode::NotFound
            )
        {
            let snapshot = {
                let mut live = self.live();
                if live.last_error.as_ref() == Some(&error.message) {
                    return;
                }
                live.last_error = Some(error.message);
                live.snapshot()
            };
            self.publish(&snapshot, UpdateKind::Live);
        }
    }
}

async fn slideshow(inner: Weak<Inner>, mut changes: watch::Receiver<Schedule>) {
    loop {
        let schedule = *changes.borrow_and_update();
        if let Some(delay) = schedule.delay() {
            tokio::select! {
                biased;
                changed = changes.changed() => if changed.is_err() { break },
                () = tokio::time::sleep(delay) => {
                    let weak = inner.clone();
                    if let Err(error) = spawn_blocking(move || {
                        if let Some(inner) = weak.upgrade() { inner.tick(schedule); }
                    }).await {
                        tracing::error!(%error, "wallpaper slideshow worker failed");
                        break;
                    }
                }
            }
        } else if changes.changed().await.is_err() {
            break;
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListParams {
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetParams {
    path: PathBuf,
    output: Option<String>,
    fit: Option<WallpaperFit>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputParams {
    output: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyParams {}

fn parse<T: DeserializeOwned>(payload: Option<Value>) -> Result<T, RpcError> {
    let value = payload
        .filter(|value| !value.is_null())
        .unwrap_or_else(|| Value::Object(Default::default()));
    serde_json::from_value(value).map_err(|error| {
        RpcError::new(
            ErrorCode::InvalidParams,
            format!("invalid wallpaper parameters: {error}"),
        )
    })
}

fn random_index(count: usize) -> Result<usize, RpcError> {
    let count = u32::try_from(count).expect("catalog size fits in u32");
    let upper = u32::MAX - u32::MAX % count;
    loop {
        let value = getrandom::u32().map_err(internal)?;
        if value < upper {
            return Ok((value % count) as usize);
        }
    }
}

fn internal(error: impl fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::Internal, error.to_string())
}

fn topic(name: &str) -> TopicName {
    TopicName::try_new(name).expect("static wallpaper topic name is valid")
}
