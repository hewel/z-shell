//! Reads requested backlight values and controls panel brightness through sysfs or logind.

use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;
use tokio::time::{self, MissedTickBehavior};
use z_shell_bus::BusHub;
use z_shell_protocol::RpcError;
use zbus::Proxy;
use zbus::zvariant::OwnedObjectPath;

use crate::{Commands, SystemBus, Topic, failed, invalid, payload, unavailable};

const SYSFS_ROOT: &str = "/sys/class/backlight";
const BRIGHTNESS_IO_TIMEOUT: Duration = Duration::from_secs(2);

/// Filesystem access to the Linux backlight class under an injectable root directory.
#[derive(Debug, Clone)]
pub struct Backlights {
    root: PathBuf,
}

/// The requested brightness and direct write capability of one backlight device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Backlight {
    device: String,
    brightness: u32,
    max_brightness: u32,
    controllable: bool,
}

impl Backlight {
    /// Returns the sysfs device name accepted by [`Backlights::set`].
    #[must_use]
    pub fn device(&self) -> &str {
        &self.device
    }

    /// Returns the requested setting in raw driver units, not `actual_brightness`.
    #[must_use]
    pub fn brightness(&self) -> u32 {
        self.brightness
    }

    /// Returns the maximum setting in raw driver units.
    #[must_use]
    pub fn max_brightness(&self) -> u32 {
        self.max_brightness
    }

    /// Reports whether the brightness attribute could be opened for direct writing.
    #[must_use]
    pub fn controllable(&self) -> bool {
        self.controllable
    }
}

impl Backlights {
    /// Creates a filesystem reader/writer rooted at the supplied backlight class directory.
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Reads readable backlights with a nonzero maximum, ordered by device name.
    ///
    /// A missing class is reported as an empty list. Entries that disappear or whose
    /// attributes cannot be read during enumeration are omitted.
    ///
    /// # Errors
    ///
    /// Returns an I/O error if the class directory cannot otherwise be opened or listed.
    pub fn devices(&self) -> io::Result<Vec<Backlight>> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(err),
        };
        let mut devices = Vec::new();
        for entry in entries {
            let entry = entry?;
            let Ok(device) = entry.file_name().into_string() else {
                continue;
            };
            let path = entry.path();
            let attribute = path.join("brightness");
            let (Ok(brightness), Ok(max_brightness)) =
                (read_value(&attribute), max_brightness(&path))
            else {
                continue;
            };
            devices.push(Backlight {
                device,
                brightness,
                max_brightness,
                // Opening without truncating or writing tests effective access without
                // changing the attribute, unlike a write of the current setting.
                controllable: OpenOptions::new().write(true).open(attribute).is_ok(),
            });
        }
        devices.sort_unstable_by(|left, right| left.device.cmp(&right.device));
        Ok(devices)
    }

    /// Writes the requested setting after clamping it to `0..=max_brightness`.
    ///
    /// # Errors
    ///
    /// Returns an I/O error for invalid names, unknown devices, malformed attributes,
    /// or a rejected write. Only the direct filesystem route is used.
    pub fn set(&self, device: &str, value: i64) -> io::Result<()> {
        let (path, value) = self.setting(device, value)?;
        write_setting(&path, value)
    }

    fn setting(&self, device: &str, value: i64) -> io::Result<(PathBuf, u32)> {
        if Path::new(device).file_name() != Some(OsStr::new(device)) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid backlight device name",
            ));
        }
        let path = self.root.join(device);
        let max = max_brightness(&path)?;
        let value = u32::try_from(value.max(0)).unwrap_or(u32::MAX).min(max);
        Ok((path.join("brightness"), value))
    }
}

fn read_value(attribute: &Path) -> io::Result<u32> {
    fs::read_to_string(attribute)?
        .trim()
        .parse()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid backlight attribute"))
}

fn max_brightness(path: &Path) -> io::Result<u32> {
    let max = read_value(&path.join("max_brightness"))?;
    if max == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "zero backlight maximum",
        ));
    }
    Ok(max)
}

fn write_setting(path: &Path, value: u32) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).truncate(true).open(path)?;
    // sysfs expects a complete value in one write, not the fragments from write_fmt.
    file.write_all(value.to_string().as_bytes())
}

#[derive(Default, PartialEq, Serialize)]
struct Brightness {
    available: bool,
    devices: Vec<Backlight>,
}

#[derive(Deserialize)]
struct SetBrightness {
    device: String,
    value: i64,
}

