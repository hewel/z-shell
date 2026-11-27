//! UPower, power profiles, and logind session actions.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;
use tokio::time::{self, MissedTickBehavior};
use z_shell_bus::BusHub;
use z_shell_protocol::{ClientRole, ErrorCode, MAX_SAFE_JS_INT, RpcError};
use zbus::names::{BusName, OwnedUniqueName};
use zbus::proxy::{Builder, CacheProperties};
use zbus::zvariant::{OwnedObjectPath, OwnedValue};
use zbus::{Connection, Proxy};

use crate::{Commands, SystemBus, Topic, failed, invalid, payload, unavailable};

const UPOWER: &str = "org.freedesktop.UPower";
const UPOWER_PATH: &str = "/org/freedesktop/UPower";
const UPOWER_DEVICE: &str = "org.freedesktop.UPower.Device";
const DISPLAY_DEVICE: &str = "/org/freedesktop/UPower/devices/DisplayDevice";
const PPD_ENDPOINTS: [(&str, &str); 2] = [
    (
        "org.freedesktop.UPower.PowerProfiles",
        "/org/freedesktop/UPower/PowerProfiles",
    ),
    ("net.hadess.PowerProfiles", "/net/hadess/PowerProfiles"),
];
const LOGIND: &str = "org.freedesktop.login1";
const LOGIND_PATH: &str = "/org/freedesktop/login1";
const LOGIND_MANAGER: &str = "org.freedesktop.login1.Manager";
const LOGIND_SESSION: &str = "org.freedesktop.login1.Session";
const QUERY_TIMEOUT: Duration = Duration::from_secs(2);
const ACTION_TIMEOUT: Duration = Duration::from_secs(30);
const TYPE_LINE_POWER: u32 = 1;
const TYPE_BATTERY: u32 = 2;
const TYPE_UPS: u32 = 3;

type Properties = HashMap<String, OwnedValue>;

#[derive(Default, PartialEq, Serialize)]
struct Power {
    /// Availability of UPower, independent of the power profiles daemon.
    available: bool,
    on_ac: Option<bool>,
    battery: Option<Battery>,
    profiles: Profiles,
}

#[derive(PartialEq, Serialize)]
struct Battery {
    percentage: Option<f64>,
    state: BatteryState,
    time_to_empty_seconds: Option<u64>,
    time_to_full_seconds: Option<u64>,
    energy_rate_watts: Option<f64>,
    capacity_percent: Option<f64>,
    /// Highest reported cycle count among present system battery packs.
    charge_cycles: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum BatteryState {
    Unknown,
    Charging,
    Discharging,
    Full,
    PendingCharge,
    PendingDischarge,
}

impl From<u32> for BatteryState {
    fn from(state: u32) -> Self {
        match state {
            1 => Self::Charging,
            2 => Self::Discharging,
            4 => Self::Full,
            5 => Self::PendingCharge,
            6 => Self::PendingDischarge,
            _ => Self::Unknown,
        }
    }
}

impl Battery {
    fn from_display(properties: &Properties) -> Option<Self> {
        if !property::<bool>(properties, "IsPresent")?
            || !matches!(property(properties, "Type"), Some(TYPE_BATTERY | TYPE_UPS))
        {
            return None;
        }
        Some(Self {
            percentage: property(properties, "Percentage").and_then(percent),
            state: BatteryState::from(property::<u32>(properties, "State").unwrap_or_default()),
            time_to_empty_seconds: seconds(properties, "TimeToEmpty"),
            time_to_full_seconds: seconds(properties, "TimeToFull"),
            energy_rate_watts: property::<f64>(properties, "EnergyRate")
                .filter(|value| value.is_finite() && *value >= 0.0),
            capacity_percent: capacity(properties),
            charge_cycles: cycles(properties),
        })
    }
}

#[derive(Default)]
struct BatteryHealth {
    packs: usize,
    design_readings: usize,
    energy_full: f64,
    energy_full_design: f64,
    reported_capacity: Option<f64>,
    charge_cycles: Option<u32>,
}

impl BatteryHealth {
    fn add_pack(&mut self, properties: &Properties, device_type: u32) {
        if property(properties, "Type") != Some(device_type)
            || property(properties, "PowerSupply") != Some(true)
            || property(properties, "IsPresent") != Some(true)
        {
            return;
        }
        self.packs += 1;
        self.reported_capacity = capacity(properties);
        self.charge_cycles = self.charge_cycles.max(cycles(properties));

        if let (Some(full), Some(design)) = (
            property::<f64>(properties, "EnergyFull").filter(|v| v.is_finite() && *v > 0.0),
            property::<f64>(properties, "EnergyFullDesign").filter(|v| v.is_finite() && *v > 0.0),
        ) {
            self.design_readings += 1;
            self.energy_full += full;
            self.energy_full_design += design;
        }
    }

