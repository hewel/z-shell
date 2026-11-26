//! Bus control and offline-capable local plugin & store catalog management.

use serde::Serialize;
use serde_json::{Value, json};
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;
use z_shell_bus::BusClient;
use z_shell_config::{ConfigStore, ShellPaths};
use z_shell_plugins::StoreCategory;
use z_shell_plugins::catalog::CatalogStore;
use z_shell_plugins::registry::{
    DoctorFinding, DoctorSeverity, OfflinePolicy, PluginManager, PluginSummary,
    RemoveSettingsPolicy, StagedUpgrade, UpgradeApprovalMode,
};
use z_shell_protocol::{
    CommandInvokeParams, CommandName, PluginId, ServerMessage, TopicName, methods,
};

const EXIT_USAGE: u8 = 2;
const EXIT_CONNECT: u8 = 3;
const EXIT_RPC: u8 = 4;
const EXIT_PLUGIN: u8 = 1;
const BUS_CONVERGENCE_TIMEOUT: Duration = Duration::from_millis(150);
const PENDING_APPLY_NO_DAEMON_NOTE: &str = "No active z-shelld instance detected; changes are persisted to desired state. Recompose/rebuild the shell (`bun run build:shell`) and start a session to apply them.";
const PENDING_APPLY_STATIC_BUILD_NOTE: &str = "Desired plugin state updated in z-shelld, but runtime overlay hot-reload is inactive (runtime_overlay_supported=false). Recompose/rebuild the shell (`bun run build:shell`) to apply or unload plugin code.";

enum ParsedCommand {
    Help,
    Bus(BusCommand),
    Plugin(PluginAction, PluginOptions),
}

enum BusCommand {
    Status,
    Topics,
    Commands,
    Watch {
        topic: TopicName,
    },
    Msg {
        name: CommandName,
        args: Vec<String>,
        payload: Option<Value>,
    },
}

enum SourcesAction {
    List,
    Refresh(Option<String>),
}

enum UpgradeTarget {
    Single(PluginId),
    All,
}

enum PluginAction {
    List,
    AddPath(PathBuf),
    AddGit {
        url: String,
        ref_name: String,
        subdir: Option<String>,
    },
    AddArchive {
        source: String,
        sha256: String,
    },
    Enable(PluginId),
    Disable(PluginId),
    Audit(PluginId),
    Approve(PluginId),
    Revoke(PluginId),
    Sync(PluginId),
    Remove {
        id: PluginId,
        purge_settings: bool,
    },
    Doctor,
    Sources(SourcesAction),
    Search {
        query: String,
        category: Option<StoreCategory>,
        source: Option<String>,
    },
    Info(PluginId),
    Install {
        id: PluginId,
        version: Option<String>,
        source: Option<String>,
        approve: bool,
        enable: bool,
    },
    Upgrade {
        target: UpgradeTarget,
        source: Option<String>,
        yes: bool,
        approve_capabilities: bool,
    },
}

#[derive(Default, PartialEq, Eq)]
struct PluginOptions {
    config_dir: Option<PathBuf>,
    state_dir: Option<PathBuf>,
    cache_dir: Option<PathBuf>,
    offline: bool,
}

struct CliArgs {
    socket_override: Option<PathBuf>,
    use_host_socket: bool,
    json_output: bool,
    command: ParsedCommand,
}

#[derive(Serialize)]
struct ConvergenceReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    plugin_id: Option<PluginId>,
    apply_status: String,
    desired_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    applied_desired_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<&'static str>,
}

#[derive(Serialize)]
struct MutatedPluginOutput<T: Serialize> {
    #[serde(flatten)]
    payload: T,
    convergence: ConvergenceReport,
}

#[derive(Serialize)]
struct UpgradeSkipped {
    id: PluginId,
    reason: &'static str,
}

#[derive(Serialize)]
struct UpgradeOutput {
    upgraded: Vec<PluginSummary>,
    skipped: Vec<UpgradeSkipped>,
    #[serde(skip_serializing_if = "Option::is_none")]
    convergence: Option<ConvergenceReport>,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let parsed = match parse_args(std::env::args().skip(1)) {
        Ok(args) => args,
        Err((json_output, msg)) => {
            emit_error(json_output, "usage_error", &msg);
            return ExitCode::from(EXIT_USAGE);
        }
    };

    let command = match parsed.command {
        ParsedCommand::Help => {
            print_help();
            return ExitCode::SUCCESS;
        }
        ParsedCommand::Plugin(action, options) => {
            return match run_plugin(action, options, parsed.json_output).await {
                Ok(()) => ExitCode::SUCCESS,
                Err(err) => {
                    emit_error(parsed.json_output, "plugin_error", &err);
                    ExitCode::from(EXIT_PLUGIN)
                }
            };
        }
        ParsedCommand::Bus(command) => command,
    };

    let socket_path = match parsed.socket_override {
        Some(path) => path,
        None => match ShellPaths::from_env() {
            Ok(paths) => {
                if parsed.use_host_socket {
                    paths.host_socket_path().to_path_buf()
                } else {
                    paths.socket_path().to_path_buf()
                }
            }
            Err(err) => {
                emit_error(parsed.json_output, "env_error", &err.to_string());
                return ExitCode::from(EXIT_CONNECT);
            }
        },
    };

    let mut client = match BusClient::connect(&socket_path).await {
        Ok(c) => c,
        Err(err) => {
            emit_error(
                parsed.json_output,
                "connect_error",
                &format!("failed to connect to {}: {err}", socket_path.display()),
            );
            return ExitCode::from(EXIT_CONNECT);
        }
    };

