//! NetworkManager integration over the system D-Bus.
//!
//! The `system.network` Topic exposes each radio and its access points under
//! `wifi.devices`. Device and AP IDs are opaque, transient NetworkManager object
//! paths, not interface names, BSSIDs or SSIDs. `ssid` is for display;
//! `ssid_bytes` preserves the exact SSID. The `wifi.profiles` list exposes Wi-Fi
//! profile IDs (NetworkManager UUIDs), independent of AP visibility.
//!
//! `network.wifi.*` commands accept JSON objects, never positional arguments:
//! - `set-enabled`: `{ "enabled": true }`
//! - `scan` / `disconnect`: `{ "device_id": "..." }` (omit to target all radios)
//! - `connect`: `{ "ap_id": "...", "password": "..." }` for a new WPA personal
//!   connection. Omit the password for open or OWE networks.
//! - `connect`: `{ "profile_id": "..." }` to reuse an existing Wi-Fi profile,
//!   including enterprise or legacy security. An optional `device_id` targets
//!   a radio; an optional `ap_id` targets an AP on that radio (or selects its
//!   radio when `device_id` is omitted). Do not send a password with a profile ID.
//! - `forget`: `{ "profile_id": "..." }` deletes that Wi-Fi profile in NM.
//!
//! A password is only accepted from a privileged host. It is returned once to
//! NetworkManager over a private, sender-checked D-Bus SecretAgent request.
//! A password-bearing profile is volatile and its PSK is marked `not-saved`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, Notify, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{self, Instant};
use z_shell_bus::{BusHub, CommandCall};
use z_shell_protocol::{ClientRole, ErrorCode, RpcError};
use zbus::fdo::DBusProxy;
use zbus::message::Header;
use zbus::names::OwnedUniqueName;
use zbus::object_server::ResponseDispatchNotifier;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};
use zbus::{Connection, Proxy};

use crate::{Commands, SystemBus, Topic, failed, invalid, payload, unavailable};

const NM: &str = "org.freedesktop.NetworkManager";
const NM_PATH: &str = "/org/freedesktop/NetworkManager";
const DEVICE: &str = "org.freedesktop.NetworkManager.Device";
const WIRELESS: &str = "org.freedesktop.NetworkManager.Device.Wireless";
const WIRED: &str = "org.freedesktop.NetworkManager.Device.Wired";
const ACCESS_POINT: &str = "org.freedesktop.NetworkManager.AccessPoint";
const ACTIVE_CONNECTION: &str = "org.freedesktop.NetworkManager.Connection.Active";
const SETTINGS: &str = "org.freedesktop.NetworkManager.Settings";
const SETTINGS_PATH: &str = "/org/freedesktop/NetworkManager/Settings";
const SETTINGS_CONNECTION: &str = "org.freedesktop.NetworkManager.Settings.Connection";
const WIFI_SETTING: &str = "802-11-wireless";
const SECURITY_SETTING: &str = "802-11-wireless-security";
const ROOT: ObjectPath<'static> = ObjectPath::from_static_str_unchecked("/");
const SECRET_AGENT_PATH: &str = "/org/freedesktop/NetworkManager/SecretAgent";
const AGENT_MANAGER: &str = "org.freedesktop.NetworkManager.AgentManager";
const AGENT_MANAGER_PATH: &str = "/org/freedesktop/NetworkManager/AgentManager";
// NM_SETTING_SECRET_FLAG_NOT_SAVED also excludes the PSK from runtime keyfiles.
const SECRET_NOT_SAVED: u32 = 0x2;

// NetworkManager's NMDeviceType and NM80211Ap*Flags D-Bus enums.
const ETHERNET: u32 = 1;
const WIFI: u32 = 2;
const PRIVACY: u32 = 0x1;
const PSK: u32 = 0x100;
const EAP: u32 = 0x200;
const SAE: u32 = 0x400;
const OWE: u32 = 0x800;
const OWE_TRANSITION: u32 = 0x1000;
const EAP_SUITE_B: u32 = 0x2000;

const REFRESH_INTERVAL: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_secs(4);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const PASSWORD_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const SCAN_TIMEOUT: Duration = Duration::from_secs(20);

type Properties = HashMap<String, OwnedValue>;
type Settings = HashMap<String, Properties>;
type Options<'a> = HashMap<&'static str, Value<'a>>;
type NewSettings<'a> = HashMap<&'static str, Options<'a>>;

#[derive(Default, PartialEq, Serialize)]
struct Network {
    available: bool,
    connectivity: Connectivity,
    wifi: Wifi,
    ethernet: Vec<Ethernet>,
    vpn: Vec<ActiveConnection>,
}

#[derive(Default, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Connectivity {
    #[default]
    Unknown,
    None,
    Portal,
    Limited,
    Full,
}

impl From<u32> for Connectivity {
    fn from(raw: u32) -> Self {
        match raw {
            1 => Self::None,
            2 => Self::Portal,
            3 => Self::Limited,
            4 => Self::Full,
            _ => Self::Unknown,
        }
    }
}

#[derive(Default, PartialEq, Serialize)]
struct Wifi {
    enabled: bool,
    hardware_enabled: bool,
    scanning: bool,
    devices: Vec<WifiDevice>,
    profiles: Vec<Profile>,
}

