import { For, Show, createEffect, createMemo, createSignal, cx, onCleanup, type NativeChild } from "@hewel/zgui";
import { useGlobalMotionScheme } from "@z-shell/sdk/zgui";
import {
  buildSparklinePaths,
  buildSplitDualArcPaths,
  createChartScrollController,
  formatThroughputAxisLabel,
  resolveThroughputScale,
  type ChartScrollFrame,
} from "../charts.ts";
import { ShellIcon } from "../icons.tsx";
import styles from "./TelemetryCharts.module.css";

const primary = "var(--color-primary)";
const tertiary = "var(--color-tertiary)";

const ROLLING_SLOT_COUNT = 60;
const MINI_SPARKLINE_SLOTS = 30;

/** Compact 36x16 inline CPU sparkline for the horizontal StatusBar trigger (right-aligned, zero motion tickers). */
export function MiniSparkline(props: {
  readonly values: readonly (number | null)[] | null | undefined;
  readonly color?: string;
}): NativeChild {
  const paths = createMemo(() =>
    buildSparklinePaths(props.values, {
      width: 36,
      height: 16,
      paddingX: 1.5,
      paddingTop: 2.5,
      paddingBottom: 2.5,
      maxValue: 100,
      smooth: false,
      slotCount: MINI_SPARKLINE_SLOTS,
    }),
  );
  const strokeColor = () => props.color ?? primary;

  return (
    <box ariaHidden class={styles.miniSparklineRoot}>
      <Show when={paths().hasData} fallback={<box ariaHidden class={styles.miniSparklineEmpty} />}>
        <vector
          ariaHidden
          viewBox="0 0 36 16"
          d={paths().strokePath}
          class={styles.miniSparklineVector}
          style={{ "--zgui-stroke": strokeColor() }}
        />
      </Show>
    </box>
  );
}

/** 30x30 Split Dual-Arc circular gauge for the vertical StatusBar trigger (CPU left / RAM right). */
export function SplitDualArcGauge(props: {
  readonly cpuPercent: number | null | undefined;
  readonly ramPercent: number | null | undefined;
  readonly size?: number;
  readonly iconColor?: string;
}): NativeChild {
  const size = () => props.size ?? 30;
  const compact = () => (size() <= 28 ? "true" : "false");
  const arcs = createMemo(() => buildSplitDualArcPaths(props.cpuPercent, props.ramPercent));
  const vecSizeStyle = () => ({ width: `${size()}px`, height: `${size()}px` });

  return (
    <box ariaHidden class={styles.dualArcRoot} style={vecSizeStyle()}>
      <vector
        ariaHidden
        viewBox="0 0 30 30"
        d={arcs().leftTrack}
        class={cx(styles.dualArcVector, styles.dualArcTrack)}
        data-compact={compact()}
        style={vecSizeStyle()}
      />
      <vector
        ariaHidden
        viewBox="0 0 30 30"
        d={arcs().rightTrack}
        class={cx(styles.dualArcVector, styles.dualArcTrack)}
        data-compact={compact()}
        style={vecSizeStyle()}
      />
      <Show when={arcs().leftFill.length > 0}>
        <vector
          ariaHidden
          viewBox="0 0 30 30"
          d={arcs().leftFill}
          class={cx(styles.dualArcVector, styles.dualArcPrimary)}
          data-compact={compact()}
          style={vecSizeStyle()}
        />
      </Show>
      <Show when={arcs().rightFill.length > 0}>
        <vector
          ariaHidden
          viewBox="0 0 30 30"
          d={arcs().rightFill}
          class={cx(styles.dualArcVector, styles.dualArcTertiary)}
          data-compact={compact()}
          style={vecSizeStyle()}
        />
      </Show>
      <ShellIcon name="pulse" size={size() <= 28 ? 11 : 12} color={props.iconColor ?? "var(--color-on-surface)"} />
    </box>
  );
}