    let result = match command {
        BusCommand::Status => client
            .invoke_command(CommandInvokeParams {
                name: CommandName::try_new("status").expect("valid status command"),
                args: Vec::new(),
                payload: None,
            })
            .await
            .map(|res| print_command_result(&res, parsed.json_output)),
        BusCommand::Topics => client.list_topics().await.map(|topics| {
            if parsed.json_output {
                print_json(&topics);
            } else {
                for entry in topics {
                    println!(
                        "{} (instance {}, rev {})",
                        entry.topic, entry.topic_instance_id, entry.revision
                    );
                }
            }
        }),
        BusCommand::Commands => client.list_commands().await.map(|commands| {
            if parsed.json_output {
                print_json(&commands);
            } else {
                for entry in commands {
                    println!("{} — {}", entry.name, entry.description);
                }
            }
        }),
        BusCommand::Watch { topic } => match client.subscribe(topic).await {
            Ok(snapshot) => {
                println!(
                    "{}",
                    serde_json::to_string(&json!({
                        "event": "snapshot",
                        "snapshot": snapshot,
                    }))
                    .expect("snapshot serializes")
                );
                while let Some(notif) = client.next_notification().await {
                    if let ServerMessage::Notification { method, params } = notif
                        && matches!(
                            method.as_str(),
                            methods::TOPIC_UPDATE | methods::TOPIC_REMOVED | methods::TOPIC_RESET
                        )
                    {
                        println!(
                            "{}",
                            serde_json::to_string(&json!({
                                "event": method,
                                "params": params,
                            }))
                            .expect("notification serializes")
                        );
                        if method == methods::TOPIC_RESET {
                            break;
                        }
                    }
                }
                Ok(())
            }
            Err(err) => Err(err),
        },
        BusCommand::Msg {
            name,
            args,
            payload,
        } => client
            .invoke_command(CommandInvokeParams {
                name,
                args,
                payload,
            })
            .await
            .map(|res| print_command_result(&res, parsed.json_output)),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            emit_error(parsed.json_output, "rpc_error", &err.to_string());
            ExitCode::from(EXIT_RPC)
        }
    }
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<CliArgs, (bool, String)> {
    let mut iter = args.peekable();
    let mut socket_override: Option<PathBuf> = None;
    let mut use_host_socket = false;
    let mut json_output = false;
    let mut plugin_options = PluginOptions::default();

    while let Some(flag) = iter.peek().map(String::as_str) {
        match flag {
            "--socket" => {
                iter.next();
                let path = iter
                    .next()
                    .ok_or_else(|| (json_output, "--socket requires a path".to_owned()))?;
                socket_override = Some(PathBuf::from(path));
            }
            "--host" => {
                iter.next();
                use_host_socket = true;
            }
            "--json" => {
                iter.next();
                json_output = true;
            }
            "--config-dir" | "--state-dir" | "--cache-dir" | "--offline" => {
                let flag = iter.next().expect("peeked plugin option");
                parse_plugin_option(&mut plugin_options, &flag, &mut iter)
                    .map_err(|err| (json_output, err))?;
            }
            "--help" | "-h" => {
                return Ok(CliArgs {
                    socket_override,
                    use_host_socket,
                    json_output,
                    command: ParsedCommand::Help,
                });
            }
            _ => break,
        }
    }

    let Some(subcommand) = iter.next() else {
        return Err((
            json_output,
            "missing subcommand; run 'z-shell --help'".to_owned(),
        ));
    };

    if subcommand == "plugin" {
        if socket_override.is_some() || use_host_socket {
            return Err((
                json_output,
                "--socket and --host do not apply to local plugin commands".to_owned(),
            ));
        }
        let command = parse_plugin_args(iter, plugin_options, &mut json_output)
            .map_err(|err| (json_output, err))?;
        return Ok(CliArgs {
            socket_override,
            use_host_socket,
            json_output,
            command,
        });
    }
    if plugin_options != PluginOptions::default() {
        return Err((
            json_output,
            "--config-dir, --state-dir, --cache-dir and --offline require the plugin command"
                .to_owned(),
        ));
    }

    let command = match subcommand.as_str() {
        "status" => BusCommand::Status,
        "topics" => BusCommand::Topics,
        "commands" => BusCommand::Commands,
        "watch" => {
            let raw_topic = iter.next().ok_or_else(|| {
                (
                    json_output,
                    "z-shell watch requires a topic name".to_owned(),
                )
            })?;
            let topic = TopicName::try_new(raw_topic)
                .map_err(|err| (json_output, format!("invalid topic name: {err}")))?;
            BusCommand::Watch { topic }
        }
        "msg" => {
            let raw_name = iter.next().ok_or_else(|| {
                (
                    json_output,
                    "z-shell msg requires a control command name".to_owned(),
                )
            })?;
            let name = CommandName::try_new(raw_name)
                .map_err(|err| (json_output, format!("invalid command name: {err}")))?;
            let mut positional = Vec::new();
            let mut payload: Option<Value> = None;
            let mut passthrough = false;

            while let Some(arg) = iter.next() {
                if passthrough {
                    positional.push(arg);
                    continue;
                }
                match arg.as_str() {
                    "--" => passthrough = true,
                    "--payload" => {
                        let raw = iter.next().ok_or_else(|| {
                            (json_output, "--payload requires a JSON string".to_owned())
                        })?;
                        payload = Some(serde_json::from_str(&raw).map_err(|err| {
                            (json_output, format!("invalid JSON in --payload: {err}"))
                        })?);
                    }
                    "--payload-stdin" => {
                        let mut stdin_buf = String::new();
                        io::stdin().read_to_string(&mut stdin_buf).map_err(|err| {
                            (
                                json_output,
                                format!("failed reading --payload-stdin: {err}"),
                            )
                        })?;
                        payload = Some(serde_json::from_str(&stdin_buf).map_err(|err| {
                            (
                                json_output,
                                format!("invalid JSON on --payload-stdin: {err}"),
                            )
                        })?);
                    }
                    _ => positional.push(arg),
                }
            }

            BusCommand::Msg {
                name,
                args: positional,
                payload,
            }
        }
        other => {
            return Err((
                json_output,
                format!("unknown subcommand {other:?}; run 'z-shell --help'"),
            ));
        }
    };

    Ok(CliArgs {
        socket_override,
        use_host_socket,
        json_output,
        command: ParsedCommand::Bus(command),
    })
}

