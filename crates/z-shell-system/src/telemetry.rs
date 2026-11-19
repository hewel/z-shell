//! CPU, memory, and thermal telemetry from Linux procfs and sysfs.

use crate::Topic;
use rustix::fs::{Mode, OFlags, open};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::task::{self, JoinHandle};
use tokio::time::{self, MissedTickBehavior};
use z_shell_bus::BusHub;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const CPU_LINE_LIMIT: u64 = 4096;
const MEMINFO_LIMIT: u64 = 32 * 1024;
const THERMAL_ATTRIBUTE_LIMIT: u64 = 4096;

/// Measured system resource usage; unavailable measurements are absent.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[non_exhaustive]
pub struct Snapshot {
    /// Aggregate CPU busy time over the last sampling interval, in percent (0–100).
    pub cpu_usage_percent: Option<f64>,
    /// System RAM counters, if both required values were reported by the kernel.
    pub memory: Option<Memory>,
    /// Readable thermal zones, sorted by numeric zone ID.
    pub temperatures: Vec<ThermalZone>,
}

/// System RAM counters derived from `MemTotal` and `MemAvailable`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct Memory {
    /// Total usable RAM in bytes.
    pub total_bytes: u64,
    /// RAM available to start new applications without swapping, in bytes.
    pub available_bytes: u64,
    /// Total less available RAM, in bytes.
    pub used_bytes: u64,
}

/// A Linux thermal-zone reading.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[non_exhaustive]
pub struct ThermalZone {
    /// Numeric suffix of the `thermal_zoneN` sysfs entry.
    pub zone: u32,
    /// Thermal driver type reported in sysfs.
    pub kind: String,
    /// Signed temperature in millidegrees Celsius.
    pub temperature_millicelsius: i64,
}

/// Samples explicit procfs and sysfs roots and retains the previous CPU counters.
#[derive(Debug)]
pub struct Sampler {
    proc_root: PathBuf,
    sys_root: PathBuf,
    previous_cpu: Option<CpuTicks>,
}

impl Sampler {
    /// Uses only the supplied roots; pass `/proc` and `/sys` for live measurements.
    #[must_use]
    pub fn new(proc_root: &Path, sys_root: &Path) -> Self {
        Self {
            proc_root: proc_root.to_owned(),
            sys_root: sys_root.to_owned(),
            previous_cpu: None,
        }
    }

    /// Reads a fresh snapshot, independently omitting missing or malformed measurements.
    /// CPU usage is absent on the first observation or after a reset, gap, or zero-tick interval.
    pub fn sample(&mut self) -> Snapshot {
        let current_cpu = cpu_ticks(&self.proc_root.join("stat"));
        let previous_cpu = std::mem::replace(&mut self.previous_cpu, current_cpu);
        Snapshot {
            cpu_usage_percent: previous_cpu
                .zip(current_cpu)
                .and_then(|(previous, current)| current.usage_since(previous)),
            memory: memory(&self.proc_root.join("meminfo")),
            temperatures: temperatures(&self.sys_root.join("class/thermal")),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct CpuTicks([u64; 8]);

impl CpuTicks {
    fn usage_since(self, previous: Self) -> Option<f64> {
        let mut total = 0_u128;
        let mut idle = 0_u128;
        for (index, (current, previous)) in self.0.into_iter().zip(previous.0).enumerate() {
            let delta = u128::from(current.checked_sub(previous)?);
            total += delta;
            if matches!(index, 3 | 4) {
                idle += delta;
            }
        }
        (total != 0).then(|| (total - idle) as f64 * 100.0 / total as f64)
    }
}

fn cpu_ticks(path: &Path) -> Option<CpuTicks> {
    let mut input = BufReader::new(regular_file(path)?).take(CPU_LINE_LIMIT);
    let mut line = String::new();
    input.read_line(&mut line).ok()?;
    if line.len() as u64 == CPU_LINE_LIMIT && !line.ends_with('\n') {
        return None;
    }
    let mut fields = line.split_ascii_whitespace();
    if fields.next()? != "cpu" {
        return None;
    }
    let mut counters = [0; 8];
    // guest and guest_nice are already accounted for in user and nice.
    for (index, target) in counters.iter_mut().enumerate() {
        match fields.next() {
            Some(value) => *target = value.parse().ok()?,
            None if index >= 4 => break,
            None => return None,
        }
    }
    Some(CpuTicks(counters))
}

fn memory(path: &Path) -> Option<Memory> {
    let text = read_text(path, MEMINFO_LIMIT)?;
    let mut total = None;
    let mut available = None;
    for line in text.lines() {
        let mut fields = line.split_ascii_whitespace();
        let target = match fields.next() {
            Some("MemTotal:") => &mut total,
            Some("MemAvailable:") => &mut available,
            _ => continue,
        };
        let kibibytes: u64 = fields.next()?.parse().ok()?;
        if fields.next()? != "kB" {
            return None;
        }
        *target = Some(kibibytes.checked_mul(1024)?);
        if total.is_some() && available.is_some() {
            break;
        }
    }
    let total_bytes = total?;
    let available_bytes = available?;
    Some(Memory {
        total_bytes,
        available_bytes,
        used_bytes: total_bytes.checked_sub(available_bytes)?,
    })
}

fn temperatures(root: &Path) -> Vec<ThermalZone> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut zones: Vec<_> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let zone = entry
                .file_name()
                .to_str()?
                .strip_prefix("thermal_zone")?
                .parse()
                .ok()?;
            let path = entry.path();
            let kind = read_text(&path.join("type"), THERMAL_ATTRIBUTE_LIMIT)?;
            let kind = kind.trim();
            if kind.is_empty() {
                return None;
            }
            let temperature_millicelsius = read_text(&path.join("temp"), THERMAL_ATTRIBUTE_LIMIT)?
                .trim()
                .parse()
                .ok()?;
            Some(ThermalZone {
                zone,
                kind: kind.to_owned(),
                temperature_millicelsius,
            })
        })
        .collect();
    zones.sort_unstable();
    zones
}

fn regular_file(path: &Path) -> Option<File> {
    let file = File::from(
        open(
            path,
            OFlags::RDONLY | OFlags::NONBLOCK | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .ok()?,
    );
    file.metadata().ok()?.is_file().then_some(file)
}

fn read_text(path: &Path, limit: u64) -> Option<String> {
    let mut text = String::new();
    regular_file(path)?
        .take(limit + 1)
        .read_to_string(&mut text)
        .ok()?;
    (text.len() as u64 <= limit).then_some(text)
}

pub(crate) fn install(hub: &BusHub, proc_root: PathBuf, sys_root: PathBuf) -> JoinHandle<()> {
    let mut topic = Topic::new(hub, "system.telemetry", Snapshot::default());
    let mut sampler = Sampler {
        proc_root,
        sys_root,
        previous_cpu: None,
    };
    tokio::spawn(async move {
        let mut interval = time::interval(POLL_INTERVAL);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let Ok((next_sampler, snapshot)) = task::spawn_blocking(move || {
                let snapshot = sampler.sample();
                (sampler, snapshot)
            })
            .await
            else {
                break;
            };
            sampler = next_sampler;
            let available = sampler.previous_cpu.is_some()
                || snapshot.memory.is_some()
                || !snapshot.temperatures.is_empty();
            topic.update(snapshot, available);
        }
    })
}
