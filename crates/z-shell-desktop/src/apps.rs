//! XDG desktop file indexing, themed icons, and argv-only execution.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use z_shell_protocol::MediaRef;

use crate::assets::{cache_icon, read_bounded};

const DESKTOP_FILE_BYTES: usize = 256 * 1024;
const THEME_FILE_BYTES: usize = 256 * 1024;
const ICON_SIZE: u32 = 48;
const ICON_SUFFIXES: &[&str] = &["png", "svg"];
pub(crate) const MAX_ACTIONS: usize = 16;

pub(crate) type Catalog = BTreeMap<String, App>;

type Sections<'a> = HashMap<&'a str, HashMap<&'a str, &'a str>>;

#[derive(Debug)]
pub(crate) struct App {
    pub(crate) title: String,
    pub(crate) subtitle: Option<String>,
    pub(crate) startup_wm_class: Option<String>,
    pub(crate) icon: Option<MediaRef>,
    pub(crate) actions: Vec<Action>,
    search_name: String,
    search_fields: String,
    exec: Vec<String>,
    working_directory: Option<PathBuf>,
    terminal: bool,
}

#[derive(Debug)]
pub(crate) struct Action {
    pub(crate) id: String,
    pub(crate) title: String,
    exec: Vec<String>,
}

impl App {
    pub(crate) fn command(&self, action: Option<&str>) -> Option<Command> {
        let argv = match action {
            Some(id) => &self.actions.iter().find(|action| action.id == id)?.exec,
            None => &self.exec,
        };
        let (program, args) = argv.split_first()?;
        let mut command = if self.terminal {
            // Use the platform's terminal selection instead of an implicit command shell.
            let mut terminal = Command::new("xdg-terminal-exec");
            terminal.arg("--").arg(program);
            terminal
        } else {
            Command::new(program)
        };
        command.args(args);
        if let Some(path) = &self.working_directory {
            command.current_dir(path);
        }
        Some(command)
    }

    pub(crate) fn score(&self, terms: &[&str]) -> Option<u32> {
        if terms.is_empty() {
            return Some(0);
        }
        let mut total = 0;
        for &term in terms {
            let name = fuzzy_score(&self.search_name, term);
            let score = match name {
                Some(score) if score >= 500 => score,
                _ => name.max(fuzzy_score(&self.search_fields, term).map(|score| score / 2))?,
            };
            total += score;
        }
        Some(total / u32::try_from(terms.len()).expect("query is bounded"))
    }
}

fn fuzzy_score(text: &str, term: &str) -> Option<u32> {
    if text == term {
        return Some(1000);
    }
    if text.starts_with(term) {
        return Some(900);
    }
    if let Some((start, _)) = text
        .match_indices(term)
        .find(|(start, _)| !text[..*start].ends_with(char::is_alphanumeric))
    {
        return Some(800 - penalty(start));
    }
    if let Some(start) = text.find(term) {
        return Some(700 - penalty(start));
    }
    let mut positions = text.char_indices();
    let mut prev = None;
    let mut cost = 0;
    for wanted in term.chars() {
        let (position, found) = positions.find(|&(_, ch)| ch == wanted)?;
        if let Some(end) = prev {
            cost += penalty(position - end);
        } else {
            cost += penalty(position);
        }
        prev = Some(position + found.len_utf8());
    }
    Some(500 - cost.min(400))
}

fn penalty(bytes: usize) -> u32 {
    u32::try_from(bytes.min(100)).expect("penalty is at most 100")
}

