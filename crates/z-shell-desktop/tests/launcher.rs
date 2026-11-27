mod common;

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

use common::{TestBus, invoke, next_update, paths, subscribe};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use z_shell_bus::{BusHub, hub::ClientOutbound};
use z_shell_config::ConfigStore;
use z_shell_desktop::{DesktopOptions, DesktopServices, ImeLockState, SessionBusAddress};
use z_shell_protocol::{
    ClientMessage, ClientRole, ErrorCode, PROTOCOL_VERSION, RequestId, RpcError,
};
use zbus::zvariant::OwnedValue;

struct Client {
    hub: BusHub,
    id: u64,
    outbound: ClientOutbound,
}

impl Client {
    async fn connect(hub: &BusHub) -> Self {
        let (id, outbound) = hub
            .register_client(ClientRole::Public)
            .expect("connect client");
        let client = Self {
            hub: hub.clone(),
            id,
            outbound,
        };
        hub.handle_inline_message(
            id,
            ClientMessage::request(
                RequestId::Number(1),
                "bus.hello",
                Some(json!({"protocol_version": PROTOCOL_VERSION})),
            ),
        );
        assert_eq!(client.next().await["result"]["client_id"], id);
        client
    }

    async fn invoke(&self, name: &str, args: Value) -> Result<Value, RpcError> {
        let (_, caller, params) = self
            .hub
            .handle_inline_message(
                self.id,
                ClientMessage::request(
                    RequestId::Number(2),
                    "command.invoke",
                    Some(json!({"name": name, "payload": args})),
                ),
            )
            .expect("authenticated command request");
        self.hub
            .invoke_command(caller, params)
            .await
            .map(|result| result.data.unwrap_or(Value::Null))
    }

    async fn next(&self) -> Value {
        let line = tokio::time::timeout(Duration::from_secs(5), self.outbound.next_line())
            .await
            .expect("client receives bus frame")
            .expect("client remains connected");
        serde_json::from_str(&line).expect("valid bus frame")
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.hub.retire_client(self.id);
    }
}

fn put(root: &Path, file: &str, body: &str) {
    let path = root.join(file);
    fs::create_dir_all(path.parent().expect("file has a parent")).expect("create fixture parent");
    fs::write(path, body).expect("write fixture");
}

async fn ready(hub: &BusHub) -> Value {
    let (mut snapshot, subscriber) = subscribe(hub, "desktop.apps").await;
    while snapshot["available"] != true {
        snapshot = next_update(&subscriber).await;
    }
    snapshot
}

