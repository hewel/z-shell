//! Static parsing and validation for the `plugin.toml` schema.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, btree_map::Entry};
use std::fmt;
use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::str::FromStr;

use serde::de::{MapAccess, Visitor, value::MapAccessDeserializer};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use sha2::{Digest, Sha256};
use thiserror::Error;
use toml::{Table, Value};
use z_shell_protocol::{PluginEntryId, PluginEntryKind, PluginId};

use super::capabilities::{
    BusPermissions, CapabilityBundle, ClipboardCapabilities, FilesCapabilities, HostCapabilities,
    NetworkOriginRule, SqliteCapabilities,
};

/// Highest cumulative plugin API level accepted by the shell.
pub const SUPPORTED_PLUGIN_API_LEVEL: u32 = 2;

/// Current host `shared_runtime_abi` (`major.minor`) supported by this shell build.
pub const HOST_SHARED_RUNTIME_ABI: SharedRuntimeAbi = SharedRuntimeAbi { major: 1, minor: 0 };

const SETTING_TYPE_EXPECTATION: &str =
    "expected a setting type of string, integer, number, or boolean";

/// Semver-style `major.minor` runtime ABI version for the 10 externalized shared runtime modules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SharedRuntimeAbi {
    /// Breaking ABI major version (must match the host exactly).
    pub major: u32,
    /// Minimum host minor ABI version required by the plugin (`host.minor >= plugin.minor`).
    pub minor: u32,
}

impl SharedRuntimeAbi {
    /// Returns true when a host implementing `host` satisfies this plugin's ABI requirement.
    #[must_use]
    pub const fn is_compatible_with_host(self, host: Self) -> bool {
        self.major == host.major && host.minor >= self.minor
    }
}

impl fmt::Display for SharedRuntimeAbi {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

/// Error returned when parsing a [`SharedRuntimeAbi`] string.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("invalid shared_runtime_abi {0:?}; expected <major>.<minor> without leading zeros")]
pub struct ParseSharedRuntimeAbiError(String);

impl FromStr for SharedRuntimeAbi {
    type Err = ParseSharedRuntimeAbiError;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        let Some((maj, min)) = raw.split_once('.') else {
            return Err(ParseSharedRuntimeAbiError(raw.to_owned()));
        };
        if min.contains('.') || !is_decimal_part(maj) || !is_decimal_part(min) {
            return Err(ParseSharedRuntimeAbiError(raw.to_owned()));
        }
        let major = maj
            .parse()
            .map_err(|_| ParseSharedRuntimeAbiError(raw.to_owned()))?;
        let minor = min
            .parse()
            .map_err(|_| ParseSharedRuntimeAbiError(raw.to_owned()))?;
        Ok(Self { major, minor })
    }
}

impl Serialize for SharedRuntimeAbi {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for SharedRuntimeAbi {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        raw.parse().map_err(de::Error::custom)
    }
}

/// Store catalog category declared in `[store]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum StoreCategory {
    /// Status bar and desktop widgets.
    Widgets,
    /// Productivity utilities and launcher providers.
    Productivity,
    /// System integrations and power tools.
    System,
    /// Theme bridges and visual styling tools.
    Appearance,
    /// Wayland compositor integrations.
    Compositor,
    /// Launcher providers and quick search extensions.
    Launcher,
}

/// Declarative store presentation metadata (`[store]`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct StoreMetadata {
    /// Primary store category.
    pub category: StoreCategory,
    /// Searchable tags.
    pub tags: Vec<String>,
    /// Optional homepage URL.
    pub homepage: Option<String>,
    /// Optional source repository URL.
    pub repository: Option<String>,
    /// Optional relative path to a contained icon asset.
    pub icon: Option<PathBuf>,
    /// Optional relative paths to contained screenshot assets.
    pub screenshots: Vec<PathBuf>,
}

/// Prebuilt bundle metadata declared in `[build]` for `plugin_api >= 2`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct BuildMetadata {
    /// Relative path to `dist/manifest.build.json`.
    pub manifest: PathBuf,
    /// Required shared runtime ABI (`"<major>.<minor>"`).
    pub shared_runtime_abi: SharedRuntimeAbi,
}

/// Verified build index (`dist/manifest.build.json`) shipped with `plugin_api >= 2` bundles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct BuildManifest {
    /// Build manifest schema version (currently `1`).
    pub schema_version: u32,
    /// Required shared runtime ABI (`"<major>.<minor>"`).
    pub shared_runtime_abi: SharedRuntimeAbi,
    /// Relative paths inside the plugin root mapped to `sha256:<64-hex>` digests.
    pub files: BTreeMap<String, String>,
}

/// Preferred bar zone hint declared on `[[widget]]` entries (`default_zone`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum BarZone {
    /// Left bar section.
    Left,
    /// Center bar section.
    Center,
    /// Right bar section.
    Right,
}

/// Error returned when checking a plugin's runtime API/ABI compatibility against a host.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum CompatibilityError {
    /// The manifest requires a higher `plugin_api` level than supported.
    #[error("plugin_api {plugin_api} exceeds supported max level {max_supported}")]
    UnsupportedPluginApi {
        /// Level declared by `plugin.toml`.
        plugin_api: u32,
        /// Highest level supported by this shell.
        max_supported: u32,
    },
    /// A `plugin_api >= 2` manifest lacked `[build]` metadata.
    #[error("plugin_api >= 2 manifest is missing [build] metadata")]
    MissingBuildMetadata,
    /// The plugin's `shared_runtime_abi` is incompatible with the host runtime ABI.
    #[error("incompatible shared_runtime_abi: plugin requires {required}, host provides {host}")]
    IncompatibleRuntimeAbi {
        /// ABI required by the plugin build manifest.
        required: SharedRuntimeAbi,
        /// ABI provided by the host.
        host: SharedRuntimeAbi,
    },
}

