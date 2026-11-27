import {
  Button, For, Match, Show, Switch,
  createEffect, createMemo, createSignal, cx,
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
  selectNetworkDisplay,
  selectPrimaryGpu,
  selectTelemetryHistoryWindow,
  type SystemTelemetrySnapshot,
  type TelemetryGpuInfo,
  type TelemetryHistoryWindow,
  type TelemetryMount,
  type TelemetryRangeKey,
} from "../topics.ts";
import styles from "./SystemMonitorWindow.module.css";
import { FadeThroughPane, SingleInstanceWindowSurface, SlidingNavPill } from "./window-chrome.tsx";

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
  return (
    <row
      ariaLabel="Memory allocation bar"
      class={styles.memoryBar}
      style={{ height: `${props.height ?? 8}px` }}
    >
      <Show when={props.activePct > 0.5}>
        <box
          data-percent-fill="true"
          ariaHidden
          class={styles.memoryBarActive}
          style={{ width: `${props.activePct.toFixed(2)}%` }}
        />
      </Show>
      <Show when={props.cachePct > 0.5}>
        <box
          data-percent-fill="true"
          ariaHidden
          class={styles.memoryBarCache}
          style={{ width: `${props.cachePct.toFixed(2)}%` }}
        />
      </Show>
    </row>
  );
}

function SimpleProgressBar(props: {
  readonly percent: number;
  readonly tone?: "primary" | "primary-container" | "tertiary";
  readonly height?: number;
}): NativeChild {
  const clamped = () => Math.max(0, Math.min(100, props.percent));
  return (
    <box
      ariaHidden
      class={styles.progressTrack}
      style={{ height: `${props.height ?? 6}px` }}
    >
      <Show when={clamped() > 0.5}>
        <box
          data-percent-fill="true"
          ariaHidden
          class={styles.progressFill}
          data-tone={props.tone ?? "primary"}
          style={{ width: `${clamped().toFixed(2)}%` }}
        />
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
    <column class={styles.mountRow}>
      <row class={styles.mountHeader}>
        <text class={styles.mountLabel}>
          {label()}
        </text>
        <text data-tabular="true" class={styles.monoSmallMutedShrink0}>
          {`${pct()}% · ${freeStr()}`}
        </text>
      </row>
      <SimpleProgressBar percent={pct()} tone={props.primaryFill ? "primary" : "primary-container"} height={6} />
    </column>
  );
}

interface PaneChartProps {
  readonly snap: Accessor<SystemTelemetrySnapshot | undefined>;
  readonly history: Accessor<TelemetryHistoryWindow | null>;
  readonly timeRange: Accessor<TelemetryRangeKey>;
  readonly sourceBaseline: Accessor<boolean>;
  readonly revision: Accessor<number>;
}