/// Resolve application data roots in the precedence order specified by XDG Base Directory.
pub(crate) fn xdg_data_dirs() -> Vec<PathBuf> {
    let home = data_home();
    let configured = env::var_os("XDG_DATA_DIRS").filter(|value| !value.is_empty());
    let system = env::split_paths(
        configured
            .as_deref()
            .unwrap_or(OsStr::new("/usr/local/share:/usr/share")),
    );
    let mut seen = HashSet::new();
    home.into_iter()
        .chain(system.filter(|path| path.is_absolute()))
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

fn data_home() -> Option<PathBuf> {
    absolute_env("XDG_DATA_HOME")
        .or_else(|| absolute_env("HOME").map(|home| home.join(".local/share")))
}

fn absolute_env(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

/// Prefer an explicit theme override or GTK's icon theme, then the freedesktop fallback.
pub(crate) fn icon_theme() -> String {
    if let Ok(theme) = env::var("Z_SHELL_ICON_THEME")
        && simple_component(&theme)
    {
        return theme;
    }
    let root = absolute_env("XDG_CONFIG_HOME")
        .or_else(|| absolute_env("HOME").map(|home| home.join(".config")));
    for version in ["gtk-4.0/settings.ini", "gtk-3.0/settings.ini"] {
        let Some(path) = root.as_deref().map(|root| root.join(version)) else {
            break;
        };
        if let Some(text) = read_text(&path, THEME_FILE_BYTES)
            && let Some(theme) = sections(&text)
                .get("Settings")
                .and_then(|settings| settings.get("gtk-icon-theme-name"))
            && simple_component(theme)
        {
            return (*theme).to_owned();
        }
    }
    "hicolor".to_owned()
}

/// Resolve a single Freedesktop icon name (or absolute path) using optional custom theme roots
/// (such as SNI `IconThemePath`) followed by the configured XDG icon data roots and theme.
pub(crate) fn resolve_icon(
    name: &str,
    data_dirs: &[PathBuf],
    theme: &str,
    extra_theme_dir: Option<&Path>,
    cache_dir: &Path,
) -> Option<MediaRef> {
    if let Some(dir) = extra_theme_dir.filter(|path| path.is_absolute())
        && simple_component(name)
    {
        let explicit = Path::new(name)
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ICON_SUFFIXES.contains(&ext));
        let filenames: Vec<_> = if explicit {
            vec![name.to_owned()]
        } else {
            ICON_SUFFIXES
                .iter()
                .map(|ext| format!("{name}.{ext}"))
                .collect()
        };
        if let Some(found) = filenames
            .iter()
            .find_map(|filename| cache_icon(cache_dir, &dir.join(filename)))
        {
            return Some(found);
        }
        let (extra_dirs, _) = theme_paths(&[dir.to_path_buf()], "hicolor");
        if let Some(found) = extra_dirs.iter().find_map(|base| {
            filenames
                .iter()
                .find_map(|filename| cache_icon(cache_dir, &base.join(filename)))
        }) {
            return Some(found);
        }
    }
    Icons::new(data_dirs, theme, cache_dir).resolve(name)
}

/// Match a notification's `desktop-entry`, `app_icon`, or `app_name` against a scanned `.desktop`
/// catalog and return its already-cached icon `MediaRef`.
pub(crate) fn find_desktop_icon(
    catalog: &Catalog,
    desktop_entry: Option<&str>,
    app_icon: Option<&str>,
    app_name: Option<&str>,
) -> Option<MediaRef> {
    let normalize = |raw: &str| {
        let trimmed = raw.trim();
        let stem = trimmed
            .strip_suffix(".desktop")
            .or_else(|| trimmed.strip_suffix(".DESKTOP"))
            .unwrap_or(trimmed);
        stem.to_lowercase()
    };

    let matches_entry = |id: &str, app: &App, candidate: &str, match_title: bool| {
        let stem = normalize(id);
        if stem == candidate {
            return true;
        }
        if stem
            .rsplit('.')
            .next()
            .is_some_and(|segment| segment == candidate)
        {
            return true;
        }
        if app
            .startup_wm_class
            .as_deref()
            .is_some_and(|wm| wm.eq_ignore_ascii_case(candidate))
        {
            return true;
        }
        match_title && app.title.eq_ignore_ascii_case(candidate)
    };

    for (raw, match_title) in [(desktop_entry, false), (app_icon, false), (app_name, true)] {
        let Some(value) = raw.map(normalize).filter(|v| !v.is_empty()) else {
            continue;
        };
        if let Some(icon) = catalog
            .iter()
            .find(|(id, app)| app.icon.is_some() && matches_entry(id, app, &value, match_title))
            .and_then(|(_, app)| app.icon.clone())
        {
            return Some(icon);
        }
    }
    None
}

pub(crate) fn scan(data_dirs: &[PathBuf], theme: &str, cache_dir: &Path) -> Catalog {
    let mut catalog = Catalog::new();
    let mut seen = HashSet::new();
    let mut icons = Icons::new(data_dirs, theme, cache_dir);
    let locales = locale_candidates();
    let current_desktop = env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    let desktops: Vec<_> = current_desktop
        .split(':')
        .filter(|desktop| !desktop.is_empty())
        .collect();
    let path = env::var_os("PATH");
    let search_path: Vec<_> = path
        .as_ref()
        .into_iter()
        .flat_map(env::split_paths)
        .collect();
    for data_dir in data_dirs {
        let root = data_dir.join("applications");
        let mut files = Vec::new();
        let mut dirs = vec![root.clone()];
        while let Some(dir) = dirs.pop() {
            for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                let path = entry.path();
                if kind.is_dir() {
                    dirs.push(path);
                } else if path.extension().is_some_and(|ext| ext == "desktop")
                    && (kind.is_file() || kind.is_symlink())
                {
                    files.push(path);
                }
            }
        }
        files.sort_unstable();
        for file in files {
            let Some(relative) = file.strip_prefix(&root).ok().and_then(Path::to_str) else {
                continue;
            };
            let id = relative.replace('/', "-");
            // Even a hidden or unusable higher-priority entry masks the same desktop ID below it.
            if id.len() > 256 || !seen.insert(id.clone()) {
                continue;
            }
            if let Some(app) =
                desktop_entry(&file, &id, &locales, &desktops, &search_path, &mut icons)
            {
                catalog.insert(id, app);
            }
        }
    }
    catalog
}

