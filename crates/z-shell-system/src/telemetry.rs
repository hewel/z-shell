//! System hardware telemetry from Linux procfs and sysfs.

use crate::Topic;
use rustix::fs::{Mode, OFlags, open};
use rustix::time::{ClockId, clock_gettime};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::task::{self, JoinHandle};
use tokio::time::{self, MissedTickBehavior};
use z_shell_bus::BusHub;

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const CPU_LINE_LIMIT: u64 = 4096;
const STAT_MAX_LINES: usize = 512;
const CPUINFO_LIMIT: u64 = 512 * 1024;
const MEMINFO_LIMIT: u64 = 64 * 1024;
const NET_DEV_LIMIT: u64 = 64 * 1024;
const DISKSTATS_LIMIT: u64 = 256 * 1024;
const MOUNTS_LIMIT: u64 = 128 * 1024;
const SMALL_ATTR_LIMIT: u64 = 4096;
const SECTOR_BYTES: u64 = 512;
const HISTORY_BUCKETS: usize = 60;
const MAX_SENSORS: usize = 12;
const MAX_MOUNTS: usize = 8;

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
    /// Configured sampling interval in milliseconds when any telemetry source is active.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poll_interval_ms: Option<u64>,
    /// Extended CPU telemetry (per-core usage, clock frequency, model, load, uptime).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu: Option<CpuInfo>,
    /// Swap counters derived from `SwapTotal` and `SwapFree`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap: Option<Swap>,
    /// Readable GPU devices ordered stably by DRM card index.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub gpus: Vec<GpuInfo>,
    /// Non-loopback network throughput and per-interface session totals.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<NetworkTelemetry>,
    /// Single-layer block device I/O throughput and local mount usage summaries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage: Option<StorageTelemetry>,
    /// Friendly-labeled thermal sensors merged from `hwmon` and `thermal_zone`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sensors: Vec<ThermalSensor>,
    /// Bounded timestamp-bucketed rolling history for 60s, 5m, and 15m chart windows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<TelemetryHistory>,
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
    /// Kernel page cache (`Cached`) in bytes, when present and valid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_bytes: Option<u64>,
    /// Kernel block buffers (`Buffers`) in bytes, when present and valid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub buffers_bytes: Option<u64>,
    /// Reclaimable slab (`SReclaimable`) in bytes, when present and valid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reclaimable_bytes: Option<u64>,
}

/// Swap counters derived from `SwapTotal` and `SwapFree`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct Swap {
    /// Total configured swap space in bytes.
    pub total_bytes: u64,
    /// Free swap space in bytes.
    pub free_bytes: u64,
    /// Used swap space (`total_bytes - free_bytes`) in bytes.
    pub used_bytes: u64,
}

/// Extended CPU details and per-core utilization.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct CpuInfo {
    /// Observed logical CPU core count.
    pub core_count: u32,
    /// Per-core busy utilization percentages (0–100), or `None` when a core has no valid interval.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub per_core_usage_percent: Vec<Option<f64>>,
    /// Observed average CPU clock frequency in MHz (`cpufreq` preferred, fallback `/proc/cpuinfo`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_mhz: Option<u64>,
    /// CPU marketing model name, cached from `/proc/cpuinfo`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_name: Option<String>,
    /// 1-, 5-, and 15-minute load averages from `/proc/loadavg`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_average: Option<[f64; 3]>,
    /// System uptime in whole seconds from `/proc/uptime`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_seconds: Option<u64>,
}

/// DRM/hwmon telemetry for a single GPU device.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct GpuInfo {
    /// Stable DRM card identifier (for example, `card0`).
    pub id: String,
    /// Human-readable product or device name, if reported by sysfs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Kernel DRM driver name (for example, `amdgpu`, `i915`, `xe`, `nouveau`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driver: Option<String>,
    /// PCI bus slot name (for example, `0000:c1:00.0`), if available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pci_slot: Option<String>,
    /// GPU busy utilization percentage (0–100), if readable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub utilization_percent: Option<f64>,
    /// Used VRAM in bytes, if readable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vram_used_bytes: Option<u64>,
    /// Total VRAM in bytes, if readable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vram_total_bytes: Option<u64>,
    /// GPU temperature in millidegrees Celsius, if readable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature_millicelsius: Option<i64>,
    /// GPU power draw in milliwatts, if readable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub power_milliwatts: Option<u64>,
    /// Current GPU graphics/shader clock in MHz, if readable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clock_mhz: Option<u64>,
}

/// Network throughput and per-interface session totals for non-loopback interfaces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct NetworkTelemetry {
    /// Selected active non-loopback interface name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_interface: Option<String>,
    /// Receive throughput in bytes/sec for the active interface.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rx_bytes_per_sec: Option<u64>,
    /// Transmit throughput in bytes/sec for the active interface.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_bytes_per_sec: Option<u64>,
    /// Session-accumulated received bytes on the active interface since sampler start.
    pub session_rx_bytes: u64,
    /// Session-accumulated transmitted bytes on the active interface since sampler start.
    pub session_tx_bytes: u64,
    /// Aggregated throughput and session totals across all active-eligible non-loopback interfaces.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aggregate: Option<NetworkAggregateTelemetry>,
    /// All observed non-loopback interfaces sorted by name.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub interfaces: Vec<NetworkInterfaceTelemetry>,
}

/// Aggregated raw non-loopback network throughput and session totals across active-eligible
/// interfaces (`up != Some(false)`).
///
/// Reports raw per-interface traffic summed across all active-eligible non-loopback links
/// (not deduplicated internet traffic: e.g., a VPN tunnel interface and its underlying physical
/// NIC are both summed).
///
/// Deliberate divergences from GNOME System Monitor's `load-graph.cpp`:
/// - Per-interface baselines in `Sampler::net_state` prevent hotplug spikes and interface-switch
///   gaps without discarding the aggregate when another link appears or disappears.
/// - Links explicitly reported down (`up == Some(false)`) are excluded from active aggregation.
/// - Initial samples, suspend/resume gaps, unreadable `/proc/net/dev`, empty interface sets, and
///   all-active counter resets emit `None` (`null`) truthfully rather than fabricating `0`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct NetworkAggregateTelemetry {
    /// Number of observed active-eligible (`up != Some(false)`) non-loopback interfaces.
    pub active_interface_count: u32,
    /// Sorted names of active-eligible non-loopback interfaces included in the aggregate.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub active_interfaces: Vec<String>,
    /// Summed receive throughput in bytes/sec across active-eligible interfaces with valid RX deltas.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rx_bytes_per_sec: Option<u64>,
    /// Summed transmit throughput in bytes/sec across active-eligible interfaces with valid TX deltas.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_bytes_per_sec: Option<u64>,
    /// Monotonic session-accumulated received bytes summed across all valid active-eligible deltas.
    pub session_rx_bytes: u64,
    /// Monotonic session-accumulated transmitted bytes summed across all valid active-eligible deltas.
    pub session_tx_bytes: u64,
}

/// Telemetry for one non-loopback network interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct NetworkInterfaceTelemetry {
    /// Kernel interface name (for example, `enp4s0`, `wlan0`).
    pub name: String,
    /// Operational link state from sysfs (`operstate`/`carrier`), when readable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub up: Option<bool>,
    /// Receive throughput in bytes/sec over the last valid interval.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rx_bytes_per_sec: Option<u64>,
    /// Transmit throughput in bytes/sec over the last valid interval.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_bytes_per_sec: Option<u64>,
    /// Session-accumulated received bytes on this interface since sampler start.
    pub session_rx_bytes: u64,
    /// Session-accumulated transmitted bytes on this interface since sampler start.
    pub session_tx_bytes: u64,
}

/// Single-layer block device I/O throughput and deduplicated local mount summaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct StorageTelemetry {
    /// Aggregate single-layer block read throughput in bytes/sec.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_bytes_per_sec: Option<u64>,
    /// Aggregate single-layer block write throughput in bytes/sec.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_bytes_per_sec: Option<u64>,
    /// Local filesystem mount capacity summaries.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub mounts: Vec<MountInfo>,
}

/// Capacity summary for one local filesystem mount.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct MountInfo {
    /// Mount point path (for example, `/`, `/home`).
    pub mount_point: String,
    /// Short block device identifier (for example, `nvme0n1p2`).
    pub device: String,
    /// Filesystem type (for example, `ext4`, `btrfs`).
    pub fs_type: String,
    /// Total filesystem capacity in bytes.
    pub total_bytes: u64,
    /// Available space for unprivileged users in bytes.
    pub available_bytes: u64,
    /// Used space (`total_bytes - available_bytes`) in bytes.
    pub used_bytes: u64,
}

/// Filesystem capacity reading returned by an injectable mount stat provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MountStat {
    /// Total filesystem capacity in bytes.
    pub total_bytes: u64,
    /// Available space for unprivileged users in bytes.
    pub available_bytes: u64,
    /// Optional underlying filesystem identifier used to deduplicate shared mounts.
    pub filesystem_id: Option<u64>,
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

