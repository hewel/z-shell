mod common;

use std::future::poll_fn;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{TestBus, invoke, next_update, paths, subscribe};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::time::timeout;
use z_shell_bus::{BusHub, hub::ClientOutbound};
use z_shell_config::{CandidateLayout, ImeMode, ImeSettings};
use z_shell_desktop::{
    DesktopHandle, DesktopOptions, DesktopServices, ImeLockState, SessionBusAddress,
};
use z_shell_protocol::{ClientRole, ErrorCode, TopicUpdate};
use zbus::export::futures_core::Stream;
use zbus::fdo::{DBusProxy, MonitoringProxy, RequestNameFlags, RequestNameReply};
use zbus::{Connection, MatchRule, Message, MessageStream};

const STATUS: &str = "desktop.ime";
const PANEL: &str = "desktop.ime.panel";
const FCITX: &str = "org.fcitx.Fcitx5";
const CONTROLLER: &str = "org.fcitx.Fcitx.Controller1";
const WATCHER: &str = "org.kde.StatusNotifierWatcher";
const IM: &str = "org.kde.kimpanel.inputmethod";
const PANELS: &str = "org.kde.impanel";
const PANELS2: &str = "org.kde.impanel2";
const PATH: &str = "/org/kde/impanel";
const LIMIT: Duration = Duration::from_secs(5);

struct Controller {
    current: Arc<Mutex<&'static str>>,
    actions: mpsc::UnboundedSender<String>,
}

#[zbus::interface(name = "org.fcitx.Fcitx.Controller1")]
impl Controller {
    fn state(&self) -> i32 {
        if self.current_input_method() == "pinyin" {
            2
        } else {
            1
        }
    }

    fn current_input_method(&self) -> &str {
        *self.current.lock().expect("current IM lock")
    }

    #[zbus(out_args(
        "unique_name",
        "name",
        "native_name",
        "icon",
        "label",
        "language",
        "configurable"
    ))]
    fn current_input_method_info(
        &self,
    ) -> zbus::fdo::Result<(&str, &str, &str, &str, &str, &str, bool)> {
        match self.current_input_method() {
            "pinyin" => Ok((
                "pinyin",
                "Pinyin",
                "拼音",
                "fcitx-pinyin",
                "拼音",
                "zh",
                true,
            )),
            "keyboard-us" => Ok((
                "keyboard-us",
                "English",
                "English",
                "input-keyboard",
                "ENG",
                "en",
                false,
            )),
            _ => Err(zbus::fdo::Error::UnknownMethod("legacy controller".into())),
        }
    }

    fn current_input_method_group(&self) -> &str {
        "Default"
    }

    #[zbus(out_args("default_layout", "entries"))]
    fn input_method_group_info(&self, group: &str) -> (&str, Vec<(&str, &str)>) {
        assert_eq!(group, "Default");
        ("us", vec![("keyboard-us", "us"), ("pinyin", "")])
    }

    fn toggle(&self) {
        self.actions.send("toggle".into()).expect("observe action");
    }

    #[zbus(name = "SetCurrentIM")]
    fn set_current_im(&self, unique_name: &str) {
        self.actions
            .send(unique_name.into())
            .expect("observe action");
    }
}

struct TrayItem;

#[zbus::interface(name = "org.kde.StatusNotifierItem")]
impl TrayItem {
    #[zbus(property)]
    fn id(&self) -> &str {
        "fcitx5"
    }

    #[zbus(property)]
    fn title(&self) -> &str {
        "Fcitx5"
    }
}

struct Fixture {
    session: TestBus,
    hub: BusHub,
    _dir: tempfile::TempDir,
    paths: z_shell_config::ShellPaths,
}

impl Fixture {
    fn new() -> Self {
        let session = TestBus::new();
        let dir = tempfile::tempdir().expect("temporary shell root");
        let paths = paths(dir.path());
        let hub = BusHub::new("ime-test", paths.media_dir());
        Self {
            session,
            hub,
            _dir: dir,
            paths,
        }
    }

