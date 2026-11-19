mod mock;

use std::collections::HashMap;
use std::time::Duration;

use mock::{Mock, Protocols, Request};
use serde_json::{Value, json};
use tempfile::TempDir;
use wayland_protocols_wlr::output_power_management::v1::server::zwlr_output_power_v1::Mode;
use z_shell_bus::hub::ClientOutbound;
use z_shell_bus::{BusHub, CallerContext};
use z_shell_protocol::{
    ClientMessage, ClientRole, CommandInvokeParams, CommandInvokeResult, CommandName, ErrorCode,
    PROTOCOL_VERSION, RequestId, RpcError, ServerMessage, TopicUpdate, methods,
};
use z_shell_wayland::{
    WaylandHandle, connect_stream, install_on_bus, publish_disconnected_baselines,
};

const OUTPUTS: &str = "wayland.outputs";
const WORKSPACES: &str = "wayland.workspaces";
const WINDOWS: &str = "wayland.windows";
const POWER: &str = "wayland.display_power";

struct Observer {
    hub: BusHub,
    client_id: u64,
    outbound: ClientOutbound,
    _media: TempDir,
}

impl Observer {
    async fn new() -> Self {
        let media = tempfile::tempdir().unwrap();
        let hub = BusHub::new("test", media.path().to_owned());
        let (client_id, outbound) = hub.register_client(ClientRole::Public).unwrap();
        let observer = Self {
            hub,
            client_id,
            outbound,
            _media: media,
        };
        observer
            .request(
                methods::BUS_HELLO,
                json!({"protocol_version": PROTOCOL_VERSION}),
            )
            .await;
        // The hub accepts subscriptions only to existing topics.
        publish_disconnected_baselines(&observer.hub);
        for topic in [OUTPUTS, WORKSPACES, WINDOWS, POWER] {
            let snapshot = observer
                .request(methods::TOPIC_SUBSCRIBE, json!({"topic": topic}))
                .await;
            assert_eq!(snapshot["data"]["capability"], "disconnected", "{topic}");
        }
        observer
    }

    async fn next(&self) -> ServerMessage {
        let line = tokio::time::timeout(Duration::from_secs(3), self.outbound.next_line())
            .await
            .expect("no bus frame")
            .expect("bus client disconnected");
        serde_json::from_str(&line).unwrap()
    }

    async fn request(&self, method: &str, params: Value) -> Value {
        let id = RequestId::try_number(1).unwrap();
        self.hub.handle_inline_message(
            self.client_id,
            ClientMessage::request(id.clone(), method, Some(params)),
        );
        match self.next().await {
            ServerMessage::Ok { id: actual, result } if actual == id => result,
            message => panic!("{method} failed: {message:?}"),
        }
    }

    async fn update(&self, baseline: bool) -> TopicUpdate {
        let ServerMessage::Notification { method, params } = self.next().await else {
            panic!("expected topic.update notification");
        };
        assert_eq!(method, methods::TOPIC_UPDATE);
        let update: TopicUpdate = serde_json::from_value(params).unwrap();
        assert_eq!(update.source_baseline, baseline, "{update:?}");
        update
    }

    async fn updates(&self, baseline: bool, topics: &[&str]) -> HashMap<String, Value> {
        let mut updates = HashMap::new();
        for _ in topics {
            let update = self.update(baseline).await;
            assert!(
                topics.contains(&update.topic.as_str()),
                "unexpected update: {update:?}"
            );
            assert!(
                updates
                    .insert(update.topic.to_string(), update.data)
                    .is_none()
            );
        }
        updates
    }

    async fn invoke(
        &self,
        name: &str,
        args: Vec<String>,
        payload: Option<Value>,
    ) -> Result<CommandInvokeResult, RpcError> {
        tokio::time::timeout(
            Duration::from_secs(3),
            self.hub.invoke_command(
                CallerContext {
                    client_id: self.client_id,
                    role: ClientRole::Public,
                },
                CommandInvokeParams {
                    name: CommandName::try_new(name).unwrap(),
                    args,
                    payload,
                },
            ),
        )
        .await
        .expect("Wayland command did not reply")
    }

