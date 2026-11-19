//! Palette backends and committed-only request sequencing.

use crate::{
    ColorScheme, GtkLinkStatus, GtkLinker, Rgb, ThemeError, dominant_color,
    dominant_color_from_path, is_dark_at, parse_seed,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::Mutex as AsyncMutex;
use z_shell_bus::{BusHub, UpdateKind};
use z_shell_config::{ThemeBackend, ThemeMode, ThemeSettings, ThemeVariant};
use z_shell_protocol::TopicName;

/// Seed or wallpaper input used to generate a palette.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ThemeSource {
    /// Explicit `#rrggbb` seed.
    Seed(String),
    /// PNG, JPEG, or WebP file.
    WallpaperPath(PathBuf),
    /// Encoded in-memory PNG, JPEG, or WebP bytes.
    WallpaperBytes(Vec<u8>),
}

impl Default for ThemeSource {
    fn default() -> Self {
        Self::Seed("#6750a4".to_owned())
    }
}

/// One sequenced generation request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerationRequest {
    /// Caller-provided monotonically increasing sequence number.
    pub request_seq: u64,
    /// Seed or wallpaper input.
    pub source: ThemeSource,
    /// Light, dark, or scheduled mode.
    pub mode: ThemeMode,
    /// Material scheme variant.
    pub variant: ThemeVariant,
    /// Built-in or optional Matugen backend.
    pub backend: ThemeBackend,
    /// Whether reversible GTK files should be synchronized.
    pub gtk_linking: bool,
    /// Injected local hour used by [`ThemeMode::Auto`].
    pub local_hour: u8,
}

impl Default for GenerationRequest {
    fn default() -> Self {
        Self {
            request_seq: 0,
            source: ThemeSource::default(),
            mode: ThemeMode::Dark,
            variant: ThemeVariant::Tonal,
            backend: ThemeBackend::Builtin,
            gtk_linking: false,
            local_hour: 12,
        }
    }
}

/// Last committed palette and its export diagnostics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeSnapshot {
    /// Last successfully generated and committed color scheme.
    pub scheme: ColorScheme,
    /// Whether the committed scheme is dark.
    pub dark: bool,
    /// Source associated with the committed scheme.
    pub source: ThemeSource,
    /// Variant associated with the committed scheme.
    pub variant: ThemeVariant,
    /// Backend associated with the committed scheme.
    pub backend: ThemeBackend,
    /// Latest GTK export outcome for this scheme.
    pub gtk_status: GtkLinkStatus,
    /// Latest current-generation diagnostic; the scheme remains last-good.
    pub last_error: Option<String>,
}

/// Result of a sequenced generation request.
#[derive(Debug, Clone, PartialEq, Eq)]
#[expect(
    clippy::large_enum_variant,
    reason = "committed snapshots are returned without an additional heap allocation"
)]
pub enum GenerationOutcome {
    /// This request remains current and its palette is committed.
    Committed(ThemeSnapshot),
    /// A newer request was registered before this result could commit.
    Superseded,
}

#[derive(Debug)]
struct State {
    snapshot: ThemeSnapshot,
    latest_requested: Option<u64>,
    last_request: GenerationRequest,
}

pub(crate) struct EngineInner {
    state: AsyncMutex<State>,
    gtk: GtkLinker,
    hub: Mutex<Option<BusHub>>,
}

#[derive(Clone)]
pub(crate) struct WeakThemeEngine {
    inner: Weak<EngineInner>,
    matugen_program: PathBuf,
}

impl WeakThemeEngine {
    pub(crate) fn upgrade(&self) -> Option<ThemeEngine> {
        Some(ThemeEngine {
            inner: self.inner.upgrade()?,
            matugen_program: self.matugen_program.clone(),
        })
    }
}

/// Cloneable theme engine with stale-result rejection and last-good commits.
#[derive(Clone)]
pub struct ThemeEngine {
    inner: Arc<EngineInner>,
    matugen_program: PathBuf,
}

impl std::fmt::Debug for ThemeEngine {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ThemeEngine")
            .field("matugen_program", &self.matugen_program)
            .finish_non_exhaustive()
    }
}

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<ThemeEngine>();
};

impl Default for ThemeEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl ThemeEngine {
    /// Creates an engine using process XDG paths and `matugen` from `PATH`.
    #[must_use]
    pub fn new() -> Self {
        Self::with_gtk(GtkLinker::from_environment())
    }

    /// Creates an engine with an isolated or preconfigured GTK linker.
    #[must_use]
    pub fn with_gtk(gtk: GtkLinker) -> Self {
        let seed = Rgb::new(0x67, 0x50, 0xa4);
        let last_request = GenerationRequest::default();
        let snapshot = ThemeSnapshot {
            scheme: ColorScheme::generate(seed, ThemeVariant::Tonal, true),
            dark: true,
            source: last_request.source.clone(),
            variant: ThemeVariant::Tonal,
            backend: ThemeBackend::Builtin,
            gtk_status: GtkLinkStatus::Disabled,
            last_error: None,
        };
        Self {
            inner: Arc::new(EngineInner {
                state: AsyncMutex::new(State {
                    snapshot,
                    latest_requested: None,
                    last_request,
                }),
                gtk,
                hub: Mutex::new(None),
            }),
            matugen_program: PathBuf::from("matugen"),
        }
    }