fn parse_plugin_args(
    mut args: impl Iterator<Item = String>,
    mut options: PluginOptions,
    json_output: &mut bool,
) -> Result<ParsedCommand, String> {
    let mut positionals: Vec<String> = Vec::new();
    let mut path: Option<PathBuf> = None;
    let mut git_url: Option<String> = None;
    let mut ref_name: Option<String> = None;
    let mut subdir: Option<String> = None;
    let mut archive: Option<String> = None;
    let mut sha256: Option<String> = None;
    let mut purge_settings = false;
    let mut category: Option<StoreCategory> = None;
    let mut source: Option<String> = None;
    let mut version: Option<String> = None;
    let mut approve = false;
    let mut enable = false;
    let mut all = false;
    let mut yes = false;
    let mut approve_capabilities = false;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--json" => *json_output = true,
            "--help" | "-h" => return Ok(ParsedCommand::Help),
            "--config-dir" | "--state-dir" | "--cache-dir" | "--offline" => {
                parse_plugin_option(&mut options, &arg, &mut args)?;
            }
            "--path" => set_option(&mut path, &arg, &mut args)?,
            "--git" => set_option(&mut git_url, &arg, &mut args)?,
            "--ref" => set_option(&mut ref_name, &arg, &mut args)?,
            "--subdir" => set_option(&mut subdir, &arg, &mut args)?,
            "--archive" => set_option(&mut archive, &arg, &mut args)?,
            "--sha256" => set_option(&mut sha256, &arg, &mut args)?,
            "--purge-settings" => purge_settings = true,
            "--category" => {
                let mut raw: Option<String> = None;
                set_option(&mut raw, &arg, &mut args)?;
                let raw = raw.expect("set_option succeeded");
                let parsed: StoreCategory = serde_json::from_value(Value::String(
                    raw.to_ascii_lowercase(),
                ))
                .map_err(|_| {
                    format!(
                        "unknown category {raw:?}; expected widgets, productivity, \
                                 system, appearance, compositor, or launcher"
                    )
                })?;
                if category.replace(parsed).is_some() {
                    return Err("duplicate --category option".to_owned());
                }
            }
            "--source" => set_option(&mut source, &arg, &mut args)?,
            "--version" => set_option(&mut version, &arg, &mut args)?,
            "--approve" => approve = true,
            "--enable" => enable = true,
            "--all" => all = true,
            "--yes" => yes = true,
            "--approve-capabilities" => approve_capabilities = true,
            flag if flag.starts_with('-') => return Err(format!("unknown plugin option {flag:?}")),
            _ => positionals.push(arg),
        }
    }

    let mut pos = positionals.into_iter();
    let operation = pos
        .next()
        .ok_or_else(|| "missing plugin subcommand; run 'z-shell plugin --help'".to_owned())?;

    let ensure_no_add_flags = |op: &str| -> Result<(), String> {
        if path.is_some()
            || git_url.is_some()
            || ref_name.is_some()
            || subdir.is_some()
            || archive.is_some()
            || sha256.is_some()
        {
            return Err(format!(
                "--path, --git, --ref, --subdir, --archive and --sha256 do not apply to plugin {op}"
            ));
        }
        Ok(())
    };

    let action = match operation.as_str() {
        "add" => {
            if pos.next().is_some()
                || purge_settings
                || category.is_some()
                || source.is_some()
                || version.is_some()
                || approve
                || enable
                || all
                || yes
                || approve_capabilities
            {
                return Err("unexpected argument or flag for plugin add".to_owned());
            }
            match (path, git_url, ref_name, subdir, archive, sha256) {
                (Some(path), None, None, None, None, None) => PluginAction::AddPath(path),
                (None, Some(url), ref_name, subdir, None, None) => PluginAction::AddGit {
                    url,
                    ref_name: ref_name.unwrap_or_else(|| "HEAD".to_owned()),
                    subdir,
                },
                (None, None, None, None, Some(src), Some(sha)) => PluginAction::AddArchive {
                    source: src,
                    sha256: sha,
                },
                _ => {
                    return Err(
                        "plugin add requires --path <dir>, --git <url> [--ref <ref>] [--subdir <dir>], \
                         or --archive <url-or-path> --sha256 <sha256:...>"
                            .to_owned(),
                    );
                }
            }
        }
        "list" | "doctor" => {
            ensure_no_add_flags(&operation)?;
            if pos.next().is_some()
                || purge_settings
                || category.is_some()
                || source.is_some()
                || version.is_some()
                || approve
                || enable
                || all
                || yes
                || approve_capabilities
            {
                return Err(format!(
                    "plugin {operation} does not accept arguments or those flags"
                ));
            }
            if operation == "list" {
                PluginAction::List
            } else {
                PluginAction::Doctor
            }
        }
        "enable" | "disable" | "audit" | "approve" | "revoke" | "sync" | "info" => {
            ensure_no_add_flags(&operation)?;
            if purge_settings
                || category.is_some()
                || source.is_some()
                || version.is_some()
                || approve
                || enable
                || all
                || yes
                || approve_capabilities
            {
                return Err(format!("unsupported flag for plugin {operation}"));
            }
            let id = pos
                .next()
                .ok_or_else(|| format!("plugin {operation} requires a plugin id"))?;
            if pos.next().is_some() {
                return Err(format!("plugin {operation} accepts only one plugin id"));
            }
            let id = id.parse::<PluginId>().map_err(|err| err.to_string())?;
            match operation.as_str() {
                "enable" => PluginAction::Enable(id),
                "disable" => PluginAction::Disable(id),
                "audit" => PluginAction::Audit(id),
                "approve" => PluginAction::Approve(id),
                "revoke" => PluginAction::Revoke(id),
                "sync" => PluginAction::Sync(id),
                _ => PluginAction::Info(id),
            }
        }
        "remove" => {
            ensure_no_add_flags(&operation)?;
            if category.is_some()
                || source.is_some()
                || version.is_some()
                || approve
                || enable
                || all
                || yes
                || approve_capabilities
            {
                return Err("unsupported flag for plugin remove".to_owned());
            }
            let id = pos
                .next()
                .ok_or_else(|| "plugin remove requires a plugin id".to_owned())?;
            if pos.next().is_some() {
                return Err("plugin remove accepts only one plugin id".to_owned());
            }
            let id = id.parse::<PluginId>().map_err(|err| err.to_string())?;
            PluginAction::Remove { id, purge_settings }
        }
        "sources" => {
            ensure_no_add_flags(&operation)?;
            if purge_settings
                || category.is_some()
                || source.is_some()
                || version.is_some()
                || approve
                || enable
                || all
                || yes
                || approve_capabilities
            {
                return Err("unsupported flag for plugin sources".to_owned());
            }
            let sub = pos
                .next()
                .ok_or_else(|| "plugin sources requires 'list' or 'refresh'".to_owned())?;
            match sub.as_str() {
                "list" => {
                    if pos.next().is_some() {
                        return Err("plugin sources list accepts no extra arguments".to_owned());
                    }
                    PluginAction::Sources(SourcesAction::List)
                }
                "refresh" => {
                    let src_id = pos.next();
                    if pos.next().is_some() {
                        return Err(
                            "plugin sources refresh accepts at most one source id".to_owned()
                        );
                    }
                    PluginAction::Sources(SourcesAction::Refresh(src_id))
                }
                other => return Err(format!("unknown plugin sources subcommand {other:?}")),
            }
        }
        "search" => {
            ensure_no_add_flags(&operation)?;
            if purge_settings
                || version.is_some()
                || approve
                || enable
                || all
                || yes
                || approve_capabilities
            {
                return Err("unsupported flag for plugin search".to_owned());
            }
            let query = pos.next().unwrap_or_default();
            if pos.next().is_some() {
                return Err("plugin search accepts at most one query argument".to_owned());
            }
            PluginAction::Search {
                query,
                category,
                source,
            }
        }
        "install" => {
            ensure_no_add_flags(&operation)?;
            if purge_settings || category.is_some() || all || yes || approve_capabilities {
                return Err("unsupported flag for plugin install".to_owned());
            }
            let raw_target = pos
                .next()
                .ok_or_else(|| "plugin install requires a plugin id".to_owned())?;
            if pos.next().is_some() {
                return Err("plugin install accepts only one plugin id".to_owned());
            }
            let (raw_id, shorthand_ver) = match raw_target.split_once('@') {
                Some((left, right)) => {
                    if right.is_empty() {
                        return Err(
                            "plugin install version suffix after '@' must be non-empty".to_owned()
                        );
                    }
                    if version.is_some() {
                        return Err(
                            "plugin install cannot combine '<id>@<version>' with '--version'"
                                .to_owned(),
                        );
                    }
                    (left, Some(right.to_owned()))
                }
                None => (raw_target.as_str(), None),
            };
            let id = raw_id.parse::<PluginId>().map_err(|err| err.to_string())?;
            let version = version.or(shorthand_ver);
            if enable && !approve {
                return Err(
                    "plugin install --enable requires --approve (catalog installs start unapproved)"
                        .to_owned(),
                );
            }
            PluginAction::Install {
                id,
                version,
                source,
                approve,
                enable,
            }
        }
        "upgrade" => {
            ensure_no_add_flags(&operation)?;
            if purge_settings || category.is_some() || version.is_some() || approve || enable {
                return Err("unsupported flag for plugin upgrade".to_owned());
            }
            let maybe_id = pos.next();
            if pos.next().is_some() {
                return Err("plugin upgrade accepts at most one plugin id".to_owned());
            }
            let target = match (maybe_id, all) {
                (Some(raw), false) => {
                    UpgradeTarget::Single(raw.parse::<PluginId>().map_err(|err| err.to_string())?)
                }
                (None, true) => UpgradeTarget::All,
                (Some(_), true) => {
                    return Err("plugin upgrade cannot combine <id> with --all".to_owned());
                }
                (None, false) => {
                    return Err("plugin upgrade requires <id> or --all".to_owned());
                }
            };
            PluginAction::Upgrade {
                target,
                source,
                yes,
                approve_capabilities,
            }
        }
        other => return Err(format!("unknown plugin subcommand {other:?}")),
    };

    Ok(ParsedCommand::Plugin(action, options))
}