/** Smooth area+line rolling chart with fixed 60-slot right-aligned timeline, null gap breaks, and sub-second scroll. */
export function AreaLineChart(props: {
  readonly values: readonly (number | null)[] | null | undefined;
  readonly variant: "popover" | "window" | "detail";
  readonly wide?: boolean | undefined;
  readonly color?: string | undefined;
  readonly maxValue?: number | undefined;
  readonly bucketSeconds?: number | undefined;
  readonly latestBucketId?: number | null | undefined;
  readonly resetKey?: string | number | null | undefined;
  readonly sourceBaseline?: boolean | undefined;
  readonly revision?: number | undefined;
  readonly emptyLabel?: string | undefined;
  readonly testId?: string | undefined;
}): NativeChild {
  const dims = () => (props.variant === "popover"
    ? { width: 340, height: 72, boxHeight: 72, paddingX: 8, paddingTop: 10, paddingBottom: 8, viewBox: "0 0 340 72" as const }
    : props.variant === "detail"
      ? { width: 536, height: 112, boxHeight: 112, paddingX: 10, paddingTop: 10, paddingBottom: 8, viewBox: "0 0 536 112" as const }
      : props.wide
        ? { width: 536, height: 88, boxHeight: 88, paddingX: 10, paddingTop: 10, paddingBottom: 8, viewBox: "0 0 536 88" as const }
        : { width: 380, height: 88, boxHeight: 88, paddingX: 8, paddingTop: 10, paddingBottom: 8, viewBox: "0 0 380 88" as const });

  const motionScheme = useGlobalMotionScheme();
  const [scrollFrame, setScrollFrame] = createSignal<ChartScrollFrame>({
    shiftSlots: 0,
    exitingPrimary: undefined,
    exitingSecondary: undefined,
  });
  const scrollController = createChartScrollController({
    slotCount: ROLLING_SLOT_COUNT,
    onChange: setScrollFrame,
  });
  onCleanup(() => scrollController.dispose());

  createEffect(
    () => ({
      values: props.values,
      latestBucketId: props.latestBucketId,
      bucketSeconds: props.bucketSeconds,
      resetKey: props.resetKey,
      sourceBaseline: props.sourceBaseline,
      revision: props.revision,
      reducedMotion: motionScheme() === "reduced",
    }),
    input => {
      scrollController.update({
        primary: input.values,
        latestBucketId: input.latestBucketId,
        bucketSeconds: input.bucketSeconds,
        resetKey: input.resetKey,
        sourceBaseline: input.sourceBaseline,
        revision: input.revision,
        reducedMotion: input.reducedMotion,
      });
    },
  );

  const paths = createMemo(() => {
    const d = dims();
    const frame = scrollFrame();
    return buildSparklinePaths(props.values, {
      width: d.width,
      height: d.height,
      paddingX: d.paddingX,
      paddingTop: d.paddingTop,
      paddingBottom: d.paddingBottom,
      ...(props.maxValue !== undefined ? { maxValue: props.maxValue } : {}),
      smooth: true,
      slotCount: ROLLING_SLOT_COUNT,
      ...(frame.exitingPrimary !== undefined ? { leadingValue: frame.exitingPrimary } : {}),
    });
  });

  const shiftPx = () => scrollFrame().shiftSlots * paths().slotPitch;
  const strokeColor = () => props.color ?? primary;
  const hairlineY = (fractionFromTop: number): string => {
    const d = dims();
    const innerH = d.height - d.paddingTop - d.paddingBottom;
    return `${(d.paddingTop + innerH * fractionFromTop).toFixed(2)}px`;
  };

  return (
    <box testId={props.testId ?? null} class={styles.chartRoot} style={{ height: `${dims().boxHeight}px` }}>
      {/* Exact 75% / 50% / 25% plot reference hairlines */}
      <box
        ariaHidden
        class={styles.areaHairline}
        style={{ left: `${dims().paddingX}px`, right: `${dims().paddingX}px`, top: hairlineY(0.25) }}
      />
      <box
        ariaHidden
        class={styles.areaHairline}
        style={{ left: `${dims().paddingX}px`, right: `${dims().paddingX}px`, top: hairlineY(0.5) }}
      />
      <box
        ariaHidden
        class={styles.areaHairline}
        style={{ left: `${dims().paddingX}px`, right: `${dims().paddingX}px`, top: hairlineY(0.75) }}
      />

      <Show when={paths().hasData} fallback={
        <box class={styles.chartEmpty}>
          <text class={styles.chartEmptyText}>
            {props.emptyLabel ?? "Waiting for samples"}
          </text>
        </box>
      }>
        <box
          ariaHidden
          class={styles.chartClip}
          style={{ left: `${dims().paddingX}px`, right: `${dims().paddingX}px` }}
        >
          <box
            ariaHidden
            class={styles.chartShift}
            style={{
              left: `${-dims().paddingX}px`,
              right: `${-dims().paddingX}px`,
              ...(shiftPx() > 0.01 ? { transform: `translateX(${shiftPx().toFixed(2)}px)` } : {}),
            }}
          >
            <Show when={paths().areaPath.length > 0}>
              <vector
                ariaHidden
                viewBox={dims().viewBox}
                d={paths().areaPath}
                class={styles.chartAreaVector}
                style={{
                  height: `${dims().boxHeight}px`,
                  "--zgui-fill": `color-mix(in srgb, ${strokeColor()} 18%, transparent)`,
                }}
              />
            </Show>
            <vector
              ariaHidden
              viewBox={dims().viewBox}
              d={paths().strokePath}
              class={styles.chartStrokeVector}
              style={{
                height: `${dims().boxHeight}px`,
                "--zgui-stroke": strokeColor(),
              }}
            />
          </box>
        </box>
      </Show>
    </box>
  );
}