    fn capacity_percent(&self) -> Option<f64> {
        if self.packs == 1 && self.reported_capacity.is_some() {
            return self.reported_capacity;
        }
        if self.packs > 0 && self.design_readings == self.packs {
            return percent(self.energy_full / self.energy_full_design * 100.0);
        }
        None
    }
}

fn property<'a, T>(properties: &'a Properties, name: &str) -> Option<T>
where
    T: TryFrom<&'a OwnedValue>,
{
    T::try_from(properties.get(name)?).ok()
}

fn seconds(properties: &Properties, name: &str) -> Option<u64> {
    let value: i64 = property(properties, name)?;
    u64::try_from(value)
        .ok()
        .filter(|value| (1..=MAX_SAFE_JS_INT).contains(value))
}

fn percent(value: f64) -> Option<f64> {
    value.is_finite().then(|| value.clamp(0.0, 100.0))
}

fn capacity(properties: &Properties) -> Option<f64> {
    percent(property::<f64>(properties, "Capacity")?).filter(|value| *value > 0.0)
}

fn cycles(properties: &Properties) -> Option<u32> {
    u32::try_from(property::<i32>(properties, "ChargeCycles")?).ok()
}

#[derive(Default, PartialEq, Serialize)]
struct Profiles {
    available: bool,
    active_profile: Option<String>,
    profiles: Vec<String>,
}

impl Profiles {
    fn from_properties(mut properties: Properties) -> Option<Self> {
        let active = String::try_from(properties.remove("ActiveProfile")?).ok()?;
        let profiles = Vec::<Properties>::try_from(properties.remove("Profiles")?).ok()?;
        let profiles: Vec<String> = profiles
            .into_iter()
            .filter_map(|mut profile| String::try_from(profile.remove("Profile")?).ok())
            .collect();
        profiles
            .iter()
            .any(|profile| profile == &active)
            .then_some(Self {
                available: true,
                active_profile: Some(active),
                profiles,
            })
    }
}

#[derive(Deserialize)]
struct SetProfile {
    profile: String,
}

pub(crate) fn install(hub: &BusHub, commands: &Commands, bus: SystemBus) -> JoinHandle<()> {
    let profile_bus = bus.clone();
    commands.register(
        "power.set-profile",
        "Select a power profile: payload {profile: string} from system.power profiles",
        move |call| {
            let bus = profile_bus.clone();
            async move { set_profile(&bus, payload(&call)?).await }
        },
    );
    for (name, description, action) in [
        (
            "power.reboot",
            "Restart the system (privileged host only)",
            "Reboot",
        ),
        (
            "power.poweroff",
            "Power off the system (privileged host only)",
            "PowerOff",
        ),
        (
            "power.logout",
            "Terminate this login session (privileged host only)",
            "Terminate",
        ),
    ] {
        let bus = bus.clone();
        commands.register(name, description, move |call| {
            let bus = bus.clone();
            async move {
                require_host_role(call.caller.role)?;
                if !call.params.args.is_empty() || call.params.payload.is_some() {
                    return Err(invalid("power session actions take no arguments"));
                }
                logind_action(&bus, action).await
            }
        });
    }

    let mut topic = Topic::new(hub, "system.power", Power::default());
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_secs(3));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut upower_owner = None;
        let mut ppd_owner = None;
        loop {
            interval.tick().await;
            let mut snapshot = Power::default();
            let mut next_upower_owner = None;
            let mut next_ppd_owner = None;
            if let Some(connection) = bus.connection().await {
                let (upower, profiles) = tokio::join!(
                    read_upower(&connection),
                    time::timeout(QUERY_TIMEOUT, read_profiles(&connection)),
                );
                if let Some((owner, on_ac, battery)) = upower {
                    snapshot.available = true;
                    snapshot.on_ac = on_ac;
                    snapshot.battery = battery;
                    next_upower_owner = Some(owner);
                }
                if let Ok(Some((owner, _, _, profiles))) = profiles {
                    snapshot.profiles = profiles;
                    next_ppd_owner = Some(owner);
                }
            }
            if (next_upower_owner.is_some() && next_upower_owner != upower_owner)
                || (next_ppd_owner.is_some() && next_ppd_owner != ppd_owner)
            {
                topic.resync();
            }
            let available = next_upower_owner.is_some() || next_ppd_owner.is_some();
            topic.update(snapshot, available);
            upower_owner = next_upower_owner;
            ppd_owner = next_ppd_owner;
        }
    })
}

