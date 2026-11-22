import {
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  getWindowRect,
  observeGeometry,
  onCleanup,
  type Accessor,
  type BlurRegion,
  type NativeNode,
  type NativeWindowRect,
} from "@hewel/zgui";

/** Protocol ceiling enforced by `zgui-js` native-host `setBlurRegion` (`<= 256` rects). */
export const MAX_BLUR_RECTS = 256;

/** Continuous superellipse exponent matching `DESIGN.md` (`--zgui-corner-shape: superellipse(2.83)`). */
export const SUPERELLIPSE_EXPONENT = 2.83;

export interface RoundedBlurShape {
  readonly rect: NativeWindowRect;
  readonly radius: number;
  /** Corner curve exponent (`2` = circular round, `2.83` = superellipse(2.83)). */
  readonly exponent?: number;
}

function appendMergedStrip(
  out: NativeWindowRect[],
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (width <= 0 || height <= 0) return;
  const prev = out[out.length - 1];
  if (prev && prev.x === x && prev.width === width && prev.y + prev.height === y) {
    out[out.length - 1] = { x: prev.x, y: prev.y, width: prev.width, height: prev.height + height };
    return;
  }
  out.push({ x, y, width, height });
}

/**
 * Approximates a rounded rectangle with integer logical horizontal strips that lie strictly
 * inside the corner circle arcs.
 *
 * Wayland `ext_background_effect_v1` uses integer `wl_region` rectangles and `zgui-platform-wayland`
 * rounds fractional blur rects outward. Outputting strictly interior integer strips guarantees:
 * 1. Outward integer rounding is an identity (zero 1px expansion leak),
 * 2. Every strip corner lies at distance <= radius from the corner arc center (zero corner leak),
 * 3. Transparent `shadowBleed` padding outside `rect` is never blurred.
 *
 * Equal-width adjacent rows are coalesced (`r = 22px` -> <= 41 strips, well below 256).
 */
export function roundedRectBlurRegion(
  rect: NativeWindowRect,
  radius: number,
  step = 1,
  exponent = 2,
): NativeWindowRect[] {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return [];
  }

  // Inward integer bounds ensure fractional coordinates never expand beyond the painted card.
  const x0 = Math.ceil(rect.x);
  const y0 = Math.ceil(rect.y);
  const x1 = Math.floor(rect.x + rect.width);
  const y1 = Math.floor(rect.y + rect.height);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return [];

  const safeRadius = Number.isFinite(radius) ? Math.max(0, radius) : 0;
  const r = Math.min(Math.ceil(safeRadius), Math.floor(w / 2), Math.floor(h / 2));
  if (r <= 0) {
    return [{ x: x0, y: y0, width: w, height: h }];
  }

  const n = Number.isFinite(exponent) && exponent > 0 ? exponent : 2;
  const bandStep = Math.max(1, Math.floor(step));
  const strips: NativeWindowRect[] = [];
  const cornerInset = (dy: number): number => {
    if (dy >= r) return r;
    const dx = n === 2
      ? Math.sqrt(Math.max(0, r * r - dy * dy))
      : r * Math.pow(Math.max(0, 1 - Math.pow(dy / r, n)), 1 / n);
    return Math.ceil(r - dx);
  };

  // Top corner arc: y in [y0, y0 + r). Worst-case distance from corner center (y0 + r) is at band top `y`.
  for (let y = y0; y < y0 + r; y += bandStep) {
    const bandEnd = Math.min(y0 + r, y + bandStep);
    const inset = cornerInset(y0 + r - y);
    appendMergedStrip(strips, x0 + inset, y, w - 2 * inset, bandEnd - y);
  }

  // Straight middle body: full width [x0, x1].
  const midStart = y0 + r;
  const midEnd = y1 - r;
  if (midEnd > midStart) {
    appendMergedStrip(strips, x0, midStart, w, midEnd - midStart);
  }

  // Bottom corner arc: y in [y1 - r, y1). Worst-case distance from corner center (y1 - r) is at `bandEnd`.
  for (let y = y1 - r; y < y1; y += bandStep) {
    const bandEnd = Math.min(y1, y + bandStep);
    const inset = cornerInset(bandEnd - (y1 - r));
    appendMergedStrip(strips, x0 + inset, y, w - 2 * inset, bandEnd - y);
  }

  return strips;
}

/**
 * Merges multiple rounded-rectangle blur regions into one flat integer `NativeWindowRect[]` list
 * guaranteed not to exceed `maxRects` (`256`). If fine 1px strips across many islands would exceed
 * `maxRects`, coarsens the vertical band step while preserving strict interior containment.
 */
