//! Linux system topics and control commands for the shell daemon.
//!
//! Retain the installed [`SystemHandle`] for as long as monitoring and commands
//! should run. Topics exist immediately, even when optional daemons are absent.
//! Initial and reconnected source baselines suppress OSDs and hooks.
//!
//! ## Audio controls
//!
//! Device controls accept a JSON payload with `kind` (`sink` or `source`) and
//! `index` from `system.audio`. `audio.set-volume` also takes a normalized
//! `volume` (`0.0` to `1.0`), and `audio.set-mute` takes a `muted` boolean.
//! `audio.set-app-volume` and `audio.set-app-mute` take the playback stream
//! `index` instead of a device, and `audio.move-app` takes the playback stream
//! `index` and destination `sink_index`. Controls acknowledge the native
//! server's reply; the topic reports observed state.
//!
//! `system.privacy` reports non-corked capture from non-monitor sources.
//! Audio is `unknown` while the backend cannot observe it. Camera and screencast
//! are always `unknown`: PulseAudio does not observe either.
//!
//! ## Other controls
//!
//! - `network.wifi.set-enabled`: `{enabled}`. `network.wifi.scan` and
//!   `network.wifi.disconnect` accept an optional `{device_id}`. Connect with
//!   `{ap_id, password?}` or `{profile_id, ap_id?, device_id?}`; forget with
//!   `{profile_id}`. Passwords require the privileged host control channel.
//! - `bluetooth.set-power`: `{adapter, powered}`; `bluetooth.set-discovery`:
//!   `{adapter, discovering}`. `bluetooth.connect`, `bluetooth.disconnect`,
//!   `bluetooth.pair`, and `bluetooth.remove` take `{device}`.
//!   `bluetooth.trust` takes `{device, trusted}`. Targets are BlueZ object paths
//!   from `system.bluetooth`.
//! - `power.set-profile`: `{profile}` from `system.power`. `power.reboot`,
//!   `power.poweroff`, `power.suspend`, and `power.logout` require the privileged
//!   host control channel and take no payload.
//! - `brightness.set`: `{device, value}` from `system.brightness`; the raw
//!   integer value is clamped to the selected backlight's supported range.

mod audio;
mod bluetooth;
pub mod brightness;
mod network;
mod power;
pub mod telemetry;
pub mod user;

pub use audio::PulseEndpoint;

use std::{
    future::Future,
    path::PathBuf,
    sync::{Arc, Weak},
    time::Duration,
};

use serde::{Serialize, de::DeserializeOwned};
use tokio::{
    sync::{Mutex, watch},
    task::JoinHandle,
    time::{self, Instant},
};
use z_shell_bus::{BusHub, CommandCall, UpdateKind};
use z_shell_config::ShellPaths;
use z_shell_protocol::{CommandInvokeResult, CommandName, ErrorCode, RpcError, TopicName};
use zbus::{Connection, connection::Builder};

/// Source of the system D-Bus connection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum SystemBusAddress {
    /// Resolve the system bus using zbus and the environment.
    #[default]
    Default,
    /// Connect to an explicit D-Bus address, including an isolated test bus.
    Address(String),
    /// Do not connect to D-Bus, even if there is a running system bus.
    Disabled,
}

/// Linux filesystem and socket endpoints, overridable for isolated invocations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemOptions {
    /// PulseAudio endpoint, or `None` for no audio observation.
    pub pulse: Option<PulseEndpoint>,
    /// System D-Bus connection configuration.
    pub system_bus: SystemBusAddress,
    /// Root containing `stat` and `meminfo`.
    pub proc_root: PathBuf,
    /// Root containing `class/thermal`.
    pub sys_root: PathBuf,
    /// Directory containing backlight devices.
    pub backlight_root: PathBuf,
}

impl Default for SystemOptions {
    fn default() -> Self {
        Self {
            pulse: PulseEndpoint::from_env(),
            system_bus: SystemBusAddress::Default,
            proc_root: PathBuf::from("/proc"),
            sys_root: PathBuf::from("/sys"),
            backlight_root: PathBuf::from("/sys/class/backlight"),
        }
    }
}

/// Entry point for installing the Linux system domains on a bus hub.
#[derive(Debug)]
pub struct SystemServices;

impl SystemServices {
    /// Installs system topics and commands using the desktop environment.
    ///
    /// # Panics
    /// Panics if called outside a Tokio runtime with I/O and time enabled.
    pub fn install(hub: &BusHub, paths: &ShellPaths) -> SystemHandle {
        Self::install_with_options(hub, paths, SystemOptions::default())
    }

    /// Installs system topics and commands with explicit source endpoints.
    ///
    /// Install once per hub. No external daemon is required at installation.
    ///
    /// # Panics
    /// Panics if called outside a Tokio runtime with I/O and time enabled.
    pub fn install_with_options(
        hub: &BusHub,
        paths: &ShellPaths,
        options: SystemOptions,
    ) -> SystemHandle {
        let (stop, active) = watch::channel(());
        let commands = Commands {
            hub: hub.clone(),
            active,
        };
        let (owner, bus) = SystemBus::new(options.system_bus);
        let mut workers = Vec::with_capacity(7);
        workers.extend(audio::install(hub, &commands, options.pulse));
        workers.push(network::install(hub, &commands, bus.clone()));
        workers.push(bluetooth::install(hub, &commands, bus.clone()));
        workers.push(power::install(hub, &commands, bus.clone()));
        workers.push(brightness::install(
            hub,
            &commands,
            bus.clone(),
            options.backlight_root,
        ));
        workers.push(telemetry::install(hub, options.proc_root, options.sys_root));
        workers.push(user::install(hub, paths, bus));
        SystemHandle {
            stop,
            workers,
            _bus: owner,
        }
    }
}