#[tokio::test]
async fn xdg_precedence_ranking_cache_and_action_argv() {
    let dir = tempfile::tempdir().expect("isolated XDG roots");
    let paths = paths(dir.path());
    let store = ConfigStore::new(paths.clone());
    store
        .update_state(|state| {
            state.pinned_apps.push("vendor-editor.desktop".to_owned());
            Ok(())
        })
        .expect("persist an app pin");
    let home = dir.path().join("data-home");
    let system = dir.path().join("data-dir");
    let exe = dir.path().join("record argv");
    let record = dir.path().join("action output");
    put(
        dir.path(),
        "record argv",
        "#!/bin/sh\noutput=$1\nshift\nprintf '%s\\n' \"$@\" > \"$output\"\n",
    );
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).expect("fixture executable");
    put(
        &home,
        "applications/masked.desktop",
        "[Desktop Entry]\nHidden=true\n",
    );
    put(
        &system,
        "applications/masked.desktop",
        "[Desktop Entry]\nType=Application\nName=Editor\nExec=/bin/true\n",
    );
    put(
        &system,
        "applications/ghost.desktop",
        "[Desktop Entry]\nType=Application\nName=Editor Ghost\nNoDisplay=true\nExec=/bin/true\n",
    );
    put(
        &system,
        "applications/missing.desktop",
        "[Desktop Entry]\nType=Application\nName=Editor Missing\nTryExec=/z-shell-missing/executable\nExec=/bin/true\n",
    );
    put(
        &system,
        "applications/editor.desktop",
        "[Desktop Entry]\nType=Application\nName=Editor\nExec=/bin/true\n",
    );
    put(
        &system,
        "applications/vendor/editor.desktop",
        "[Desktop Entry]\nType=Application\nName=Editor Wrong Origin\nExec=/bin/true\n",
    );
    put(
        &home,
        "applications/vendor/editor.desktop",
        &format!(
            "[Desktop Entry]\nType=Application\nName=Markdown Editor\nStartupWMClass=MarkdownEditor\nIcon=proof\nExec=/bin/true --launch-option\nActions=Proof;Missing;\n[Desktop Action Proof]\nName=Write proof\nExec=\"{}\" \"{}\" %f %F %u %U %% %c %k %i \"literal ; $(false)\"\n",
            exe.display(),
            record.display(),
        ),
    );
    put(
        &home,
        "icons/custom/index.theme",
        "[Icon Theme]\nName=Custom\nDirectories=48x48/apps\nInherits=parent\n[48x48/apps]\nSize=48\nType=Fixed\n",
    );
    put(
        &system,
        "icons/parent/index.theme",
        "[Icon Theme]\nName=Parent\nDirectories=scalable/apps\n[scalable/apps]\nSize=48\nType=Scalable\nMinSize=16\nMaxSize=128\n",
    );
    put(
        &system,
        "icons/parent/scalable/apps/proof.svg",
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- leading comment -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"><rect width=\"1\" height=\"1\"/></svg>",
    );

    let hub = BusHub::new("test", paths.media_dir());
    let _services = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Disabled,
            xdg_data_dirs: vec![home.clone(), system],
            icon_theme: "custom".to_owned(),
            ..DesktopOptions::default()
        },
    );
    let baseline = ready(&hub).await;
    assert_eq!(
        baseline["count"], 2,
        "shadowed, NoDisplay, and missing TryExec entries must not leak"
    );
    assert_eq!(baseline["pinned_apps"], json!(["vendor-editor.desktop"]));
    let summary = baseline["apps"]
        .as_array()
        .expect("apps summary array")
        .iter()
        .find(|entry| entry["id"] == "vendor-editor.desktop")
        .expect("vendor-editor summary in desktop.apps");
    assert_eq!(summary["title"], "Markdown Editor");
    assert_eq!(summary["startup_wm_class"], "MarkdownEditor");
    assert!(
        summary["icon"].is_object(),
        "desktop.apps summary includes resolved icon: {summary}"
    );
    let pinned = invoke(&hub, ClientRole::Public, "apps.list", json!({}))
        .await
        .expect("list apps");
    assert_eq!(
        pinned["items"][0]["item_id"], "vendor-editor.desktop",
        "pinned app leads browsing"
    );
    let client = Client::connect(&hub).await;
    let result = client
        .invoke("launcher.query", json!({"query": "editor"}))
        .await
        .expect("matching apps");
    assert_eq!(
        result["items"][0]["item_id"], "editor.desktop",
        "exact match outranks pinned substring"
    );
    let item = &result["items"][1];
    assert_eq!(
        item["title"], "Markdown Editor",
        "higher-priority desktop ID wins"
    );
    assert_eq!(
        item["actions"],
        json!([{"action_id": "Proof", "title": "Write proof"}])
    );
    assert!(item["icon"].is_object(), "resolved inherited icon: {item}");
    assert!(
        fs::read_dir(paths.media_dir())
            .expect("runtime media cache")
            .next()
            .is_some()
    );

    let exec_match = client
        .invoke(
            "launcher.query",
            json!({"query": "launch-option", "limit": 1}),
        )
        .await
        .expect("match an Exec token");
    assert_eq!(exec_match["items"][0]["item_id"], "vendor-editor.desktop");

    let fuzzy = client
        .invoke("launcher.query", json!({"query": "mkd edit"}))
        .await
        .expect("fuzzy result");
    assert_eq!(fuzzy["items"][0]["item_id"], "vendor-editor.desktop");
    let activation = json!({"query_id": fuzzy["query_id"], "provider_id": "desktop", "item_id": "vendor-editor.desktop", "action_id": "Proof"});
    client
        .invoke("launcher.activate", activation)
        .await
        .expect("launch the produced action");
    let desktop_file = home.join("applications/vendor/editor.desktop");
    let argv = tokio::time::timeout(Duration::from_secs(5), async {
        let expected = format!(
            "%\nMarkdown Editor\n{}\n--icon\nproof\nliteral ; $(false)\n",
            desktop_file.display()
        );
        loop {
            if let Ok(got) = fs::read_to_string(&record)
                && got.ends_with('\n')
                && got.lines().count() == expected.lines().count()
            {
                break (got, expected);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("desktop action recorded its argv");
    assert_eq!(
        argv.0, argv.1,
        "expand %%/c/k/i and strip unused Exec fields without shell interpretation"
    );

    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "apps.pin",
        json!({"id": "vendor-editor.desktop", "pinned": false}),
    )
    .await
    .expect("persist unpin");
    assert!(
        store
            .load_state()
            .expect("read durable state")
            .pinned_apps
            .is_empty()
    );
}

#[tokio::test]
async fn scoped_provider_replies_activation_and_query_supersession() {
    let dir = tempfile::tempdir().expect("isolated XDG roots");
    let xdg = dir.path().join("data");
    put(
        &xdg,
        "applications/web.desktop",
        "[Desktop Entry]\nType=Application\nName=Web Current\nExec=/bin/true\n",
    );
    let paths = paths(dir.path());
    let hub = BusHub::new("test", paths.media_dir());
    let _services = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Disabled,
            xdg_data_dirs: vec![xdg],
            ..DesktopOptions::default()
        },
    );
    ready(&hub).await;
    let requester = Client::connect(&hub).await;
    let owner = Client::connect(&hub).await;
    let outsider = Client::connect(&hub).await;
    let registration = json!({"entry": "example/web:search", "prefix": "web "});
    let provider = owner
        .invoke("launcher.register-provider", registration.clone())
        .await
        .expect("register owner")["provider_id"]
        .clone();
    let other_provider = outsider
        .invoke(
            "launcher.register-provider",
            json!({"entry": "other/web:search", "prefix": "other "}),
        )
        .await
        .expect("register independent provider")["provider_id"]
        .clone();
    assert_ne!(provider, other_provider);
    assert_eq!(
        outsider
            .invoke(
                "launcher.unregister-provider",
                json!({"provider_id": provider})
            )
            .await
            .expect_err("non-owner cannot unregister")
            .code,
        ErrorCode::PermissionDenied
    );

    let (old, ()) = tokio::join!(
        requester.invoke(
            "launcher.query",
            json!({"query": "web old", "query_id": 10})
        ),
        async {
            let event = owner.next().await;
            assert_eq!(event["method"], "launcher.provider-query");
            assert_eq!(event["params"]["provider_id"], provider);
            assert_eq!(event["params"]["query"], "old");
            let reply = json!({"request_id": event["params"]["request_id"], "items": []});
            let another = outsider
                .invoke(
                    "launcher.query",
                    json!({"query": "unmatched", "query_id": 1}),
                )
                .await
                .expect("query IDs are per requester");
            assert_eq!(another["query_id"], 1);
            let newer = tokio::time::timeout(
                Duration::from_millis(400),
                requester.invoke(
                    "launcher.query",
                    json!({"query": "unmatched", "query_id": 11}),
                ),
            )
            .await
            .expect("no wait for superseded provider")
            .expect("new query accepted");
            assert_eq!(newer["items"], json!([]));
            assert!(
                owner
                    .invoke("launcher.provider-reply", reply)
                    .await
                    .is_err(),
                "late reply cannot resurrect an old query"
            );
        }
    );
    assert_eq!(
        old.expect_err("pending query was superseded").code,
        ErrorCode::InvalidParams
    );
    assert_eq!(
        requester
            .invoke(
                "launcher.query",
                json!({"query": "web stale", "query_id": 9})
            )
            .await
            .expect_err("numeric stale ID rejected")
            .code,
        ErrorCode::InvalidParams
    );
    assert_eq!(
        requester
            .invoke(
                "launcher.query",
                json!({"query": "", "query_id": 9_007_199_254_740_992_u64})
            )
            .await
            .expect_err("unsafe numeric ID rejected")
            .code,
        ErrorCode::InvalidParams
    );

    let (new, ()) = tokio::join!(
        requester.invoke(
            "launcher.query",
            json!({"query": "web current", "limit": 2})
        ),
        async {
            let event = owner.next().await;
            assert_eq!(event["method"], "launcher.provider-query");
            assert_eq!(event["params"]["query_id"], 12);
            assert_eq!(event["params"]["limit"], 2);
            let reply = json!({"request_id": event["params"]["request_id"], "items": [
                {"item_id": "result", "title": "Result", "score": 100, "actions": [{"action_id": "open", "title": "Open"}]},
                {"item_id": "below-cutoff", "title": "Below cutoff", "score": 20}
            ]});
            assert_eq!(
                outsider
                    .invoke("launcher.provider-reply", reply.clone())
                    .await
                    .expect_err("only owning connection may reply")
                    .code,
                ErrorCode::PermissionDenied
            );
            owner
                .invoke("launcher.provider-reply", reply)
                .await
                .expect("accept exact owner reply");
        }
    );
    let new = new.expect("merge provider result");
    assert_eq!(new["query_id"], 12);
    assert_eq!(
        new["items"][0]["provider_id"], "desktop",
        "core app merges with provider result"
    );
    assert_eq!(new["items"][1]["provider_id"], provider);
    assert_eq!(new["items"].as_array().expect("items array").len(), 2);
    for (caller, activation) in [
        (
            &requester,
            json!({"query_id": 12, "provider_id": other_provider, "item_id": "result", "action_id": "open"}),
        ),
        (
            &requester,
            json!({"query_id": 12, "provider_id": provider, "item_id": "invented", "action_id": "open"}),
        ),
        (
            &requester,
            json!({"query_id": 12, "provider_id": provider, "item_id": "below-cutoff"}),
        ),
        (
            &requester,
            json!({"query_id": 12, "provider_id": provider, "item_id": "result", "action_id": "invented"}),
        ),
        (
            &outsider,
            json!({"query_id": 12, "provider_id": provider, "item_id": "result", "action_id": "open"}),
        ),
    ] {
        assert!(
            caller
                .invoke("launcher.activate", activation)
                .await
                .is_err(),
            "only produced results from the caller's query may activate"
        );
    }
    let valid = json!({"provider_id": provider, "item_id": "result", "action_id": "open"});
    let (activated, ()) = tokio::join!(
        requester.invoke("launcher.activate", valid.clone()),
        async {
            let event = owner.next().await;
            assert_eq!(event["method"], "launcher.provider-activate");
            assert_eq!(event["params"]["provider_id"], provider);
            assert_eq!(event["params"]["item_id"], "result");
            assert_eq!(event["params"]["action_id"], "open");
            owner
                .invoke(
                    "launcher.provider-reply",
                    json!({"request_id": event["params"]["request_id"], "activated": true}),
                )
                .await
                .expect("report activation");
        }
    );
    activated.expect("dispatch activation to the producing connection");
    drop(owner);
    let replacement = outsider
        .invoke("launcher.register-provider", registration)
        .await
        .expect("register replacement")["provider_id"]
        .clone();
    assert_ne!(
        provider, replacement,
        "registration IDs never transfer to a replacement connection"
    );
    assert!(
        requester.invoke("launcher.activate", valid).await.is_err(),
        "old results cannot route to replacement providers"
    );
    outsider
        .invoke(
            "launcher.unregister-provider",
            json!({"provider_id": replacement}),
        )
        .await
        .expect("owner may unregister");
    let no_provider = requester
        .invoke("launcher.query", json!({"query": "web current"}))
        .await
        .expect("query after provider removal");
    assert_eq!(
        no_provider["items"].as_array().expect("items array").len(),
        1,
        "unregistered provider does not contribute"
    );
}