/// Broad hardware category for a friendly thermal sensor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ThermalCategory {
    /// Processor package or core die sensor.
    Cpu,
    /// Graphics processor edge or junction sensor.
    Gpu,
    /// NVMe or storage drive sensor.
    Nvme,
    /// Battery pack sensor.
    Battery,
    /// Other platform thermal sensor.
    Other,
}

/// Friendly-labeled thermal sensor merged from `hwmon` and `thermal_zone`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct ThermalSensor {
    /// Human-readable label (for example, `CPU`, `GPU`, `NVMe`, `Battery`).
    pub label: String,
    /// Hardware category.
    pub category: ThermalCategory,
    /// Underlying sysfs driver or thermal zone name.
    pub source: String,
    /// Signed temperature in millidegrees Celsius.
    pub temperature_millicelsius: i64,
}

/// Rolling scalar histories for the 60s, 5m, and 15m chart time ranges.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct TelemetryHistory {
    /// 60-second window (1-second buckets, up to 60 points).
    pub window_60s: HistoryWindow,
    /// 5-minute window (5-second buckets, up to 60 points).
    pub window_5m: HistoryWindow,
    /// 15-minute window (15-second buckets, up to 60 points).
    pub window_15m: HistoryWindow,
}

/// Timestamp-bucketed scalar series for one chart time window.
///
/// Missing intervals, counter resets, device switches, and suspend/resume gaps
/// are explicitly represented as `None` (`null` in JSON) rather than zero.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct HistoryWindow {
    /// Duration of each bucket in seconds (`1`, `5`, or `15`).
    pub bucket_seconds: u32,
    /// Monotonic bucket index of the rightmost slot in this window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_bucket_id: Option<u64>,
    /// Aggregate CPU busy utilization (%) series.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub cpu_percent: Vec<Option<f64>>,
    /// Memory utilization (`used / total * 100`) series.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub memory_percent: Vec<Option<f64>>,
    /// Primary GPU utilization (%) series.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub gpu_percent: Vec<Option<f64>>,
    /// Active network interface RX throughput (bytes/sec) series.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub net_rx_bytes_per_sec: Vec<Option<u64>>,
    /// Active network interface TX throughput (bytes/sec) series.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub net_tx_bytes_per_sec: Vec<Option<u64>>,
    /// Aggregated non-loopback RX throughput (bytes/sec) series across active-eligible interfaces.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aggregate_net_rx_bytes_per_sec: Vec<Option<u64>>,
    /// Aggregated non-loopback TX throughput (bytes/sec) series across active-eligible interfaces.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub aggregate_net_tx_bytes_per_sec: Vec<Option<u64>>,
    /// Aggregate block device read throughput (bytes/sec) series.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub disk_read_bytes_per_sec: Vec<Option<u64>>,
    /// Aggregate block device write throughput (bytes/sec) series.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub disk_write_bytes_per_sec: Vec<Option<u64>>,
}

/// Reads the suspend-aware Linux `CLOCK_BOOTTIME` monotonic clock as a `Duration`.
#[must_use]
pub fn boottime_now() -> Duration {
    let ts = clock_gettime(ClockId::Boottime);
    let secs = u64::try_from(ts.tv_sec).unwrap_or(0);
    let nanos = u32::try_from(ts.tv_nsec).unwrap_or(0);
    Duration::new(secs, nanos)
}

type MountStatProvider = Box<dyn Fn(&Path) -> Option<MountStat> + Send>;

/// Samples explicit procfs and sysfs roots and retains delta counters and rolling history.
pub struct Sampler {
    proc_root: PathBuf,
    sys_root: PathBuf,
    poll_interval: Duration,
    max_sample_gap: Duration,
    mount_stat_provider: MountStatProvider,
    boottime_epoch: Option<Duration>,
    instant_epoch: Option<Instant>,
    last_sample_elapsed: Option<Duration>,
    previous_cpu: Option<CpuTicks>,
    previous_cores: BTreeMap<u32, CpuTicks>,
    cached_cpu_model: Option<String>,
    previous_primary_gpu_id: Option<String>,
    previous_active_net_iface: Option<String>,
    last_net_sample_elapsed: Option<Duration>,
    aggregate_net_session_rx: u64,
    aggregate_net_session_tx: u64,
    net_state: HashMap<String, NetInterfaceState>,
    previous_disk: Option<DiskState>,
    history_60s: RollingWindowState,
    history_5m: RollingWindowState,
    history_15m: RollingWindowState,
}

impl fmt::Debug for Sampler {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Sampler")
            .field("proc_root", &self.proc_root)
            .field("sys_root", &self.sys_root)
            .field("poll_interval", &self.poll_interval)
            .field("previous_cpu", &self.previous_cpu.is_some())
            .finish_non_exhaustive()
    }
}

impl Sampler {
    /// Uses only the supplied roots; pass `/proc` and `/sys` for live measurements.
    ///
    /// Live filesystem `statvfs` queries are enabled only when `proc_root == Path::new("/proc")`;
    /// isolated test roots never touch host mounts unless configured with
    /// [`Sampler::with_mount_stat_provider`].
    #[must_use]
    pub fn new(proc_root: &Path, sys_root: &Path) -> Self {
        let provider: MountStatProvider = if proc_root == Path::new("/proc") {
            Box::new(live_statvfs)
        } else {
            Box::new(|_| None)
        };
        Self {
            proc_root: proc_root.to_owned(),
            sys_root: sys_root.to_owned(),
            poll_interval: POLL_INTERVAL,
            max_sample_gap: Duration::from_secs(10),
            mount_stat_provider: provider,
            boottime_epoch: None,
            instant_epoch: None,
            last_sample_elapsed: None,
            previous_cpu: None,
            previous_cores: BTreeMap::new(),
            cached_cpu_model: None,
            previous_primary_gpu_id: None,
            previous_active_net_iface: None,
            last_net_sample_elapsed: None,
            aggregate_net_session_rx: 0,
            aggregate_net_session_tx: 0,
            net_state: HashMap::new(),
            previous_disk: None,
            history_60s: RollingWindowState::new(1, HISTORY_BUCKETS),
            history_5m: RollingWindowState::new(5, HISTORY_BUCKETS),
            history_15m: RollingWindowState::new(15, HISTORY_BUCKETS),
        }
    }

    /// Overrides the configured poll interval reported in snapshots and used to derive the gap limit.
    #[must_use]
    pub fn with_poll_interval(mut self, interval: Duration) -> Self {
        self.poll_interval = interval;
        self.max_sample_gap = interval.saturating_mul(5).max(Duration::from_secs(10));
        self
    }

    /// Injects a custom mount capacity provider for deterministic, isolated tests.
    #[must_use]
    pub fn with_mount_stat_provider<F>(mut self, provider: F) -> Self
    where
        F: Fn(&Path) -> Option<MountStat> + Send + 'static,
    {
        self.mount_stat_provider = Box::new(provider);
        self
    }

    /// Reads a fresh snapshot using the suspend-aware Linux `CLOCK_BOOTTIME` clock so
    /// suspend/resume jumps are accurately detected even when `CLOCK_MONOTONIC` pauses during sleep.
    pub fn sample(&mut self) -> Snapshot {
        let now = boottime_now();
        let epoch = *self.boottime_epoch.get_or_insert(now);
        let elapsed_since_epoch = now.saturating_sub(epoch);
        self.sample_at_elapsed(elapsed_since_epoch)
    }

    /// Reads a fresh snapshot at an explicit monotonic timestamp, enabling deterministic
    /// rate, bucketing, suspend/resume gap, and history eviction tests.
    pub fn sample_at(&mut self, now: Instant) -> Snapshot {
        let epoch = *self.instant_epoch.get_or_insert(now);
        let elapsed_since_epoch = now.saturating_duration_since(epoch);
        self.sample_at_elapsed(elapsed_since_epoch)
    }

