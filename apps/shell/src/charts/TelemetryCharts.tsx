import { For, Show, createMemo, type NativeChild } from "@hewel/zgui";
import { buildSparklinePaths, buildSplitDualArcPaths } from "../charts.ts";
import { ShellIcon } from "../icons.tsx";

const primary = "var(--color-primary)";
const primaryContainer = "var(--color-primary-container)";
const tertiary = "var(--color-tertiary)";
const trackColor = "var(--color-surface-container-highest)";
const surfaceLowest = "var(--color-surface-container-lowest)";
const muted = "var(--color-on-surface-variant)";

/** Compact 36x16 inline CPU sparkline for the horizontal StatusBar trigger. */
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

/** Smooth area+line rolling chart supporting null gap discontinuities. */
export function AreaLineChart(props: {
  readonly values: readonly (number | null)[] | null | undefined;
  readonly variant: "popover" | "window" | "detail";
  readonly color?: string;
  readonly maxValue?: number;
  readonly emptyLabel?: string;
  readonly testId?: string;
}): NativeChild {
  const dims = () => (props.variant === "popover"
    ? { width: 340, height: 72, boxHeight: 72, viewBox: "0 0 340 72" as const }
    : props.variant === "detail"
      ? { width: 380, height: 88, boxHeight: 112, viewBox: "0 0 380 88" as const }
      : { width: 380, height: 88, boxHeight: 88, viewBox: "0 0 380 88" as const });

  const paths = createMemo(() => {
    const d = dims();
    return buildSparklinePaths(props.values, {
      width: d.width,
      height: d.height,
      paddingX: 8,
      paddingTop: 10,
      paddingBottom: 8,
      ...(props.maxValue !== undefined ? { maxValue: props.maxValue } : {}),
      smooth: true,
    });
  });

  const strokeColor = () => props.color ?? primary;

  return (
    <box testId={props.testId ?? null} style={{
      position: "relative",
      width: "100%",
      height: `${dims().boxHeight}px`,
      borderRadius: "10px",
      backgroundColor: surfaceLowest,
      overflow: "hidden",
    }}>
      {/* Subtle 25% / 50% / 75% reference hairlines */}
      <box ariaHidden style={{
        position: "absolute", left: "8px", right: "8px", top: "28%", height: "1px",
        backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
      }} />
      <box ariaHidden style={{
        position: "absolute", left: "8px", right: "8px", top: "54%", height: "1px",
        backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
      }} />
      <box ariaHidden style={{
        position: "absolute", left: "8px", right: "8px", top: "80%", height: "1px",
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
      </Show>
    </box>
  );
}

/** Dual-series rolling chart for Network RX/TX or Disk Read/Write with shared auto-scaling and gap breaks. */
export function DualLineChart(props: {
  readonly primarySeries: readonly (number | null)[] | null | undefined;
  readonly secondarySeries: readonly (number | null)[] | null | undefined;
  readonly wide?: boolean;
  readonly primaryColor?: string;
  readonly secondaryColor?: string;
  readonly emptyLabel?: string;
  readonly testId?: string;
}): NativeChild {
  const dims = () => (props.wide
    ? { width: 380, height: 88, boxHeight: 96, viewBox: "0 0 380 88" as const }
    : { width: 260, height: 64, boxHeight: 64, viewBox: "0 0 260 64" as const });

  const sharedMax = createMemo(() => {
    let max = 0;
    for (const v of props.primarySeries ?? []) {
      if (v !== null && Number.isFinite(v) && v > max) max = v;
    }
    for (const v of props.secondarySeries ?? []) {
      if (v !== null && Number.isFinite(v) && v > max) max = v;
    }
    return Math.max(1, max * 1.15);
  });

  const primaryPaths = createMemo(() => {
    const d = dims();
    return buildSparklinePaths(props.primarySeries, {
      width: d.width,
      height: d.height,
      paddingX: 6,
      paddingTop: 8,
      paddingBottom: 6,
      maxValue: sharedMax(),
      smooth: false,
    });
  });
  const secondaryPaths = createMemo(() => {
    const d = dims();
    return buildSparklinePaths(props.secondarySeries, {
      width: d.width,
      height: d.height,
      paddingX: 6,
      paddingTop: 8,
      paddingBottom: 6,
      maxValue: sharedMax(),
      smooth: false,
    });
  });

  const hasAny = () => primaryPaths().hasData || secondaryPaths().hasData;
  const pColor = () => props.primaryColor ?? primary;
  const sColor = () => props.secondaryColor ?? tertiary;

  return (
    <box testId={props.testId ?? null} style={{
      position: "relative",
      width: "100%",
      height: `${dims().boxHeight}px`,
      borderRadius: "10px",
      backgroundColor: surfaceLowest,
      overflow: "hidden",
    }}>
      <box ariaHidden style={{
        position: "absolute", left: "6px", right: "6px", top: "35%", height: "1px",
        backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 28%, transparent)",
      }} />
      <box ariaHidden style={{
        position: "absolute", left: "6px", right: "6px", top: "70%", height: "1px",
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
