import { describe, expect, test } from "bun:test";
import {
  M3_DURATIONS,
  M3_EASINGS,
  M3_SPRINGS,
  SPRING_EPSILON,
  createFrameScheduler,
  resolveMotionScheme,
  resolveSpringSpec,
  sampleSpring,
  type SpringRole,
} from "../src/motion.ts";

describe("M3 analytical spring physics & shared frame scheduler", () => {
  test("critically damped high-stiffness fast.effects (k=3800, ζ=1.0) is stable at 60Hz and strictly monotonic with zero overshoot", () => {
    const spec = M3_SPRINGS.standard.fastEffects;
    expect(spec).toEqual({ stiffness: 3800, dampingRatio: 1.0 });

    let prev = 0;
    let settledAtSec: number | null = null;
    for (let frame = 0; frame <= 60; frame++) {
      const t = frame / 60;
      const sample = sampleSpring(spec, 0, 1, 0, t, SPRING_EPSILON.unit);
      expect(Number.isFinite(sample.value)).toBe(true);
      expect(Number.isFinite(sample.velocity)).toBe(true);
      expect(sample.value).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(sample.value).toBeLessThanOrEqual(1);
      prev = sample.value;
      if (sample.settled && settledAtSec === null) settledAtSec = t;
    }
    expect(settledAtSec).not.toBeNull();
    expect(settledAtSec!).toBeLessThanOrEqual(0.25);
  });

  test("all *.effects springs across standard and expressive schemes are critically damped and never overshoot", () => {
    const effectsRoles: readonly SpringRole[] = ["fastEffects", "defaultEffects", "slowEffects"];
    for (const scheme of ["standard", "expressive"] as const) {
      for (const role of effectsRoles) {
        const spec = M3_SPRINGS[scheme][role];
        expect(spec.dampingRatio, `${scheme}.${role}`).toBe(1.0);
        for (let step = 0; step <= 200; step++) {
          const sample = sampleSpring(spec, 0, 1, 0, step * 0.005, SPRING_EPSILON.unit);
          expect(sample.value).toBeGreaterThanOrEqual(0);
          expect(sample.value).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test("expressive fastSpatial (k=800, ζ=0.6) exhibits tactile overshoot and settles cleanly", () => {
    const spec = M3_SPRINGS.expressive.fastSpatial;
    let maxVal = 0;
    let settled = false;
    for (let step = 0; step <= 120; step++) {
      const sample = sampleSpring(spec, 0, 1, 0, step * 0.01, SPRING_EPSILON.unit);
      if (sample.value > maxVal) maxVal = sample.value;
      if (sample.settled) settled = true;
    }
    expect(maxVal).toBeGreaterThan(1.05);
    expect(settled).toBe(true);
  });

  test("mid-flight retargeting preserves position and velocity continuity", () => {
    const spec = M3_SPRINGS.standard.defaultSpatial;
    const mid = sampleSpring(spec, 0, 100, 0, 0.06, SPRING_EPSILON.px);
    expect(mid.settled).toBe(false);
    expect(mid.velocity).toBeGreaterThan(0);

    // Reverse target mid-flight from (mid.value, mid.velocity) -> 0.
    const immediate = sampleSpring(spec, mid.value, 0, mid.velocity, 0, SPRING_EPSILON.px);
    expect(immediate.value).toBeCloseTo(mid.value, 6);
    expect(immediate.velocity).toBeCloseTo(mid.velocity, 6);

    // Shortly after reversal, momentum carries forward slightly before turning around, then settles at 0.
    const after = sampleSpring(spec, mid.value, 0, mid.velocity, 0.004, SPRING_EPSILON.px);
    expect(after.value).toBeGreaterThan(mid.value);
    const end = sampleSpring(spec, mid.value, 0, mid.velocity, 1.0, SPRING_EPSILON.px);
    expect(end).toEqual({ value: 0, velocity: 0, settled: true });
  });

  test("resolveMotionScheme enforces host reduced motion override and reduced spring fallback", () => {
    expect(resolveMotionScheme("expressive", true)).toBe("reduced");
    expect(resolveMotionScheme(undefined, false)).toBe("standard");
    expect(resolveMotionScheme("expressive", false)).toBe("expressive");
    expect(resolveSpringSpec("reduced", "defaultSpatial", "expressive")).toEqual(M3_SPRINGS.standard.fastEffects);
    expect(resolveSpringSpec("standard", "fastSpatial", "expressive")).toEqual(M3_SPRINGS.expressive.fastSpatial);
    expect(M3_EASINGS.emphasizedDecelerate).toBe("cubic-bezier(0.05, 0.7, 0.1, 1.0)");
    expect(M3_DURATIONS.short2).toBe(100);
  });

  test("shared frame scheduler runs one frame callback for multiple tickers and stops at zero idle CPU", () => {
    let clock = 0;
    let nextId = 1;
    let requestCalls = 0;
    let cancelCalls = 0;
    const pending = new Map<number, (ts: number) => void>();

    const scheduler = createFrameScheduler({
      now: () => clock,
      requestFrame: cb => {
        requestCalls++;
        const id = nextId++;
        pending.set(id, cb);
        return id;
      },
      cancelFrame: id => {
        cancelCalls++;
        pending.delete(id);
      },
    });

    const tickFrame = (dtMs: number) => {
      clock += dtMs;
      const batch = [...pending.entries()];
      pending.clear();
      for (const [, cb] of batch) cb(clock);
    };

    let ticksA = 0;
    let ticksB = 0;
    scheduler.register(() => ++ticksA < 2);
    scheduler.register(() => ++ticksB < 3);

    expect(scheduler.activeCount()).toBe(2);
    expect(requestCalls).toBe(1);

    tickFrame(16);
    expect(scheduler.activeCount()).toBe(2);
    expect(requestCalls).toBe(2);

    tickFrame(16);
    expect(scheduler.activeCount()).toBe(1);
    expect(requestCalls).toBe(3);

    tickFrame(16);
    expect(scheduler.activeCount()).toBe(0);
    expect(pending.size).toBe(0);
    expect(requestCalls).toBe(3);

    // Registering then immediately unregistering cancels the pending frame.
    const unsub = scheduler.register(() => true);
    expect(requestCalls).toBe(4);
    unsub();
    expect(cancelCalls).toBe(1);
    expect(scheduler.activeCount()).toBe(0);
  });
});
