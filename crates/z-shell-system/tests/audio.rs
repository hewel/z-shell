mod common;

use common::{client, fixture, invoke, receive, subscribe};
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use z_shell_protocol::{ClientRole, ErrorCode, ServerMessage};
use z_shell_system::{PulseEndpoint, SystemBusAddress, SystemOptions, SystemServices};

#[tokio::test]
async fn pulse_controls_and_capture_are_visible_on_the_bus() {
    let dir = tempdir().unwrap();
    let (paths, hub) = fixture(&dir);
    let socket = dir.path().join("pulse");
    let cookie = dir.path().join("cookie");
    std::fs::write(&cookie, [0xAB; 256]).unwrap();
    let pulse = UnixListener::bind(&socket).unwrap();
    let (id, out) = client(&hub).await;
    let _system = SystemServices::install_with_options(
        &hub,
        &paths,
        SystemOptions {
            system_bus: SystemBusAddress::Disabled,
            pulse: Some(PulseEndpoint::new(socket, Some(cookie))),
            proc_root: dir.path().join("proc"),
            sys_root: dir.path().join("sys"),
            backlight_root: dir.path().join("backlight"),
        },
    );
    assert_eq!(
        subscribe(&hub, id, &out, "system.audio").await["availability"],
        "unavailable"
    );
    assert_eq!(
        subscribe(&hub, id, &out, "system.privacy").await["audio_capture"]["state"],
        "unknown"
    );
    let (disconnect, close) = tokio::sync::oneshot::channel();
    let (stop_capture, recording_stopped) = tokio::sync::oneshot::channel();
    let mock = tokio::spawn(server(pulse, close, recording_stopped));

    let audio = update(&out, "system.audio", true).await;
    assert_eq!(audio["default_sink"], "speakers");
    assert_eq!(audio["default_source"], "microphone");
    assert_eq!(audio["sinks"][0]["volume"], 1.0);
    assert_eq!(audio["sources"][1]["monitor_of_sink"], 3);
    assert_eq!(audio["sink_inputs"][0]["application"], "Music");
    assert_eq!(audio["source_outputs"][2]["device_index"], 4);
    assert_eq!(
        update(&out, "system.privacy", true).await,
        json!({
            "audio_capture": {"state": "active", "apps": ["Recorder"]},
            "camera": "unknown", "screencast": "unknown"
        })
    );

    stop_capture.send(()).unwrap();
    let audio = update(&out, "system.audio", false).await;
    assert_eq!(audio["source_outputs"][2]["corked"], true);
    assert_eq!(
        update(&out, "system.privacy", false).await["audio_capture"]["state"],
        "inactive"
    );

    let gone = invoke(
        &hub,
        ClientRole::Public,
        "audio.set-volume",
        Some(json!({"kind":"sink", "index":999, "volume":0.5})),
    )
    .await
    .unwrap_err();
    assert_eq!(gone.code, ErrorCode::NotFound);
    invoke(
        &hub,
        ClientRole::Public,
        "audio.set-volume",
        Some(json!({"kind":"sink", "index":3, "volume":0.5})),
    )
    .await
    .unwrap();
    let audio = update(&out, "system.audio", false).await;
    assert_eq!(audio["sinks"][0]["volume"], 0.5);
    invoke(
        &hub,
        ClientRole::Public,
        "audio.set-app-mute",
        Some(json!({"index":9, "muted":true})),
    )
    .await
    .unwrap();
    let audio = update(&out, "system.audio", false).await;
    assert_eq!(audio["sink_inputs"][0]["muted"], true);
    disconnect.send(()).unwrap();
    mock.await.unwrap();
    assert_eq!(
        update(&out, "system.audio", false).await["availability"],
        "unavailable"
    );
    assert_eq!(
        update(&out, "system.privacy", false).await["audio_capture"]["state"],
        "unknown"
    );
}

async fn update(out: &z_shell_bus::hub::ClientOutbound, topic: &str, baseline: bool) -> Value {
    let ServerMessage::Notification { method, params } = receive(out).await else {
        panic!("expected {topic} update");
    };
    assert_eq!(method, "topic.update");
    assert_eq!(params["topic"], topic);
    assert_eq!(params["source_baseline"], baseline);
    params["data"].clone()
}

