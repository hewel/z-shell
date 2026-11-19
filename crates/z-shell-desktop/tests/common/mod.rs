#![allow(
    dead_code,
    reason = "integration test binaries use different parts of this fixture"
)]

use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use z_shell_bus::{BusHub, CallerContext, hub::ClientOutbound};
use z_shell_config::ShellPaths;
use z_shell_protocol::{
    ClientMessage, ClientRole, CommandInvokeParams, CommandName, PROTOCOL_VERSION, RequestId,
    RpcError,
};
use zbus::{Connection, connection::Builder};

pub fn paths(root: &Path) -> ShellPaths {
    let paths = ShellPaths::from_roots(
        root.join("config"),
        root.join("state"),
        root.join("runtime"),
        root.join("runtime/bus.sock"),
    );
    paths.ensure_dirs().expect("prepare isolated ShellPaths");
    paths
}

pub async fn invoke(
    hub: &BusHub,
    role: ClientRole,
    name: &str,
    payload: Value,
) -> Result<Value, RpcError> {
    hub.invoke_command(
        CallerContext { client_id: 1, role },
        CommandInvokeParams {
            name: CommandName::try_new(name).expect("valid command name"),
            args: Vec::new(),
            payload: Some(payload),
        },
    )
    .await
    .map(|result| result.data.unwrap_or(Value::Null))
}

async fn next_frame(outbound: &ClientOutbound) -> Value {
    let line = tokio::time::timeout(Duration::from_secs(5), outbound.next_line())
        .await
        .expect("expected outbound bus frame within 5s")
        .expect("connection remains live");
    serde_json::from_str(&line).expect("valid outbound JSON")
}

pub async fn subscribe(hub: &BusHub, topic: &str) -> (Value, ClientOutbound) {
    let (id, outbound) = hub
        .register_client(ClientRole::Public)
        .expect("connect observer");
    hub.handle_inline_message(
        id,
        ClientMessage::request(
            RequestId::Number(1),
            "bus.hello",
            Some(json!({"protocol_version": PROTOCOL_VERSION})),
        ),
    );
    assert!(
        next_frame(&outbound).await.get("result").is_some(),
        "handshake succeeds"
    );
    hub.handle_inline_message(
        id,
        ClientMessage::request(
            RequestId::Number(2),
            "topic.subscribe",
            Some(json!({"topic": topic})),
        ),
    );
    let snapshot = next_frame(&outbound).await;
    assert_eq!(
        snapshot["result"]["topic"], topic,
        "subscription succeeds: {snapshot}"
    );
    (snapshot["result"]["data"].clone(), outbound)
}

pub async fn next_update(outbound: &ClientOutbound) -> Value {
    let frame = next_frame(outbound).await;
    assert_eq!(
        frame["method"], "topic.update",
        "expected topic update: {frame}"
    );
    frame["params"]["data"].clone()
}

pub struct TestBus {
    child: Child,
    address: String,
}

impl TestBus {
    pub fn new() -> Self {
        let mut child = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--nosyslog", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("start isolated dbus-daemon");
        let mut address = String::new();
        BufReader::new(child.stdout.take().expect("pipe D-Bus stdout"))
            .read_line(&mut address)
            .expect("read private D-Bus address");
        let bus = Self {
            child,
            address: address.trim().to_owned(),
        };
        assert!(
            !bus.address.is_empty(),
            "dbus-daemon did not report an address"
        );
        bus
    }

    pub fn address(&self) -> &str {
        &self.address
    }

    pub async fn connection(&self) -> Connection {
        tokio::time::timeout(
            Duration::from_secs(5),
            Builder::address(self.address())
                .expect("valid D-Bus address")
                .build(),
        )
        .await
        .expect("connect to private D-Bus within 5s")
        .expect("D-Bus connection succeeds")
    }
}

impl Drop for TestBus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
