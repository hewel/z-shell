mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

use common::{invoke, next_update, paths, subscribe};
use serde_json::{Value, json};
use z_shell_bus::{BusHub, hub::ClientOutbound};
use z_shell_config::ConfigStore;
use z_shell_desktop::{DesktopOptions, DesktopServices, SessionBusAddress};
use z_shell_protocol::{
    ClientMessage, ClientRole, ErrorCode, PROTOCOL_VERSION, RequestId, RpcError,
};

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
            "[Desktop Entry]\nType=Application\nName=Markdown Editor\nIcon=proof\nExec=/bin/true --launch-option\nActions=Proof;Missing;\n[Desktop Action Proof]\nName=Write proof\nExec=\"{}\" \"{}\" %f %F %u %U %% %c %k %i \"literal ; $(false)\"\n",
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
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"><rect width=\"1\" height=\"1\"/></svg>",
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
    let argv = tokio::time::timeout(Duration::from_secs(5), async {
        let expected = "%\nliteral ; $(false)\n";
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
        "strip Exec fields and pass arguments without shell interpretation"
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