#[tokio::test]
async fn apps_launch_executes_catalog_entries_without_query_and_enforces_catalog_errors() {
    struct FifoGate {
        path: std::path::PathBuf,
        hold: Option<fs::File>,
    }
    impl Drop for FifoGate {
        fn drop(&mut self) {
            // Unlink before closing the writer FD so a late open(O_RDONLY) gets ENOENT
            // while an already-opened reader gets immediate EOF.
            let _ = fs::remove_file(&self.path);
            let _ = self.hold.take();
        }
    }

    let dir = tempfile::tempdir().expect("isolated XDG roots");
    let paths = paths(dir.path());
    let state_fifo = paths.state_file();
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&state_fifo)
            .status()
            .expect("invoke mkfifo")
            .success(),
        "create state.toml FIFO gate"
    );
    let fifo_gate = FifoGate {
        hold: Some(
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&state_fifo)
                .expect("hold FIFO writer open until dropped"),
        ),
        path: state_fifo,
    };

    let xdg = dir.path().join("data");
    let exe = dir.path().join("record-launch");
    let record_default = dir.path().join("default-launch-output");
    let record_action = dir.path().join("action-launch-output");
    put(
        dir.path(),
        "record-launch",
        "#!/bin/sh\noutput=$1\nshift\nprintf '%s\\n' \"$@\" > \"$output.tmp\" && mv \"$output.tmp\" \"$output\"\n",
    );
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).expect("fixture executable");
    put(
        &xdg,
        "applications/vendor/dock-app.desktop",
        &format!(
            "[Desktop Entry]\nType=Application\nName=Dock App\nExec=\"{}\" \"{}\" default-run\nActions=NewWindow;\n[Desktop Action NewWindow]\nName=New Window\nExec=\"{}\" \"{}\" action-new-window\n",
            exe.display(),
            record_default.display(),
            exe.display(),
            record_action.display(),
        ),
    );
    put(
        &xdg,
        "applications/hidden.desktop",
        "[Desktop Entry]\nType=Application\nName=Hidden App\nNoDisplay=true\nExec=/bin/true\n",
    );

    let hub = BusHub::new("test", paths.media_dir());
    let _services = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Disabled,
            xdg_data_dirs: vec![xdg],
            ..DesktopOptions::default()
        },
    );

    let cold_client = Client::connect(&hub).await;
    assert_eq!(
        cold_client
            .invoke("apps.launch", json!({"id": "vendor-dock-app.desktop"}))
            .await
            .expect_err("apps.launch must report disabled while catalog scan is still loading")
            .code,
        ErrorCode::Disabled
    );

    // Unblock initial catalog scan deterministically and remove FIFO so normal state files work.
    drop(fifo_gate);
    ready(&hub).await;

    // Cold-boot launch without any prior launcher.query on this connection.
    assert_eq!(
        cold_client
            .invoke(
                "launcher.activate",
                json!({"provider_id": "desktop", "item_id": "vendor-dock-app.desktop"})
            )
            .await
            .expect_err("launcher.activate still requires an active query on the connection")
            .code,
        ErrorCode::InvalidParams
    );
    cold_client
        .invoke("apps.launch", json!({"id": "vendor-dock-app.desktop"}))
        .await
        .expect("cold-boot apps.launch succeeds without launcher.query");
    let recorded_default = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(got) = fs::read_to_string(&record_default) {
                break got;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("default apps.launch invocation executed");
    assert_eq!(recorded_default, "default-run\n");

    // Filtered search excluding the app blocks launcher.activate, but never blocks apps.launch.
    let filtered = cold_client
        .invoke(
            "launcher.query",
            json!({"query": "zzz-unrelated-filter", "limit": 5}),
        )
        .await
        .expect("filtered query succeeds");
    assert_eq!(filtered["items"], json!([]));
    assert_eq!(
        cold_client
            .invoke(
                "launcher.activate",
                json!({
                    "query_id": filtered["query_id"],
                    "provider_id": "desktop",
                    "item_id": "vendor-dock-app.desktop"
                })
            )
            .await
            .expect_err("launcher.activate still rejects items absent from filtered query")
            .code,
        ErrorCode::NotFound
    );
    cold_client
        .invoke(
            "apps.launch",
            json!({"id": "vendor-dock-app.desktop", "action_id": "NewWindow"}),
        )
        .await
        .expect("apps.launch with action_id succeeds after unrelated launcher.query");

    let recorded_action = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(got) = fs::read_to_string(&record_action) {
                break got;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("action apps.launch invocation executed");
    assert_eq!(recorded_action, "action-new-window\n");

    // Unknown or non-catalog desktop IDs and unknown action_ids return NotFound.
    for bad in [
        json!({"id": "does-not-exist.desktop"}),
        json!({"id": "hidden.desktop"}),
        json!({"id": "vendor-dock-app.desktop", "action_id": "MissingAction"}),
    ] {
        assert_eq!(
            cold_client
                .invoke("apps.launch", bad.clone())
                .await
                .expect_err("invalid catalog entry or action must return NotFound")
                .code,
            ErrorCode::NotFound,
            "payload: {bad}"
        );
    }
}

#[tokio::test]
async fn apps_launch_is_denied_while_session_is_locked() {
    let dir = tempfile::tempdir().expect("isolated XDG roots");
    let paths = paths(dir.path());
    let xdg = dir.path().join("data");
    let exe = dir.path().join("record-locked-launch");
    let record = dir.path().join("locked-launch-output");
    put(
        dir.path(),
        "record-locked-launch",
        "#!/bin/sh\noutput=$1\nshift\nprintf '%s\\n' \"$@\" >> \"$output\"\n",
    );
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).expect("fixture executable");
    put(
        &xdg,
        "applications/locked-check.desktop",
        &format!(
            "[Desktop Entry]\nType=Application\nName=Locked Check\nExec=\"{}\" \"{}\" launched\n",
            exe.display(),
            record.display(),
        ),
    );

    let hub = BusHub::new("test", paths.media_dir());
    let services = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Disabled,
            xdg_data_dirs: vec![xdg],
            ..DesktopOptions::default()
        },
    );
    ready(&hub).await;

    let client = Client::connect(&hub).await;
    services.set_locked(ImeLockState::Locked);

    for payload in [json!({"id": "locked-check.desktop"}), json!({})] {
        assert_eq!(
            client
                .invoke("apps.launch", payload)
                .await
                .expect_err("apps.launch must be denied while locked")
                .code,
            ErrorCode::PermissionDenied
        );
    }
    assert!(
        !record.exists(),
        "locked apps.launch must not spawn desktop entry"
    );

    services.set_ime_locked(ImeLockState::Locked);
    assert_eq!(
        client
            .invoke("apps.launch", json!({"id": "locked-check.desktop"}))
            .await
            .expect_err("set_ime_locked also gates apps.launch")
            .code,
        ErrorCode::PermissionDenied
    );

    services.set_locked(ImeLockState::Unlocked);
    client
        .invoke("apps.launch", json!({"id": "locked-check.desktop"}))
        .await
        .expect("apps.launch resumes once unlocked");
    let recorded = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(got) = fs::read_to_string(&record)
                && got.ends_with('\n')
            {
                break got;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("unlocked apps.launch executed");
    assert_eq!(recorded, "launched\n");
}