    /// Overrides the Matugen executable, primarily for hermetic diagnostics.
    #[must_use]
    pub fn with_matugen_program(mut self, program: PathBuf) -> Self {
        self.matugen_program = program;
        self
    }

    /// Returns a clone of the latest committed state.
    pub async fn snapshot(&self) -> ThemeSnapshot {
        self.inner.state.lock().await.snapshot.clone()
    }

    pub(crate) fn try_snapshot(&self) -> Option<ThemeSnapshot> {
        self.inner
            .state
            .try_lock()
            .ok()
            .map(|guard| guard.snapshot.clone())
    }

    /// Generates and, if still current, commits and exports one palette.
    ///
    /// Generation errors preserve the previous scheme. GTK errors are reported in
    /// [`ThemeSnapshot::gtk_status`] after the new scheme has committed.
    pub async fn generate(
        &self,
        request: GenerationRequest,
    ) -> Result<GenerationOutcome, ThemeError> {
        {
            let mut state = self.inner.state.lock().await;
            if state
                .latest_requested
                .is_some_and(|latest| latest >= request.request_seq)
            {
                return Ok(GenerationOutcome::Superseded);
            }
            state.latest_requested = Some(request.request_seq);
            state.last_request = request.clone();
        }
        self.generate_started(request).await
    }

    /// Generates a palette for a wallpaper using the current theme settings.
    ///
    /// Shares sequencing with `theme.set` and `theme.retry`.
    ///
    /// # Errors
    ///
    /// Returns an error if the image or configured backend cannot produce a palette.
    pub async fn generate_wallpaper(
        &self,
        path: PathBuf,
        settings: &ThemeSettings,
    ) -> Result<GenerationOutcome, ThemeError> {
        self.generate_next(|request| {
            request.source = ThemeSource::WallpaperPath(path);
            request.mode = settings.mode;
            request.variant = settings.variant;
            request.backend = settings.backend;
            request.gtk_linking = settings.gtk_linking;
        })
        .await
    }

    async fn generate_started(
        &self,
        request: GenerationRequest,
    ) -> Result<GenerationOutcome, ThemeError> {
        let engine = self.clone();
        let request_seq = request.request_seq;
        match tokio::task::spawn_blocking(move || engine.generate_and_commit(request)).await {
            Ok(result) => result,
            Err(error) => {
                let error = ThemeError::GenerationTask(error.to_string());
                let mut state = self.inner.state.lock().await;
                self.record_failure(&mut state, &error, request_seq);
                Err(error)
            }
        }
    }

    fn generate_and_commit(
        &self,
        request: GenerationRequest,
    ) -> Result<GenerationOutcome, ThemeError> {
        let request_seq = request.request_seq;
        let generated = generate_scheme(request, &self.matugen_program);
        // Sequence export and publication with the commit. A stale generation must not
        // overwrite GTK assets or publish after a newer commit.
        let mut state = self.inner.state.blocking_lock();
        let (scheme, dark, request) = match generated {
            Ok(generated) => generated,
            Err(error) => {
                self.record_failure(&mut state, &error, request_seq);
                return Err(error);
            }
        };
        if state.latest_requested != Some(request_seq) {
            return Ok(GenerationOutcome::Superseded);
        }
        let gtk_status = if request.gtk_linking {
            self.inner.gtk.link(&scheme, dark)
        } else {
            match self.inner.gtk.revert() {
                GtkLinkStatus::Unlinked => GtkLinkStatus::Disabled,
                status => status,
            }
        };
        state.snapshot = ThemeSnapshot {
            scheme,
            dark,
            source: request.source,
            variant: request.variant,
            backend: request.backend,
            gtk_status,
            last_error: None,
        };
        self.publish(&state.snapshot, UpdateKind::Live);
        Ok(GenerationOutcome::Committed(state.snapshot.clone()))
    }

    fn record_failure(&self, state: &mut State, error: &ThemeError, request_seq: u64) {
        if state.latest_requested == Some(request_seq) {
            state.snapshot.last_error = Some(error.to_string());
            self.publish(&state.snapshot, UpdateKind::Live);
        }
    }

    pub(crate) async fn generate_next(
        &self,
        update: impl FnOnce(&mut GenerationRequest),
    ) -> Result<GenerationOutcome, ThemeError> {
        let request = {
            let mut state = self.inner.state.lock().await;
            let Some(sequence) = state.latest_requested.unwrap_or_default().checked_add(1) else {
                return Ok(GenerationOutcome::Superseded);
            };
            let mut request = state.last_request.clone();
            update(&mut request);
            request.request_seq = sequence;
            state.latest_requested = Some(sequence);
            state.last_request = request.clone();
            request
        };
        self.generate_started(request).await
    }

    pub(crate) fn downgrade(&self) -> WeakThemeEngine {
        WeakThemeEngine {
            inner: Arc::downgrade(&self.inner),
            matugen_program: self.matugen_program.clone(),
        }
    }

