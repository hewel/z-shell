import { describe, expect, test } from "bun:test";
import type { NativeWindowRect } from "@hewel/zgui";
import { MAX_BLUR_RECTS, SUPERELLIPSE_EXPONENT, mergeRoundedBlurRegions, roundedRectBlurRegion } from "../src/blur.ts";

function isPointInsideRoundedRect(px: number, py: number, rect: NativeWindowRect, radius: number, exponent = 2): boolean {
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.width;
  const y1 = rect.y + rect.height;
  if (px < x0 - 1e-6 || px > x1 + 1e-6 || py < y0 - 1e-6 || py > y1 + 1e-6) return false;
  const r = Math.min(radius, rect.width / 2, rect.height / 2);
  if (r <= 0) return true;
  const cx = px < x0 + r ? x0 + r : px > x1 - r ? x1 - r : px;
  const cy = py < y0 + r ? y0 + r : py > y1 - r ? y1 - r : py;
  const norm = Math.pow(Math.abs(px - cx) / r, exponent) + Math.pow(Math.abs(py - cy) / r, exponent);
  return norm <= 1 + 1e-6;
}

function assertPixelCenterInsideRoundedRect(
  strips: readonly NativeWindowRect[],
  rect: NativeWindowRect,
  radius: number,
  label: string,
  exponent = 2,
): void {
  expect(strips.length, `${label}: non-empty`).toBeGreaterThan(0);
  const x0 = Math.ceil(rect.x);
  const y0 = Math.ceil(rect.y);
  const x1 = Math.floor(rect.x + rect.width);
  const y1 = Math.floor(rect.y + rect.height);
  for (const strip of strips) {
    expect(Number.isInteger(strip.x), `${label}: integer x`).toBe(true);
    expect(Number.isInteger(strip.y), `${label}: integer y`).toBe(true);
    expect(Number.isInteger(strip.width), `${label}: integer width`).toBe(true);
    expect(Number.isInteger(strip.height), `${label}: integer height`).toBe(true);
    expect(strip.width, `${label}: positive width`).toBeGreaterThan(0);
    expect(strip.height, `${label}: positive height`).toBeGreaterThan(0);
    // Strictly inside the card's integer bounding box (zero shadowBleed leak).
    expect(strip.x, `${label}: strip.x >= x0`).toBeGreaterThanOrEqual(x0);
    expect(strip.y, `${label}: strip.y >= y0`).toBeGreaterThanOrEqual(y0);
    expect(strip.x + strip.width, `${label}: strip right <= x1`).toBeLessThanOrEqual(x1);
    expect(strip.y + strip.height, `${label}: strip bottom <= y1`).toBeLessThanOrEqual(y1);
    // All 4 edge pixel centers lie strictly inside the painted curve (>= 50% pixel coverage).
    const pixelCenters = [
      [strip.x + 0.5, strip.y + 0.5],
      [strip.x + strip.width - 0.5, strip.y + 0.5],
      [strip.x + 0.5, strip.y + strip.height - 0.5],
      [strip.x + strip.width - 0.5, strip.y + strip.height - 0.5],
    ] as const;
    for (const [cx, cy] of pixelCenters) {
      expect(
        isPointInsideRoundedRect(cx, cy, rect, radius, exponent),
        `${label}: pixel center (${cx},${cy}) inside rounded rect`,
      ).toBe(true);
    }
  }
}

