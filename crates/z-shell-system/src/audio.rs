//! PulseAudio native control connection. No audio samples or shared memory are requested.

mod wire;

use std::{
    collections::BTreeSet,
    env,
    fs::OpenOptions,
    io::{self, Read},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{
    io::AsyncReadExt,
    net::UnixStream,
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time,
};
use z_shell_bus::{BusHub, CommandCall};
use z_shell_protocol::{ErrorCode, RpcError};

use crate::{Commands, Topic, failed, invalid, payload, unavailable};
use wire::{Error, Packet, Reader, Result};

const COMMAND_ERROR: u32 = 0;
const COMMAND_REPLY: u32 = 2;
const COMMAND_AUTH: u32 = 8;
const COMMAND_SET_CLIENT_NAME: u32 = 9;
const COMMAND_GET_SERVER_INFO: u32 = 20;
const COMMAND_GET_SINK_INFO_LIST: u32 = 22;
const COMMAND_GET_SOURCE_INFO_LIST: u32 = 24;
const COMMAND_GET_SINK_INPUT_INFO_LIST: u32 = 30;
const COMMAND_GET_SOURCE_OUTPUT_INFO_LIST: u32 = 32;
const COMMAND_SUBSCRIBE: u32 = 35;
const COMMAND_SET_SINK_VOLUME: u32 = 36;
const COMMAND_SET_SINK_INPUT_VOLUME: u32 = 37;
const COMMAND_SET_SOURCE_VOLUME: u32 = 38;
const COMMAND_SET_SINK_MUTE: u32 = 39;
const COMMAND_SET_SOURCE_MUTE: u32 = 40;
const COMMAND_SET_DEFAULT_SINK: u32 = 44;
const COMMAND_SET_DEFAULT_SOURCE: u32 = 45;
const COMMAND_SUBSCRIBE_EVENT: u32 = 66;
const COMMAND_MOVE_SINK_INPUT: u32 = 67;
const COMMAND_SET_SINK_INPUT_MUTE: u32 = 69;

// v22 has cork state, both classes of stream volume, and device format lists.
// New servers send the layout for the version in COMMAND_AUTH, not their own.
const VERSION: u32 = 22;
const VERSION_MASK: u32 = 0x0000_ffff;
const COOKIE_LENGTH: usize = 256;
const INVALID_INDEX: u32 = u32::MAX;
const VOLUME_NORMAL: u32 = 0x1_0000;
// Sinks, sources, sink inputs, source outputs, and server/default changes.
const SUBSCRIPTIONS: u32 = 0x8f;
const IO_TIMEOUT: Duration = Duration::from_secs(3);
const RETRY: Duration = Duration::from_secs(2);

/// Native PulseAudio Unix socket and optional 256-byte authentication cookie.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct PulseEndpoint {
    /// Socket path, normally `$XDG_RUNTIME_DIR/pulse/native`.
    pub socket: PathBuf,
    /// A missing cookie sends zeros for local PipeWire or peer authentication.
    pub cookie: Option<PathBuf>,
}

impl PulseEndpoint {
    /// Configures an explicit endpoint without consulting the environment.
    #[must_use]
    pub fn new(socket: PathBuf, cookie: Option<PathBuf>) -> Self {
        Self { socket, cookie }
    }

    pub(crate) fn from_env() -> Option<Self> {
        let home = || env_path("HOME");
        let socket = env_path("XDG_RUNTIME_DIR")?.join("pulse/native");
        let cookie = env_path("PULSE_COOKIE").or_else(|| {
            env_path("XDG_CONFIG_HOME")
                .or_else(|| home().map(|home| home.join(".config")))
                .map(|config| config.join("pulse/cookie"))
        });
        Some(Self { socket, cookie })
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn cookie(path: Option<&Path>) -> io::Result<[u8; COOKIE_LENGTH]> {
    let mut cookie = [0; COOKIE_LENGTH];
    if let Some(path) = path {
        let mut file = match OpenOptions::new()
            .read(true)
            .custom_flags(rustix::fs::OFlags::NONBLOCK.bits() as i32)
            .open(path)
        {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(cookie),
            Err(err) => return Err(err),
        };
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() != COOKIE_LENGTH as u64 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid PulseAudio cookie length or type",
            ));
        }
        file.read_exact(&mut cookie)?;
    }
    Ok(cookie)
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Availability {
    Available,
    #[default]
    Unavailable,
}