async fn get_all(
    connection: &Connection,
    destination: BusName<'_>,
    path: &str,
    interface: &str,
) -> Option<(OwnedUniqueName, Properties)> {
    let reply = connection
        .call_method(
            Some(destination),
            path,
            Some("org.freedesktop.DBus.Properties"),
            "GetAll",
            &(interface,),
        )
        .await
        .ok()?;
    let sender = reply.header().sender()?.to_owned().into();
    let properties = reply.body().deserialize::<Properties>().ok()?;
    Some((sender, properties))
}

async fn read_upower(
    connection: &Connection,
) -> Option<(OwnedUniqueName, Option<bool>, Option<Battery>)> {
    let (owner, on_ac) = time::timeout(QUERY_TIMEOUT, async {
        let (owner, daemon) =
            get_all(connection, UPOWER.try_into().ok()?, UPOWER_PATH, UPOWER).await?;
        let on_ac = property::<bool>(&daemon, "OnBattery").map(|on_battery| !on_battery);
        Some((owner, on_ac))
    })
    .await
    .ok()??;
    let display = time::timeout(
        QUERY_TIMEOUT,
        get_all(connection, (&owner).into(), DISPLAY_DEVICE, UPOWER_DEVICE),
    )
    .await
    .ok()
    .flatten()
    .map(|(_, display)| display);
    let mut battery = display.as_ref().and_then(Battery::from_display);
    // DisplayDevice does not normally expose health or cycle counts. Use individual
    // packs for health and explicit line power when available.
    let battery_type = battery
        .as_ref()
        .and_then(|_| property(display.as_ref()?, "Type"));
    let supply = time::timeout(
        QUERY_TIMEOUT / 2,
        read_power_supply(connection, &owner, battery_type),
    )
    .await
    .ok()
    .flatten();
    if let Some(battery) = &mut battery
        && let Some((_, health)) = &supply
    {
        battery.capacity_percent = health.capacity_percent().or(battery.capacity_percent);
        battery.charge_cycles = health.charge_cycles.or(battery.charge_cycles);
    }
    Some((
        owner,
        supply.and_then(|(online, _)| online).or(on_ac),
        battery,
    ))
}

async fn read_power_supply(
    connection: &Connection,
    owner: &OwnedUniqueName,
    battery_type: Option<u32>,
) -> Option<(Option<bool>, BatteryHealth)> {
    let reply = connection
        .call_method(
            Some(owner),
            UPOWER_PATH,
            Some(UPOWER),
            "EnumerateDevices",
            &(),
        )
        .await
        .ok()?;
    let paths = reply.body().deserialize::<Vec<OwnedObjectPath>>().ok()?;
    let mut online = None;
    let mut health = BatteryHealth::default();
    for path in paths {
        if let Some((_, properties)) =
            get_all(connection, owner.into(), path.as_str(), UPOWER_DEVICE).await
        {
            if property(&properties, "Type") == Some(TYPE_LINE_POWER) {
                online = online.max(property::<bool>(&properties, "Online"));
            } else if let Some(battery_type) = battery_type {
                health.add_pack(&properties, battery_type);
            }
        }
    }
    Some((online, health))
}

