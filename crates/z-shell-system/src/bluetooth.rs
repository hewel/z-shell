//! BlueZ adapters and devices.
//!
//! Commands accept JSON objects. Targets are D-Bus object paths from `system.bluetooth`:
//! - `bluetooth.set-power`: `adapter`, `powered` (boolean)
//! - `bluetooth.set-discovery`: `adapter`, `discovering` (boolean)
//! - `bluetooth.connect`, `bluetooth.disconnect`, `bluetooth.pair`, `bluetooth.remove`: `device`
//! - `bluetooth.trust`: `device`, `trusted` (boolean)

use std::{collections::HashMap, time::Duration};

use serde::{Deserialize, Serialize};
use tokio::{task::JoinHandle, time::MissedTickBehavior};
use z_shell_bus::{BusHub, CommandCall};
use z_shell_protocol::RpcError;
use zbus::{
    Connection,
    fdo::ManagedObjects,
    zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value},
};

use crate::{Commands, SystemBus, Topic, failed, invalid, payload, unavailable};

const BLUEZ: &str = "org.bluez";
const ADAPTER: &str = "org.bluez.Adapter1";
const DEVICE: &str = "org.bluez.Device1";
const BATTERY: &str = "org.bluez.Battery1";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const OBJECT_MANAGER: &str = "org.freedesktop.DBus.ObjectManager";
const SNAPSHOT_INTERVAL: Duration = Duration::from_secs(2);

type Properties = HashMap<String, OwnedValue>;

#[derive(Default, PartialEq, Serialize)]
struct State {
    available: bool,
    adapters: Vec<Adapter>,
    devices: Vec<Device>,
}

#[derive(PartialEq, Serialize)]
struct Adapter {
    path: String,
    powered: bool,
    discovering: bool,
}

#[derive(PartialEq, Serialize)]
struct Device {
    path: String,
    adapter: String,
    address: String,
    name: String,
    icon: Option<String>,
    paired: bool,
    trusted: bool,
    connected: bool,
    battery: Option<u8>,
}

impl State {
    fn from_objects(objects: &ManagedObjects) -> Self {
        let mut state = Self {
            available: true,
            ..Self::default()
        };
        for (path, interfaces) in objects {
            if let Some(props) = interfaces.get(ADAPTER) {
                state.adapters.push(Adapter {
                    path: path.to_string(),
                    powered: flag(props, "Powered"),
                    discovering: flag(props, "Discovering"),
                });
            }
            if let Some(props) = interfaces.get(DEVICE) {
                // Adapter and Address are mandatory Device1 properties.
                let Some(adapter) = props
                    .get("Adapter")
                    .and_then(|v| <&ObjectPath>::try_from(v).ok())
                else {
                    continue;
                };
                let Some(address) = text(props, "Address") else {
                    continue;
                };
                let battery = interfaces
                    .get(BATTERY)
                    .and_then(|props| props.get("Percentage"))
                    .and_then(|v| u8::try_from(v).ok());
                state.devices.push(Device {
                    path: path.to_string(),
                    adapter: adapter.to_string(),
                    address: address.to_owned(),
                    name: device_display_name(props, address).to_owned(),
                    icon: text(props, "Icon").map(str::to_owned),
                    paired: flag(props, "Paired"),
                    trusted: flag(props, "Trusted"),
                    connected: flag(props, "Connected"),
                    battery,
                });
            }
        }
        state.adapters.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        state.devices.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        state
    }
}

fn device_display_name<'props>(props: &'props Properties, address: &'props str) -> &'props str {
    let default_alias = address.replace(':', "-");
    if let Some(alias) = text(props, "Alias")
        .filter(|alias| !alias.is_empty() && !alias.eq_ignore_ascii_case(&default_alias))
    {
        return alias;
    }
    if let Some(name) = text(props, "Name").filter(|name| !name.is_empty()) {
        return name;
    }
    address
}

fn flag(props: &Properties, name: &str) -> bool {
    props
        .get(name)
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or_default()
}

fn text<'props>(props: &'props Properties, name: &str) -> Option<&'props str> {
    props.get(name).and_then(|v| <&str>::try_from(v).ok())
}