    fn sample_at_elapsed(&mut self, elapsed_since_epoch: Duration) -> Snapshot {
        let prev_elapsed = self.last_sample_elapsed.replace(elapsed_since_epoch);
        let elapsed = prev_elapsed.and_then(|previous| elapsed_since_epoch.checked_sub(previous));
        let gap_exceeded = elapsed.is_some_and(|dt| dt > self.max_sample_gap);

        // 1. CPU & system load/uptime
        let parsed_stat = parse_proc_stat(&self.proc_root.join("stat"));
        let (current_cpu, current_cores) = match parsed_stat {
            Some(stat) => (Some(stat.aggregate), stat.cores),
            None => (None, BTreeMap::new()),
        };
        let previous_cpu = std::mem::replace(&mut self.previous_cpu, current_cpu);
        let previous_cores = std::mem::replace(&mut self.previous_cores, current_cores.clone());

        let cpu_usage_percent = if gap_exceeded {
            None
        } else {
            previous_cpu
                .zip(current_cpu)
                .and_then(|(previous, current)| current.usage_since(previous))
        };

        let per_core_usage_percent: Vec<Option<f64>> = current_cores
            .iter()
            .map(|(core_id, current)| {
                if gap_exceeded {
                    return None;
                }
                previous_cores
                    .get(core_id)
                    .and_then(|previous| current.usage_since(*previous))
                    .map(round_tenths)
            })
            .collect();

        let cpufreq_mhz = read_cpufreq_mhz(&self.sys_root.join("devices/system/cpu"));
        let need_cpuinfo =
            self.cached_cpu_model.is_none() || cpufreq_mhz.is_none() || current_cores.is_empty();
        let cpuinfo = if need_cpuinfo {
            parse_cpuinfo(&self.proc_root.join("cpuinfo"))
        } else {
            None
        };
        if self.cached_cpu_model.is_none()
            && let Some(model) = cpuinfo.as_ref().and_then(|info| info.model_name.clone())
        {
            self.cached_cpu_model = Some(model);
        }
        let frequency_mhz =
            cpufreq_mhz.or_else(|| cpuinfo.as_ref().and_then(|info| info.frequency_mhz));
        let core_count = if !current_cores.is_empty() {
            current_cores.len() as u32
        } else {
            cpuinfo.as_ref().map_or(0, |info| info.core_count)
        };
        let load_average = parse_loadavg(&self.proc_root.join("loadavg"));
        let uptime_seconds = parse_uptime(&self.proc_root.join("uptime"));

        let cpu = (core_count > 0
            || frequency_mhz.is_some()
            || self.cached_cpu_model.is_some()
            || load_average.is_some()
            || uptime_seconds.is_some())
        .then(|| CpuInfo {
            core_count,
            per_core_usage_percent,
            frequency_mhz,
            model_name: self.cached_cpu_model.clone(),
            load_average,
            uptime_seconds,
        });

        // 2. Memory & Swap (optional fields never invalidate valid MemTotal/MemAvailable)
        let (memory, swap) = parse_meminfo(&self.proc_root.join("meminfo"));

        // 3. Legacy thermal zones + merged friendly sensors
        let temperatures = temperatures(&self.sys_root.join("class/thermal"));
        let sensors = collect_sensors(&self.sys_root.join("class/hwmon"), &temperatures);

        // 4. Multi-GPU DRM/hwmon
        let gpus = collect_gpus(&self.sys_root.join("class/drm"));
        let current_primary_gpu_id = gpus.first().map(|gpu| gpu.id.clone());
        let gpu_switched = match (&self.previous_primary_gpu_id, &current_primary_gpu_id) {
            (Some(prev), Some(curr)) => prev != curr,
            _ => false,
        };
        self.previous_primary_gpu_id = current_primary_gpu_id;

        // 5. Network (non-loopback rates + per-interface session totals + active aggregate)
        let network = self.sample_network(elapsed_since_epoch, gap_exceeded);
        let current_active_iface = network
            .as_ref()
            .and_then(|net| net.active_interface.clone());
        let net_switched = match (&self.previous_active_net_iface, &current_active_iface) {
            (Some(prev), Some(curr)) => prev != curr,
            _ => false,
        };
        self.previous_active_net_iface = current_active_iface;

        // 6. Single-layer block Disk I/O + isolated local mounts
        let storage = self.sample_storage(elapsed_since_epoch, gap_exceeded);

        let has_any_source = self.previous_cpu.is_some()
            || cpu_usage_percent.is_some()
            || memory.is_some()
            || !temperatures.is_empty()
            || cpu.is_some()
            || swap.is_some()
            || !gpus.is_empty()
            || network.is_some()
            || storage.is_some()
            || !sensors.is_empty();

        if !has_any_source {
            return Snapshot::default();
        }

        // 7. Timestamp-bucketed rolling history
        let memory_percent = memory
            .filter(|mem| mem.total_bytes > 0)
            .map(|mem| round_tenths(mem.used_bytes as f64 * 100.0 / mem.total_bytes as f64));
        let history_sample = HistorySample {
            cpu_percent: cpu_usage_percent.map(round_tenths),
            memory_percent,
            gpu_percent: if gpu_switched || gap_exceeded {
                None
            } else {
                gpus.first()
                    .and_then(|gpu| gpu.utilization_percent)
                    .map(round_tenths)
            },
            net_rx_bytes_per_sec: if net_switched || gap_exceeded {
                None
            } else {
                network.as_ref().and_then(|net| net.rx_bytes_per_sec)
            },
            net_tx_bytes_per_sec: if net_switched || gap_exceeded {
                None
            } else {
                network.as_ref().and_then(|net| net.tx_bytes_per_sec)
            },
            aggregate_net_rx_bytes_per_sec: if gap_exceeded {
                None
            } else {
                network
                    .as_ref()
                    .and_then(|net| net.aggregate.as_ref())
                    .and_then(|agg| agg.rx_bytes_per_sec)
            },
            aggregate_net_tx_bytes_per_sec: if gap_exceeded {
                None
            } else {
                network
                    .as_ref()
                    .and_then(|net| net.aggregate.as_ref())
                    .and_then(|agg| agg.tx_bytes_per_sec)
            },
            disk_read_bytes_per_sec: if gap_exceeded {
                None
            } else {
                storage.as_ref().and_then(|st| st.read_bytes_per_sec)
            },
            disk_write_bytes_per_sec: if gap_exceeded {
                None
            } else {
                storage.as_ref().and_then(|st| st.write_bytes_per_sec)
            },
        };

        // Quantize elapsed history timestamps to the nearest poll grid tick so sub-period
        // timer jitter (e.g. 999ms / 2001ms on a 1s interval) never drops adjacent buckets,
        // while keeping unquantized `elapsed_since_epoch` for all rate calculations and gap checks.
        let elapsed_since_epoch_ms =
            u64::try_from(elapsed_since_epoch.as_millis()).unwrap_or(u64::MAX);
        let poll_ms = u64::try_from(self.poll_interval.as_millis()).unwrap_or(u64::MAX);
        let history_elapsed_ms = elapsed_since_epoch_ms
            .saturating_add(poll_ms / 2)
            .checked_div(poll_ms)
            .map_or(elapsed_since_epoch_ms, |ticks| {
                ticks.saturating_mul(poll_ms)
            });
        self.history_60s.record(history_elapsed_ms, history_sample);
        self.history_5m.record(history_elapsed_ms, history_sample);
        self.history_15m.record(history_elapsed_ms, history_sample);

        let history = Some(TelemetryHistory {
            window_60s: self.history_60s.materialize(history_elapsed_ms),
            window_5m: self.history_5m.materialize(history_elapsed_ms),
            window_15m: self.history_15m.materialize(history_elapsed_ms),
        });

        Snapshot {
            cpu_usage_percent,
            memory,
            temperatures,
            poll_interval_ms: Some(self.poll_interval.as_millis() as u64),
            cpu,
            swap,
            gpus,
            network,
            storage,
            sensors,
            history,
        }
    }

    fn has_cpu_baseline(&self) -> bool {
        self.previous_cpu.is_some()
    }

