/**
 * Pure analytical SVG path builders for System Monitor telemetry charts and split dual-arc gauges.
 * All chart paths break cleanly across `null` gaps (never interpolating across missing/reset intervals).
 */

export interface SparklinePathOptions {
  readonly width: number;
  readonly height: number;
  readonly paddingX?: number;
  readonly paddingTop?: number;
  readonly paddingBottom?: number;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly smooth?: boolean;
}

export interface SparklinePathResult {
  readonly strokePath: string;
  readonly areaPath: string;
  readonly maxValue: number;
  readonly hasData: boolean;
  readonly segmentCount: number;
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
  const series = values ?? [];
  const paddingX = options.paddingX ?? 2;
  const paddingTop = options.paddingTop ?? 4;
  const paddingBottom = options.paddingBottom ?? 4;
  const minValue = options.minValue ?? 0;
  const smooth = options.smooth ?? true;

  let observedMax = 0;
  let validCount = 0;
  for (const val of series) {
    if (val !== null && Number.isFinite(val)) {
      validCount += 1;
      if (val > observedMax) observedMax = val;
    }
  }

  const maxValue = options.maxValue ?? Math.max(1, observedMax * 1.15);
  if (validCount === 0 || series.length === 0) {
    return { strokePath: "", areaPath: "", maxValue, hasData: false, segmentCount: 0 };
  }

  const innerW = Math.max(1, options.width - paddingX * 2);
  const innerH = Math.max(1, options.height - paddingTop - paddingBottom);
  const baselineY = options.height - paddingBottom;
  const range = Math.max(1e-6, maxValue - minValue);

  const runs: Point[][] = [];
  let current: Point[] = [];
  const denom = Math.max(1, series.length - 1);

  for (let i = 0; i < series.length; i += 1) {
    const raw = series[i];
    if (raw === null || raw === undefined || !Number.isFinite(raw)) {
      if (current.length > 0) {
        runs.push(current);
        current = [];
      }
      continue;
    }
    const x = series.length === 1
      ? paddingX + innerW / 2
      : paddingX + (i / denom) * innerW;
    const norm = clamp((raw - minValue) / range, 0, 1);
    const y = paddingTop + (1 - norm) * innerH;
    current.push({ x, y });
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
