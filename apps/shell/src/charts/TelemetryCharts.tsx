import { For, Show, createEffect, createMemo, createSignal, onCleanup, type NativeChild } from "@hewel/zgui";
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

const primary = "var(--color-primary)";
const primaryContainer = "var(--color-primary-container)";
const tertiary = "var(--color-tertiary)";
const trackColor = "var(--color-surface-container-highest)";
const surfaceLowest = "var(--color-surface-container-lowest)";
const muted = "var(--color-on-surface-variant)";

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
    <box ariaHidden style={{ position: "relative", width: "36px", height: "16px", flexShrink: 0 }}>
      <Show when={paths().hasData} fallback={
        <box ariaHidden style={{
          position: "absolute", left: "2px", right: "2px", top: "7px", height: "1.5px",
          borderRadius: "1px", backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
        }} />
      }>
        <vector
          ariaHidden
          viewBox="0 0 36 16"
          d={paths().strokePath}
          style={{
            position: "absolute", inset: "0px", width: "36px", height: "16px",
            "--zgui-fill": "transparent",
            "--zgui-stroke": strokeColor(),
            "--zgui-stroke-width": "1.8px",
            "--zgui-stroke-linecap": "round",
            "--zgui-stroke-linejoin": "round",
          }}
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
  const arcs = createMemo(() => buildSplitDualArcPaths(props.cpuPercent, props.ramPercent));
  const strokeWidth = () => (size() <= 28 ? "2.8px" : "2.6px");

  return (
    <box ariaHidden style={{
      position: "relative",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: `${size()}px`,
      height: `${size()}px`,
      flexShrink: 0,
    }}>
      <vector
        ariaHidden
        viewBox="0 0 30 30"
        d={arcs().leftTrack}
        style={{
          position: "absolute", inset: "0px", width: `${size()}px`, height: `${size()}px`,
          "--zgui-fill": "transparent",
          "--zgui-stroke": trackColor,
          "--zgui-stroke-width": strokeWidth(),
          "--zgui-stroke-linecap": "round",
        }}
      />
      <vector
        ariaHidden
        viewBox="0 0 30 30"
        d={arcs().rightTrack}
        style={{
          position: "absolute", inset: "0px", width: `${size()}px`, height: `${size()}px`,
          "--zgui-fill": "transparent",
          "--zgui-stroke": trackColor,
          "--zgui-stroke-width": strokeWidth(),
          "--zgui-stroke-linecap": "round",
        }}
      />
      <Show when={arcs().leftFill.length > 0}>
        <vector
          ariaHidden
          viewBox="0 0 30 30"
          d={arcs().leftFill}
          style={{
            position: "absolute", inset: "0px", width: `${size()}px`, height: `${size()}px`,
            "--zgui-fill": "transparent",
            "--zgui-stroke": primary,
            "--zgui-stroke-width": strokeWidth(),
            "--zgui-stroke-linecap": "round",
          }}
        />
      </Show>
      <Show when={arcs().rightFill.length > 0}>
        <vector
          ariaHidden
          viewBox="0 0 30 30"
          d={arcs().rightFill}
          style={{
            position: "absolute", inset: "0px", width: `${size()}px`, height: `${size()}px`,
            "--zgui-fill": "transparent",
            "--zgui-stroke": tertiary,
            "--zgui-stroke-width": strokeWidth(),
            "--zgui-stroke-linecap": "round",
          }}
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
    <box testId={props.testId ?? null} style={{
      position: "relative",
      width: "100%",
      height: `${dims().boxHeight}px`,
      borderRadius: "10px",
      backgroundColor: surfaceLowest,
      overflow: "hidden",
    }}>
      {/* Exact 75% / 50% / 25% plot reference hairlines */}
      <box ariaHidden style={{
        position: "absolute", left: `${dims().paddingX}px`, right: `${dims().paddingX}px`, top: hairlineY(0.25), height: "1px",
        backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
      }} />
      <box ariaHidden style={{
        position: "absolute", left: `${dims().paddingX}px`, right: `${dims().paddingX}px`, top: hairlineY(0.5), height: "1px",
        backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
      }} />
      <box ariaHidden style={{
        position: "absolute", left: `${dims().paddingX}px`, right: `${dims().paddingX}px`, top: hairlineY(0.75), height: "1px",
        backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
      }} />

      <Show when={paths().hasData} fallback={
        <box style={{
          display: "flex", width: "100%", height: "100%",
          alignItems: "center", justifyContent: "center",
        }}>
          <text style={{ fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: muted }}>
            {props.emptyLabel ?? "Waiting for samples"}
          </text>
        </box>
      }>
        <box ariaHidden style={{
          position: "absolute",
          left: `${dims().paddingX}px`,
          right: `${dims().paddingX}px`,
          top: "0px",
          bottom: "0px",
          overflow: "hidden",
        }}>
          <box ariaHidden style={{
            position: "absolute",
            left: `${-dims().paddingX}px`,
            right: `${-dims().paddingX}px`,
            top: "0px",
            bottom: "0px",
            ...(shiftPx() > 0.01 ? { transform: `translateX(${shiftPx().toFixed(2)}px)` } : {}),
          }}>
            <Show when={paths().areaPath.length > 0}>
              <vector
                ariaHidden
                viewBox={dims().viewBox}
                d={paths().areaPath}
                style={{
                  position: "absolute", inset: "0px", width: "100%", height: `${dims().boxHeight}px`,
                  "--zgui-fill": `color-mix(in srgb, ${strokeColor()} 18%, transparent)`,
                  "--zgui-stroke": "transparent",
                }}
              />
            </Show>
            <vector
              ariaHidden
              viewBox={dims().viewBox}
              d={paths().strokePath}
              style={{
                position: "absolute", inset: "0px", width: "100%", height: `${dims().boxHeight}px`,
                "--zgui-fill": "transparent",
                "--zgui-stroke": strokeColor(),
                "--zgui-stroke-width": "2px",
                "--zgui-stroke-linecap": "round",
                "--zgui-stroke-linejoin": "round",
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
    <box testId={props.testId ?? null} style={{
      position: "relative",
      width: "100%",
      height: `${dims().boxHeight}px`,
      borderRadius: "10px",
      backgroundColor: surfaceLowest,
      overflow: "hidden",
    }}>
      {/* Exact 100% ceiling & 50% mid-scale reference hairlines */}
      <box ariaHidden style={{
        position: "absolute", left: `${dims().paddingX}px`, right: `${dims().paddingX}px`, top: `${dims().paddingTop}px`, height: "1px",
        backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 28%, transparent)",
      }} />
      <box ariaHidden style={{
        position: "absolute", left: `${dims().paddingX}px`, right: `${dims().paddingX}px`, top: `${midLineY().toFixed(2)}px`, height: "1px",
        backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 28%, transparent)",
      }} />
      <Show when={hasAny()} fallback={
        <box style={{
          display: "flex", width: "100%", height: "100%",
          alignItems: "center", justifyContent: "center",
        }}>
          <text style={{ fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: muted }}>
            {props.emptyLabel ?? "No throughput history"}
          </text>
        </box>
      }>
        <box ariaHidden style={{
          position: "absolute",
          left: `${dims().paddingX}px`,
          right: `${dims().paddingX}px`,
          top: "0px",
          bottom: "0px",
          overflow: "hidden",
        }}>
          <box ariaHidden style={{
            position: "absolute",
            left: `${-dims().paddingX}px`,
            right: `${-dims().paddingX}px`,
            top: "0px",
            bottom: "0px",
            ...(shiftPx() > 0.01 ? { transform: `translateX(${shiftPx().toFixed(2)}px)` } : {}),
          }}>
            <Show when={primaryPaths().areaPath.length > 0}>
              <vector
                ariaHidden
                viewBox={dims().viewBox}
                d={primaryPaths().areaPath}
                style={{
                  position: "absolute", inset: "0px", width: "100%", height: `${dims().boxHeight}px`,
                  "--zgui-fill": `color-mix(in srgb, ${pColor()} 15%, transparent)`,
                  "--zgui-stroke": "transparent",
                }}
              />
            </Show>
            <Show when={secondaryPaths().strokePath.length > 0}>
              <vector
                ariaHidden
                viewBox={dims().viewBox}
                d={secondaryPaths().strokePath}
                style={{
                  position: "absolute", inset: "0px", width: "100%", height: `${dims().boxHeight}px`,
                  "--zgui-fill": "transparent",
                  "--zgui-stroke": sColor(),
                  "--zgui-stroke-width": "1.6px",
                  "--zgui-stroke-linecap": "round",
                  "--zgui-stroke-linejoin": "round",
                }}
              />
            </Show>
            <Show when={primaryPaths().strokePath.length > 0}>
              <vector
                ariaHidden
                viewBox={dims().viewBox}
                d={primaryPaths().strokePath}
                style={{
                  position: "absolute", inset: "0px", width: "100%", height: `${dims().boxHeight}px`,
                  "--zgui-fill": "transparent",
                  "--zgui-stroke": pColor(),
                  "--zgui-stroke-width": "1.8px",
                  "--zgui-stroke-linecap": "round",
                  "--zgui-stroke-linejoin": "round",
                }}
              />
            </Show>
          </box>
        </box>

        {/* Opaque Y-axis ceiling label */}
        <box style={{
          position: "absolute",
          left: `${dims().paddingX}px`,
          top: `${Math.max(2, dims().paddingTop - 6)}px`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 4px",
          borderRadius: "4px",
          backgroundColor: surfaceLowest,
          pointerEvents: "none",
        }}>
          <text
            testId={props.testId ? `${props.testId}-scale-max` : null}
            data-tabular="true"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "9px",
              lineHeight: "12px",
              color: muted,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {formatThroughputAxisLabel(scaleCeiling())}
          </text>
        </box>

        {/* Opaque 50% mid-scale label on wide charts */}
        <Show when={props.wide}>
          <box style={{
            position: "absolute",
            left: `${dims().paddingX}px`,
            top: `${Math.round(midLineY() - 6)}px`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "0 4px",
            borderRadius: "4px",
            backgroundColor: surfaceLowest,
            pointerEvents: "none",
          }}>
            <text
              testId={props.testId ? `${props.testId}-scale-mid` : null}
              data-tabular="true"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "9px",
                lineHeight: "12px",
                color: muted,
                fontVariantNumeric: "tabular-nums",
              }}
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
    <row style={{
      width: "100%",
      height: `${height()}px`,
      alignItems: "flex-end",
      gap: visibleCores().length > 16 ? "2px" : "4px",
    }}>
      <For each={visibleCores()} keyed={item => item.index}>
        {item => {
          const pct = () => {
            const v = item().value;
            return v === null ? 0 : Math.max(6, Math.min(100, Math.round(v)));
          };
          const busy = () => (item().value ?? 0) >= 35;
          return (
            <box ariaHidden style={{
              display: "flex",
              flexGrow: 1,
              flexBasis: "0px",
              minWidth: "2px",
              height: "100%",
              alignItems: "flex-end",
            }}>
              <box
                data-percent-fill="true"
                ariaHidden
                style={{
                  width: "100%",
                  height: item().value === null ? "4px" : `${pct()}%`,
                  borderRadius: "3px",
                  backgroundColor: item().value === null
                    ? trackColor
                    : busy() ? primary : primaryContainer,
                }}
              />
            </box>
          );
        }}
      </For>
    </row>
  );
}