    fn sample_network(
        &mut self,
        now_elapsed: Duration,
        gap_exceeded: bool,
    ) -> Option<NetworkTelemetry> {
        let Some(readings) = parse_net_dev(&self.proc_root.join("net/dev")) else {
            for state in self.net_state.values_mut() {
                state.prev = None;
            }
            self.last_net_sample_elapsed = None;
            return None;
        };

        let mut seen = HashMap::new();
        for (name, rx, tx) in readings {
            if is_loopback_interface(&self.sys_root.join("class/net"), &name) {
                continue;
            }
            seen.insert(name, (rx, tx));
        }

        for (name, state) in &mut self.net_state {
            if !seen.contains_key(name) {
                state.prev = None;
            }
        }

        if seen.is_empty() {
            self.last_net_sample_elapsed = None;
            return None;
        }

        let prev_net_elapsed = self.last_net_sample_elapsed.replace(now_elapsed);
        let valid_net_interval = !gap_exceeded
            && prev_net_elapsed
                .and_then(|previous| now_elapsed.checked_sub(previous))
                .is_some_and(|dt| !dt.is_zero() && dt <= self.max_sample_gap);

        let mut interfaces = Vec::with_capacity(seen.len());
        let mut raw_totals: HashMap<String, u64> = HashMap::with_capacity(seen.len());
        let mut active_interfaces = Vec::with_capacity(seen.len());
        let mut agg_rx_sum: u64 = 0;
        let mut agg_rx_valid: u32 = 0;
        let mut agg_tx_sum: u64 = 0;
        let mut agg_tx_valid: u32 = 0;

        for (name, (rx, tx)) in seen {
            let up = read_interface_up(&self.sys_root.join("class/net").join(&name));
            let active_eligible = up != Some(false);
            let entry = self.net_state.entry(name.clone()).or_default();
            let (rx_delta, rx_bps, tx_delta, tx_bps) = if gap_exceeded {
                (None, None, None, None)
            } else if let Some((prev_rx, prev_tx, prev_at)) = entry.prev {
                let dt = now_elapsed
                    .checked_sub(prev_at)
                    .filter(|dt| !dt.is_zero() && *dt <= self.max_sample_gap);
                if let Some(dt) = dt {
                    let secs = dt.as_secs_f64();
                    let rx_delta = rx.checked_sub(prev_rx);
                    let rx_rate = rx_delta.map(|delta| {
                        entry.session_rx = entry.session_rx.saturating_add(delta);
                        (delta as f64 / secs).round() as u64
                    });
                    let tx_delta = tx.checked_sub(prev_tx);
                    let tx_rate = tx_delta.map(|delta| {
                        entry.session_tx = entry.session_tx.saturating_add(delta);
                        (delta as f64 / secs).round() as u64
                    });
                    (rx_delta, rx_rate, tx_delta, tx_rate)
                } else {
                    (None, None, None, None)
                }
            } else {
                (None, None, None, None)
            };
            entry.prev = Some((rx, tx, now_elapsed));
            if active_eligible {
                active_interfaces.push(name.clone());
                if let Some(delta) = rx_delta {
                    self.aggregate_net_session_rx =
                        self.aggregate_net_session_rx.saturating_add(delta);
                }
                if let Some(rate) = rx_bps {
                    agg_rx_sum = agg_rx_sum.saturating_add(rate);
                    agg_rx_valid += 1;
                }
                if let Some(delta) = tx_delta {
                    self.aggregate_net_session_tx =
                        self.aggregate_net_session_tx.saturating_add(delta);
                }
                if let Some(rate) = tx_bps {
                    agg_tx_sum = agg_tx_sum.saturating_add(rate);
                    agg_tx_valid += 1;
                }
            }
            raw_totals.insert(name.clone(), rx.saturating_add(tx));
            interfaces.push(NetworkInterfaceTelemetry {
                name,
                up,
                rx_bytes_per_sec: rx_bps,
                tx_bytes_per_sec: tx_bps,
                session_rx_bytes: entry.session_rx,
                session_tx_bytes: entry.session_tx,
            });
        }

        interfaces.sort_by(|a, b| a.name.cmp(&b.name));
        active_interfaces.sort();

        let all_known_down = active_interfaces.is_empty();
        let aggregate = Some(NetworkAggregateTelemetry {
            active_interface_count: active_interfaces.len() as u32,
            active_interfaces,
            rx_bytes_per_sec: if agg_rx_valid > 0 {
                Some(agg_rx_sum)
            } else if all_known_down && valid_net_interval {
                Some(0)
            } else {
                None
            },
            tx_bytes_per_sec: if agg_tx_valid > 0 {
                Some(agg_tx_sum)
            } else if all_known_down && valid_net_interval {
                Some(0)
            } else {
                None
            },
            session_rx_bytes: self.aggregate_net_session_rx,
            session_tx_bytes: self.aggregate_net_session_tx,
        });

        let active = interfaces
            .iter()
            .max_by(|a, b| {
                let a_up = u8::from(a.up == Some(true));
                let b_up = u8::from(b.up == Some(true));
                let a_rate = a
                    .rx_bytes_per_sec
                    .unwrap_or(0)
                    .saturating_add(a.tx_bytes_per_sec.unwrap_or(0));
                let b_rate = b
                    .rx_bytes_per_sec
                    .unwrap_or(0)
                    .saturating_add(b.tx_bytes_per_sec.unwrap_or(0));
                let a_prev = u8::from(self.previous_active_net_iface.as_deref() == Some(&a.name));
                let b_prev = u8::from(self.previous_active_net_iface.as_deref() == Some(&b.name));
                let a_raw = raw_totals.get(&a.name).copied().unwrap_or(0);
                let b_raw = raw_totals.get(&b.name).copied().unwrap_or(0);

                a_up.cmp(&b_up)
                    .then_with(|| a_rate.cmp(&b_rate))
                    .then_with(|| a_prev.cmp(&b_prev))
                    .then_with(|| a_raw.cmp(&b_raw))
                    .then_with(|| b.name.cmp(&a.name))
            })
            .cloned();

        let (
            active_interface,
            rx_bytes_per_sec,
            tx_bytes_per_sec,
            session_rx_bytes,
            session_tx_bytes,
        ) = match active {
            Some(iface) => (
                Some(iface.name),
                iface.rx_bytes_per_sec,
                iface.tx_bytes_per_sec,
                iface.session_rx_bytes,
                iface.session_tx_bytes,
            ),
            None => (None, None, None, 0, 0),
        };

        Some(NetworkTelemetry {
            active_interface,
            rx_bytes_per_sec,
            tx_bytes_per_sec,
            session_rx_bytes,
            session_tx_bytes,
            aggregate,
            interfaces,
        })
    }

    fn sample_storage(
        &mut self,
        now_elapsed: Duration,
        gap_exceeded: bool,
    ) -> Option<StorageTelemetry> {
        let disk_readings = parse_diskstats(
            &self.proc_root.join("diskstats"),
            &self.sys_root.join("class/block"),
        );

        let (read_bytes_per_sec, write_bytes_per_sec) = match disk_readings {
            Some(current_devices) if !current_devices.is_empty() => {
                let prev = self.previous_disk.replace(DiskState {
                    at: now_elapsed,
                    devices: current_devices.clone(),
                });
                if gap_exceeded {
                    (None, None)
                } else if let Some(prev) = prev {
                    let dt = now_elapsed
                        .checked_sub(prev.at)
                        .filter(|dt| !dt.is_zero() && *dt <= self.max_sample_gap);
                    if let Some(dt) = dt {
                        compute_disk_rates(&prev.devices, &current_devices, dt)
                    } else {
                        (None, None)
                    }
                } else {
                    (None, None)
                }
            }
            _ => {
                self.previous_disk = None;
                (None, None)
            }
        };

        let mounts = collect_mounts(
            &self.proc_root.join("mounts"),
            self.mount_stat_provider.as_ref(),
        );

        if self.previous_disk.is_none() && mounts.is_empty() {
            return None;
        }

        Some(StorageTelemetry {
            read_bytes_per_sec,
            write_bytes_per_sec,
            mounts,
        })
    }
}

#[derive(Debug, Default)]
struct NetInterfaceState {
    prev: Option<(u64, u64, Duration)>,
    session_rx: u64,
    session_tx: u64,
}

#[derive(Debug)]
struct DiskState {
    at: Duration,
    devices: BTreeMap<String, (u64, u64)>,
}

fn compute_disk_rates(
    previous: &BTreeMap<String, (u64, u64)>,
    current: &BTreeMap<String, (u64, u64)>,
    dt: Duration,
) -> (Option<u64>, Option<u64>) {
    let mut matched = 0usize;
    let mut read_sectors: u128 = 0;
    let mut write_sectors: u128 = 0;
    for (dev, &(cur_r, cur_w)) in current {
        let Some(&(prev_r, prev_w)) = previous.get(dev) else {
            continue;
        };
        let (Some(dr), Some(dw)) = (cur_r.checked_sub(prev_r), cur_w.checked_sub(prev_w)) else {
            return (None, None);
        };
        matched += 1;
        read_sectors += u128::from(dr);
        write_sectors += u128::from(dw);
    }
    if matched == 0 {
        return (None, None);
    }
    let secs = dt.as_secs_f64();
    let read_bps = ((read_sectors * u128::from(SECTOR_BYTES)) as f64 / secs).round() as u64;
    let write_bps = ((write_sectors * u128::from(SECTOR_BYTES)) as f64 / secs).round() as u64;
    (Some(read_bps), Some(write_bps))
}

#[derive(Debug, Clone, Copy)]
struct HistorySample {
    cpu_percent: Option<f64>,
    memory_percent: Option<f64>,
    gpu_percent: Option<f64>,
    net_rx_bytes_per_sec: Option<u64>,
    net_tx_bytes_per_sec: Option<u64>,
    aggregate_net_rx_bytes_per_sec: Option<u64>,
    aggregate_net_tx_bytes_per_sec: Option<u64>,
    disk_read_bytes_per_sec: Option<u64>,
    disk_write_bytes_per_sec: Option<u64>,
}

#[derive(Debug, Clone, Default)]
struct BucketAccumulator {
    bucket_id: u64,
    cpu_sum: f64,
    cpu_count: u32,
    mem_sum: f64,
    mem_count: u32,
    gpu_sum: f64,
    gpu_count: u32,
    net_rx_sum: u128,
    net_rx_count: u32,
    net_tx_sum: u128,
    net_tx_count: u32,
    agg_net_rx_sum: u128,
    agg_net_rx_count: u32,
    agg_net_tx_sum: u128,
    agg_net_tx_count: u32,
    disk_r_sum: u128,
    disk_r_count: u32,
    disk_w_sum: u128,
    disk_w_count: u32,
}

impl BucketAccumulator {
    fn new(bucket_id: u64) -> Self {
        Self {
            bucket_id,
            ..Self::default()
        }
    }