async fn server(
    listener: UnixListener,
    mut close: tokio::sync::oneshot::Receiver<()>,
    mut recording_stopped: tokio::sync::oneshot::Receiver<()>,
) {
    let (mut stream, _) = listener.accept().await.unwrap();
    let mut auth = b"L\0\0\0\x16x\0\0\x01\0".to_vec();
    auth.extend([0xAB; 256]);
    let (command, tag, args) = request(&mut stream).await;
    assert_eq!(command, 8);
    assert_eq!(args, auth);
    send(&mut stream, 2, tag, b"L\0\0\0\x23").await;
    let (command, tag, args) = request(&mut stream).await;
    assert_eq!(command, 9);
    assert_eq!(args, props("z-shell"));
    send(&mut stream, 2, tag, b"L\0\0\0\x01").await;
    let (command, tag, args) = request(&mut stream).await;
    assert_eq!(command, 35);
    assert_eq!(args, b"L\0\0\0\x8f");
    send(&mut stream, 2, tag, b"").await;

    let (mut volume, mut muted) = (65536, false);
    let mut capture_stopped = false;
    loop {
        let (command, tag, args) = tokio::select! {
            _ = &mut close => return,
            _ = &mut recording_stopped, if !capture_stopped => {
                capture_stopped = true;
                send(&mut stream, 66, u32::MAX, b"L\0\0\0\x13L\0\0\0\x0c").await;
                continue;
            }
            req = request(&mut stream) => req,
        };
        let body = match command {
            20 => b"tPipeWire\0t1.0\0tuser\0thost\0a\x03\x02\0\0\xbb\x80tspeakers\0tmicrophone\0L\0\0\0\x01m\x02\x01\x02".to_vec(),
            22 => device(3, "speakers", 5, volume),
            24 => [device(5, "speakers.monitor", 3, 65536), device(4, "microphone", u32::MAX, 65536)].concat(),
            30 => playback(muted),
            32 => [capture(10, 5, "Monitor", false), capture(11, 4, "Corked", true), capture(12, 4, "Recorder", capture_stopped)].concat(),
            36 => {
                assert_eq!(args, b"L\0\0\0\x03Nv\x02\0\0\x80\0\0\0\x80\0");
                volume = 32768;
                Vec::new()
            }
            69 => {
                assert_eq!(args, b"L\0\0\0\x091");
                muted = true;
                // An unsolicited event may arrive before the command's tagged reply.
                send(&mut stream, 66, u32::MAX, b"L\0\0\0\x13L\0\0\0\x0c").await;
                Vec::new()
            }
            other => panic!("unexpected PulseAudio command {other}"),
        };
        send(&mut stream, 2, tag, &body).await;
    }
}

async fn request(stream: &mut UnixStream) -> (u32, u32, Vec<u8>) {
    let length = stream.read_u32().await.unwrap();
    assert_eq!(stream.read_u32().await.unwrap(), u32::MAX);
    assert_eq!(stream.read_u64().await.unwrap(), 0);
    assert_eq!(stream.read_u32().await.unwrap(), 0);
    assert_eq!(stream.read_u8().await.unwrap(), b'L');
    let command = stream.read_u32().await.unwrap();
    assert_eq!(stream.read_u8().await.unwrap(), b'L');
    let tag = stream.read_u32().await.unwrap();
    let mut args = vec![0; (length - 10) as usize];
    stream.read_exact(&mut args).await.unwrap();
    (command, tag, args)
}

async fn send(stream: &mut UnixStream, command: u32, tag: u32, body: &[u8]) {
    let mut frame = ((10 + body.len()) as u32).to_be_bytes().to_vec();
    frame.extend(u32::MAX.to_be_bytes());
    frame.extend([0; 12]);
    frame.extend(word(command));
    frame.extend(word(tag));
    frame.extend(body);
    // Fragment both the header and payload across writes.
    stream.write_all(&frame[..9]).await.unwrap();
    stream.write_all(&frame[9..]).await.unwrap();
}

fn word(value: u32) -> Vec<u8> {
    [b"L".as_slice(), &value.to_be_bytes()].concat()
}

fn props(app: &str) -> Vec<u8> {
    let len = (app.len() as u32 + 1).to_be_bytes();
    [
        b"Ptapplication.name\0L".as_slice(),
        &len,
        b"x",
        &len,
        app.as_bytes(),
        b"\0N",
    ]
    .concat()
}

fn device(index: u32, name: &str, monitor: u32, volume: u32) -> Vec<u8> {
    [
        &word(index), b"t".as_slice(), name.as_bytes(), b"\0tDevice\0a\x03\x02\0\0\xbb\x80m\x02\x01\x02L\xff\xff\xff\xffv\x02",
        &volume.to_be_bytes(), &volume.to_be_bytes(), b"0", &word(monitor),
        b"NU\0\0\0\0\0\0\0\0tPipeWire\0L\0\0\0\0PNU\0\0\0\0\0\0\0\0V\0\x01\0\0L\0\0\0\x01L\0\x01\0\x01L\xff\xff\xff\xffL\0\0\0\x01tport\0tPort\0L\0\0\0\x01tport\0B\x01fB\x01PN",
    ].concat()
}

fn playback(muted: bool) -> Vec<u8> {
    [b"L\0\0\0\x09tSong\0L\xff\xff\xff\xffL\0\0\0\x01L\0\0\0\x03a\x03\x02\0\0\xbb\x80m\x02\x01\x02v\x02\0\x01\0\0\0\x01\0\0U\0\0\0\0\0\0\0\0U\0\0\0\0\0\0\0\0NtPipeWire\0".as_slice(),
        if muted { b"1" } else { b"0" }, &props("Music"), b"011fB\x01PN"].concat()
}

fn capture(index: u32, source: u32, app: &str, corked: bool) -> Vec<u8> {
    [
        word(index).as_slice(),
        b"tCapture\0L\xff\xff\xff\xffL\0\0\0\x01",
        &word(source),
        b"a\x03\x02\0\0\xbb\x80m\x02\x01\x02U\0\0\0\0\0\0\0\0U\0\0\0\0\0\0\0\0NtPipeWire\0",
        props(app).as_slice(),
        if corked { b"1" } else { b"0" },
        b"v\x02\0\x01\0\0\0\x01\0\x00011fB\x01PN",
    ]
    .concat()
}