/// A statically validated plugin manifest. Its settings schema is not public data.
#[derive(Debug)]
#[non_exhaustive]
pub struct Manifest {
    /// Canonical plugin identifier.
    pub id: PluginId,
    /// Human-readable plugin name.
    pub name: String,
    /// Validated package version, independent of the plugin API level.
    pub version: String,
    /// Required cumulative plugin API level.
    pub plugin_api: u32,
    /// Optional author metadata.
    pub author: Option<String>,
    /// License metadata, defaulting to `MIT` when omitted.
    pub license: String,
    /// Optional human-readable description.
    pub description: Option<String>,
    /// Informational minimum shell version hint (display-only, not a hard preflight gate).
    pub min_shell_version: Option<String>,
    /// Informational dependency metadata, not commands to execute.
    pub dependencies: Vec<String>,
    /// Optional store catalog presentation metadata (`[store]`).
    pub store: Option<StoreMetadata>,
    /// Prebuilt artifact declaration (`[build]`, required when `plugin_api >= 2`).
    pub build: Option<BuildMetadata>,
    /// Verified build index parsed from `build.manifest` when `plugin_api >= 2`.
    pub build_manifest: Option<BuildManifest>,
    /// Requested host capabilities and bus permissions.
    pub capabilities: CapabilityBundle,
    /// Validated plugin entries across all supported kinds.
    pub entries: Vec<ManifestEntry>,
    settings: Settings,
}

impl Manifest {
    /// Reads and validates `plugin.toml` and its entry/build paths without executing plugin code.
    ///
    /// # Errors
    ///
    /// Fails when the manifest cannot be read or when it, its build manifest, or any tree file
    /// violates the contract (including presence of any `.qjsb` file).
    pub fn load(root: &Path) -> Result<Self, ManifestError> {
        let root = root.canonicalize().map_err(ManifestIssue::Root)?;
        verify_no_qjsb(&root)?;
        let path = contained_file(&root, Path::new("plugin.toml")).map_err(ManifestIssue::File)?;
        let source = fs::read_to_string(path).map_err(|err| ManifestIssue::File(err.into()))?;
        let raw: RawManifest =
            toml::from_str(&source).map_err(|err| manifest_parse_issue(&err, &source))?;
        Ok(raw.validate(&root)?)
    }

    /// Checks `plugin_api` and `shared_runtime_abi` compatibility against `host_abi`.
    ///
    /// `min_shell_version` is informational display metadata and does not fail this check.
    ///
    /// # Errors
    ///
    /// Returns [`CompatibilityError`] if `plugin_api` or `shared_runtime_abi` is incompatible.
    pub fn check_runtime_compatibility(
        &self,
        host_abi: SharedRuntimeAbi,
    ) -> Result<(), CompatibilityError> {
        if self.plugin_api > SUPPORTED_PLUGIN_API_LEVEL {
            return Err(CompatibilityError::UnsupportedPluginApi {
                plugin_api: self.plugin_api,
                max_supported: SUPPORTED_PLUGIN_API_LEVEL,
            });
        }
        if self.plugin_api >= 2 {
            let Some(build) = &self.build else {
                return Err(CompatibilityError::MissingBuildMetadata);
            };
            if !build.shared_runtime_abi.is_compatible_with_host(host_abi) {
                return Err(CompatibilityError::IncompatibleRuntimeAbi {
                    required: build.shared_runtime_abi,
                    host: host_abi,
                });
            }
        }
        Ok(())
    }

    /// Applies shared plugin setting overrides and returns only non-secret values.
    ///
    /// # Errors
    ///
    /// Fails on keys not declared at plugin scope or values that violate their declarations,
    /// including overrides for secret settings.
    pub fn public_settings(&self, overrides: &Table) -> Result<Table, ManifestError> {
        Ok(self
            .settings
            .public_values(Scope::Plugin(&self.id), overrides)?)
    }
}

/// Rejects any `.qjsb` bytecode file anywhere inside `root` (excluding `.git`).
///
/// # Errors
///
/// Returns [`ManifestError`] if directory traversal fails or any `.qjsb` file is present.
pub fn verify_no_qjsb(root: &Path) -> Result<(), ManifestError> {
    fn walk(dir: &Path, is_root: bool) -> Result<(), ManifestIssue> {
        for entry in fs::read_dir(dir).map_err(|err| ManifestIssue::File(err.into()))? {
            let entry = entry.map_err(|err| ManifestIssue::File(err.into()))?;
            let path = entry.path();
            let name = entry.file_name();
            if is_root && name == ".git" {
                continue;
            }
            let file_type = entry
                .file_type()
                .map_err(|err| ManifestIssue::File(err.into()))?;
            if file_type.is_dir() {
                walk(&path, false)?;
            } else if path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("qjsb"))
            {
                return Err(ManifestIssue::Field {
                    field: "dist",
                    problem: "remote or bundled .qjsb bytecode files are forbidden",
                });
            }
        }
        Ok(())
    }
    walk(root, true).map_err(ManifestError)
}

