import { For, Show, createMemo, type NativeChild } from "@hewel/zgui";
import { M3Button, M3IconButton } from "@z-shell/sdk/primitives";
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
  selectPrimaryGpu,
  selectTelemetryHistoryWindow,
} from "../topics.ts";

const primary = "var(--color-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

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
  const { telemetry, power, openSystemMonitorWindow } = useShellStore();
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

    const net = current?.network;
    if (net) {
      const rxLabel = net.rx_bytes_per_sec != null ? `↓ ${formatRateBytesPerSec(net.rx_bytes_per_sec)}` : "—";
      const detailParts: string[] = [];
      if (net.tx_bytes_per_sec != null) detailParts.push(`↑ ${formatRateBytesPerSec(net.tx_bytes_per_sec)}`);
      if (net.active_interface) detailParts.push(net.active_interface);
      tiles.push({
        id: "network",
        title: "Network",
        value: rxLabel,
        accentValue: net.rx_bytes_per_sec != null,
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

  const batteryText = createMemo(() => {
    const bat = power.data()?.battery;
    if (!bat || bat.percentage === null || bat.percentage === undefined) return null;
    const pct = `${Math.round(bat.percentage)}%`;
    if (bat.energy_rate_watts !== null && bat.energy_rate_watts !== undefined && Number.isFinite(bat.energy_rate_watts)) {
      return `Battery ${pct} · ${bat.energy_rate_watts.toFixed(1)} W`;
    }
    return `Battery ${pct}`;
  });

  return (
    <scroll testId="panel-system-monitor" style={{
      width: "100%",
      maxHeight: `${PANEL_MAX_HEIGHTS["system-monitor"]}px`,
      overflow: "hidden auto",
      backgroundColor: "transparent",
      color: onSurface,
      fontFamily: "var(--font-sans)",
      fontSize: "13px",
    }}>
      <column style={{ padding: "14px", gap: "10px", width: "100%" }}>
        {/* Header */}
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
          <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "2px" }}>
            <text role="heading" style={{ fontSize: "20px", fontWeight: 600, lineHeight: "26px" }}>
              System monitor
            </text>
            <text testId="sysmon-popover-subtitle" data-tabular="true" style={{
              ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "15px", color: muted, fontVariantNumeric: "tabular-nums",
            }}>
              {subtitle()}
            </text>
          </column>
          <row style={{ alignItems: "center", gap: "8px", flexShrink: 0 }}>
            <Show when={pollLabel()}>
              {cadence => (
                <row testId="sysmon-poll-pill" style={{
                  alignItems: "center", gap: "6px", height: "28px", padding: "0 10px",
                  borderRadius: "999px", "--zgui-corner-shape": "none",
                  backgroundColor: containerHigh,
                }}>
                  <box ariaHidden style={{
                    width: "6px", height: "6px", borderRadius: "999px", "--zgui-corner-shape": "none",
                    backgroundColor: primary, flexShrink: 0,
                  }} />
                  <text data-tabular="true" style={{
                    fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "14px", color: muted, fontVariantNumeric: "tabular-nums",
                  }}>
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
        <column testId="sysmon-cpu-card" style={{
          borderRadius: "16px", backgroundColor: containerHigh, padding: "12px", gap: "8px", width: "100%",
        }}>
          <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
            <row style={{ alignItems: "center", gap: "6px", flexGrow: 1, flexBasis: "0px", minWidth: "0px" }}>
              <ShellIcon name="cpu" size={15} color={primary} />
              <text style={{ fontSize: "13px", fontWeight: 600, flexShrink: 0 }}>CPU</text>
              <Show when={cpuMeta().length > 0}>
                <text data-tabular="true" style={{
                  ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "15px", color: muted, fontVariantNumeric: "tabular-nums",
                }}>
                  {cpuMeta()}
                </text>
              </Show>
            </row>
            <text testId="sysmon-cpu-percent" data-tabular="true" style={{
              fontFamily: "var(--font-mono)", fontSize: "20px", fontWeight: 600, lineHeight: "24px",
              color: primary, flexShrink: 0, fontVariantNumeric: "tabular-nums",
            }}>
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
              <column testId="sysmon-memory-card" style={{
                borderRadius: "16px", backgroundColor: containerHigh, padding: "12px", gap: "8px", width: "100%",
              }}>
                <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
                  <row style={{ alignItems: "baseline", gap: "8px", flexGrow: 1, flexBasis: "0px", minWidth: "0px" }}>
                    <text style={{ fontSize: "13px", fontWeight: 600, flexShrink: 0 }}>Memory</text>
                    <text data-tabular="true" style={{
                      ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "15px", color: muted, fontVariantNumeric: "tabular-nums",
                    }}>
                      {`${(breakdown().usedBytes / 1024 ** 3).toFixed(1)} / ${formatBytesDecimalGB(breakdown().totalBytes, 1)}`}
                    </text>
                  </row>
                  <text testId="sysmon-memory-percent" data-tabular="true" style={{
                    fontFamily: "var(--font-mono)", fontSize: "14px", fontWeight: 600, lineHeight: "18px",
                    color: onSurface, flexShrink: 0, fontVariantNumeric: "tabular-nums",
                  }}>
                    {`${Math.round(breakdown().usedPercent)}%`}
                  </text>
                </row>

                {/* Non-overlapping Active + Cache segmented bar */}
                <row ariaLabel="Memory usage breakdown" style={{
                  width: "100%", height: "8px", borderRadius: "999px", "--zgui-corner-shape": "none",
                  backgroundColor: containerHighest, overflow: "hidden", gap: "2px",
                }}>
                  <Show when={activePct() > 0.5}>
                    <box data-percent-fill="true" ariaHidden style={{
                      width: `${activePct().toFixed(2)}%`, height: "100%",
                      borderRadius: "999px", "--zgui-corner-shape": "none",
                      backgroundColor: primary,
                    }} />
                  </Show>
                  <Show when={cachePct() > 0.5}>
                    <box data-percent-fill="true" ariaHidden style={{
                      width: `${cachePct().toFixed(2)}%`, height: "100%",
                      borderRadius: "999px", "--zgui-corner-shape": "none",
                      backgroundColor: primaryContainer,
                    }} />
                  </Show>
                </row>

                <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
                  <text data-tabular="true" style={{
                    ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "15px", color: muted, fontVariantNumeric: "tabular-nums",
                  }}>
                    {cacheBytes() !== null
                      ? `Active ${formatBytesShort(breakdown().usedBytes, true)} · Cache ${formatBytesShort(cacheBytes(), true)}`
                      : `Active ${formatBytesShort(breakdown().usedBytes, true)} · Free ${formatBytesShort(breakdown().availableBytes, true)}`}
                  </text>
                  <Show when={showSwap()}>
                    <text data-tabular="true" style={{
                      fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "15px", color: muted, flexShrink: 0, fontVariantNumeric: "tabular-nums",
                    }}>
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
          <column testId="sysmon-hardware-grid" style={{ gap: "8px", width: "100%" }}>
            <For each={hardwareRows()} keyed={row => row.map(t => t.id).join("-")}>
              {row => (
                <row style={{ gap: "8px", width: "100%" }}>
                  <For each={row()} keyed={tile => tile.id}>
                    {tile => (
                      <column testId={`sysmon-tile-${tile().id}`} style={{
                        flexGrow: 1, flexBasis: "0px", minWidth: "0px",
                        borderRadius: "14px", backgroundColor: containerHigh,
                        padding: "10px 12px", gap: "4px",
                      }}>
                        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "6px", width: "100%" }}>
                          <text style={{ fontSize: "12px", fontWeight: 600, color: onSurface, flexShrink: 0 }}>
                            {tile().title}
                          </text>
                          <text data-tabular="true" style={{
                            ...clipped, fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600,
                            lineHeight: "16px", color: tile().accentValue ? primary : onSurface, fontVariantNumeric: "tabular-nums",
                          }}>
                            {tile().value}
                          </text>
                        </row>
                        <text data-tabular="true" style={{
                          ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "15px",
                          color: muted, fontVariantNumeric: "tabular-nums",
                        }}>
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

        {/* Footer */}
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%", paddingTop: "2px" }}>
          <Show when={batteryText()} fallback={<box style={{ flexGrow: 1 }} />}>
            {text => (
              <text testId="sysmon-popover-battery" data-tabular="true" style={{
                ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "15px", color: muted, fontVariantNumeric: "tabular-nums",
              }}>
                {text()}
              </text>
            )}
          </Show>
          <M3Button
            testId="sysmon-open-detailed"
            variant="accent-tonal"
            size="sm"
            onClick={() => openSystemMonitorWindow("overview")}
          >
            <text>Open detailed monitor</text>
            <ShellIcon name="openInNew" size={14} color={onPrimaryContainer} />
          </M3Button>
        </row>
      </column>
    </scroll>
  );
}