    fn install(&self, stream: std::os::unix::net::UnixStream) -> WaylandHandle {
        install_on_bus(&self.hub, connect_stream(stream).unwrap())
    }
}

#[tokio::test]
async fn full_compositor_settles_then_publishes_live_changes_and_forwards_controls() {
    let observer = Observer::new().await;
    let (mut compositor, stream) = Mock::start(Protocols::Full);
    let _service = observer.install(stream);
    let baseline = observer
        .updates(true, &[OUTPUTS, WORKSPACES, WINDOWS, POWER])
        .await;
    assert_eq!(baseline[OUTPUTS]["capability"], "readable");
    for topic in [WORKSPACES, WINDOWS, POWER] {
        assert_eq!(baseline[topic]["capability"], "controllable", "{topic}");
    }
    let output = &baseline[OUTPUTS]["outputs"][0];
    let output_id = output["output_instance_id"].as_u64().unwrap();
    assert_eq!(
        *output,
        json!({
            "output_instance_id": output_id, "name": "DP-1", "description": "Mock monitor 1",
            "make": "Mock Make", "model": "Mock Model", "x": -200, "y": 30, "width": 1500,
            "height": 840, "mode_width": 3200, "mode_height": 1800, "refresh_mhz": 59950,
            "scale": 2, "physical_width_mm": 520, "physical_height_mm": 290
        })
    );
    let group = &baseline[WORKSPACES]["groups"][0];
    assert_eq!(group["output_instance_ids"], json!([output_id]));
    let workspace = &baseline[WORKSPACES]["workspaces"][0];
    let workspace_id = workspace["workspace_id"].as_u64().unwrap();
    assert_eq!(
        *workspace,
        json!({
            "workspace_id": workspace_id, "group_id": group["group_id"], "name": "One",
            "id_str": "mock:one", "coordinates": [2, 3], "active": true, "urgent": true,
            "hidden": false, "capabilities": ["activate"]
        })
    );
    let window = &baseline[WINDOWS]["windows"][0];
    let window_id = window["window_id"].as_u64().unwrap();
    assert_eq!(
        *window,
        json!({
            "window_id": window_id, "title": "Document", "app_id": "com.example.Editor",
            "output_instance_ids": [output_id], "activated": true, "minimized": false,
            "maximized": true, "fullscreen": true
        })
    );
    assert_eq!(
        baseline[POWER]["outputs"],
        json!([{"output_instance_id": output_id, "mode": "on"}])
    );

    compositor.act(|state, _| state.stage_changes());
    let power = observer.update(false).await;
    assert_eq!(
        power.topic.as_str(),
        POWER,
        "uncommitted protocol state leaked"
    );
    assert_eq!(power.data["outputs"][0]["mode"], "off");
    compositor.act(|state, _| state.finish_changes());
    let live = observer
        .updates(false, &[OUTPUTS, WORKSPACES, WINDOWS])
        .await;
    assert_eq!(live[OUTPUTS]["outputs"][0]["x"], -500);
    assert_eq!(live[WORKSPACES]["workspaces"][0]["hidden"], true);
    assert_eq!(live[WORKSPACES]["workspaces"][0]["active"], false);
    assert_eq!(live[WINDOWS]["windows"][0]["title"], "Edited document");
    assert_eq!(live[WINDOWS]["windows"][0]["minimized"], true);
    assert_eq!(live[WINDOWS]["windows"][0]["activated"], false);

    observer
        .invoke(
            "wayland.workspace.activate",
            vec![],
            Some(json!({"workspace_id": workspace_id})),
        )
        .await
        .unwrap();
    compositor.expect(Request::ActivateWorkspace).await;
    compositor.expect(Request::CommitWorkspaces).await;
    observer
        .invoke("wayland.window.activate", vec![window_id.to_string()], None)
        .await
        .unwrap();
    compositor.expect(Request::ActivateWindow).await;
    observer
        .invoke(
            "wayland.window.close",
            vec![],
            Some(json!({"window_id": window_id})),
        )
        .await
        .unwrap();
    compositor.expect(Request::CloseWindow).await;
    assert_eq!(
        observer.updates(false, &[WINDOWS]).await[WINDOWS]["windows"],
        json!([])
    );
    let closed = observer
        .invoke("wayland.window.close", vec![window_id.to_string()], None)
        .await
        .unwrap_err();
    assert_eq!(closed.code, ErrorCode::NotFound);
    observer
        .invoke(
            "wayland.display_power.set",
            vec![],
            Some(json!({"output_instance_id": output_id, "mode": "on"})),
        )
        .await
        .unwrap();
    compositor.expect(Request::SetPower(1, Mode::On)).await;
    assert_eq!(
        observer.updates(false, &[POWER]).await[POWER]["outputs"][0]["mode"],
        "on"
    );

    compositor.act(|state, _| state.remove_workspace());
    let removed = observer.updates(false, &[WORKSPACES]).await;
    assert_eq!(removed[WORKSPACES]["workspaces"], json!([]));
    assert_eq!(removed[WORKSPACES]["groups"], json!([]));
    assert_eq!(removed[WORKSPACES]["capability"], "readable");
    let removed = observer
        .invoke(
            "wayland.workspace.activate",
            vec![workspace_id.to_string()],
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(removed.code, ErrorCode::NotFound);

    compositor.act(|state, _| state.fail_power());
    let unavailable = observer.updates(false, &[POWER]).await;
    assert_eq!(unavailable[POWER]["capability"], "readable");
    assert_eq!(unavailable[POWER]["outputs"][0]["mode"], "unknown");
    let unavailable = observer
        .invoke(
            "wayland.display_power.set",
            vec![output_id.to_string(), "off".into()],
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(unavailable.code, ErrorCode::Disabled);

    compositor.stop().await;
    for (topic, data) in observer
        .updates(false, &[OUTPUTS, WORKSPACES, WINDOWS, POWER])
        .await
    {
        assert_eq!(data["capability"], "disconnected", "{topic}");
    }
}

#[tokio::test]
async fn hotplug_does_not_retarget_stale_output_ids() {
    let observer = Observer::new().await;
    let (mut compositor, stream) = Mock::start(Protocols::Full);
    let service = observer.install(stream);
    let baseline = observer
        .updates(true, &[OUTPUTS, WORKSPACES, WINDOWS, POWER])
        .await;
    let first = baseline[OUTPUTS]["outputs"][0]["output_instance_id"]
        .as_u64()
        .unwrap();
    compositor.act(|state, handle| state.add_second_output(handle));
    let mut output_update = None;
    let mut power_ready = false;
    while output_update.is_none() || !power_ready {
        let update = observer.update(false).await;
        match update.topic.as_str() {
            OUTPUTS => output_update = Some(update.data),
            POWER => power_ready = update.data["outputs"][1]["mode"] == "on",
            _ => panic!("unexpected update: {update:?}"),
        }
    }
    let output_update = output_update.unwrap();
    let outputs = output_update["outputs"].as_array().unwrap();
    assert_eq!(outputs.len(), 2);
    assert_eq!(outputs[0]["output_instance_id"], first);
    assert_eq!(outputs[1]["name"], "DP-2");
    let second = outputs[1]["output_instance_id"].as_u64().unwrap();
    assert!(second > first, "instance IDs must increase across hotplug");

    observer
        .invoke(
            "wayland.display_power.set",
            vec!["all".into(), "off".into()],
            None,
        )
        .await
        .unwrap();
    compositor.expect(Request::SetPower(1, Mode::Off)).await;
    compositor.expect(Request::SetPower(2, Mode::Off)).await;
    loop {
        let update = observer.update(false).await;
        assert_eq!(update.topic.as_str(), POWER);
        if update.data["outputs"][1]["mode"] == "off" {
            assert_eq!(update.data["outputs"][0]["mode"], "off");
            break;
        }
    }

    compositor.act(|state, handle| state.remove_first_output(handle));
    let removed = observer
        .updates(false, &[OUTPUTS, WORKSPACES, WINDOWS, POWER])
        .await;
    assert_eq!(removed[OUTPUTS]["outputs"].as_array().unwrap().len(), 1);
    assert_eq!(removed[OUTPUTS]["outputs"][0]["output_instance_id"], second);
    assert_eq!(
        removed[WORKSPACES]["groups"][0]["output_instance_ids"],
        json!([])
    );
    assert_eq!(
        removed[WINDOWS]["windows"][0]["output_instance_ids"],
        json!([])
    );
    assert_eq!(
        removed[POWER]["outputs"],
        json!([{"output_instance_id": second, "mode": "off"}])
    );

    let stale = observer
        .invoke(
            "wayland.display_power.set",
            vec![first.to_string(), "on".into()],
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(stale.code, ErrorCode::NotFound);
    assert!(stale.message.starts_with("output_gone: "), "{stale:?}");
    observer
        .invoke(
            "wayland.display_power.set",
            vec![second.to_string(), "on".into()],
            None,
        )
        .await
        .unwrap();
    compositor.expect(Request::SetPower(2, Mode::On)).await;
    assert_eq!(
        observer.updates(false, &[POWER]).await[POWER]["outputs"][0]["mode"],
        "on"
    );

    drop(service);
    for data in observer
        .updates(false, &[OUTPUTS, WORKSPACES, WINDOWS, POWER])
        .await
        .values()
    {
        assert_eq!(data["capability"], "disconnected");
    }
    compositor.stop().await;
}

#[tokio::test]
async fn missing_extensions_and_seat_do_not_disable_supported_domains() {
    let observer = Observer::new().await;
    let (mut compositor, stream) = Mock::start(Protocols::Partial);
    let _service = observer.install(stream);
    let baseline = observer
        .updates(true, &[OUTPUTS, WORKSPACES, WINDOWS, POWER])
        .await;
    assert_eq!(baseline[WORKSPACES]["capability"], "unsupported");
    assert_eq!(baseline[POWER]["capability"], "unsupported");
    assert_eq!(baseline[OUTPUTS]["capability"], "readable");
    assert_eq!(baseline[WINDOWS]["capability"], "controllable");
    let output = &baseline[OUTPUTS]["outputs"][0];
    assert_eq!(output["name"], "DP-1");
    assert_eq!(output["width"], 1600);
    assert_eq!(output["height"], 900);
    let window = &baseline[WINDOWS]["windows"][0];
    assert_eq!(
        window["output_instance_ids"],
        json!([output["output_instance_id"]])
    );
    let window_id = window["window_id"].as_u64().unwrap().to_string();
    let error = observer
        .invoke("wayland.window.activate", vec![window_id.clone()], None)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Disabled);
    assert!(error.message.contains("seat"), "{error:?}");
    let error = observer
        .invoke("wayland.workspace.activate", vec!["1".into()], None)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Disabled);
    let error = observer
        .invoke(
            "wayland.display_power.set",
            vec!["all".into(), "off".into()],
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Disabled);
    observer
        .invoke("wayland.window.close", vec![window_id], None)
        .await
        .unwrap();
    compositor.expect(Request::CloseWindow).await;
    assert_eq!(
        observer.updates(false, &[WINDOWS]).await[WINDOWS]["windows"],
        json!([])
    );
    compositor.stop().await;
}

#[tokio::test]
async fn stalled_registry_does_not_block_controls_or_shutdown() {
    use std::os::unix::net::UnixStream;

    let observer = Observer::new().await;
    let (client, _unresponsive_peer) = UnixStream::pair().unwrap();
    let service = observer.install(client);

    let error = observer
        .invoke("wayland.window.close", vec!["1".into()], None)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Disabled);
    assert!(error.message.contains("initializing"), "{error:?}");

    let (stopped, stop) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        drop(service);
        stopped.send(()).ok();
    });
    tokio::time::timeout(Duration::from_secs(3), stop)
        .await
        .expect("worker did not stop while waiting for the registry")
        .unwrap();
    for data in observer
        .updates(true, &[OUTPUTS, WORKSPACES, WINDOWS, POWER])
        .await
        .values()
    {
        assert_eq!(data["capability"], "disconnected");
    }
}