    fn install(&self, mode: ImeMode) -> DesktopHandle {
        DesktopServices::install_with_options(
            &self.hub,
            &self.paths,
            DesktopOptions {
                session_bus: SessionBusAddress::Address(self.session.address().into()),
                notifications: false,
                ime: ImeSettings {
                    mode,
                    ..ImeSettings::default()
                },
                xdg_data_dirs: vec![],
                ..DesktopOptions::default()
            },
        )
    }
}

async fn update(outbound: &ClientOutbound) -> TopicUpdate {
    let line = timeout(LIMIT, outbound.next_line())
        .await
        .expect("topic update timeout")
        .expect("topic subscription closed");
    let frame: Value = serde_json::from_str(&line).expect("valid NDJSON");
    assert_eq!(frame["method"], "topic.update", "{frame}");
    serde_json::from_value(frame["params"].clone()).expect("valid topic update")
}

async fn updated_until(outbound: &ClientOutbound, ready: impl Fn(&Value) -> bool) -> TopicUpdate {
    timeout(LIMIT, async {
        loop {
            let update = update(outbound).await;
            if ready(&update.data) {
                break update;
            }
        }
    })
    .await
    .expect("expected matching topic update")
}

async fn signal<T>(app: &Connection, path: &str, iface: &str, member: &str, body: &T)
where
    T: serde::Serialize + zbus::zvariant::DynamicType,
{
    app.emit_signal(None::<&str>, path, iface, member, body)
        .await
        .expect("send D-Bus signal");
}

async fn input<T>(app: &Connection, member: &str, body: &T)
where
    T: serde::Serialize + zbus::zvariant::DynamicType,
{
    signal(app, "/kimpanel", IM, member, body).await;
}

async fn method<T>(app: &Connection, member: &str, body: &T)
where
    T: serde::Serialize + zbus::zvariant::DynamicType,
{
    app.call_method(Some(PANELS), PATH, Some(PANELS2), member, body)
        .await
        .expect("call impanel2 method");
}

async fn signals(connection: &Connection) -> MessageStream {
    MessageStream::for_match_rule(
        MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .path(PATH)
            .expect("valid path")
            .build(),
        connection,
        None,
    )
    .await
    .expect("subscribe before panel starts")
}

async fn next_signal(stream: &mut MessageStream, member: &str, iface: &str) -> Message {
    let msg = timeout(LIMIT, poll_fn(|cx| Pin::new(&mut *stream).poll_next(cx)))
        .await
        .expect("D-Bus signal timeout")
        .expect("D-Bus stream closed")
        .expect("D-Bus signal");
    assert_eq!(
        msg.header().member().expect("signal member").as_str(),
        member
    );
    assert_eq!(
        msg.header().interface().expect("signal interface").as_str(),
        iface
    );
    msg
}

async fn has_owner(dbus: &DBusProxy<'_>, name: &'static str) -> bool {
    dbus.name_has_owner(name.try_into().expect("valid name"))
        .await
        .expect("query bus name")
}