async fn read_profiles(
    connection: &Connection,
) -> Option<(OwnedUniqueName, &'static str, &'static str, Profiles)> {
    for (name, path) in PPD_ENDPOINTS {
        if let Ok(Some((owner, properties))) = time::timeout(
            QUERY_TIMEOUT / 2,
            get_all(connection, name.try_into().ok()?, path, name),
        )
        .await
            && let Some(profiles) = Profiles::from_properties(properties)
        {
            return Some((owner, name, path, profiles));
        }
    }
    None
}

async fn set_profile(bus: &SystemBus, request: SetProfile) -> Result<(), RpcError> {
    let connection = bus
        .connection()
        .await
        .ok_or_else(|| unavailable("system bus is unavailable"))?;
    let (owner, interface, path, profiles) =
        time::timeout(QUERY_TIMEOUT, read_profiles(&connection))
            .await
            .ok()
            .flatten()
            .ok_or_else(|| unavailable("power profiles are unavailable"))?;
    if !profiles.profiles.contains(&request.profile) {
        return Err(invalid("power profile is not supported"));
    }
    let proxy = dbus_proxy(&connection, owner.into(), path, interface)
        .await
        .map_err(|_| unavailable("power profiles are unavailable"))?;
    time::timeout(
        ACTION_TIMEOUT,
        proxy.set_property("ActiveProfile", request.profile.as_str()),
    )
    .await
    .map_err(|_| failed("power profile request timed out"))?
    .map_err(|_| failed("power profiles daemon rejected the setting"))
}

fn require_host_role(role: ClientRole) -> Result<(), RpcError> {
    if role == ClientRole::PrivilegedHost {
        Ok(())
    } else {
        Err(RpcError::new(
            ErrorCode::PermissionDenied,
            "power action requires the privileged host control channel",
        ))
    }
}

async fn logind_action(bus: &SystemBus, action: &'static str) -> Result<(), RpcError> {
    let connection = bus
        .connection()
        .await
        .ok_or_else(|| unavailable("system bus is unavailable"))?;
    time::timeout(ACTION_TIMEOUT, async {
        let result = if action == "Terminate" {
            let session = logind_session(&connection)
                .await
                .ok_or_else(|| unavailable("logind session is unavailable"))?;
            session.call::<_, _, ()>(action, &()).await
        } else {
            let manager = logind_manager(&connection)
                .await
                .map_err(|_| unavailable("logind is unavailable"))?;
            manager.call::<_, _, ()>(action, &(true,)).await
        };
        match result {
            Ok(()) => Ok(()),
            Err(zbus::Error::MethodError(name, _, _))
                if matches!(
                    name.as_str(),
                    "org.freedesktop.DBus.Error.ServiceUnknown"
                        | "org.freedesktop.DBus.Error.NameHasNoOwner"
                ) =>
            {
                Err(unavailable("logind is unavailable"))
            }
            Err(_) => Err(failed("logind rejected the power action")),
        }
    })
    .await
    .map_err(|_| failed("logind power request timed out"))?
}

pub(super) async fn logind_session(connection: &Connection) -> Option<Proxy<'static>> {
    let manager = logind_manager(connection).await.ok()?;
    // `auto` chooses the caller's own session, or its user's display session when
    // the daemon runs under the user service manager. Older logind lacks `auto`.
    let path = match manager
        .call::<_, _, OwnedObjectPath>("GetSession", &("auto",))
        .await
    {
        Ok(path) => path,
        Err(_) => manager
            .call("GetSessionByPID", &(std::process::id(),))
            .await
            .ok()?,
    };
    dbus_proxy(connection, LOGIND.try_into().ok()?, path, LOGIND_SESSION)
        .await
        .ok()
}

async fn logind_manager(connection: &Connection) -> zbus::Result<Proxy<'static>> {
    dbus_proxy(connection, LOGIND.try_into()?, LOGIND_PATH, LOGIND_MANAGER).await
}