fn desktop_entry(
    file: &Path,
    id: &str,
    locales: &[String],
    desktops: &[&str],
    search_path: &[PathBuf],
    icons: &mut Icons<'_>,
) -> Option<App> {
    let body = read_text(file, DESKTOP_FILE_BYTES)?;
    let sections = sections(&body);
    let main = sections.get("Desktop Entry")?;
    let field = |key| main.get(key).copied();
    if field("Type") != Some("Application")
        || field("Hidden") == Some("true")
        || field("NoDisplay") == Some("true")
        || field("OnlyShowIn")
            .is_some_and(|value| !list(value, ';').any(|entry| desktops.contains(&entry.as_str())))
        || field("NotShowIn")
            .is_some_and(|value| list(value, ';').any(|entry| desktops.contains(&entry.as_str())))
        || field("TryExec").is_some_and(|value| !has_executable(&unescape(value), search_path))
    {
        return None;
    }
    let name = localized(main, "Name", locales).map(unescape)?;
    let title = display_text(&name, 200)?;
    let subtitle = localized(main, "Comment", locales)
        .or_else(|| localized(main, "GenericName", locales))
        .and_then(|value| display_text(&unescape(value), 300));
    let icon_name = field("Icon")
        .map(unescape)
        .filter(|value| !value.is_empty());
    let exec = parse_exec(field("Exec")?)?;
    let working_directory = field("Path")
        .map(unescape)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute());
    let mut actions: Vec<Action> = Vec::new();
    for action_id in field("Actions").into_iter().flat_map(|raw| list(raw, ';')) {
        if action_id.len() > 100
            || !action_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || actions.iter().any(|action| action.id == action_id)
        {
            continue;
        }
        let Some(section) = sections.get(format!("Desktop Action {action_id}").as_str()) else {
            continue;
        };
        let Some(title) =
            localized(section, "Name", locales).and_then(|name| display_text(&unescape(name), 100))
        else {
            continue;
        };
        let Some(exec) = section.get("Exec").and_then(|raw| parse_exec(raw)) else {
            continue;
        };
        actions.push(Action {
            id: action_id,
            title,
            exec,
        });
        if actions.len() == MAX_ACTIONS {
            break;
        }
    }
    let mut search_fields = id.to_lowercase();
    for value in [
        localized(main, "GenericName", locales),
        localized(main, "Keywords", locales),
        field("Categories"),
    ]
    .into_iter()
    .flatten()
    {
        search_fields.push(' ');
        search_fields.extend(
            unescape(value)
                .chars()
                .take(1024)
                .flat_map(char::to_lowercase),
        );
    }
    search_fields.extend(
        exec.iter()
            .flat_map(|arg| [' '].into_iter().chain(arg.chars()))
            .take(1024)
            .flat_map(char::to_lowercase),
    );
    let icon = icon_name.as_deref().and_then(|name| icons.resolve(name));
    let startup_wm_class = field("StartupWMClass")
        .map(unescape)
        .and_then(|value| display_text(&value, 200));
    Some(App {
        search_name: title.to_lowercase(),
        search_fields,
        title,
        subtitle,
        startup_wm_class,
        icon,
        exec,
        actions,
        terminal: field("Terminal") == Some("true"),
        working_directory,
    })
}