#[tokio::test]
async fn indicator_tracks_controller_via_tray_and_group_signals_without_claiming_panel() {
    let f = Fixture::new();
    let app = f.session.connection().await;
    let dbus = DBusProxy::new(&app).await.expect("D-Bus proxy");
    let current = Arc::new(Mutex::new("keyboard-us"));
    let (actions, mut observed) = mpsc::unbounded_channel();
    app.object_server()
        .at(
            "/controller",
            Controller {
                current: current.clone(),
                actions,
            },
        )
        .await
        .expect("export Controller1");
    app.object_server()
        .at("/StatusNotifierItem", TrayItem)
        .await
        .expect("export SNI");
    let desktop = f.install(ImeMode::IndicatorOnly);
    let (_, status) = subscribe(&f.hub, STATUS).await;
    let (mut tray, tray_updates) = subscribe(&f.hub, "desktop.tray").await;
    while tray["available"] != true {
        tray = next_update(&tray_updates).await;
    }

    app.request_name(FCITX).await.expect("start Controller1");
    let baseline = updated_until(&status, |s| s["available"] == true).await;
    assert!(baseline.source_baseline);
    assert_eq!(baseline.data["active_im"]["short_label"], "EN");
    assert_eq!(baseline.data["enabled"], false);
    assert_eq!(baseline.data["group_ims"][0]["layout"], "us");
    assert!(
        baseline.data["group_ims"]
            .as_array()
            .expect("group list")
            .iter()
            .any(|im| im["unique_name"] == "pinyin")
    );
    assert!(!has_owner(&dbus, PANELS).await);

    *current.lock().expect("current IM lock") = "pinyin";
    app.call_method(
        Some(WATCHER),
        "/StatusNotifierWatcher",
        Some(WATCHER),
        "RegisterStatusNotifierItem",
        &("/StatusNotifierItem",),
    )
    .await
    .expect("register Fcitx5 SNI");
    let changed = updated_until(&status, |s| s["active_im"]["unique_name"] == "pinyin").await;
    assert!(!changed.source_baseline);
    assert_eq!(changed.data["enabled"], true);
    assert_eq!(changed.data["active_im"]["short_label"], "拼");

    *current.lock().expect("current IM lock") = "keyboard-us";
    signal(
        &app,
        "/StatusNotifierItem",
        "org.kde.StatusNotifierItem",
        "NewIcon",
        &(),
    )
    .await;
    let changed = updated_until(&status, |s| s["active_im"]["short_label"] == "EN").await;
    assert!(!changed.source_baseline);
    assert_eq!(changed.data["enabled"], false);

    *current.lock().expect("current IM lock") = "legacy";
    signal(
        &app,
        "/controller",
        CONTROLLER,
        "InputMethodGroupsChanged",
        &(),
    )
    .await;
    let changed = updated_until(&status, |s| s["active_im"]["unique_name"] == "legacy").await;
    assert!(!changed.source_baseline);
    assert_eq!(changed.data["active_im"]["label"], "legacy");
    assert_eq!(changed.data["active_im"]["short_label"], "le");
    for (command, body, expected) in [
        ("ime.toggle", json!({}), "toggle"),
        ("ime.set-im", json!({"unique_name": "pinyin"}), "pinyin"),
    ] {
        invoke(&f.hub, ClientRole::Public, command, body)
            .await
            .expect("dispatch Controller1 command");
        assert_eq!(
            timeout(LIMIT, observed.recv())
                .await
                .expect("Controller1 command timeout")
                .as_deref(),
            Some(expected)
        );
    }
    let (panel, _) = subscribe(&f.hub, PANEL).await;
    assert_eq!(panel["visible"], false);
    assert_eq!(panel["lookup_table"]["texts"], json!([]));
    desktop.shutdown().await;
}