async fn dbus_proxy(
    connection: &Connection,
    destination: BusName<'static>,
    path: impl TryInto<zbus::zvariant::ObjectPath<'static>, Error: Into<zbus::Error>>,
    interface: &'static str,
) -> zbus::Result<Proxy<'static>> {
    Builder::<Proxy<'static>>::new(connection)
        .destination(destination)?
        .path(path)?
        .interface(interface)?
        .cache_properties(CacheProperties::No)
        .build()
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use zbus::zvariant::Value;

    #[test]
    fn display_device_preserves_charge_state_and_unknown_measurements() {
        let properties = Properties::from([
            ("IsPresent".into(), OwnedValue::from(true)),
            ("Type".into(), OwnedValue::from(2_u32)),
            ("State".into(), OwnedValue::from(2_u32)),
            ("Percentage".into(), OwnedValue::from(37.5)),
            ("EnergyRate".into(), OwnedValue::from(9.25)),
            ("TimeToEmpty".into(), OwnedValue::from(2700_i64)),
            ("TimeToFull".into(), OwnedValue::from(0_i64)),
            ("Capacity".into(), OwnedValue::from(0.0)),
            ("ChargeCycles".into(), OwnedValue::from(-1_i32)),
        ]);
        let battery = Battery::from_display(&properties).unwrap();
        assert_eq!(battery.state, BatteryState::Discharging);
        assert_eq!(battery.percentage, Some(37.5));
        assert_eq!(battery.energy_rate_watts, Some(9.25));
        assert_eq!(battery.time_to_empty_seconds, Some(2700));
        assert_eq!(battery.time_to_full_seconds, None);
        assert_eq!(battery.capacity_percent, None);
        assert_eq!(battery.charge_cycles, None);
    }

    #[test]
    fn absent_display_battery_does_not_emit_a_zero_percent_battery() {
        let properties = Properties::from([
            ("IsPresent".into(), OwnedValue::from(false)),
            ("Type".into(), OwnedValue::from(2_u32)),
            ("Percentage".into(), OwnedValue::from(0.0)),
        ]);
        assert!(Battery::from_display(&properties).is_none());
    }

    #[test]
    fn battery_health_uses_system_packs_and_weights_by_design_energy() {
        let pack = |full, design, cycles, supplies_system| {
            Properties::from([
                ("Type".into(), OwnedValue::from(2_u32)),
                ("IsPresent".into(), OwnedValue::from(true)),
                ("PowerSupply".into(), OwnedValue::from(supplies_system)),
                ("EnergyFull".into(), OwnedValue::from(full)),
                ("EnergyFullDesign".into(), OwnedValue::from(design)),
                ("ChargeCycles".into(), OwnedValue::from(cycles)),
            ])
        };
        let mut health = BatteryHealth::default();
        health.add_pack(&pack(18.0, 20.0, 95_i32, true), 2);
        health.add_pack(&pack(42.0, 60.0, 102_i32, true), 2);
        health.add_pack(&pack(1.0, 2.0, 333_i32, false), 2);
        assert_eq!(health.capacity_percent(), Some(75.0));
        assert_eq!(health.charge_cycles, Some(102));
    }

    #[test]
    fn profiles_only_advertise_names_exposed_by_the_backend() {
        let profile = |name: &str| {
            Properties::from([(
                "Profile".into(),
                OwnedValue::try_from(Value::from(name)).unwrap(),
            )])
        };
        let properties = Properties::from([
            (
                "ActiveProfile".into(),
                OwnedValue::try_from(Value::from("balanced")).unwrap(),
            ),
            (
                "Profiles".into(),
                OwnedValue::try_from(Value::from(vec![
                    profile("power-saver"),
                    profile("balanced"),
                ]))
                .unwrap(),
            ),
        ]);
        let profiles = Profiles::from_properties(properties).unwrap();
        assert_eq!(profiles.active_profile.as_deref(), Some("balanced"));
        assert_eq!(profiles.profiles, ["power-saver", "balanced"]);
        assert!(profiles.available);
    }

    #[test]
    fn lifecycle_actions_require_the_host_control_channel() {
        assert_eq!(
            require_host_role(ClientRole::Public).unwrap_err().code,
            ErrorCode::PermissionDenied
        );
        assert!(require_host_role(ClientRole::PrivilegedHost).is_ok());
    }
}