#[derive(PartialEq, Serialize)]
struct WifiDevice {
    id: OwnedObjectPath,
    interface: String,
    active_ap_id: Option<OwnedObjectPath>,
    active_connection: Option<ActiveConnection>,
    access_points: Vec<AccessPoint>,
}

#[derive(PartialEq, Serialize)]
struct AccessPoint {
    id: OwnedObjectPath,
    ssid: String,
    ssid_bytes: Vec<u8>,
    bssid: String,
    strength: u8,
    security: Security,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Security {
    Open,
    Owe,
    WpaPsk,
    WpaSae,
    Enterprise,
    Unsupported,
}

impl Security {
    fn from_flags(flags: u32, wpa: u32, rsn: u32) -> Self {
        if (wpa | rsn) & PSK != 0 {
            // NetworkManager's wpa-psk also supports WPA2/WPA3 transition mode.
            Self::WpaPsk
        } else if rsn & SAE != 0 {
            Self::WpaSae
        } else if rsn & (OWE | OWE_TRANSITION) != 0 {
            Self::Owe
        } else if (wpa | rsn) & (EAP | EAP_SUITE_B) != 0 {
            Self::Enterprise
        } else if flags & PRIVACY == 0 && wpa == 0 && rsn == 0 {
            Self::Open
        } else {
            Self::Unsupported
        }
    }
}

impl AccessPoint {
    fn from_properties(id: OwnedObjectPath, mut properties: Properties) -> Option<Self> {
        let ssid_bytes: Vec<u8> = take(&mut properties, "Ssid")?;
        if ssid_bytes.is_empty() {
            // No usable identity until NetworkManager knows the hidden SSID.
            return None;
        }
        let security = Security::from_flags(
            take(&mut properties, "Flags")?,
            take(&mut properties, "WpaFlags")?,
            take(&mut properties, "RsnFlags")?,
        );
        Some(Self {
            id,
            ssid: String::from_utf8_lossy(&ssid_bytes).into_owned(),
            ssid_bytes,
            bssid: take(&mut properties, "HwAddress")?,
            strength: take(&mut properties, "Strength")?,
            security,
        })
    }
}

#[derive(PartialEq, Serialize)]
struct Ethernet {
    id: OwnedObjectPath,
    interface: String,
    carrier: bool,
    active_connection: Option<ActiveConnection>,
}

#[derive(PartialEq, Serialize)]
struct ActiveConnection {
    id: OwnedObjectPath,
    profile_id: String,
    name: String,
    state: ConnectionState,
}

#[derive(PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ConnectionState {
    Unknown,
    Activating,
    Activated,
    Deactivating,
    Deactivated,
}

impl ActiveConnection {
    fn from_properties(id: OwnedObjectPath, properties: &mut Properties) -> Option<Self> {
        Some(Self {
            id,
            profile_id: take(properties, "Uuid")?,
            name: take(properties, "Id")?,
            state: match take::<u32>(properties, "State")? {
                1 => ConnectionState::Activating,
                2 => ConnectionState::Activated,
                3 => ConnectionState::Deactivating,
                4 => ConnectionState::Deactivated,
                _ => ConnectionState::Unknown,
            },
        })
    }
}

#[derive(PartialEq, Serialize)]
struct Profile {
    id: String,
    name: String,
    ssid: String,
    ssid_bytes: Vec<u8>,
}

impl Profile {
    fn from_settings(mut settings: Settings) -> Option<Self> {
        let mut connection = settings.remove("connection")?;
        if take::<String>(&mut connection, "type")? != WIFI_SETTING {
            return None;
        }
        let mut wireless = settings.remove(WIFI_SETTING)?;
        let ssid_bytes: Vec<u8> = take(&mut wireless, "ssid")?;
        Some(Self {
            id: take(&mut connection, "uuid")?,
            name: take(&mut connection, "id")?,
            ssid: String::from_utf8_lossy(&ssid_bytes).into_owned(),
            ssid_bytes,
        })
    }
}

fn take<T: TryFrom<OwnedValue>>(properties: &mut Properties, key: &str) -> Option<T> {
    T::try_from(properties.remove(key)?).ok()
}

struct Nm {
    connection: Connection,
    owner: OwnedUniqueName,
}

impl Nm {
    async fn new(connection: Connection) -> zbus::Result<Self> {
        let owner = DBusProxy::new(&connection)
            .await?
            .get_name_owner(NM.try_into()?)
            .await?;
        Ok(Self { connection, owner })
    }

