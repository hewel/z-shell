use std::fs;
use std::os::unix::fs::symlink;
use z_shell_system::telemetry::Sampler;

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
}