#[tokio::test]
async fn kimpanel_composition_is_split_from_status_redacted_on_lock_and_cleared_on_disconnect() {
    let f = Fixture::new();
    let app = f.session.connection().await;
    let observer = f.session.connection().await;
    let dbus = DBusProxy::new(&observer).await.expect("D-Bus proxy");
    let mut wire = signals(&observer).await;
    app.request_name(FCITX).await.expect("start Fcitx5");
    app.request_name(IM).await.expect("start Kimpanel source");
    let desktop = f.install(ImeMode::Kimpanel);
    let (_, status) = subscribe(&f.hub, STATUS).await;
    let (_, panel) = subscribe(&f.hub, PANEL).await;
    next_signal(&mut wire, "PanelCreated", PANELS).await;
    next_signal(&mut wire, "PanelCreated2", PANELS2).await;
    assert!(has_owner(&dbus, PANELS).await);
    assert!(!has_owner(&dbus, "org.fcitx.GnomeHelper").await);
    input(
        &app,
        "RegisterProperties",
        &(vec![
            "/Fcitx/im:Pinyin:fcitx-pinyin:Chinese:menu,label=拼音",
            "/Fcitx/punct:Punctuation::",
        ],),
    )
    .await;
    let baseline = updated_until(&status, |s| s["active_im"]["short_label"] == "拼").await;
    assert!(baseline.source_baseline);
    assert_eq!(
        baseline.data["properties"][0]["hints"],
        json!(["menu", "label=拼音"])
    );
    input(
        &app,
        "UpdateProperty",
        &("/Fcitx/im:English::raw:label=EN-US",),
    )
    .await;
    let changed = updated_until(&status, |s| s["active_im"]["short_label"] == "EN").await;
    assert!(!changed.source_baseline);
    assert_eq!(changed.data["active_im"]["text"], "raw");
    input(&app, "Enable", &(false,)).await;
    let disabled = updated_until(&status, |s| s["enabled"] == false).await;
    assert!(!disabled.source_baseline);
    input(&app, "Enable", &(true,)).await;
    let enabled = updated_until(&status, |s| s["enabled"] == true).await;
    assert!(!enabled.source_baseline);
    input(&app, "ExecMenu", &(vec!["/Fcitx/pinyin:Pinyin:::"],)).await;
    let menu = updated_until(&status, |s| !s["exec_menu"].is_null()).await;
    assert_eq!(menu.data["exec_menu"]["items"][0]["key"], "/Fcitx/pinyin");

    // A different session client cannot feed a fake spot rectangle.
    method(&observer, "SetSpotRect", &(900_i32, 0_i32, 1_i32, 1_i32)).await;
    method(
        &app,
        "SetRelativeSpotRectV2",
        &(20_i32, -4_i32, 2_i32, 16_i32, 1.25_f64),
    )
    .await;
    let positioned = update(&panel).await;
    assert_eq!(
        positioned.data["spot_rect"],
        json!({"x":20,"y":-4,"w":2,"h":16,"relative":true,"scale":1.25})
    );
    input(&app, "UpdatePreeditText", &("pin", "")).await;
    input(&app, "UpdatePreeditCaret", &(2_i32,)).await;
    input(&app, "UpdateAux", &("hint", "")).await;
    method(
        &app,
        "SetLookupTable",
        &(
            vec!["1"],
            vec!["拼"],
            vec!["color"],
            true,
            false,
            0_i32,
            1_i32,
        ),
    )
    .await;
    input(&app, "ShowLookupTable", &(true,)).await;
    input(&app, "ShowPreedit", &(true,)).await;
    input(&app, "ShowAux", &(true,)).await;
    let composed = updated_until(&panel, |p| {
        p["visible"] == true
            && p["aux"] == "hint"
            && p["caret"] == 2
            && p["lookup_table"]["texts"] == json!(["拼"])
    })
    .await;
    assert_eq!(composed.data["preedit"], "pin");
    assert_eq!(
        composed.data["lookup_table"],
        json!({"labels":["1"],"texts":["拼"],"attrs":["color"],"cursor":0,"has_prev":true,"has_next":false,"layout":"vertical"})
    );
    // Another status signal fences the prior inputmethod signal traffic. Its revision
    // must directly follow ExecMenu: no keystroke changes (or spoofed messages) there.
    input(&app, "RemoveProperty", &("/Fcitx/punct",)).await;
    let removed = updated_until(&status, |s| {
        s["properties"]
            .as_array()
            .is_some_and(|props| props.len() == 1)
    })
    .await;
    assert_eq!(removed.revision, menu.revision + 1);

    for (command, body, member) in [
        (
            "ime.select-candidate",
            json!({"index": 3}),
            "SelectCandidate",
        ),
        ("ime.page-up", json!({}), "LookupTablePageUp"),
        ("ime.page-down", json!({}), "LookupTablePageDown"),
        ("ime.move-caret", json!({"position": 2}), "MovePreeditCaret"),
        (
            "ime.trigger-property",
            json!({"key": "/Fcitx/pinyin"}),
            "TriggerProperty",
        ),
        ("ime.reload-config", json!({}), "ReloadConfig"),
        ("ime.configure", json!({}), "Configure"),
    ] {
        invoke(&f.hub, ClientRole::Public, command, body)
            .await
            .expect("route panel action");
        let signal = next_signal(&mut wire, member, PANELS).await;
        match member {
            "SelectCandidate" => {
                assert_eq!(signal.body().deserialize::<i32>().expect("candidate"), 3)
            }
            "MovePreeditCaret" => assert_eq!(signal.body().deserialize::<i32>().expect("caret"), 2),
            "TriggerProperty" => assert_eq!(
                signal.body().deserialize::<&str>().expect("property"),
                "/Fcitx/pinyin"
            ),
            _ => assert!(signal.body().is_empty()),
        }
    }

    desktop.set_ime_settings(ImeSettings {
        mode: ImeMode::Kimpanel,
        candidate_layout: CandidateLayout::Horizontal,
        switch_osd: false,
    });
    let relaid = updated_until(&panel, |p| p["lookup_table"]["layout"] == "horizontal").await;
    assert_eq!(relaid.data["lookup_table"]["texts"], json!(["拼"]));
    desktop.set_ime_locked(ImeLockState::Locked);
    let cleared = updated_until(&panel, |p| p["spot_rect"].is_null()).await;
    assert_eq!(cleared.data["visible"], false);
    assert_eq!(cleared.data["aux"], "");
    assert_eq!(cleared.data["preedit"], "");
    assert_eq!(cleared.data["lookup_table"]["texts"], json!([]));
    input(&app, "UpdatePreeditText", &("password", "")).await;
    input(&app, "ShowPreedit", &(true,)).await;
    method(&app, "SetSpotRect", &(10_i32, 0_i32, 1_i32, 1_i32)).await;
    // Status still flows while locked, fencing the previous composition signals.
    input(&app, "UpdateProperty", &("/Fcitx/im:Chinese:::label=中文",)).await;
    updated_until(&status, |s| s["active_im"]["short_label"] == "中").await;
    let (snapshot, _) = subscribe(&f.hub, PANEL).await;
    assert_eq!(snapshot, cleared.data);
    for name in [
        "ime.toggle",
        "ime.set-im",
        "ime.trigger-property",
        "ime.select-candidate",
        "ime.page-up",
        "ime.page-down",
        "ime.move-caret",
        "ime.reload-config",
        "ime.configure",
    ] {
        assert_eq!(
            invoke(&f.hub, ClientRole::Public, name, json!({}))
                .await
                .expect_err("public command denied while locked")
                .code,
            ErrorCode::PermissionDenied
        );
    }
    invoke(
        &f.hub,
        ClientRole::PrivilegedHost,
        "ime.page-down",
        json!({}),
    )
    .await
    .expect("trusted host remains allowed");
    next_signal(&mut wire, "LookupTablePageDown", PANELS).await;

    desktop.set_ime_locked(ImeLockState::Unlocked);
    input(&app, "UpdatePreeditText", &("new", "")).await;
    input(&app, "ShowPreedit", &(true,)).await;
    let resumed = updated_until(&panel, |p| p["preedit"] == "new" && p["visible"] == true).await;
    assert_eq!(
        resumed.revision,
        cleared.revision + 2,
        "locked signals must not publish any composition"
    );
    app.close().await.expect("disconnect input method sender");
    let lost = updated_until(&status, |s| s["available"] == false).await;
    assert!(lost.source_baseline);
    assert!(lost.data["active_im"].is_null());
    assert!(lost.data["exec_menu"].is_null());
    let lost = updated_until(&panel, |p| p["preedit"] == "").await;
    assert!(lost.source_baseline);
    assert_eq!(lost.data["visible"], false);

    let restarted = f.session.connection().await;
    restarted.request_name(FCITX).await.expect("restart Fcitx5");
    restarted
        .request_name(IM)
        .await
        .expect("restart Kimpanel source");
    input(
        &restarted,
        "RegisterProperties",
        &(vec!["/Fcitx/im:English:::label=EN"],),
    )
    .await;
    let reconnected = updated_until(&status, |s| s["available"] == true).await;
    assert!(reconnected.source_baseline);
    assert_eq!(reconnected.data["active_im"]["short_label"], "EN");
    let (empty, _) = subscribe(&f.hub, PANEL).await;
    assert!(empty["spot_rect"].is_null());
    assert_eq!(empty["lookup_table"]["texts"], json!([]));

    method(&restarted, "SetSpotRect", &(3_i32, 4_i32, 1_i32, 12_i32)).await;
    updated_until(&panel, |p| p["spot_rect"]["x"] == 3).await;
    restarted
        .release_name(IM)
        .await
        .expect("stop just the kimpanel addon");
    let disconnected = updated_until(&status, |s| s["available"] == false).await;
    assert!(disconnected.source_baseline);
    let cleared = updated_until(&panel, |p| p["spot_rect"].is_null()).await;
    assert!(cleared.source_baseline);
    assert!(has_owner(&dbus, FCITX).await);

    desktop.set_ime_settings(ImeSettings::default());
    desktop.shutdown().await;
    assert!(!has_owner(&dbus, PANELS).await);
}