    fn push(&mut self, sample: HistorySample) {
        if let Some(v) = sample.cpu_percent {
            self.cpu_sum += v;
            self.cpu_count += 1;
        }
        if let Some(v) = sample.memory_percent {
            self.mem_sum += v;
            self.mem_count += 1;
        }
        if let Some(v) = sample.gpu_percent {
            self.gpu_sum += v;
            self.gpu_count += 1;
        }
        if let Some(v) = sample.net_rx_bytes_per_sec {
            self.net_rx_sum += u128::from(v);
            self.net_rx_count += 1;
        }
        if let Some(v) = sample.net_tx_bytes_per_sec {
            self.net_tx_sum += u128::from(v);
            self.net_tx_count += 1;
        }
        if let Some(v) = sample.aggregate_net_rx_bytes_per_sec {
            self.agg_net_rx_sum += u128::from(v);
            self.agg_net_rx_count += 1;
        }
        if let Some(v) = sample.aggregate_net_tx_bytes_per_sec {
            self.agg_net_tx_sum += u128::from(v);
            self.agg_net_tx_count += 1;
        }
        if let Some(v) = sample.disk_read_bytes_per_sec {
            self.disk_r_sum += u128::from(v);
            self.disk_r_count += 1;
        }
        if let Some(v) = sample.disk_write_bytes_per_sec {
            self.disk_w_sum += u128::from(v);
            self.disk_w_count += 1;
        }
    }

    fn cpu(&self) -> Option<f64> {
        (self.cpu_count > 0).then(|| round_tenths(self.cpu_sum / f64::from(self.cpu_count)))
    }

    fn memory(&self) -> Option<f64> {
        (self.mem_count > 0).then(|| round_tenths(self.mem_sum / f64::from(self.mem_count)))
    }

    fn gpu(&self) -> Option<f64> {
        (self.gpu_count > 0).then(|| round_tenths(self.gpu_sum / f64::from(self.gpu_count)))
    }

    fn net_rx(&self) -> Option<u64> {
        (self.net_rx_count > 0).then(|| (self.net_rx_sum / u128::from(self.net_rx_count)) as u64)
    }

    fn net_tx(&self) -> Option<u64> {
        (self.net_tx_count > 0).then(|| (self.net_tx_sum / u128::from(self.net_tx_count)) as u64)
    }

    fn aggregate_net_rx(&self) -> Option<u64> {
        (self.agg_net_rx_count > 0)
            .then(|| (self.agg_net_rx_sum / u128::from(self.agg_net_rx_count)) as u64)
    }

    fn aggregate_net_tx(&self) -> Option<u64> {
        (self.agg_net_tx_count > 0)
            .then(|| (self.agg_net_tx_sum / u128::from(self.agg_net_tx_count)) as u64)
    }

    fn disk_read(&self) -> Option<u64> {
        (self.disk_r_count > 0).then(|| (self.disk_r_sum / u128::from(self.disk_r_count)) as u64)
    }

    fn disk_write(&self) -> Option<u64> {
        (self.disk_w_count > 0).then(|| (self.disk_w_sum / u128::from(self.disk_w_count)) as u64)
    }
}

#[derive(Debug)]
struct RollingWindowState {
    bucket_seconds: u32,
    max_buckets: usize,
    buckets: VecDeque<BucketAccumulator>,
}

impl RollingWindowState {
    fn new(bucket_seconds: u32, max_buckets: usize) -> Self {
        Self {
            bucket_seconds,
            max_buckets,
            buckets: VecDeque::with_capacity(max_buckets),
        }
    }

    fn record(&mut self, elapsed_ms: u64, sample: HistorySample) {
        let bucket_ms = u64::from(self.bucket_seconds) * 1000;
        let bucket_id = elapsed_ms / bucket_ms;
        let min_bucket = bucket_id.saturating_sub((self.max_buckets - 1) as u64);

        while self
            .buckets
            .front()
            .is_some_and(|front| front.bucket_id < min_bucket)
        {
            self.buckets.pop_front();
        }

        if let Some(last) = self.buckets.back_mut()
            && last.bucket_id == bucket_id
        {
            last.push(sample);
            return;
        }
        let mut acc = BucketAccumulator::new(bucket_id);
        acc.push(sample);
        self.buckets.push_back(acc);
    }

    fn materialize(&self, elapsed_ms: u64) -> HistoryWindow {
        let bucket_ms = u64::from(self.bucket_seconds) * 1000;
        let cur_bucket = elapsed_ms / bucket_ms;
        let min_bucket = cur_bucket.saturating_sub((self.max_buckets - 1) as u64);
        let start_bucket = self
            .buckets
            .front()
            .map_or(cur_bucket, |front| front.bucket_id.max(min_bucket));
        let len = (cur_bucket.saturating_sub(start_bucket) as usize + 1).min(self.max_buckets);

        let mut cpu_percent = vec![None; len];
        let mut memory_percent = vec![None; len];
        let mut gpu_percent = vec![None; len];
        let mut net_rx_bytes_per_sec = vec![None; len];
        let mut net_tx_bytes_per_sec = vec![None; len];
        let mut aggregate_net_rx_bytes_per_sec = vec![None; len];
        let mut aggregate_net_tx_bytes_per_sec = vec![None; len];
        let mut disk_read_bytes_per_sec = vec![None; len];
        let mut disk_write_bytes_per_sec = vec![None; len];

        let mut has_gpu = false;
        let mut has_net = false;
        let mut has_agg_net = false;
        let mut has_disk = false;

        for bucket in &self.buckets {
            if bucket.bucket_id < start_bucket || bucket.bucket_id > cur_bucket {
                continue;
            }
            let idx = (bucket.bucket_id - start_bucket) as usize;
            if idx >= len {
                continue;
            }
            cpu_percent[idx] = bucket.cpu();
            memory_percent[idx] = bucket.memory();
            let gpu = bucket.gpu();
            if gpu.is_some() {
                has_gpu = true;
            }
            gpu_percent[idx] = gpu;
            let rx = bucket.net_rx();
            let tx = bucket.net_tx();
            if rx.is_some() || tx.is_some() {
                has_net = true;
            }
            net_rx_bytes_per_sec[idx] = rx;
            net_tx_bytes_per_sec[idx] = tx;
            let agg_rx = bucket.aggregate_net_rx();
            let agg_tx = bucket.aggregate_net_tx();
            if agg_rx.is_some() || agg_tx.is_some() {
                has_agg_net = true;
            }
            aggregate_net_rx_bytes_per_sec[idx] = agg_rx;
            aggregate_net_tx_bytes_per_sec[idx] = agg_tx;
            let dr = bucket.disk_read();
            let dw = bucket.disk_write();
            if dr.is_some() || dw.is_some() {
                has_disk = true;
            }
            disk_read_bytes_per_sec[idx] = dr;
            disk_write_bytes_per_sec[idx] = dw;
        }

        if !has_gpu {
            gpu_percent.clear();
        }
        if !has_net {
            net_rx_bytes_per_sec.clear();
            net_tx_bytes_per_sec.clear();
        }
        if !has_agg_net {
            aggregate_net_rx_bytes_per_sec.clear();
            aggregate_net_tx_bytes_per_sec.clear();
        }
        if !has_disk {
            disk_read_bytes_per_sec.clear();
            disk_write_bytes_per_sec.clear();
        }

        HistoryWindow {
            bucket_seconds: self.bucket_seconds,
            latest_bucket_id: Some(cur_bucket),
            cpu_percent,
            memory_percent,
            gpu_percent,
            net_rx_bytes_per_sec,
            net_tx_bytes_per_sec,
            aggregate_net_rx_bytes_per_sec,
            aggregate_net_tx_bytes_per_sec,
            disk_read_bytes_per_sec,
            disk_write_bytes_per_sec,
        }
    }
}