/** Dual-series rolling chart for Network RX/TX or Disk Read/Write with nice-scale hysteresis, Y-axis labels, and smooth scroll. */
export function DualLineChart(props: {
  readonly primarySeries: readonly (number | null)[] | null | undefined;
  readonly secondarySeries: readonly (number | null)[] | null | undefined;
  readonly wide?: boolean | undefined;
  readonly compact?: boolean | undefined;
  readonly primaryColor?: string | undefined;
  readonly secondaryColor?: string | undefined;
  readonly bucketSeconds?: number | undefined;
  readonly latestBucketId?: number | null | undefined;
  readonly resetKey?: string | number | null | undefined;
  readonly sourceBaseline?: boolean | undefined;
  readonly revision?: number | undefined;
  readonly emptyLabel?: string | undefined;
  readonly testId?: string | undefined;
}): NativeChild {
  const dims = () => (!props.wide
    ? { width: 250, height: 64, boxHeight: 64, paddingX: 6, paddingTop: 8, paddingBottom: 6, viewBox: "0 0 250 64" as const }
    : props.compact
      ? { width: 536, height: 64, boxHeight: 64, paddingX: 10, paddingTop: 8, paddingBottom: 6, viewBox: "0 0 536 64" as const }
      : { width: 536, height: 96, boxHeight: 96, paddingX: 10, paddingTop: 10, paddingBottom: 8, viewBox: "0 0 536 96" as const });

  const motionScheme = useGlobalMotionScheme();
  const [scrollFrame, setScrollFrame] = createSignal<ChartScrollFrame>({
    shiftSlots: 0,
    exitingPrimary: undefined,
    exitingSecondary: undefined,
  });
  const scrollController = createChartScrollController({
    slotCount: ROLLING_SLOT_COUNT,
    onChange: setScrollFrame,
  });
  onCleanup(() => scrollController.dispose());

  createEffect(
    () => ({
      primary: props.primarySeries,
      secondary: props.secondarySeries,
      latestBucketId: props.latestBucketId,
      bucketSeconds: props.bucketSeconds,
      resetKey: props.resetKey,
      sourceBaseline: props.sourceBaseline,
      revision: props.revision,
      reducedMotion: motionScheme() === "reduced",
    }),
    input => {
      scrollController.update({
        primary: input.primary,
        secondary: input.secondary,
        latestBucketId: input.latestBucketId,
        bucketSeconds: input.bucketSeconds,
        resetKey: input.resetKey,
        sourceBaseline: input.sourceBaseline,
        revision: input.revision,
        reducedMotion: input.reducedMotion,
      });
    },
  );

  const observedMax = createMemo(() => {
    let max = 0;
    const p = props.primarySeries ?? [];
    const pSlice = p.length > ROLLING_SLOT_COUNT ? p.slice(p.length - ROLLING_SLOT_COUNT) : p;
    for (const v of pSlice) {
      if (v !== null && Number.isFinite(v) && v > max) max = v;
    }
    const s = props.secondarySeries ?? [];
    const sSlice = s.length > ROLLING_SLOT_COUNT ? s.slice(s.length - ROLLING_SLOT_COUNT) : s;
    for (const v of sSlice) {
      if (v !== null && Number.isFinite(v) && v > max) max = v;
    }
    return max;
  });

  let previousCeiling: number | null = null;
  let lastScaleResetKey: string | number | null | undefined = undefined;
  const scaleCeiling = createMemo(() => {
    const key = props.resetKey;
    if (key !== lastScaleResetKey) {
      lastScaleResetKey = key;
      previousCeiling = null;
    }
    const next = resolveThroughputScale(observedMax(), previousCeiling);
    previousCeiling = next;
    return next;
  });

  const primaryPaths = createMemo(() => {
    const d = dims();
    const frame = scrollFrame();
    return buildSparklinePaths(props.primarySeries, {
      width: d.width,
      height: d.height,
      paddingX: d.paddingX,
      paddingTop: d.paddingTop,
      paddingBottom: d.paddingBottom,
      maxValue: scaleCeiling(),
      smooth: false,
      slotCount: ROLLING_SLOT_COUNT,
      ...(frame.exitingPrimary !== undefined ? { leadingValue: frame.exitingPrimary } : {}),
    });
  });
  const secondaryPaths = createMemo(() => {
    const d = dims();
    const frame = scrollFrame();
    return buildSparklinePaths(props.secondarySeries, {
      width: d.width,
      height: d.height,
      paddingX: d.paddingX,
      paddingTop: d.paddingTop,
      paddingBottom: d.paddingBottom,
      maxValue: scaleCeiling(),
      smooth: false,
      slotCount: ROLLING_SLOT_COUNT,
      ...(frame.exitingSecondary !== undefined ? { leadingValue: frame.exitingSecondary } : {}),
    });
  });

  const hasAny = () => primaryPaths().hasData || secondaryPaths().hasData;
  const shiftPx = () => scrollFrame().shiftSlots * primaryPaths().slotPitch;
  const pColor = () => props.primaryColor ?? primary;
  const sColor = () => props.secondaryColor ?? tertiary;
  const midLineY = (): number => {
    const d = dims();
    return d.paddingTop + (d.height - d.paddingTop - d.paddingBottom) * 0.5;
  };

  return (
    <box testId={props.testId ?? null} class={styles.chartRoot} style={{ height: `${dims().boxHeight}px` }}>
      {/* Exact 100% ceiling & 50% mid-scale reference hairlines */}
      <box
        ariaHidden
        class={styles.dualHairline}
        style={{ left: `${dims().paddingX}px`, right: `${dims().paddingX}px`, top: `${dims().paddingTop}px` }}
      />
      <box
        ariaHidden
        class={styles.dualHairline}
        style={{ left: `${dims().paddingX}px`, right: `${dims().paddingX}px`, top: `${midLineY().toFixed(2)}px` }}
      />
      <Show when={hasAny()} fallback={
        <box class={styles.chartEmpty}>
          <text class={styles.chartEmptyText}>
            {props.emptyLabel ?? "No throughput history"}
          </text>
        </box>
      }>
        <box
          ariaHidden
          class={styles.chartClip}
          style={{ left: `${dims().paddingX}px`, right: `${dims().paddingX}px` }}
        >
          <box
            ariaHidden
            class={styles.chartShift}
            style={{
              left: `${-dims().paddingX}px`,
              right: `${-dims().paddingX}px`,
              ...(shiftPx() > 0.01 ? { transform: `translateX(${shiftPx().toFixed(2)}px)` } : {}),
            }}
          >
            <Show when={primaryPaths().areaPath.length > 0}>
              <vector
                ariaHidden
                viewBox={dims().viewBox}
                d={primaryPaths().areaPath}
                class={styles.chartAreaVector}
                style={{
                  height: `${dims().boxHeight}px`,
                  "--zgui-fill": `color-mix(in srgb, ${pColor()} 15%, transparent)`,
                }}
              />
            </Show>
            <Show when={secondaryPaths().strokePath.length > 0}>
              <vector
                ariaHidden
                viewBox={dims().viewBox}
                d={secondaryPaths().strokePath}
                class={styles.dualSecondaryVector}
                style={{
                  height: `${dims().boxHeight}px`,
                  "--zgui-stroke": sColor(),
                }}
              />
            </Show>
            <Show when={primaryPaths().strokePath.length > 0}>
              <vector
                ariaHidden
                viewBox={dims().viewBox}
                d={primaryPaths().strokePath}
                class={styles.dualPrimaryVector}
                style={{
                  height: `${dims().boxHeight}px`,
                  "--zgui-stroke": pColor(),
                }}
              />
            </Show>
          </box>
        </box>

        {/* Opaque Y-axis ceiling label */}
        <box
          class={styles.scaleBadge}
          style={{ left: `${dims().paddingX}px`, top: `${Math.max(2, dims().paddingTop - 6)}px` }}
        >
          <text
            testId={props.testId ? `${props.testId}-scale-max` : null}
            data-tabular="true"
            class={styles.scaleBadgeText}
          >
            {formatThroughputAxisLabel(scaleCeiling())}
          </text>
        </box>

        {/* Opaque 50% mid-scale label on wide charts */}
        <Show when={props.wide}>
          <box
            class={styles.scaleBadge}
            style={{ left: `${dims().paddingX}px`, top: `${Math.round(midLineY() - 6)}px` }}
          >
            <text
              testId={props.testId ? `${props.testId}-scale-mid` : null}
              data-tabular="true"
              class={styles.scaleBadgeText}
            >
              {formatThroughputAxisLabel(scaleCeiling() / 2)}
            </text>
          </box>
        </Show>
      </Show>
    </box>
  );
}