fn display_text(text: &str, max_bytes: usize) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut end = text.len().min(max_bytes);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(
        text[..end]
            .chars()
            .map(|ch| if ch.is_control() { ' ' } else { ch })
            .collect(),
    )
}

fn read_text(path: &Path, max_bytes: usize) -> Option<String> {
    String::from_utf8(read_bounded(path, max_bytes)?).ok()
}

fn sections(text: &str) -> Sections<'_> {
    let mut groups = HashMap::<_, HashMap<_, _>>::new();
    let mut group = None;
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(section) = line
            .strip_prefix('[')
            .and_then(|line| line.strip_suffix(']'))
        {
            group = Some(section);
        } else if let Some(section) = group
            && let Some((key, value)) = line.split_once('=')
        {
            groups
                .entry(section)
                .or_default()
                .insert(key.trim_end(), value.trim_start());
        }
    }
    groups
}

fn locale_candidates() -> Vec<String> {
    let value = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(|key| env::var(key).ok().filter(|value| !value.is_empty()))
        .unwrap_or_default();
    let (locale, modifier) = value
        .split_once('@')
        .map_or((value.as_str(), None), |(base, suffix)| {
            (base, Some(suffix))
        });
    let locale = locale.split_once('.').map_or(locale, |(base, _)| base);
    if matches!(locale, "" | "C" | "POSIX") {
        return Vec::new();
    }
    let mut options = Vec::with_capacity(4);
    let (language, territory) = locale
        .split_once('_')
        .map_or((locale, None), |(lang, _)| (lang, Some(locale)));
    for base in territory.into_iter().chain([language]) {
        if let Some(modifier) = modifier {
            options.push(format!("{base}@{modifier}"));
        }
        options.push(base.to_owned());
    }
    options
}

fn localized<'a>(
    section: &HashMap<&'a str, &'a str>,
    key: &str,
    locales: &[String],
) -> Option<&'a str> {
    locales
        .iter()
        .find_map(|locale| section.get(format!("{key}[{locale}]").as_str()).copied())
        .or_else(|| section.get(key).copied())
}

fn list(value: &str, delimiter: char) -> impl Iterator<Item = String> + '_ {
    let mut start = 0;
    let mut escaped = false;
    std::iter::from_fn(move || {
        while start < value.len() {
            let end = value[start..]
                .char_indices()
                .find_map(|(offset, ch)| {
                    if escaped {
                        escaped = false;
                    } else if ch == '\\' {
                        escaped = true;
                    } else if ch == delimiter {
                        return Some(start + offset);
                    }
                    None
                })
                .unwrap_or(value.len());
            let part = value[start..end].trim();
            start = end + delimiter.len_utf8();
            if !part.is_empty() {
                return Some(unescape(part));
            }
        }
        None
    })
}