#[tokio::test]
async fn kimpanel_preserves_an_incumbent_and_releases_its_name_on_mode_switch_and_shutdown() {
    let f = Fixture::new();
    let incumbent = f.session.connection().await;
    let dbus = DBusProxy::new(&incumbent).await.expect("D-Bus proxy");
    incumbent
        .request_name_with_flags(PANELS, RequestNameFlags::AllowReplacement.into())
        .await
        .expect("incumbent owns panel");
    let mut wire = signals(&incumbent).await;
    let monitor = f.session.connection().await;
    let mut traffic = MessageStream::from(&monitor);
    let request_name = MatchRule::builder()
        .msg_type(zbus::message::Type::MethodCall)
        .interface("org.freedesktop.DBus")
        .expect("bus interface")
        .member("RequestName")
        .expect("name request")
        .arg(0, PANELS)
        .expect("panel name")
        .build();
    MonitoringProxy::new(&monitor)
        .await
        .expect("D-Bus monitoring proxy")
        .become_monitor(&[request_name], 0)
        .await
        .expect("watch name requests on the isolated bus");
    let desktop = f.install(ImeMode::Kimpanel);
    let request = timeout(LIMIT, async {
        loop {
            let request = poll_fn(|cx| Pin::new(&mut traffic).poll_next(cx))
                .await
                .expect("monitor is still open")
                .expect("bus message");
            if request
                .header()
                .member()
                .is_some_and(|member| member.as_str() == "RequestName")
            {
                break request;
            }
        }
    })
    .await
    .expect("panel name request timeout");
    let request = request.body();
    let (_, flags): (&str, u32) = request.deserialize().expect("request-name arguments");
    assert_eq!(flags, RequestNameFlags::DoNotQueue as u32);
    let owner = dbus
        .get_name_owner(PANELS.try_into().expect("valid name"))
        .await
        .expect("incumbent still owns panel");
    assert_eq!(
        &owner,
        incumbent.unique_name().expect("incumbent unique name")
    );
    assert_eq!(
        dbus.list_queued_owners(PANELS.try_into().expect("valid name"))
            .await
            .expect("query queue")
            .len(),
        1
    );
    incumbent
        .release_name(PANELS)
        .await
        .expect("incumbent releases panel");
    next_signal(&mut wire, "PanelCreated", PANELS).await;
    next_signal(&mut wire, "PanelCreated2", PANELS2).await;

    let mut names = dbus
        .receive_name_owner_changed_with_args(&[(0, PANELS)])
        .await
        .expect("watch panel ownership");
    desktop.set_ime_settings(ImeSettings::default());
    let lost = timeout(LIMIT, poll_fn(|cx| Pin::new(&mut names).poll_next(cx)))
        .await
        .expect("mode change releases name")
        .expect("owner change signal");
    assert!(
        lost.args()
            .expect("ownership args")
            .new_owner()
            .as_ref()
            .is_none()
    );
    assert!(!has_owner(&dbus, PANELS).await);
    desktop.set_ime_settings(ImeSettings {
        mode: ImeMode::Kimpanel,
        ..ImeSettings::default()
    });
    next_signal(&mut wire, "PanelCreated", PANELS).await;
    next_signal(&mut wire, "PanelCreated2", PANELS2).await;
    desktop.shutdown().await;
    assert!(!has_owner(&dbus, PANELS).await);
    assert_eq!(
        incumbent
            .request_name_with_flags(PANELS, RequestNameFlags::DoNotQueue.into())
            .await
            .expect("reclaim name"),
        RequestNameReply::PrimaryOwner
    );
}