#[derive(Debug, PartialEq, Eq)]
enum DbusAppCall {
    Activate,
    Action(String, usize),
}

struct MockFdoApp {
    calls: mpsc::UnboundedSender<DbusAppCall>,
}

#[zbus::interface(name = "org.freedesktop.Application")]
impl MockFdoApp {
    fn activate(&self, _platform_data: HashMap<String, OwnedValue>) {
        self.calls.send(DbusAppCall::Activate).unwrap();
    }

    fn activate_action(
        &self,
        action_name: String,
        parameter: Vec<OwnedValue>,
        _platform_data: HashMap<String, OwnedValue>,
    ) {
        self.calls
            .send(DbusAppCall::Action(action_name, parameter.len()))
            .unwrap();
    }
}

#[tokio::test]
async fn dbus_activatable_launches_org_freedesktop_application_and_falls_back_on_service_unknown() {
    let bus = TestBus::new();
    let conn = bus.connection().await;
    let (calls_tx, mut calls_rx) = mpsc::unbounded_channel();
    conn.object_server()
        .at("/org/example/my_app", MockFdoApp { calls: calls_tx })
        .await
        .unwrap();
    conn.request_name("org.example.my-app").await.unwrap();

    let dir = tempfile::tempdir().expect("isolated XDG roots");
    let paths = paths(dir.path());
    let xdg = dir.path().join("data");
    let exe = dir.path().join("record-fallback");
    let record = dir.path().join("fallback-output");
    put(
        dir.path(),
        "record-fallback",
        "#!/bin/sh\noutput=$1\nshift\nprintf '%s\\n' \"$@\" > \"$output.tmp\" && mv \"$output.tmp\" \"$output\"\n",
    );
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).unwrap();

    // Pure DBusActivatable entry without Exec= in main or action section.
    put(
        &xdg,
        "applications/org.example.my-app.desktop",
        "[Desktop Entry]\nType=Application\nName=Pure D-Bus App\nDBusActivatable=true\nActions=new-window;\n[Desktop Action new-window]\nName=New Window\n",
    );

    // Hybrid DBusActivatable entry whose D-Bus service has no owner (ServiceUnknown) and no Icon=.
    let fallback_desktop = xdg.join("applications/org.example.UnownedApp.desktop");
    put(
        &xdg,
        "applications/org.example.UnownedApp.desktop",
        &format!(
            "[Desktop Entry]\nType=Application\nName=Fallback App\nDBusActivatable=true\nExec=\"{}\" \"{}\" %i %c %k\n",
            exe.display(),
            record.display(),
        ),
    );

    let hub = BusHub::new("test", paths.media_dir());
    let desktop = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Address(bus.address().to_owned()),
            notifications: false,
            tray: false,
            xdg_data_dirs: vec![xdg],
            ..DesktopOptions::default()
        },
    );
    ready(&hub).await;

    let client = Client::connect(&hub).await;
    client
        .invoke("apps.launch", json!({"id": "org.example.my-app.desktop"}))
        .await
        .expect("pure DBusActivatable default launch");
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), calls_rx.recv())
            .await
            .unwrap(),
        Some(DbusAppCall::Activate)
    );

    client
        .invoke(
            "apps.launch",
            json!({"id": "org.example.my-app.desktop", "action_id": "new-window"}),
        )
        .await
        .expect("pure DBusActivatable action launch");
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), calls_rx.recv())
            .await
            .unwrap(),
        Some(DbusAppCall::Action("new-window".to_owned(), 0))
    );

    // Unowned DBusActivatable service falls back to Exec, omitting empty %i and expanding %c + %k.
    client
        .invoke(
            "apps.launch",
            json!({"id": "org.example.UnownedApp.desktop"}),
        )
        .await
        .expect("DBusActivatable ServiceUnknown falls back to Exec");
    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(content) = fs::read_to_string(&record) {
                break content;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fallback Exec wrote output");
    assert_eq!(
        got,
        format!("Fallback App\n{}\n", fallback_desktop.display())
    );

    desktop.shutdown().await;
}