    async fn proxy<'a>(
        &'a self,
        path: &'a str,
        interface: &'static str,
    ) -> zbus::Result<Proxy<'a>> {
        Proxy::new(&self.connection, self.owner.as_str(), path, interface).await
    }

    async fn properties(&self, path: &str, interface: &'static str) -> zbus::Result<Properties> {
        self.proxy(path, "org.freedesktop.DBus.Properties")
            .await?
            .call("GetAll", &(interface,))
            .await
    }

    async fn active_connection(&self, path: OwnedObjectPath) -> Option<ActiveConnection> {
        if path.as_str() == "/" {
            return None;
        }
        let mut properties = self
            .properties(path.as_str(), ACTIVE_CONNECTION)
            .await
            .ok()?;
        ActiveConnection::from_properties(path, &mut properties)
    }

    async fn access_point(&self, path: OwnedObjectPath) -> Option<AccessPoint> {
        let properties = self.properties(path.as_str(), ACCESS_POINT).await.ok()?;
        AccessPoint::from_properties(path, properties)
    }

    async fn profile(&self, path: &OwnedObjectPath) -> Option<Profile> {
        // GetSettings cannot return secrets; do not query GetSecrets.
        let settings = self
            .proxy(path.as_str(), SETTINGS_CONNECTION)
            .await
            .ok()?
            .call("GetSettings", &())
            .await
            .ok()?;
        Profile::from_settings(settings)
    }

    async fn snapshot(&self) -> zbus::Result<Snapshot> {
        let mut manager = self.properties(NM_PATH, NM).await?;
        let mut devices: Vec<OwnedObjectPath> =
            take(&mut manager, "Devices").ok_or(zbus::Error::MissingField)?;
        let mut active: Vec<OwnedObjectPath> =
            take(&mut manager, "ActiveConnections").ok_or(zbus::Error::MissingField)?;
        let mut network = Network {
            available: true,
            connectivity: take::<u32>(&mut manager, "Connectivity")
                .unwrap_or_default()
                .into(),
            wifi: Wifi {
                enabled: take(&mut manager, "WirelessEnabled").unwrap_or_default(),
                hardware_enabled: take(&mut manager, "WirelessHardwareEnabled").unwrap_or_default(),
                ..Wifi::default()
            },
            ..Network::default()
        };
        let mut last_scans = Vec::new();
        devices.sort_unstable_by(|a, b| a.as_str().cmp(b.as_str()));
        for path in devices {
            let Ok(mut properties) = self.properties(path.as_str(), DEVICE).await else {
                continue; // A device may disappear between the manager and device reads.
            };
            let Some(interface) = take(&mut properties, "Interface") else {
                continue;
            };
            let active = take(&mut properties, "ActiveConnection");
            match take::<u32>(&mut properties, "DeviceType") {
                Some(WIFI) => {
                    let Ok(mut wireless) = self.properties(path.as_str(), WIRELESS).await else {
                        continue;
                    };
                    let active_ap_id: Option<OwnedObjectPath> =
                        take(&mut wireless, "ActiveAccessPoint");
                    let active_ap_id = active_ap_id.filter(|ap| ap.as_str() != "/");
                    let mut paths: Vec<OwnedObjectPath> =
                        take(&mut wireless, "AccessPoints").unwrap_or_default();
                    let mut access_points = Vec::with_capacity(paths.len());
                    paths.sort_unstable_by(|a, b| a.as_str().cmp(b.as_str()));
                    for ap_path in paths {
                        if let Some(ap) = self.access_point(ap_path).await {
                            access_points.push(ap);
                        }
                    }
                    if let Some(last_scan) = take(&mut wireless, "LastScan") {
                        last_scans.push((path.clone(), last_scan));
                    }
                    network.wifi.devices.push(WifiDevice {
                        id: path,
                        interface,
                        active_ap_id,
                        active_connection: match active {
                            Some(path) => self.active_connection(path).await,
                            None => None,
                        },
                        access_points,
                    });
                }
                Some(ETHERNET) => {
                    let carrier = self
                        .properties(path.as_str(), WIRED)
                        .await
                        .ok()
                        .and_then(|mut wired| take(&mut wired, "Carrier"))
                        .unwrap_or_default();
                    network.ethernet.push(Ethernet {
                        id: path,
                        interface,
                        carrier,
                        active_connection: match active {
                            Some(path) => self.active_connection(path).await,
                            None => None,
                        },
                    });
                }
                _ => {}
            }
        }
        active.sort_unstable_by(|a, b| a.as_str().cmp(b.as_str()));
        for path in active {
            if network
                .wifi
                .devices
                .iter()
                .filter_map(|device| device.active_connection.as_ref())
                .chain(
                    network
                        .ethernet
                        .iter()
                        .filter_map(|device| device.active_connection.as_ref()),
                )
                .any(|connection| connection.id == path)
            {
                continue;
            }
            let Ok(mut properties) = self.properties(path.as_str(), ACTIVE_CONNECTION).await else {
                continue;
            };
            // VPN plugins expose Vpn=true; WireGuard is a native device type.
            let vpn = take(&mut properties, "Vpn").unwrap_or_default()
                || take::<String>(&mut properties, "Type").as_deref() == Some("wireguard");
            if vpn
                && let Some(connection) = ActiveConnection::from_properties(path, &mut properties)
            {
                network.vpn.push(connection);
            }
        }
        let settings = self.proxy(SETTINGS_PATH, SETTINGS).await?;
        if let Ok(paths) = settings
            .call::<_, _, Vec<OwnedObjectPath>>("ListConnections", &())
            .await
        {
            for path in paths {
                if let Some(profile) = self.profile(&path).await {
                    network.wifi.profiles.push(profile);
                }
            }
            network
                .wifi
                .profiles
                .sort_unstable_by(|a, b| a.id.cmp(&b.id));
        }
        Ok(Snapshot {
            network,
            last_scans,
        })
    }
}

struct Snapshot {
    network: Network,
    last_scans: Vec<(OwnedObjectPath, i64)>,
}

struct PendingScan {
    owner: OwnedUniqueName,
    device_id: OwnedObjectPath,
    before: i64,
    accepted: Instant,
}