function OverviewPane(props: PaneChartProps): NativeChild {
  const mem = createMemo(() => computeMemoryBreakdown(props.snap()?.memory));
  const gpu = createMemo(() => selectPrimaryGpu(props.snap()?.gpus));
  const netDisplay = createMemo(() => selectNetworkDisplay(props.snap()?.network, props.history()));
  const headlineTemp = createMemo(() => selectHeadlineTempCelsius(props.snap()));
  const cpuCores = () => props.snap()?.cpu?.per_core_usage_percent ?? [];
  const coreCount = () => props.snap()?.cpu?.core_count ?? cpuCores().length;

  const cpuHeaderMeta = createMemo(() => {
    const parts: string[] = [];
    const freq = formatFrequencyMhz(props.snap()?.cpu?.frequency_mhz, 2);
    if (freq) parts.push(freq);
    const load1 = props.snap()?.cpu?.load_average?.[0];
    if (load1 !== undefined && load1 !== null && Number.isFinite(load1)) {
      parts.push(`Load ${load1.toFixed(2)}`);
    }
    const temp = headlineTemp();
    if (temp !== null) parts.push(`${temp}°C`);
    return parts.join(" · ");
  });

  const thermalStrip = createMemo(() => {
    const sensors = props.snap()?.sensors ?? [];
    if (sensors.length > 0) {
      return sensors.slice(0, 4).map(s => ({
        label: s.label,
        temp: `${Math.round(s.temperature_millicelsius / 1000)}°C`,
        highlight: s.category === "cpu",
      }));
    }
    return (props.snap()?.temperatures ?? []).slice(0, 4).map((z, idx) => ({
      label: z.kind,
      temp: `${Math.round(z.temperature_millicelsius / 1000)}°C`,
      highlight: idx === 0,
    }));
  });

  const mounts = () => (props.snap()?.storage?.mounts ?? []).slice(0, 2);

  return (
    <column testId="sysmon-overview-pane" class={styles.paneStack}>
      {/* Row 1: CPU Utilization + Per-Core */}
      <column class={cx(styles.card, styles.fullWidth)}>
        <row class={styles.cardHeader}>
          <row class={styles.cpuTitleGroup}>
            <text class={styles.cardTitleShrink0}>CPU Utilization</text>
            <Show when={cpuHeaderMeta().length > 0}>
              <text data-tabular="true" class={styles.detailMetaMono}>
                {cpuHeaderMeta()}
              </text>
            </Show>
          </row>
          <text testId="sysmon-win-cpu-pct" data-tabular="true" class={styles.cpuHeroPct}>
            {percentText(props.snap()?.cpu_usage_percent)}
          </text>
        </row>
        <row class={styles.cardRow}>
          <box class={styles.grow}>
            <AreaLineChart
              testId="sysmon-win-cpu-chart"
              variant="window"
              wide={cpuCores().length === 0}
              values={props.history()?.cpu_percent}
              maxValue={100}
              bucketSeconds={props.history()?.bucket_seconds}
              latestBucketId={props.history()?.latest_bucket_id}
              resetKey={props.timeRange()}
              sourceBaseline={props.sourceBaseline()}
              revision={props.revision()}
              emptyLabel="Live CPU readout only"
            />
          </box>
          <Show when={cpuCores().length > 0}>
            <column class={styles.perCoreCard}>
              <text data-tabular="true" class={styles.perCoreLabel}>
                {`PER CORE (${coreCount()})`}
              </text>
              <PerCoreBarChart cores={cpuCores()} height={52} maxBars={16} />
            </column>
          </Show>
        </row>
      </column>

      {/* Row 2: Memory & Swap | GPU */}
      <row class={styles.cardRow}>
        <Show when={mem()}>
          {breakdown => {
            const swap = () => props.snap()?.swap;
            return (
              <column class={cx(styles.card, styles.grow, styles.spaceBetween)}>
                <row class={styles.cardHeader}>
                  <text class={styles.cardTitle}>Memory & Swap</text>
                  <text data-tabular="true" class={styles.cardPctAccent}>
                    {`${Math.round(breakdown().usedPercent)}%`}
                  </text>
                </row>
                <text data-tabular="true" class={cx(styles.clipped, styles.monoBodyMuted)}>
                  {breakdown().cacheBytes !== null
                    ? `${(breakdown().usedBytes / 1024 ** 3).toFixed(1)} / ${formatBytesDecimalGB(breakdown().totalBytes, 1)} active · ${formatBytesDecimalGB(breakdown().cacheBytes!, 1)} cache`
                    : `${(breakdown().usedBytes / 1024 ** 3).toFixed(1)} / ${formatBytesDecimalGB(breakdown().totalBytes, 1)} used`}
                </text>
                <MemorySegmentedBar activePct={breakdown().activePercent} cachePct={breakdown().cachePercent} height={8} />
                <row class={styles.cardFooterRow}>
                  <text data-tabular="true" class={cx(styles.clipped, styles.monoSmallMuted)}>
                    {swap() && swap()!.total_bytes > 0
                      ? `Swap ${(swap()!.used_bytes / 1024 ** 3).toFixed(1)} / ${formatBytesDecimalGB(swap()!.total_bytes, 1)}`
                      : "Swap inactive"}
                  </text>
                  <text data-tabular="true" class={styles.monoSmallMutedShrink0}>
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
              <column testId="sysmon-overview-gpu" class={cx(styles.card, styles.grow, styles.spaceBetween)}>
                <row class={styles.cardHeader}>
                  <text class={cx(styles.clipped, styles.cardTitle)}>
                    {card().name ? `GPU · ${card().name}` : `GPU · ${card().driver ?? card().id}`}
                  </text>
                  <text data-tabular="true" class={styles.cardPctAccent}>
                    {percentText(card().utilization_percent)}
                  </text>
                </row>
                <text data-tabular="true" class={cx(styles.clipped, styles.monoBodyMuted)}>
                  {gpuMetrics()}
                </text>
                <SimpleProgressBar percent={vramPct()} tone="primary" height={8} />
                <row class={styles.cardFooterRow}>
                  <text data-tabular="true" class={cx(styles.clipped, styles.monoSmallMuted)}>
                    {card().clock_mhz != null ? `SCLK ${card().clock_mhz} MHz` : (card().pci_slot ?? card().id)}
                  </text>
                  <text class={styles.monoSmallMutedShrink0}>
                    {card().driver ? `drm / ${card().driver}` : "drm"}
                  </text>
                </row>
              </column>
            );
          }}
        </Show>
      </row>

      {/* Row 3: Network | Disk I/O & Storage */}
      <Show when={Boolean(netDisplay() || props.snap()?.storage)}>
        <row class={styles.cardRow}>
          <Show when={netDisplay()}>
            {net => (
              <column class={cx(styles.card, styles.grow, styles.spaceBetween)}>
                <row class={styles.cardHeader}>
                  <text testId="sysmon-win-net-title" class={cx(styles.clipped, styles.cardTitle)}>
                    {net().label ? `Network · ${net().label}` : "Network"}
                  </text>
                  <text testId="sysmon-win-net-rx" data-tabular="true" class={styles.netRateAccent}>
                    {`↓ ${formatRateBytesPerSec(net().rxBytesPerSec)}`}
                  </text>
                </row>
                <DualLineChart
                  testId="sysmon-win-net-chart"
                  compact
                  wide={!props.snap()?.storage}
                  primarySeries={net().rxHistory}
                  secondarySeries={net().txHistory}
                  bucketSeconds={props.history()?.bucket_seconds}
                  latestBucketId={props.history()?.latest_bucket_id}
                  resetKey={props.timeRange()}
                  sourceBaseline={props.sourceBaseline()}
                  revision={props.revision()}
                  emptyLabel="Live interface counters"
                />
                <row class={styles.cardFooterRow}>
                  <text data-tabular="true" class={styles.monoSmallMuted}>
                    {`↑ ${formatRateBytesPerSec(net().txBytesPerSec)}`}
                  </text>
                  <text data-tabular="true" class={cx(styles.clipped, styles.monoSmallMuted)}>
                    {`Total ↓${formatBytesShort(net().sessionRxBytes, true)} · ↑${formatBytesShort(net().sessionTxBytes, true)}`}
                  </text>
                </row>
              </column>
            )}
          </Show>

          <Show when={props.snap()?.storage}>
            {storage => (
              <column class={cx(styles.card, styles.grow, styles.spaceBetween)}>
                <row class={styles.cardHeaderTight}>
                  <text class={styles.cardTitleShrink0}>Disk I/O & Storage</text>
                  <text data-tabular="true" class={cx(styles.clipped, styles.monoSmallMuted)}>
                    {`R ${formatRateBytesPerSec(storage().read_bytes_per_sec)} · W ${formatRateBytesPerSec(storage().write_bytes_per_sec)}`}
                  </text>
                </row>
                <Show when={mounts().length > 0} fallback={
                  <DualLineChart
                    testId="sysmon-win-disk-chart"
                    compact
                    wide={!props.snap()?.network}
                    primarySeries={props.history()?.disk_read_bytes_per_sec}
                    secondarySeries={props.history()?.disk_write_bytes_per_sec}
                    bucketSeconds={props.history()?.bucket_seconds}
                    latestBucketId={props.history()?.latest_bucket_id}
                    resetKey={props.timeRange()}
                    sourceBaseline={props.sourceBaseline()}
                    revision={props.revision()}
                    emptyLabel="No local mount summaries"
                  />
                }>
                  <column class={styles.mountListOverview}>
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
        <row testId="sysmon-thermals-strip" class={styles.thermalsStrip}>
          <text class={styles.thermalsTitle}>Thermals</text>
          <row class={styles.thermalsItems}>
            <For each={thermalStrip()} keyed={s => s.label}>
              {sensor => (
                <row class={styles.thermalItem}>
                  <text class={styles.thermalLabel}>{sensor().label}</text>
                  <text
                    data-tabular="true"
                    class={styles.thermalValue}
                    data-highlight={sensor().highlight ? "true" : "false"}
                  >
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

function CpuThermalPane(props: PaneChartProps): NativeChild {
  const cpu = () => props.snap()?.cpu;
  const cores = () => (cpu()?.per_core_usage_percent ?? []).map((val, idx) => ({ idx, val }));
  const sensors = () => props.snap()?.sensors ?? [];
  const zones = () => props.snap()?.temperatures ?? [];

  return (
    <column testId="sysmon-cpu-pane" class={styles.paneStack}>
      <column class={styles.card}>
        <row class={styles.cardHeaderFlush}>
          <column class={cx(styles.titleCol, styles.grow)}>
            <text class={styles.detailCardTitle}>
              {cpu()?.model_name ?? "Processor"}
            </text>
            <text data-tabular="true" class={styles.detailMetaMono}>
              {[
                cpu()?.core_count ? `${cpu()!.core_count} logical cores` : "",
                formatFrequencyMhz(cpu()?.frequency_mhz, 2),
                formatUptimeCompact(cpu()?.uptime_seconds) ? `Up ${formatUptimeCompact(cpu()?.uptime_seconds)}` : "",
              ].filter(Boolean).join(" · ") || "CPU telemetry"}
            </text>
          </column>
          <text data-tabular="true" class={styles.detailHeroPct}>
            {percentText(props.snap()?.cpu_usage_percent)}
          </text>
        </row>
        <AreaLineChart
          testId="sysmon-detail-cpu-chart"
          variant="detail"
          values={props.history()?.cpu_percent}
          maxValue={100}
          bucketSeconds={props.history()?.bucket_seconds}
          latestBucketId={props.history()?.latest_bucket_id}
          resetKey={props.timeRange()}
          sourceBaseline={props.sourceBaseline()}
          revision={props.revision()}
        />
        <Show when={cpu()?.load_average}>
          {load => (
            <row class={styles.statRow}>
              <For each={[
                { label: "Load 1m", value: load()[0].toFixed(2) },
                { label: "Load 5m", value: load()[1].toFixed(2) },
                { label: "Load 15m", value: load()[2].toFixed(2) },
              ]} keyed={item => item.label}>
                {item => (
                  <row class={styles.loadStatItem}>
                    <text class={styles.loadStatLabel}>{item().label}</text>
                    <text data-tabular="true" class={styles.loadStatValue}>
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
        <column class={styles.card}>
          <row class={styles.cardHeaderFlush}>
            <text class={styles.cardTitle}>Per-core utilization</text>
            <text data-tabular="true" class={styles.perCoreCount}>
              {`${cores().length} cores`}
            </text>
          </row>
          <box class={styles.perCoreDetailWell}>
            <PerCoreBarChart cores={cpu()?.per_core_usage_percent ?? []} height={72} maxBars={32} />
          </box>
        </column>
      </Show>

      <Show when={sensors().length > 0 || zones().length > 0}>
        <column class={styles.card}>
          <text class={styles.cardTitle}>Thermal sensors</text>
          <Show when={sensors().length > 0} fallback={
            <column class={styles.subList}>
              <For each={zones()} keyed={z => z.zone}>
                {z => (
                  <row class={styles.subRow}>
                    <text class={styles.zoneLabel}>{z().kind}</text>
                    <text data-tabular="true" class={styles.zoneValue}>
                      {`${Math.round(z().temperature_millicelsius / 1000)}°C`}
                    </text>
                  </row>
                )}
              </For>
            </column>
          }>
            <column class={styles.subList}>
              <For each={sensors()} keyed={s => `${s.label}:${s.source}`}>
                {s => (
                  <row class={styles.subRow}>
                    <row class={styles.sensorLeft}>
                      <text class={styles.sensorLabel}>{s().label}</text>
                      <text class={styles.sensorSource}>
                        {s().source}
                      </text>
                    </row>
                    <text
                      data-tabular="true"
                      class={styles.sensorValue}
                      data-highlight={s().category === "cpu" ? "true" : "false"}
                    >
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

function MemoryPane(props: PaneChartProps): NativeChild {
  const mem = createMemo(() => computeMemoryBreakdown(props.snap()?.memory));
  const rawMem = () => props.snap()?.memory;
  const swap = () => props.snap()?.swap;

  return (
    <column testId="sysmon-memory-pane" class={styles.paneStack}>
      <Show when={mem()} fallback={
        <box class={cx(styles.card, styles.emptyCard)}>
          <text class={styles.emptyText}>Memory telemetry unavailable</text>
        </box>
      }>
        {breakdown => (
          <>
            <column class={styles.card}>
              <row class={styles.cardHeaderFlush}>
                <column class={styles.titleCol}>
                  <text class={styles.detailCardTitle}>System RAM</text>
                  <text data-tabular="true" class={styles.monoBodyMutedTall}>
                    {`${formatBytesDecimalGB(breakdown().usedBytes, 1)} used of ${formatBytesDecimalGB(breakdown().totalBytes, 1)}`}
                  </text>
                </column>
                <text data-tabular="true" class={styles.detailHeroPct}>
                  {`${Math.round(breakdown().usedPercent)}%`}
                </text>
              </row>
              <AreaLineChart
                testId="sysmon-detail-memory-chart"
                variant="detail"
                values={props.history()?.memory_percent}
                maxValue={100}
                bucketSeconds={props.history()?.bucket_seconds}
                latestBucketId={props.history()?.latest_bucket_id}
                resetKey={props.timeRange()}
                sourceBaseline={props.sourceBaseline()}
                revision={props.revision()}
              />
              <MemorySegmentedBar activePct={breakdown().activePercent} cachePct={breakdown().cachePercent} height={10} />
              <row class={styles.statRow}>
                <For each={[
                  { label: "Active", value: formatBytesDecimalGB(breakdown().usedBytes, 1) },
                  { label: "Available", value: formatBytesDecimalGB(breakdown().availableBytes, 1) },
                  ...(breakdown().cacheBytes !== null ? [{ label: "Page cache", value: formatBytesDecimalGB(breakdown().cacheBytes!, 1) }] : []),
                ]} keyed={item => item.label}>
                  {item => (
                    <column class={styles.statTile}>
                      <text class={styles.statTileLabel}>{item().label}</text>
                      <text data-tabular="true" class={styles.statTileValueLg}>
                        {item().value}
                      </text>
                    </column>
                  )}
                </For>
              </row>
            </column>

            <Show when={rawMem()?.buffers_bytes != null || rawMem()?.reclaimable_bytes != null}>
              <column class={styles.card}>
                <text class={styles.cardTitle}>Kernel cache breakdown</text>
                <row class={styles.statRow}>
                  <Show when={rawMem()?.cached_bytes != null}>
                    <column class={styles.statTile}>
                      <text class={styles.statTileLabel}>Cached</text>
                      <text data-tabular="true" class={styles.statTileValue}>
                        {formatBytesDecimalGB(rawMem()!.cached_bytes!, 1)}
                      </text>
                    </column>
                  </Show>
                  <Show when={rawMem()?.buffers_bytes != null}>
                    <column class={styles.statTile}>
                      <text class={styles.statTileLabel}>Buffers</text>
                      <text data-tabular="true" class={styles.statTileValue}>
                        {formatBytesDecimalGB(rawMem()!.buffers_bytes!, 1)}
                      </text>
                    </column>
                  </Show>
                  <Show when={rawMem()?.reclaimable_bytes != null}>
                    <column class={styles.statTile}>
                      <text class={styles.statTileLabel}>Reclaimable</text>
                      <text data-tabular="true" class={styles.statTileValue}>
                        {formatBytesDecimalGB(rawMem()!.reclaimable_bytes!, 1)}
                      </text>
                    </column>
                  </Show>
                </row>
              </column>
            </Show>

            <Show when={swap() && swap()!.total_bytes > 0}>
              <column class={styles.card}>
                <row class={styles.cardHeaderFlush}>
                  <text class={styles.cardTitle}>Swap</text>
                  <text data-tabular="true" class={styles.mono12Bold}>
                    {`${formatBytesDecimalGB(swap()!.used_bytes, 1)} / ${formatBytesDecimalGB(swap()!.total_bytes, 1)}`}
                  </text>
                </row>
                <SimpleProgressBar
                  percent={(swap()!.used_bytes / swap()!.total_bytes) * 100}
                  tone="tertiary"
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

function GpuCardDetail(props: {
  readonly gpu: TelemetryGpuInfo;
  readonly primaryHistory?: readonly (number | null)[] | undefined;
  readonly bucketSeconds?: number | undefined;
  readonly latestBucketId?: number | null | undefined;
  readonly resetKey?: TelemetryRangeKey | undefined;
  readonly sourceBaseline?: boolean | undefined;
  readonly revision?: number | undefined;
}): NativeChild {
  const vramPct = () => {
    const u = props.gpu.vram_used_bytes;
    const t = props.gpu.vram_total_bytes;
    return u != null && t != null && t > 0 ? (u / t) * 100 : null;
  };
  return (
    <column class={styles.card}>
      <row class={styles.cardHeaderFlush}>
        <column class={cx(styles.titleCol, styles.grow)}>
          <text class={cx(styles.clipped, styles.detailCardTitle)}>
            {props.gpu.name ?? props.gpu.driver ?? props.gpu.id}
          </text>
          <text class={styles.detailSubMono}>
            {[props.gpu.id, props.gpu.driver ? `drm / ${props.gpu.driver}` : "", props.gpu.pci_slot ?? ""].filter(Boolean).join(" · ")}
          </text>
        </column>
        <text data-tabular="true" class={styles.cpuHeroPct}>
          {percentText(props.gpu.utilization_percent)}
        </text>
      </row>

      <Show when={props.primaryHistory && props.primaryHistory.length > 0}>
        <AreaLineChart
          testId="sysmon-detail-gpu-chart"
          variant="detail"
          values={props.primaryHistory}
          maxValue={100}
          bucketSeconds={props.bucketSeconds}
          latestBucketId={props.latestBucketId}
          resetKey={props.resetKey}
          sourceBaseline={props.sourceBaseline}
          revision={props.revision}
        />
      </Show>

      <Show when={vramPct() !== null}>
        <column class={styles.vramSection}>
          <row class={styles.cardHeaderFlush}>
            <text class={styles.statTileLabel}>VRAM</text>
            <text data-tabular="true" class={styles.vramValue}>
              {`${(props.gpu.vram_used_bytes! / 1024 ** 3).toFixed(1)} / ${formatBytesDecimalGB(props.gpu.vram_total_bytes!, 1)}`}
            </text>
          </row>
          <SimpleProgressBar percent={vramPct()!} tone="primary" height={8} />
        </column>
      </Show>

      <row class={styles.statRow}>
        <Show when={props.gpu.temperature_millicelsius != null}>
          <column class={styles.statTile}>
            <text class={styles.statTileLabel}>Temperature</text>
            <text data-tabular="true" class={styles.statTileValue}>
              {`${Math.round(props.gpu.temperature_millicelsius! / 1000)}°C`}
            </text>
          </column>
        </Show>
        <Show when={props.gpu.power_milliwatts != null}>
          <column class={styles.statTile}>
            <text class={styles.statTileLabel}>Power</text>
            <text data-tabular="true" class={styles.statTileValue}>
              {`${(props.gpu.power_milliwatts! / 1000).toFixed(1)} W`}
            </text>
          </column>
        </Show>
        <Show when={props.gpu.clock_mhz != null}>
          <column class={styles.statTile}>
            <text class={styles.statTileLabel}>Clock (SCLK)</text>
            <text data-tabular="true" class={styles.statTileValue}>
              {`${props.gpu.clock_mhz} MHz`}
            </text>
          </column>
        </Show>
      </row>
    </column>
  );
}

function GpuPane(props: PaneChartProps): NativeChild {
  const gpus = () => props.snap()?.gpus ?? [];
  return (
    <column testId="sysmon-gpu-pane" class={styles.paneStack}>
      <For each={gpus()} keyed={g => g.id}>
        {(gpu, idx) => (
          <GpuCardDetail
            gpu={gpu()}
            primaryHistory={idx() === 0 ? props.history()?.gpu_percent : undefined}
            bucketSeconds={props.history()?.bucket_seconds}
            latestBucketId={props.history()?.latest_bucket_id}
            resetKey={props.timeRange()}
            sourceBaseline={props.sourceBaseline()}
            revision={props.revision()}
          />
        )}
      </For>
    </column>
  );
}

function DiskNetworkPane(props: PaneChartProps): NativeChild {
  const net = () => props.snap()?.network;
  const netDisplay = createMemo(() => selectNetworkDisplay(net(), props.history()));
  const storage = () => props.snap()?.storage;

  return (
    <column testId="sysmon-storage-pane" class={styles.paneStack}>
      <Show when={netDisplay()}>
        {nd => (
          <column class={styles.card}>
            <row class={styles.cardHeaderFlush}>
              <text testId="sysmon-detail-net-title" class={styles.detailCardTitle}>
                {nd().label ? `Network · ${nd().label}` : "Network"}
              </text>
              <text testId="sysmon-detail-net-rates" data-tabular="true" class={styles.detailRateAccent}>
                {`↓ ${formatRateBytesPerSec(nd().rxBytesPerSec)} · ↑ ${formatRateBytesPerSec(nd().txBytesPerSec)}`}
              </text>
            </row>
            <DualLineChart
              testId="sysmon-detail-net-chart"
              wide
              primarySeries={nd().rxHistory}
              secondarySeries={nd().txHistory}
              bucketSeconds={props.history()?.bucket_seconds}
              latestBucketId={props.history()?.latest_bucket_id}
              resetKey={props.timeRange()}
              sourceBaseline={props.sourceBaseline()}
              revision={props.revision()}
            />
            <Show when={(net()?.interfaces?.length ?? 0) > 0}>
              <column class={styles.subList}>
                <For each={net()?.interfaces ?? []} keyed={iface => iface.name}>
                  {iface => (
                    <row class={styles.subRowGap}>
                      <row class={styles.ifaceLeft}>
                        <box
                          ariaHidden
                          class={styles.ifaceDot}
                          data-up={iface().up ? "true" : "false"}
                        />
                        <text class={styles.ifaceName}>
                          {iface().name}
                        </text>
                      </row>
                      <text data-tabular="true" class={styles.monoSmallMuted}>
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
          <column class={styles.card}>
            <row class={styles.cardHeaderFlush}>
              <text class={styles.detailCardTitle}>Disk I/O & local storage</text>
              <text data-tabular="true" class={styles.detailRateAccent}>
                {`R ${formatRateBytesPerSec(st().read_bytes_per_sec)} · W ${formatRateBytesPerSec(st().write_bytes_per_sec)}`}
              </text>
            </row>
            <DualLineChart
              testId="sysmon-detail-disk-chart"
              wide
              primarySeries={props.history()?.disk_read_bytes_per_sec}
              secondarySeries={props.history()?.disk_write_bytes_per_sec}
              bucketSeconds={props.history()?.bucket_seconds}
              latestBucketId={props.history()?.latest_bucket_id}
              resetKey={props.timeRange()}
              sourceBaseline={props.sourceBaseline()}
              revision={props.revision()}
            />
            <Show when={(st().mounts?.length ?? 0) > 0}>
              <column class={styles.mountListDetail}>
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
    <row testId="sysmon-window-root" data-theme-rev={String(theme.revision())} class={styles.root}>
      {/* Left 216px Sidebar */}
      <column testId="sysmon-sidebar" class={styles.sidebar}>
        <column class={styles.sidebarTop}>
          <row class={styles.brandHeader}>
            <box ariaHidden class={styles.brandBadge}>
              <ShellIcon name="pulse" size={16} color="var(--color-on-primary-container)" />
            </box>
            <column class={styles.brandTextCol}>
              <text class={styles.brandTitle}>System Monitor</text>
              <text class={styles.brandSubtitle}>
                z-shell · telemetry
              </text>
            </column>
          </row>

          <column class={styles.navSection}>
            <box class={styles.navSectionHeader}>
              <text class={styles.navSectionTitle}>HARDWARE</text>
            </box>
            <column class={styles.navTrack}>
              <SlidingNavPill activeIndex={activeNavIndex} itemCount={() => navItems().length} />
              <For each={navItems()} keyed={item => item.id}>
                {item => {
                  const active = () => effectiveTab() === item().id;
                  return (
                    <Button
                      testId={`sysmon-nav-${item().id}`}
                      data-qs-tile="true"
                      data-active={active() ? "true" : "false"}
                      selected={active()}
                      class={styles.navItem}
                      onClick={() => openSystemMonitorWindow(item().id)}
                    >
                      <ShellIcon
                        name={item().icon}
                        size={15}
                        color={active() ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)"}
                      />
                      <text class={cx(styles.grow, styles.clipped)}>{item().label}</text>
                      <Show when={item().readout}>
                        {val => (
                          <text
                            data-tabular="true"
                            class={styles.navReadout}
                            data-active={active() ? "true" : "false"}
                          >
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
        <row testId="sysmon-sidebar-status" class={styles.statusPill}>
          <box ariaHidden class={styles.statusDot} />
          <text data-tabular="true" class={styles.statusText}>
            {statusPillLabel()}
          </text>
        </row>
      </column>

      {/* Right 604px Detail Pane */}
      <column testId="sysmon-content-pane" class={styles.contentPane}>
        <row class={styles.contentHeader}>
          <column class={styles.headerTextCol}>
            <text role="heading" class={styles.headerTitle}>
              {activeNavItem().heading}
            </text>
            <text testId="sysmon-window-identity" class={styles.headerIdentity}>
              {hardwareIdentity()}
            </text>
          </column>
          <row class={styles.headerActions}>
            <Show when={Boolean(snap()?.history)}>
              <box class={styles.rangeControl}>
                <M3SegmentedControl
                  options={RANGE_OPTIONS}
                  value={timeRange()}
                  onChange={setTimeRange}
                  ariaLabel="History time range"
                  compact
                  recessed="surface"
                />
              </box>
            </Show>
            <Button
              testId="sysmon-window-close"
              ariaLabel="Close system monitor"
              class={styles.closeButton}
              onClick={closeSystemMonitorWindow}
            >
              <ShellIcon name="close" size={15} color="var(--color-on-surface-variant)" />
            </Button>
          </row>
        </row>

        <scroll testId="sysmon-content-scroll" class={styles.contentScroll}>
          <Switch fallback={
            <FadeThroughPane animate={animatePane()}>
              <OverviewPane snap={snap} history={activeHistory} timeRange={timeRange} sourceBaseline={telemetry.sourceBaseline} revision={telemetry.revision} />
            </FadeThroughPane>
          }>
            <Match when={effectiveTab() === "overview"}>
              <FadeThroughPane animate={animatePane()}>
                <OverviewPane snap={snap} history={activeHistory} timeRange={timeRange} sourceBaseline={telemetry.sourceBaseline} revision={telemetry.revision} />
              </FadeThroughPane>
            </Match>
            <Match when={effectiveTab() === "cpu"}>
              <FadeThroughPane animate={animatePane()}>
                <CpuThermalPane snap={snap} history={activeHistory} timeRange={timeRange} sourceBaseline={telemetry.sourceBaseline} revision={telemetry.revision} />
              </FadeThroughPane>
            </Match>
            <Match when={effectiveTab() === "memory"}>
              <FadeThroughPane animate={animatePane()}>
                <MemoryPane snap={snap} history={activeHistory} timeRange={timeRange} sourceBaseline={telemetry.sourceBaseline} revision={telemetry.revision} />
              </FadeThroughPane>
            </Match>
            <Match when={effectiveTab() === "gpu"}>
              <FadeThroughPane animate={animatePane()}>
                <GpuPane snap={snap} history={activeHistory} timeRange={timeRange} sourceBaseline={telemetry.sourceBaseline} revision={telemetry.revision} />
              </FadeThroughPane>
            </Match>
            <Match when={effectiveTab() === "storage"}>
              <FadeThroughPane animate={animatePane()}>
                <DiskNetworkPane snap={snap} history={activeHistory} timeRange={timeRange} sourceBaseline={telemetry.sourceBaseline} revision={telemetry.revision} />
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