    pub(crate) fn attach_hub(&self, hub: BusHub) {
        *self.inner.hub.lock().expect("theme hub lock poisoned") = Some(hub);
    }

    pub(crate) fn publish(&self, snapshot: &ThemeSnapshot, kind: UpdateKind) {
        let hub = self
            .inner
            .hub
            .lock()
            .expect("theme hub lock poisoned")
            .clone();
        if let Some(hub) = hub {
            let topic = TopicName::try_new("theme").expect("static theme topic is valid");
            let data =
                serde_json::to_value(snapshot).expect("ThemeSnapshot serialization is infallible");
            hub.publish_core_topic(topic, data, kind);
        }
    }
}

fn generate_scheme(
    request: GenerationRequest,
    program: &Path,
) -> Result<(ColorScheme, bool, GenerationRequest), ThemeError> {
    let dark = is_dark_at(request.mode, request.local_hour);
    let scheme = match request.backend {
        ThemeBackend::Builtin => {
            let seed = match &request.source {
                ThemeSource::Seed(seed) => parse_seed(seed)?,
                ThemeSource::WallpaperPath(path) => dominant_color_from_path(path)?,
                ThemeSource::WallpaperBytes(bytes) => dominant_color(bytes)?,
            };
            ColorScheme::generate(seed, request.variant, dark)
        }
        ThemeBackend::Matugen => generate_matugen(&request, dark, program)?,
        _ => ColorScheme::generate(
            match &request.source {
                ThemeSource::Seed(seed) => parse_seed(seed)?,
                ThemeSource::WallpaperPath(path) => dominant_color_from_path(path)?,
                ThemeSource::WallpaperBytes(bytes) => dominant_color(bytes)?,
            },
            request.variant,
            dark,
        ),
    };
    Ok((scheme, dark, request))
}

#[derive(Debug, Deserialize)]
struct MatugenJson {
    mode: String,
    is_dark_mode: bool,
    colors: BTreeMap<String, MatugenRole>,
}

#[derive(Debug, Deserialize)]
struct MatugenRole {
    default: MatugenColor,
    dark: MatugenColor,
    light: MatugenColor,
}

#[derive(Debug, Deserialize)]
struct MatugenColor {
    color: String,
}

fn generate_matugen(
    request: &GenerationRequest,
    dark: bool,
    program: &Path,
) -> Result<ColorScheme, ThemeError> {
    let variant = match request.variant {
        ThemeVariant::Tonal => "scheme-tonal-spot",
        ThemeVariant::Vibrant => "scheme-vibrant",
        ThemeVariant::Expressive => "scheme-expressive",
        ThemeVariant::Fidelity => "scheme-fidelity",
        ThemeVariant::Neutral => "scheme-neutral",
        ThemeVariant::Mono => "scheme-monochrome",
        _ => "scheme-tonal-spot",
    };
    let mut command = Command::new(program);
    command
        .args(["--mode", if dark { "dark" } else { "light" }])
        .args(["--type", variant])
        .args(["--source-color-index", "0", "--json", "hex", "--quiet"])
        .args(["--include-image-in-json", "false"]);
    match &request.source {
        ThemeSource::Seed(seed) => {
            let seed = parse_seed(seed)?.to_hex();
            command.args(["color", "hex", &seed]);
        }
        ThemeSource::WallpaperPath(path) => {
            command.arg("image").arg("--").arg(path);
        }
        ThemeSource::WallpaperBytes(bytes) => {
            let seed = dominant_color(bytes)?.to_hex();
            command.args(["color", "hex", &seed]);
        }
    }
    let output = command.output().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ThemeError::MatugenUnavailable
        } else {
            ThemeError::MatugenFailed(error.to_string())
        }
    })?;
    if !output.status.success() {
        return Err(ThemeError::MatugenFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        ));
    }
    parse_matugen(&output.stdout, dark)
}

fn parse_matugen(bytes: &[u8], dark: bool) -> Result<ColorScheme, ThemeError> {
    let json: MatugenJson = serde_json::from_slice(bytes)
        .map_err(|error| ThemeError::MatugenFailed(format!("invalid JSON: {error}")))?;
    if json.is_dark_mode != dark || json.mode != if dark { "dark" } else { "light" } {
        return Err(ThemeError::MatugenFailed(
            "returned palette has the wrong mode".to_owned(),
        ));
    }
    let mut roles = BTreeMap::new();
    for (name, role) in json.colors {
        let default = normalize_matugen_color(&role.default.color)?;
        let selected = if dark {
            &role.dark.color
        } else {
            &role.light.color
        };
        if default != normalize_matugen_color(selected)? {
            return Err(ThemeError::MatugenFailed(format!(
                "role `{name}` disagrees with the selected mode"
            )));
        }
        roles.insert(name, default);
    }
    ColorScheme::from_map(&roles)
}

fn normalize_matugen_color(value: &str) -> Result<String, ThemeError> {
    parse_seed(value)
        .map(Rgb::to_hex)
        .map_err(|error| ThemeError::MatugenFailed(error.to_string()))
}