describe("roundedRectBlurRegion & mergeRoundedBlurRegions (ext_background_effect_v1)", () => {
  test("22px popover panel produces <= 45 coalesced integer strips aligned to pixel centers", () => {
    const rect: NativeWindowRect = { x: 0, y: 0, width: 396, height: 520 };
    const strips = roundedRectBlurRegion(rect, 22);
    expect(strips.length).toBeLessThanOrEqual(45);
    assertPixelCenterInsideRoundedRect(strips, rect, 22, "panel-22px");
    // Straight middle body must cover full width [0, 396] without splitting.
    const middle = strips.find(s => s.x === 0 && s.width === 396);
    expect(middle).toBeDefined();
    expect(middle!.height).toBeGreaterThanOrEqual(520 - 44);
  });

  test("pill capsule (OSD 280x48 R=999 -> effective R=24) clamps radius and stays interior", () => {
    const rect: NativeWindowRect = { x: 32, y: 24, width: 280, height: 48 };
    const strips = roundedRectBlurRegion(rect, 999);
    expect(strips.length).toBeLessThanOrEqual(48);
    assertPixelCenterInsideRoundedRect(strips, rect, 24, "osd-pill");
    // Must never leak into transparent shadowBleed padding outside [32..312, 24..72].
    for (const s of strips) {
      expect(s.x).toBeGreaterThanOrEqual(32);
      expect(s.x + s.width).toBeLessThanOrEqual(312);
      expect(s.y).toBeGreaterThanOrEqual(24);
      expect(s.y + s.height).toBeLessThanOrEqual(72);
    }
  });

  test("fractional coordinates shrink inward before stripping so outward rounding never leaks", () => {
    const rect: NativeWindowRect = { x: 10.3, y: 14.7, width: 120.4, height: 32.2 };
    const strips = roundedRectBlurRegion(rect, 16);
    assertPixelCenterInsideRoundedRect(strips, rect, 16, "fractional-bar-island");
  });

  test("mergeRoundedBlurRegions enforces <= 256 protocol ceiling across many islands while keeping pixel-center containment", () => {
    const shapes = Array.from({ length: 14 }, (_, i) => ({
      rect: { x: 14 + i * 96, y: 14, width: 84, height: 40 },
      radius: 20,
    }));
    const merged = mergeRoundedBlurRegions(shapes);
    expect(merged.length).toBeGreaterThan(0);
    expect(merged.length).toBeLessThanOrEqual(MAX_BLUR_RECTS);
    // Every merged strip's edge pixel centers must belong inside one of the input rounded islands.
    for (const strip of merged) {
      const contained = shapes.some(shape => {
        const centers = [
          [strip.x + 0.5, strip.y + 0.5],
          [strip.x + strip.width - 0.5, strip.y + 0.5],
          [strip.x + 0.5, strip.y + strip.height - 0.5],
          [strip.x + strip.width - 0.5, strip.y + strip.height - 0.5],
        ] as const;
        return centers.every(([cx, cy]) => isPointInsideRoundedRect(cx, cy, shape.rect, shape.radius));
      });
      expect(contained, `strip ${JSON.stringify(strip)} inside an island`).toBe(true);
    }
  });

  test("22px superellipse(2.83) panel hugs squircle boundary without flat-tangent unblurred notches", () => {
    const rect: NativeWindowRect = { x: 0, y: 0, width: 396, height: 520 };
    const strips = roundedRectBlurRegion(rect, 22, 1, SUPERELLIPSE_EXPONENT);
    expect(strips.length).toBeLessThanOrEqual(45);
    assertPixelCenterInsideRoundedRect(strips, rect, 22, "panel-22px-superellipse", SUPERELLIPSE_EXPONENT);
    // Top row y=0 covers flat superellipse tangent (inset <= 14px, not 22px) and full-width middle expands into y=14..506.
    const topStrip = strips.find(s => s.y === 0);
    expect(topStrip).toBeDefined();
    expect(topStrip!.x, "top row hugs superellipse tangent without 8px unblurred notch").toBeLessThanOrEqual(14);
    const middle = strips.find(s => s.x === 0 && s.width === 396);
    expect(middle).toBeDefined();
    expect(middle!.y, "full-width band starts by y=14 without 1px vertical dark notch").toBeLessThanOrEqual(14);
  });

  test("handles zero radius and empty/invalid rects safely", () => {
    expect(roundedRectBlurRegion({ x: 4, y: 8, width: 100, height: 40 }, 0)).toEqual([
      { x: 4, y: 8, width: 100, height: 40 },
    ]);
    expect(roundedRectBlurRegion({ x: 0, y: 0, width: 0, height: 40 }, 16)).toEqual([]);
    expect(roundedRectBlurRegion({ x: Number.NaN, y: 0, width: 100, height: 40 }, 16)).toEqual([]);
    expect(mergeRoundedBlurRegions([])).toEqual([]);
  });
});