fn round_tenths(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[derive(Debug, Clone, Copy)]
struct CpuTicks([u64; 8]);

impl CpuTicks {
    fn usage_since(self, previous: Self) -> Option<f64> {
        let mut busy = 0_u128;
        for index in [0, 1, 2, 5, 6, 7] {
            busy += u128::from(self.0[index].checked_sub(previous.0[index])?);
        }
        // Tickless Linux kernels (`CONFIG_NO_HZ_IDLE`) can briefly retract `idle` or `iowait`
        // by 1–2 ticks between adjacent `/proc/stat` reads. Combine them with saturating
        // subtraction so benign NO_HZ jitter never discards a valid busy interval while genuine
        // busy-counter resets still yield `None`.
        let curr_idle = u128::from(self.0[3]) + u128::from(self.0[4]);
        let prev_idle = u128::from(previous.0[3]) + u128::from(previous.0[4]);
        let idle = curr_idle.saturating_sub(prev_idle);
        let total = busy + idle;
        (total != 0).then(|| busy as f64 * 100.0 / total as f64)
    }
}

struct ParsedStat {
    aggregate: CpuTicks,
    cores: BTreeMap<u32, CpuTicks>,
}

fn parse_cpu_ticks_fields<'a>(mut fields: impl Iterator<Item = &'a str>) -> Option<CpuTicks> {
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

fn parse_proc_stat(path: &Path) -> Option<ParsedStat> {
    let mut reader = BufReader::new(regular_file(path)?);
    let mut line = String::new();
    let mut aggregate = None;
    let mut cores = BTreeMap::new();

    for line_idx in 0..STAT_MAX_LINES {
        line.clear();
        let read_bytes = reader
            .by_ref()
            .take(CPU_LINE_LIMIT)
            .read_line(&mut line)
            .ok()?;
        if read_bytes == 0 {
            break;
        }
        if line.len() as u64 == CPU_LINE_LIMIT && !line.ends_with('\n') {
            if line_idx == 0 {
                return None;
            }
            break;
        }
        let mut fields = line.split_ascii_whitespace();
        let Some(label) = fields.next() else {
            if line_idx == 0 {
                return None;
            }
            break;
        };
        if line_idx == 0 {
            if label != "cpu" {
                return None;
            }
            aggregate = Some(parse_cpu_ticks_fields(fields)?);
        } else if let Some(core_str) = label.strip_prefix("cpu") {
            if let Ok(core_id) = core_str.parse::<u32>()
                && let Some(ticks) = parse_cpu_ticks_fields(fields)
            {
                cores.insert(core_id, ticks);
            }
        } else {
            break;
        }
    }

    Some(ParsedStat {
        aggregate: aggregate?,
        cores,
    })
}

fn read_cpufreq_mhz(cpu_sys_root: &Path) -> Option<u64> {
    let entries = fs::read_dir(cpu_sys_root).ok()?;
    let mut sum_khz: u128 = 0;
    let mut count: u128 = 0;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        let Some(suffix) = name_str.strip_prefix("cpu") else {
            continue;
        };
        if suffix.is_empty() || !suffix.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let cpufreq = entry.path().join("cpufreq");
        let khz = read_text(&cpufreq.join("scaling_cur_freq"), SMALL_ATTR_LIMIT)
            .or_else(|| read_text(&cpufreq.join("cpuinfo_cur_freq"), SMALL_ATTR_LIMIT))
            .and_then(|s| s.trim().parse::<u64>().ok());
        if let Some(khz) = khz
            && khz > 0
        {
            sum_khz += u128::from(khz);
            count += 1;
        }
    }
    (count > 0).then(|| ((sum_khz / count) / 1000) as u64)
}

struct ParsedCpuInfo {
    model_name: Option<String>,
    frequency_mhz: Option<u64>,
    core_count: u32,
}

fn parse_cpuinfo(path: &Path) -> Option<ParsedCpuInfo> {
    let text = read_text(path, CPUINFO_LIMIT)?;
    let mut model_name: Option<String> = None;
    let mut freq_sum = 0.0_f64;
    let mut freq_count = 0_u32;
    let mut core_count = 0_u32;

    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        match key {
            "processor" => {
                if value.parse::<u32>().is_ok() {
                    core_count = core_count.saturating_add(1);
                }
            }
            "model name" | "Hardware" if model_name.is_none() && !value.is_empty() => {
                model_name = Some(value.to_owned());
            }
            "cpu MHz" => {
                if let Ok(mhz) = value.parse::<f64>()
                    && mhz.is_finite()
                    && mhz > 0.0
                {
                    freq_sum += mhz;
                    freq_count += 1;
                }
            }
            _ => {}
        }
    }

    let frequency_mhz = (freq_count > 0).then(|| (freq_sum / f64::from(freq_count)).round() as u64);
    Some(ParsedCpuInfo {
        model_name,
        frequency_mhz,
        core_count,
    })
}

fn parse_loadavg(path: &Path) -> Option<[f64; 3]> {
    let text = read_text(path, SMALL_ATTR_LIMIT)?;
    let mut fields = text.split_ascii_whitespace();
    let one: f64 = fields.next()?.parse().ok()?;
    let five: f64 = fields.next()?.parse().ok()?;
    let fifteen: f64 = fields.next()?.parse().ok()?;
    if ![one, five, fifteen]
        .into_iter()
        .all(|v| v.is_finite() && v >= 0.0)
    {
        return None;
    }
    Some([one, five, fifteen])
}

fn parse_uptime(path: &Path) -> Option<u64> {
    let text = read_text(path, SMALL_ATTR_LIMIT)?;
    let seconds: f64 = text.split_ascii_whitespace().next()?.parse().ok()?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    Some(seconds.floor() as u64)
}

fn parse_kib_field<'a>(mut fields: impl Iterator<Item = &'a str>) -> Option<u64> {
    let kibibytes: u64 = fields.next()?.parse().ok()?;
    if fields.next()? != "kB" {
        return None;
    }
    kibibytes.checked_mul(1024)
}

fn parse_meminfo(path: &Path) -> (Option<Memory>, Option<Swap>) {
    let Some(text) = read_text(path, MEMINFO_LIMIT) else {
        return (None, None);
    };
    let mut total = None;
    let mut available = None;
    let mut cached = None;
    let mut buffers = None;
    let mut reclaimable = None;
    let mut swap_total = None;
    let mut swap_free = None;
    let mut required_malformed = false;

    for line in text.lines() {
        let mut fields = line.split_ascii_whitespace();
        let Some(key) = fields.next() else {
            continue;
        };
        match key {
            "MemTotal:" => match parse_kib_field(fields) {
                Some(bytes) => total = Some(bytes),
                None => required_malformed = true,
            },
            "MemAvailable:" => match parse_kib_field(fields) {
                Some(bytes) => available = Some(bytes),
                None => required_malformed = true,
            },
            "Cached:" => cached = parse_kib_field(fields),
            "Buffers:" => buffers = parse_kib_field(fields),
            "SReclaimable:" => reclaimable = parse_kib_field(fields),
            "SwapTotal:" => swap_total = parse_kib_field(fields),
            "SwapFree:" => swap_free = parse_kib_field(fields),
            _ => {}
        }
    }

    let memory = if required_malformed {
        None
    } else if let (Some(total_bytes), Some(available_bytes)) = (total, available) {
        total_bytes
            .checked_sub(available_bytes)
            .map(|used_bytes| Memory {
                total_bytes,
                available_bytes,
                used_bytes,
                cached_bytes: cached,
                buffers_bytes: buffers,
                reclaimable_bytes: reclaimable,
            })
    } else {
        None
    };

    let swap = match (swap_total, swap_free) {
        (Some(total_bytes), Some(free_bytes)) => {
            total_bytes.checked_sub(free_bytes).map(|used_bytes| Swap {
                total_bytes,
                free_bytes,
                used_bytes,
            })
        }
        _ => None,
    };

    (memory, swap)
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
            let kind = read_text(&path.join("type"), SMALL_ATTR_LIMIT)?;
            let kind = kind.trim();
            if kind.is_empty() {
                return None;
            }
            let temperature_millicelsius = read_text(&path.join("temp"), SMALL_ATTR_LIMIT)?
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

fn collect_gpus(drm_root: &Path) -> Vec<GpuInfo> {
    let Ok(entries) = fs::read_dir(drm_root) else {
        return Vec::new();
    };
    let mut cards: Vec<(u32, GpuInfo)> = Vec::new();

    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        let Some(num_str) = name_str.strip_prefix("card") else {
            continue;
        };
        if num_str.is_empty() || !num_str.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(card_num) = num_str.parse::<u32>() else {
            continue;
        };

        let device_dir = entry.path().join("device");
        if !device_dir.exists() {
            continue;
        }

        let uevent = read_text(&device_dir.join("uevent"), SMALL_ATTR_LIMIT);
        let driver = fs::read_link(device_dir.join("driver"))
            .ok()
            .and_then(|target| {
                target
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(str::to_owned)
            })
            .or_else(|| uevent_value(uevent.as_deref(), "DRIVER"));
        let pci_slot = uevent_value(uevent.as_deref(), "PCI_SLOT_NAME");
        let product_name = read_trimmed(&device_dir.join("product_name"))
            .or_else(|| read_trimmed(&device_dir.join("marketing_name")));

        let utilization_percent = read_trimmed(&device_dir.join("gpu_busy_percent"))
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|v| v.is_finite() && (0.0..=100.0).contains(v));
        let vram_used_bytes = read_trimmed(&device_dir.join("mem_info_vram_used"))
            .and_then(|s| s.parse::<u64>().ok());
        let vram_total_bytes = read_trimmed(&device_dir.join("mem_info_vram_total"))
            .and_then(|s| s.parse::<u64>().ok());

        let (hwmon_temp, hwmon_power_mw, hwmon_clock_mhz) =
            read_gpu_hwmon(&device_dir.join("hwmon"));

        let clock_mhz = parse_pp_dpm_sclk(&device_dir.join("pp_dpm_sclk"))
            .or_else(|| {
                read_trimmed(&device_dir.join("gt_cur_freq_mhz"))
                    .and_then(|s| s.parse::<u64>().ok())
            })
            .or(hwmon_clock_mhz);

        let has_telemetry = utilization_percent.is_some()
            || vram_used_bytes.is_some()
            || vram_total_bytes.is_some()
            || hwmon_temp.is_some()
            || hwmon_power_mw.is_some()
            || clock_mhz.is_some();

        if !has_telemetry {
            continue;
        }

        cards.push((
            card_num,
            GpuInfo {
                id: name_str.to_owned(),
                name: product_name,
                driver,
                pci_slot,
                utilization_percent,
                vram_used_bytes,
                vram_total_bytes,
                temperature_millicelsius: hwmon_temp,
                power_milliwatts: hwmon_power_mw,
                clock_mhz,
            },
        ));
    }

    cards.sort_by(|(a_num, a_gpu), (b_num, b_gpu)| {
        a_num
            .cmp(b_num)
            .then_with(|| a_gpu.pci_slot.cmp(&b_gpu.pci_slot))
    });
    cards.into_iter().map(|(_, gpu)| gpu).collect()
}