#[derive(Debug, Default, PartialEq, Serialize)]
struct Audio {
    availability: Availability,
    default_sink: Option<String>,
    default_source: Option<String>,
    sinks: Vec<Device>,
    sources: Vec<Device>,
    sink_inputs: Vec<Stream>,
    source_outputs: Vec<Stream>,
}

#[derive(Debug, PartialEq, Serialize)]
struct Device {
    index: u32,
    name: String,
    description: Option<String>,
    channels: u8,
    volume: f64,
    muted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    monitor_of_sink: Option<u32>,
}

#[derive(Debug, PartialEq, Serialize)]
struct Stream {
    index: u32,
    name: Option<String>,
    application: Option<String>,
    device_index: u32,
    channels: u8,
    volume: Option<f64>,
    muted: bool,
    corked: bool,
    volume_writable: bool,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
struct Privacy {
    audio_capture: Capture,
    camera: Unknown,
    screencast: Unknown,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum Capture {
    Active {
        apps: Vec<String>,
    },
    Inactive,
    #[default]
    Unknown,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Unknown {
    #[default]
    Unknown,
}

impl Audio {
    fn devices(&self, kind: DeviceKind) -> &[Device] {
        match kind {
            DeviceKind::Sink => &self.sinks,
            DeviceKind::Source => &self.sources,
        }
    }

    fn privacy(&self) -> Privacy {
        let mut apps = BTreeSet::new();
        let mut unresolved = false;
        for stream in self.source_outputs.iter().filter(|stream| !stream.corked) {
            match self
                .sources
                .iter()
                .find(|source| source.index == stream.device_index)
            {
                Some(source) if source.monitor_of_sink.is_none() => {
                    apps.insert(
                        stream
                            .application
                            .as_deref()
                            .or(stream.name.as_deref())
                            .unwrap_or("Unknown application"),
                    );
                }
                Some(_) => {} // Monitor sources record speaker output, not microphone input.
                None => unresolved = true, // Device changed during the multi-request snapshot.
            }
        }
        let audio_capture = if !apps.is_empty() {
            Capture::Active {
                apps: apps.into_iter().map(str::to_owned).collect(),
            }
        } else if unresolved {
            Capture::Unknown
        } else {
            Capture::Inactive
        };
        Privacy {
            audio_capture,
            ..Privacy::default()
        }
    }
}

struct Client {
    socket: UnixStream,
    incoming: Vec<u8>,
    outgoing: Packet,
    next_tag: u32,
    dirty: bool,
}

impl Client {
    async fn open(endpoint: &PulseEndpoint) -> Result<Self> {
        let path = endpoint.cookie.clone();
        let cookie = tokio::task::spawn_blocking(move || cookie(path.as_deref()))
            .await
            .map_err(io::Error::other)??;
        let socket = time::timeout(IO_TIMEOUT, UnixStream::connect(&endpoint.socket))
            .await
            .map_err(|_| Error::Timeout)??;
        let mut client = Self {
            socket,
            incoming: Vec::new(),
            outgoing: Packet::default(),
            next_tag: 0,
            dirty: false,
        };
        let mut auth = client
            .rpc(COMMAND_AUTH, |packet| {
                packet.u32(VERSION);
                packet.bytes(&cookie);
            })
            .await?;
        let version = auth.u32()? & VERSION_MASK;
        auth.end()?;
        if version < VERSION {
            return Err(Error::Version(version));
        }
        let mut name = client
            .rpc(COMMAND_SET_CLIENT_NAME, |packet| {
                packet.application("z-shell")
            })
            .await?;
        name.u32()?;
        name.end()?;
        client
            .rpc(COMMAND_SUBSCRIBE, |packet| packet.u32(SUBSCRIPTIONS))
            .await?
            .end()?;
        Ok(client)
    }

    async fn rpc(&mut self, command: u32, body: impl FnOnce(&mut Packet)) -> Result<Reader<'_>> {
        let tag = self.next_tag;
        self.next_tag = if tag == u32::MAX - 1 { 0 } else { tag + 1 };
        self.outgoing.reset(command, tag);
        body(&mut self.outgoing);
        time::timeout(IO_TIMEOUT, self.exchange(tag))
            .await
            .map_err(|_| Error::Timeout)??;
        Ok(Reader(&self.incoming[10..]))
    }

    async fn exchange(&mut self, tag: u32) -> Result<()> {
        self.outgoing.send(&mut self.socket).await?;
        loop {
            wire::receive(&mut self.socket, &mut self.incoming, None).await?;
            let (command, reply_tag, mut fields) = self.packet()?;
            match (command, reply_tag) {
                (COMMAND_REPLY, reply_tag) if reply_tag == tag => return Ok(()),
                (COMMAND_ERROR, reply_tag) if reply_tag == tag => {
                    let code = fields.u32()?;
                    fields.end()?;
                    return Err(Error::Rejected(code));
                }
                (COMMAND_SUBSCRIBE_EVENT, u32::MAX) => {
                    event(&mut fields)?;
                    self.dirty = true;
                }
                _ => return Err(Error::Protocol),
            }
        }
    }

    fn packet(&self) -> Result<(u32, u32, Reader<'_>)> {
        let mut fields = Reader(&self.incoming);
        Ok((fields.u32()?, fields.u32()?, fields))
    }

    async fn receive_event(&mut self, first: u8) -> Result<()> {
        time::timeout(
            IO_TIMEOUT,
            wire::receive(&mut self.socket, &mut self.incoming, Some(first)),
        )
        .await
        .map_err(|_| Error::Timeout)??;
        let (command, tag, mut fields) = self.packet()?;
        if command != COMMAND_SUBSCRIBE_EVENT || tag != u32::MAX {
            return Err(Error::Protocol);
        }
        event(&mut fields)?;
        self.dirty = true;
        Ok(())
    }

    async fn snapshot(&mut self) -> Result<Audio> {
        self.dirty = false;
        let mut server = self.rpc(COMMAND_GET_SERVER_INFO, |_| {}).await?;
        for _ in 0..4 {
            server.string()?;
        }
        server.sample_spec()?;
        let default_sink = server.string()?.map(str::to_owned);
        let default_source = server.string()?.map(str::to_owned);
        server.u32()?; // Server instance cookie (not the auth cookie).
        server.channel_map()?;
        server.end()?;
        let mut sinks = self
            .list(COMMAND_GET_SINK_INFO_LIST, |r| device(r, DeviceKind::Sink))
            .await?;
        let mut sources = self
            .list(COMMAND_GET_SOURCE_INFO_LIST, |r| {
                device(r, DeviceKind::Source)
            })
            .await?;
        let mut sink_inputs = self
            .list(COMMAND_GET_SINK_INPUT_INFO_LIST, |r| {
                stream(r, StreamKind::Playback)
            })
            .await?;
        let mut source_outputs = self
            .list(COMMAND_GET_SOURCE_OUTPUT_INFO_LIST, |r| {
                stream(r, StreamKind::Capture)
            })
            .await?;
        sinks.sort_unstable_by_key(|device| device.index);
        sources.sort_unstable_by_key(|device| device.index);
        sink_inputs.sort_unstable_by_key(|stream| stream.index);
        source_outputs.sort_unstable_by_key(|stream| stream.index);
        Ok(Audio {
            availability: Availability::Available,
            default_sink,
            default_source,
            sinks,
            sources,
            sink_inputs,
            source_outputs,
        })
    }

    async fn list<T>(
        &mut self,
        command: u32,
        parse: impl Fn(&mut Reader<'_>) -> Result<T>,
    ) -> Result<Vec<T>> {
        let mut response = self.rpc(command, |_| {}).await?;
        let mut values = Vec::new();
        while !response.empty() {
            values.push(parse(&mut response)?);
        }
        Ok(values)
    }
}

fn event(fields: &mut Reader<'_>) -> Result<()> {
    fields.u32()?; // Event type/facility; the subscription mask selects relevant events.
    fields.u32()?; // Object index.
    fields.end()
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DeviceKind {
    Sink,
    Source,
}

#[derive(Clone, Copy)]
enum StreamKind {
    Playback,
    Capture,
}

fn normalized(volume: u32) -> f64 {
    f64::from(volume) / f64::from(VOLUME_NORMAL)
}

fn device(r: &mut Reader<'_>, kind: DeviceKind) -> Result<Device> {
    let index = r.u32()?;
    let name = r.string()?.ok_or(Error::Protocol)?.to_owned();
    let description = r.string()?.map(str::to_owned);
    r.sample_spec()?;
    r.channel_map()?;
    r.u32()?; // Module.
    let (channels, volume) = r.channel_volume()?;
    let muted = r.boolean()?;
    let monitor = r.u32()?;
    let monitor_of_sink =
        (matches!(kind, DeviceKind::Source) && monitor != INVALID_INDEX).then_some(monitor);
    r.string()?; // Monitor name.
    r.usec()?;
    r.string()?; // Driver.
    r.u32()?; // Flags.
    r.properties()?;
    r.usec()?; // Requested latency.
    r.scalar_volume()?;
    for _ in 0..3 {
        r.u32()?;
    } // State, volume steps, card.
    for _ in 0..r.u32()? {
        r.string()?; // Port name.
        r.string()?; // Port description.
        r.u32()?; // Port priority.
    }
    r.string()?; // Active port.
    for _ in 0..r.u8()? {
        r.format()?;
    }
    Ok(Device {
        index,
        name,
        description,
        channels,
        volume: normalized(volume),
        muted,
        monitor_of_sink,
    })
}

fn stream(r: &mut Reader<'_>, kind: StreamKind) -> Result<Stream> {
    let index = r.u32()?;
    let name = r
        .string()?
        .filter(|name| !name.is_empty())
        .map(str::to_owned);
    r.u32()?; // Module.
    r.u32()?; // Client.
    let device_index = r.u32()?;
    r.sample_spec()?;
    r.channel_map()?;
    let playback = matches!(kind, StreamKind::Playback)
        .then(|| r.channel_volume())
        .transpose()?;
    r.usec()?; // Stream latency.
    r.usec()?; // Device latency.
    r.string()?; // Resampler.
    r.string()?; // Driver.
    let playback_mute = playback.is_some().then(|| r.boolean()).transpose()?;
    let application = r.properties()?.map(str::to_owned);
    let corked = r.boolean()?;
    let ((channels, volume), muted) = match (playback, playback_mute) {
        (Some(volume), Some(muted)) => (volume, muted),
        _ => (r.channel_volume()?, r.boolean()?),
    };
    let volume = r.boolean()?.then_some(normalized(volume));
    let volume_writable = r.boolean()?;
    r.format()?;
    Ok(Stream {
        index,
        name,
        application,
        device_index,
        channels,
        volume,
        muted,
        corked,
        volume_writable,
    })
}

#[derive(Clone, Copy)]
enum Action {
    DeviceVolume,
    DeviceMute,
    Default,
    AppVolume,
    AppMute,
    Move,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    kind: DeviceKind,
    index: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceVolume {
    kind: DeviceKind,
    index: u32,
    volume: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceMute {
    kind: DeviceKind,
    index: u32,
    muted: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AppVolume {
    index: u32,
    volume: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AppMute {
    index: u32,
    muted: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Move {
    index: u32,
    sink_index: u32,
}

enum Control {
    DeviceVolume(DeviceKind, u32, u32),
    DeviceMute(DeviceKind, u32, bool),
    Default(Target),
    AppVolume(u32, u32),
    AppMute(AppMute),
    Move(Move),
}

enum ControlError {
    Rpc(RpcError),
    Connection(Error),
}

impl From<RpcError> for ControlError {
    fn from(error: RpcError) -> Self {
        Self::Rpc(error)
    }
}

fn volume(normalized: f64) -> std::result::Result<u32, RpcError> {
    if !(0.0..=1.0).contains(&normalized) {
        return Err(invalid("volume must be between 0 and 1"));
    }
    Ok((normalized * f64::from(VOLUME_NORMAL)).round() as u32)
}

impl Control {
    fn parse(action: Action, call: &CommandCall) -> std::result::Result<Self, RpcError> {
        Ok(match action {
            Action::DeviceVolume => {
                let args: DeviceVolume = payload(call)?;
                Self::DeviceVolume(args.kind, args.index, volume(args.volume)?)
            }
            Action::DeviceMute => {
                let args: DeviceMute = payload(call)?;
                Self::DeviceMute(args.kind, args.index, args.muted)
            }
            Action::Default => Self::Default(payload(call)?),
            Action::AppVolume => {
                let args: AppVolume = payload(call)?;
                Self::AppVolume(args.index, volume(args.volume)?)
            }
            Action::AppMute => Self::AppMute(payload(call)?),
            Action::Move => Self::Move(payload(call)?),
        })
    }

    async fn apply(self, client: &mut Client, audio: &Audio) -> Result<(), ControlError> {
        let device = |kind, index| {
            audio
                .devices(kind)
                .iter()
                .find(|device| device.index == index)
                .ok_or_else(|| RpcError::new(ErrorCode::NotFound, "audio device not found"))
        };
        let stream = |index| {
            audio
                .sink_inputs
                .iter()
                .find(|stream| stream.index == index)
                .ok_or_else(|| RpcError::new(ErrorCode::NotFound, "playback stream not found"))
        };
        let response = match self {
            Self::DeviceVolume(kind, index, volume) => {
                let channels = device(kind, index)?.channels;
                if channels == 0 {
                    return Err(unavailable("audio device has no controllable volume").into());
                }
                let command = match kind {
                    DeviceKind::Sink => COMMAND_SET_SINK_VOLUME,
                    DeviceKind::Source => COMMAND_SET_SOURCE_VOLUME,
                };
                client
                    .rpc(command, |packet| {
                        packet.u32(index);
                        packet.string(None);
                        packet.volume(channels, volume);
                    })
                    .await
            }
            Self::DeviceMute(kind, index, muted) => {
                device(kind, index)?;
                let command = match kind {
                    DeviceKind::Sink => COMMAND_SET_SINK_MUTE,
                    DeviceKind::Source => COMMAND_SET_SOURCE_MUTE,
                };
                client
                    .rpc(command, |packet| {
                        packet.u32(index);
                        packet.string(None);
                        packet.boolean(muted);
                    })
                    .await
            }
            Self::Default(Target { kind, index }) => {
                let device = device(kind, index)?;
                let command = match kind {
                    DeviceKind::Sink => COMMAND_SET_DEFAULT_SINK,
                    DeviceKind::Source => COMMAND_SET_DEFAULT_SOURCE,
                };
                client
                    .rpc(command, |packet| packet.string(Some(&device.name)))
                    .await
            }
            Self::AppVolume(index, volume) => {
                let stream = stream(index)?;
                if stream.channels == 0 || !stream.volume_writable {
                    return Err(unavailable("playback stream volume is read-only").into());
                }
                client
                    .rpc(COMMAND_SET_SINK_INPUT_VOLUME, |packet| {
                        packet.u32(index);
                        packet.volume(stream.channels, volume);
                    })
                    .await
            }
            Self::AppMute(AppMute { index, muted }) => {
                stream(index)?;
                client
                    .rpc(COMMAND_SET_SINK_INPUT_MUTE, |packet| {
                        packet.u32(index);
                        packet.boolean(muted);
                    })
                    .await
            }
            Self::Move(Move { index, sink_index }) => {
                stream(index)?;
                device(DeviceKind::Sink, sink_index)?;
                client
                    .rpc(COMMAND_MOVE_SINK_INPUT, |packet| {
                        packet.u32(index);
                        packet.u32(sink_index);
                        packet.string(None);
                    })
                    .await
            }
        };
        match response.and_then(|response| response.end()) {
            Ok(()) => {
                client.dirty = true;
                Ok(())
            }
            Err(Error::Rejected(5)) => {
                Err(RpcError::new(ErrorCode::NotFound, "audio target no longer exists").into())
            }
            Err(Error::Rejected(code)) => {
                tracing::debug!(code, "PulseAudio rejected control request");
                Err(failed("audio server rejected the command").into())
            }
            Err(err) => Err(ControlError::Connection(err)),
        }
    }
}

struct Request {
    control: Control,
    reply: oneshot::Sender<std::result::Result<(), RpcError>>,
}

pub(crate) fn install(
    hub: &BusHub,
    commands: &Commands,
    endpoint: Option<PulseEndpoint>,
) -> Option<JoinHandle<()>> {
    let mut audio = Topic::new(hub, "system.audio", Audio::default());
    let mut privacy = Topic::new(hub, "system.privacy", Privacy::default());
    let (sender, receiver) = watch::channel::<Option<mpsc::Sender<Request>>>(None);
    for (name, description, action) in [
        (
            "audio.set-volume",
            "Set a sink or source volume",
            Action::DeviceVolume,
        ),
        (
            "audio.set-mute",
            "Mute or unmute a sink or source",
            Action::DeviceMute,
        ),
        (
            "audio.set-default",
            "Make a sink or source the default",
            Action::Default,
        ),
        (
            "audio.set-app-volume",
            "Set a playback stream volume",
            Action::AppVolume,
        ),
        (
            "audio.set-app-mute",
            "Mute or unmute a playback stream",
            Action::AppMute,
        ),
        (
            "audio.move-app",
            "Move a playback stream to a sink",
            Action::Move,
        ),
    ] {
        let receiver = receiver.clone();
        commands.register(name, description, move |call| {
            let receiver = receiver.clone();
            async move {
                let control = Control::parse(action, &call)?;
                let sender = receiver
                    .borrow()
                    .clone()
                    .ok_or_else(|| unavailable("audio is unavailable"))?;
                let (reply, result) = oneshot::channel();
                sender
                    .try_send(Request { control, reply })
                    .map_err(|error| match error {
                        mpsc::error::TrySendError::Closed(_) => unavailable("audio is unavailable"),
                        mpsc::error::TrySendError::Full(_) => {
                            RpcError::new(ErrorCode::ResourceExhausted, "too many audio requests")
                        }
                    })?;
                result
                    .await
                    .map_err(|_| unavailable("audio is unavailable"))?
            }
        });
    }
    let endpoint = endpoint?;
    Some(tokio::spawn(async move {
        loop {
            let result = match Client::open(&endpoint).await {
                Ok(client) => session(client, &sender, &mut audio, &mut privacy).await,
                Err(err) => err,
            };
            tracing::debug!(error = %result, "PulseAudio connection unavailable");
            sender.send_replace(None);
            audio.update(Audio::default(), false);
            privacy.update(Privacy::default(), false);
            time::sleep(RETRY).await;
        }
    }))
}

async fn session(
    mut client: Client,
    sender: &watch::Sender<Option<mpsc::Sender<Request>>>,
    topic: &mut Topic<Audio>,
    privacy: &mut Topic<Privacy>,
) -> Error {
    let (requests, mut pending) = mpsc::channel::<Request>(32);
    let mut requests = Some(requests);
    client.dirty = true;
    loop {
        if client.dirty {
            let snapshot = match client.snapshot().await {
                Ok(value) => value,
                Err(error) => return error,
            };
            let capture = snapshot.privacy();
            topic.update(snapshot, true);
            privacy.update(capture, true);
            if let Some(requests) = requests.take() {
                sender.send_replace(Some(requests));
            }
        }
        tokio::select! {
            // Read one byte in select: cancel-safe, and unlike readiness can’t
            // spuriously win over a queued control request on an idle socket.
            first = client.socket.read_u8() => {
                let first = match first {
                    Ok(first) => first,
                    Err(err) => return err.into(),
                };
                if let Err(err) = client.receive_event(first).await { return err; }
            }
            request = pending.recv() => {
                let Some(request) = request else { return Error::Protocol; };
                if request.reply.is_closed() { continue; }
                match request.control.apply(&mut client, topic.value()).await {
                    Ok(()) => { let _ = request.reply.send(Ok(())); }
                    Err(ControlError::Rpc(err)) => { let _ = request.reply.send(Err(err)); }
                    Err(ControlError::Connection(err)) => {
                        let _ = request.reply.send(Err(unavailable("audio connection lost")));
                        return err;
                    }
                }
            }
            _ = std::future::ready(()), if client.dirty => continue,
        }
    }
}
