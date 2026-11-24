#[allow(dead_code)]
mod common;

use common::{client, fixture, receive, subscribe};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;
use std::time::{Duration, Instant};
use z_shell_bus::BusLimits;
use z_shell_protocol::{
    MAX_FRAME_BYTES, RequestId, ServerMessage, TopicName, TopicSnapshot, TopicUpdate, encode_line,
    methods,
};
use z_shell_system::telemetry::{MountStat, Sampler, ThermalCategory};
use z_shell_system::{SystemBusAddress, SystemOptions, SystemServices};

#[test]
fn samples_cpu_deltas_memory_and_ordered_thermal_zones() {
    let roots = tempfile::tempdir().unwrap();
    let proc_root = roots.path().join("proc");
    let sys_root = roots.path().join("sys");
    fs::create_dir(&proc_root).unwrap();
    let stat = proc_root.join("stat");
    fs::write(&stat, "cpu 100 20 30 800 40 5 5 0 10 2\ncpu0 0 0 0 0\n").unwrap();
    fs::write(
        proc_root.join("meminfo"),
        "MemTotal: 1024 kB\nMemFree: 5 kB\nMemAvailable: 256 kB\n",
    )
    .unwrap();
    for (id, kind, temperature) in [
        (10, "battery", "-1500"),
        (2, "cpu", "48123"),
        (3, "invalid", "bad reading"),
    ] {
        let zone = sys_root.join(format!("class/thermal/thermal_zone{id}"));
        fs::create_dir_all(&zone).unwrap();
        fs::write(zone.join("type"), kind).unwrap();
        fs::write(zone.join("temp"), temperature).unwrap();
    }
    let thermal = sys_root.join("class/thermal");
    let device_zone = sys_root.join("devices/thermal_zone2");
    fs::create_dir_all(device_zone.parent().unwrap()).unwrap();
    fs::rename(thermal.join("thermal_zone2"), &device_zone).unwrap();
    symlink(device_zone, thermal.join("thermal_zone2")).unwrap();

    let mut sampler = Sampler::new(&proc_root, &sys_root);
    let first = sampler.sample();
    assert_eq!(
        first.cpu_usage_percent, None,
        "no interval on the first read"
    );
    let memory = first.memory.unwrap();
    assert_eq!(memory.total_bytes, 1_048_576);
    assert_eq!(memory.available_bytes, 262_144);
    assert_eq!(memory.used_bytes, 786_432);
    let zones: Vec<_> = first
        .temperatures
        .iter()
        .map(|zone| (zone.zone, zone.kind.as_str(), zone.temperature_millicelsius))
        .collect();
    assert_eq!(zones, [(2, "cpu", 48_123), (10, "battery", -1_500)]);

    fs::write(&stat, "cpu 160 30 50 890 50 10 8 2 50 10\n").unwrap();
    assert_eq!(sampler.sample().cpu_usage_percent, Some(50.0));
    assert_eq!(sampler.sample().cpu_usage_percent, None, "zero tick delta");

    fs::write(&stat, "cpu 159 30 50 900 50 10 8 2 50 10\n").unwrap();
    assert_eq!(sampler.sample().cpu_usage_percent, None, "counter reset");
    fs::write(&stat, "cpu 169 30 50 910 50 10 8 2 50 10\n").unwrap();
    assert_eq!(sampler.sample().cpu_usage_percent, Some(50.0));

    fs::remove_file(&stat).unwrap();
    assert_eq!(sampler.sample().cpu_usage_percent, None);
    fs::write(&stat, "cpu 170 30 50 910 50 10 8 2 50 10\n").unwrap();
    assert_eq!(
        sampler.sample().cpu_usage_percent,
        None,
        "no delta across a gap"
    );
}

#[test]
fn absent_sources_leave_metrics_unknown() {
    let root = tempfile::tempdir().unwrap();
    let snapshot = Sampler::new(&root.path().join("proc"), &root.path().join("sys")).sample();
    assert_eq!(snapshot.cpu_usage_percent, None);
    assert!(snapshot.memory.is_none());
    assert!(snapshot.temperatures.is_empty());
    assert_eq!(snapshot.poll_interval_ms, None);
    assert!(snapshot.cpu.is_none());
    assert!(snapshot.swap.is_none());
    assert!(snapshot.gpus.is_empty());
    assert!(snapshot.network.is_none());
    assert!(snapshot.storage.is_none());
    assert!(snapshot.sensors.is_empty());
    assert!(snapshot.history.is_none());
}

