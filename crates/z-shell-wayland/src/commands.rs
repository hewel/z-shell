use std::sync::Arc;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use wayland_protocols_wlr::output_power_management::v1::client::zwlr_output_power_v1::Mode;
use z_shell_bus::{BusHub, CommandCall};
use z_shell_protocol::{
    CommandInvokeParams, CommandInvokeResult, CommandName, ErrorCode, MAX_SAFE_JS_INT, RpcError,
};

use crate::outputs::PowerTarget;
use crate::state::State;

#[derive(Clone, Copy)]
enum Action {
    ActivateWorkspace,
    ActivateWindow,
    CloseWindow,
    SetPower,
}

impl Action {
    fn parse(self, params: &CommandInvokeParams) -> Result<Command, RpcError> {
        let selector =
            |name, position| match params.payload.as_ref().and_then(|value| value.get(name)) {
                Some(Value::Number(id)) => id.as_u64().map(Selector::Id),
                Some(Value::String(text)) => Some(Selector::Text(text)),
                Some(_) => None,
                None => params
                    .args
                    .get(position)
                    .map(|text: &String| Selector::Text(text)),
            };
        match self {
            Self::ActivateWorkspace => Ok(Command::ActivateWorkspace(id(
                selector("workspace_id", 0),
                "workspace_id",
            )?)),
            Self::ActivateWindow => Ok(Command::ActivateWindow(id(
                selector("window_id", 0),
                "window_id",
            )?)),
            Self::CloseWindow => Ok(Command::CloseWindow(id(
                selector("window_id", 0),
                "window_id",
            )?)),
            Self::SetPower => {
                let output = selector("output_instance_id", 0);
                let target = match output {
                    Some(Selector::Text("all")) => PowerTarget::All,
                    _ => PowerTarget::Output(id(output, "output_instance_id")?),
                };
                let mode = match selector("mode", 1) {
                    Some(Selector::Text("on")) => Mode::On,
                    Some(Selector::Text("off")) => Mode::Off,
                    _ => {
                        return Err(RpcError::new(
                            ErrorCode::InvalidParams,
                            "mode must be 'on' or 'off'",
                        ));
                    }
                };
                Ok(Command::SetPower(target, mode))
            }
        }
    }
}

enum Selector<'a> {
    Id(u64),
    Text(&'a str),
}

fn id(selector: Option<Selector<'_>>, name: &str) -> Result<u64, RpcError> {
    let id = match selector {
        Some(Selector::Id(id)) => Some(id),
        Some(Selector::Text(text)) => text.parse().ok(),
        None => None,
    };
    id.filter(|&id| (1..=MAX_SAFE_JS_INT).contains(&id))
        .ok_or_else(|| {
            RpcError::new(
                ErrorCode::InvalidParams,
                format!("{name} must be a positive instance ID"),
            )
        })
}

pub(crate) enum Command {
    ActivateWorkspace(u64),
    ActivateWindow(u64),
    CloseWindow(u64),
    SetPower(PowerTarget, Mode),
}

impl Command {
    pub(crate) fn execute(self, state: &State) -> Result<(), RpcError> {
        match self {
            Self::ActivateWorkspace(id) => state.workspaces.activate(id),
            Self::ActivateWindow(id) => state.windows.activate(id),
            Self::CloseWindow(id) => state.windows.close(id),
            Self::SetPower(target, mode) => state.outputs.set_power(target, mode),
        }
    }
}

pub(crate) struct Request {
    pub(crate) command: Command,
    pub(crate) reply: oneshot::Sender<Result<(), RpcError>>,
}

pub(crate) fn register(hub: &BusHub, sender: &mpsc::Sender<Request>) {
    for (name, description, action) in [
        (
            "wayland.workspace.activate",
            "Activate a Wayland workspace",
            Action::ActivateWorkspace,
        ),
        (
            "wayland.window.activate",
            "Activate a Wayland window",
            Action::ActivateWindow,
        ),
        (
            "wayland.window.close",
            "Ask a Wayland window to close",
            Action::CloseWindow,
        ),
        (
            "wayland.display_power.set",
            "Set power for one Wayland output or all outputs",
            Action::SetPower,
        ),
    ] {
        let sender = sender.clone();
        hub.register_core_command(
            CommandName::try_new(name).expect("static Wayland command name is valid"),
            description,
            Arc::new(move |call: CommandCall| {
                let command = action.parse(&call.params);
                let sender = sender.clone();
                Box::pin(async move {
                    let command = command?;
                    let disconnected =
                        || RpcError::new(ErrorCode::Disabled, "wayland is disconnected");
                    let (reply, result) = oneshot::channel();
                    sender
                        .send(Request { command, reply })
                        .await
                        .map_err(|_| disconnected())?;
                    result.await.map_err(|_| disconnected())??;
                    Ok(CommandInvokeResult {
                        message: None,
                        data: None,
                    })
                })
            }),
        );
    }
}