export function mergeRoundedBlurRegions(
  shapes: readonly RoundedBlurShape[],
  maxRects = MAX_BLUR_RECTS,
): NativeWindowRect[] {
  if (shapes.length === 0 || maxRects <= 0) return [];
  for (const step of [1, 2, 3, 4, 6, 8, 12, 16, 24]) {
    const combined: NativeWindowRect[] = [];
    for (const shape of shapes) {
      const strips = roundedRectBlurRegion(shape.rect, shape.radius, step, shape.exponent ?? 2);
      for (const strip of strips) combined.push(strip);
      if (combined.length > maxRects) break;
    }
    if (combined.length <= maxRects) return combined;
  }
  // Last-resort fallback for extreme island counts: strictly inscribed single rect per shape.
  const fallback: NativeWindowRect[] = [];
  for (const shape of shapes) {
    const x0 = Math.ceil(shape.rect.x);
    const y0 = Math.ceil(shape.rect.y);
    const x1 = Math.floor(shape.rect.x + shape.rect.width);
    const y1 = Math.floor(shape.rect.y + shape.rect.height);
    const r = Math.max(0, Math.min(Math.ceil(shape.radius), Math.floor((x1 - x0) / 2), Math.floor((y1 - y0) / 2)));
    const inset = Math.ceil(r * (1 - Math.SQRT1_2));
    const width = x1 - x0 - 2 * inset;
    const height = y1 - y0 - 2 * inset;
    if (width > 0 && height > 0) {
      fallback.push({ x: x0 + inset, y: y0 + inset, width, height });
    }
    if (fallback.length >= maxRects) break;
  }
  return fallback;
}

function snapRect(rect: NativeWindowRect | null | undefined): NativeWindowRect | null {
  if (
    !rect ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return null;
  }
  const x0 = Math.ceil(rect.x);
  const y0 = Math.ceil(rect.y);
  const x1 = Math.floor(rect.x + rect.width);
  const y1 = Math.floor(rect.y + rect.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function sameRect(a: NativeWindowRect | null | undefined, b: NativeWindowRect | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Tracks a single rounded surface card (e.g. `PopupSurface` frame) via `observeGeometry` and
 * produces strictly interior rounded horizontal blur strips for `blurRegion`.
 */
export function createSingleNodeRoundedBlur(
  radius: number | Accessor<number>,
  enabled?: Accessor<boolean>,
  exponent = SUPERELLIPSE_EXPONENT,
): {
  readonly ref: (node: NativeNode) => void;
  readonly region: Accessor<BlurRegion>;
} {
  const [node, setNode] = createSignal<NativeNode | null>(null);
  const [rect, setRect] = createSignal<NativeWindowRect | null>(null);
  const readRadius = typeof radius === "function" ? radius : () => radius;

  const updateRect = (next: NativeWindowRect | null) => {
    const snapped = snapRect(next);
    setRect(prev => (sameRect(prev, snapped) ? prev : snapped));
  };

  createEffect(node, current => {
    if (!current) {
      updateRect(null);
      return;
    }
    updateRect(getWindowRect(current));
    const stop = observeGeometry(current, "borderBox", next => updateRect(next));
    return () => {
      stop();
      updateRect(null);
    };
  });

  const region = createMemo<BlurRegion>(() => {
    if (enabled && !enabled()) return "none";
    const box = rect();
    if (!box) return "none";
    const strips = roundedRectBlurRegion(box, readRadius(), 1, exponent);
    return strips.length > 0 ? strips : "none";
  });

  return {
    ref: current => setNode(current),
    region,
  };
}

export interface RoundedBlurGroup {
  /** Registers a child node's geometry inside the caller's Solid owner (cleans up automatically). */
  readonly useTarget: (customRadius?: number | Accessor<number>) => (node: NativeNode) => void;
  readonly region: Accessor<BlurRegion>;
}

/**
 * Tracks multiple rounded cards/islands on one transparent `LayerSurface` (e.g. floating StatusBar
 * islands or stacked NotificationToasts) and publishes one coalesced `BlurRegion` (`<= 256` rects).
 */
export function createRoundedBlurGroup(
  defaultRadius: number | Accessor<number>,
  enabled?: Accessor<boolean>,
  exponent = 2,
): RoundedBlurGroup {
  const readDefaultRadius = typeof defaultRadius === "function" ? defaultRadius : () => defaultRadius;
  const entries = new Map<symbol, { rect: NativeWindowRect; radius: () => number }>();
  const [revision, setRevision] = createSignal(0);
  const bump = () => setRevision(n => n + 1);

  const setEntry = (id: symbol, rect: NativeWindowRect | null, radius: () => number) => {
    const snapped = snapRect(rect);
    const prev = entries.get(id);
    if (!snapped) {
      if (prev) {
        entries.delete(id);
        bump();
      }
      return;
    }
    if (prev && sameRect(prev.rect, snapped)) return;
    entries.set(id, { rect: snapped, radius });
    bump();
  };

  const removeEntry = (id: symbol) => {
    if (entries.delete(id)) bump();
  };

  const region = createMemo<BlurRegion>(() => {
    revision();
    if (enabled && !enabled()) return "none";
    if (entries.size === 0) return "none";
    const shapes: RoundedBlurShape[] = [];
    for (const entry of entries.values()) {
      shapes.push({ rect: entry.rect, radius: entry.radius(), exponent });
    }
    const strips = mergeRoundedBlurRegions(shapes);
    return strips.length > 0 ? strips : "none";
  });

  return {
    useTarget(customRadius) {
      const id = Symbol();
      const readRadius =
        customRadius === undefined
          ? readDefaultRadius
          : typeof customRadius === "function"
            ? customRadius
            : () => customRadius;
      const [node, setNode] = createSignal<NativeNode | null>(null);

      createEffect(node, current => {
        if (!current) {
          removeEntry(id);
          return;
        }
        setEntry(id, getWindowRect(current), readRadius);
        const stop = observeGeometry(current, "borderBox", next => setEntry(id, next, readRadius));
        return () => {
          stop();
          removeEntry(id);
        };
      });

      if (getOwner()) {
        onCleanup(() => removeEntry(id));
      }

      return current => setNode(current);
    },
    region,
  };
}
