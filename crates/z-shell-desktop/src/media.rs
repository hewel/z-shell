use std::{
    collections::{BTreeMap, HashMap},
    fmt,
    future::poll_fn,
    io::Read,
    net::IpAddr,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{runtime::Handle, time::timeout};
use ureq::{Agent, http::Uri};
use z_shell_bus::{BusHub, CommandCall, UpdateKind};
use z_shell_protocol::{CommandInvokeResult, MAX_SAFE_JS_INT, MediaRef, RpcError};
use zbus::{
    Connection, MatchRule, Message, MessageStream,
    export::futures_core::Stream,
    fdo::{self, DBusProxy},
    message::Type,
    names::{BusName, OwnedUniqueName},
    zvariant::{OwnedObjectPath, OwnedValue},
};

use crate::{
    OfflinePolicy,
    assets::{MAX_IMAGE_BYTES as MAX_COVER_BYTES, cache_image, local_path, read_bounded},
    disabled, failed, invalid, not_found, ok, payload, publish, register,
};

const TOPIC: &str = "desktop.media";
const PREFIX: &str = "org.mpris.MediaPlayer2.";
const PATH: &str = "/org/mpris/MediaPlayer2";
const ROOT: &str = "org.mpris.MediaPlayer2";
const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const DBUS: &str = "org.freedesktop.DBus";
const NO_TRACK: &str = "/org/mpris/MediaPlayer2/TrackList/NoTrack";
const DBUS_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_WIRE_INTEGER: i64 = MAX_SAFE_JS_INT as i64;
const COVER_TIMEOUT: Duration = Duration::from_secs(10);
// One slow request must not block the next selected cover. Coalesce any further
// changes into a single pending request; local files have an independent slot.
const REMOTE_COVER_WORKERS: usize = 2;

type Properties = HashMap<String, OwnedValue>;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
enum PlaybackStatus {
    Playing,
    Paused,
    Stopped,
    #[default]
    Unknown,
}

impl From<&str> for PlaybackStatus {
    fn from(value: &str) -> Self {
        match value {
            "Playing" => Self::Playing,
            "Paused" => Self::Paused,
            "Stopped" => Self::Stopped,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
struct Metadata {
    track_id: Option<OwnedObjectPath>,
    title: Option<String>,
    album: Option<String>,
    artists: Vec<String>,
    length_us: Option<i64>,
    #[serde(skip)]
    art_url: Option<String>,
}

impl From<Properties> for Metadata {
    fn from(mut values: Properties) -> Self {
        Self {
            track_id: take::<OwnedObjectPath>(&mut values, "mpris:trackid")
                .filter(|id| id.as_str() != NO_TRACK),
            title: take(&mut values, "xesam:title"),
            album: take(&mut values, "xesam:album"),
            artists: take(&mut values, "xesam:artist").unwrap_or_default(),
            length_us: take(&mut values, "mpris:length").and_then(nonnegative_wire_integer),
            art_url: take(&mut values, "mpris:artUrl"),
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
struct Capabilities {
    can_control: bool,
    can_play: bool,
    can_pause: bool,
    can_go_next: bool,
    can_go_previous: bool,
    can_seek: bool,
}

impl From<&Properties> for Capabilities {
    fn from(properties: &Properties) -> Self {
        let enabled = |name| read::<bool>(properties, name).unwrap_or(false);
        let can_control = enabled("CanControl");
        Self {
            can_control,
            can_play: can_control && enabled("CanPlay"),
            can_pause: can_control && enabled("CanPause"),
            can_go_next: can_control && enabled("CanGoNext"),
            can_go_previous: can_control && enabled("CanGoPrevious"),
            can_seek: can_control && enabled("CanSeek"),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Serialize)]
struct Player {
    id: String,
    #[serde(skip)]
    owner: OwnedUniqueName,
    identity: String,
    playback_status: PlaybackStatus,
    position_us: Option<i64>,
    metadata: Metadata,
    capabilities: Capabilities,
}

impl Player {
    async fn query(connection: &Connection, id: &str, owner: &OwnedUniqueName) -> Option<Self> {
        let destination = Some(owner.as_str());
        let (properties, identity) = tokio::join!(
            timeout(
                DBUS_TIMEOUT,
                connection.call_method(destination, PATH, Some(PROPERTIES), "GetAll", &(PLAYER,))
            ),
            timeout(
                DBUS_TIMEOUT,
                connection.call_method(
                    destination,
                    PATH,
                    Some(PROPERTIES),
                    "Get",
                    &(ROOT, "Identity")
                )
            ),
        );
        let mut properties: Properties = properties.ok()?.ok()?.body().deserialize().ok()?;
        let identity = identity
            .ok()
            .and_then(Result::ok)
            .and_then(|reply| reply.body().deserialize::<OwnedValue>().ok())
            .and_then(|value| String::try_from(value).ok())
            .filter(|identity| !identity.is_empty())
            .unwrap_or_else(|| id.strip_prefix(PREFIX).unwrap_or(id).to_owned());
        Some(Self {
            id: id.to_owned(),
            owner: owner.clone(),
            identity,
            playback_status: read::<&str>(&properties, "PlaybackStatus")
                .map(PlaybackStatus::from)
                .unwrap_or_default(),
            position_us: read(&properties, "Position").and_then(nonnegative_wire_integer),
            metadata: take::<Properties>(&mut properties, "Metadata")
                .map(Metadata::from)
                .unwrap_or_default(),
            capabilities: Capabilities::from(&properties),
        })
    }
}

fn read<'a, T: TryFrom<&'a OwnedValue>>(values: &'a Properties, key: &str) -> Option<T> {
    T::try_from(values.get(key)?).ok()
}

fn take<T: TryFrom<OwnedValue>>(values: &mut Properties, key: &str) -> Option<T> {
    T::try_from(values.remove(key)?).ok()
}

fn nonnegative_wire_integer(value: i64) -> Option<i64> {
    (0..=MAX_WIRE_INTEGER).contains(&value).then_some(value)
}

#[derive(Debug)]
struct State {
    connection: Option<Connection>,
    players: Vec<Player>,
    selected: Option<String>,
    offline_policy: OfflinePolicy,
    cover: CoverState,
}

impl State {
    fn index(&self, id: &str) -> Result<usize, usize> {
        self.players
            .binary_search_by(|player| player.id.as_str().cmp(id))
    }

    fn player(&self, id: &str) -> Option<&Player> {
        self.index(id).ok().map(|index| &self.players[index])
    }

    fn selected(&self) -> Option<&Player> {
        self.selected
            .as_deref()
            .and_then(|id| self.player(id))
            .or_else(|| {
                self.players
                    .iter()
                    .min_by_key(|player| player.playback_status)
            })
    }

    fn any_playing(&self) -> bool {
        self.players
            .iter()
            .any(|player| player.playback_status == PlaybackStatus::Playing)
    }

    fn sync_cover(&mut self) {
        let player = self.selected();
        if self
            .cover
            .key
            .as_ref()
            .zip(player)
            .is_some_and(|(key, player)| key.matches(player))
        {
            return;
        }
        let key = player.and_then(CoverKey::for_player);
        if self.cover.key.is_none() && key.is_none() {
            return;
        }
        self.cover.invalidate();
        self.cover.key = key;
        self.cover.reference = None;
        self.cover.queue(self.offline_policy);
    }
}

#[derive(Serialize)]
struct Snapshot<'a> {
    available: bool,
    players: &'a [Player],
    selected_player_id: Option<&'a str>,
    any_playing: bool,
    cover: Option<&'a MediaRef>,
}

pub(crate) struct Media {
    hub: BusHub,
    media_dir: PathBuf,
    agent: Agent,
    runtime: Handle,
    state: Mutex<State>,
}

impl fmt::Debug for Media {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Media")
            .field("media_dir", &self.media_dir)
            .finish_non_exhaustive()
    }
}

impl Media {
    pub(crate) fn install(hub: &BusHub, media_dir: PathBuf, policy: OfflinePolicy) -> Arc<Self> {
        let state = Arc::new(Self {
            hub: hub.clone(),
            media_dir,
            agent: Agent::new_with_config(
                Agent::config_builder()
                    .timeout_global(Some(COVER_TIMEOUT))
                    // An automatic redirect could start another request after going offline.
                    .max_redirects(0)
                    .build(),
            ),
            runtime: Handle::current(),
            state: Mutex::new(State {
                connection: None,
                players: Vec::new(),
                selected: None,
                offline_policy: policy,
                cover: CoverState::default(),
            }),
        });
        state.publish(&state.state(), UpdateKind::SourceBaseline);
        register(
            hub,
            &state,
            "media.select-player",
            "Select a media player or return to automatic selection",
            |media, call| async move { media.select(payload(&call)?) },
        );
        for (name, description, control) in [
            (
                "media.play-pause",
                "Toggle play or pause",
                Control::PlayPause,
            ),
            ("media.next", "Play the next track", Control::Next),
            (
                "media.previous",
                "Play the previous track",
                Control::Previous,
            ),
            (
                "media.seek",
                "Seek by a relative microsecond offset",
                Control::Seek,
            ),
        ] {
            register(
                hub,
                &state,
                name,
                description,
                move |media, call| async move { media.control(control, &call).await },
            );
        }
        state
    }

    pub(crate) async fn run(self: &Arc<Self>, connection: &Connection) -> zbus::Result<()> {
        // Subscribe before discovery so startup cannot miss a player appearing or changing.
        let owner_rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(DBUS)?
            .interface(DBUS)?
            .member("NameOwnerChanged")?
            .arg0ns(ROOT)?
            .build();
        let player_rule = MatchRule::builder()
            .msg_type(Type::Signal)
            .path(PATH)?
            .build();
        let mut owner_events =
            MessageStream::for_match_rule(owner_rule, connection, Some(128)).await?;
        let mut player_events =
            MessageStream::for_match_rule(player_rule, connection, Some(128)).await?;
        let dbus = DBusProxy::new(connection).await?;
        let mut owners = BTreeMap::new();
        let mut players = Vec::new();
        for name in dbus.list_names().await? {
            if !name.as_str().starts_with(PREFIX) {
                continue;
            }
            if let Some(owner) = name_owner(&dbus, name.inner().clone()).await? {
                if let Some(player) = Player::query(connection, name.as_str(), &owner).await {
                    players.push(player);
                }
                owners.insert(name.to_string(), owner);
            }
        }
        players.sort_unstable_by(|left, right| left.id.cmp(&right.id));
        {
            let mut state = self.state();
            state.connection = Some(connection.clone());
            state.players = players;
            self.publish_with_cover(&mut state, UpdateKind::SourceBaseline);
        }

        loop {
            tokio::select! {
                message = next_message(&mut owner_events) => {
                    let Some(message) = message.transpose()? else { return Ok(()) };
                    let body = message.body();
                    let Ok((id, _, _)) = body.deserialize::<(BusName<'_>, &str, &str)>() else { continue };
                    if !id.as_str().starts_with(PREFIX) {
                        continue;
                    }
                    // The snapshot may already include a queued change. Resolve the current
                    // owner rather than replaying a superseded signal's owner.
                    if let Some(owner) = name_owner(&dbus, id.clone()).await? {
                        if owners.get(id.as_str()) != Some(&owner) {
                            let player = Player::query(connection, id.as_str(), &owner).await;
                            self.replace_player(id.as_str(), player);
                            owners.insert(id.to_string(), owner);
                        }
                    } else if owners.remove(id.as_str()).is_some() {
                        self.replace_player(id.as_str(), None);
                    }
                }
                message = next_message(&mut player_events) => {
                    let Some(message) = message.transpose()? else { return Ok(()) };
                    let header = message.header();
                    let (Some(sender), Some(interface), Some(member)) =
                        (header.sender(), header.interface(), header.member()) else { continue };
                    for (id, owner) in &owners {
                        if &**owner != sender {
                            continue;
                        }
                        match (interface.as_str(), member.as_str()) {
                            (PLAYER, "Seeked") => {
                                if let Ok(position) = message.body().deserialize::<i64>() {
                                    self.seeked(id, position);
                                }
                            }
                            (PROPERTIES, "PropertiesChanged") => {
                                if let Some(player) = Player::query(connection, id, owner).await {
                                    self.replace_player(id, Some(player));
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }

    pub(crate) fn disconnected(&self) {
        let mut state = self.state();
        if state.connection.take().is_some() {
            state.players.clear();
            state.selected = None;
            state.sync_cover();
            self.publish(&state, UpdateKind::SourceBaseline);
        }
    }

    pub(crate) fn is_any_playing(&self) -> bool {
        self.state().any_playing()
    }

    pub(crate) fn set_offline_policy(self: &Arc<Self>, policy: OfflinePolicy) {
        let mut state = self.state();
        if state.offline_policy == policy {
            return;
        }
        state.offline_policy = policy;
        if state
            .cover
            .key
            .as_ref()
            .is_some_and(|key| key.source.is_remote())
        {
            state.cover.invalidate();
            if policy == OfflinePolicy::Offline && state.cover.reference.take().is_some() {
                self.publish(&state, UpdateKind::Live);
            }
            state.cover.queue(policy);
            self.start_cover_job(&mut state);
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("media state lock poisoned")
    }

    fn publish(&self, state: &State, kind: UpdateKind) {
        publish(
            &self.hub,
            TOPIC,
            &Snapshot {
                available: state.connection.is_some(),
                players: &state.players,
                selected_player_id: state.selected().map(|player| player.id.as_str()),
                any_playing: state.any_playing(),
                cover: state.cover.reference.as_ref(),
            },
            kind,
        );
    }

    fn replace_player(self: &Arc<Self>, id: &str, player: Option<Player>) {
        let mut state = self.state();
        match (state.index(id), player) {
            (Ok(index), Some(player)) if state.players[index] != player => {
                state.players[index] = player
            }
            (Err(index), Some(player)) => state.players.insert(index, player),
            (Ok(index), None) => {
                state.players.remove(index);
                if state.selected.as_deref() == Some(id) {
                    state.selected = None;
                }
            }
            _ => return,
        }
        self.publish_with_cover(&mut state, UpdateKind::Live);
    }

    fn seeked(&self, id: &str, position: i64) {
        let mut state = self.state();
        let (Ok(index), Some(position)) = (state.index(id), nonnegative_wire_integer(position))
        else {
            return;
        };
        let player = &mut state.players[index];
        if player.position_us != Some(position) {
            player.position_us = Some(position);
            self.publish(&state, UpdateKind::Live);
        }
    }

    fn select(self: &Arc<Self>, request: Selection) -> Result<CommandInvokeResult, RpcError> {
        let mut state = self.state();
        if let Some(id) = request.player_id.as_deref()
            && state.player(id).is_none()
        {
            return Err(not_found("media player not found"));
        }
        if state.selected != request.player_id {
            state.selected = request.player_id;
            self.publish_with_cover(&mut state, UpdateKind::Live);
        }
        Ok(ok())
    }

    fn publish_with_cover(self: &Arc<Self>, state: &mut State, kind: UpdateKind) {
        state.sync_cover();
        self.publish(state, kind);
        self.start_cover_job(state);
    }

    fn start_cover_job(self: &Arc<Self>, state: &mut State) {
        let Some(job) = state.cover.take_job() else {
            return;
        };
        let service = Arc::downgrade(self);
        let cache_dir = self.media_dir.clone();
        let agent = self.agent.clone();
        self.runtime.spawn_blocking(move || {
            let is_current = || {
                service.upgrade().is_some_and(|media| {
                    let state = media.state();
                    state.cover.accepts(&job, state.offline_policy)
                })
            };
            // Check after entering the blocking pool, not just when the job is enqueued.
            let result = if is_current() {
                job.source
                    .read(&agent)
                    .filter(|_| is_current())
                    .and_then(|bytes| cache_image(&cache_dir, &bytes))
            } else {
                None
            };
            if let Some(media) = service.upgrade() {
                media.finish_cover_job(&job, result);
            }
        });
    }

    fn finish_cover_job(self: &Arc<Self>, job: &CoverJob, result: Option<MediaRef>) {
        let mut state = self.state();
        if job.source.is_remote() {
            state.cover.remote_running -= 1;
        } else {
            state.cover.local_running = false;
        }
        if result.is_some() && state.cover.accepts(job, state.offline_policy) {
            state.cover.reference = result;
            self.publish(&state, UpdateKind::Live);
        }
        self.start_cover_job(&mut state);
    }

    async fn control(
        &self,
        control: Control,
        call: &CommandCall,
    ) -> Result<CommandInvokeResult, RpcError> {
        let request: ControlPayload = payload(call)?;
        let (connection, owner) = {
            let state = self.state();
            let connection = state
                .connection
                .as_ref()
                .ok_or_else(|| disabled("media source unavailable"))?;
            let player = match request.player_id.as_deref() {
                Some(id) => state.player(id),
                None => state.selected(),
            }
            .ok_or_else(|| not_found("media player not found"))?;
            if !control.supported(&player.capabilities) {
                return Err(disabled("media player does not support this control"));
            }
            (connection.clone(), player.owner.clone())
        };

        // Address this exact owner so replacement of the public name cannot redirect a control.
        let destination = Some(owner.as_str());
        let result = timeout(DBUS_TIMEOUT, async {
            let method = control.method();
            let result = match control {
                Control::Seek => {
                    let offset = request
                        .offset_us
                        .filter(|value| (-MAX_WIRE_INTEGER..=MAX_WIRE_INTEGER).contains(value))
                        .ok_or_else(|| invalid("seek requires a safe integer offset_us"))?;
                    connection
                        .call_method(destination, PATH, Some(PLAYER), method, &(offset,))
                        .await
                }
                _ => {
                    connection
                        .call_method(destination, PATH, Some(PLAYER), method, &())
                        .await
                }
            };
            result.map_err(|error| {
                tracing::debug!(%error, method, "MPRIS control failed");
                failed("media player rejected the control")
            })
        })
        .await
        .map_err(|_| failed("media player did not respond"))?;
        result?;
        Ok(ok())
    }
}

async fn name_owner(
    dbus: &DBusProxy<'_>,
    name: BusName<'_>,
) -> zbus::Result<Option<OwnedUniqueName>> {
    match dbus.get_name_owner(name).await {
        Ok(owner) => Ok(Some(owner)),
        Err(fdo::Error::NameHasNoOwner(_)) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn next_message(stream: &mut MessageStream) -> Option<zbus::Result<Message>> {
    poll_fn(|context| Pin::new(&mut *stream).poll_next(context)).await
}

#[derive(Deserialize)]
struct Selection {
    player_id: Option<String>,
}

#[derive(Deserialize)]
struct ControlPayload {
    player_id: Option<String>,
    offset_us: Option<i64>,
}

#[derive(Clone, Copy)]
enum Control {
    PlayPause,
    Next,
    Previous,
    Seek,
}

impl Control {
    fn method(self) -> &'static str {
        match self {
            Self::PlayPause => "PlayPause",
            Self::Next => "Next",
            Self::Previous => "Previous",
            Self::Seek => "Seek",
        }
    }

    fn supported(self, capabilities: &Capabilities) -> bool {
        match self {
            Self::PlayPause => capabilities.can_pause,
            Self::Next => capabilities.can_go_next,
            Self::Previous => capabilities.can_go_previous,
            Self::Seek => capabilities.can_seek,
        }
    }
}

#[derive(Debug)]
struct CoverKey {
    player_id: String,
    owner: OwnedUniqueName,
    track_id: Option<OwnedObjectPath>,
    title: Option<String>,
    url: String,
    source: CoverSource,
}

impl CoverKey {
    fn for_player(player: &Player) -> Option<Self> {
        let url = player.metadata.art_url.as_deref()?;
        Some(Self {
            source: CoverSource::parse(url)?,
            player_id: player.id.clone(),
            owner: player.owner.clone(),
            track_id: player.metadata.track_id.clone(),
            title: player.metadata.title.clone(),
            url: url.to_owned(),
        })
    }

    fn matches(&self, player: &Player) -> bool {
        self.player_id == player.id
            && self.owner == player.owner
            && self.track_id == player.metadata.track_id
            && self.title == player.metadata.title
            && player.metadata.art_url.as_deref() == Some(self.url.as_str())
    }
}

#[derive(Debug, Clone)]
enum CoverSource {
    Local(PathBuf),
    Remote(Uri),
}

impl CoverSource {
    fn parse(url: &str) -> Option<Self> {
        if let Some(path) = local_path(url) {
            return Some(Self::Local(path));
        }
        let uri: Uri = url.parse().ok()?;
        (matches!(uri.scheme_str(), Some("http" | "https"))
            && uri
                .authority()
                .is_some_and(|authority| !authority.as_str().contains('@')))
        .then_some(Self::Remote(uri))
    }

    fn is_remote(&self) -> bool {
        matches!(self, Self::Remote(_))
    }

    fn permitted(&self, policy: OfflinePolicy) -> bool {
        !self.is_remote() || policy == OfflinePolicy::Online
    }

    fn read(&self, agent: &Agent) -> Option<Vec<u8>> {
        match self {
            Self::Local(path) => read_bounded(path, MAX_COVER_BYTES),
            Self::Remote(uri) => {
                let request = agent.get(uri.clone());
                // Local players may serve art on loopback, which is never a proxy target.
                let loopback = uri.host().is_some_and(|host| {
                    host.trim_matches(['[', ']'])
                        .parse::<IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
                });
                let mut response = if loopback {
                    request.config().proxy(None).build().call()
                } else {
                    request.call()
                }
                .ok()?;
                if !response.status().is_success() {
                    return None;
                }
                let limit = MAX_COVER_BYTES as u64;
                let body = response.body_mut();
                let length = body.content_length().unwrap_or(0);
                if length > limit {
                    return None;
                }
                let mut bytes = Vec::with_capacity(usize::try_from(length).ok()?);
                body.with_config()
                    .limit(limit)
                    .reader()
                    .read_to_end(&mut bytes)
                    .ok()?;
                Some(bytes)
            }
        }
    }
}

#[derive(Debug)]
struct CoverJob {
    generation: u64,
    source: CoverSource,
}

#[derive(Debug, Default)]
struct CoverState {
    generation: u64,
    key: Option<CoverKey>,
    reference: Option<MediaRef>,
    pending: Option<CoverJob>,
    remote_running: usize,
    local_running: bool,
}

impl CoverState {
    fn invalidate(&mut self) {
        self.generation += 1;
        self.pending = None;
    }

    fn queue(&mut self, policy: OfflinePolicy) {
        if let Some(key) = self.key.as_ref()
            && self.reference.is_none()
            && key.source.permitted(policy)
        {
            self.pending = Some(CoverJob {
                generation: self.generation,
                source: key.source.clone(),
            });
        }
    }

    fn take_job(&mut self) -> Option<CoverJob> {
        if self.pending.as_ref()?.source.is_remote() {
            if self.remote_running == REMOTE_COVER_WORKERS {
                return None;
            }
            self.remote_running += 1;
        } else {
            if self.local_running {
                return None;
            }
            self.local_running = true;
        }
        self.pending.take()
    }

    fn accepts(&self, job: &CoverJob, policy: OfflinePolicy) -> bool {
        self.generation == job.generation && job.source.permitted(policy)
    }
}