#[tokio::test]
async fn live_desktop_watcher_updates_catalog_on_create_modify_and_delete_preserving_pins() {
    let dir = tempfile::tempdir().expect("isolated XDG roots");
    let paths = paths(dir.path());
    let store = ConfigStore::new(paths.clone());
    let xdg = dir.path().join("data");
    put(
        &xdg,
        "applications/pinned.desktop",
        "[Desktop Entry]\nType=Application\nName=Pinned Base\nExec=/bin/true\n",
    );

    let hub = BusHub::new("test", paths.media_dir());
    let desktop = DesktopServices::install_with_options(
        &hub,
        &paths,
        DesktopOptions {
            session_bus: SessionBusAddress::Disabled,
            xdg_data_dirs: vec![xdg.clone()],
            ..DesktopOptions::default()
        },
    );

    let (mut snapshot, subscriber) = subscribe(&hub, "desktop.apps").await;
    while snapshot["available"] != true {
        snapshot = next_update(&subscriber).await;
    }
    assert_eq!(snapshot["count"], 1);

    invoke(
        &hub,
        ClientRole::PrivilegedHost,
        "apps.pin",
        json!({"id": "pinned.desktop", "pinned": true}),
    )
    .await
    .expect("pin existing app");
    let pinned_snap = next_update(&subscriber).await;
    assert_eq!(pinned_snap["pinned_apps"], json!(["pinned.desktop"]));

    // 1. Live creation in a newly created subdirectory updates desktop.apps without losing pins.
    put(
        &xdg,
        "applications/sub/fresh.desktop",
        "[Desktop Entry]\nType=Application\nName=Fresh Installed\nExec=/bin/true\n",
    );
    let created = next_update(&subscriber).await;
    assert_eq!(created["count"], 2);
    assert_eq!(created["pinned_apps"], json!(["pinned.desktop"]));
    assert!(
        created["apps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|app| app["id"] == "sub-fresh.desktop" && app["title"] == "Fresh Installed")
    );
    invoke(
        &hub,
        ClientRole::Public,
        "apps.launch",
        json!({"id": "sub-fresh.desktop"}),
    )
    .await
    .expect("newly watched desktop entry launches immediately");

    // 2. Live modification updates title while preserving durable pinned_apps.
    put(
        &xdg,
        "applications/sub/fresh.desktop",
        "[Desktop Entry]\nType=Application\nName=Fresh Updated\nExec=/bin/true\n",
    );
    let modified = next_update(&subscriber).await;
    assert_eq!(modified["count"], 2);
    assert_eq!(modified["pinned_apps"], json!(["pinned.desktop"]));
    assert!(
        modified["apps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|app| app["id"] == "sub-fresh.desktop" && app["title"] == "Fresh Updated")
    );

    // 3. Live deletion removes entry from catalog while keeping durable state.toml pins intact.
    fs::remove_file(xdg.join("applications/sub/fresh.desktop")).unwrap();
    let deleted = next_update(&subscriber).await;
    assert_eq!(deleted["count"], 1);
    assert_eq!(deleted["pinned_apps"], json!(["pinned.desktop"]));
    assert_eq!(
        store.load_state().unwrap().pinned_apps,
        vec!["pinned.desktop".to_owned()]
    );
    assert_eq!(
        invoke(
            &hub,
            ClientRole::Public,
            "apps.launch",
            json!({"id": "sub-fresh.desktop"}),
        )
        .await
        .unwrap_err()
        .code,
        ErrorCode::NotFound
    );

    desktop.shutdown().await;
}