fn unescape(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('s') => result.push(' '),
                Some('n') => result.push('\n'),
                Some('t') => result.push('\t'),
                Some('r') => result.push('\r'),
                Some(next @ ('\\' | ';')) => result.push(next),
                next => {
                    result.push(ch);
                    result.extend(next);
                }
            }
        } else {
            result.push(ch);
        }
    }
    result
}

fn has_executable(value: &str, search_path: &[PathBuf]) -> bool {
    fn executable(path: &Path) -> bool {
        path.metadata()
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
    }
    let path = Path::new(value);
    if path.is_absolute() {
        executable(path)
    } else {
        simple_component(value) && search_path.iter().any(|dir| executable(&dir.join(path)))
    }
}

fn parse_exec(raw: &str) -> Option<Vec<String>> {
    if raw.contains('\0') {
        return None;
    }
    let mut argv = tokenize_exec(&unescape(raw))?;
    let program = argv.first_mut()?;
    if !strip_fields(program) || program.is_empty() || program.contains('=') {
        return None;
    }
    let mut first = true;
    let mut valid = true;
    argv.retain_mut(|word| {
        if std::mem::take(&mut first) || word.is_empty() {
            return true;
        }
        valid &= strip_fields(word);
        !word.is_empty()
    });
    valid.then_some(argv)
}

fn strip_fields(word: &mut String) -> bool {
    let whole_code = word.len() == 2;
    let mut valid = true;
    let mut percent = false;
    word.retain(|ch| {
        if std::mem::take(&mut percent) {
            match ch {
                '%' => return true,
                'F' | 'U' | 'i' if !whole_code => valid = false,
                // This launcher does not pass files, URLs, or desktop metadata to Exec.
                'f' | 'F' | 'u' | 'U' | 'i' | 'c' | 'k' | 'd' | 'D' | 'n' | 'N' | 'v' | 'm' => {}
                _ => valid = false,
            }
            false
        } else {
            percent = ch == '%';
            !percent
        }
    });
    valid && !percent
}

fn tokenize_exec(value: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                started = true;
                quoted = !quoted;
            }
            '\\' if quoted
                && chars
                    .peek()
                    .is_some_and(|next| matches!(next, '"' | '\\' | '`' | '$')) =>
            {
                word.extend(chars.next());
            }
            ch if !quoted && ch.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            _ => {
                started = true;
                word.push(ch);
            }
        }
    }
    if quoted {
        return None;
    }
    if started {
        words.push(word);
    }
    Some(words)
}

struct Icons<'a> {
    themed: Vec<PathBuf>,
    fallback: Vec<PathBuf>,
    cache_dir: &'a Path,
    resolved: HashMap<String, Option<MediaRef>>,
}

impl<'a> Icons<'a> {
    fn new(data_dirs: &[PathBuf], theme: &str, cache_dir: &'a Path) -> Self {
        let mut roots = Vec::new();
        if data_dirs.first() == data_home().as_ref()
            && let Some(home) = absolute_env("HOME")
        {
            roots.push(home.join(".icons"));
        }
        roots.extend(data_dirs.iter().map(|dir| dir.join("icons")));
        let mut themed = Vec::new();
        let mut seen = HashSet::new();
        let mut themes = VecDeque::from([theme.to_owned()]);
        loop {
            let next = themes
                .pop_front()
                .or_else(|| (!seen.contains("hicolor")).then(|| "hicolor".to_owned()));
            let Some(theme) = next else { break };
            if !simple_component(&theme) || !seen.insert(theme.clone()) {
                continue;
            }
            let (dirs, inherits) = theme_paths(&roots, &theme);
            themed.extend(dirs);
            for parent in inherits.into_iter().rev() {
                // hicolor is the final fallback after all explicit ancestors.
                if parent != "hicolor" {
                    themes.push_front(parent);
                }
            }
        }
        let mut fallback = roots;
        fallback.extend(data_dirs.iter().map(|dir| dir.join("pixmaps")));
        Self {
            themed,
            fallback,
            cache_dir,
            resolved: HashMap::new(),
        }
    }