#[derive(Clone, Copy)]
enum Action {
    SetPower,
    SetDiscovery,
    DeviceMethod(&'static str),
    Trust,
    Remove,
}

#[derive(Deserialize)]
struct AdapterPower {
    adapter: OwnedObjectPath,
    powered: bool,
}

#[derive(Deserialize)]
struct AdapterDiscovery {
    adapter: OwnedObjectPath,
    discovering: bool,
}

#[derive(Deserialize)]
struct DeviceTarget {
    device: OwnedObjectPath,
}

#[derive(Deserialize)]
struct DeviceTrust {
    device: OwnedObjectPath,
    trusted: bool,
}

enum Operation {
    SetBool {
        interface: &'static str,
        property: &'static str,
        value: bool,
    },
    Call {
        interface: &'static str,
        method: &'static str,
    },
    Remove,
}

impl Action {
    fn parse(self, call: &CommandCall) -> Result<(OwnedObjectPath, Operation), RpcError> {
        let (path, operation) = match self {
            Self::SetPower => {
                let AdapterPower { adapter, powered } = payload(call)?;
                (
                    adapter,
                    Operation::SetBool {
                        interface: ADAPTER,
                        property: "Powered",
                        value: powered,
                    },
                )
            }
            Self::SetDiscovery => {
                let AdapterDiscovery {
                    adapter,
                    discovering,
                } = payload(call)?;
                (
                    adapter,
                    Operation::Call {
                        interface: ADAPTER,
                        method: if discovering {
                            "StartDiscovery"
                        } else {
                            "StopDiscovery"
                        },
                    },
                )
            }
            Self::Trust => {
                let DeviceTrust { device, trusted } = payload(call)?;
                (
                    device,
                    Operation::SetBool {
                        interface: DEVICE,
                        property: "Trusted",
                        value: trusted,
                    },
                )
            }
            Self::DeviceMethod(method) => {
                let DeviceTarget { device } = payload(call)?;
                (
                    device,
                    Operation::Call {
                        interface: DEVICE,
                        method,
                    },
                )
            }
            Self::Remove => {
                let DeviceTarget { device } = payload(call)?;
                (device, Operation::Remove)
            }
        };
        if !path.as_str().starts_with("/org/bluez/") {
            return Err(invalid("invalid Bluetooth object path"));
        }
        Ok((path, operation))
    }
}

impl Operation {
    async fn run(self, conn: &Connection, path: &OwnedObjectPath) -> zbus::Result<()> {
        match self {
            Self::SetBool {
                interface,
                property,
                value,
            } => {
                conn.call_method(
                    Some(BLUEZ),
                    path,
                    Some(PROPERTIES),
                    "Set",
                    &(interface, property, Value::from(value)),
                )
                .await?;
            }
            Self::Call { interface, method } => {
                conn.call_method(Some(BLUEZ), path, Some(interface), method, &())
                    .await?;
            }
            Self::Remove => {
                // RemoveDevice belongs to the adapter, not the device. Resolve the
                // relationship from BlueZ rather than guessing from the path.
                let reply = conn
                    .call_method(
                        Some(BLUEZ),
                        path,
                        Some(PROPERTIES),
                        "Get",
                        &(DEVICE, "Adapter"),
                    )
                    .await?;
                let adapter = OwnedObjectPath::try_from(reply.body().deserialize::<OwnedValue>()?)?;
                conn.call_method(
                    Some(BLUEZ),
                    &adapter,
                    Some(ADAPTER),
                    "RemoveDevice",
                    &(path,),
                )
                .await?;
            }
        }
        Ok(())
    }
}

fn command_error(error: zbus::Error) -> RpcError {
    match error {
        zbus::Error::MethodError(name, _, _)
            if matches!(
                name.as_str(),
                "org.freedesktop.DBus.Error.ServiceUnknown"
                    | "org.freedesktop.DBus.Error.NameHasNoOwner"
            ) =>
        {
            unavailable("BlueZ is unavailable")
        }
        _ => failed("Bluetooth operation failed"),
    }
}

async fn snapshot(conn: &Connection) -> zbus::Result<(String, State)> {
    // Reading the topic should not activate a daemon that is stopped.
    let owner = conn
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "GetNameOwner",
            &(BLUEZ,),
        )
        .await?;
    let owner: String = owner.body().deserialize()?;
    let reply = conn
        .call_method(
            Some(owner.as_str()),
            "/",
            Some(OBJECT_MANAGER),
            "GetManagedObjects",
            &(),
        )
        .await?;
    let objects: ManagedObjects = reply.body().deserialize()?;
    Ok((owner, State::from_objects(&objects)))
}