fn parse_plugin_option(
    options: &mut PluginOptions,
    flag: &str,
    args: &mut impl Iterator<Item = String>,
) -> Result<(), String> {
    match flag {
        "--offline" => {
            options.offline = true;
            Ok(())
        }
        "--config-dir" => set_option(&mut options.config_dir, flag, args),
        "--state-dir" => set_option(&mut options.state_dir, flag, args),
        "--cache-dir" => set_option(&mut options.cache_dir, flag, args),
        _ => Err(format!("unknown plugin option {flag:?}")),
    }
}

fn set_option<T: From<String>>(
    value: &mut Option<T>,
    flag: &str,
    args: &mut impl Iterator<Item = String>,
) -> Result<(), String> {
    if value.is_some() {
        return Err(format!("duplicate {flag} option"));
    }
    let raw = args
        .next()
        .filter(|arg| !arg.is_empty() && !arg.starts_with("--"))
        .ok_or_else(|| format!("{flag} requires a value"))?;
    *value = Some(raw.into());
    Ok(())
}

async fn run_plugin(
    action: PluginAction,
    options: PluginOptions,
    json_output: bool,
) -> Result<(), String> {
    let allow_session_socket_fallback = options.config_dir.is_none() && options.state_dir.is_none();
    let mut paths = ShellPaths::for_local_state(options.config_dir, options.state_dir)
        .map_err(|err| err.to_string())?;
    if let Some(cache_dir) = options.cache_dir {
        paths = paths.with_cache_dir(cache_dir);
    }
    let settings = ConfigStore::new(paths.clone())
        .load_settings()
        .map_err(|err| err.to_string())?;
    let policy = if options.offline || settings.general.offline_mode {
        OfflinePolicy::Offline
    } else {
        OfflinePolicy::Online
    };

    let manager = PluginManager::new(paths.clone());
    let catalog = CatalogStore::new(paths);

    match action {
        PluginAction::List => {
            let plugins = manager.list().map_err(|err| err.to_string())?;
            if json_output {
                print_json(&plugins);
            } else {
                for plugin in &plugins {
                    print_plugin_summary(plugin);
                }
            }
            Ok(())
        }
        PluginAction::Audit(id) => {
            let audit = manager.audit(&id).map_err(|err| err.to_string())?;
            if json_output {
                print_json(&audit);
            } else {
                print_plugin_summary(&audit.plugin);
                println!(
                    "Content digest: {}",
                    if audit.digest_matches {
                        "matches"
                    } else {
                        "drifted; sync before approving or enabling"
                    }
                );
                print_json(&audit.diff);
            }
            Ok(())
        }
        PluginAction::AddPath(path) => {
            let summary = manager.add_path(&path).map_err(|err| err.to_string())?;
            emit_plugin_summary(&summary, json_output, None);
            Ok(())
        }
        PluginAction::AddGit {
            url,
            ref_name,
            subdir,
        } => {
            let summary = match subdir.as_deref() {
                Some(dir) => manager.add_git_subdir(&url, &ref_name, dir, policy),
                None => manager.add_git(&url, &ref_name, policy),
            }
            .map_err(|err| err.to_string())?;
            emit_plugin_summary(&summary, json_output, None);
            Ok(())
        }
        PluginAction::AddArchive { source, sha256 } => {
            let summary = manager
                .add_archive(&source, &sha256, policy)
                .map_err(|err| err.to_string())?;
            emit_plugin_summary(&summary, json_output, None);
            Ok(())
        }
        PluginAction::Approve(id) => {
            let summary = manager.approve(&id).map_err(|err| err.to_string())?;
            emit_plugin_summary(&summary, json_output, None);
            Ok(())
        }
        PluginAction::Enable(id) => {
            let summary = manager.enable(&id).map_err(|err| err.to_string())?;
            let convergence =
                observe_convergence(&manager, Some(&id), allow_session_socket_fallback).await?;
            emit_plugin_summary(&summary, json_output, Some(convergence));
            Ok(())
        }
        PluginAction::Disable(id) => {
            let summary = manager.disable(&id).map_err(|err| err.to_string())?;
            let convergence =
                observe_convergence(&manager, Some(&id), allow_session_socket_fallback).await?;
            emit_plugin_summary(&summary, json_output, Some(convergence));
            Ok(())
        }
        PluginAction::Revoke(id) => {
            let summary = manager.revoke(&id).map_err(|err| err.to_string())?;
            let convergence =
                observe_convergence(&manager, Some(&id), allow_session_socket_fallback).await?;
            emit_plugin_summary(&summary, json_output, Some(convergence));
            Ok(())
        }
        PluginAction::Sync(id) => {
            let summary = manager.sync(&id, policy).map_err(|err| err.to_string())?;
            let convergence =
                observe_convergence(&manager, Some(&id), allow_session_socket_fallback).await?;
            emit_plugin_summary(&summary, json_output, Some(convergence));
            Ok(())
        }
        PluginAction::Remove { id, purge_settings } => {
            let settings_policy = if purge_settings {
                RemoveSettingsPolicy::PurgeSettings
            } else {
                RemoveSettingsPolicy::KeepSettings
            };
            let removed = manager
                .remove(&id, settings_policy)
                .map_err(|err| err.to_string())?;
            let convergence = observe_convergence_rev(
                removed.desired_revision,
                Some(&id),
                allow_session_socket_fallback,
            )
            .await;
            if json_output {
                print_json(&MutatedPluginOutput {
                    payload: &removed,
                    convergence,
                });
            } else {
                println!(
                    "Removed {} (settings_purged={}, daemon={})",
                    removed.id, removed.settings_purged, convergence.apply_status
                );
            }
            Ok(())
        }
        PluginAction::Doctor => {
            let findings = manager.doctor().map_err(|err| err.to_string())?;
            if json_output {
                print_json(&findings);
            } else if findings.is_empty() {
                println!("No plugin registry or bundle issues detected.");
            } else {
                for finding in &findings {
                    print_doctor_finding(finding);
                }
            }
            Ok(())
        }
        PluginAction::Sources(SourcesAction::List) => {
            if json_output {
                print_json(&settings.plugins.sources);
            } else {
                for src in &settings.plugins.sources {
                    println!(
                        "{} [priority={}, enabled={}] — {} ({})",
                        src.id, src.priority, src.enabled, src.name, src.url
                    );
                }
            }
            Ok(())
        }
        PluginAction::Sources(SourcesAction::Refresh(source_filter)) => {
            let filtered: Vec<_> = match source_filter.as_deref() {
                Some(target) => {
                    let matching: Vec<_> = settings
                        .plugins
                        .sources
                        .iter()
                        .filter(|s| s.id == target)
                        .cloned()
                        .collect();
                    if matching.is_empty() {
                        return Err(format!("catalog source {target:?} not configured"));
                    }
                    matching
                }
                None => settings.plugins.sources.clone(),
            };
            let refreshed = catalog
                .refresh(&filtered, policy)
                .map_err(|err| err.to_string())?;
            if json_output {
                print_json(&refreshed);
            } else {
                for item in &refreshed {
                    println!(
                        "{}: {} plugins (cached={}, stale={})",
                        item.source_id, item.plugin_count, item.cached, item.stale
                    );
                }
            }
            Ok(())
        }
        PluginAction::Search {
            query,
            category,
            source,
        } => {
            let results = catalog
                .search(
                    &settings.plugins.sources,
                    &query,
                    category,
                    source.as_deref(),
                    policy,
                )
                .map_err(|err| err.to_string())?;
            if json_output {
                print_json(&results);
            } else {
                for entry in &results {
                    println!(
                        "{} {} [{} via {}] — {}",
                        entry.id,
                        entry.latest_version,
                        serde_json::to_string(&entry.category)
                            .unwrap_or_default()
                            .trim_matches('"'),
                        entry.preferred_source_id,
                        entry.summary
                    );
                }
            }
            Ok(())
        }
        PluginAction::Info(id) => {
            let detail = catalog
                .detail(&settings.plugins.sources, &id, policy)
                .map_err(|err| err.to_string())?;
            if json_output {
                print_json(&detail);
            } else {
                println!("{} {} — {}", detail.id, detail.latest_version, detail.name);
                println!("Summary: {}", detail.summary);
                for offering in &detail.available_sources {
                    println!(
                        "  source {}: v{} (priority {}, yanked={})",
                        offering.source_id,
                        offering.latest_version,
                        offering.priority,
                        offering.yanked
                    );
                }
            }
            Ok(())
        }
        PluginAction::Install {
            id,
            version,
            source,
            approve,
            enable,
        } => {
            let resolved = catalog
                .resolve_install(
                    &settings.plugins.sources,
                    &id,
                    version.as_deref(),
                    source.as_deref(),
                    policy,
                )
                .map_err(|err| err.to_string())?;
            let outcome = manager
                .install_from_catalog(&resolved, policy)
                .map_err(|err| err.to_string())?;
            let mut summary = outcome.summary;
            if approve {
                summary = manager.approve(&id).map_err(|err| err.to_string())?;
            }
            let convergence = if enable {
                summary = manager.enable(&id).map_err(|err| err.to_string())?;
                Some(observe_convergence(&manager, Some(&id), allow_session_socket_fallback).await?)
            } else {
                None
            };
            if json_output {
                print_json(&json!({
                    "plugin": summary,
                    "resolved_from": outcome.resolved_from,
                    "convergence": convergence,
                }));
            } else {
                print_plugin_summary(&summary);
                if let Some(conv) = &convergence {
                    println!("Daemon convergence: {}", conv.apply_status);
                }
            }
            Ok(())
        }
        PluginAction::Upgrade {
            target,
            source,
            yes,
            approve_capabilities,
        } => {
            run_plugin_upgrade(UpgradeRunConfig {
                manager: &manager,
                catalog: &catalog,
                sources: &settings.plugins.sources,
                policy,
                target,
                explicit_source: source.as_deref(),
                yes,
                approve_capabilities,
                json_output,
                allow_session_socket_fallback,
            })
            .await
        }
    }
}

