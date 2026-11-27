/** Analytical SVG generators for exact dihedral-symmetric M3 Expressive shapes (DESIGN.md Exact-Geometry Shape Rule). */

export interface RosetteSpec {
  readonly lobes: number;
  readonly cx: number;
  readonly cy: number;
  readonly outerRadius: number;
  readonly innerRadius: number;
  readonly outerTension?: number;
  readonly innerTension?: number;
}

function fmt(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/**
 * Generate a closed cubic-Bezier silhouette with exact D_n rotational and vertical-axis mirror symmetry
 * around `(cx, cy)`. Lobe 0 starts at `-pi/2` (12 o'clock) so reflecting across `x = cx` is exact for all n.
 */
export function rosettePath(spec: RosetteSpec): string {
  const { lobes, cx, cy, outerRadius, innerRadius, outerTension = 1.15, innerTension = 0.85 } = spec;
  const count = lobes * 2;
  const step = Math.PI / lobes;
  const kappa = (4 / 3) * Math.tan(step / 4);
  const startAngle = -Math.PI / 2;

  const points = Array.from({ length: count }, (_, index) => {
    const angle = startAngle + index * step;
    const isOuter = index % 2 === 0;
    const radius = isOuter ? outerRadius : innerRadius;
    const handle = radius * kappa * (isOuter ? outerTension : innerTension);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      x: cx + radius * cos,
      y: cy + radius * sin,
      tx: -sin * handle,
      ty: cos * handle,
    };
  });

  const first = points[0]!;
  const commands = [`M${fmt(first.x)} ${fmt(first.y)}`];
  for (let i = 0; i < count; i++) {
    const curr = points[i]!;
    const next = points[(i + 1) % count]!;
    commands.push(
      `C${fmt(curr.x + curr.tx)} ${fmt(curr.y + curr.ty)} ${fmt(next.x - next.tx)} ${fmt(next.y - next.ty)} ${fmt(next.x)} ${fmt(next.y)}`,
    );
  }
  commands.push("Z");
  return commands.join("");
}

/** Canonical 8-lobe D_8 scalloped rosette for z-shell brand mark and user avatar badges (viewBox 0 0 64 64). */
export const SHELL_ROSETTE_PATH = rosettePath({
  lobes: 8,
  cx: 32,
  cy: 32,
  outerRadius: 28,
  innerRadius: 23.5,
  outerTension: 1.15,
  innerTension: 0.85,
});

/** CSS `clip-path: path("...")` scaled to `sizePx` for clipping raster avatar images into the exact D_8 rosette. */
export function shellRosetteClipPath(sizePx: number): string {
  const scale = sizePx / 64;
  return `path("${rosettePath({
    lobes: 8,
    cx: 32 * scale,
    cy: 32 * scale,
    outerRadius: 28 * scale,
    innerRadius: 23.5 * scale,
    outerTension: 1.15,
    innerTension: 0.85,
  })}")`;
}

export const SHELL_ROSETTE_CLIP_40 = shellRosetteClipPath(40);
export const SHELL_ROSETTE_CLIP_104 = shellRosetteClipPath(104);

/** Canonical Lock Screen morphing password dot shapes (viewBox 0 0 24 24, centered at 12, 12). */
export const LOCK_MORPH_SHAPES = Object.freeze({
  Cookie4: {
    lobes: 4,
    viewBox: "0 0 24 24",
    d: rosettePath({ lobes: 4, cx: 12, cy: 12, outerRadius: 10, innerRadius: 7.8, outerTension: 1.15, innerTension: 0.85 }),
  },
  Clover4: {
    lobes: 4,
    viewBox: "0 0 24 24",
    d: rosettePath({ lobes: 4, cx: 12, cy: 12, outerRadius: 10, innerRadius: 5.8, outerTension: 1.35, innerTension: 0.7 }),
  },
  Sunny: {
    lobes: 8,
    viewBox: "0 0 24 24",
    d: rosettePath({ lobes: 8, cx: 12, cy: 12, outerRadius: 10, innerRadius: 8.2, outerTension: 1.1, innerTension: 0.85 }),
  },
  Circle: {
    lobes: 4,
    viewBox: "0 0 24 24",
    d: rosettePath({ lobes: 4, cx: 12, cy: 12, outerRadius: 9.5, innerRadius: 9.5, outerTension: 1, innerTension: 1 }),
  },
  Cookie6: {
    lobes: 6,
    viewBox: "0 0 24 24",
    d: rosettePath({ lobes: 6, cx: 12, cy: 12, outerRadius: 10, innerRadius: 8, outerTension: 1.15, innerTension: 0.85 }),
  },
  Flower5: {
    lobes: 5,
    viewBox: "0 0 24 24",
    d: rosettePath({ lobes: 5, cx: 12, cy: 12, outerRadius: 10, innerRadius: 6.4, outerTension: 1.25, innerTension: 0.75 }),
  },
});

/**
 * Convert a stroke width authored on the 24x24 icon viewBox into non-scaling
 * CSS pixels for `zgui-paint` (`--zgui-stroke-width`).
 */
export function resolveIconStrokeWidthPx(size: number, strokeWidth = 2, viewBoxSize = 24): string {
  return `${Number(((strokeWidth * size) / viewBoxSize).toFixed(3))}px`;
}

/** Canonical resting 5-bar Tabler `waveform` (`mediaEq`) silhouette on `0 0 24 24`. */
export const MEDIA_EQ_REST_PATH = "M4 10.5v3\nM8 7v10\nM12 8v8\nM16 4v16\nM20 10v4";

const MEDIA_EQ_XS = [4, 8, 12, 16, 20] as const;
const MEDIA_EQ_REST_HEIGHTS = [3, 10, 8, 16, 4] as const;
const MEDIA_EQ_WAVE_SPECS = [
  { min: 3.0, max: 9.5, freqHz: 1.21, phase: 0.3 },
  { min: 4.5, max: 14.5, freqHz: 1.54, phase: 1.7 },
  { min: 5.0, max: 16.0, freqHz: 1.33, phase: 3.1 },
  { min: 5.5, max: 16.0, freqHz: 1.68, phase: 4.4 },
  { min: 3.0, max: 10.0, freqHz: 1.15, phase: 2.3 },
] as const;

function formatMediaEqBars(heights: readonly number[]): string {
  return MEDIA_EQ_XS.map((x, index) => {
    const height = heights[index]!;
    const y0 = 12 - height / 2;
    return `M${x} ${fmt(y0)}v${fmt(height)}`;
  }).join("\n");
}

/**
 * Generates an analytically symmetric 5-bar waveform SVG path on `0 0 24 24` centered at `y = 12`.
 * When `amplitudeScale <= 0.005`, returns the exact resting `mediaEq` Tabler path.
 */
export function buildMediaEqWavePath(amplitudeScale: number, phaseSec: number): string {
  const amp = Math.max(0, Math.min(1, amplitudeScale));
  if (amp <= 0.005) {
    return MEDIA_EQ_REST_PATH;
  }
  const heights = MEDIA_EQ_WAVE_SPECS.map((spec, index) => {
    const rest = MEDIA_EQ_REST_HEIGHTS[index]!;
    const mid = (spec.min + spec.max) / 2;
    const span = (spec.max - spec.min) / 2;
    const wave = mid + span * Math.sin(phaseSec * Math.PI * 2 * spec.freqHz + spec.phase);
    return Math.max(2.5, Math.min(16.5, rest + amp * (wave - rest)));
  });
  return formatMediaEqBars(heights);
}