pub(crate) fn install(hub: &BusHub, commands: &Commands, bus: SystemBus) -> JoinHandle<()> {
    let mut topic = Topic::new(hub, "system.bluetooth", State::default());
    for (name, description, action) in [
        (
            "bluetooth.set-power",
            "Set Bluetooth adapter power",
            Action::SetPower,
        ),
        (
            "bluetooth.set-discovery",
            "Set Bluetooth discovery",
            Action::SetDiscovery,
        ),
        (
            "bluetooth.connect",
            "Connect to a Bluetooth device",
            Action::DeviceMethod("Connect"),
        ),
        (
            "bluetooth.disconnect",
            "Disconnect a Bluetooth device",
            Action::DeviceMethod("Disconnect"),
        ),
        (
            "bluetooth.pair",
            "Pair a Bluetooth device",
            Action::DeviceMethod("Pair"),
        ),
        (
            "bluetooth.trust",
            "Set Bluetooth device trust",
            Action::Trust,
        ),
        (
            "bluetooth.remove",
            "Remove a Bluetooth device",
            Action::Remove,
        ),
    ] {
        let bus = bus.clone();
        commands.register(name, description, move |call| {
            let bus = bus.clone();
            async move {
                let (path, operation) = action.parse(&call)?;
                // BlueZ scopes discovery to its caller's D-Bus connection.
                let conn = bus
                    .connection()
                    .await
                    .ok_or_else(|| unavailable("system D-Bus is unavailable"))?;
                operation.run(&conn, &path).await.map_err(command_error)
            }
        });
    }

    tokio::spawn(async move {
        let mut ticks = tokio::time::interval(SNAPSHOT_INTERVAL);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut owner = None;
        loop {
            ticks.tick().await;
            let snapshot = match bus.connection().await {
                Some(conn) => snapshot(&conn).await.ok(),
                None => None,
            };
            let state = if let Some((new_owner, state)) = snapshot {
                if owner.as_ref() != Some(&new_owner) {
                    topic.resync();
                    owner = Some(new_owner);
                }
                state
            } else {
                owner = None;
                State::default()
            };
            let available = state.available;
            topic.update(state, available);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use zbus::zvariant::Str;

    #[test]
    fn projects_adapters_devices_and_optional_batteries_in_path_order() {
        let objects = ManagedObjects::from([
            (
                "/org/bluez/hci1".try_into().unwrap(),
                [(
                    ADAPTER.try_into().unwrap(),
                    [("Powered".into(), true.into())].into(),
                )]
                .into(),
            ),
            (
                "/org/bluez/hci0".try_into().unwrap(),
                [(
                    ADAPTER.try_into().unwrap(),
                    [
                        ("Powered".into(), true.into()),
                        ("Discovering".into(), true.into()),
                    ]
                    .into(),
                )]
                .into(),
            ),
            (
                "/org/bluez/hci1/dev_BB".try_into().unwrap(),
                [(
                    DEVICE.try_into().unwrap(),
                    [
                        (
                            "Adapter".into(),
                            ObjectPath::try_from("/org/bluez/hci1").unwrap().into(),
                        ),
                        ("Address".into(), Str::from("BB:00:00:00:00:00").into()),
                    ]
                    .into(),
                )]
                .into(),
            ),
            (
                "/org/bluez/hci0/dev_AA".try_into().unwrap(),
                [
                    (
                        DEVICE.try_into().unwrap(),
                        [
                            (
                                "Adapter".into(),
                                ObjectPath::try_from("/org/bluez/hci0").unwrap().into(),
                            ),
                            ("Address".into(), Str::from("AA:00:00:00:00:00").into()),
                            ("Name".into(), Str::from("Test headphones").into()),
                            ("Icon".into(), Str::from("audio-headphones").into()),
                            ("Paired".into(), true.into()),
                            ("Trusted".into(), true.into()),
                            ("Connected".into(), true.into()),
                        ]
                        .into(),
                    ),
                    (
                        BATTERY.try_into().unwrap(),
                        [("Percentage".into(), 84_u8.into())].into(),
                    ),
                ]
                .into(),
            ),
        ]);

        assert_eq!(
            serde_json::to_value(State::from_objects(&objects)).unwrap(),
            json!({
                "available": true,
                "adapters": [
                    {"path": "/org/bluez/hci0", "powered": true, "discovering": true},
                    {"path": "/org/bluez/hci1", "powered": true, "discovering": false}
                ],
                "devices": [
                    {
                        "path": "/org/bluez/hci0/dev_AA", "adapter": "/org/bluez/hci0",
                        "address": "AA:00:00:00:00:00", "name": "Test headphones",
                        "icon": "audio-headphones", "paired": true, "trusted": true,
                        "connected": true, "battery": 84
                    },
                    {
                        "path": "/org/bluez/hci1/dev_BB", "adapter": "/org/bluez/hci1",
                        "address": "BB:00:00:00:00:00", "name": "BB:00:00:00:00:00", "icon": null,
                        "paired": false, "trusted": false, "connected": false, "battery": null
                    }
                ]
            })
        );
    }

    #[test]
    fn prefers_non_default_alias_over_name_and_falls_back_to_address() {
        let adapter_path = || ObjectPath::try_from("/org/bluez/hci0").unwrap();
        let objects = ManagedObjects::from([
            (
                "/org/bluez/hci0/dev_1_custom_alias".try_into().unwrap(),
                [(
                    DEVICE.try_into().unwrap(),
                    [
                        ("Adapter".into(), adapter_path().into()),
                        ("Address".into(), Str::from("11:22:33:44:55:01").into()),
                        ("Name".into(), Str::from("WH-1000XM5").into()),
                        ("Alias".into(), Str::from("Studio Headphones").into()),
                    ]
                    .into(),
                )]
                .into(),
            ),
            (
                "/org/bluez/hci0/dev_2_default_mac_alias"
                    .try_into()
                    .unwrap(),
                [(
                    DEVICE.try_into().unwrap(),
                    [
                        ("Adapter".into(), adapter_path().into()),
                        ("Address".into(), Str::from("AA:BB:CC:DD:EE:02").into()),
                        ("Name".into(), Str::from("Keychron K2").into()),
                        ("Alias".into(), Str::from("AA-BB-CC-DD-EE-02").into()),
                    ]
                    .into(),
                )]
                .into(),
            ),
            (
                "/org/bluez/hci0/dev_3_empty_alias_has_name"
                    .try_into()
                    .unwrap(),
                [(
                    DEVICE.try_into().unwrap(),
                    [
                        ("Adapter".into(), adapter_path().into()),
                        ("Address".into(), Str::from("11:22:33:44:55:03").into()),
                        ("Name".into(), Str::from("MX Master 3S").into()),
                        ("Alias".into(), Str::from("").into()),
                    ]
                    .into(),
                )]
                .into(),
            ),
            (
                "/org/bluez/hci0/dev_4_default_alias_no_name"
                    .try_into()
                    .unwrap(),
                [(
                    DEVICE.try_into().unwrap(),
                    [
                        ("Adapter".into(), adapter_path().into()),
                        ("Address".into(), Str::from("11:22:33:44:55:04").into()),
                        ("Name".into(), Str::from("").into()),
                        ("Alias".into(), Str::from("11-22-33-44-55-04").into()),
                    ]
                    .into(),
                )]
                .into(),
            ),
        ]);

        let snapshot = serde_json::to_value(State::from_objects(&objects)).unwrap();
        let names: Vec<(&str, Option<&str>)> = snapshot["devices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|dev| (dev["path"].as_str().unwrap(), dev["name"].as_str()))
            .collect();
        assert_eq!(
            names,
            vec![
                (
                    "/org/bluez/hci0/dev_1_custom_alias",
                    Some("Studio Headphones")
                ),
                (
                    "/org/bluez/hci0/dev_2_default_mac_alias",
                    Some("Keychron K2")
                ),
                (
                    "/org/bluez/hci0/dev_3_empty_alias_has_name",
                    Some("MX Master 3S")
                ),
                (
                    "/org/bluez/hci0/dev_4_default_alias_no_name",
                    Some("11:22:33:44:55:04")
                ),
            ]
        );
    }

    #[test]
    fn distinguishes_a_daemon_without_hardware_from_no_daemon() {
        assert_eq!(
            serde_json::to_value(State::from_objects(&ManagedObjects::new())).unwrap(),
            json!({"available": true, "adapters": [], "devices": []})
        );
        assert_eq!(
            serde_json::to_value(State::default()).unwrap(),
            json!({"available": false, "adapters": [], "devices": []})
        );
    }
}