/** Compact per-core vertical bar chart (`PER CORE (N)` in 22J Overview & CPU detail). */
export function PerCoreBarChart(props: {
  readonly cores: readonly (number | null)[];
  readonly height?: number;
  readonly maxBars?: number;
}): NativeChild {
  const height = () => props.height ?? 56;
  const visibleCores = createMemo(() => {
    const limit = props.maxBars ?? 32;
    return props.cores.slice(0, limit).map((value, index) => ({ index, value }));
  });

  return (
    <row
      class={styles.perCoreRow}
      data-dense={visibleCores().length > 16 ? "true" : "false"}
      style={{ height: `${height()}px` }}
    >
      <For each={visibleCores()} keyed={item => item.index}>
        {item => {
          const pct = () => {
            const v = item().value;
            return v === null ? 0 : Math.max(6, Math.min(100, Math.round(v)));
          };
          const busy = () => (item().value ?? 0) >= 35;
          const barState = () => (item().value === null ? "empty" : busy() ? "busy" : "idle");
          return (
            <box ariaHidden class={styles.perCoreBarTrack}>
              <box
                data-percent-fill="true"
                ariaHidden
                class={styles.perCoreBarFill}
                data-state={barState()}
                style={{ height: item().value === null ? "4px" : `${pct()}%` }}
              />
            </box>
          );
        }}
      </For>
    </row>
  );
}