struct UpgradeRunConfig<'a> {
    manager: &'a PluginManager,
    catalog: &'a CatalogStore,
    sources: &'a [z_shell_config::PluginSourceSettings],
    policy: OfflinePolicy,
    target: UpgradeTarget,
    explicit_source: Option<&'a str>,
    yes: bool,
    approve_capabilities: bool,
    json_output: bool,
    allow_session_socket_fallback: bool,
}

async fn run_plugin_upgrade(cfg: UpgradeRunConfig<'_>) -> Result<(), String> {
    let installed = cfg.manager.list().map_err(|err| err.to_string())?;
    let candidates: Vec<PluginSummary> = match &cfg.target {
        UpgradeTarget::All => installed,
        UpgradeTarget::Single(id) => vec![
            installed
                .into_iter()
                .find(|p| &p.id == id)
                .ok_or_else(|| format!("plugin {id} is not installed"))?,
        ],
    };

    let mut staged_list: Vec<StagedUpgrade> = Vec::new();
    let mut skipped: Vec<UpgradeSkipped> = Vec::new();

    for plugin in candidates {
        let lookup_source = cfg.explicit_source.or(plugin.catalog_source_id.as_deref());
        if lookup_source.is_none() {
            match cfg.target {
                UpgradeTarget::All => {
                    skipped.push(UpgradeSkipped {
                        id: plugin.id,
                        reason: "non_catalog_source",
                    });
                    continue;
                }
                UpgradeTarget::Single(ref id) => {
                    return Err(format!(
                        "plugin {id} was not installed from a catalog source; use `z-shell plugin sync {id}`"
                    ));
                }
            }
        }

        let resolved = cfg
            .catalog
            .resolve_install(cfg.sources, &plugin.id, None, lookup_source, cfg.policy)
            .map_err(|err| err.to_string())?;
        if resolved.release.version == plugin.version
            && resolved.release.content_digest == plugin.content_digest
        {
            skipped.push(UpgradeSkipped {
                id: plugin.id,
                reason: "up_to_date",
            });
            continue;
        }

        let staged = cfg
            .manager
            .stage_upgrade(&plugin.id, &resolved, cfg.policy)
            .map_err(|err| err.to_string())?;
        // `--yes` only bypasses non-expanding confirmations; capability expansion requires either
        // explicit `--approve-capabilities` or interactive `[y/N]` confirmation.
        if staged.requires_reapproval && !cfg.approve_capabilities && cfg.yes {
            return Err(format!(
                "upgrading {} ({} -> {}) requires capability approval; re-run with --approve-capabilities",
                staged.id, staged.from_version, staged.to_version
            ));
        }
        staged_list.push(staged);
    }

    if staged_list.is_empty() {
        let output = UpgradeOutput {
            upgraded: Vec::new(),
            skipped,
            convergence: None,
        };
        if cfg.json_output {
            print_json(&output);
        } else {
            println!("All selected catalog plugins are up to date.");
        }
        return Ok(());
    }

    let mut confirmed_interactively = false;
    if !cfg.yes {
        for staged in &staged_list {
            eprintln!(
                "Upgrade {} {} -> {} ({} -> {}, requires_reapproval={})",
                staged.id,
                staged.from_version,
                staged.to_version,
                staged.from_digest,
                staged.to_digest,
                staged.requires_reapproval
            );
            if staged.diff.requires_approval() {
                eprintln!(
                    "Capability additions: {}",
                    serde_json::to_string_pretty(&staged.diff.added).unwrap_or_default()
                );
            }
        }
        eprint!("Proceed with upgrade? [y/N] ");
        io::stderr().flush().map_err(|err| err.to_string())?;
        let mut line = String::new();
        io::stdin()
            .lock()
            .read_line(&mut line)
            .map_err(|err| err.to_string())?;
        let answer = line.trim().to_ascii_lowercase();
        if answer != "y" && answer != "yes" {
            return Err("upgrade aborted by user".to_owned());
        }
        confirmed_interactively = true;
    }

    let mut upgraded = Vec::with_capacity(staged_list.len());
    for staged in &staged_list {
        let approval_mode = if cfg.approve_capabilities
            || (confirmed_interactively && staged.requires_reapproval)
        {
            UpgradeApprovalMode::ApproveExpanded
        } else {
            UpgradeApprovalMode::KeepExistingOnly
        };
        let summary = cfg
            .manager
            .commit_upgrade(
                staged,
                &staged.from_digest,
                &staged.to_digest,
                approval_mode,
            )
            .map_err(|err| err.to_string())?;
        upgraded.push(summary);
    }

    let target_plugin = if upgraded.len() == 1 {
        Some(&upgraded[0].id)
    } else {
        None
    };
    let convergence = observe_convergence(
        cfg.manager,
        target_plugin,
        cfg.allow_session_socket_fallback,
    )
    .await?;
    let output = UpgradeOutput {
        upgraded,
        skipped,
        convergence: Some(convergence),
    };
    if cfg.json_output {
        print_json(&output);
    } else {
        for summary in &output.upgraded {
            print_plugin_summary(summary);
        }
        if let Some(conv) = &output.convergence {
            println!("Daemon convergence: {}", conv.apply_status);
        }
    }
    Ok(())
}

