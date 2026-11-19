//! Thin control CLI (`z-shell status|topics|commands|watch|msg`) parsing arguments before connecting.

use serde_json::{Value, json};
use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;
use z_shell_bus::BusClient;
use z_shell_config::ShellPaths;
use z_shell_protocol::{CommandInvokeParams, CommandName, ServerMessage, TopicName, methods};

const EXIT_USAGE: u8 = 2;
const EXIT_CONNECT: u8 = 3;
const EXIT_RPC: u8 = 4;

enum ParsedCommand {
    Help,
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

    if matches!(parsed.command, ParsedCommand::Help) {
        print_help();
        return ExitCode::SUCCESS;
    }

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

    let result = match parsed.command {
        ParsedCommand::Help => Ok(()),
        ParsedCommand::Status => client
            .invoke_command(CommandInvokeParams {
                name: CommandName::try_new("status").expect("valid status command"),
                args: Vec::new(),
                payload: None,
            })
            .await
            .map(|res| print_command_result(&res, parsed.json_output)),
        ParsedCommand::Topics => client.list_topics().await.map(|topics| {
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
        ParsedCommand::Commands => client.list_commands().await.map(|commands| {
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
        ParsedCommand::Watch { topic } => match client.subscribe(topic).await {
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
        ParsedCommand::Msg {
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

    let command = match subcommand.as_str() {
        "status" => ParsedCommand::Status,
        "topics" => ParsedCommand::Topics,
        "commands" => ParsedCommand::Commands,
        "watch" => {
            let raw_topic = iter.next().ok_or_else(|| {
                (
                    json_output,
                    "z-shell watch requires a topic name".to_owned(),
                )
            })?;
            let topic = TopicName::try_new(raw_topic)
                .map_err(|err| (json_output, format!("invalid topic name: {err}")))?;
            ParsedCommand::Watch { topic }
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

            ParsedCommand::Msg {
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
        command,
    })
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
                                          Invoke a core or plugin control command"
    );
}