#[test]
fn samples_per_core_cpu_freq_model_load_uptime_and_cpuinfo_fallback() {
    let roots = tempfile::tempdir().unwrap();
    let proc_root = roots.path().join("proc");
    let sys_root = roots.path().join("sys");
    fs::create_dir_all(&proc_root).unwrap();
    fs::write(
        proc_root.join("stat"),
        "cpu 100 0 0 900 0 0 0 0\ncpu0 50 0 0 450 0 0 0 0\ncpu1 50 0 0 450 0 0 0 0\n",
    )
    .unwrap();
    fs::write(
        proc_root.join("cpuinfo"),
        "processor\t: 0\nmodel name\t: AMD Ryzen 7 7840U\ncpu MHz\t\t: 3200.5\n\nprocessor\t: 1\nmodel name\t: AMD Ryzen 7 7840U\ncpu MHz\t\t: 3600.5\n",
    )
    .unwrap();
    fs::write(proc_root.join("loadavg"), "1.42 1.18 0.96 2/512 1234\n").unwrap();
    fs::write(proc_root.join("uptime"), "15480.75 98765.00\n").unwrap();

    let t0 = Instant::now();
    let mut sampler = Sampler::new(&proc_root, &sys_root);
    let s1 = sampler.sample_at(t0);
    let cpu1 = s1.cpu.as_ref().unwrap();
    assert_eq!(cpu1.core_count, 2);
    assert_eq!(cpu1.per_core_usage_percent, vec![None, None]);
    assert_eq!(cpu1.frequency_mhz, Some(3401));
    assert_eq!(cpu1.model_name.as_deref(), Some("AMD Ryzen 7 7840U"));
    assert_eq!(cpu1.load_average, Some([1.42, 1.18, 0.96]));
    assert_eq!(cpu1.uptime_seconds, Some(15480));

    // Add cpufreq sysfs (preferred over cpuinfo) and advance CPU ticks; reset cpu1 to test gap.
    for (core, khz) in [(0, "3800000"), (1, "4000000")] {
        let dir = sys_root.join(format!("devices/system/cpu/cpu{core}/cpufreq"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("scaling_cur_freq"), khz).unwrap();
    }
    // Remove cpuinfo to prove model_name stays cached.
    fs::remove_file(proc_root.join("cpuinfo")).unwrap();
    fs::write(
        proc_root.join("stat"),
        "cpu 160 0 0 940 0 0 0 0\ncpu0 90 0 0 460 0 0 0 0\ncpu1 40 0 0 460 0 0 0 0\n",
    )
    .unwrap();

    let s2 = sampler.sample_at(t0 + Duration::from_secs(1));
    let cpu2 = s2.cpu.as_ref().unwrap();
    assert_eq!(s2.cpu_usage_percent, Some(60.0));
    assert_eq!(cpu2.per_core_usage_percent, vec![Some(80.0), None]);
    assert_eq!(cpu2.frequency_mhz, Some(3900));
    assert_eq!(cpu2.model_name.as_deref(), Some("AMD Ryzen 7 7840U"));
}

#[test]
fn memory_optional_fields_and_swap_never_invalidate_valid_memory() {
    let roots = tempfile::tempdir().unwrap();
    let proc_root = roots.path().join("proc");
    let sys_root = roots.path().join("sys");
    fs::create_dir_all(&proc_root).unwrap();

    // Malformed Cached/Buffers/Swap must NOT drop valid MemTotal/MemAvailable.
    fs::write(
        proc_root.join("meminfo"),
        "MemTotal:       32768 kB\nMemAvailable:   20480 kB\nCached:         corrupt\nBuffers:        512 MB\nSReclaimable:   1024 kB\nSwapTotal:      bad kB\nSwapFree:       1024 kB\n",
    )
    .unwrap();
    let mut sampler = Sampler::new(&proc_root, &sys_root);
    let s1 = sampler.sample();
    let mem1 = s1
        .memory
        .expect("valid memory must survive bad optional fields");
    assert_eq!(mem1.total_bytes, 32_768 * 1024);
    assert_eq!(mem1.available_bytes, 20_480 * 1024);
    assert_eq!(mem1.used_bytes, 12_288 * 1024);
    assert_eq!(mem1.cached_bytes, None);
    assert_eq!(mem1.buffers_bytes, None);
    assert_eq!(mem1.reclaimable_bytes, Some(1024 * 1024));
    assert_eq!(s1.swap, None);

    // Valid Cached/Buffers/SReclaimable/Swap
    fs::write(
        proc_root.join("meminfo"),
        "MemTotal:       32768 kB\nMemAvailable:   20480 kB\nCached:         4096 kB\nBuffers:        512 kB\nSReclaimable:   1024 kB\nSwapTotal:      8192 kB\nSwapFree:       7168 kB\n",
    )
    .unwrap();
    let s2 = sampler.sample();
    let mem2 = s2.memory.unwrap();
    assert_eq!(mem2.cached_bytes, Some(4096 * 1024));
    assert_eq!(mem2.buffers_bytes, Some(512 * 1024));
    assert_eq!(mem2.reclaimable_bytes, Some(1024 * 1024));
    let swap = s2.swap.unwrap();
    assert_eq!(swap.total_bytes, 8192 * 1024);
    assert_eq!(swap.free_bytes, 7168 * 1024);
    assert_eq!(swap.used_bytes, 1024 * 1024);
}

#[test]
fn multi_gpu_drm_hwmon_stable_order_and_partial_telemetry_retention() {
    let roots = tempfile::tempdir().unwrap();
    let proc_root = roots.path().join("proc");
    let sys_root = roots.path().join("sys");
    fs::create_dir_all(&proc_root).unwrap();

    // Connector entry must be ignored.
    fs::create_dir_all(sys_root.join("class/drm/card0-DP-1")).unwrap();

    // card1: has NO gpu_busy_percent, but has VRAM and temp -> must still be retained!
    let card1_dev = sys_root.join("class/drm/card1/device");
    fs::create_dir_all(card1_dev.join("hwmon/hwmon3")).unwrap();
    fs::write(
        card1_dev.join("uevent"),
        "DRIVER=i915\nPCI_SLOT_NAME=0000:00:02.0\n",
    )
    .unwrap();
    fs::write(card1_dev.join("mem_info_vram_used"), "536870912\n").unwrap();
    fs::write(card1_dev.join("mem_info_vram_total"), "4294967296\n").unwrap();
    fs::write(card1_dev.join("hwmon/hwmon3/temp1_input"), "41000\n").unwrap();

    // card0: symlinked device + driver, full AMDGPU metrics
    let real_card0_dev = sys_root.join("devices/pci0000:c1/0000:c1:00.0");
    let driver_dir = sys_root.join("bus/pci/drivers/amdgpu");
    fs::create_dir_all(real_card0_dev.join("hwmon/hwmon1")).unwrap();
    fs::create_dir_all(&driver_dir).unwrap();
    symlink(&driver_dir, real_card0_dev.join("driver")).unwrap();
    fs::write(
        real_card0_dev.join("uevent"),
        "PCI_SLOT_NAME=0000:c1:00.0\n",
    )
    .unwrap();
    fs::write(real_card0_dev.join("product_name"), "Radeon 780M\n").unwrap();
    fs::write(real_card0_dev.join("gpu_busy_percent"), "18\n").unwrap();
    fs::write(real_card0_dev.join("mem_info_vram_used"), "2147483648\n").unwrap();
    fs::write(real_card0_dev.join("mem_info_vram_total"), "12884901888\n").unwrap();
    fs::write(
        real_card0_dev.join("pp_dpm_sclk"),
        "0: 800Mhz\n1: 1450Mhz *\n2: 2700Mhz\n",
    )
    .unwrap();
    fs::write(real_card0_dev.join("hwmon/hwmon1/temp1_label"), "edge\n").unwrap();
    fs::write(real_card0_dev.join("hwmon/hwmon1/temp1_input"), "46000\n").unwrap();
    fs::write(
        real_card0_dev.join("hwmon/hwmon1/power1_average"),
        "14200000\n",
    )
    .unwrap();
    fs::create_dir_all(sys_root.join("class/drm/card0")).unwrap();
    symlink(&real_card0_dev, sys_root.join("class/drm/card0/device")).unwrap();

    let t0 = Instant::now();
    let mut sampler = Sampler::new(&proc_root, &sys_root);
    let s1 = sampler.sample_at(t0);
    assert_eq!(s1.gpus.len(), 2);
    assert_eq!(s1.gpus[0].id, "card0");
    assert_eq!(s1.gpus[0].name.as_deref(), Some("Radeon 780M"));
    assert_eq!(s1.gpus[0].driver.as_deref(), Some("amdgpu"));
    assert_eq!(s1.gpus[0].utilization_percent, Some(18.0));
    assert_eq!(s1.gpus[0].vram_used_bytes, Some(2_147_483_648));
    assert_eq!(s1.gpus[0].vram_total_bytes, Some(12_884_901_888));
    assert_eq!(s1.gpus[0].temperature_millicelsius, Some(46_000));
    assert_eq!(s1.gpus[0].power_milliwatts, Some(14_200));
    assert_eq!(s1.gpus[0].clock_mhz, Some(1450));

    assert_eq!(s1.gpus[1].id, "card1");
    assert_eq!(s1.gpus[1].driver.as_deref(), Some("i915"));
    assert_eq!(s1.gpus[1].utilization_percent, None);
    assert_eq!(s1.gpus[1].vram_total_bytes, Some(4_294_967_296));
    assert_eq!(s1.gpus[1].temperature_millicelsius, Some(41_000));

    // Remove card0 and give card1 a busy percentage -> primary GPU switches to card1,
    // which must emit a None gap on the transition bucket in gpu_percent history.
    fs::remove_dir_all(sys_root.join("class/drm/card0")).unwrap();
    fs::write(card1_dev.join("gpu_busy_percent"), "55\n").unwrap();
    let s2 = sampler.sample_at(t0 + Duration::from_secs(1));
    assert_eq!(s2.gpus.len(), 1);
    assert_eq!(s2.gpus[0].id, "card1");
    let gpu_hist = &s2.history.as_ref().unwrap().window_60s.gpu_percent;
    assert_eq!(gpu_hist, &vec![Some(18.0), None]);

    let s3 = sampler.sample_at(t0 + Duration::from_secs(2));
    assert_eq!(
        s3.history.as_ref().unwrap().window_60s.gpu_percent,
        vec![Some(18.0), None, Some(55.0)]
    );
}

#[test]
fn network_excludes_loopback_tracks_per_interface_sessions_and_handles_switch_and_reset() {
    let roots = tempfile::tempdir().unwrap();
    let proc_root = roots.path().join("proc");
    let sys_root = roots.path().join("sys");
    fs::create_dir_all(proc_root.join("net")).unwrap();
    for (iface, state, typ) in [
        ("lo", "unknown", "772"),
        ("enp4s0", "up", "1"),
        ("wlan0", "up", "1"),
    ] {
        let dir = sys_root.join(format!("class/net/{iface}"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("operstate"), state).unwrap();
        fs::write(dir.join("type"), typ).unwrap();
    }

    let write_net = |enp_rx: u64, enp_tx: u64, wlan_rx: u64, wlan_tx: u64| {
        fs::write(
            proc_root.join("net/dev"),
            format!(
                "Inter-|   Receive                                                |  Transmit\n\
                 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n\
                   lo: 999999 10 0 0 0 0 0 0 999999 10 0 0 0 0 0 0\n\
               enp4s0: {enp_rx} 10 0 0 0 0 0 0 {enp_tx} 10 0 0 0 0 0 0\n\
                wlan0: {wlan_rx} 10 0 0 0 0 0 0 {wlan_tx} 10 0 0 0 0 0 0\n"
            ),
        )
        .unwrap();
    };

    let t0 = Instant::now();
    let mut sampler = Sampler::new(&proc_root, &sys_root);

    write_net(10_000, 2_000, 5_000, 1_000);
    let s1 = sampler.sample_at(t0);
    let n1 = s1.network.as_ref().unwrap();
    assert_eq!(n1.interfaces.len(), 2, "lo must be excluded");
    assert_eq!(n1.rx_bytes_per_sec, None);
    assert_eq!(n1.session_rx_bytes, 0);

    // enp4s0 gets +4000 RX, +1000 TX in 1s; wlan0 gets +500 RX, +200 TX
    write_net(14_000, 3_000, 5_500, 1_200);
    let s2 = sampler.sample_at(t0 + Duration::from_secs(1));
    let n2 = s2.network.as_ref().unwrap();
    assert_eq!(n2.active_interface.as_deref(), Some("enp4s0"));
    assert_eq!(n2.rx_bytes_per_sec, Some(4_000));
    assert_eq!(n2.tx_bytes_per_sec, Some(1_000));
    assert_eq!(n2.session_rx_bytes, 4_000);
    assert_eq!(n2.session_tx_bytes, 1_000);

    // Switch active traffic to wlan0 (enp4s0 goes down) -> session totals must NOT mix enp4s0's bytes!
    fs::write(sys_root.join("class/net/enp4s0/operstate"), "down").unwrap();
    write_net(14_000, 3_000, 15_500, 3_200);
    let s3 = sampler.sample_at(t0 + Duration::from_secs(2));
    let n3 = s3.network.as_ref().unwrap();
    assert_eq!(n3.active_interface.as_deref(), Some("wlan0"));
    assert_eq!(n3.rx_bytes_per_sec, Some(10_000));
    assert_eq!(n3.session_rx_bytes, 10_500, "wlan0 own session total only");
    assert_eq!(n3.session_tx_bytes, 2_200, "wlan0 own session total only");
    // Interface switch must emit None gap in net_rx history on the transition bucket.
    assert_eq!(
        s3.history.as_ref().unwrap().window_60s.net_rx_bytes_per_sec,
        vec![None, Some(4_000), None]
    );

    // Counter reset on wlan0 must yield None rate and keep session totals untouched.
    write_net(14_000, 3_000, 100, 50);
    let s4 = sampler.sample_at(t0 + Duration::from_secs(3));
    let n4 = s4.network.as_ref().unwrap();
    assert_eq!(n4.rx_bytes_per_sec, None);
    assert_eq!(n4.tx_bytes_per_sec, None);
    assert_eq!(n4.session_rx_bytes, 10_500);
    assert_eq!(n4.session_tx_bytes, 2_200);
}

#[test]
fn disk_io_single_layer_excludes_partitions_and_stacked_dm_md_devices() {
    let roots = tempfile::tempdir().unwrap();
    let proc_root = roots.path().join("proc");
    let sys_root = roots.path().join("sys");
    fs::create_dir_all(&proc_root).unwrap();

    // Base physical drive: nvme0n1 (no partition, empty slaves)
    fs::create_dir_all(sys_root.join("class/block/nvme0n1/slaves")).unwrap();
    // Partition: nvme0n1p2 (has partition file)
    fs::create_dir_all(sys_root.join("class/block/nvme0n1p2")).unwrap();
    fs::write(sys_root.join("class/block/nvme0n1p2/partition"), "2\n").unwrap();
    // LVM/LUKS dm-0 stacked on nvme0n1p2 (non-empty slaves)
    fs::create_dir_all(sys_root.join("class/block/dm-0/slaves")).unwrap();
    fs::write(sys_root.join("class/block/dm-0/slaves/nvme0n1p2"), "").unwrap();
    // RAID md0 stacked on sda (non-empty slaves)
    fs::create_dir_all(sys_root.join("class/block/md0/slaves")).unwrap();
    fs::write(sys_root.join("class/block/md0/slaves/sda"), "").unwrap();
    // Virtual devices
    fs::create_dir_all(sys_root.join("class/block/loop0")).unwrap();
    fs::create_dir_all(sys_root.join("class/block/zram0")).unwrap();

    let write_diskstats = |base_r: u64, base_w: u64| {
        // Every layer mirrors the same sectors to prove stacked/partition layers aren't double-counted.
        let line = |maj: u32, min: u32, name: &str, r: u64, w: u64| {
            format!("{maj} {min} {name} 10 0 {r} 10 10 0 {w} 10 0 0 0\n")
        };
        let mut content = String::new();
        content.push_str(&line(259, 0, "nvme0n1", base_r, base_w));
        content.push_str(&line(259, 2, "nvme0n1p2", base_r, base_w));
        content.push_str(&line(253, 0, "dm-0", base_r, base_w));
        content.push_str(&line(9, 0, "md0", base_r, base_w));
        content.push_str(&line(7, 0, "loop0", base_r * 5, base_w * 5));
        content.push_str(&line(252, 0, "zram0", base_r * 5, base_w * 5));
        fs::write(proc_root.join("diskstats"), content).unwrap();
    };

    let t0 = Instant::now();
    let mut sampler = Sampler::new(&proc_root, &sys_root);
    write_diskstats(1000, 2000);
    let s1 = sampler.sample_at(t0);
    assert_eq!(s1.storage.as_ref().unwrap().read_bytes_per_sec, None);

    // +200 sectors read (102_400 B), +100 sectors written (51_200 B) over 1s
    write_diskstats(1200, 2100);
    let s2 = sampler.sample_at(t0 + Duration::from_secs(1));
    let st2 = s2.storage.as_ref().unwrap();
    assert_eq!(st2.read_bytes_per_sec, Some(102_400));
    assert_eq!(st2.write_bytes_per_sec, Some(51_200));

    // Counter reset -> None gap
    write_diskstats(50, 50);
    let s3 = sampler.sample_at(t0 + Duration::from_secs(2));
    let st3 = s3.storage.as_ref().unwrap();
    assert_eq!(st3.read_bytes_per_sec, None);
    assert_eq!(st3.write_bytes_per_sec, None);
}

#[test]
fn mounts_are_isolated_local_only_and_deduplicate_shared_home_capacity() {
    let roots = tempfile::tempdir().unwrap();
    let proc_root = roots.path().join("proc");
    let sys_root = roots.path().join("sys");
    fs::create_dir_all(&proc_root).unwrap();

    fs::write(
        proc_root.join("mounts"),
        "/dev/nvme0n1p2 / btrfs rw,subvol=/@ 0 0\n\
         /dev/nvme0n1p2 /home btrfs rw,subvol=/@home 0 0\n\
         /dev/nvme0n1p1 /boot/efi vfat rw 0 0\n\
         server:/share /mnt/nfs nfs4 rw 0 0\n\
         sshfs#host:/ /mnt/remote fuse.sshfs rw 0 0\n\
         systemd-1 /mnt/auto autofs rw 0 0\n\
         tmpfs /tmp tmpfs rw 0 0\n\
         /dev/sda1 /mnt/data ext4 rw 0 0\n",
    )
    .unwrap();

    // Without an injected provider, isolated roots must NEVER touch host statvfs.
    let mut isolated = Sampler::new(&proc_root, &sys_root);
    let s_isolated = isolated.sample();
    assert!(
        s_isolated.storage.is_none(),
        "isolated Sampler::new must not query host mounts"
    );

    // With injected provider: /home shares fsid with / -> deduplicated; remote/FUSE/autofs/boot excluded.
    let mut injected = Sampler::new(&proc_root, &sys_root).with_mount_stat_provider(|mp: &Path| {
        match mp.to_str()? {
            "/" | "/home" => Some(MountStat {
                total_bytes: 1_000_000_000_000,
                available_bytes: 360_000_000_000,
                filesystem_id: Some(42),
            }),
            "/mnt/data" => Some(MountStat {
                total_bytes: 2_000_000_000_000,
                available_bytes: 1_200_000_000_000,
                filesystem_id: Some(99),
            }),
            other => panic!("unexpected statvfs query on non-whitelisted mount: {other}"),
        }
    });

    let snap = injected.sample();
    let mounts = &snap.storage.as_ref().unwrap().mounts;
    assert_eq!(mounts.len(), 2);
    assert_eq!(mounts[0].mount_point, "/");
    assert_eq!(mounts[0].device, "nvme0n1p2");
    assert_eq!(mounts[0].used_bytes, 640_000_000_000);
    assert_eq!(mounts[1].mount_point, "/mnt/data");
    assert_eq!(mounts[1].device, "sda1");

    // Distinct /home device & fsid must NOT be deduplicated.
    fs::write(
        proc_root.join("mounts"),
        "/dev/nvme0n1p2 / ext4 rw 0 0\n/dev/nvme0n1p3 /home ext4 rw 0 0\n",
    )
    .unwrap();
    let mut distinct = Sampler::new(&proc_root, &sys_root).with_mount_stat_provider(|mp: &Path| {
        match mp.to_str()? {
            "/" => Some(MountStat {
                total_bytes: 500_000_000_000,
                available_bytes: 200_000_000_000,
                filesystem_id: Some(10),
            }),
            "/home" => Some(MountStat {
                total_bytes: 1_000_000_000_000,
                available_bytes: 580_000_000_000,
                filesystem_id: Some(11),
            }),
            _ => None,
        }
    });
    let snap2 = distinct.sample();
    let mounts2 = &snap2.storage.as_ref().unwrap().mounts;
    assert_eq!(mounts2.len(), 2);
    assert_eq!(mounts2[0].mount_point, "/");
    assert_eq!(mounts2[1].mount_point, "/home");
}

#[test]
fn sensors_merge_hwmon_and_thermal_zone_with_friendly_labels() {
    let roots = tempfile::tempdir().unwrap();
    let proc_root = roots.path().join("proc");
    let sys_root = roots.path().join("sys");
    fs::create_dir_all(&proc_root).unwrap();

    // hwmon0: k10temp (Tctl preferred over Tccd1)
    let hw0 = sys_root.join("class/hwmon/hwmon0");
    fs::create_dir_all(&hw0).unwrap();
    fs::write(hw0.join("name"), "k10temp\n").unwrap();
    fs::write(hw0.join("temp1_label"), "Tccd1\n").unwrap();
    fs::write(hw0.join("temp1_input"), "49000\n").unwrap();
    fs::write(hw0.join("temp2_label"), "Tctl\n").unwrap();
    fs::write(hw0.join("temp2_input"), "52500\n").unwrap();

    // hwmon1: nvme
    let hw1 = sys_root.join("class/hwmon/hwmon1");
    fs::create_dir_all(&hw1).unwrap();
    fs::write(hw1.join("name"), "nvme\n").unwrap();
    fs::write(hw1.join("temp1_label"), "Composite\n").unwrap();
    fs::write(hw1.join("temp1_input"), "38000\n").unwrap();

    // thermal_zone0: x86_pkg_temp (lower priority than hwmon CPU), thermal_zone1: battery
    for (id, kind, temp) in [(0, "x86_pkg_temp", "50000"), (1, "battery", "31000")] {
        let z = sys_root.join(format!("class/thermal/thermal_zone{id}"));
        fs::create_dir_all(&z).unwrap();
        fs::write(z.join("type"), kind).unwrap();
        fs::write(z.join("temp"), temp).unwrap();
    }

    let snap = Sampler::new(&proc_root, &sys_root).sample();
    assert_eq!(snap.temperatures.len(), 2);
    let mapped: Vec<_> = snap
        .sensors
        .iter()
        .map(|s| (s.label.as_str(), s.category, s.temperature_millicelsius))
        .collect();
    assert_eq!(
        mapped,
        vec![
            ("CPU", ThermalCategory::Cpu, 52_500),
            ("NVMe", ThermalCategory::Nvme, 38_000),
            ("Battery", ThermalCategory::Battery, 31_000),
        ]
    );
}

#[test]
fn timestamp_bucketing_handles_missed_ticks_and_suspend_resume_gaps() {
    let roots = tempfile::tempdir().unwrap();
    let proc_root = roots.path().join("proc");
    let sys_root = roots.path().join("sys");
    fs::create_dir_all(&proc_root).unwrap();

    let stat = proc_root.join("stat");
    let t0 = Instant::now();
    let mut sampler = Sampler::new(&proc_root, &sys_root);

    // 10 consecutive 1s samples (t=0..=9), 50% CPU on t=1..=9
    let mut busy = 0_u64;
    let mut idle = 0_u64;
    for sec in 0..=9 {
        fs::write(&stat, format!("cpu {busy} 0 0 {idle} 0 0 0 0\n")).unwrap();
        let _ = sampler.sample_at(t0 + Duration::from_secs(sec));
        busy += 50;
        idle += 50;
    }

    // Simulate 120s suspend/resume jump (t=9 -> t=129)
    busy += 6000;
    idle += 6000;
    fs::write(&stat, format!("cpu {busy} 0 0 {idle} 0 0 0 0\n")).unwrap();
    let resume = sampler.sample_at(t0 + Duration::from_secs(129));
    assert_eq!(
        resume.cpu_usage_percent, None,
        "resume tick after suspend must not smear delta across sleep"
    );
    let hist_resume = resume.history.as_ref().unwrap();
    // 60s window evicted t=0..=9 (older than 129-59=70); only bucket 129 remains with None.
    assert_eq!(hist_resume.window_60s.cpu_percent, vec![None]);
    // 5m window (5s buckets): t=0..=9 occupied buckets 0 and 1; t=129 is bucket 25 -> 26 slots with explicit None gaps!
    assert_eq!(hist_resume.window_5m.cpu_percent.len(), 26);
    assert_eq!(hist_resume.window_5m.cpu_percent[0], Some(50.0));
    assert_eq!(hist_resume.window_5m.cpu_percent[1], Some(50.0));
    assert!(
        hist_resume.window_5m.cpu_percent[2..25]
            .iter()
            .all(Option::is_none),
        "suspend gap buckets must be None, never zero"
    );
    assert_eq!(hist_resume.window_5m.cpu_percent[25], None);

    // Next normal 1s tick after resume (t=130) recovers cleanly at 80% CPU.
    busy += 80;
    idle += 20;
    fs::write(&stat, format!("cpu {busy} 0 0 {idle} 0 0 0 0\n")).unwrap();
    let recovered = sampler.sample_at(t0 + Duration::from_secs(130));
    assert_eq!(recovered.cpu_usage_percent, Some(80.0));
    assert_eq!(
        recovered.history.as_ref().unwrap().window_60s.cpu_percent,
        vec![None, Some(80.0)]
    );
}

#[tokio::test]
async fn new_source_only_triggers_initial_source_baseline() {
    let dir = tempfile::tempdir().unwrap();
    let (paths, hub) = fixture(&dir);
    let proc_root = dir.path().join("proc");
    let sys_root = dir.path().join("sys");

    let _handle = SystemServices::install_with_options(
        &hub,
        &paths,
        SystemOptions {
            pulse: None,
            system_bus: SystemBusAddress::Disabled,
            proc_root: proc_root.clone(),
            sys_root: sys_root.clone(),
            backlight_root: dir.path().join("backlight"),
        },
    );

    let (id, out) = client(&hub).await;
    let initial = subscribe(&hub, id, &out, "system.telemetry").await;
    assert_eq!(initial["cpu_usage_percent"], json!(null));
    assert!(initial.get("poll_interval_ms").is_none());

    // Provide ONLY a new telemetry source (uptime, no legacy stat/meminfo/thermal_zone).
    fs::create_dir_all(&proc_root).unwrap();
    fs::write(proc_root.join("uptime"), "3600.0 7200.0\n").unwrap();

    let ServerMessage::Notification { params, .. } = receive(&out).await else {
        panic!("expected topic.update for new telemetry source");
    };
    assert_eq!(params["topic"], "system.telemetry");
    assert_eq!(
        params["source_baseline"], true,
        "new-only telemetry source must emit initial SourceBaseline"
    );
    assert_eq!(params["data"]["cpu"]["uptime_seconds"], 3600);
    assert_eq!(params["data"]["poll_interval_ms"], 1000);
}

#[test]
fn high_load_full_15m_snapshot_and_update_stay_within_bus_frame_budget() {
    let roots = tempfile::tempdir().unwrap();
    let proc_root = roots.path().join("proc");
    let sys_root = roots.path().join("sys");
    fs::create_dir_all(proc_root.join("net")).unwrap();

    // 64 CPU cores + cpufreq + cpuinfo + loadavg + uptime + meminfo
    let write_stat = |step: u64| {
        let mut s = format!(
            "cpu {} 0 {} {} 0 0 0 0\n",
            step * 400,
            step * 100,
            step * 500
        );
        for core in 0..64_u64 {
            let busy = step * (20 + (core % 50));
            let idle = step * (100 - (20 + (core % 50)));
            s.push_str(&format!("cpu{core} {busy} 0 0 {idle} 0 0 0 0\n"));
        }
        fs::write(proc_root.join("stat"), s).unwrap();
    };
    for core in 0..64 {
        let dir = sys_root.join(format!("devices/system/cpu/cpu{core}/cpufreq"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("scaling_cur_freq"), "3850000").unwrap();
    }
    fs::write(
        proc_root.join("cpuinfo"),
        "processor\t: 0\nmodel name\t: AMD EPYC 9554 64-Core Processor\n",
    )
    .unwrap();
    fs::write(proc_root.join("loadavg"), "12.48 11.20 10.05 8/1024 9999\n").unwrap();
    fs::write(proc_root.join("uptime"), "864000.0 9999999.0\n").unwrap();
    fs::write(
        proc_root.join("meminfo"),
        "MemTotal:       134217728 kB\nMemAvailable:   83886080 kB\nCached:         20971520 kB\nBuffers:        2097152 kB\nSReclaimable:   4194304 kB\nSwapTotal:      16777216 kB\nSwapFree:       14680064 kB\n",
    )
    .unwrap();

    // 4 GPUs
    for card in 0..4 {
        let dev = sys_root.join(format!("class/drm/card{card}/device"));
        fs::create_dir_all(dev.join("hwmon/hwmon0")).unwrap();
        fs::write(
            dev.join("uevent"),
            format!("DRIVER=amdgpu\nPCI_SLOT_NAME=0000:0{card}:00.0\n"),
        )
        .unwrap();
        fs::write(
            dev.join("product_name"),
            format!("Radeon Pro W7900 #{card}"),
        )
        .unwrap();
        fs::write(dev.join("gpu_busy_percent"), format!("{}", 20 + card * 15)).unwrap();
        fs::write(dev.join("mem_info_vram_used"), "8589934592").unwrap();
        fs::write(dev.join("mem_info_vram_total"), "48318382080").unwrap();
        fs::write(dev.join("pp_dpm_sclk"), "1: 2200Mhz *\n").unwrap();
        fs::write(dev.join("hwmon/hwmon0/temp1_input"), "62000").unwrap();
        fs::write(dev.join("hwmon/hwmon0/power1_average"), "185000000").unwrap();
    }

    // 8 NICs
    for idx in 0..8 {
        let dir = sys_root.join(format!("class/net/eth{idx}"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("operstate"), "up").unwrap();
        fs::write(dir.join("type"), "1").unwrap();
    }

    // 12 hwmon sensors + 8 thermal zones
    for idx in 0..12 {
        let dir = sys_root.join(format!("class/hwmon/hwmon{idx}"));
        fs::create_dir_all(&dir).unwrap();
        let name = match idx {
            0 => "k10temp",
            1 => "amdgpu",
            2 => "nvme",
            3 => "BAT0",
            _ => "acpi_sensor",
        };
        fs::write(dir.join("name"), format!("{name}_{idx}")).unwrap();
        fs::write(dir.join("temp1_input"), format!("{}", 35_000 + idx * 1000)).unwrap();
    }
    for id in 0..8 {
        let z = sys_root.join(format!("class/thermal/thermal_zone{id}"));
        fs::create_dir_all(&z).unwrap();
        fs::write(z.join("type"), format!("zone_kind_{id}")).unwrap();
        fs::write(z.join("temp"), format!("{}", 40_000 + id * 500)).unwrap();
    }

    // 4 physical disks + 8 local mounts
    for d in 0..4 {
        fs::create_dir_all(sys_root.join(format!("class/block/nvme{d}n1/slaves"))).unwrap();
    }
    let mut mounts_txt = String::new();
    let mut mount_stats = HashMap::new();
    let mount_paths = [
        "/", "/home", "/mnt/a", "/mnt/b", "/mnt/c", "/mnt/d", "/mnt/e", "/mnt/f",
    ];
    for (idx, mp) in mount_paths.iter().enumerate() {
        mounts_txt.push_str(&format!("/dev/nvme0n1p{} {mp} ext4 rw 0 0\n", idx + 1));
        mount_stats.insert(
            (*mp).to_owned(),
            MountStat {
                total_bytes: 2_000_000_000_000,
                available_bytes: 800_000_000_000,
                filesystem_id: Some((idx + 1) as u64),
            },
        );
    }
    fs::write(proc_root.join("mounts"), mounts_txt).unwrap();

    let t0 = Instant::now();
    let mut sampler = Sampler::new(&proc_root, &sys_root)
        .with_mount_stat_provider(move |p| p.to_str().and_then(|s| mount_stats.get(s).copied()));

    // Populate a full 15 minutes (900 seconds) of rolling history across all 3 windows (60s/5m/15m).
    let mut latest = None;
    for sec in 0..=900_u64 {
        // Sample every 5s (<= max_sample_gap) up to 840s and every 1s for the final 60s
        // so all 60 buckets in window_60s, window_5m, and window_15m are populated with live values.
        if sec < 840 && sec % 5 != 0 {
            continue;
        }
        write_stat(sec);
        let mut net = String::from("Inter-| Receive | Transmit\nface |bytes\n");
        for idx in 0..8_u64 {
            net.push_str(&format!(
                "eth{idx}: {} 1 0 0 0 0 0 0 {} 1 0 0 0 0 0 0\n",
                sec * (100_000 + idx * 10_000),
                sec * (50_000 + idx * 5_000)
            ));
        }
        fs::write(proc_root.join("net/dev"), net).unwrap();

        let mut disk = String::new();
        for d in 0..4_u64 {
            disk.push_str(&format!(
                "259 {d} nvme{d}n1 1 0 {} 1 1 0 {} 1 0 0 0\n",
                sec * 2048,
                sec * 1024
            ));
        }
        fs::write(proc_root.join("diskstats"), disk).unwrap();

        latest = Some(sampler.sample_at(t0 + Duration::from_secs(sec)));
    }

    let snapshot = latest.unwrap();
    let hist = snapshot.history.as_ref().unwrap();
    assert_eq!(hist.window_60s.cpu_percent.len(), 60);
    assert_eq!(hist.window_5m.cpu_percent.len(), 60);
    assert_eq!(hist.window_15m.cpu_percent.len(), 60);
    assert_eq!(
        snapshot.cpu.as_ref().unwrap().per_core_usage_percent.len(),
        64
    );
    assert_eq!(snapshot.gpus.len(), 4);
    assert_eq!(snapshot.network.as_ref().unwrap().interfaces.len(), 8);
    assert_eq!(snapshot.storage.as_ref().unwrap().mounts.len(), 8);

    let data = serde_json::to_value(&snapshot).unwrap();
    let topic = TopicName::try_new("system.telemetry").unwrap();

    let subscribe_frame = ServerMessage::Ok {
        id: RequestId::try_number(19).unwrap(),
        result: serde_json::to_value(TopicSnapshot {
            daemon_instance_id: "daemon-budget-check".to_owned(),
            topic_instance_id: 18,
            topic: topic.clone(),
            revision: 901,
            data: data.clone(),
        })
        .unwrap(),
    };
    let encoded_snapshot = encode_line(&subscribe_frame).unwrap();

    let update_frame = ServerMessage::Notification {
        method: methods::TOPIC_UPDATE.to_owned(),
        params: serde_json::to_value(TopicUpdate {
            daemon_instance_id: "daemon-budget-check".to_owned(),
            topic_instance_id: 18,
            topic,
            revision: 902,
            source_baseline: false,
            data,
        })
        .unwrap(),
    };
    let encoded_update = encode_line(&update_frame).unwrap();

    let limits = BusLimits::default();
    assert!(
        encoded_snapshot.len() < 32 * 1024,
        "TopicSnapshot frame too large: {} bytes (MAX_FRAME_BYTES={MAX_FRAME_BYTES})",
        encoded_snapshot.len()
    );
    assert!(
        encoded_update.len() < 32 * 1024,
        "TopicUpdate frame too large: {} bytes (MAX_FRAME_BYTES={MAX_FRAME_BYTES})",
        encoded_update.len()
    );
    // Even 60 queued telemetry updates (a full minute of backlog) must fit well inside BusLimits::max_queued_bytes.
    assert!(
        encoded_update.len() * 60 < limits.max_queued_bytes,
        "60 queued TopicUpdate frames ({} bytes) exceed max_queued_bytes ({})",
        encoded_update.len() * 60,
        limits.max_queued_bytes
    );
}