fn uevent_value(uevent: Option<&str>, key: &str) -> Option<String> {
    let text = uevent?;
    let prefix = format!("{key}=");
    text.lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn parse_pp_dpm_sclk(path: &Path) -> Option<u64> {
    let text = read_text(path, SMALL_ATTR_LIMIT)?;
    for line in text.lines() {
        if !line.contains('*') {
            continue;
        }
        for token in line.split_ascii_whitespace() {
            let lower = token.to_ascii_lowercase();
            if let Some(num) = lower.strip_suffix("mhz")
                && let Ok(mhz) = num.parse::<u64>()
            {
                return Some(mhz);
            }
        }
    }
    None
}

fn read_gpu_hwmon(hwmon_root: &Path) -> (Option<i64>, Option<u64>, Option<u64>) {
    let Ok(entries) = fs::read_dir(hwmon_root) else {
        return (None, None, None);
    };
    let mut dirs: Vec<(u32, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let num = entry
                .file_name()
                .to_str()?
                .strip_prefix("hwmon")?
                .parse::<u32>()
                .ok()?;
            Some((num, entry.path()))
        })
        .collect();
    dirs.sort_by_key(|(num, _)| *num);

    let mut temp = None;
    let mut power_mw = None;
    let mut clock_mhz = None;

    for (_, dir) in dirs {
        if temp.is_none() {
            let readings = read_hwmon_temps(&dir);
            temp = pick_preferred_temp(&readings, &["edge", "junction", "gpu"]);
        }
        if power_mw.is_none() {
            power_mw = read_trimmed(&dir.join("power1_average"))
                .or_else(|| read_trimmed(&dir.join("power1_input")))
                .and_then(|s| s.parse::<u64>().ok())
                .map(|uw| uw / 1000);
        }
        if clock_mhz.is_none() {
            clock_mhz = read_trimmed(&dir.join("freq1_input"))
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|hz| *hz > 0)
                .map(|hz| hz / 1_000_000);
        }
    }
    (temp, power_mw, clock_mhz)
}

fn read_hwmon_temps(dir: &Path) -> Vec<(u32, Option<String>, i64)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut temps = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        let Some(rest) = name_str.strip_prefix("temp") else {
            continue;
        };
        let Some(idx_str) = rest.strip_suffix("_input") else {
            continue;
        };
        let Ok(idx) = idx_str.parse::<u32>() else {
            continue;
        };
        let Some(temp) = read_trimmed(&entry.path()).and_then(|s| s.parse::<i64>().ok()) else {
            continue;
        };
        let label = read_trimmed(&dir.join(format!("temp{idx}_label")));
        temps.push((idx, label, temp));
    }
    temps.sort_by_key(|(idx, _, _)| *idx);
    temps
}

fn pick_preferred_temp(
    readings: &[(u32, Option<String>, i64)],
    preferred_labels: &[&str],
) -> Option<i64> {
    for target in preferred_labels {
        if let Some((_, _, temp)) = readings.iter().find(|(_, label, _)| {
            label
                .as_deref()
                .is_some_and(|l| l.to_ascii_lowercase().contains(target))
        }) {
            return Some(*temp);
        }
    }
    readings.first().map(|(_, _, temp)| *temp)
}

fn collect_sensors(hwmon_root: &Path, thermal_zones: &[ThermalZone]) -> Vec<ThermalSensor> {
    let mut primary_by_category: BTreeMap<ThermalCategory, ThermalSensor> = BTreeMap::new();
    let mut extras: Vec<ThermalSensor> = Vec::new();

    if let Ok(entries) = fs::read_dir(hwmon_root) {
        let mut dirs: Vec<(u32, PathBuf)> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let num = entry
                    .file_name()
                    .to_str()?
                    .strip_prefix("hwmon")?
                    .parse::<u32>()
                    .ok()?;
                Some((num, entry.path()))
            })
            .collect();
        dirs.sort_by_key(|(num, _)| *num);

        for (_, dir) in dirs {
            let Some(driver) = read_trimmed(&dir.join("name")) else {
                continue;
            };
            let readings = read_hwmon_temps(&dir);
            if readings.is_empty() {
                continue;
            }
            let lower = driver.to_ascii_lowercase();
            let category = classify_sensor_name(&lower);
            let preferred = match category {
                ThermalCategory::Cpu => &["tctl", "tdie", "package", "cpu"][..],
                ThermalCategory::Gpu => &["edge", "junction", "gpu"][..],
                ThermalCategory::Nvme => &["composite", "sensor 1"][..],
                ThermalCategory::Battery => &["battery", "bat"][..],
                ThermalCategory::Other => &[][..],
            };
            let Some(temp) = pick_preferred_temp(&readings, preferred) else {
                continue;
            };
            let label = match category {
                ThermalCategory::Cpu => "CPU".to_owned(),
                ThermalCategory::Gpu => "GPU".to_owned(),
                ThermalCategory::Nvme => "NVMe".to_owned(),
                ThermalCategory::Battery => "Battery".to_owned(),
                ThermalCategory::Other => readings
                    .first()
                    .and_then(|(_, lbl, _)| lbl.clone())
                    .unwrap_or_else(|| driver.clone()),
            };
            let sensor = ThermalSensor {
                label,
                category,
                source: driver,
                temperature_millicelsius: temp,
            };
            if category == ThermalCategory::Other {
                extras.push(sensor);
            } else {
                primary_by_category.entry(category).or_insert(sensor);
            }
        }
    }

    for zone in thermal_zones {
        let lower = zone.kind.to_ascii_lowercase();
        let category = classify_sensor_name(&lower);
        let label = match category {
            ThermalCategory::Cpu => "CPU".to_owned(),
            ThermalCategory::Gpu => "GPU".to_owned(),
            ThermalCategory::Nvme => "NVMe".to_owned(),
            ThermalCategory::Battery => "Battery".to_owned(),
            ThermalCategory::Other => zone.kind.clone(),
        };
        let sensor = ThermalSensor {
            label,
            category,
            source: zone.kind.clone(),
            temperature_millicelsius: zone.temperature_millicelsius,
        };
        if category == ThermalCategory::Other {
            if !extras
                .iter()
                .any(|existing| existing.source == sensor.source)
            {
                extras.push(sensor);
            }
        } else {
            primary_by_category.entry(category).or_insert(sensor);
        }
    }

    let mut sensors: Vec<ThermalSensor> = primary_by_category.into_values().collect();
    for extra in extras {
        if sensors.len() >= MAX_SENSORS {
            break;
        }
        sensors.push(extra);
    }
    sensors
}

fn classify_sensor_name(lower: &str) -> ThermalCategory {
    if lower.contains("k10temp")
        || lower.contains("coretemp")
        || lower.contains("zenpower")
        || lower.contains("x86_pkg_temp")
        || lower == "cpu"
        || lower.starts_with("cpu")
        || lower.contains("tcpu")
        || lower.contains("soc_thermal")
        || lower.contains("soc-thermal")
    {
        ThermalCategory::Cpu
    } else if lower.contains("amdgpu")
        || lower.contains("nouveau")
        || lower.contains("radeon")
        || lower == "i915"
        || lower == "xe"
        || lower.contains("nvidia")
        || lower.contains("gpu")
    {
        ThermalCategory::Gpu
    } else if lower.starts_with("nvme") || lower.contains("drivetemp") {
        ThermalCategory::Nvme
    } else if lower.contains("bat") || lower.contains("bms") || lower.starts_with("sbs") {
        ThermalCategory::Battery
    } else {
        ThermalCategory::Other
    }
}

fn parse_net_dev(path: &Path) -> Option<Vec<(String, u64, u64)>> {
    let text = read_text(path, NET_DEV_LIMIT)?;
    let mut out = Vec::new();
    for line in text.lines().skip(2) {
        let Some((name_part, rest)) = line.split_once(':') else {
            continue;
        };
        let name = name_part.trim();
        if name.is_empty() {
            continue;
        }
        let mut fields = rest.split_ascii_whitespace();
        let Some(rx_bytes) = fields.next().and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        let Some(tx_bytes) = fields.nth(7).and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        out.push((name.to_owned(), rx_bytes, tx_bytes));
    }
    Some(out)
}