impl PendingScan {
    fn pending_at(
        &self,
        owner: &OwnedUniqueName,
        enabled: bool,
        last_scans: &[(OwnedObjectPath, i64)],
        observed_at: Instant,
    ) -> bool {
        // An observation that started before acceptance cannot settle the scan.
        if self.accepted > observed_at {
            return true;
        }
        self.owner == *owner
            && enabled
            && observed_at.duration_since(self.accepted) < SCAN_TIMEOUT
            && last_scans
                .iter()
                .any(|(id, last)| id == &self.device_id && *last == self.before)
    }
}

#[derive(Default)]
struct Control {
    scan_requests: AsyncMutex<()>,
    scans: Mutex<Vec<PendingScan>>,
    refresh: Notify,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetEnabled {
    enabled: bool,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceTarget {
    device_id: Option<OwnedObjectPath>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Connect {
    device_id: Option<OwnedObjectPath>,
    ap_id: Option<OwnedObjectPath>,
    profile_id: Option<String>,
    password: Option<String>,
}

impl Connect {
    fn authorize(&self, role: ClientRole) -> Result<(), RpcError> {
        if self.password.is_some() && role != ClientRole::PrivilegedHost {
            return Err(RpcError::new(
                ErrorCode::PermissionDenied,
                "Wi-Fi passwords require the host control channel",
            ));
        }
        if self.profile_id.is_some() && self.password.is_some() {
            return Err(invalid("password cannot be combined with a profile ID"));
        }
        if self.profile_id.is_none() && self.ap_id.is_none() {
            return Err(invalid(
                "an access-point ID or Wi-Fi profile ID is required",
            ));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Forget {
    profile_id: String,
}

#[derive(Clone, Copy)]
enum Command {
    SetEnabled,
    Scan,
    Connect,
    Disconnect,
    Forget,
}

enum Action {
    SetEnabled(SetEnabled),
    Scan(DeviceTarget),
    Connect(Connect),
    Disconnect(DeviceTarget),
    Forget(Forget),
}

impl Command {
    fn parse(self, call: &CommandCall) -> Result<Action, RpcError> {
        if !call.params.args.is_empty() {
            return Err(invalid("Wi-Fi commands do not accept positional arguments"));
        }
        let target = || {
            if call.params.payload.is_none() {
                Ok(DeviceTarget::default())
            } else {
                payload(call)
            }
        };
        Ok(match self {
            Self::SetEnabled => Action::SetEnabled(payload(call)?),
            Self::Scan => Action::Scan(target()?),
            Self::Connect => {
                let connect: Connect = payload(call)?;
                connect.authorize(call.caller.role)?;
                Action::Connect(connect)
            }
            Self::Disconnect => Action::Disconnect(target()?),
            Self::Forget => Action::Forget(payload(call)?),
        })
    }
}

impl Action {
    async fn run(self, bus: &SystemBus, control: &Control) -> Result<(), RpcError> {
        let password = matches!(&self, Self::Connect(connect) if connect.password.is_some());
        let deadline = if password {
            PASSWORD_COMMAND_TIMEOUT
        } else {
            COMMAND_TIMEOUT
        };
        let result = time::timeout(deadline, async {
            let connection = if password {
                // Dropping this invocation's bus connection also unregisters its agent.
                bus.fresh_connection().await
            } else {
                bus.connection().await
            };
            let connection = connection.ok_or_else(|| unavailable("NetworkManager unavailable"))?;
            let nm = Nm::new(connection)
                .await
                .map_err(|_| unavailable("NetworkManager unavailable"))?;
            match self {
                Self::SetEnabled(SetEnabled { enabled }) => nm.set_enabled(enabled).await,
                Self::Scan(target) => nm.scan(target, control).await,
                Self::Connect(connect) => nm.connect(connect).await,
                Self::Disconnect(target) => nm.disconnect(target).await,
                Self::Forget(Forget { profile_id }) => nm.forget(&profile_id).await,
            }
        })
        .await;
        control.refresh.notify_one();
        result.map_err(|_| RpcError::new(ErrorCode::Timeout, "Wi-Fi operation timed out"))?
    }
}

struct WifiTarget {
    id: OwnedObjectPath,
    active: bool,
}

impl Nm {
    async fn set_enabled(&self, enabled: bool) -> Result<(), RpcError> {
        self.proxy(NM_PATH, NM)
            .await
            .map_err(nm_failure)?
            .set_property("WirelessEnabled", enabled)
            .await
            .map_err(|_| failed("NetworkManager could not change Wi-Fi radio state"))
    }

    async fn wifi_targets(
        &self,
        id: Option<&OwnedObjectPath>,
    ) -> Result<Vec<WifiTarget>, RpcError> {
        let devices: Vec<OwnedObjectPath> = self
            .proxy(NM_PATH, NM)
            .await
            .map_err(nm_failure)?
            .call("GetDevices", &())
            .await
            .map_err(nm_failure)?;
        let mut targets = Vec::new();
        for path in devices
            .into_iter()
            .filter(|path| id.is_none_or(|id| id == path))
        {
            let Ok(mut properties) = self.properties(path.as_str(), DEVICE).await else {
                continue;
            };
            if take(&mut properties, "DeviceType") == Some(WIFI) {
                let active = take::<OwnedObjectPath>(&mut properties, "ActiveConnection")
                    .is_some_and(|path| path.as_str() != "/");
                targets.push(WifiTarget { id: path, active });
            }
        }
        if targets.is_empty() {
            return Err(if id.is_some() {
                invalid("unknown Wi-Fi device ID")
            } else {
                unavailable("no Wi-Fi devices available")
            });
        }
        Ok(targets)
    }

    async fn scan(&self, target: DeviceTarget, control: &Control) -> Result<(), RpcError> {
        let devices = self.wifi_targets(target.device_id.as_ref()).await?;
        let options = Options::new();
        let mut requested = false;
        // Serialize overlapping scan requests so a late reply cannot overwrite
        // the LastScan baseline of a newer request.
        let _request = control.scan_requests.lock().await;
        for WifiTarget { id, .. } in devices {
            let Ok(mut properties) = self.properties(id.as_str(), WIRELESS).await else {
                continue;
            };
            let Some(before) = take(&mut properties, "LastScan") else {
                continue;
            };
            let proxy = self
                .proxy(id.as_str(), WIRELESS)
                .await
                .map_err(nm_failure)?;
            if proxy
                .call::<_, _, ()>("RequestScan", &(&options,))
                .await
                .is_ok()
            {
                let mut scans = control
                    .scans
                    .lock()
                    .expect("Wi-Fi scan state lock poisoned");
                scans.retain(|scan| scan.device_id != id || scan.owner != self.owner);
                scans.push(PendingScan {
                    owner: self.owner.clone(),
                    device_id: id,
                    before,
                    accepted: Instant::now(),
                });
                control.refresh.notify_one();
                requested = true;
            }
        }
        if requested {
            Ok(())
        } else {
            Err(failed("NetworkManager did not accept a Wi-Fi scan"))
        }
    }

    async fn disconnect(&self, target: DeviceTarget) -> Result<(), RpcError> {
        let devices = self.wifi_targets(target.device_id.as_ref()).await?;
        let mut disconnected_all = true;
        for device in devices.into_iter().filter(|device| device.active) {
            let proxy = self
                .proxy(device.id.as_str(), DEVICE)
                .await
                .map_err(nm_failure)?;
            // Device.Disconnect blocks immediate autoconnect on this radio.
            disconnected_all &= proxy.call::<_, _, ()>("Disconnect", &()).await.is_ok();
        }
        if disconnected_all {
            Ok(())
        } else {
            Err(failed("NetworkManager could not disconnect Wi-Fi"))
        }
    }

    async fn wifi_profile(&self, id: &str) -> Result<(OwnedObjectPath, Profile), RpcError> {
        let path = self
            .proxy(SETTINGS_PATH, SETTINGS)
            .await
            .map_err(nm_failure)?
            .call("GetConnectionByUuid", &(id,))
            .await
            .map_err(|_| invalid("unknown Wi-Fi profile ID"))?;
        let profile = self
            .profile(&path)
            .await
            .ok_or_else(|| invalid("unknown Wi-Fi profile ID"))?;
        Ok((path, profile))
    }

    async fn forget(&self, id: &str) -> Result<(), RpcError> {
        let (path, _) = self.wifi_profile(id).await?;
        self.proxy(path.as_str(), SETTINGS_CONNECTION)
            .await
            .map_err(nm_failure)?
            .call("Delete", &())
            .await
            .map_err(|_| failed("NetworkManager could not delete the Wi-Fi profile"))
    }

    async fn find_ap(
        &self,
        ap_id: &OwnedObjectPath,
        device_id: Option<&OwnedObjectPath>,
    ) -> Result<(OwnedObjectPath, AccessPoint), RpcError> {
        for device in self.wifi_targets(device_id).await? {
            let Ok(mut wireless) = self.properties(device.id.as_str(), WIRELESS).await else {
                continue;
            };
            let paths: Vec<OwnedObjectPath> =
                take(&mut wireless, "AccessPoints").unwrap_or_default();
            if let Some(path) = paths.into_iter().find(|path| path == ap_id)
                && let Some(ap) = self.access_point(path).await
            {
                return Ok((device.id, ap));
            }
        }
        Err(invalid("unknown Wi-Fi access-point ID"))
    }

    async fn connect(&self, connect: Connect) -> Result<(), RpcError> {
        let ap = match connect.ap_id.as_ref() {
            Some(ap_id) => Some(self.find_ap(ap_id, connect.device_id.as_ref()).await?),
            None => None,
        };
        let manager = self.proxy(NM_PATH, NM).await.map_err(nm_failure)?;
        if let Some(id) = connect.profile_id {
            let (profile_path, profile) = self.wifi_profile(&id).await?;
            let (device_path, ap_path) = if let Some((device, ap)) = ap {
                if profile.ssid_bytes != ap.ssid_bytes {
                    return Err(invalid("Wi-Fi profile does not match the access point"));
                }
                (device.into_inner(), ap.id.into_inner())
            } else if let Some(device) = connect.device_id.as_ref() {
                self.wifi_targets(Some(device)).await?;
                (device.as_ref(), ROOT)
            } else {
                (ROOT, ROOT)
            };
            let _: OwnedObjectPath = manager
                .call("ActivateConnection", &(profile_path, device_path, ap_path))
                .await
                .map_err(|_| failed("NetworkManager could not activate the Wi-Fi profile"))?;
        } else if let Some((device, ap)) = ap {
            let activation = Activation::new(&ap, connect.password.as_deref())?;
            let mut settings = activation.settings(&ap);
            let mut dispatched = None;
            if let Some(password) = connect.password {
                let (uuid, reception) = self.register_secret_agent(password).await?;
                settings.insert(
                    "connection",
                    Options::from([
                        ("type", Value::new(WIFI_SETTING)),
                        ("uuid", Value::new(uuid)),
                        ("autoconnect", Value::new(false)),
                    ]),
                );
                dispatched = Some(reception);
            }
            let options = Options::from([("persist", Value::new(activation.persistence()))]);
            let _: (OwnedObjectPath, OwnedObjectPath, Properties) = manager
                .call(
                    "AddAndActivateConnection2",
                    &(settings, device, ap.id.as_ref(), options),
                )
                .await
                .map_err(|_| failed("NetworkManager could not activate the Wi-Fi network"))?;
            if let Some(dispatched) = dispatched {
                dispatched
                    .await
                    .map_err(|_| failed("Wi-Fi credential was not delivered"))?;
            }
        } else {
            return Err(invalid(
                "an access-point ID or Wi-Fi profile ID is required",
            ));
        }
        Ok(())
    }

    async fn register_secret_agent(
        &self,
        password: String,
    ) -> Result<(String, oneshot::Receiver<()>), RpcError> {
        // NetworkManager can request the credential before returning the
        // activation reply, so identify the profile with a caller-chosen UUID.
        let uuid = std::fs::read_to_string("/proc/sys/kernel/random/uuid")
            .map_err(|_| failed("could not allocate a Wi-Fi profile ID"))?;
        let uuid = uuid.trim().to_owned();
        let id = format!("org.z_shell.Network.request_{uuid}");
        let (sent, reception) = oneshot::channel();
        let agent = SecretAgent {
            owner: self.owner.clone(),
            uuid: uuid.clone(),
            credential: Some((password, sent)),
        };
        self.connection
            .object_server()
            .at(SECRET_AGENT_PATH, agent)
            .await
            .map_err(nm_failure)?;
        self.proxy(AGENT_MANAGER_PATH, AGENT_MANAGER)
            .await
            .map_err(nm_failure)?
            .call::<_, _, ()>("Register", &(id,))
            .await
            .map_err(|_| failed("NetworkManager could not register the Wi-Fi secret agent"))?;
        Ok((uuid, reception))
    }
}

fn nm_failure(_: zbus::Error) -> RpcError {
    failed("NetworkManager operation failed")
}

enum Activation {
    Open,
    Owe,
    Psk,
    Sae,
}

impl Activation {
    fn new(ap: &AccessPoint, password: Option<&str>) -> Result<Self, RpcError> {
        if password.is_some_and(|password| password.is_empty() || password.contains('\0')) {
            return Err(invalid("invalid Wi-Fi password"));
        }
        match (ap.security, password) {
            (Security::Open, None) => Ok(Self::Open),
            (Security::Owe, None) => Ok(Self::Owe),
            (Security::WpaSae, Some(_)) => Ok(Self::Sae),
            (Security::WpaPsk, Some(password)) => {
                let valid_passphrase = (8..=63).contains(&password.len()) && password.is_ascii();
                let valid_key =
                    password.len() == 64 && password.bytes().all(|c| c.is_ascii_hexdigit());
                if valid_passphrase || valid_key {
                    Ok(Self::Psk)
                } else {
                    Err(invalid("invalid WPA passphrase or pre-shared key"))
                }
            }
            (Security::Open | Security::Owe, Some(_)) => {
                Err(invalid("this access point does not accept a password"))
            }
            (Security::WpaPsk | Security::WpaSae, None) => Err(invalid(
                "this access point requires a password or a saved profile",
            )),
            (Security::Enterprise | Security::Unsupported, _) => {
                Err(invalid("this Wi-Fi security mode requires a saved profile"))
            }
        }
    }

    fn persistence(&self) -> &'static str {
        match self {
            Self::Open | Self::Owe => "disk",
            Self::Psk | Self::Sae => "volatile",
        }
    }

    fn settings<'a>(&self, ap: &'a AccessPoint) -> NewSettings<'a> {
        let mut settings = NewSettings::from([(
            WIFI_SETTING,
            Options::from([("ssid", Value::new(ap.ssid_bytes.as_slice()))]),
        )]);
        let key_mgmt = match self {
            Self::Open => return settings,
            Self::Owe => "owe",
            Self::Psk => "wpa-psk",
            Self::Sae => "sae",
        };
        let mut security = Options::from([("key-mgmt", Value::new(key_mgmt))]);
        if matches!(self, Self::Psk | Self::Sae) {
            security.insert("psk-flags", Value::new(SECRET_NOT_SAVED));
        }
        settings.insert(SECURITY_SETTING, security);
        settings
    }
}

struct SecretAgent {
    owner: OwnedUniqueName,
    uuid: String,
    credential: Option<(String, oneshot::Sender<()>)>,
}

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.freedesktop.NetworkManager.SecretAgent")]
enum SecretError {
    NoSecrets(String),
}

#[zbus::interface(name = "org.freedesktop.NetworkManager.SecretAgent")]
impl SecretAgent {
    fn get_secrets(
        &mut self,
        mut connection: Settings,
        _connection_path: ObjectPath<'_>,
        setting_name: &str,
        _hints: Vec<String>,
        _flags: u32,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<ResponseDispatchNotifier<NewSettings<'static>>, SecretError> {
        let no_secret = || SecretError::NoSecrets("no credential for this connection".into());
        if header
            .sender()
            .is_none_or(|sender| sender.as_str() != self.owner.as_str())
        {
            return Err(no_secret());
        }
        let profile_id = connection
            .get_mut("connection")
            .and_then(|settings| take::<String>(settings, "uuid"));
        if setting_name != SECURITY_SETTING || profile_id.as_deref() != Some(self.uuid.as_str()) {
            return Err(no_secret());
        }
        let (password, sent) = self.credential.take().ok_or_else(no_secret)?;
        let (response, dispatched) = ResponseDispatchNotifier::new(NewSettings::from([(
            SECURITY_SETTING,
            Options::from([("psk", Value::new(password))]),
        )]));
        tokio::spawn(async move {
            dispatched.await;
            let _ = sent.send(());
        });
        Ok(response)
    }
}

/// Installs the NetworkManager Topic and Wi-Fi control commands.
pub(crate) fn install(hub: &BusHub, commands: &Commands, bus: SystemBus) -> JoinHandle<()> {
    let mut topic = Topic::new(hub, "system.network", Network::default());
    let control = Arc::new(Control::default());
    for (kind, name, description) in [
        (
            Command::SetEnabled,
            "network.wifi.set-enabled",
            "Enable or disable Wi-Fi",
        ),
        (
            Command::Scan,
            "network.wifi.scan",
            "Scan a Wi-Fi radio for access points",
        ),
        (
            Command::Connect,
            "network.wifi.connect",
            "Connect to a Wi-Fi access point or profile",
        ),
        (
            Command::Disconnect,
            "network.wifi.disconnect",
            "Disconnect a Wi-Fi radio",
        ),
        (
            Command::Forget,
            "network.wifi.forget",
            "Delete a Wi-Fi profile",
        ),
    ] {
        let control = Arc::clone(&control);
        let bus = bus.clone();
        commands.register(name, description, move |call| {
            let control = Arc::clone(&control);
            let bus = bus.clone();
            async move {
                let action = kind.parse(&call)?;
                drop(call);
                action.run(&bus, &control).await
            }
        });
    }
    tokio::spawn(async move {
        let mut previous_owner = None;
        loop {
            let observed_at = Instant::now();
            let sample = time::timeout(READ_TIMEOUT, async {
                let connection = bus.connection().await?;
                let nm = Nm::new(connection).await.ok()?;
                let snapshot = nm.snapshot().await.ok()?;
                Some((nm.owner, snapshot))
            })
            .await;
            if let Ok(Some((owner, mut snapshot))) = sample {
                let mut scans = control
                    .scans
                    .lock()
                    .expect("Wi-Fi scan state lock poisoned");
                let enabled = snapshot.network.wifi.enabled;
                scans.retain(|scan| {
                    scan.pending_at(&owner, enabled, &snapshot.last_scans, observed_at)
                });
                snapshot.network.wifi.scanning =
                    enabled && scans.iter().any(|scan| scan.owner == owner);
                drop(scans);
                if previous_owner
                    .as_ref()
                    .is_some_and(|previous| previous != &owner)
                {
                    topic.resync();
                }
                previous_owner = Some(owner);
                topic.update(snapshot.network, true);
            } else {
                control
                    .scans
                    .lock()
                    .expect("Wi-Fi scan state lock poisoned")
                    .retain(|scan| scan.accepted > observed_at);
                previous_owner = None;
                topic.update(Network::default(), false);
            }
            tokio::select! {
                () = time::sleep(REFRESH_INTERVAL) => {}
                () = control.refresh.notified() => {}
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_network_manager_has_no_availability_or_stale_connections() {
        let value = serde_json::to_value(Network::default()).unwrap();
        assert_eq!(value["available"], false);
        assert_eq!(value["connectivity"], "unknown");
        assert_eq!(value["wifi"]["enabled"], false);
        assert_eq!(value["wifi"]["scanning"], false);
        assert_eq!(value["wifi"]["devices"], serde_json::json!([]));
        assert_eq!(value["ethernet"], serde_json::json!([]));
        assert_eq!(value["vpn"], serde_json::json!([]));
    }

    #[test]
    fn projects_scan_results_with_lossless_identity_and_advertised_security() {
        let properties = HashMap::from([
            (
                "Ssid".into(),
                OwnedValue::try_from(Value::new(vec![b'H', 0xff])).unwrap(),
            ),
            ("Flags".into(), OwnedValue::from(1_u32)),
            ("WpaFlags".into(), OwnedValue::from(0_u32)),
            ("RsnFlags".into(), OwnedValue::from(0x400_u32)),
            (
                "HwAddress".into(),
                OwnedValue::try_from(Value::new("00:11:22:33:44:55")).unwrap(),
            ),
            ("Strength".into(), OwnedValue::from(59_u8)),
        ]);
        let path = "/org/freedesktop/NetworkManager/AccessPoint/12";
        let ap = AccessPoint::from_properties(path.try_into().unwrap(), properties).unwrap();
        let value = serde_json::to_value(ap).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": path,
                "ssid": "H\u{fffd}",
                "ssid_bytes": [72, 255],
                "bssid": "00:11:22:33:44:55",
                "strength": 59,
                "security": "wpa_sae",
            })
        );
    }

    #[test]
    fn saved_wifi_profile_has_a_stable_identity_independent_of_scan_results() {
        let text = |value| OwnedValue::try_from(Value::new(value)).unwrap();
        let settings = |kind| {
            Settings::from([
                (
                    "connection".into(),
                    Properties::from([
                        ("type".into(), text(kind)),
                        ("uuid".into(), text("98164500-e528-4a8d-bc23-59095f2dc297")),
                        ("id".into(), text("Office profile")),
                    ]),
                ),
                (
                    "802-11-wireless".into(),
                    Properties::from([(
                        "ssid".into(),
                        OwnedValue::try_from(Value::new(b"Office".as_slice())).unwrap(),
                    )]),
                ),
            ])
        };
        let wifi = Profile::from_settings(settings("802-11-wireless")).unwrap();
        let value = serde_json::to_value(wifi).unwrap();
        assert_eq!(value["id"], "98164500-e528-4a8d-bc23-59095f2dc297");
        assert_eq!(value["name"], "Office profile");
        assert_eq!(value["ssid"], "Office");
        assert!(Profile::from_settings(settings("802-3-ethernet")).is_none());
    }

    #[test]
    fn password_payload_requires_privileged_host() {
        let connect: Connect = serde_json::from_value(serde_json::json!({
            "ap_id": "/org/freedesktop/NetworkManager/AccessPoint/12",
            "password": "a known passphrase",
        }))
        .unwrap();
        let error = connect.authorize(ClientRole::Public).unwrap_err();
        assert_eq!(error.code, ErrorCode::PermissionDenied);
        assert!(!error.message.contains("a known passphrase"));
        assert!(connect.authorize(ClientRole::PrivilegedHost).is_ok());
    }

    #[test]
    fn personal_activation_creates_a_volatile_profile_without_a_stored_psk() {
        let ap = AccessPoint {
            id: "/org/freedesktop/NetworkManager/AccessPoint/1"
                .try_into()
                .unwrap(),
            ssid: "example".into(),
            ssid_bytes: b"example".to_vec(),
            bssid: "00:11:22:33:44:55".into(),
            strength: 70,
            security: Security::WpaPsk,
        };
        let activation = Activation::new(&ap, Some("example test password")).unwrap();
        let settings = activation.settings(&ap);
        let security = &settings["802-11-wireless-security"];
        assert_eq!(activation.persistence(), "volatile");
        assert_eq!(security["psk-flags"].downcast_ref::<u32>().unwrap(), 2);
        assert!(!security.contains_key("psk"));
    }

    #[tokio::test]
    async fn secret_agent_replies_once_and_only_to_network_manager_for_the_exact_profile() {
        use zbus::Message;

        let (sender, receipt) = oneshot::channel();
        let mut agent = SecretAgent {
            owner: ":1.5".try_into().unwrap(),
            uuid: "test-profile".into(),
            credential: Some(("example test password".into(), sender)),
        };
        let message = |owner| {
            Message::method_call(SECRET_AGENT_PATH, "GetSecrets")
                .unwrap()
                .sender(owner)
                .unwrap()
                .build(&())
                .unwrap()
        };
        let settings = |uuid| {
            Settings::from([(
                "connection".into(),
                Properties::from([(
                    "uuid".into(),
                    OwnedValue::try_from(Value::new(uuid)).unwrap(),
                )]),
            )])
        };
        let wrong_owner = message(":1.6");
        let nm = message(":1.5");
        assert!(
            agent
                .get_secrets(
                    settings("test-profile"),
                    ROOT,
                    SECURITY_SETTING,
                    Vec::new(),
                    0,
                    wrong_owner.header(),
                )
                .is_err()
        );
        assert!(
            agent
                .get_secrets(
                    settings("unrelated-profile"),
                    ROOT,
                    SECURITY_SETTING,
                    Vec::new(),
                    0,
                    nm.header(),
                )
                .is_err()
        );
        let response = agent
            .get_secrets(
                settings("test-profile"),
                ROOT,
                SECURITY_SETTING,
                Vec::new(),
                0,
                nm.header(),
            )
            .unwrap();
        assert_eq!(
            response.response()[SECURITY_SETTING]["psk"]
                .downcast_ref::<&str>()
                .unwrap(),
            "example test password",
        );
        drop(response);
        receipt.await.unwrap();
        assert!(
            agent
                .get_secrets(
                    settings("test-profile"),
                    ROOT,
                    SECURITY_SETTING,
                    Vec::new(),
                    0,
                    nm.header(),
                )
                .is_err()
        );
    }

    #[test]
    fn scan_finishes_only_after_the_matching_devices_last_scan_advances() {
        let started = Instant::now();
        let sampled = started + Duration::from_secs(1);
        let device: OwnedObjectPath = "/org/freedesktop/NetworkManager/Devices/1"
            .try_into()
            .unwrap();
        let owner: OwnedUniqueName = ":1.5".try_into().unwrap();
        let pending = PendingScan {
            owner: owner.clone(),
            device_id: device.clone(),
            before: -1,
            accepted: started,
        };
        assert!(pending.pending_at(&owner, true, &[(device.clone(), -1)], sampled));
        assert!(!pending.pending_at(&owner, true, &[(device.clone(), 25)], sampled));
        assert!(!pending.pending_at(&owner, false, &[(device.clone(), -1)], sampled));
        assert!(!pending.pending_at(&owner, true, &[], sampled));
        assert!(!pending.pending_at(&owner, true, &[(device, -1)], started + SCAN_TIMEOUT,));
    }
}