pub(crate) fn install(
    hub: &BusHub,
    commands: &Commands,
    bus: SystemBus,
    root: PathBuf,
) -> JoinHandle<()> {
    let use_logind = root == Path::new(SYSFS_ROOT);
    let backlights = Arc::new(Backlights::new(root));
    let command_bus = bus.clone();
    let command_backlights = Arc::clone(&backlights);
    commands.register(
        "brightness.set",
        "Set a backlight: payload {device: string, value: integer} in raw brightness units (clamped)",
        move |call| {
            let bus = command_bus.clone();
            let backlights = Arc::clone(&command_backlights);
            async move { set_brightness(backlights, &bus, use_logind, payload(&call)?).await }
        },
    );

    let mut topic = Topic::new(hub, "system.brightness", Brightness::default());
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let reader = Arc::clone(&backlights);
            let mut devices = tokio::task::spawn_blocking(move || reader.devices())
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
            if use_logind
                && devices.iter().any(|device| !device.controllable)
                && let Ok(Some((_, seat))) =
                    time::timeout(BRIGHTNESS_IO_TIMEOUT, logind_backlight(&bus)).await
            {
                devices = tokio::task::spawn_blocking(move || {
                    for device in &mut devices {
                        device.controllable |= device_on_seat(&device.device, &seat);
                    }
                    devices
                })
                .await
                .unwrap_or_default();
            }
            let available = !devices.is_empty();
            topic.update(Brightness { available, devices }, available);
        }
    })
}

async fn set_brightness(
    backlights: Arc<Backlights>,
    bus: &SystemBus,
    use_logind: bool,
    request: SetBrightness,
) -> Result<(), RpcError> {
    let (device, value, result) = tokio::task::spawn_blocking(move || {
        let (path, value) = backlights.setting(&request.device, request.value)?;
        Ok::<_, io::Error>((request.device, value, write_setting(&path, value)))
    })
    .await
    .map_err(|_| failed("backlight write did not complete"))?
    .map_err(backlight_error)?;
    match result {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem
            ) && use_logind =>
        {
            time::timeout(BRIGHTNESS_IO_TIMEOUT, async {
                let (session, seat) = logind_backlight(bus)
                    .await
                    .ok_or_else(|| unavailable("backlight is not controllable"))?;
                let device = tokio::task::spawn_blocking(move || {
                    device_on_seat(&device, &seat).then_some(device)
                })
                .await
                .ok()
                .flatten()
                .ok_or_else(|| unavailable("backlight is not controllable"))?;
                session
                    .call::<_, _, ()>("SetBrightness", &("backlight", device, value))
                    .await
                    .map_err(|_| failed("logind rejected the backlight setting"))
            })
            .await
            .map_err(|_| unavailable("logind brightness request timed out"))?
        }
        Err(error) => Err(backlight_error(error)),
    }
}

fn backlight_error(error: io::Error) -> RpcError {
    match error.kind() {
        io::ErrorKind::InvalidInput => invalid("invalid backlight device name"),
        io::ErrorKind::NotFound => unavailable("backlight device is unavailable"),
        io::ErrorKind::PermissionDenied | io::ErrorKind::ReadOnlyFilesystem => {
            unavailable("backlight is not controllable")
        }
        _ => failed("could not access the backlight setting"),
    }
}

async fn logind_backlight(bus: &SystemBus) -> Option<(Proxy<'static>, String)> {
    let connection = bus.connection().await?;
    let session = crate::power::logind_session(&connection).await?;
    let (active, seat, introspection) = tokio::join!(
        session.get_property::<bool>("Active"),
        session.get_property::<(String, OwnedObjectPath)>("Seat"),
        session.introspect(),
    );
    let (seat, _) = seat.ok()?;
    if !active.ok()? || seat.is_empty() || !has_set_brightness(&introspection.ok()?) {
        return None;
    }
    Some((session, seat))
}

fn has_set_brightness(xml: &str) -> bool {
    // Only inspect this named logind interface; another interface exposing a method
    // with the same name would not make the session's SetBrightness callable.
    let mut in_session_interface = false;
    for tag in xml.split('<') {
        if tag.starts_with("interface ") {
            in_session_interface =
                tag.split(['\'', '"']).nth(1) == Some("org.freedesktop.login1.Session");
        } else if tag.starts_with("/interface") {
            in_session_interface = false;
        } else if in_session_interface
            && tag.starts_with("method ")
            && tag.split(['\'', '"']).nth(1) == Some("SetBrightness")
        {
            return true;
        }
    }
    false
}

fn device_on_seat(device: &str, seat: &str) -> bool {
    // Match logind's udev ID_SEAT lookup. Unassigned devices belong to seat0.
    match fs::read_to_string(format!("/run/udev/data/+backlight:{device}")) {
        Ok(properties) => {
            properties
                .lines()
                .find_map(|line| line.strip_prefix("E:ID_SEAT="))
                .unwrap_or("seat0")
                == seat
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => seat == "seat0",
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::has_set_brightness;

    #[test]
    fn only_logind_session_interface_establishes_brightness_capability() {
        let unsupported = r#"<node>
            <interface name="org.freedesktop.login1.Session">
                <property name="Active" type="b" access="read"/>
            </interface>
            <interface name="org.example.Unrelated">
                <method name="SetBrightness"/>
            </interface>
        </node>"#;
        assert!(!has_set_brightness(unsupported));

        let supported = r#"<node>
            <interface name="org.freedesktop.login1.Session">
                <method name="SetBrightness">
                    <arg type="s" direction="in"/>
                    <arg type="s" direction="in"/>
                    <arg type="u" direction="in"/>
                </method>
            </interface>
        </node>"#;
        assert!(has_set_brightness(supported));
    }
}
