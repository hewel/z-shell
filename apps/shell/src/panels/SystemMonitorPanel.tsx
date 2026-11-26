import { For, Show, createMemo, cx, type NativeChild } from "@hewel/zgui";
import { M3IconButton } from "@z-shell/sdk/primitives";
import { AreaLineChart } from "../charts/TelemetryCharts.tsx";
import { ShellIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import {
  PANEL_MAX_HEIGHTS,
  computeMemoryBreakdown,
  formatBytesDecimalGB,
  formatBytesShort,
  formatFrequencyMhz,
  formatPollInterval,
  formatRateBytesPerSec,
  formatUptimeCompact,
  selectHeadlineTempCelsius,
  selectNetworkDisplay,
  selectPrimaryGpu,
  selectTelemetryHistoryWindow,
} from "../topics.ts";
import styles from "./SystemMonitorPanel.module.css";

const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";

interface HardwareTileData {
  readonly id: string;
  readonly title: string;
  readonly value: string;
  readonly accentValue: boolean;
  readonly detail: string;
}

/**
 * Paper `04C · System Monitor` (`396px`) quick telemetry popover.
 * Pure hardware telemetry (no process table), gracefully omitting absent hardware and
 * hiding unverified cadence/history elements on legacy daemon snapshots.
 */
export function SystemMonitorPanel(): NativeChild {
  const { telemetry, openSystemMonitorWindow } = useShellStore();
  const snap = () => telemetry.data();

  const cpuPct = () => snap()?.cpu_usage_percent ?? null;
  const cpuPctLabel = () => (cpuPct() === null ? "—" : `${Math.round(cpuPct()!)}%`);
  const mem = createMemo(() => computeMemoryBreakdown(snap()?.memory));
  const primaryGpu = createMemo(() => selectPrimaryGpu(snap()?.gpus));
  const headlineTemp = createMemo(() => selectHeadlineTempCelsius(snap()));
  const pollLabel = createMemo(() => formatPollInterval(snap()?.poll_interval_ms));
  const history60s = createMemo(() => selectTelemetryHistoryWindow(snap(), "60s"));
  const cpuHistory = createMemo(() => {
    const win = history60s();
    return win?.cpu_percent && win.cpu_percent.length > 0 ? win.cpu_percent : null;
  });

  const subtitle = createMemo(() => {
    const parts: string[] = [];
    const load1 = snap()?.cpu?.load_average?.[0];
    if (load1 !== undefined && load1 !== null && Number.isFinite(load1)) {
      parts.push(`Load ${load1.toFixed(2)}`);
    }
    const up = formatUptimeCompact(snap()?.cpu?.uptime_seconds);
    if (up) parts.push(`Up ${up}`);
    const temp = headlineTemp();
    if (temp !== null) parts.push(`${temp}°C`);
    return parts.join(" · ") || "Hardware telemetry";
  });

  const cpuMeta = createMemo(() => {
    const parts: string[] = [];
    const cores = snap()?.cpu?.core_count;
    if (cores && cores > 0) parts.push(`${cores} cores`);
    const freq = formatFrequencyMhz(snap()?.cpu?.frequency_mhz, 1);
    if (freq) parts.push(freq);
    return parts.join(" · ");
  });

  const hardwareTiles = createMemo((): readonly HardwareTileData[] => {
    const tiles: HardwareTileData[] = [];
    const current = snap();

    const gpu = primaryGpu();
    if (gpu) {
      const gpuDetailParts: string[] = [];
      if (gpu.vram_used_bytes != null && gpu.vram_total_bytes != null && gpu.vram_total_bytes > 0) {
        const usedGb = (gpu.vram_used_bytes / 1024 ** 3).toFixed(1);
        const totalGb = Math.round(gpu.vram_total_bytes / 1024 ** 3);
        gpuDetailParts.push(`VRAM ${usedGb} / ${totalGb}G`);
      } else if (gpu.vram_total_bytes != null && gpu.vram_total_bytes > 0) {
        gpuDetailParts.push(`VRAM ${formatBytesShort(gpu.vram_total_bytes, true)}`);
      }
      if (gpu.temperature_millicelsius != null) {
        gpuDetailParts.push(`${Math.round(gpu.temperature_millicelsius / 1000)}°C`);
      } else if (gpu.clock_mhz != null) {
        gpuDetailParts.push(`${gpu.clock_mhz} MHz`);
      }
      tiles.push({
        id: "gpu",
        title: "GPU",
        value: gpu.utilization_percent != null ? `${Math.round(gpu.utilization_percent)}%` : "—",
        accentValue: gpu.utilization_percent != null,
        detail: gpuDetailParts.join(" · ") || (gpu.driver ?? gpu.id),
      });
    }

    const sensors = current?.sensors ?? [];
    const temp = headlineTemp();
    if (temp !== null || sensors.length > 0) {
      const topSensors = sensors.slice(0, 2).map(s => `${s.label} ${Math.round(s.temperature_millicelsius / 1000)}°`);
      const fallbackZones = (current?.temperatures ?? [])
        .slice(0, 2)
        .map(z => `${z.kind} ${Math.round(z.temperature_millicelsius / 1000)}°`);
      tiles.push({
        id: "thermal",
        title: "Thermal",
        value: temp !== null ? `${temp}°C` : "—",
        accentValue: false,
        detail: (topSensors.length > 0 ? topSensors : fallbackZones).join(" · ") || "Thermal zones",
      });
    }

    const netDisplay = selectNetworkDisplay(current?.network, history60s());
    if (netDisplay) {
      const rxLabel = netDisplay.rxBytesPerSec != null ? `↓ ${formatRateBytesPerSec(netDisplay.rxBytesPerSec)}` : "—";
      const detailParts: string[] = [];
      if (netDisplay.txBytesPerSec != null) detailParts.push(`↑ ${formatRateBytesPerSec(netDisplay.txBytesPerSec)}`);
      if (netDisplay.label) detailParts.push(netDisplay.label);
      tiles.push({
        id: "network",
        title: "Network",
        value: rxLabel,
        accentValue: netDisplay.rxBytesPerSec != null,
        detail: detailParts.join(" · ") || "Waiting for interval",
      });
    }

    const storage = current?.storage;
    if (storage) {
      const readLabel = storage.read_bytes_per_sec != null
        ? formatRateBytesPerSec(storage.read_bytes_per_sec)
        : "—";
      const detailParts: string[] = [];
      if (storage.write_bytes_per_sec != null) {
        detailParts.push(`W ${formatRateBytesPerSec(storage.write_bytes_per_sec)}`);
      }
      const rootMount = storage.mounts?.find(m => m.mount_point === "/") ?? storage.mounts?.[0];
      if (rootMount && rootMount.total_bytes > 0) {
        const pct = Math.round((rootMount.used_bytes / rootMount.total_bytes) * 100);
        detailParts.push(`${rootMount.mount_point} ${pct}%`);
      }
      tiles.push({
        id: "disk",
        title: "Disk I/O",
        value: readLabel,
        accentValue: false,
        detail: detailParts.join(" · ") || "Block devices",
      });
    }

    return tiles;
  });

  const hardwareRows = createMemo(() => {
    const tiles = hardwareTiles();
    const rows: (readonly HardwareTileData[])[] = [];
    for (let i = 0; i < tiles.length; i += 2) {
      rows.push(tiles.slice(i, i + 2));
    }
    return rows;
  });

  return (
    <scroll
      testId="panel-system-monitor"
      class={styles.panelScroll}
      style={{ maxHeight: `${PANEL_MAX_HEIGHTS["system-monitor"]}px` }}
    >
      <column class={styles.panelBody}>
        {/* Header */}
        <row class={styles.headerRow}>
          <column class={styles.headerTitleCol}>
            <text role="heading" class={styles.headerTitle}>
              System monitor
            </text>
            <text testId="sysmon-popover-subtitle" data-tabular="true" class={cx(styles.clipped, styles.subtitle)}>
              {subtitle()}
            </text>
          </column>
          <row class={styles.headerActions}>
            <Show when={pollLabel()}>
              {cadence => (
                <row testId="sysmon-poll-pill" class={styles.pollPill}>
                  <box ariaHidden class={styles.pollDot} />
                  <text data-tabular="true" class={styles.pollText}>
                    {cadence()}
                  </text>
                </row>
              )}
            </Show>
            <M3IconButton
              testId="sysmon-popout"
              ariaLabel="Open detailed system monitor"
              variant="filled-tonal"
              size="sm"
              onClick={() => openSystemMonitorWindow("overview")}
            >
              <ShellIcon name="openInNew" size={16} color={onSurface} />
            </M3IconButton>
          </row>
        </row>

        {/* CPU Card */}
        <column testId="sysmon-cpu-card" class={styles.card}>
          <row class={styles.cardHeaderRow}>
            <row class={styles.cpuLabelRow}>
              <ShellIcon name="cpu" size={15} color={primary} />
              <text class={styles.cardTitle}>CPU</text>
              <Show when={cpuMeta().length > 0}>
                <text data-tabular="true" class={cx(styles.clipped, styles.monoMeta)}>
                  {cpuMeta()}
                </text>
              </Show>
            </row>
            <text testId="sysmon-cpu-percent" data-tabular="true" class={styles.cpuPercent}>
              {cpuPctLabel()}
            </text>
          </row>
          <Show when={cpuHistory()}>
            {series => (
              <AreaLineChart
                testId="sysmon-popover-cpu-chart"
                variant="popover"
                values={series()}
                maxValue={100}
                bucketSeconds={history60s()?.bucket_seconds}
                latestBucketId={history60s()?.latest_bucket_id}
                sourceBaseline={telemetry.sourceBaseline()}
                revision={telemetry.revision()}
              />
            )}
          </Show>
        </column>

        {/* Memory Card */}
        <Show when={mem()}>
          {breakdown => {
            const swap = () => snap()?.swap;
            const showSwap = () => Boolean(swap() && swap()!.total_bytes > 0);
            const activePct = () => breakdown().activePercent;
            const cachePct = () => breakdown().cachePercent;
            const cacheBytes = () => breakdown().cacheBytes;
            return (
              <column testId="sysmon-memory-card" class={styles.card}>
                <row class={styles.cardHeaderRow}>
                  <row class={styles.memoryTitleRow}>
                    <text class={styles.cardTitle}>Memory</text>
                    <text data-tabular="true" class={cx(styles.clipped, styles.monoMeta)}>
                      {`${(breakdown().usedBytes / 1024 ** 3).toFixed(1)} / ${formatBytesDecimalGB(breakdown().totalBytes, 1)}`}
                    </text>
                  </row>
                  <text testId="sysmon-memory-percent" data-tabular="true" class={styles.memoryPercent}>
                    {`${Math.round(breakdown().usedPercent)}%`}
                  </text>
                </row>

                {/* Non-overlapping Active + Cache segmented bar */}
                <row ariaLabel="Memory usage breakdown" class={styles.memoryBarTrack}>
                  <Show when={activePct() > 0.5}>
                    <box
                      data-percent-fill="true"
                      ariaHidden
                      class={styles.memoryBarActive}
                      style={{ width: `${activePct().toFixed(2)}%` }}
                    />
                  </Show>
                  <Show when={cachePct() > 0.5}>
                    <box
                      data-percent-fill="true"
                      ariaHidden
                      class={styles.memoryBarCache}
                      style={{ width: `${cachePct().toFixed(2)}%` }}
                    />
                  </Show>
                </row>

                <row class={styles.cardHeaderRow}>
                  <text data-tabular="true" class={cx(styles.clipped, styles.monoMeta)}>
                    {cacheBytes() !== null
                      ? `Active ${formatBytesShort(breakdown().usedBytes, true)} · Cache ${formatBytesShort(cacheBytes(), true)}`
                      : `Active ${formatBytesShort(breakdown().usedBytes, true)} · Free ${formatBytesShort(breakdown().availableBytes, true)}`}
                  </text>
                  <Show when={showSwap()}>
                    <text data-tabular="true" class={styles.swapText}>
                      {`Swap ${(swap()!.used_bytes / 1024 ** 3).toFixed(1)} / ${(swap()!.total_bytes / 1024 ** 3).toFixed(1)}G`}
                    </text>
                  </Show>
                </row>
              </column>
            );
          }}
        </Show>

        {/* Dynamic 2x2 Hardware Grid */}
        <Show when={hardwareRows().length > 0}>
          <column testId="sysmon-hardware-grid" class={styles.hardwareGrid}>
            <For each={hardwareRows()} keyed={row => row.map(t => t.id).join("-")}>
              {row => (
                <row class={styles.hardwareRow}>
                  <For each={row()} keyed={tile => tile.id}>
                    {tile => (
                      <column testId={`sysmon-tile-${tile().id}`} class={styles.hardwareTile}>
                        <row class={styles.tileHeaderRow}>
                          <text class={styles.tileTitle}>
                            {tile().title}
                          </text>
                          <text
                            data-tabular="true"
                            class={cx(styles.clipped, styles.tileValue)}
                            data-accent={tile().accentValue ? "true" : "false"}
                          >
                            {tile().value}
                          </text>
                        </row>
                        <text data-tabular="true" class={cx(styles.clipped, styles.monoMeta)}>
                          {tile().detail}
                        </text>
                      </column>
                    )}
                  </For>
                </row>
              )}
            </For>
          </column>
        </Show>
      </column>
    </scroll>
  );
}