async fn observe_convergence(
    manager: &PluginManager,
    target_plugin: Option<&PluginId>,
    allow_session_socket_fallback: bool,
) -> Result<ConvergenceReport, String> {
    let desired_revision = manager.desired_revision().map_err(|err| err.to_string())?;
    Ok(observe_convergence_rev(
        desired_revision,
        target_plugin,
        allow_session_socket_fallback,
    )
    .await)
}

async fn observe_convergence_rev(
    desired_revision: u64,
    target_plugin: Option<&PluginId>,
    allow_session_socket_fallback: bool,
) -> ConvergenceReport {
    let Some(bus_socket) = resolve_public_bus_socket(allow_session_socket_fallback) else {
        return pending_apply_report(
            target_plugin,
            desired_revision,
            None,
            PENDING_APPLY_NO_DAEMON_NOTE,
        );
    };

    let observed = tokio::time::timeout(BUS_CONVERGENCE_TIMEOUT, async {
        let mut client = BusClient::connect(&bus_socket).await.ok()?;
        let plugins_topic = TopicName::try_new("plugins").ok()?;
        let snapshot = client.subscribe(plugins_topic).await.ok()?;
        if snapshot
            .data
            .get("runtime_overlay_supported")
            .and_then(Value::as_bool)
            == Some(false)
        {
            return Some((
                "pending_apply".to_owned(),
                extract_applied_revision(&snapshot.data),
                true,
            ));
        }
        let mut applied_revision = extract_applied_revision(&snapshot.data);
        if applied_revision.is_some_and(|rev| rev >= desired_revision) {
            let status = extract_plugin_runtime_state(&snapshot.data, target_plugin);
            return Some((status, applied_revision, true));
        }

        while let Some(notif) = client.next_notification().await {
            if let ServerMessage::Notification { method, params } = notif
                && method == methods::TOPIC_UPDATE
                && params.get("topic").and_then(Value::as_str) == Some("plugins")
                && let Some(data) = params.get("data")
            {
                if data
                    .get("runtime_overlay_supported")
                    .and_then(Value::as_bool)
                    == Some(false)
                {
                    return Some((
                        "pending_apply".to_owned(),
                        extract_applied_revision(data),
                        true,
                    ));
                }
                if let Some(rev) = extract_applied_revision(data) {
                    applied_revision = Some(rev);
                    if rev >= desired_revision {
                        let status = extract_plugin_runtime_state(data, target_plugin);
                        return Some((status, applied_revision, true));
                    }
                }
            }
        }
        Some(("pending_apply".to_owned(), applied_revision, true))
    })
    .await
    .ok()
    .flatten();

    match observed {
        Some((apply_status, applied_desired_revision, _)) if apply_status != "pending_apply" => {
            ConvergenceReport {
                plugin_id: target_plugin.cloned(),
                apply_status,
                desired_revision,
                applied_desired_revision,
                note: None,
            }
        }
        Some((_, applied_desired_revision, true)) => pending_apply_report(
            target_plugin,
            desired_revision,
            applied_desired_revision,
            PENDING_APPLY_STATIC_BUILD_NOTE,
        ),
        Some((_, applied_desired_revision, false)) => pending_apply_report(
            target_plugin,
            desired_revision,
            applied_desired_revision,
            PENDING_APPLY_NO_DAEMON_NOTE,
        ),
        None => pending_apply_report(
            target_plugin,
            desired_revision,
            None,
            PENDING_APPLY_NO_DAEMON_NOTE,
        ),
    }
}