    fn resolve(&mut self, name: &str) -> Option<MediaRef> {
        if let Some(cached) = self.resolved.get(name) {
            return cached.clone();
        }
        let icon = if Path::new(name).is_absolute() {
            cache_icon(self.cache_dir, Path::new(name))
        } else if simple_component(name) {
            let explicit = Path::new(name)
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ICON_SUFFIXES.contains(&ext));
            let filenames: Vec<_> = if explicit {
                vec![name.to_owned()]
            } else {
                ICON_SUFFIXES
                    .iter()
                    .map(|ext| format!("{name}.{ext}"))
                    .collect()
            };
            self.themed.iter().chain(&self.fallback).find_map(|base| {
                filenames
                    .iter()
                    .find_map(|filename| cache_icon(self.cache_dir, &base.join(filename)))
            })
        } else {
            None
        };
        self.resolved.insert(name.to_owned(), icon.clone());
        icon
    }
}

fn simple_component(value: &str) -> bool {
    !value.is_empty()
        && !value.contains('/')
        && matches!(
            Path::new(value).components().next(),
            Some(Component::Normal(_))
        )
}

fn theme_paths(roots: &[PathBuf], theme: &str) -> (Vec<PathBuf>, Vec<String>) {
    let bases: Vec<_> = roots.iter().map(|root| root.join(theme)).collect();
    let index = bases
        .iter()
        .find_map(|base| read_text(&base.join("index.theme"), THEME_FILE_BYTES));
    let parsed = index.as_deref().map(sections);
    let mut ranked = Vec::new();
    let mut inherits = Vec::new();
    if let Some(parsed) = parsed.as_ref()
        && let Some(entry) = parsed.get("Icon Theme")
    {
        inherits.extend(
            entry
                .get("Inherits")
                .into_iter()
                .flat_map(|value| list(value, ',')),
        );
        let dirs = ["Directories", "ScaledDirectories"]
            .into_iter()
            .filter_map(|key| entry.get(key))
            .flat_map(|value| list(value, ','));
        let mut seen = HashSet::new();
        for dir in dirs {
            if !dir.split('/').all(simple_component) || !seen.insert(dir.clone()) {
                continue;
            }
            let Some(settings) = parsed.get(dir.as_str()) else {
                continue;
            };
            let number = |key| {
                settings
                    .get(key)
                    .and_then(|value| value.parse::<u32>().ok())
            };
            let Some(size) = number("Size") else { continue };
            let scale = number("Scale").unwrap_or(1).max(1);
            let (min, max) = match settings.get("Type").copied().unwrap_or("Threshold") {
                "Fixed" => (size, size),
                "Scalable" => (
                    number("MinSize").unwrap_or(size),
                    number("MaxSize").unwrap_or(size),
                ),
                _ => {
                    let threshold = number("Threshold").unwrap_or(2);
                    (
                        size.saturating_sub(threshold),
                        size.saturating_add(threshold),
                    )
                }
            };
            let scaled_min = min.saturating_mul(scale);
            let scaled_max = max.max(min).saturating_mul(scale);
            let distance = scaled_min
                .saturating_sub(ICON_SIZE)
                .max(ICON_SIZE.saturating_sub(scaled_max));
            for base in &bases {
                ranked.push((distance, scale != 1, base.join(&dir)));
            }
        }
    }
    if ranked.is_empty() {
        // An index is optional for a user overlay; conventional directories still work.
        for base in &bases {
            for (distance, dir) in [(0, "48x48"), (1, "scalable"), (16, "32x32"), (16, "64x64")] {
                ranked.push((distance, false, base.join(dir).join("apps")));
            }
            ranked.push((u32::MAX, false, base.clone()));
        }
    }
    ranked.sort_by_key(|(distance, scaled, _)| (*distance, *scaled));
    (
        ranked.into_iter().map(|(_, _, path)| path).collect(),
        inherits,
    )
}