/// Width tier declared by a plugin `[[panel]]` entry (`DESIGN.md` Compact 360px vs Standard 396px).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum PanelWidthTier {
    /// Compact popover (`360px` wide).
    Compact,
    /// Standard popover (`396px` wide).
    Standard,
}

/// A validated static plugin contribution and its entry-scoped settings schema.
#[derive(Debug)]
#[non_exhaustive]
pub struct ManifestEntry {
    /// Canonical identifier, qualified with the owning plugin.
    pub id: PluginEntryId,
    /// Which of the seven contribution kinds this entry implements.
    pub kind: PluginEntryKind,
    /// Primary entry file path as declared, relative to the plugin root.
    pub path: PathBuf,
    /// Prebuilt ES2022 `.mjs` bundle path relative to plugin root (`plugin_api >= 2`).
    pub bundle: Option<PathBuf>,
    /// Optional precompiled Lightning CSS stylesheet paths relative to plugin root (`plugin_api >= 2`).
    pub styles: Vec<PathBuf>,
    /// Preferred bar zone hint (`[[widget]]` entries only).
    pub default_zone: Option<BarZone>,
    /// Optional human-readable title.
    pub title: Option<String>,
    /// Optional human-readable description.
    pub description: Option<String>,
    /// Optional popover width tier (valid only on `[[panel]]` entries).
    pub width_tier: Option<PanelWidthTier>,
    settings: Settings,
}

impl ManifestEntry {
    /// Applies this entry's setting overrides and returns only non-secret values.
    ///
    /// # Errors
    ///
    /// Fails on keys not declared for this entry or values that violate their declarations,
    /// including overrides for secret settings.
    pub fn public_settings(&self, overrides: &Table) -> Result<Table, ManifestError> {
        Ok(self
            .settings
            .public_values(Scope::Entry(&self.id), overrides)?)
    }
}

/// Public diagnostic that does not contain setting values or manifest source snippets.
#[derive(Debug, Error)]
#[error(transparent)]
pub struct ManifestError(#[from] ManifestIssue);

#[derive(Debug, Error)]
enum ManifestIssue {
    #[error("cannot resolve plugin root: {0}")]
    Root(#[source] io::Error),
    #[error("invalid plugin.toml: {0}")]
    File(#[source] FileIssue),
    #[error("invalid plugin.toml{location}: {problem}")]
    Parse { location: String, problem: String },
    #[error("invalid plugin.toml field {field}: {problem}")]
    Field {
        field: &'static str,
        problem: &'static str,
    },
    #[error("entry {id}: {issue}")]
    EntryFile {
        id: PluginEntryId,
        #[source]
        issue: FileIssue,
    },
    #[error("duplicate entry id {0}")]
    DuplicateEntry(PluginEntryId),
    #[error("{scope} setting {key:?}: {problem}")]
    Setting {
        scope: String,
        key: String,
        problem: &'static str,
    },
}

#[derive(Debug, Error)]
enum FileIssue {
    #[error("filesystem error: {0}")]
    Io(#[from] io::Error),
    #[error("expected a relative path without '..' components")]
    RelativePath,
    #[error("file must resolve strictly inside the canonical plugin root")]
    OutsideRoot,
    #[error("expected a regular file")]
    NotRegular,
}

fn check_relative_syntax(relative: &Path) -> Result<(), FileIssue> {
    if relative.as_os_str().is_empty()
        || relative.components().any(|part| {
            matches!(
                part,
                Component::Prefix(_) | Component::RootDir | Component::ParentDir
            )
        })
    {
        return Err(FileIssue::RelativePath);
    }
    Ok(())
}

fn contained_file(root: &Path, relative: &Path) -> Result<PathBuf, FileIssue> {
    check_relative_syntax(relative)?;
    let canonical = root.join(relative).canonicalize()?;
    if canonical == root || !canonical.starts_with(root) {
        return Err(FileIssue::OutsideRoot);
    }
    if !canonical.metadata()?.is_file() {
        return Err(FileIssue::NotRegular);
    }
    Ok(canonical)
}

fn sha256_file(path: &Path) -> Result<String, io::Error> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher)?;
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn manifest_parse_issue(error: &toml::de::Error, source: &str) -> ManifestIssue {
    // The TOML diagnostic may include both source snippets and unexpected values.
    // Preserve only Serde's schema field names; never retain the original error.
    let message = error.message();
    let problem = if let Some((field, _)) = message
        .strip_prefix("unknown field `")
        .and_then(|rest| rest.rsplit_once("`, expected "))
    {
        format!("unknown field {field:?}")
    } else if let Some(field) = message
        .strip_prefix("missing field `")
        .and_then(|s| s.strip_suffix('`'))
    {
        format!("missing required field {field:?}")
    } else if message == SETTING_TYPE_EXPECTATION {
        SETTING_TYPE_EXPECTATION.to_owned()
    } else if message.ends_with(", expected a TOML table") {
        "expected a TOML table".to_owned()
    } else {
        "invalid syntax or field type".to_owned()
    };
    let location = error
        .span()
        .and_then(|span| source.get(..span.start))
        .map_or_else(String::new, |prefix| {
            let line = prefix.bytes().filter(|&byte| byte == b'\n').count() + 1;
            let column = prefix
                .rsplit('\n')
                .next()
                .map_or(0, |line| line.chars().count())
                + 1;
            format!(" at line {line}, column {column}")
        });
    ManifestIssue::Parse { location, problem }
}

// TOML forwards arrays to Serde's struct visitor, which by default also accepts
// positional fields. Require a map before delegating to a deny_unknown_fields struct.
#[derive(Default)]
struct TableOnly<T>(T);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for TableOnly<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TableVisitor<T>(std::marker::PhantomData<T>);

        impl<'de, T: Deserialize<'de>> Visitor<'de> for TableVisitor<T> {
            type Value = TableOnly<T>;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a TOML table")
            }

            fn visit_map<M: MapAccess<'de>>(self, map: M) -> Result<Self::Value, M::Error> {
                T::deserialize(MapAccessDeserializer::new(map)).map(TableOnly)
            }
        }

        deserializer.deserialize_map(TableVisitor(std::marker::PhantomData))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawStoreMetadata {
    category: StoreCategory,
    #[serde(default)]
    tags: Vec<String>,
    homepage: Option<String>,
    repository: Option<String>,
    icon: Option<PathBuf>,
    #[serde(default)]
    screenshots: Vec<PathBuf>,
}

