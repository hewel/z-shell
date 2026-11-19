use serde_json::{Value, json};
use std::time::Duration;
use tempfile::TempDir;
use z_shell_bus::{BusHub, CallerContext, hub::ClientOutbound};
use z_shell_config::ShellPaths;
use z_shell_protocol::{
    ClientMessage, ClientRole, CommandInvokeParams, CommandName, PROTOCOL_VERSION, RequestId,
    ServerMessage, methods,
};

pub fn fixture(dir: &TempDir) -> (ShellPaths, BusHub) {
    let runtime = dir.path().join("run");
    let paths = ShellPaths::from_roots(
        dir.path().join("config"),
        dir.path().join("state"),
        runtime.clone(),
        runtime.join("bus.sock"),
    );
    let hub = BusHub::new("test", paths.media_dir());
    (paths, hub)
}

pub fn send(hub: &BusHub, id: u64, method: &str, params: Value) {
    let message = ClientMessage::request(RequestId::try_number(1).unwrap(), method, Some(params));
    assert!(hub.handle_inline_message(id, message).is_none());
}

pub async fn receive(out: &ClientOutbound) -> ServerMessage {
    let line = tokio::time::timeout(Duration::from_secs(5), out.next_line())
        .await
        .expect("expected bus frame before deadline")
        .expect("expected open bus connection");
    serde_json::from_str(&line).unwrap()
}

pub async fn client(hub: &BusHub) -> (u64, ClientOutbound) {
    let (id, out) = hub.register_client(ClientRole::Public).unwrap();
    send(
        hub,
        id,
        methods::BUS_HELLO,
        json!({"protocol_version": PROTOCOL_VERSION}),
    );
    assert!(matches!(receive(&out).await, ServerMessage::Ok { .. }));
    (id, out)
}

pub async fn subscribe(hub: &BusHub, id: u64, out: &ClientOutbound, topic: &str) -> Value {
    send(hub, id, methods::TOPIC_SUBSCRIBE, json!({"topic": topic}));
    match receive(out).await {
        ServerMessage::Ok { result, .. } => result["data"].clone(),
        other => panic!("expected subscription snapshot for {topic}, got {other:?}"),
    }
}

pub async fn invoke(
    hub: &BusHub,
    role: ClientRole,
    command: &str,
    payload: Option<Value>,
) -> Result<z_shell_protocol::CommandInvokeResult, z_shell_protocol::RpcError> {
    hub.invoke_command(
        CallerContext { client_id: 1, role },
        CommandInvokeParams {
            name: CommandName::try_new(command).unwrap(),
            args: Vec::new(),
            payload,
        },
    )
    .await
}