fn is_loopback_interface(net_sys_root: &Path, name: &str) -> bool {
    if name == "lo" {
        return true;
    }
    read_trimmed(&net_sys_root.join(name).join("type")).as_deref() == Some("772")
}

fn read_interface_up(iface_sys_dir: &Path) -> Option<bool> {
    if let Some(state) = read_trimmed(&iface_sys_dir.join("operstate")) {
        match state.as_str() {
            "up" => return Some(true),
            "down" | "lowerlayerdown" | "notpresent" | "dormant" => return Some(false),
            _ => {}
        }
    }
    match read_trimmed(&iface_sys_dir.join("carrier")).as_deref() {
        Some("1") => Some(true),
        Some("0") => Some(false),
        _ => None,
    }
}

fn parse_diskstats(
    diskstats_path: &Path,
    block_sys_root: &Path,
) -> Option<BTreeMap<String, (u64, u64)>> {
    let text = read_text(diskstats_path, DISKSTATS_LIMIT)?;
    let has_sys_block = block_sys_root.is_dir();
    let mut devices = BTreeMap::new();

    for line in text.lines() {
        let mut fields = line.split_ascii_whitespace();
        let _major = fields.next()?;
        let _minor = fields.next()?;
        let Some(name) = fields.next() else {
            continue;
        };
        if !is_single_layer_block_device(name, block_sys_root, has_sys_block) {
            continue;
        }
        // Fields after name: 0=reads, 1=reads_merged, 2=sectors_read, 3=ms_read,
        // 4=writes, 5=writes_merged, 6=sectors_written
        let Some(sectors_read) = fields.nth(2).and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        let Some(sectors_written) = fields.nth(3).and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        devices.insert(name.to_owned(), (sectors_read, sectors_written));
    }

    Some(devices)
}

fn is_single_layer_block_device(name: &str, block_sys_root: &Path, has_sys_block: bool) -> bool {
    if name.starts_with("loop")
        || name.starts_with("ram")
        || name.starts_with("zram")
        || name.starts_with("fd")
        || name.starts_with("sr")
        || name.starts_with("nbd")
    {
        return false;
    }

    if has_sys_block {
        let dev_dir = block_sys_root.join(name);
        if !dev_dir.exists() {
            return false;
        }
        // Partitions expose a `partition` attribute in sysfs; exclude to avoid double counting.
        if dev_dir.join("partition").exists() {
            return false;
        }
        // Stacked virtual devices (dm-*, md*, LUKS, LVM) list underlying block devices in `slaves`.
        // Exclude stacked layers when slaves exist so we count only the physical base layer.
        if let Ok(mut slaves) = fs::read_dir(dev_dir.join("slaves"))
            && slaves.next().is_some()
        {
            return false;
        }
        return true;
    }

    // Proc-only fallback when sysfs block hierarchy is absent.
    if name.starts_with("dm-") || name.starts_with("md") {
        return false;
    }
    !looks_like_partition_name(name)
}

fn looks_like_partition_name(name: &str) -> bool {
    if let Some(rest) = name
        .strip_prefix("nvme")
        .or_else(|| name.strip_prefix("mmcblk"))
    {
        if let Some((_, part)) = rest.rsplit_once('p') {
            return !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
        }
        return false;
    }
    if (name.starts_with("sd") || name.starts_with("vd") || name.starts_with("hd"))
        && name.len() >= 4
    {
        return name.as_bytes().last().is_some_and(u8::is_ascii_digit);
    }
    false
}

fn is_local_filesystem(fs_type: &str) -> bool {
    matches!(
        fs_type,
        "ext2"
            | "ext3"
            | "ext4"
            | "btrfs"
            | "xfs"
            | "f2fs"
            | "jfs"
            | "reiserfs"
            | "zfs"
            | "bcachefs"
            | "vfat"
            | "exfat"
            | "ntfs3"
            | "ntfs"
    )
}

fn is_user_facing_mount_point(mount_point: &str) -> bool {
    if mount_point == "/" || mount_point == "/home" {
        return true;
    }
    for prefix in [
        "/boot", "/efi", "/var", "/nix", "/snap", "/run", "/sys", "/proc", "/dev", "/tmp", "/etc",
        "/usr",
    ] {
        if mount_point == prefix || mount_point.starts_with(&format!("{prefix}/")) {
            return false;
        }
    }
    mount_point.starts_with('/')
}

fn unescape_mount_field(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\'
            && i + 3 < bytes.len()
            && bytes[i + 1..=i + 3]
                .iter()
                .all(|b| (b'0'..=b'7').contains(b))
        {
            let octal =
                ((bytes[i + 1] - b'0') << 6) | ((bytes[i + 2] - b'0') << 3) | (bytes[i + 3] - b'0');
            out.push(octal);
            i += 4;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn collect_mounts(
    mounts_path: &Path,
    stat_provider: &(dyn Fn(&Path) -> Option<MountStat> + Send),
) -> Vec<MountInfo> {
    let Some(text) = read_text(mounts_path, MOUNTS_LIMIT) else {
        return Vec::new();
    };

    let mut candidates: Vec<(String, String, String)> = Vec::new();
    for line in text.lines() {
        let mut fields = line.split_ascii_whitespace();
        let (Some(raw_dev), Some(raw_mp), Some(fs_type)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if !is_local_filesystem(fs_type) {
            continue;
        }
        let mount_point = unescape_mount_field(raw_mp);
        if !is_user_facing_mount_point(&mount_point) {
            continue;
        }
        let device = unescape_mount_field(raw_dev);
        candidates.push((device, mount_point, fs_type.to_owned()));
    }

    candidates.sort_by(|a, b| {
        mount_priority(&a.1)
            .cmp(&mount_priority(&b.1))
            .then_with(|| a.1.cmp(&b.1))
    });

    let mut seen_mount_points: Vec<String> = Vec::new();
    let mut seen_fsids: Vec<u64> = Vec::new();
    let mut seen_dev_totals: Vec<(String, u64)> = Vec::new();
    let mut mounts = Vec::new();

    for (raw_device, mount_point, fs_type) in candidates {
        if mounts.len() >= MAX_MOUNTS {
            break;
        }
        if seen_mount_points.contains(&mount_point) {
            continue;
        }
        let Some(stat) = stat_provider(Path::new(&mount_point)) else {
            continue;
        };
        if stat.total_bytes == 0 || stat.available_bytes > stat.total_bytes {
            continue;
        }
        if let Some(fsid) = stat.filesystem_id.filter(|&id| id != 0)
            && seen_fsids.contains(&fsid)
        {
            continue;
        }
        let short_device = raw_device
            .strip_prefix("/dev/")
            .unwrap_or(&raw_device)
            .to_owned();
        if seen_dev_totals
            .iter()
            .any(|(dev, total)| dev == &short_device && *total == stat.total_bytes)
        {
            continue;
        }

        seen_mount_points.push(mount_point.clone());
        if let Some(fsid) = stat.filesystem_id.filter(|&id| id != 0) {
            seen_fsids.push(fsid);
        }
        seen_dev_totals.push((short_device.clone(), stat.total_bytes));

        mounts.push(MountInfo {
            mount_point,
            device: short_device,
            fs_type,
            total_bytes: stat.total_bytes,
            available_bytes: stat.available_bytes,
            used_bytes: stat.total_bytes - stat.available_bytes,
        });
    }

    mounts
}

fn mount_priority(mount_point: &str) -> u8 {
    match mount_point {
        "/" => 0,
        "/home" => 1,
        _ => 2,
    }
}

fn live_statvfs(mount_point: &Path) -> Option<MountStat> {
    let stat = rustix::fs::statvfs(mount_point).ok()?;
    let block_size = if stat.f_frsize > 0 {
        stat.f_frsize
    } else {
        stat.f_bsize
    };
    let total_bytes = stat.f_blocks.checked_mul(block_size)?;
    let available_bytes = stat.f_bavail.checked_mul(block_size)?;
    Some(MountStat {
        total_bytes,
        available_bytes,
        filesystem_id: (stat.f_fsid != 0).then_some(stat.f_fsid),
    })
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

fn read_trimmed(path: &Path) -> Option<String> {
    let text = read_text(path, SMALL_ATTR_LIMIT)?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

fn snapshot_available(sampler: &Sampler, snapshot: &Snapshot) -> bool {
    sampler.has_cpu_baseline()
        || snapshot.cpu_usage_percent.is_some()
        || snapshot.memory.is_some()
        || !snapshot.temperatures.is_empty()
        || snapshot.cpu.is_some()
        || snapshot.swap.is_some()
        || !snapshot.gpus.is_empty()
        || snapshot.network.is_some()
        || snapshot.storage.is_some()
        || !snapshot.sensors.is_empty()
}

pub(crate) fn install(hub: &BusHub, proc_root: PathBuf, sys_root: PathBuf) -> JoinHandle<()> {
    let mut topic = Topic::new(hub, "system.telemetry", Snapshot::default());
    let mut sampler = Sampler::new(&proc_root, &sys_root);
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
            let available = snapshot_available(&sampler, &snapshot);
            topic.update(snapshot, available);
        }
    })
}