fn extract_applied_revision(data: &Value) -> Option<u64> {
    data.get("applied_desired_revision")
        .or_else(|| data.get("runtime_revision"))
        .and_then(Value::as_u64)
}

fn extract_plugin_runtime_state(data: &Value, target_plugin: Option<&PluginId>) -> String {
    if data
        .get("runtime_overlay_supported")
        .and_then(Value::as_bool)
        == Some(false)
    {
        return "unknown".to_owned();
    }
    let Some(plugins) = data.get("plugins").and_then(Value::as_array) else {
        return "unknown".to_owned();
    };
    if let Some(target_id) = target_plugin {
        return plugins
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(target_id.as_str()))
            .and_then(|entry| entry.get("runtime_state").and_then(Value::as_str))
            .unwrap_or("unknown")
            .to_owned();
    }
    if !plugins.is_empty()
        && plugins
            .iter()
            .all(|entry| entry.get("runtime_state").and_then(Value::as_str) == Some("active"))
    {
        return "active".to_owned();
    }
    "unknown".to_owned()
}

fn pending_apply_report(
    target_plugin: Option<&PluginId>,
    desired_revision: u64,
    applied_desired_revision: Option<u64>,
    note: &'static str,
) -> ConvergenceReport {
    ConvergenceReport {
        plugin_id: target_plugin.cloned(),
        apply_status: "pending_apply".to_owned(),
        desired_revision,
        applied_desired_revision,
        note: Some(note),
    }
}

