mod common;

use std::{collections::HashMap, fs, net, path::Path, time::Duration};

use common::{TestBus, invoke, next_update, paths, subscribe};
use image::{ExtendedColorType, ImageEncoder, codecs::png::PngEncoder};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::mpsc,
    time::timeout,
};
use z_shell_bus::{BusHub, hub::ClientOutbound};
use z_shell_desktop::{
    DesktopHandle, DesktopOptions, DesktopServices, OfflinePolicy, SessionBusAddress,
};
use z_shell_protocol::{ClientRole, ErrorCode};
use zbus::{
    Connection,
    connection::Builder,
    object_server::SignalEmitter,
    zvariant::{ObjectPath, OwnedValue, Str},
};

const TOPIC: &str = "desktop.media";
const PATH: &str = "/org/mpris/MediaPlayer2";
const ALPHA: &str = "org.mpris.MediaPlayer2.alpha";
const BETA: &str = "org.mpris.MediaPlayer2.beta";
const TRACK: &str = "/org/mpris/MediaPlayer2/Track/One";
const DEADLINE: Duration = Duration::from_secs(4);

#[derive(Debug, PartialEq, Eq)]
enum Action {
    PlayPause,
    Next,
    Previous,
    Seek(i64),
}

struct Root(&'static str);

#[zbus::interface(name = "org.mpris.MediaPlayer2")]
impl Root {
    #[zbus(property)]
    fn identity(&self) -> &str {
        self.0
    }
}

struct Player {
    status: &'static str,
    art_url: Option<String>,
    title: String,
    can_next: bool,
    position: i64,
    actions: mpsc::UnboundedSender<Action>,
}

#[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
impl Player {
    #[zbus(property)]
    fn playback_status(&self) -> &str {
        self.status
    }

    #[zbus(property)]
    fn metadata(&self) -> HashMap<&str, OwnedValue> {
        let artists = zbus::zvariant::Value::from(vec!["One", "Two"]);
        let mut metadata = HashMap::from([
            (
                "mpris:trackid",
                OwnedValue::from(ObjectPath::try_from(TRACK).unwrap()),
            ),
            ("mpris:length", OwnedValue::from(90_000_000_i64)),
            (
                "xesam:title",
                OwnedValue::from(Str::from(self.title.as_str())),
            ),
            ("xesam:album", OwnedValue::from(Str::from("Album"))),
            ("xesam:artist", OwnedValue::try_from(artists).unwrap()),
        ]);
        if let Some(url) = self.art_url.as_deref() {
            metadata.insert("mpris:artUrl", OwnedValue::from(Str::from(url)));
        }
        metadata
    }

    #[zbus(property)]
    fn can_control(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_play(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_pause(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        self.can_next
    }

    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        true
    }

    #[zbus(property)]
    fn can_seek(&self) -> bool {
        true
    }

    #[zbus(property(emits_changed_signal = "false"))]
    fn position(&self) -> i64 {
        self.position
    }

    fn play_pause(&self) {
        self.actions.send(Action::PlayPause).unwrap();
    }

    fn next(&self) {
        self.actions.send(Action::Next).unwrap();
    }

    fn previous(&self) {
        self.actions.send(Action::Previous).unwrap();
    }

    async fn seek(&mut self, offset: i64, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) {
        self.actions.send(Action::Seek(offset)).unwrap();
        self.position += offset;
        Self::seeked(&emitter, self.position).await.unwrap();
    }

    #[zbus(signal)]
    async fn seeked(emitter: &SignalEmitter<'_>, position: i64) -> zbus::Result<()>;
}

struct Fixture {
    connection: Connection,
    actions: mpsc::UnboundedReceiver<Action>,
}

impl Fixture {
    async fn new(
        bus: &TestBus,
        name: &'static str,
        identity: &'static str,
        status: &'static str,
        can_next: bool,
    ) -> Self {
        let (actions, receiver) = mpsc::unbounded_channel();
        let connection = Builder::address(bus.address())
            .unwrap()
            .serve_at(PATH, Root(identity))
            .unwrap()
            .serve_at(
                PATH,
                Player {
                    status,
                    art_url: None,
                    title: "Song".into(),
                    can_next,
                    position: 7_000_000,
                    actions,
                },
            )
            .unwrap()
            .name(name)
            .unwrap()
            .build()
            .await
            .unwrap();
        Self {
            connection,
            actions: receiver,
        }
    }

    async fn status(&self, status: &'static str) {
        let player = self
            .connection
            .object_server()
            .interface::<_, Player>(PATH)
            .await
            .unwrap();
        let mut state = player.get_mut().await;
        state.status = status;
        state
            .playback_status_changed(player.signal_emitter())
            .await
            .unwrap();
    }

    async fn track(&self, title: &str, art_url: &str) {
        let player = self
            .connection
            .object_server()
            .interface::<_, Player>(PATH)
            .await
            .unwrap();
        let mut state = player.get_mut().await;
        state.title = title.to_owned();
        state.art_url = Some(art_url.to_owned());
        state
            .metadata_changed(player.signal_emitter())
            .await
            .unwrap();
    }

    async fn expect_action(&mut self, expected: Action) {
        assert_eq!(
            timeout(DEADLINE, self.actions.recv()).await.unwrap(),
            Some(expected)
        );
    }
}

fn install(
    bus: &TestBus,
    hub: &BusHub,
    root: &Path,
    offline_policy: OfflinePolicy,
) -> DesktopHandle {
    DesktopServices::install_with_options(
        hub,
        &paths(root),
        DesktopOptions {
            session_bus: SessionBusAddress::Address(bus.address().to_owned()),
            offline_policy,
            notifications: false,
            tray: false,
            xdg_data_dirs: Vec::new(),
            ..Default::default()
        },
    )
}

async fn until(outbound: &ClientOutbound, predicate: impl Fn(&Value) -> bool) -> Value {
    timeout(DEADLINE, async {
        loop {
            let update = next_update(outbound).await;
            if predicate(&update) {
                return update;
            }
        }
    })
    .await
    .expect("expected media topic update")
}

async fn call(hub: &BusHub, name: &str, payload: Value) {
    invoke(hub, ClientRole::Public, name, payload)
        .await
        .unwrap();
}

#[tokio::test]
async fn discovers_players_tracks_selection_and_dispatches_capability_checked_controls() {
    let bus = TestBus::new();
    let root = tempfile::tempdir().unwrap();
    let hub = BusHub::new("media-controls", paths(root.path()).media_dir());
    let mut alpha = Fixture::new(&bus, ALPHA, "Alpha", "Paused", false).await;
    let handle = install(&bus, &hub, root.path(), OfflinePolicy::Online);
    let (snapshot, outbound) = subscribe(&hub, TOPIC).await;
    let ready = if snapshot["available"] == true {
        snapshot
    } else {
        until(&outbound, |data| data["available"] == true).await
    };
    assert_eq!(ready["selected_player_id"], ALPHA);
    assert!(!handle.is_any_playing());
    assert_eq!(ready["players"][0]["identity"], "Alpha");
    assert_eq!(ready["players"][0]["playback_status"], "paused");
    assert_eq!(ready["players"][0]["position_us"], 7_000_000);
    assert_eq!(
        ready["players"][0]["metadata"],
        json!({
            "title": "Song", "album": "Album", "artists": ["One", "Two"],
            "length_us": 90_000_000, "track_id": TRACK,
        })
    );
    assert_eq!(ready["players"][0]["capabilities"]["can_go_next"], false);

    let mut beta = Fixture::new(&bus, BETA, "Beta", "Playing", true).await;
    let added = until(&outbound, |data| data["selected_player_id"] == BETA).await;
    assert_eq!(added["any_playing"], true);
    assert!(handle.is_any_playing());

    call(&hub, "media.next", json!({})).await;
    beta.expect_action(Action::Next).await;
    call(&hub, "media.select-player", json!({"player_id": ALPHA})).await;
    let selected = until(&outbound, |data| data["selected_player_id"] == ALPHA).await;
    assert_eq!(selected["any_playing"], true);
    call(&hub, "media.select-player", json!({"player_id": null})).await;
    until(&outbound, |data| data["selected_player_id"] == BETA).await;
    call(&hub, "media.select-player", json!({"player_id": ALPHA})).await;
    until(&outbound, |data| data["selected_player_id"] == ALPHA).await;

    let error = invoke(&hub, ClientRole::Public, "media.next", json!({}))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Disabled);
    assert!(alpha.actions.try_recv().is_err());
    call(&hub, "media.next", json!({"player_id": BETA})).await;
    beta.expect_action(Action::Next).await;
    for (name, action) in [
        ("media.play-pause", Action::PlayPause),
        ("media.previous", Action::Previous),
    ] {
        call(&hub, name, json!({})).await;
        alpha.expect_action(action).await;
    }
    call(&hub, "media.seek", json!({"offset_us": -1_000_000})).await;
    alpha.expect_action(Action::Seek(-1_000_000)).await;
    until(&outbound, |data| {
        data["players"][0]["position_us"] == 6_000_000
    })
    .await;

    beta.status("Stopped").await;
    until(&outbound, |data| data["any_playing"] == false).await;
    assert!(!handle.is_any_playing());
    alpha.connection.release_name(ALPHA).await.unwrap();
    let removed = until(&outbound, |data| data["selected_player_id"] == BETA).await;
    assert_eq!(removed["players"].as_array().unwrap().len(), 1);
    handle.shutdown().await;
    let disconnected = until(&outbound, |data| data["available"] == false).await;
    assert_eq!(disconnected["players"], json!([]));
    assert!(disconnected["selected_player_id"].is_null());
    assert_eq!(disconnected["any_playing"], false);
}

struct Http(TcpListener);

impl Http {
    fn new() -> Self {
        let listener = net::TcpListener::bind((net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        Self(TcpListener::from_std(listener).unwrap())
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.0.local_addr().unwrap())
    }

    async fn expect(&self, path: &str) -> TcpStream {
        timeout(DEADLINE, async {
            let (stream, _) = self.0.accept().await.unwrap();
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            assert_eq!(line, format!("GET {path} HTTP/1.1\r\n"));
            loop {
                line.clear();
                assert!(reader.read_line(&mut line).await.unwrap() > 0);
                if line == "\r\n" {
                    return reader.into_inner();
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("cover request for {path} did not arrive"))
    }

    async fn expect_no_request(&self) {
        assert!(
            timeout(Duration::from_millis(200), self.0.accept())
                .await
                .is_err(),
            "offline media service attempted an HTTP cover request"
        );
    }
}

async fn send_cover(mut stream: TcpStream, bytes: &[u8]) {
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n",
        bytes.len()
    );
    stream.write_all(headers.as_bytes()).await.unwrap();
    stream.write_all(bytes).await.unwrap();
    stream.shutdown().await.unwrap();
}

fn png(rgb: [u8; 3]) -> Vec<u8> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(&rgb, 1, 1, ExtendedColorType::Rgb8)
        .unwrap();
    bytes
}

fn expect_cached(data: &Value, cache_dir: &Path, bytes: &[u8]) {
    let cover = &data["cover"];
    assert_eq!(cover["kind"], "runtime_path");
    assert_eq!(cover["mime"], "image/png");
    assert!(
        cover["revision"]
            .as_u64()
            .is_some_and(|revision| revision < (1 << 53))
    );
    let path = Path::new(cover["path"].as_str().unwrap());
    assert!(path.starts_with(cache_dir));
    assert_eq!(
        fs::read(path).unwrap(),
        bytes,
        "applied cover is from a stale request"
    );
}

async fn observed_track(outbound: &ClientOutbound, title: &str) -> Value {
    until(outbound, |data| {
        data["players"][0]["metadata"]["title"] == title
    })
    .await
}

#[tokio::test]
async fn newer_cover_commits_while_an_older_download_is_blocked_and_rejects_stale_results() {
    let bus = TestBus::new();
    let http = Http::new();
    let root = tempfile::tempdir().unwrap();
    let cache_dir = paths(root.path()).media_dir();
    let hub = BusHub::new("media-stale-cover", cache_dir.clone());
    let fixture = Fixture::new(&bus, ALPHA, "Alpha", "Playing", true).await;
    fixture.track("Old", &http.url("/old")).await;
    let _handle = install(&bus, &hub, root.path(), OfflinePolicy::Online);
    let (_, outbound) = subscribe(&hub, TOPIC).await;
    let old = http.expect("/old").await;

    let red = png([255, 0, 0]);
    let green = png([0, 255, 0]);
    let blue = png([0, 0, 255]);
    fixture.track("New", &http.url("/new")).await;
    send_cover(http.expect("/new").await, &green).await;
    let newest = until(&outbound, |data| !data["cover"].is_null()).await;
    assert_eq!(newest["players"][0]["metadata"]["title"], "New");
    expect_cached(&newest, &cache_dir, &green);

    // With both slots occupied, observing the queued request start proves the
    // old request completed and its response was considered by the daemon.
    fixture
        .track("Other blocked", &http.url("/other-blocked"))
        .await;
    let other = http.expect("/other-blocked").await;
    fixture.track("Latest", &http.url("/latest")).await;
    assert!(observed_track(&outbound, "Latest").await["cover"].is_null());
    send_cover(old, &red).await;
    send_cover(http.expect("/latest").await, &blue).await;
    let newest = until(&outbound, |data| !data["cover"].is_null()).await;
    expect_cached(&newest, &cache_dir, &blue);
    drop(other);
}

#[tokio::test]
async fn offline_blocks_preexisting_new_and_queued_urls_and_clears_remote_cover() {
    let bus = TestBus::new();
    let http = Http::new();
    let root = tempfile::tempdir().unwrap();
    let cache_dir = paths(root.path()).media_dir();
    let hub = BusHub::new("media-offline", cache_dir.clone());
    let fixture = Fixture::new(&bus, ALPHA, "Alpha", "Playing", true).await;
    fixture
        .track("Preexisting", &http.url("/preexisting"))
        .await;
    let handle = install(&bus, &hub, root.path(), OfflinePolicy::Offline);
    let (snapshot, outbound) = subscribe(&hub, TOPIC).await;
    let ready = if snapshot["available"] == true {
        snapshot
    } else {
        observed_track(&outbound, "Preexisting").await
    };
    assert!(ready["cover"].is_null());
    http.expect_no_request().await;

    let red = png([255, 0, 0]);
    let green = png([0, 255, 0]);
    let blue = png([0, 0, 255]);
    handle.set_offline_policy(OfflinePolicy::Online);
    let in_flight = http.expect("/preexisting").await;
    handle.set_offline_policy(OfflinePolicy::Offline);
    send_cover(in_flight, &red).await;
    http.expect_no_request().await;
    assert!(subscribe(&hub, TOPIC).await.0["cover"].is_null());

    handle.set_offline_policy(OfflinePolicy::Online);
    send_cover(http.expect("/preexisting").await, &green).await;
    let cached = until(&outbound, |data| !data["cover"].is_null()).await;
    expect_cached(&cached, &cache_dir, &green);
    handle.set_offline_policy(OfflinePolicy::Offline);
    assert!(subscribe(&hub, TOPIC).await.0["cover"].is_null());

    let local = root.path().join("local cover.png");
    fs::write(&local, &blue).unwrap();
    fixture
        .track(
            "Local",
            &format!("file://{}", local.to_str().unwrap().replace(' ', "%20")),
        )
        .await;
    let local = until(&outbound, |data| {
        data["players"][0]["metadata"]["title"] == "Local" && !data["cover"].is_null()
    })
    .await;
    expect_cached(&local, &cache_dir, &blue);

    fixture.track("A", &http.url("/a")).await;
    assert!(observed_track(&outbound, "A").await["cover"].is_null());
    http.expect_no_request().await;
    handle.set_offline_policy(OfflinePolicy::Online);
    let first = http.expect("/a").await;
    fixture.track("B", &http.url("/b")).await;
    let second = http.expect("/b").await;
    fixture.track("Queued", &http.url("/queued")).await;
    assert!(observed_track(&outbound, "Queued").await["cover"].is_null());
    handle.set_offline_policy(OfflinePolicy::Offline);
    send_cover(first, &red).await;
    send_cover(second, &red).await;
    http.expect_no_request().await;
    assert!(subscribe(&hub, TOPIC).await.0["cover"].is_null());

    handle.set_offline_policy(OfflinePolicy::Online);
    send_cover(http.expect("/queued").await, &green).await;
    let restored = until(&outbound, |data| !data["cover"].is_null()).await;
    expect_cached(&restored, &cache_dir, &green);
}
