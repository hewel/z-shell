//! Reversible, conflict-checked GTK 3/4 stylesheet ownership and optional GSettings.

use crate::{ColorScheme, ThemeError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::{c_char, c_int, c_void};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

const RECOVERY_VERSION: u32 = 1;
const GTK_TARGETS: [&str; 2] = ["gtk-3.0/gtk.css", "gtk-4.0/gtk.css"];
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Result of an opt-in GTK synchronization operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GtkLinkStatus {
    /// GTK linking is disabled and no managed files remain.
    Disabled,
    /// Both GTK generations are linked to the committed palette.
    Linked,
    /// No managed files remain; unmanaged files were untouched.
    Unlinked,
    /// A managed file changed externally and must be resolved manually.
    Conflict {
        /// Externally changed managed path.
        path: PathBuf,
    },
    /// Linking failed without affecting the committed shell palette.
    Error {
        /// Diagnostic suitable for the theme topic.
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct OriginalFile {
    bytes: Vec<u8>,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RecoveryEntry {
    original: Option<OriginalFile>,
    managed_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct RecoveryRecord {
    version: u32,
    files: BTreeMap<String, RecoveryEntry>,
}

/// Owns GTK stylesheets beneath injectable XDG configuration and state roots.
#[derive(Debug)]
pub struct GtkLinker {
    config_home: PathBuf,
    state_home: PathBuf,
    operation: Mutex<()>,
}

impl GtkLinker {
    /// Creates a linker using explicit roots, suitable for isolated tests.
    #[must_use]
    pub fn new(config_home: PathBuf, state_home: PathBuf) -> Self {
        Self {
            config_home,
            state_home,
            operation: Mutex::new(()),
        }
    }

    /// Creates a linker from `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `HOME`.
    #[must_use]
    pub fn from_environment() -> Self {
        let home = std::env::var_os("HOME").map_or_else(PathBuf::new, PathBuf::from);
        let root = |name: &str, fallback: PathBuf| {
            std::env::var_os(name)
                .filter(|value| !value.is_empty())
                .map_or(fallback, PathBuf::from)
        };
        Self::new(
            root("XDG_CONFIG_HOME", home.join(".config")),
            root("XDG_STATE_HOME", home.join(".local/state")),
        )
    }

    /// Links both GTK generations to `scheme`, preserving prior user files.
    /// GSettings synchronization is best-effort; a missing schema or key does not affect linking.
    #[must_use]
    pub fn link(&self, scheme: &ColorScheme, dark: bool) -> GtkLinkStatus {
        let _guard = self.operation.lock().expect("GTK operation lock poisoned");
        match self.link_locked(scheme, dark) {
            Ok(()) => {
                set_gsettings_color_scheme(dark);
                GtkLinkStatus::Linked
            }
            Err(Failure::Conflict(path)) => GtkLinkStatus::Conflict { path },
            Err(Failure::Error(error)) => GtkLinkStatus::Error {
                message: error.to_string(),
            },
        }
    }

    /// Restores original files and removes only shell-created managed files.
    #[must_use]
    pub fn revert(&self) -> GtkLinkStatus {
        let _guard = self.operation.lock().expect("GTK operation lock poisoned");
        match self.revert_locked() {
            Ok(()) => GtkLinkStatus::Unlinked,
            Err(Failure::Conflict(path)) => GtkLinkStatus::Conflict { path },
            Err(Failure::Error(error)) => GtkLinkStatus::Error {
                message: error.to_string(),
            },
        }
    }

    fn recovery_path(&self) -> PathBuf {
        self.state_home.join("z-shell/theme/gtk-recovery.json")
    }

    fn link_locked(&self, scheme: &ColorScheme, dark: bool) -> Result<(), Failure> {
        let recovery_path = self.recovery_path();
        let previous = load_recovery(&recovery_path)?;
        let css = render_css(scheme, dark);
        let mut next = RecoveryRecord {
            version: RECOVERY_VERSION,
            files: BTreeMap::new(),
        };
        let mut plans = Vec::with_capacity(GTK_TARGETS.len());
        for relative in GTK_TARGETS {
            let path = self.config_home.join(relative);
            let current = read_regular(&path)?;
            if let Some(entry) = previous
                .as_ref()
                .and_then(|record| record.files.get(relative))
            {
                let matches = current
                    .as_ref()
                    .is_some_and(|bytes| sha256(bytes) == entry.managed_sha256);
                if !matches {
                    return Err(Failure::Conflict(path));
                }
            }
            let original = previous
                .as_ref()
                .and_then(|record| record.files.get(relative))
                .map_or_else(
                    || {
                        current.as_ref().map(|bytes| OriginalFile {
                            sha256: sha256(bytes),
                            bytes: bytes.clone(),
                        })
                    },
                    |entry| entry.original.clone(),
                );
            next.files.insert(
                relative.to_owned(),
                RecoveryEntry {
                    original,
                    managed_sha256: sha256(css.as_bytes()),
                },
            );
            plans.push(LinkPlan {
                path,
                previous: current,
                managed: css.as_bytes(),
            });
        }

        for (written, plan) in plans.iter().enumerate() {
            if let Err(error) = write_atomic(&plan.path, plan.managed) {
                rollback_writes(&plans, written);
                return Err(Failure::Error(error));
            }
        }
        let encoded = encode_recovery(&next, &recovery_path)?;
        if let Err(error) = write_atomic(&recovery_path, &encoded) {
            rollback_writes(&plans, plans.len());
            return Err(Failure::Error(error));
        }
        Ok(())
    }

    fn revert_locked(&self) -> Result<(), Failure> {
        let recovery_path = self.recovery_path();
        let Some(record) = load_recovery(&recovery_path)? else {
            return Ok(());
        };
        let mut plans = Vec::with_capacity(record.files.len());
        for (relative, entry) in &record.files {
            let path = self.config_home.join(relative);
            let current = read_regular(&path)?;
            if !current
                .as_ref()
                .is_some_and(|bytes| sha256(bytes) == entry.managed_sha256)
            {
                return Err(Failure::Conflict(path));
            }
            plans.push(RevertPlan {
                path,
                managed: current,
                original: entry.original.clone(),
            });
        }
        for (restored, plan) in plans.iter().enumerate() {
            let result = match &plan.original {
                Some(original) => write_atomic(&plan.path, &original.bytes),
                None => remove_file(&plan.path),
            };
            if let Err(error) = result {
                rollback_reverts(&plans, restored);
                return Err(Failure::Error(error));
            }
        }
        remove_file(&recovery_path).map_err(Failure::Error)
    }
}

#[derive(Debug)]
struct LinkPlan<'a> {
    path: PathBuf,
    previous: Option<Vec<u8>>,
    managed: &'a [u8],
}

#[derive(Debug)]
struct RevertPlan {
    path: PathBuf,
    managed: Option<Vec<u8>>,
    original: Option<OriginalFile>,
}

#[derive(Debug)]
enum Failure {
    Conflict(PathBuf),
    Error(ThemeError),
}

impl From<ThemeError> for Failure {
    fn from(error: ThemeError) -> Self {
        Self::Error(error)
    }
}

fn rollback_writes(plans: &[LinkPlan<'_>], count: usize) {
    for plan in plans.iter().take(count).rev() {
        let result = match &plan.previous {
            Some(bytes) => write_atomic(&plan.path, bytes),
            None => remove_file(&plan.path),
        };
        if let Err(error) = result {
            tracing::error!(path = %plan.path.display(), %error, "GTK rollback failed");
        }
    }
}

fn rollback_reverts(plans: &[RevertPlan], count: usize) {
    for plan in plans.iter().take(count).rev() {
        let result = match &plan.managed {
            Some(bytes) => write_atomic(&plan.path, bytes),
            None => Ok(()),
        };
        if let Err(error) = result {
            tracing::error!(path = %plan.path.display(), %error, "GTK revert rollback failed");
        }
    }
}

fn load_recovery(path: &Path) -> Result<Option<RecoveryRecord>, ThemeError> {
    let Some(bytes) = read_regular(path)? else {
        return Ok(None);
    };
    let record: RecoveryRecord =
        serde_json::from_slice(&bytes).map_err(|error| ThemeError::Recovery {
            path: path.to_owned(),
            message: error.to_string(),
        })?;
    if record.version != RECOVERY_VERSION {
        return Err(ThemeError::Recovery {
            path: path.to_owned(),
            message: format!("unsupported version {}", record.version),
        });
    }
    for (relative, entry) in &record.files {
        if !GTK_TARGETS.contains(&relative.as_str()) {
            return Err(ThemeError::Recovery {
                path: path.to_owned(),
                message: format!("non-allowlisted path `{relative}`"),
            });
        }
        if !valid_digest(&entry.managed_sha256)
            || entry.original.as_ref().is_some_and(|original| {
                !valid_digest(&original.sha256) || original.sha256 != sha256(&original.bytes)
            })
        {
            return Err(ThemeError::Recovery {
                path: path.to_owned(),
                message: format!("invalid digest for `{relative}`"),
            });
        }
    }
    Ok(Some(record))
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn encode_recovery(record: &RecoveryRecord, path: &Path) -> Result<Vec<u8>, ThemeError> {
    serde_json::to_vec_pretty(record).map_err(|error| ThemeError::Recovery {
        path: path.to_owned(),
        message: error.to_string(),
    })
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read_regular(path: &Path) -> Result<Option<Vec<u8>>, ThemeError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            fs::read(path).map(Some).map_err(|source| ThemeError::Io {
                operation: "read",
                path: path.to_owned(),
                source,
            })
        }
        Ok(_) => Err(ThemeError::Io {
            operation: "read regular file",
            path: path.to_owned(),
            source: io::Error::new(io::ErrorKind::InvalidData, "not a regular file"),
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(ThemeError::Io {
            operation: "inspect",
            path: path.to_owned(),
            source,
        }),
    }
}

fn remove_file(path: &Path) -> Result<(), ThemeError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(ThemeError::Io {
            operation: "remove",
            path: path.to_owned(),
            source,
        }),
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), ThemeError> {
    let parent = path.parent().ok_or_else(|| ThemeError::Io {
        operation: "find parent directory for",
        path: path.to_owned(),
        source: io::Error::new(io::ErrorKind::InvalidInput, "missing parent directory"),
    })?;
    fs::create_dir_all(parent).map_err(|source| ThemeError::Io {
        operation: "create directory for",
        path: path.to_owned(),
        source,
    })?;
    let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(
        ".z-shell-theme-{}-{sequence}.tmp",
        std::process::id()
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|source| ThemeError::Io {
                operation: "create temporary file for",
                path: path.to_owned(),
                source,
            })?;
        file.write_all(bytes).map_err(|source| ThemeError::Io {
            operation: "write temporary file for",
            path: path.to_owned(),
            source,
        })?;
        file.sync_all().map_err(|source| ThemeError::Io {
            operation: "sync temporary file for",
            path: path.to_owned(),
            source,
        })?;
        fs::rename(&temp, path).map_err(|source| ThemeError::Io {
            operation: "replace",
            path: path.to_owned(),
            source,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn render_css(scheme: &ColorScheme, dark: bool) -> String {
    use std::fmt::Write as _;
    let mut css = format!(
        "/* Managed by z-shell. External edits disable updates until resolved. Mode: {}. */\n",
        if dark { "dark" } else { "light" }
    );
    for (role, color) in scheme.to_map() {
        writeln!(css, "@define-color z_shell_{role} {color};")
            .expect("writing CSS into a String cannot fail");
    }
    css
}

fn set_gsettings_color_scheme(dark: bool) {
    type SchemaSourceGetDefault = unsafe extern "C" fn() -> *mut c_void;
    type SchemaSourceLookup =
        unsafe extern "C" fn(*mut c_void, *const c_char, c_int) -> *mut c_void;
    type SchemaHasKey = unsafe extern "C" fn(*mut c_void, *const c_char) -> c_int;
    type SettingsNew = unsafe extern "C" fn(*const c_char) -> *mut c_void;
    type SettingsSetEnum = unsafe extern "C" fn(*mut c_void, *const c_char, c_int) -> c_int;
    type Unref = unsafe extern "C" fn(*mut c_void);

    // SAFETY: this loads the system GIO library, whose initialization and
    // finalization routines may run.
    let Ok(library) = (unsafe { libloading::Library::new("libgio-2.0.so.0") }) else {
        tracing::debug!("libgio is unavailable; skipping GSettings color-scheme hook");
        return;
    };
    // SAFETY: symbol names are NUL-terminated and their types match the GIO
    // and GObject C headers. The library outlives every symbol invocation.
    let symbols = unsafe {
        (
            library.get::<SchemaSourceGetDefault>(b"g_settings_schema_source_get_default\0"),
            library.get::<SchemaSourceLookup>(b"g_settings_schema_source_lookup\0"),
            library.get::<SchemaHasKey>(b"g_settings_schema_has_key\0"),
            library.get::<Unref>(b"g_settings_schema_unref\0"),
            library.get::<SettingsNew>(b"g_settings_new\0"),
            library.get::<SettingsSetEnum>(b"g_settings_set_enum\0"),
            library.get::<Unref>(b"g_object_unref\0"),
        )
    };
    let (
        Ok(default_source),
        Ok(lookup),
        Ok(has_key),
        Ok(schema_unref),
        Ok(new),
        Ok(set),
        Ok(object_unref),
    ) = symbols
    else {
        tracing::debug!("GSettings symbols are unavailable; skipping color-scheme hook");
        return;
    };
    // SAFETY: the default source is borrowed from GIO and used only if non-null.
    // The schema ID and key are static C strings. We verify both are present
    // before creating and updating settings. Each owned reference is released once.
    unsafe {
        let source = default_source();
        if source.is_null() {
            tracing::debug!("No default GSettings schema source; skipping color-scheme hook");
            return;
        }
        let schema_id = c"org.gnome.desktop.interface".as_ptr();
        let schema = lookup(source, schema_id, 1);
        if schema.is_null() {
            tracing::debug!("GNOME interface schema is unavailable; skipping color-scheme hook");
            return;
        }
        let key = c"color-scheme".as_ptr();
        let supports_color_scheme = has_key(schema, key) != 0;
        schema_unref(schema);
        if !supports_color_scheme {
            tracing::debug!("GNOME interface schema lacks color-scheme; skipping GSettings hook");
            return;
        }

        let settings = new(schema_id);
        if settings.is_null() {
            tracing::debug!("Could not open GNOME interface settings");
            return;
        }
        let accepted = set(settings, key, if dark { 1 } else { 2 });
        if accepted == 0 {
            tracing::debug!("GSettings did not accept the color-scheme update");
        }
        object_unref(settings);
    }
}