impl RawStoreMetadata {
    fn validate(self, root: &Path) -> Result<StoreMetadata, ManifestIssue> {
        for tag in &self.tags {
            if tag.trim().is_empty() || tag.chars().any(char::is_control) {
                return Err(ManifestIssue::Field {
                    field: "store.tags",
                    problem: "expected non-empty tags without control characters",
                });
            }
        }
        for url_opt in [&self.homepage, &self.repository] {
            if let Some(url) = url_opt
                && (url.trim().is_empty() || url.chars().any(char::is_control))
            {
                return Err(ManifestIssue::Field {
                    field: "store",
                    problem: "store URLs must be non-empty without control characters",
                });
            }
        }
        if let Some(icon) = &self.icon {
            contained_file(root, icon).map_err(ManifestIssue::File)?;
        }
        for shot in &self.screenshots {
            contained_file(root, shot).map_err(ManifestIssue::File)?;
        }
        Ok(StoreMetadata {
            category: self.category,
            tags: self.tags,
            homepage: self.homepage,
            repository: self.repository,
            icon: self.icon,
            screenshots: self.screenshots,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawBuildMetadata {
    manifest: PathBuf,
    shared_runtime_abi: String,
}

impl RawBuildMetadata {
    fn validate(self, root: &Path) -> Result<(BuildMetadata, BuildManifest), ManifestIssue> {
        let shared_runtime_abi: SharedRuntimeAbi =
            self.shared_runtime_abi
                .parse()
                .map_err(|_| ManifestIssue::Field {
                    field: "build.shared_runtime_abi",
                    problem: "expected <major>.<minor> without leading zeros",
                })?;
        let manifest_path = contained_file(root, &self.manifest).map_err(ManifestIssue::File)?;
        let raw_json =
            fs::read_to_string(&manifest_path).map_err(|err| ManifestIssue::File(err.into()))?;
        let build_manifest: BuildManifest =
            serde_json::from_str(&raw_json).map_err(|_| ManifestIssue::Field {
                field: "build.manifest",
                problem: "invalid build manifest JSON",
            })?;
        if build_manifest.schema_version != 1 {
            return Err(ManifestIssue::Field {
                field: "build.manifest",
                problem: "unsupported build manifest schema_version",
            });
        }
        if build_manifest.shared_runtime_abi != shared_runtime_abi {
            return Err(ManifestIssue::Field {
                field: "build.manifest",
                problem: "build manifest shared_runtime_abi does not match [build]",
            });
        }
        for (rel, expected_digest) in &build_manifest.files {
            if rel.to_ascii_lowercase().ends_with(".qjsb") {
                return Err(ManifestIssue::Field {
                    field: "build.manifest",
                    problem: "remote or bundled .qjsb bytecode files are forbidden",
                });
            }
            if !is_valid_sha256_digest(expected_digest) {
                return Err(ManifestIssue::Field {
                    field: "build.manifest",
                    problem: "invalid sha256 file digest in build manifest",
                });
            }
            let file_path = contained_file(root, Path::new(rel)).map_err(ManifestIssue::File)?;
            let actual = sha256_file(&file_path).map_err(|err| ManifestIssue::File(err.into()))?;
            if &actual != expected_digest {
                return Err(ManifestIssue::Field {
                    field: "build.manifest",
                    problem: "build manifest file digest mismatch",
                });
            }
        }
        Ok((
            BuildMetadata {
                manifest: self.manifest,
                shared_runtime_abi,
            },
            build_manifest,
        ))
    }
}

fn is_valid_sha256_digest(digest: &str) -> bool {
    crate::digest::is_valid_sha256(digest)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    id: String,
    name: String,
    version: String,
    plugin_api: i64,
    author: Option<String>,
    license: Option<String>,
    description: Option<String>,
    min_shell_version: Option<String>,
    #[serde(default)]
    dependencies: Vec<String>,
    store: Option<TableOnly<RawStoreMetadata>>,
    build: Option<TableOnly<RawBuildMetadata>>,
    #[serde(default)]
    host_capabilities: TableOnly<RawHostCapabilities>,
    #[serde(default)]
    bus_permissions: TableOnly<RawBusPermissions>,
    #[serde(default)]
    setting: Vec<TableOnly<RawSetting>>,
    #[serde(default)]
    widget: Vec<TableOnly<RawEntry>>,
    #[serde(default)]
    shortcut: Vec<TableOnly<RawEntry>>,
    #[serde(default)]
    panel: Vec<TableOnly<RawEntry>>,
    #[serde(default)]
    service: Vec<TableOnly<RawEntry>>,
    #[serde(default)]
    launcher_provider: Vec<TableOnly<RawEntry>>,
    #[serde(default)]
    settings_page: Vec<TableOnly<RawEntry>>,
    #[serde(default)]
    layer: Vec<TableOnly<RawEntry>>,
}

impl RawManifest {
    fn validate(self, root: &Path) -> Result<Manifest, ManifestIssue> {
        let id = PluginId::try_new(self.id).map_err(|_| ManifestIssue::Field {
            field: "id",
            problem: "expected a canonical author/plugin identifier",
        })?;
        if self.name.trim().is_empty() {
            return Err(ManifestIssue::Field {
                field: "name",
                problem: "expected a non-empty display name",
            });
        }
        if !valid_version(&self.version) {
            return Err(ManifestIssue::Field {
                field: "version",
                problem: "expected MAJOR.MINOR.PATCH without leading zeros",
            });
        }
        if let Some(min_ver) = &self.min_shell_version
            && !valid_version(min_ver)
        {
            return Err(ManifestIssue::Field {
                field: "min_shell_version",
                problem: "expected MAJOR.MINOR.PATCH without leading zeros",
            });
        }
        let plugin_api = u32::try_from(self.plugin_api)
            .ok()
            .filter(|level| (1..=SUPPORTED_PLUGIN_API_LEVEL).contains(level))
            .ok_or(ManifestIssue::Field {
                field: "plugin_api",
                problem: "unsupported plugin API level",
            })?;
        let store = self
            .store
            .map(|TableOnly(meta)| meta.validate(root))
            .transpose()?;
        let (build, build_manifest) = match (plugin_api >= 2, self.build) {
            (true, None) => {
                return Err(ManifestIssue::Field {
                    field: "build",
                    problem: "plugin_api >= 2 requires a [build] table",
                });
            }
            (false, Some(_)) => {
                return Err(ManifestIssue::Field {
                    field: "build",
                    problem: "[build] requires plugin_api >= 2",
                });
            }
            (true, Some(TableOnly(raw_build))) => {
                let (b, bm) = raw_build.validate(root)?;
                (Some(b), Some(bm))
            }
            (false, None) => (None, None),
        };
        let capabilities = CapabilityBundle {
            host: self.host_capabilities.0.validate()?,
            bus: self.bus_permissions.0.validate()?,
        };
        let settings = Settings::validate(Scope::Plugin(&id), self.setting)?;
        let groups = [
            (PluginEntryKind::Widget, "widget.id", self.widget),
            (PluginEntryKind::Shortcut, "shortcut.id", self.shortcut),
            (PluginEntryKind::Panel, "panel.id", self.panel),
            (PluginEntryKind::Service, "service.id", self.service),
            (
                PluginEntryKind::LauncherProvider,
                "launcher_provider.id",
                self.launcher_provider,
            ),
            (
                PluginEntryKind::SettingsPage,
                "settings_page.id",
                self.settings_page,
            ),
            (PluginEntryKind::Layer, "layer.id", self.layer),
        ];
        let mut entries =
            Vec::with_capacity(groups.iter().map(|(_, _, entries)| entries.len()).sum());
        for (kind, id_field, group) in groups {
            for TableOnly(entry) in group {
                entries.push(entry.validate(
                    root,
                    &id,
                    kind,
                    id_field,
                    plugin_api,
                    build_manifest.as_ref(),
                )?);
            }
        }
        let mut ids = BTreeSet::new();
        for entry in &entries {
            if !ids.insert(&entry.id) {
                return Err(ManifestIssue::DuplicateEntry(entry.id.clone()));
            }
        }
        Ok(Manifest {
            id,
            name: self.name,
            version: self.version,
            plugin_api,
            author: self.author,
            license: self.license.unwrap_or_else(|| "MIT".to_owned()),
            description: self.description,
            min_shell_version: self.min_shell_version,
            dependencies: self.dependencies,
            store,
            build,
            build_manifest,
            capabilities,
            entries,
            settings,
        })
    }
}

fn is_decimal_part(part: &str) -> bool {
    !part.is_empty()
        && (part.len() == 1 || !part.starts_with('0'))
        && part.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_version(version: &str) -> bool {
    let mut parts = version.split('.');
    (0..3).all(|_| parts.next().is_some_and(is_decimal_part)) && parts.next().is_none()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEntry {
    id: String,
    entry: Option<PathBuf>,
    bundle: Option<PathBuf>,
    #[serde(default)]
    styles: Vec<PathBuf>,
    default_zone: Option<BarZone>,
    title: Option<String>,
    description: Option<String>,
    width_tier: Option<PanelWidthTier>,
    #[serde(default)]
    setting: Vec<TableOnly<RawSetting>>,
}

impl RawEntry {
    fn validate(
        self,
        root: &Path,
        plugin: &PluginId,
        kind: PluginEntryKind,
        id_field: &'static str,
        plugin_api: u32,
        build_manifest: Option<&BuildManifest>,
    ) -> Result<ManifestEntry, ManifestIssue> {
        let id = PluginEntryId::try_new(format!("{plugin}:{}", self.id)).map_err(|_| {
            ManifestIssue::Field {
                field: id_field,
                problem: "expected a valid entry slug with a qualified id of at most 128 bytes",
            }
        })?;
        if self.width_tier.is_some() && kind != PluginEntryKind::Panel {
            return Err(ManifestIssue::Field {
                field: "width_tier",
                problem: "width_tier is only valid on [[panel]] entries",
            });
        }
        if self.default_zone.is_some() && kind != PluginEntryKind::Widget {
            return Err(ManifestIssue::Field {
                field: "default_zone",
                problem: "default_zone is only valid on [[widget]] entries",
            });
        }
        let primary_path = if plugin_api >= 2 {
            if let Some(entry) = &self.entry {
                check_relative_syntax(entry).map_err(|issue| ManifestIssue::EntryFile {
                    id: id.clone(),
                    issue,
                })?;
            }
            let Some(bundle) = &self.bundle else {
                return Err(ManifestIssue::Field {
                    field: "bundle",
                    problem: "plugin_api >= 2 entries require a prebuilt bundle path",
                });
            };
            let bundle_str = bundle.to_string_lossy();
            if bundle_str.to_ascii_lowercase().ends_with(".qjsb") || !bundle_str.ends_with(".mjs") {
                return Err(ManifestIssue::Field {
                    field: "bundle",
                    problem: "bundle must be a prebuilt .mjs module (never .qjsb)",
                });
            }
            contained_file(root, bundle).map_err(|issue| ManifestIssue::EntryFile {
                id: id.clone(),
                issue,
            })?;
            let build = build_manifest.ok_or(ManifestIssue::Field {
                field: "build.manifest",
                problem: "missing build manifest",
            })?;
            let normalized_bundle = normalize_rel_key(bundle);
            if !build.files.contains_key(&normalized_bundle) {
                return Err(ManifestIssue::Field {
                    field: "bundle",
                    problem: "bundle path must be registered in dist/manifest.build.json",
                });
            }
            for style in &self.styles {
                let style_str = style.to_string_lossy();
                if !style_str.ends_with(".css") {
                    return Err(ManifestIssue::Field {
                        field: "styles",
                        problem: "plugin styles must be .css files",
                    });
                }
                contained_file(root, style).map_err(|issue| ManifestIssue::EntryFile {
                    id: id.clone(),
                    issue,
                })?;
                let normalized_style = normalize_rel_key(style);
                if !build.files.contains_key(&normalized_style) {
                    return Err(ManifestIssue::Field {
                        field: "styles",
                        problem: "style path must be registered in dist/manifest.build.json",
                    });
                }
            }
            bundle.clone()
        } else {
            if self.bundle.is_some() || !self.styles.is_empty() {
                return Err(ManifestIssue::Field {
                    field: "bundle",
                    problem: "bundle and styles require plugin_api >= 2",
                });
            }
            let Some(entry) = &self.entry else {
                return Err(ManifestIssue::Field {
                    field: "entry",
                    problem: "plugin_api = 1 entries require an entry path",
                });
            };
            contained_file(root, entry).map_err(|issue| ManifestIssue::EntryFile {
                id: id.clone(),
                issue,
            })?;
            entry.clone()
        };
        let settings = Settings::validate(Scope::Entry(&id), self.setting)?;
        Ok(ManifestEntry {
            id,
            kind,
            path: primary_path,
            bundle: self.bundle,
            styles: self.styles,
            default_zone: self.default_zone,
            title: self.title,
            description: self.description,
            width_tier: self.width_tier,
            settings,
        })
    }
}

fn normalize_rel_key(path: &Path) -> String {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawClipboardCapabilities {
    read_outside_gesture: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawSqliteCapabilities {
    databases: BTreeSet<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawFilesCapabilities {
    directories: BTreeSet<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawNetworkOriginRule {
    origin: String,
    #[serde(default)]
    allow_insecure_http: bool,
    #[serde(default)]
    allow_private_networks: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawHostCapabilities {
    commands: BTreeSet<String>,
    image_prefixes: BTreeSet<String>,
    unix_sockets: BTreeSet<String>,
    named_sockets: BTreeSet<String>,
    shell_surfaces: bool,
    control_channel: bool,
    clipboard: TableOnly<RawClipboardCapabilities>,
    sqlite: TableOnly<RawSqliteCapabilities>,
    files: TableOnly<RawFilesCapabilities>,
    network_origins: Vec<TableOnly<RawNetworkOriginRule>>,
}

impl RawHostCapabilities {
    fn validate(self) -> Result<HostCapabilities, ManifestIssue> {
        let mut seen_origins = BTreeSet::new();
        let mut network_origins = BTreeSet::new();
        for TableOnly(rule) in self.network_origins {
            if !valid_http_origin(&rule.origin) {
                return Err(ManifestIssue::Field {
                    field: "host_capabilities.network_origins.origin",
                    problem: "expected a normalized http(s)://host[:port] origin without path or query",
                });
            }
            if rule.origin.starts_with("http://") && !rule.allow_insecure_http {
                return Err(ManifestIssue::Field {
                    field: "host_capabilities.network_origins",
                    problem: "http:// origins require allow_insecure_http = true",
                });
            }
            if !seen_origins.insert(rule.origin.clone()) {
                return Err(ManifestIssue::Field {
                    field: "host_capabilities.network_origins.origin",
                    problem: "duplicate network origin rule",
                });
            }
            network_origins.insert(NetworkOriginRule {
                origin: rule.origin,
                allow_insecure_http: rule.allow_insecure_http,
                allow_private_networks: rule.allow_private_networks,
            });
        }
        Ok(HostCapabilities {
            commands: host_list(
                self.commands,
                "host_capabilities.commands",
                |command| {
                    command.chars().any(|ch| ch != ' ') && !command.chars().any(char::is_control)
                },
                "expected a non-empty command without control characters",
            )?,
            image_prefixes: host_list(
                self.image_prefixes,
                "host_capabilities.image_prefixes",
                canonical_host_path,
                "expected a canonical absolute path or constrained runtime path template",
            )?,
            unix_sockets: host_list(
                self.unix_sockets,
                "host_capabilities.unix_sockets",
                canonical_host_path,
                "expected a canonical absolute path or constrained runtime path template",
            )?,
            named_sockets: host_list(
                self.named_sockets,
                "host_capabilities.named_sockets",
                valid_named_socket,
                "expected a valid named socket identifier (1..=64 ASCII letters, digits, _, - starting with a letter)",
            )?,
            shell_surfaces: self.shell_surfaces,
            control_channel: self.control_channel,
            clipboard: ClipboardCapabilities {
                read_outside_gesture: self.clipboard.0.read_outside_gesture,
            },
            sqlite: SqliteCapabilities {
                databases: host_list(
                    self.sqlite.0.databases,
                    "host_capabilities.sqlite.databases",
                    |db| {
                        !db.is_empty()
                            && db.len() <= 64
                            && db
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
                    },
                    "expected valid SQLite database identifiers",
                )?,
            },
            files: FilesCapabilities {
                directories: host_list(
                    self.files.0.directories,
                    "host_capabilities.files.directories",
                    canonical_host_path,
                    "expected a canonical absolute path or constrained runtime path template",
                )?,
            },
            network_origins,
        })
    }
}

fn valid_http_origin(origin: &str) -> bool {
    let Some(rest) = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
    else {
        return false;
    };
    !rest.is_empty()
        && !rest.contains('/')
        && !rest.contains('?')
        && !rest.contains('#')
        && !rest.contains('@')
        && !rest.chars().any(|ch| ch.is_whitespace() || ch.is_control())
}

fn host_list(
    values: BTreeSet<String>,
    field: &'static str,
    is_valid: impl Fn(&str) -> bool,
    problem: &'static str,
) -> Result<BTreeSet<String>, ManifestIssue> {
    if values.iter().any(|value| !is_valid(value)) {
        return Err(ManifestIssue::Field { field, problem });
    }
    Ok(values)
}

fn valid_named_socket(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_alphabetic()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'-'))
}

fn canonical_host_path(path: &str) -> bool {
    if path == "/" {
        return true;
    }
    if path.chars().any(|ch| ch == '\\' || ch.is_control()) {
        return false;
    }
    let mut parts = path.split('/');
    let Some(root) = parts.next() else {
        return false;
    };
    let is_template = matches!(root, "$XDG_RUNTIME_DIR" | "$HOME" | "$XDG_DATA_HOME");
    if !root.is_empty() && !is_template {
        return false;
    }
    parts.all(|part| {
        !matches!(part, "" | "." | "..")
            && (!is_template
                || part == "$WAYLAND_DISPLAY"
                || !part.replace("${WAYLAND_DISPLAY}", "").contains('$'))
    })
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct RawBusPermissions {
    topics_read: BTreeSet<String>,
    topics_publish: BTreeSet<String>,
    commands_register: BTreeSet<String>,
    inhibitors: bool,
}

impl RawBusPermissions {
    fn validate(self) -> Result<BusPermissions, ManifestIssue> {
        if self.topics_read.contains("") {
            return Err(ManifestIssue::Field {
                field: "bus_permissions.topics_read",
                problem: "expected a non-empty topic name",
            });
        }
        for (field, values) in [
            ("bus_permissions.topics_publish", &self.topics_publish),
            ("bus_permissions.commands_register", &self.commands_register),
        ] {
            if values.iter().any(|value| !value.starts_with("plugin.")) {
                return Err(ManifestIssue::Field {
                    field,
                    problem: "expected the plugin. namespace",
                });
            }
        }
        Ok(BusPermissions {
            topics_read: self.topics_read,
            topics_publish: self.topics_publish,
            commands_register: self.commands_register,
            inhibitors: self.inhibitors,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSetting {
    key: String,
    #[serde(rename = "type")]
    kind: SettingKind,
    default: Value,
    min: Option<Value>,
    max: Option<Value>,
    #[serde(default)]
    secret: bool,
}

#[derive(Clone, Copy)]
enum SettingKind {
    String,
    Integer,
    Number,
    Boolean,
}

impl<'de> Deserialize<'de> for SettingKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "string" => Ok(Self::String),
            "integer" => Ok(Self::Integer),
            "number" => Ok(Self::Number),
            "boolean" => Ok(Self::Boolean),
            _ => Err(de::Error::custom(SETTING_TYPE_EXPECTATION)),
        }
    }
}

struct Settings(BTreeMap<String, Setting>);

impl fmt::Debug for Settings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Settings").finish_non_exhaustive()
    }
}

struct Setting {
    kind: SettingKind,
    default: Value,
    min: Option<Numeric>,
    max: Option<Numeric>,
    secret: bool,
}

#[derive(Clone, Copy)]
enum Scope<'a> {
    Plugin(&'a PluginId),
    Entry(&'a PluginEntryId),
}

impl Scope<'_> {
    fn issue(self, key: &str, problem: &'static str) -> ManifestIssue {
        let scope = match self {
            Self::Plugin(id) => format!("plugin {id}"),
            Self::Entry(id) => format!("entry {id}"),
        };
        ManifestIssue::Setting {
            scope,
            key: key.to_owned(),
            problem,
        }
    }
}

impl Settings {
    fn validate(scope: Scope<'_>, raw: Vec<TableOnly<RawSetting>>) -> Result<Self, ManifestIssue> {
        let mut settings = BTreeMap::new();
        for TableOnly(RawSetting {
            key,
            kind,
            default,
            min,
            max,
            secret,
        }) in raw
        {
            if key.trim().is_empty() {
                return Err(scope.issue(&key, "expected a non-empty key"));
            }
            let slot = match settings.entry(key) {
                Entry::Vacant(slot) => slot,
                Entry::Occupied(slot) => {
                    return Err(scope.issue(slot.key(), "duplicate declaration"));
                }
            };
            let setting = Setting::validate(kind, default, min.as_ref(), max.as_ref(), secret)
                .map_err(|problem| scope.issue(slot.key(), problem))?;
            slot.insert(setting);
        }
        Ok(Self(settings))
    }

    fn public_values(&self, scope: Scope<'_>, overrides: &Table) -> Result<Table, ManifestIssue> {
        for (key, value) in overrides {
            let setting = self
                .0
                .get(key)
                .ok_or_else(|| scope.issue(key, "undeclared key"))?;
            setting
                .check_value(value)
                .map_err(|problem| scope.issue(key, problem))?;
        }
        Ok(self
            .0
            .iter()
            .filter(|(_, setting)| !setting.secret)
            .map(|(key, setting)| {
                (
                    key.clone(),
                    overrides.get(key).unwrap_or(&setting.default).clone(),
                )
            })
            .collect())
    }
}

impl Setting {
    fn validate(
        kind: SettingKind,
        default: Value,
        min: Option<&Value>,
        max: Option<&Value>,
        secret: bool,
    ) -> Result<Self, &'static str> {
        if (min.is_some() || max.is_some())
            && !matches!(kind, SettingKind::Integer | SettingKind::Number)
        {
            return Err("bounds are only allowed on numeric settings");
        }
        let min = min
            .map(|v| parse_bound(kind, v))
            .transpose()
            .map_err(|_| "minimum must match the setting numeric type and be finite")?;
        let max = max
            .map(|v| parse_bound(kind, v))
            .transpose()
            .map_err(|_| "maximum must match the setting numeric type and be finite")?;
        if let (Some(min), Some(max)) = (min, max)
            && max.less_than(min)
        {
            return Err("minimum exceeds maximum");
        }
        let setting = Self {
            kind,
            default,
            min,
            max,
            secret,
        };
        setting.check_value(&setting.default)?;
        Ok(setting)
    }

    fn check_value(&self, value: &Value) -> Result<(), &'static str> {
        let number = match (self.kind, value) {
            (SettingKind::String, Value::String(_)) | (SettingKind::Boolean, Value::Boolean(_)) => {
                return Ok(());
            }
            (SettingKind::Integer | SettingKind::Number, Value::Integer(n)) => Numeric::Integer(*n),
            (SettingKind::Number, Value::Float(n)) if n.is_finite() => Numeric::Float(*n),
            (SettingKind::String, _) => return Err("expected a string"),
            (SettingKind::Boolean, _) => return Err("expected a boolean"),
            (SettingKind::Integer, _) => return Err("expected an integer"),
            (SettingKind::Number, _) => return Err("expected a finite number"),
        };
        if self.min.is_some_and(|min| number.less_than(min)) {
            return Err("value is below the minimum");
        }
        if self.max.is_some_and(|max| max.less_than(number)) {
            return Err("value is above the maximum");
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum Numeric {
    Integer(i64),
    Float(f64),
}

impl TryFrom<&Value> for Numeric {
    type Error = ();

    fn try_from(value: &Value) -> Result<Self, Self::Error> {
        match value {
            Value::Integer(n) => Ok(Self::Integer(*n)),
            Value::Float(n) if n.is_finite() => Ok(Self::Float(*n)),
            _ => Err(()),
        }
    }
}

fn parse_bound(kind: SettingKind, value: &Value) -> Result<Numeric, ()> {
    match kind {
        SettingKind::Integer => value.as_integer().map(Numeric::Integer).ok_or(()),
        SettingKind::Number => Numeric::try_from(value),
        SettingKind::String | SettingKind::Boolean => Err(()),
    }
}

impl Numeric {
    fn less_than(self, other: Self) -> bool {
        match (self, other) {
            (Self::Integer(a), Self::Integer(b)) => a < b,
            (Self::Float(a), Self::Float(b)) => a < b,
            (Self::Integer(a), Self::Float(b)) => compare_integer_float(a, b).is_lt(),
            (Self::Float(a), Self::Integer(b)) => compare_integer_float(b, a).is_gt(),
        }
    }
}

fn compare_integer_float(integer: i64, float: f64) -> Ordering {
    // Converting a large integer to f64 first could round an out-of-bounds value onto a bound.
    const UPPER_EXCLUSIVE: f64 = 9_223_372_036_854_775_808.0;
    if float >= UPPER_EXCLUSIVE {
        Ordering::Less
    } else if float < -UPPER_EXCLUSIVE {
        Ordering::Greater
    } else {
        integer.cmp(&(float as i64)).then_with(|| {
            let fraction = float.fract();
            if fraction > 0.0 {
                Ordering::Less
            } else if fraction < 0.0 {
                Ordering::Greater
            } else {
                Ordering::Equal
            }
        })
    }
}
