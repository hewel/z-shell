import {
  Button, For, Match, Show, Switch,
  createEffect, createMemo, createSignal,
  type Accessor, type NativeChild,
} from "@hewel/zgui";
import { M3SegmentedControl, type M3SegmentedOption } from "@z-shell/sdk/primitives";
import { AreaLineChart, DualLineChart, PerCoreBarChart } from "../charts/TelemetryCharts.tsx";
import { ShellIcon, type ShellIconName } from "../icons.tsx";
import { useShellStore, type SystemMonitorTab } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import {
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
  type SystemTelemetrySnapshot,
  type TelemetryGpuInfo,
  type TelemetryHistoryWindow,
  type TelemetryMount,
  type TelemetryRangeKey,
} from "../topics.ts";
import {
  clipped,
  container,
  containerHigh,
  containerHighest,
  grow,
  muted,
  onPrimaryContainer,
  onSurface,
  outline,
  primary,
  primaryContainer,
  surface,
} from "./settings/shared.tsx";
import { FadeThroughPane, SingleInstanceWindowSurface, SlidingNavPill } from "./window-chrome.tsx";

const surfaceLowest = "var(--color-surface-container-lowest)";
const tertiary = "var(--color-tertiary)";

const RANGE_OPTIONS: readonly M3SegmentedOption<TelemetryRangeKey>[] = [
  { id: "60s", label: "60s", testId: "sysmon-range-60s" },
  { id: "5m", label: "5m", testId: "sysmon-range-5m" },
  { id: "15m", label: "15m", testId: "sysmon-range-15m" },
];

interface MonitorNavItem {
  readonly id: SystemMonitorTab;
  readonly label: string;
  readonly heading: string;
  readonly icon: ShellIconName;
  readonly readout?: string;
}

const cardStyle = {
  borderRadius: "16px",
  backgroundColor: containerHigh,
  padding: "12px 14px",
  gap: "8px",
} as const;

