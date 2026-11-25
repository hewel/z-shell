/**
 * Pure analytical SVG path builders, throughput Y-axis nice-scale hysteresis, and rolling chart
 * transition/scroll math for System Monitor telemetry charts and split dual-arc gauges.
 * All chart paths break cleanly across `null` gaps (never interpolating across missing/reset intervals).
 */
import { motionNowMs, registerFrameTicker, type FrameTicker } from "@z-shell/sdk/zgui";

export interface SparklinePathOptions {
  readonly width: number;
  readonly height: number;
  readonly paddingX?: number;
  readonly paddingTop?: number;
  readonly paddingBottom?: number;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly smooth?: boolean;
  /** Fixed right-aligned timeline slot count (e.g. 60 for rolling charts, 30 for mini sparkline). */
  readonly slotCount?: number;
  /**
   * Optional exiting sample placed at slot `-1` (`x = paddingX - slotPitch`) while a full rolling
   * buffer scrolls smoothly off the left clip edge. `null` breaks cleanly at the left edge.
   */
  readonly leadingValue?: number | null;
}

export interface SparklinePathResult {
  readonly strokePath: string;
  readonly areaPath: string;
  readonly maxValue: number;
  readonly hasData: boolean;
  readonly segmentCount: number;
  readonly slotPitch: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

function fmt(n: number): string {
  return Number(n.toFixed(2)).toString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function buildRunStrokePath(points: readonly Point[], smooth: boolean): string {
  if (points.length === 0) return "";
  const first = points[0]!;
  if (points.length === 1) {
    // Render a crisp 1.5px horizontal tick for an isolated single sample so it stays visible.
    return `M ${fmt(first.x - 0.75)} ${fmt(first.y)} L ${fmt(first.x + 0.75)} ${fmt(first.y)}`;
  }
  if (!smooth || points.length === 2) {
    let d = `M ${fmt(first.x)} ${fmt(first.y)}`;
    for (let i = 1; i < points.length; i += 1) {
      const p = points[i]!;
      d += ` L ${fmt(p.x)} ${fmt(p.y)}`;
    }
    return d;
  }

  // Monotone-clamped Catmull-Rom cubic Bezier segments so curves never overshoot [0, max].
  let d = `M ${fmt(first.x)} ${fmt(first.y)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const dx = p2.x - p1.x;
    const m1 = (p2.y - p0.y) / Math.max(1e-4, p2.x - p0.x);
    const m2 = (p3.y - p1.y) / Math.max(1e-4, p3.x - p1.x);
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);
    const c1x = p1.x + dx / 3;
    const c1y = clamp(p1.y + (m1 * dx) / 3, minY, maxY);
    const c2x = p2.x - dx / 3;
    const c2y = clamp(p2.y - (m2 * dx) / 3, minY, maxY);
    d += ` C ${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p2.x)} ${fmt(p2.y)}`;
  }
  return d;
}

/**
 * Converts a scalar series (with explicit `null` gaps) into disjoint SVG stroke and area paths.
 * Never bridges across `null` entries.
 */
export function buildSparklinePaths(
  values: readonly (number | null)[] | null | undefined,
  options: SparklinePathOptions,
): SparklinePathResult {
  const rawSeries = values ?? [];
  const paddingX = options.paddingX ?? 2;
  const paddingTop = options.paddingTop ?? 4;
  const paddingBottom = options.paddingBottom ?? 4;
  const minValue = options.minValue ?? 0;
  const smooth = options.smooth ?? true;

  const innerW = Math.max(1, options.width - paddingX * 2);
  const innerH = Math.max(1, options.height - paddingTop - paddingBottom);
  const baselineY = options.height - paddingBottom;

  const fixedSlots = options.slotCount !== undefined
    ? Math.max(2, Math.floor(options.slotCount))
    : undefined;
  const series = fixedSlots !== undefined && rawSeries.length > fixedSlots
    ? rawSeries.slice(rawSeries.length - fixedSlots)
    : rawSeries;
  const slotPitch = fixedSlots !== undefined
    ? innerW / (fixedSlots - 1)
    : series.length > 1
      ? innerW / (series.length - 1)
      : 0;
  const hasLeadingSlot = fixedSlots !== undefined
    && series.length === fixedSlots
    && options.leadingValue !== undefined;

  let observedMax = 0;
  let validCount = 0;
  if (hasLeadingSlot && options.leadingValue !== null && options.leadingValue !== undefined && Number.isFinite(options.leadingValue)) {
    validCount += 1;
    if (options.leadingValue > observedMax) observedMax = options.leadingValue;
  }
  for (const val of series) {
    if (val !== null && Number.isFinite(val)) {
      validCount += 1;
      if (val > observedMax) observedMax = val;
    }
  }

  const maxValue = options.maxValue ?? Math.max(1, observedMax * 1.15);
  if (validCount === 0 || series.length === 0) {
    return { strokePath: "", areaPath: "", maxValue, hasData: false, segmentCount: 0, slotPitch };
  }

  const range = Math.max(1e-6, maxValue - minValue);

  const runs: Point[][] = [];
  let current: Point[] = [];
  const denom = Math.max(1, series.length - 1);

  const pushSample = (raw: number | null | undefined, x: number): void => {
    if (raw === null || raw === undefined || !Number.isFinite(raw)) {
      if (current.length > 0) {
        runs.push(current);
        current = [];
      }
      return;
    }
    const norm = clamp((raw - minValue) / range, 0, 1);
    const y = paddingTop + (1 - norm) * innerH;
    current.push({ x, y });
  };

  if (hasLeadingSlot) {
    pushSample(options.leadingValue, paddingX - slotPitch);
  }

  for (let i = 0; i < series.length; i += 1) {
    const x = fixedSlots !== undefined
      ? paddingX + (fixedSlots - series.length + i) * slotPitch
      : series.length === 1
        ? paddingX + innerW / 2
        : paddingX + (i / denom) * innerW;
    pushSample(series[i], x);
  }
  if (current.length > 0) {
    runs.push(current);
  }

  const strokeParts: string[] = [];
  const areaParts: string[] = [];
  for (const run of runs) {
    const runStroke = buildRunStrokePath(run, smooth);
    if (!runStroke) continue;
    strokeParts.push(runStroke);
    if (run.length >= 2) {
      const first = run[0]!;
      const last = run[run.length - 1]!;
      areaParts.push(`${runStroke} L ${fmt(last.x)} ${fmt(baselineY)} L ${fmt(first.x)} ${fmt(baselineY)} Z`);
    }
  }

  return {
    strokePath: strokeParts.join(" "),
    areaPath: areaParts.join(" "),
    maxValue,
    hasData: true,
    segmentCount: runs.length,
    slotPitch,
  };
}

const KIB = 1024;
const THROUGHPUT_UNIT_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500] as const;
const THROUGHPUT_KIB_STEPS = [10, 20, 50, 100, 200, 500] as const;
const THROUGHPUT_BINARY_BASES = [KIB ** 2, KIB ** 3, KIB ** 4] as const;

/** Minimum Y-axis ceiling (10 KB/s) so idle throughput noise never stretches full-height. */
export const THROUGHPUT_SCALE_FLOOR_BPS = 10 * KIB;

function findNiceThroughputRung(bytesPerSec: number, headroomFactor: number): number {
  const target = Number.isFinite(bytesPerSec) && bytesPerSec > 0 ? bytesPerSec : 0;
  for (const step of THROUGHPUT_KIB_STEPS) {
    const rung = step * KIB;
    if (target <= rung * headroomFactor) return rung;
  }
  for (const base of THROUGHPUT_BINARY_BASES) {
    for (const step of THROUGHPUT_UNIT_STEPS) {
      const rung = step * base;
      if (target <= rung * headroomFactor) return rung;
    }
  }
  let decade = 1000 * KIB ** 4;
  while (true) {
    for (const mult of [1, 2, 5] as const) {
      const rung = mult * decade;
      if (target <= rung * headroomFactor) return rung;
    }
    decade *= 10;
  }
}

/**
 * Snaps a raw throughput ceiling in bytes/sec onto a clean 1-2-5 binary ladder
 * (`10 KB/s`, `20 KB/s`, `50 KB/s`, ..., `500 KB/s`, `1 MB/s`, `2 MB/s`, `5 MB/s`, ...).
 */
export function niceThroughputCeiling(bytesPerSec: number): number {
  return findNiceThroughputRung(bytesPerSec, 1);
}

/**
 * Resolves the active throughput Y-axis ceiling with immediate upward scaling and
 * `0.8x` downward hysteresis so jitter near a rung boundary does not oscillate,
 * while multi-tier drops step straight down to the lowest rung with >= 20% headroom.
 */
export function resolveThroughputScale(
  observedMax: number,
  previousCeiling: number | null,
): number {
  const peak = Number.isFinite(observedMax) && observedMax > 0 ? observedMax : 0;
  const upward = niceThroughputCeiling(peak);
  if (previousCeiling === null || !Number.isFinite(previousCeiling) || previousCeiling <= 0) {
    return upward;
  }
  if (peak > previousCeiling) {
    return upward;
  }
  const downwardTarget = findNiceThroughputRung(peak, 0.8);
  return Math.min(previousCeiling, downwardTarget);
}

/** Formats a throughput Y-axis scale label cleanly (e.g. `10 KB/s`, `512 KB/s`, `2.5 MB/s`, `5 MB/s`). */
export function formatThroughputAxisLabel(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0 B/s";
  const fmtVal = (v: number): string => {
    const rounded = Number(v.toFixed(1));
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  };
  if (bytesPerSec >= KIB ** 4) return `${fmtVal(bytesPerSec / KIB ** 4)} TB/s`;
  if (bytesPerSec >= KIB ** 3) return `${fmtVal(bytesPerSec / KIB ** 3)} GB/s`;
  if (bytesPerSec >= KIB ** 2) return `${fmtVal(bytesPerSec / KIB ** 2)} MB/s`;
  if (bytesPerSec >= KIB) return `${fmtVal(bytesPerSec / KIB)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

export interface HistoryTransitionSnapshot {
  readonly latestBucketId: number | null | undefined;
  readonly resetKey?: string | number | null | undefined;
  readonly seriesLength: number;
  readonly secondarySeriesLength?: number | undefined;
  readonly firstValue: number | null;
  readonly secondaryFirstValue?: number | null | undefined;
}

export interface HistoryTransitionInput {
  readonly previous: HistoryTransitionSnapshot | null;
  readonly next: HistoryTransitionSnapshot;
  readonly slotCount: number;
  readonly sourceBaseline?: boolean | undefined;
  readonly revision?: number | undefined;
  readonly previousRevision?: number | undefined;
}

export type HistoryTransition =
  | {
      readonly kind: "advance";
      readonly exitingValue: number | null;
      readonly secondaryExitingValue: number | null;
    }
  | { readonly kind: "in_place" }
  | { readonly kind: "snap" };

/**
 * Classifies a rolling history update:
 * - `"advance"` ONLY on a proven single-bucket advance (`deltaBuckets === 1` via `latestBucketId`)
 *   with stable `resetKey`, non-baseline update, and non-regressing topic revision.
 * - `"in_place"` when `deltaBuckets === 0` so active scrolls keep running undisturbed.
 * - `"snap"` on first render, missing `latestBucketId` (legacy daemon), `sourceBaseline`,
 *   reconnect/revision reset, `resetKey` change, or multi-bucket jump.
 */
export function classifyHistoryTransition(input: HistoryTransitionInput): HistoryTransition {
  const { previous, next, slotCount, sourceBaseline, revision, previousRevision } = input;
  if (!previous) return { kind: "snap" };
  if (sourceBaseline) return { kind: "snap" };
  if (previous.resetKey !== next.resetKey) return { kind: "snap" };
  if (
    revision !== undefined
    && previousRevision !== undefined
    && revision < previousRevision
  ) {
    return { kind: "snap" };
  }
  const prevId = previous.latestBucketId;
  const nextId = next.latestBucketId;
  if (
    prevId === null || prevId === undefined || !Number.isFinite(prevId)
    || nextId === null || nextId === undefined || !Number.isFinite(nextId)
  ) {
    return { kind: "snap" };
  }
  const delta = nextId - prevId;
  if (delta === 0) {
    return { kind: "in_place" };
  }
  if (delta === 1) {
    const exitingValue = previous.seriesLength >= slotCount ? previous.firstValue : null;
    const secondaryLen = previous.secondarySeriesLength ?? previous.seriesLength;
    const secondaryExitingValue = secondaryLen >= slotCount
      ? (previous.secondaryFirstValue ?? null)
      : null;
    return { kind: "advance", exitingValue, secondaryExitingValue };
  }
  return { kind: "snap" };
}

export interface ChartScrollFrame {
  readonly shiftSlots: number;
  readonly exitingPrimary: number | null | undefined;
  readonly exitingSecondary: number | null | undefined;
}

export interface ChartScrollUpdate {
  readonly primary: readonly (number | null)[] | null | undefined;
  readonly secondary?: readonly (number | null)[] | null | undefined;
  readonly latestBucketId: number | null | undefined;
  readonly bucketSeconds?: number | undefined;
  readonly resetKey?: string | number | null | undefined;
  readonly sourceBaseline?: boolean | undefined;
  readonly revision?: number | undefined;
  readonly reducedMotion: boolean;
}

export interface ChartScrollControllerOptions {
  readonly slotCount: number;
  readonly onChange: (frame: ChartScrollFrame) => void;
  readonly registerTicker?: (ticker: FrameTicker) => () => void;
  readonly nowMs?: () => number;
}

export interface ChartScrollController {
  readonly update: (input: ChartScrollUpdate) => void;
  readonly dispose: () => void;
  readonly state: () => ChartScrollFrame;
}

const SETTLED_SCROLL_FRAME: ChartScrollFrame = Object.freeze({
  shiftSlots: 0,
  exitingPrimary: undefined,
  exitingSecondary: undefined,
});

function visibleWindowSlice(
  series: readonly (number | null)[] | null | undefined,
  slotCount: number,
): readonly (number | null)[] {
  const arr = series ?? [];
  return arr.length > slotCount ? arr.slice(arr.length - slotCount) : arr;
}

/**
 * Drives sub-second horizontal scroll interpolation for rolling charts through the shared
 * motion frame scheduler, preserving active scrolls on `in_place` updates and guaranteeing
 * zero active tickers after settle, unmount (`dispose`), or under reduced motion.
 */
export function createChartScrollController(
  options: ChartScrollControllerOptions,
): ChartScrollController {
  const slotCount = Math.max(2, Math.floor(options.slotCount));
  const registerTicker = options.registerTicker ?? registerFrameTicker;
  const nowMs = options.nowMs ?? motionNowMs;

  let disposed = false;
  let unregister: (() => void) | undefined;
  let prevSnap: HistoryTransitionSnapshot | null = null;
  let prevRevision: number | undefined;
  let current: ChartScrollFrame = SETTLED_SCROLL_FRAME;

  const stop = (): void => {
    unregister?.();
    unregister = undefined;
  };

  const setFrame = (next: ChartScrollFrame): void => {
    if (
      current.shiftSlots === next.shiftSlots
      && current.exitingPrimary === next.exitingPrimary
      && current.exitingSecondary === next.exitingSecondary
    ) {
      return;
    }
    current = next;
    options.onChange(next);
  };

  return {
    update(input) {
      if (disposed) return;
      const visiblePrimary = visibleWindowSlice(input.primary, slotCount);
      const visibleSecondary = visibleWindowSlice(input.secondary, slotCount);
      const nextSnap: HistoryTransitionSnapshot = {
        latestBucketId: input.latestBucketId,
        resetKey: input.resetKey,
        seriesLength: visiblePrimary.length,
        secondarySeriesLength: visibleSecondary.length,
        firstValue: visiblePrimary[0] ?? null,
        secondaryFirstValue: visibleSecondary[0] ?? null,
      };
      const transition = classifyHistoryTransition({
        previous: prevSnap,
        next: nextSnap,
        slotCount,
        sourceBaseline: input.sourceBaseline,
        revision: input.revision,
        previousRevision: prevRevision,
      });
      prevSnap = nextSnap;
      prevRevision = input.revision;

      if (input.reducedMotion) {
        stop();
        setFrame(SETTLED_SCROLL_FRAME);
        return;
      }

      if (transition.kind === "in_place") {
        // Leave any active scroll animation running smoothly without restarting it.
        return;
      }

      if (transition.kind === "snap") {
        stop();
        setFrame(SETTLED_SCROLL_FRAME);
        return;
      }

      stop();
      const durationMs = Math.min(1000, Math.max(250, (input.bucketSeconds ?? 1) * 1000));
      const startMs = nowMs();
      const exitingPrimary = transition.exitingValue;
      const exitingSecondary = transition.secondaryExitingValue;
      setFrame({ shiftSlots: 1, exitingPrimary, exitingSecondary });

      unregister = registerTicker(frameNowMs => {
        if (disposed) return false;
        const elapsed = Math.max(0, frameNowMs - startMs);
        const progress = Math.min(1, elapsed / durationMs);
        if (progress >= 1) {
          unregister = undefined;
          setFrame(SETTLED_SCROLL_FRAME);
          return false;
        }
        setFrame({
          shiftSlots: 1 - progress,
          exitingPrimary,
          exitingSecondary,
        });
        return true;
      });
    },
    dispose() {
      disposed = true;
      stop();
      current = SETTLED_SCROLL_FRAME;
    },
    state: () => current,
  };
}

/**
 * Generates an analytical circular arc path using cubic Bezier segments (each <= 90 deg)
 * so every vector backend renders exact circular geometry with < 0.004px radial deviation.
 */
export function buildCircularArcPath(
  cx: number,
  cy: number,
  radius: number,
  startDeg: number,
  endDeg: number,
): string {
  const delta = endDeg - startDeg;
  if (Math.abs(delta) < 0.5) return "";
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / 60));
  const stepRad = ((delta / steps) * Math.PI) / 180;
  const k = (4 / 3) * Math.tan(stepRad / 4);

  let angle = (startDeg * Math.PI) / 180;
  const startX = cx + radius * Math.cos(angle);
  const startY = cy + radius * Math.sin(angle);
  let d = `M ${fmt(startX)} ${fmt(startY)}`;

  for (let i = 0; i < steps; i += 1) {
    const nextAngle = angle + stepRad;
    const cos0 = Math.cos(angle);
    const sin0 = Math.sin(angle);
    const cos1 = Math.cos(nextAngle);
    const sin1 = Math.sin(nextAngle);

    const x0 = cx + radius * cos0;
    const y0 = cy + radius * sin0;
    const x1 = cx + radius * cos1;
    const y1 = cy + radius * sin1;

    const c1x = x0 - k * radius * sin0;
    const c1y = y0 + k * radius * cos0;
    const c2x = x1 + k * radius * sin1;
    const c2y = y1 - k * radius * cos1;

    d += ` C ${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(x1)} ${fmt(y1)}`;
    angle = nextAngle;
  }
  return d;
}

export interface SplitDualArcPaths {
  readonly leftTrack: string;
  readonly rightTrack: string;
  readonly leftFill: string;
  readonly rightFill: string;
}

const ARC_CENTER = 15;
const ARC_RADIUS = 11.5;
const ARC_SPAN_DEG = 148;
const LEFT_START_DEG = 106; // 16 deg left of 6 o'clock -> sweeps clockwise up to 254 deg (16 deg left of 12 o'clock)
const RIGHT_START_DEG = 74; // 16 deg right of 6 o'clock -> sweeps counter-clockwise up to -74 deg (16 deg right of 12 o'clock)

/**
 * Builds the 30x30 Split Dual-Arc circular gauge paths for the vertical StatusBar trigger:
 * - Left half-arc: CPU utilization (`--color-primary`) filling upward from 6 o'clock
 * - Right half-arc: Memory utilization (`--color-tertiary`) filling upward from 6 o'clock
 */
export function buildSplitDualArcPaths(
  cpuPercent: number | null | undefined,
  ramPercent: number | null | undefined,
): SplitDualArcPaths {
  const leftTrack = buildCircularArcPath(
    ARC_CENTER,
    ARC_CENTER,
    ARC_RADIUS,
    LEFT_START_DEG,
    LEFT_START_DEG + ARC_SPAN_DEG,
  );
  const rightTrack = buildCircularArcPath(
    ARC_CENTER,
    ARC_CENTER,
    ARC_RADIUS,
    RIGHT_START_DEG,
    RIGHT_START_DEG - ARC_SPAN_DEG,
  );

  const cpuRatio = cpuPercent != null && Number.isFinite(cpuPercent)
    ? clamp(cpuPercent / 100, 0, 1)
    : 0;
  const ramRatio = ramPercent != null && Number.isFinite(ramPercent)
    ? clamp(ramPercent / 100, 0, 1)
    : 0;

  const leftFill = cpuRatio > 0.01
    ? buildCircularArcPath(
        ARC_CENTER,
        ARC_CENTER,
        ARC_RADIUS,
        LEFT_START_DEG,
        LEFT_START_DEG + ARC_SPAN_DEG * cpuRatio,
      )
    : "";
  const rightFill = ramRatio > 0.01
    ? buildCircularArcPath(
        ARC_CENTER,
        ARC_CENTER,
        ARC_RADIUS,
        RIGHT_START_DEG,
        RIGHT_START_DEG - ARC_SPAN_DEG * ramRatio,
      )
    : "";

  return { leftTrack, rightTrack, leftFill, rightFill };
}
