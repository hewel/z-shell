//! Bus control and offline-capable local plugin management.

use serde_json::{Value, json};
use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;
use z_shell_bus::BusClient;
use z_shell_config::{ConfigStore, ShellPaths};
use z_shell_plugins::registry::{OfflinePolicy, PluginManager, PluginSummary};
use z_shell_protocol::{
    CommandInvokeParams, CommandName, PluginId, ServerMessage, TopicName, methods,
};

const EXIT_USAGE: u8 = 2;
const EXIT_CONNECT: u8 = 3;
const EXIT_RPC: u8 = 4;
const EXIT_PLUGIN: u8 = 1;

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

enum PluginAction {
    List,
    AddPath(PathBuf),
    AddGit { url: String, ref_name: String },
    Enable(PluginId),
    Disable(PluginId),
    Audit(PluginId),
    Approve(PluginId),
    Revoke(PluginId),
    Sync(PluginId),
}

#[derive(Default, PartialEq, Eq)]
struct PluginOptions {
    config_dir: Option<PathBuf>,
    state_dir: Option<PathBuf>,
    offline: bool,
}

struct CliArgs {
    socket_override: Option<PathBuf>,
    use_host_socket: bool,
    json_output: bool,
    command: ParsedCommand,
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
            return match run_plugin(action, options, parsed.json_output) {
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
                println!(
                    "{}",
                    serde_json::to_string_pretty(&topics).expect("topics serialize")
                );
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
                println!(
                    "{}",
                    serde_json::to_string_pretty(&commands).expect("commands serialize")
                );
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
            "--config-dir" | "--state-dir" | "--offline" => {
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
            "--config-dir, --state-dir and --offline require the plugin command".to_owned(),
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
                        std::io::stdin()
                            .read_to_string(&mut stdin_buf)
                            .map_err(|err| {
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
    let mut operation = None;
    let mut id = None;
    let mut path: Option<PathBuf> = None;
    let mut url = None;
    let mut ref_name = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--json" => *json_output = true,
            "--help" | "-h" => return Ok(ParsedCommand::Help),
            "--config-dir" | "--state-dir" | "--offline" => {
                parse_plugin_option(&mut options, &arg, &mut args)?;
            }
            "--path" => set_option(&mut path, &arg, &mut args)?,
            "--git" => set_option(&mut url, &arg, &mut args)?,
            "--ref" => set_option(&mut ref_name, &arg, &mut args)?,
            flag if flag.starts_with('-') => return Err(format!("unknown plugin option {flag:?}")),
            _ if operation.is_none() => operation = Some(arg),
            _ if id.is_none() => id = Some(arg),
            _ => return Err(format!("unexpected plugin argument {arg:?}")),
        }
    }
    let operation = operation
        .ok_or_else(|| "missing plugin subcommand; run 'z-shell plugin --help'".to_owned())?;
    let action = if operation == "add" {
        match (path, url, ref_name, id) {
            (Some(path), None, None, None) => PluginAction::AddPath(path),
            (None, Some(url), ref_name, None) => PluginAction::AddGit {
                url,
                ref_name: ref_name.unwrap_or_else(|| "HEAD".to_owned()),
            },
            _ => {
                return Err(
                    "plugin add requires exactly --path <dir> or --git <url> [--ref <ref>]"
                        .to_owned(),
                );
            }
        }
    } else {
        if path.is_some() || url.is_some() || ref_name.is_some() {
            return Err("--path, --git and --ref require plugin add".to_owned());
        }
        match operation.as_str() {
            "list" if id.is_none() => PluginAction::List,
            "list" => return Err("plugin list does not accept a plugin id".to_owned()),
            "enable" | "disable" | "audit" | "approve" | "revoke" | "sync" => {
                let id = id.ok_or_else(|| format!("plugin {operation} requires a plugin id"))?;
                let id = id.parse::<PluginId>().map_err(|err| err.to_string())?;
                match operation.as_str() {
                    "enable" => PluginAction::Enable(id),
                    "disable" => PluginAction::Disable(id),
                    "audit" => PluginAction::Audit(id),
                    "approve" => PluginAction::Approve(id),
                    "revoke" => PluginAction::Revoke(id),
                    _ => PluginAction::Sync(id),
                }
            }
            _ => return Err(format!("unknown plugin subcommand {operation:?}")),
        }
    };
    Ok(ParsedCommand::Plugin(action, options))
}

fn parse_plugin_option(
    options: &mut PluginOptions,
    flag: &str,
    args: &mut impl Iterator<Item = String>,
) -> Result<(), String> {
    if flag == "--offline" {
        options.offline = true;
    } else {
        let path = if flag == "--config-dir" {
            &mut options.config_dir
        } else {
            &mut options.state_dir
        };
        set_option(path, flag, args)?;
    }
    Ok(())
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

fn run_plugin(
    action: PluginAction,
    options: PluginOptions,
    json_output: bool,
) -> Result<(), String> {
    let paths = ShellPaths::for_local_state(options.config_dir, options.state_dir)
        .map_err(|err| err.to_string())?;
    let offline = options.offline
        || (matches!(&action, PluginAction::AddGit { .. } | PluginAction::Sync(_))
            && ConfigStore::new(paths.clone())
                .load_settings()
                .map_err(|err| err.to_string())?
                .general
                .offline_mode);
    let policy = if offline {
        OfflinePolicy::Offline
    } else {
        OfflinePolicy::Online
    };
    let manager = PluginManager::new(paths);
    let summary = match action {
        PluginAction::List => {
            let plugins = manager.list().map_err(|err| err.to_string())?;
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&plugins).expect("plugin summaries serialize")
                );
            } else {
                for plugin in plugins {
                    print_plugin_summary(&plugin);
                }
            }
            return Ok(());
        }
        PluginAction::Audit(id) => {
            let audit = manager.audit(&id).map_err(|err| err.to_string())?;
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&audit).expect("plugin audit serializes")
                );
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
                println!(
                    "{}",
                    serde_json::to_string_pretty(&audit.diff).expect("capability diff serializes")
                );
            }
            return Ok(());
        }
        PluginAction::AddPath(path) => manager.add_path(&path),
        PluginAction::AddGit { url, ref_name } => manager.add_git(&url, &ref_name, policy),
        PluginAction::Enable(id) => manager.enable(&id),
        PluginAction::Disable(id) => manager.disable(&id),
        PluginAction::Approve(id) => manager.approve(&id),
        PluginAction::Revoke(id) => manager.revoke(&id),
        PluginAction::Sync(id) => manager.sync(&id, policy),
    }
    .map_err(|err| err.to_string())?;
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(&summary).expect("plugin summary serializes")
        );
    } else {
        print_plugin_summary(&summary);
    }
    Ok(())
}

fn print_plugin_summary(plugin: &PluginSummary) {
    let status = if plugin.revoked {
        "revoked"
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

fn print_command_result(result: &z_shell_protocol::CommandInvokeResult, json_output: bool) {
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(result).expect("CommandInvokeResult serializes")
        );
        return;
    }
    if let Some(msg) = &result.message {
        println!("{msg}");
    } else if let Some(data) = &result.data {
        println!(
            "{}",
            serde_json::to_string_pretty(data).expect("command data serializes")
        );
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
  plugin [--config-dir PATH] [--state-dir PATH] [--offline] [--json] <action>
    list                                  List installed plugins
    add --path DIR | --git URL [--ref REF] Install a disabled plugin (Git defaults to HEAD)
    audit <id>                            Check capability approval and pinned content
    approve <id> | revoke <id>            Grant or clear explicit capability approval
    enable <id> | disable <id>           Change whether a plugin is composed
    sync <id>                             Update a plugin from its source"
    );
}