fn resolve_public_bus_socket(allow_session_socket_fallback: bool) -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("Z_SHELL_BUS_SOCKET").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(explicit));
    }
    if !allow_session_socket_fallback {
        return None;
    }
    ShellPaths::from_env()
        .ok()
        .map(|paths| paths.socket_path().to_path_buf())
}

fn emit_plugin_summary(
    summary: &PluginSummary,
    json_output: bool,
    convergence: Option<ConvergenceReport>,
) {
    if json_output {
        match convergence {
            Some(conv) => print_json(&MutatedPluginOutput {
                payload: summary,
                convergence: conv,
            }),
            None => print_json(summary),
        }
    } else {
        print_plugin_summary(summary);
        if let Some(conv) = convergence {
            println!("Daemon convergence: {}", conv.apply_status);
        }
    }
}

fn print_plugin_summary(plugin: &PluginSummary) {
    let status = if plugin.revoked {
        "revoked"
    } else if plugin.migration_reapproval_required {
        "reapproval required (v1 migration)"
    } else if !plugin.approved {
        "approval required"
    } else if plugin.enabled {
        "enabled"
    } else {
        "disabled"
    };
    println!(
        "{} {} — {} ({status})",
        plugin.id, plugin.version, plugin.name
    );
}

fn print_doctor_finding(finding: &DoctorFinding) {
    let sev = match finding.severity {
        DoctorSeverity::Info => "info",
        DoctorSeverity::Warning => "warning",
        DoctorSeverity::Error => "error",
        _ => "unknown",
    };
    if let Some(id) = &finding.plugin_id {
        println!("[{sev}] {} ({id}): {}", finding.code, finding.message);
    } else {
        println!("[{sev}] {}: {}", finding.code, finding.message);
    }
}

fn print_json(value: &impl Serialize) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).expect("JSON value serializes")
    );
}

fn print_command_result(result: &z_shell_protocol::CommandInvokeResult, json_output: bool) {
    if json_output {
        print_json(result);
        return;
    }
    if let Some(msg) = &result.message {
        println!("{msg}");
    } else if let Some(data) = &result.data {
        print_json(data);
    }
}

fn emit_error(json_output: bool, code: &str, message: &str) {
    if json_output {
        eprintln!(
            "{}",
            serde_json::to_string(&json!({ "error": { "code": code, "message": message } }))
                .expect("error json serializes")
        );
    } else {
        eprintln!("z-shell: {message}");
    }
}

fn print_help() {
    println!(
        "\
Usage: z-shell [--socket PATH] [--host] [--json] <command>

Commands:
  status                                  Show daemon status summary
  topics                                  List active bus topics and revisions
  commands                                List registered control commands
  watch <topic>                           Stream subscription snapshot and live updates as NDJSON
  msg <name> [args...] [--payload JSON | --payload-stdin] [-- <args...>]
                                          Invoke a core or plugin control command
  plugin [--config-dir PATH] [--state-dir PATH] [--cache-dir PATH] [--offline] [--json] <action>
    list                                  List installed plugins
    add --path DIR | --git URL [--ref REF] [--subdir DIR] | --archive URL_OR_PATH --sha256 DIGEST
                                          Install a disabled plugin bundle
    audit <id>                            Check capability approval, net host delta, and bundle pin
    approve <id> | revoke <id>            Grant or clear explicit capability approval
    enable <id> | disable <id>            Change whether a plugin is composed
    sync <id>                             Update a plugin from its bound source
    remove <id> [--purge-settings]        Uninstall a plugin and optionally purge its settings
    doctor                                Check registry, bundles, and staging directory health
    sources list | sources refresh [id]   List or refresh configured plugin catalog sources
    search [query] [--category CAT] [--source ID]
                                          Search aggregated catalog sources
    info <id>                             Show catalog metadata across sources
    install <id>[@ver] [--version VER] [--source ID] [--approve] [--enable]
                                          Install a plugin release from catalog sources
    upgrade [<id> | --all] [--source ID] [--yes] [--approve-capabilities]
                                          Stage and commit catalog plugin upgrades"
    );
}