/// Owns system monitoring tasks and the lifetime of installed control commands.
#[derive(Debug)]
#[must_use = "dropping the handle stops system services"]
pub struct SystemHandle {
    stop: watch::Sender<()>,
    workers: Vec<JoinHandle<()>>,
    _bus: Arc<SystemBusInner>,
}

impl Drop for SystemHandle {
    fn drop(&mut self) {
        self.stop.send_replace(());
        for worker in &self.workers {
            worker.abort();
        }
    }
}

struct Topic<T> {
    hub: BusHub,
    name: TopicName,
    current: T,
    source_available: bool,
    baseline_pending: bool,
}

impl<T: Serialize + PartialEq> Topic<T> {
    fn new(hub: &BusHub, name: &'static str, initial: T) -> Self {
        let name = TopicName::try_new(name).expect("static system topic name must be valid");
        hub.publish_core_topic(
            name.clone(),
            serde_json::to_value(&initial).expect("system topic state must serialize"),
            UpdateKind::SourceBaseline,
        );
        Self {
            hub: hub.clone(),
            name,
            current: initial,
            source_available: false,
            baseline_pending: false,
        }
    }

    fn resync(&mut self) {
        self.baseline_pending = true;
    }

    fn value(&self) -> &T {
        &self.current
    }

    fn update(&mut self, next: T, source_available: bool) {
        let baseline = self.baseline_pending || (!self.source_available && source_available);
        self.source_available = source_available;
        self.baseline_pending = false;
        if !baseline && self.current == next {
            return;
        }
        let kind = if baseline {
            UpdateKind::SourceBaseline
        } else {
            UpdateKind::Live
        };
        self.hub.publish_core_topic(
            self.name.clone(),
            serde_json::to_value(&next).expect("system topic state must serialize"),
            kind,
        );
        self.current = next;
    }
}

struct Commands {
    hub: BusHub,
    active: watch::Receiver<()>,
}

impl Commands {
    fn register<F, Fut>(&self, name: &'static str, description: &'static str, run: F)
    where
        F: Fn(CommandCall) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), RpcError>> + Send + 'static,
    {
        let active = self.active.clone();
        self.hub.register_core_command(
            CommandName::try_new(name).expect("static system command name must be valid"),
            description,
            Arc::new(move |call| {
                let mut active = active.clone();
                let command = run(call);
                Box::pin(async move {
                    tokio::select! {
                        biased;
                        _ = active.changed() => Err(unavailable("system services have stopped")),
                        result = command => {
                            result?;
                            Ok(CommandInvokeResult { message: None, data: None })
                        }
                    }
                })
            }),
        );
    }
}

fn payload<T: DeserializeOwned>(call: &CommandCall) -> Result<T, RpcError> {
    match (call.params.args.is_empty(), &call.params.payload) {
        (true, Some(value @ serde_json::Value::Object(_))) => {
            T::deserialize(value).map_err(|_| invalid("invalid command payload"))
        }
        _ => Err(invalid("expected a JSON object payload")),
    }
}

fn invalid(message: &'static str) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, message)
}

fn unavailable(message: &'static str) -> RpcError {
    RpcError::new(ErrorCode::Disabled, message)
}

fn failed(message: &'static str) -> RpcError {
    RpcError::new(ErrorCode::Internal, message)
}

// Registered commands remain in the hub after shutdown. They must not keep
// the connection (and BlueZ's discovery lease) alive after the handle drops.
#[derive(Clone)]
struct SystemBus(Weak<SystemBusInner>);

#[derive(Debug)]
struct SystemBusInner {
    address: SystemBusAddress,
    state: Mutex<BusState>,
}

#[derive(Debug, Default)]
struct BusState {
    connection: Option<Connection>,
    retry_at: Option<Instant>,
}

impl SystemBus {
    fn new(address: SystemBusAddress) -> (Arc<SystemBusInner>, Self) {
        let owner = Arc::new(SystemBusInner {
            address,
            state: Mutex::new(BusState::default()),
        });
        let bus = Self(Arc::downgrade(&owner));
        (owner, bus)
    }

    async fn connection(&self) -> Option<Connection> {
        let bus = self.0.upgrade()?;
        if bus.address == SystemBusAddress::Disabled {
            return None;
        }
        let mut state = bus.state.lock().await;
        if let Some(connection) = &state.connection
            && !connection.is_closed()
        {
            return Some(connection.clone());
        }
        if state.retry_at.is_some_and(|when| when > Instant::now()) {
            return None;
        }
        let connection = Self::connect(&bus.address).await;
        state.retry_at = connection
            .is_none()
            .then(|| Instant::now() + Duration::from_secs(2));
        state.connection = connection.clone();
        connection
    }

    async fn fresh_connection(&self) -> Option<Connection> {
        let bus = self.0.upgrade()?;
        Self::connect(&bus.address).await
    }

    async fn connect(address: &SystemBusAddress) -> Option<Connection> {
        let builder = match address {
            SystemBusAddress::Default => Builder::system(),
            SystemBusAddress::Address(address) => Builder::address(address.as_str()),
            SystemBusAddress::Disabled => return None,
        }
        .ok()?;
        // Pairing can involve user interaction; the setup deadline is separate.
        time::timeout(
            Duration::from_secs(3),
            builder.method_timeout(Duration::from_secs(30)).build(),
        )
        .await
        .ok()?
        .ok()
    }
}
