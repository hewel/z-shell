//! Static parsing and validation for the `plugin.toml` schema.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, btree_map::Entry};
use std::fmt;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use serde::de::{MapAccess, Visitor, value::MapAccessDeserializer};
use serde::{Deserialize, Deserializer, de};
use thiserror::Error;
use toml::{Table, Value};
use z_shell_protocol::{PluginEntryId, PluginEntryKind, PluginId};

use super::capabilities::{BusPermissions, CapabilityBundle, HostCapabilities};

/// Highest cumulative plugin API level accepted by the shell.
pub const SUPPORTED_PLUGIN_API_LEVEL: u32 = 1;

const SETTING_TYPE_EXPECTATION: &str =
    "expected a setting type of string, integer, number, or boolean";

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
    /// Informational dependency metadata, not commands to execute.
    pub dependencies: Vec<String>,
    /// Requested host capabilities and bus permissions.
    pub capabilities: CapabilityBundle,
    /// Validated plugin entries across all supported kinds.
    pub entries: Vec<ManifestEntry>,
    settings: Settings,
}

impl Manifest {
    /// Reads and validates `plugin.toml` and its entry paths without executing plugin code.
    ///
    /// # Errors
    ///
    /// Fails when the manifest cannot be read or when it or an entry violates the v1 contract.
    pub fn load(root: &Path) -> Result<Self, ManifestError> {
        let root = root.canonicalize().map_err(ManifestIssue::Root)?;
        let path = contained_file(&root, Path::new("plugin.toml")).map_err(ManifestIssue::File)?;
        let source = fs::read_to_string(path).map_err(|err| ManifestIssue::File(err.into()))?;
        let raw: RawManifest =
            toml::from_str(&source).map_err(|err| manifest_parse_issue(&err, &source))?;
        Ok(raw.validate(&root)?)
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

/// A validated static plugin contribution and its entry-scoped settings schema.
#[derive(Debug)]
#[non_exhaustive]
pub struct ManifestEntry {
    /// Canonical identifier, qualified with the owning plugin.
    pub id: PluginEntryId,
    /// Which of the seven contribution kinds this entry implements.
    pub kind: PluginEntryKind,
    /// Entry file path as declared, relative to the plugin root.
    pub path: PathBuf,
    /// Optional human-readable title.
    pub title: Option<String>,
    /// Optional human-readable description.
    pub description: Option<String>,
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

fn contained_file(root: &Path, relative: &Path) -> Result<PathBuf, FileIssue> {
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
    let canonical = root.join(relative).canonicalize()?;
    if canonical == root || !canonical.starts_with(root) {
        return Err(FileIssue::OutsideRoot);
    }
    if !canonical.metadata()?.is_file() {
        return Err(FileIssue::NotRegular);
    }
    Ok(canonical)
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
struct RawManifest {
    id: String,
    name: String,
    version: String,
    plugin_api: i64,
    author: Option<String>,
    license: Option<String>,
    description: Option<String>,
    #[serde(default)]
    dependencies: Vec<String>,
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
        let plugin_api = u32::try_from(self.plugin_api)
            .ok()
            .filter(|level| (1..=SUPPORTED_PLUGIN_API_LEVEL).contains(level))
            .ok_or(ManifestIssue::Field {
                field: "plugin_api",
                problem: "unsupported plugin API level",
            })?;
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
                entries.push(entry.validate(root, &id, kind, id_field)?);
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
            dependencies: self.dependencies,
            capabilities,
            entries,
            settings,
        })
    }
}

fn valid_version(version: &str) -> bool {
    let mut parts = version.split('.');
    (0..3).all(|_| {
        parts.next().is_some_and(|part| {
            !part.is_empty()
                && (part.len() == 1 || !part.starts_with('0'))
                && part.bytes().all(|byte| byte.is_ascii_digit())
        })
    }) && parts.next().is_none()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEntry {
    id: String,
    entry: PathBuf,
    title: Option<String>,
    description: Option<String>,
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
    ) -> Result<ManifestEntry, ManifestIssue> {
        let id = PluginEntryId::try_new(format!("{plugin}:{}", self.id)).map_err(|_| {
            ManifestIssue::Field {
                field: id_field,
                problem: "expected a valid entry slug with a qualified id of at most 128 bytes",
            }
        })?;
        contained_file(root, &self.entry).map_err(|issue| ManifestIssue::EntryFile {
            id: id.clone(),
            issue,
        })?;
        let settings = Settings::validate(Scope::Entry(&id), self.setting)?;
        Ok(ManifestEntry {
            id,
            kind,
            path: self.entry,
            title: self.title,
            description: self.description,
            settings,
        })
    }
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
}

impl RawHostCapabilities {
    fn validate(self) -> Result<HostCapabilities, ManifestIssue> {
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
        })
    }
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