function percentText(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${Math.round(value)}%`;
}

function formatCompactModel(model: string | null | undefined): string {
  if (!model) return "";
  return model
    .replace(/^AMD\s+/i, "")
    .replace(/^Intel\(R\)\s+Core\(TM\)\s+/i, "")
    .replace(/\s+w\/\s+.*$/i, "")
    .replace(/\s+\d+-Core\s+Processor$/i, "")
    .trim();
}

function MemorySegmentedBar(props: {
  readonly activePct: number;
  readonly cachePct: number;
  readonly height?: number;
}): NativeChild {
  const h = () => `${props.height ?? 8}px`;
  return (
    <row ariaLabel="Memory allocation bar" style={{
      width: "100%", height: h(), borderRadius: "999px", "--zgui-corner-shape": "none",
      backgroundColor: containerHighest, overflow: "hidden", gap: "2px",
    }}>
      <Show when={props.activePct > 0.5}>
        <box data-percent-fill="true" ariaHidden style={{
          width: `${props.activePct.toFixed(2)}%`, height: "100%",
          borderRadius: "999px", "--zgui-corner-shape": "none",
          backgroundColor: primary,
        }} />
      </Show>
      <Show when={props.cachePct > 0.5}>
        <box data-percent-fill="true" ariaHidden style={{
          width: `${props.cachePct.toFixed(2)}%`, height: "100%",
          borderRadius: "999px", "--zgui-corner-shape": "none",
          backgroundColor: primaryContainer,
        }} />
      </Show>
    </row>
  );
}

function SimpleProgressBar(props: {
  readonly percent: number;
  readonly color?: string;
  readonly height?: number;
}): NativeChild {
  const clamped = () => Math.max(0, Math.min(100, props.percent));
  return (
    <box ariaHidden style={{
      width: "100%", height: `${props.height ?? 6}px`, borderRadius: "999px", "--zgui-corner-shape": "none",
      backgroundColor: containerHighest, overflow: "hidden",
    }}>
      <Show when={clamped() > 0.5}>
        <box data-percent-fill="true" ariaHidden style={{
          width: `${clamped().toFixed(2)}%`, height: "100%",
          borderRadius: "999px", "--zgui-corner-shape": "none",
          backgroundColor: props.color ?? primary,
        }} />
      </Show>
    </box>
  );
}

function MountRow(props: { readonly mount: TelemetryMount; readonly primaryFill: boolean }): NativeChild {
  const pct = () => props.mount.total_bytes > 0
    ? Math.round((props.mount.used_bytes / props.mount.total_bytes) * 100)
    : 0;
  const label = () => (props.mount.mount_point === "/" && props.mount.device
    ? `/ (${props.mount.device})`
    : props.mount.mount_point);
  const freeStr = () => `${formatBytesShort(props.mount.available_bytes)} free`;
  return (
    <column style={{ gap: "4px", width: "100%" }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
        <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "14px", color: onSurface }}>
          {label()}
        </text>
        <text data-tabular="true" style={{
          fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: muted, flexShrink: 0, fontVariantNumeric: "tabular-nums",
        }}>
          {`${pct()}% · ${freeStr()}`}
        </text>
      </row>
      <SimpleProgressBar percent={pct()} color={props.primaryFill ? primary : primaryContainer} height={6} />
    </column>
  );
}

function OverviewPane(props: {
  readonly snap: Accessor<SystemTelemetrySnapshot | undefined>;
  readonly history: Accessor<TelemetryHistoryWindow | null>;
}): NativeChild {
  const snap = props.snap;
  const mem = createMemo(() => computeMemoryBreakdown(snap()?.memory));
  const gpu = createMemo(() => selectPrimaryGpu(snap()?.gpus));
  const headlineTemp = createMemo(() => selectHeadlineTempCelsius(snap()));
  const cpuCores = () => snap()?.cpu?.per_core_usage_percent ?? [];
  const coreCount = () => snap()?.cpu?.core_count ?? cpuCores().length;

  const cpuHeaderMeta = createMemo(() => {
    const parts: string[] = [];
    const freq = formatFrequencyMhz(snap()?.cpu?.frequency_mhz, 2);
    if (freq) parts.push(freq);
    const load1 = snap()?.cpu?.load_average?.[0];
    if (load1 !== undefined && load1 !== null && Number.isFinite(load1)) {
      parts.push(`Load ${load1.toFixed(2)}`);
    }
    const temp = headlineTemp();
    if (temp !== null) parts.push(`${temp}°C`);
    return parts.join(" · ");
  });

  const thermalStrip = createMemo(() => {
    const sensors = snap()?.sensors ?? [];
    if (sensors.length > 0) {
      return sensors.slice(0, 4).map(s => ({
        label: s.label,
        temp: `${Math.round(s.temperature_millicelsius / 1000)}°C`,
        highlight: s.category === "cpu",
      }));
    }
    return (snap()?.temperatures ?? []).slice(0, 4).map((z, idx) => ({
      label: z.kind,
      temp: `${Math.round(z.temperature_millicelsius / 1000)}°C`,
      highlight: idx === 0,
    }));
  });

  const mounts = () => (snap()?.storage?.mounts ?? []).slice(0, 2);

  return (
    <column testId="sysmon-overview-pane" style={{ gap: "10px", width: "100%" }}>
      {/* Row 1: CPU Utilization + Per-Core */}
      <column style={{ ...cardStyle, gap: "8px", width: "100%" }}>
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
          <row style={{ alignItems: "baseline", gap: "8px", ...grow }}>
            <text style={{ fontSize: "13px", fontWeight: 600, flexShrink: 0 }}>CPU Utilization</text>
            <Show when={cpuHeaderMeta().length > 0}>
              <text data-tabular="true" style={{
                ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "15px", color: muted, fontVariantNumeric: "tabular-nums",
              }}>
                {cpuHeaderMeta()}
              </text>
            </Show>
          </row>
          <text testId="sysmon-win-cpu-pct" data-tabular="true" style={{
            fontFamily: "var(--font-mono)", fontSize: "20px", fontWeight: 600, lineHeight: "24px",
            color: primary, flexShrink: 0, fontVariantNumeric: "tabular-nums",
          }}>
            {percentText(snap()?.cpu_usage_percent)}
          </text>
        </row>
        <row style={{ gap: "10px", width: "100%", alignItems: "stretch" }}>
          <box style={{ ...grow }}>
            <AreaLineChart
              testId="sysmon-win-cpu-chart"
              variant="window"
              values={props.history()?.cpu_percent}
              maxValue={100}
              emptyLabel="Live CPU readout only"
            />
          </box>
          <Show when={cpuCores().length > 0}>
            <column style={{
              width: "148px", flexShrink: 0, borderRadius: "10px", backgroundColor: surfaceLowest,
              padding: "8px 10px", justifyContent: "space-between", gap: "4px",
            }}>
              <text data-tabular="true" style={{
                fontFamily: "var(--font-mono)", fontSize: "9px", fontWeight: 600, letterSpacing: "0.04em",
                lineHeight: "12px", color: muted, fontVariantNumeric: "tabular-nums",
              }}>
                {`PER CORE (${coreCount()})`}
              </text>
              <PerCoreBarChart cores={cpuCores()} height={52} maxBars={16} />
            </column>
          </Show>
        </row>
      </column>

      {/* Row 2: Memory & Swap | GPU */}
      <row style={{ gap: "10px", width: "100%", alignItems: "stretch" }}>
        <Show when={mem()}>
          {breakdown => {
            const swap = () => snap()?.swap;
            return (
              <column style={{ ...cardStyle, ...grow, justifyContent: "space-between" }}>
                <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
                  <text style={{ fontSize: "13px", fontWeight: 600 }}>Memory & Swap</text>
                  <text data-tabular="true" style={{
                    fontFamily: "var(--font-mono)", fontSize: "13px", fontWeight: 600, lineHeight: "16px",
                    color: primary, fontVariantNumeric: "tabular-nums",
                  }}>
                    {`${Math.round(breakdown().usedPercent)}%`}
                  </text>
                </row>
                <text data-tabular="true" style={{
                  ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "14px", color: muted, fontVariantNumeric: "tabular-nums",
                }}>
                  {breakdown().cacheBytes !== null
                    ? `${(breakdown().usedBytes / 1024 ** 3).toFixed(1)} / ${formatBytesDecimalGB(breakdown().totalBytes, 1)} active · ${formatBytesDecimalGB(breakdown().cacheBytes!, 1)} cache`
                    : `${(breakdown().usedBytes / 1024 ** 3).toFixed(1)} / ${formatBytesDecimalGB(breakdown().totalBytes, 1)} used`}
                </text>
                <MemorySegmentedBar activePct={breakdown().activePercent} cachePct={breakdown().cachePercent} height={8} />
                <row style={{ alignItems: "center", justifyContent: "space-between", gap: "6px", width: "100%" }}>
                  <text data-tabular="true" style={{
                    ...clipped, fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: muted, fontVariantNumeric: "tabular-nums",
                  }}>
                    {swap() && swap()!.total_bytes > 0
                      ? `Swap ${(swap()!.used_bytes / 1024 ** 3).toFixed(1)} / ${formatBytesDecimalGB(swap()!.total_bytes, 1)}`
                      : "Swap inactive"}
                  </text>
                  <text data-tabular="true" style={{
                    fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: muted, flexShrink: 0, fontVariantNumeric: "tabular-nums",
                  }}>
                    {`Available ${formatBytesDecimalGB(breakdown().availableBytes, 1)}`}
                  </text>
                </row>
              </column>
            );
          }}
        </Show>

        <Show when={gpu()}>
          {card => {
            const vramPct = () => {
              const u = card().vram_used_bytes;
              const t = card().vram_total_bytes;
              return u != null && t != null && t > 0 ? (u / t) * 100 : 0;
            };
            const gpuMetrics = () => {
              const parts: string[] = [];
              if (card().vram_used_bytes != null && card().vram_total_bytes != null && card().vram_total_bytes! > 0) {
                parts.push(`VRAM ${(card().vram_used_bytes! / 1024 ** 3).toFixed(1)} / ${formatBytesDecimalGB(card().vram_total_bytes!, 1)}`);
              }
              if (card().power_milliwatts != null) {
                parts.push(`${(card().power_milliwatts! / 1000).toFixed(1)} W`);
              }
              if (card().temperature_millicelsius != null) {
                parts.push(`${Math.round(card().temperature_millicelsius! / 1000)}°C`);
              }
              return parts.join(" · ") || "DRM telemetry";
            };
            return (
              <column testId="sysmon-overview-gpu" style={{ ...cardStyle, ...grow, justifyContent: "space-between" }}>
                <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
                  <text style={{ ...clipped, fontSize: "13px", fontWeight: 600 }}>
                    {card().name ? `GPU · ${card().name}` : `GPU · ${card().driver ?? card().id}`}
                  </text>
                  <text data-tabular="true" style={{
                    fontFamily: "var(--font-mono)", fontSize: "13px", fontWeight: 600, lineHeight: "16px",
                    color: primary, flexShrink: 0, fontVariantNumeric: "tabular-nums",
                  }}>
                    {percentText(card().utilization_percent)}
                  </text>
                </row>
                <text data-tabular="true" style={{
                  ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "14px", color: muted, fontVariantNumeric: "tabular-nums",
                }}>
                  {gpuMetrics()}
                </text>
                <SimpleProgressBar percent={vramPct()} color={primary} height={8} />
                <row style={{ alignItems: "center", justifyContent: "space-between", gap: "6px", width: "100%" }}>
                  <text data-tabular="true" style={{
                    ...clipped, fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: muted, fontVariantNumeric: "tabular-nums",
                  }}>
                    {card().clock_mhz != null ? `SCLK ${card().clock_mhz} MHz` : (card().pci_slot ?? card().id)}
                  </text>
                  <text style={{ fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: muted, flexShrink: 0 }}>
                    {card().driver ? `drm / ${card().driver}` : "drm"}
                  </text>
                </row>
              </column>
            );
          }}
        </Show>
      </row>

      {/* Row 3: Network | Disk I/O & Storage */}
      <Show when={Boolean(snap()?.network || snap()?.storage)}>
        <row style={{ gap: "10px", width: "100%", alignItems: "stretch" }}>
          <Show when={snap()?.network}>
            {net => (
              <column style={{ ...cardStyle, ...grow, justifyContent: "space-between" }}>
                <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", width: "100%" }}>
                  <text style={{ ...clipped, fontSize: "13px", fontWeight: 600 }}>
                    {net().active_interface ? `Network · ${net().active_interface}` : "Network"}
                  </text>
                  <text data-tabular="true" style={{
                    fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 600, lineHeight: "15px",
                    color: primary, flexShrink: 0, fontVariantNumeric: "tabular-nums",
                  }}>
                    {`↓ ${formatRateBytesPerSec(net().rx_bytes_per_sec)}`}
                  </text>
                </row>
                <DualLineChart
                  testId="sysmon-win-net-chart"
                  primarySeries={props.history()?.net_rx_bytes_per_sec}
                  secondarySeries={props.history()?.net_tx_bytes_per_sec}
                  emptyLabel="Live interface counters"
                />
                <row style={{ alignItems: "center", justifyContent: "space-between", gap: "6px", width: "100%" }}>
                  <text data-tabular="true" style={{
                    fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: muted, fontVariantNumeric: "tabular-nums",
                  }}>
                    {`↑ ${formatRateBytesPerSec(net().tx_bytes_per_sec)}`}
                  </text>
                  <text data-tabular="true" style={{
                    ...clipped, fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: muted, fontVariantNumeric: "tabular-nums",
                  }}>
                    {`Total ↓${formatBytesShort(net().session_rx_bytes, true)} · ↑${formatBytesShort(net().session_tx_bytes, true)}`}
                  </text>
                </row>
              </column>
            )}
          </Show>

          <Show when={snap()?.storage}>
            {storage => (
              <column style={{ ...cardStyle, ...grow, justifyContent: "space-between" }}>
                <row style={{ alignItems: "center", justifyContent: "space-between", gap: "6px", width: "100%" }}>
                  <text style={{ fontSize: "13px", fontWeight: 600, flexShrink: 0 }}>Disk I/O & Storage</text>
                  <text data-tabular="true" style={{
                    ...clipped, fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: muted, fontVariantNumeric: "tabular-nums",
                  }}>
                    {`R ${formatRateBytesPerSec(storage().read_bytes_per_sec)} · W ${formatRateBytesPerSec(storage().write_bytes_per_sec)}`}
                  </text>
                </row>
                <Show when={mounts().length > 0} fallback={
                  <DualLineChart
                    primarySeries={props.history()?.disk_read_bytes_per_sec}
                    secondarySeries={props.history()?.disk_write_bytes_per_sec}
                    emptyLabel="No local mount summaries"
                  />
                }>
                  <column style={{ gap: "10px", width: "100%", paddingTop: "2px" }}>
                    <For each={mounts()} keyed={m => m.mount_point}>
                      {(m, idx) => <MountRow mount={m()} primaryFill={idx() === 0} />}
                    </For>
                  </column>
                </Show>
              </column>
            )}
          </Show>
        </row>
      </Show>

      {/* Row 4: Thermals Summary Strip */}
      <Show when={thermalStrip().length > 0}>
        <row testId="sysmon-thermals-strip" style={{
          borderRadius: "14px", backgroundColor: containerHigh, padding: "10px 14px",
          alignItems: "center", justifyContent: "space-between", gap: "12px", width: "100%",
        }}>
          <text style={{ fontSize: "12px", fontWeight: 600, lineHeight: "16px", flexShrink: 0 }}>Thermals</text>
          <row style={{ alignItems: "center", gap: "14px", flexWrap: "nowrap" }}>
            <For each={thermalStrip()} keyed={s => s.label}>
              {sensor => (
                <row style={{ alignItems: "baseline", gap: "5px", flexShrink: 0 }}>
                  <text style={{ fontSize: "11px", lineHeight: "15px", color: muted }}>{sensor().label}</text>
                  <text data-tabular="true" style={{
                    fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 600, lineHeight: "15px",
                    color: sensor().highlight ? primary : onSurface, fontVariantNumeric: "tabular-nums",
                  }}>
                    {sensor().temp}
                  </text>
                </row>
              )}
            </For>
          </row>
        </row>
      </Show>
    </column>
  );
}

function CpuThermalPane(props: {
  readonly snap: Accessor<SystemTelemetrySnapshot | undefined>;
  readonly history: Accessor<TelemetryHistoryWindow | null>;
}): NativeChild {
  const snap = props.snap;
  const cpu = () => snap()?.cpu;
  const cores = () => (cpu()?.per_core_usage_percent ?? []).map((val, idx) => ({ idx, val }));
  const sensors = () => snap()?.sensors ?? [];
  const zones = () => snap()?.temperatures ?? [];

  return (
    <column testId="sysmon-cpu-pane" style={{ gap: "10px", width: "100%" }}>
      <column style={cardStyle}>
        <row style={{ alignItems: "center", justifyContent: "space-between", width: "100%" }}>
          <column style={{ gap: "2px", ...grow }}>
            <text style={{ fontSize: "14px", fontWeight: 600 }}>
              {cpu()?.model_name ?? "Processor"}
            </text>
            <text data-tabular="true" style={{
              ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "15px", color: muted, fontVariantNumeric: "tabular-nums",
            }}>
              {[
                cpu()?.core_count ? `${cpu()!.core_count} logical cores` : "",
                formatFrequencyMhz(cpu()?.frequency_mhz, 2),
                formatUptimeCompact(cpu()?.uptime_seconds) ? `Up ${formatUptimeCompact(cpu()?.uptime_seconds)}` : "",
              ].filter(Boolean).join(" · ") || "CPU telemetry"}
            </text>
          </column>
          <text data-tabular="true" style={{
            fontFamily: "var(--font-mono)", fontSize: "22px", fontWeight: 600, lineHeight: "26px",
            color: primary, flexShrink: 0, fontVariantNumeric: "tabular-nums",
          }}>
            {percentText(snap()?.cpu_usage_percent)}
          </text>
        </row>
        <AreaLineChart
          testId="sysmon-detail-cpu-chart"
          variant="detail"
          values={props.history()?.cpu_percent}
          maxValue={100}
        />
        <Show when={cpu()?.load_average}>
          {load => (
            <row style={{ gap: "8px", width: "100%" }}>
              <For each={[
                { label: "Load 1m", value: load()[0].toFixed(2) },
                { label: "Load 5m", value: load()[1].toFixed(2) },
                { label: "Load 15m", value: load()[2].toFixed(2) },
              ]} keyed={item => item.label}>
                {item => (
                  <row style={{
                    ...grow, alignItems: "center", justifyContent: "space-between",
                    padding: "8px 10px", borderRadius: "10px", backgroundColor: container,
                  }}>
                    <text style={{ fontSize: "11px", lineHeight: "14px", color: muted }}>{item().label}</text>
                    <text data-tabular="true" style={{
                      fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, lineHeight: "15px", color: onSurface, fontVariantNumeric: "tabular-nums",
                    }}>
                      {item().value}
                    </text>
                  </row>
                )}
              </For>
            </row>
          )}
        </Show>
      </column>

      <Show when={cores().length > 0}>
        <column style={cardStyle}>
          <row style={{ alignItems: "center", justifyContent: "space-between", width: "100%" }}>
            <text style={{ fontSize: "13px", fontWeight: 600 }}>Per-core utilization</text>
            <text data-tabular="true" style={{
              fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "14px", color: muted, fontVariantNumeric: "tabular-nums",
            }}>
              {`${cores().length} cores`}
            </text>
          </row>
          <box style={{ borderRadius: "10px", backgroundColor: surfaceLowest, padding: "10px" }}>
            <PerCoreBarChart cores={cpu()?.per_core_usage_percent ?? []} height={72} maxBars={32} />
          </box>
        </column>
      </Show>

      <Show when={sensors().length > 0 || zones().length > 0}>
        <column style={cardStyle}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>Thermal sensors</text>
          <Show when={sensors().length > 0} fallback={
            <column style={{ gap: "6px", width: "100%" }}>
              <For each={zones()} keyed={z => z.zone}>
                {z => (
                  <row style={{
                    alignItems: "center", justifyContent: "space-between",
                    padding: "8px 10px", borderRadius: "10px", backgroundColor: container,
                  }}>
                    <text style={{ fontSize: "12px", lineHeight: "16px", color: onSurface }}>{z().kind}</text>
                    <text data-tabular="true" style={{
                      fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, lineHeight: "16px", color: primary, fontVariantNumeric: "tabular-nums",
                    }}>
                      {`${Math.round(z().temperature_millicelsius / 1000)}°C`}
                    </text>
                  </row>
                )}
              </For>
            </column>
          }>
            <column style={{ gap: "6px", width: "100%" }}>
              <For each={sensors()} keyed={s => `${s.label}:${s.source}`}>
                {s => (
                  <row style={{
                    alignItems: "center", justifyContent: "space-between",
                    padding: "8px 10px", borderRadius: "10px", backgroundColor: container,
                  }}>
                    <row style={{ alignItems: "center", gap: "8px", ...grow }}>
                      <text style={{ fontSize: "12px", fontWeight: 600, lineHeight: "16px", color: onSurface }}>{s().label}</text>
                      <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: muted }}>
                        {s().source}
                      </text>
                    </row>
                    <text data-tabular="true" style={{
                      fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, lineHeight: "16px",
                      color: s().category === "cpu" ? primary : onSurface, fontVariantNumeric: "tabular-nums",
                    }}>
                      {`${(s().temperature_millicelsius / 1000).toFixed(1)}°C`}
                    </text>
                  </row>
                )}
              </For>
            </column>
          </Show>
        </column>
      </Show>
    </column>
  );
}

function MemoryPane(props: {
  readonly snap: Accessor<SystemTelemetrySnapshot | undefined>;
  readonly history: Accessor<TelemetryHistoryWindow | null>;
}): NativeChild {
  const mem = createMemo(() => computeMemoryBreakdown(props.snap()?.memory));
  const rawMem = () => props.snap()?.memory;
  const swap = () => props.snap()?.swap;

  return (
    <column testId="sysmon-memory-pane" style={{ gap: "10px", width: "100%" }}>
      <Show when={mem()} fallback={
        <box style={{ ...cardStyle, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
          <text style={{ fontSize: "13px", color: muted }}>Memory telemetry unavailable</text>
        </box>
      }>
        {breakdown => (
          <>
            <column style={cardStyle}>
              <row style={{ alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                <column style={{ gap: "2px" }}>
                  <text style={{ fontSize: "14px", fontWeight: 600 }}>System RAM</text>
                  <text data-tabular="true" style={{
                    fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "15px", color: muted, fontVariantNumeric: "tabular-nums",
                  }}>
                    {`${formatBytesDecimalGB(breakdown().usedBytes, 1)} used of ${formatBytesDecimalGB(breakdown().totalBytes, 1)}`}
                  </text>
                </column>
                <text data-tabular="true" style={{
                  fontFamily: "var(--font-mono)", fontSize: "22px", fontWeight: 600, lineHeight: "26px",
                  color: primary, fontVariantNumeric: "tabular-nums",
                }}>
                  {`${Math.round(breakdown().usedPercent)}%`}
                </text>
              </row>
              <AreaLineChart
                testId="sysmon-detail-memory-chart"
                variant="detail"
                values={props.history()?.memory_percent}
                maxValue={100}
              />
              <MemorySegmentedBar activePct={breakdown().activePercent} cachePct={breakdown().cachePercent} height={10} />
              <row style={{ gap: "8px", width: "100%" }}>
                <For each={[
                  { label: "Active", value: formatBytesDecimalGB(breakdown().usedBytes, 1) },
                  { label: "Available", value: formatBytesDecimalGB(breakdown().availableBytes, 1) },
                  ...(breakdown().cacheBytes !== null ? [{ label: "Page cache", value: formatBytesDecimalGB(breakdown().cacheBytes!, 1) }] : []),
                ]} keyed={item => item.label}>
                  {item => (
                    <column style={{ ...grow, padding: "8px 10px", borderRadius: "10px", backgroundColor: container, gap: "2px" }}>
                      <text style={{ fontSize: "11px", color: muted }}>{item().label}</text>
                      <text data-tabular="true" style={{
                        fontFamily: "var(--font-mono)", fontSize: "13px", fontWeight: 600, lineHeight: "16px", color: onSurface, fontVariantNumeric: "tabular-nums",
                      }}>
                        {item().value}
                      </text>
                    </column>
                  )}
                </For>
              </row>
            </column>

            <Show when={rawMem()?.buffers_bytes != null || rawMem()?.reclaimable_bytes != null}>
              <column style={cardStyle}>
                <text style={{ fontSize: "13px", fontWeight: 600 }}>Kernel cache breakdown</text>
                <row style={{ gap: "8px", width: "100%" }}>
                  <Show when={rawMem()?.cached_bytes != null}>
                    <column style={{ ...grow, padding: "8px 10px", borderRadius: "10px", backgroundColor: container, gap: "2px" }}>
                      <text style={{ fontSize: "11px", color: muted }}>Cached</text>
                      <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                        {formatBytesDecimalGB(rawMem()!.cached_bytes!, 1)}
                      </text>
                    </column>
                  </Show>
                  <Show when={rawMem()?.buffers_bytes != null}>
                    <column style={{ ...grow, padding: "8px 10px", borderRadius: "10px", backgroundColor: container, gap: "2px" }}>
                      <text style={{ fontSize: "11px", color: muted }}>Buffers</text>
                      <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                        {formatBytesDecimalGB(rawMem()!.buffers_bytes!, 1)}
                      </text>
                    </column>
                  </Show>
                  <Show when={rawMem()?.reclaimable_bytes != null}>
                    <column style={{ ...grow, padding: "8px 10px", borderRadius: "10px", backgroundColor: container, gap: "2px" }}>
                      <text style={{ fontSize: "11px", color: muted }}>Reclaimable</text>
                      <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                        {formatBytesDecimalGB(rawMem()!.reclaimable_bytes!, 1)}
                      </text>
                    </column>
                  </Show>
                </row>
              </column>
            </Show>

            <Show when={swap() && swap()!.total_bytes > 0}>
              <column style={cardStyle}>
                <row style={{ alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                  <text style={{ fontSize: "13px", fontWeight: 600 }}>Swap</text>
                  <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                    {`${formatBytesDecimalGB(swap()!.used_bytes, 1)} / ${formatBytesDecimalGB(swap()!.total_bytes, 1)}`}
                  </text>
                </row>
                <SimpleProgressBar
                  percent={(swap()!.used_bytes / swap()!.total_bytes) * 100}
                  color={tertiary}
                  height={8}
                />
              </column>
            </Show>
          </>
        )}
      </Show>
    </column>
  );
}

function GpuCardDetail(props: { readonly gpu: TelemetryGpuInfo; readonly primaryHistory?: readonly (number | null)[] | undefined }): NativeChild {
  const vramPct = () => {
    const u = props.gpu.vram_used_bytes;
    const t = props.gpu.vram_total_bytes;
    return u != null && t != null && t > 0 ? (u / t) * 100 : null;
  };
  return (
    <column style={cardStyle}>
      <row style={{ alignItems: "center", justifyContent: "space-between", width: "100%" }}>
        <column style={{ gap: "2px", ...grow }}>
          <text style={{ ...clipped, fontSize: "14px", fontWeight: 600 }}>
            {props.gpu.name ?? props.gpu.driver ?? props.gpu.id}
          </text>
          <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
            {[props.gpu.id, props.gpu.driver ? `drm / ${props.gpu.driver}` : "", props.gpu.pci_slot ?? ""].filter(Boolean).join(" · ")}
          </text>
        </column>
        <text data-tabular="true" style={{
          fontFamily: "var(--font-mono)", fontSize: "20px", fontWeight: 600, lineHeight: "24px",
          color: primary, flexShrink: 0, fontVariantNumeric: "tabular-nums",
        }}>
          {percentText(props.gpu.utilization_percent)}
        </text>
      </row>

      <Show when={props.primaryHistory && props.primaryHistory.length > 0}>
        <AreaLineChart
          testId="sysmon-detail-gpu-chart"
          variant="detail"
          values={props.primaryHistory}
          maxValue={100}
        />
      </Show>

      <Show when={vramPct() !== null}>
        <column style={{ gap: "4px", width: "100%" }}>
          <row style={{ alignItems: "center", justifyContent: "space-between", width: "100%" }}>
            <text style={{ fontSize: "11px", color: muted }}>VRAM</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: onSurface, fontVariantNumeric: "tabular-nums" }}>
              {`${(props.gpu.vram_used_bytes! / 1024 ** 3).toFixed(1)} / ${formatBytesDecimalGB(props.gpu.vram_total_bytes!, 1)}`}
            </text>
          </row>
          <SimpleProgressBar percent={vramPct()!} color={primary} height={8} />
        </column>
      </Show>

      <row style={{ gap: "8px", width: "100%" }}>
        <Show when={props.gpu.temperature_millicelsius != null}>
          <column style={{ ...grow, padding: "8px 10px", borderRadius: "10px", backgroundColor: container, gap: "2px" }}>
            <text style={{ fontSize: "11px", color: muted }}>Temperature</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {`${Math.round(props.gpu.temperature_millicelsius! / 1000)}°C`}
            </text>
          </column>
        </Show>
        <Show when={props.gpu.power_milliwatts != null}>
          <column style={{ ...grow, padding: "8px 10px", borderRadius: "10px", backgroundColor: container, gap: "2px" }}>
            <text style={{ fontSize: "11px", color: muted }}>Power</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {`${(props.gpu.power_milliwatts! / 1000).toFixed(1)} W`}
            </text>
          </column>
        </Show>
        <Show when={props.gpu.clock_mhz != null}>
          <column style={{ ...grow, padding: "8px 10px", borderRadius: "10px", backgroundColor: container, gap: "2px" }}>
            <text style={{ fontSize: "11px", color: muted }}>Clock (SCLK)</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {`${props.gpu.clock_mhz} MHz`}
            </text>
          </column>
        </Show>
      </row>
    </column>
  );
}

function GpuPane(props: {
  readonly snap: Accessor<SystemTelemetrySnapshot | undefined>;
  readonly history: Accessor<TelemetryHistoryWindow | null>;
}): NativeChild {
  const gpus = () => props.snap()?.gpus ?? [];
  return (
    <column testId="sysmon-gpu-pane" style={{ gap: "10px", width: "100%" }}>
      <For each={gpus()} keyed={g => g.id}>
        {(gpu, idx) => (
          <GpuCardDetail
            gpu={gpu()}
            primaryHistory={idx() === 0 ? props.history()?.gpu_percent : undefined}
          />
        )}
      </For>
    </column>
  );
}

function DiskNetworkPane(props: {
  readonly snap: Accessor<SystemTelemetrySnapshot | undefined>;
  readonly history: Accessor<TelemetryHistoryWindow | null>;
}): NativeChild {
  const net = () => props.snap()?.network;
  const storage = () => props.snap()?.storage;

  return (
    <column testId="sysmon-storage-pane" style={{ gap: "10px", width: "100%" }}>
      <Show when={net()}>
        {n => (
          <column style={cardStyle}>
            <row style={{ alignItems: "center", justifyContent: "space-between", width: "100%" }}>
              <text style={{ fontSize: "14px", fontWeight: 600 }}>
                {n().active_interface ? `Network · ${n().active_interface}` : "Network"}
              </text>
              <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: primary, fontVariantNumeric: "tabular-nums" }}>
                {`↓ ${formatRateBytesPerSec(n().rx_bytes_per_sec)} · ↑ ${formatRateBytesPerSec(n().tx_bytes_per_sec)}`}
              </text>
            </row>
            <DualLineChart
              testId="sysmon-detail-net-chart"
              wide
              primarySeries={props.history()?.net_rx_bytes_per_sec}
              secondarySeries={props.history()?.net_tx_bytes_per_sec}
            />
            <Show when={(n().interfaces?.length ?? 0) > 0}>
              <column style={{ gap: "6px", width: "100%" }}>
                <For each={n().interfaces ?? []} keyed={iface => iface.name}>
                  {iface => (
                    <row style={{
                      alignItems: "center", justifyContent: "space-between", gap: "8px",
                      padding: "8px 10px", borderRadius: "10px", backgroundColor: container,
                    }}>
                      <row style={{ alignItems: "center", gap: "8px" }}>
                        <box ariaHidden style={{
                          width: "6px", height: "6px", borderRadius: "999px", "--zgui-corner-shape": "none",
                          backgroundColor: iface().up ? primary : outline,
                        }} />
                        <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 600 }}>
                          {iface().name}
                        </text>
                      </row>
                      <text data-tabular="true" style={{
                        fontFamily: "var(--font-mono)", fontSize: "10px", color: muted, fontVariantNumeric: "tabular-nums",
                      }}>
                        {`↓ ${formatRateBytesPerSec(iface().rx_bytes_per_sec)} · ↑ ${formatRateBytesPerSec(iface().tx_bytes_per_sec)} · Total ↓${formatBytesShort(iface().session_rx_bytes, true)} ↑${formatBytesShort(iface().session_tx_bytes, true)}`}
                      </text>
                    </row>
                  )}
                </For>
              </column>
            </Show>
          </column>
        )}
      </Show>

      <Show when={storage()}>
        {st => (
          <column style={cardStyle}>
            <row style={{ alignItems: "center", justifyContent: "space-between", width: "100%" }}>
              <text style={{ fontSize: "14px", fontWeight: 600 }}>Disk I/O & local storage</text>
              <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: primary, fontVariantNumeric: "tabular-nums" }}>
                {`R ${formatRateBytesPerSec(st().read_bytes_per_sec)} · W ${formatRateBytesPerSec(st().write_bytes_per_sec)}`}
              </text>
            </row>
            <DualLineChart
              testId="sysmon-detail-disk-chart"
              wide
              primarySeries={props.history()?.disk_read_bytes_per_sec}
              secondarySeries={props.history()?.disk_write_bytes_per_sec}
            />
            <Show when={(st().mounts?.length ?? 0) > 0}>
              <column style={{ gap: "8px", width: "100%", paddingTop: "2px" }}>
                <For each={st().mounts ?? []} keyed={m => m.mount_point}>
                  {(m, idx) => <MountRow mount={m()} primaryFill={idx() === 0} />}
                </For>
              </column>
            </Show>
          </column>
        )}
      </Show>
    </column>
  );
}

function SystemMonitorWindowContent(): NativeChild {
  const {
    theme,
    telemetry,
    systemMonitorWindowTab,
    openSystemMonitorWindow,
    closeSystemMonitorWindow,
  } = useShellStore();
  useShellTheme(theme.data);

  const [timeRange, setTimeRange] = createSignal<TelemetryRangeKey>("60s");
  const [animatePane, setAnimatePane] = createSignal(false);

  const snap = () => telemetry.data();
  const hasGpu = createMemo(() => (snap()?.gpus?.length ?? 0) > 0);
  const mem = createMemo(() => computeMemoryBreakdown(snap()?.memory));
  const primaryGpu = createMemo(() => selectPrimaryGpu(snap()?.gpus));
  const activeHistory = createMemo(() => selectTelemetryHistoryWindow(snap(), timeRange()));
  const pollLabel = createMemo(() => formatPollInterval(snap()?.poll_interval_ms));

  const navItems = createMemo((): readonly MonitorNavItem[] => {
    const items: MonitorNavItem[] = [
      { id: "overview", label: "Overview", heading: "Hardware overview", icon: "dashboard" },
      { id: "cpu", label: "CPU & Thermal", heading: "CPU & thermal", icon: "cpu", readout: percentText(snap()?.cpu_usage_percent) },
      { id: "memory", label: "Memory", heading: "Memory & swap", icon: "memory", readout: mem() ? `${Math.round(mem()!.usedPercent)}%` : "—" },
    ];
    if (hasGpu()) {
      items.push({
        id: "gpu",
        label: "GPU",
        heading: "GPU telemetry",
        icon: "gpu",
        readout: percentText(primaryGpu()?.utilization_percent),
      });
    }
    items.push({ id: "storage", label: "Disk & Network", heading: "Disk & network", icon: "storage" });
    return items;
  });

  const effectiveTab = createMemo((): SystemMonitorTab => {
    const requested = systemMonitorWindowTab();
    if (requested === "gpu" && !hasGpu()) return "overview";
    return requested;
  });

  let seenInitialTab = false;
  createEffect(effectiveTab, () => {
    if (!seenInitialTab) {
      seenInitialTab = true;
      return;
    }
    setAnimatePane(true);
  });

  const activeNavIndex = createMemo(() => navItems().findIndex(item => item.id === effectiveTab()));
  const activeNavItem = createMemo(() => navItems()[Math.max(0, activeNavIndex())] ?? navItems()[0]!);

  const hardwareIdentity = createMemo(() => {
    const parts: string[] = [];
    const model = formatCompactModel(snap()?.cpu?.model_name);
    if (model) parts.push(model);
    const gpuName = primaryGpu()?.name ?? primaryGpu()?.driver;
    if (gpuName) parts.push(gpuName);
    const totalRam = snap()?.memory?.total_bytes;
    if (totalRam && totalRam > 0) {
      parts.push(`${Math.round(totalRam / 1024 ** 3)} GB RAM`);
    }
    return parts.join(" · ") || "System hardware telemetry";
  });

  const statusPillLabel = createMemo(() => {
    const cadence = pollLabel();
    const hasHist = Boolean(snap()?.history);
    if (hasHist && cadence) return `${timeRange()} rolling · ${cadence} live`;
    if (cadence) return `${cadence} live`;
    return "Live snapshot";
  });

  return (
    <row testId="sysmon-window-root" data-theme-rev={String(theme.revision())} style={{
      width: "820px",
      height: "600px",
      overflow: "hidden",
      backgroundColor: container,
      color: onSurface,
      fontFamily: "var(--font-sans)",
      fontSize: "13px",
    }}>
      {/* Left 216px Sidebar */}
      <column testId="sysmon-sidebar" style={{
        width: "216px",
        height: "100%",
        flexShrink: 0,
        backgroundColor: surface,
        borderRight: "1px solid color-mix(in srgb, var(--color-outline-variant) 42%, transparent)",
        padding: "16px 12px",
        justifyContent: "space-between",
      }}>
        <column style={{ gap: "14px" }}>
          <row style={{ alignItems: "center", gap: "10px", padding: "2px 6px" }}>
            <box ariaHidden style={{
              display: "flex", width: "30px", height: "30px", borderRadius: "10px", flexShrink: 0,
              alignItems: "center", justifyContent: "center", backgroundColor: primaryContainer,
            }}>
              <ShellIcon name="pulse" size={16} color={onPrimaryContainer} />
            </box>
            <column style={{ minWidth: "0px" }}>
              <text style={{ fontSize: "14px", fontWeight: 600, lineHeight: "18px" }}>System Monitor</text>
              <text style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: muted, lineHeight: "14px" }}>
                z-shell · telemetry
              </text>
            </column>
          </row>

          <column style={{ gap: "3px" }}>
            <box style={{ padding: "0 8px 4px 8px" }}>
              <text style={{ fontSize: "11px", fontWeight: 600, letterSpacing: "0.04em", color: outline }}>HARDWARE</text>
            </box>
            <column style={{ position: "relative", gap: "3px" }}>
              <SlidingNavPill activeIndex={activeNavIndex} itemCount={() => navItems().length} />
              <For each={navItems()} keyed={item => item.id}>
                {item => {
                  const active = () => effectiveTab() === item().id;
                  return (
                    <Button
                      testId={`sysmon-nav-${item().id}`}
                      data-qs-tile="true"
                      selected={active()}
                      onClick={() => openSystemMonitorWindow(item().id)}
                      style={{
                        position: "relative",
                        zIndex: 1,
                        display: "flex",
                        flexDirection: "row",
                        alignItems: "center",
                        gap: "9px",
                        height: "34px",
                        padding: "0 10px",
                        borderRadius: "10px",
                        flexShrink: 0,
                        backgroundColor: "transparent",
                        border: "1px solid transparent",
                        color: active() ? onPrimaryContainer : muted,
                        fontSize: "13px",
                        fontWeight: 500,
                      }}
                    >
                      <ShellIcon name={item().icon} size={15} color={active() ? onPrimaryContainer : muted} />
                      <text style={{ ...grow, ...clipped }}>{item().label}</text>
                      <Show when={item().readout}>
                        {val => (
                          <text data-tabular="true" style={{
                            fontFamily: "var(--font-mono)", fontSize: "11px", lineHeight: "14px",
                            color: active() ? onPrimaryContainer : muted, flexShrink: 0, fontVariantNumeric: "tabular-nums",
                          }}>
                            {val()}
                          </text>
                        )}
                      </Show>
                    </Button>
                  );
                }}
              </For>
            </column>
          </column>
        </column>

        {/* Bottom Live Cadence Pill */}
        <row testId="sysmon-sidebar-status" style={{
          alignItems: "center", gap: "8px", padding: "8px 10px", borderRadius: "10px", backgroundColor: container,
        }}>
          <box ariaHidden style={{
            width: "6px", height: "6px", borderRadius: "999px", "--zgui-corner-shape": "none",
            flexShrink: 0, backgroundColor: primary,
          }} />
          <text data-tabular="true" style={{
            ...clipped, fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: muted, fontVariantNumeric: "tabular-nums",
          }}>
            {statusPillLabel()}
          </text>
        </row>
      </column>

      {/* Right 604px Detail Pane */}
      <column testId="sysmon-content-pane" style={{
        ...grow,
        height: "100%",
        padding: "16px 20px",
        gap: "12px",
        overflow: "hidden",
      }}>
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "12px", width: "100%", flexShrink: 0 }}>
          <column style={{ ...grow, gap: "2px" }}>
            <text role="heading" style={{ fontSize: "18px", fontWeight: 600, letterSpacing: "-0.015em", lineHeight: "24px" }}>
              {activeNavItem().heading}
            </text>
            <text testId="sysmon-window-identity" style={{
              ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted, lineHeight: "15px",
            }}>
              {hardwareIdentity()}
            </text>
          </column>
          <row style={{ alignItems: "center", gap: "8px", flexShrink: 0 }}>
            <Show when={Boolean(snap()?.history)}>
              <M3SegmentedControl
                options={RANGE_OPTIONS}
                value={timeRange()}
                onChange={setTimeRange}
                ariaLabel="History time range"
                compact
                recessed="surface"
                style={{ width: "126px" }}
              />
            </Show>
            <Button
              testId="sysmon-window-close"
              ariaLabel="Close system monitor"
              onClick={closeSystemMonitorWindow}
              style={{
                display: "flex", width: "30px", height: "30px", borderRadius: "10px", flexShrink: 0,
                alignItems: "center", justifyContent: "center", backgroundColor: containerHigh,
              }}
            >
              <ShellIcon name="close" size={15} color={muted} />
            </Button>
          </row>
        </row>

        <scroll testId="sysmon-content-scroll" style={{ ...grow, minHeight: "0px", width: "100%", overflow: "hidden auto" }}>
          <Switch fallback={
            <FadeThroughPane animate={animatePane()}>
              <OverviewPane snap={snap} history={activeHistory} />
            </FadeThroughPane>
          }>
            <Match when={effectiveTab() === "overview"}>
              <FadeThroughPane animate={animatePane()}>
                <OverviewPane snap={snap} history={activeHistory} />
              </FadeThroughPane>
            </Match>
            <Match when={effectiveTab() === "cpu"}>
              <FadeThroughPane animate={animatePane()}>
                <CpuThermalPane snap={snap} history={activeHistory} />
              </FadeThroughPane>
            </Match>
            <Match when={effectiveTab() === "memory"}>
              <FadeThroughPane animate={animatePane()}>
                <MemoryPane snap={snap} history={activeHistory} />
              </FadeThroughPane>
            </Match>
            <Match when={effectiveTab() === "gpu"}>
              <FadeThroughPane animate={animatePane()}>
                <GpuPane snap={snap} history={activeHistory} />
              </FadeThroughPane>
            </Match>
            <Match when={effectiveTab() === "storage"}>
              <FadeThroughPane animate={animatePane()}>
                <DiskNetworkPane snap={snap} history={activeHistory} />
              </FadeThroughPane>
            </Match>
          </Switch>
        </scroll>
      </column>
    </row>
  );
}

export function SystemMonitorWindow(): NativeChild {
  const { systemMonitorWindowOpen, closeSystemMonitorWindow } = useShellStore();
  return (
    <SingleInstanceWindowSurface
      open={systemMonitorWindowOpen}
      onClose={closeSystemMonitorWindow}
      name="system-monitor-window"
      title="z-shell System Monitor"
      appId="dev.zshell.shell.monitor"
      width={820}
      height={600}
    >
      <SystemMonitorWindowContent />
    </SingleInstanceWindowSurface>
  );
}
