/**
 * Pure Material Design 3 analytical spring solver, token definitions, and single shared frame
 * scheduler. Zero Node/Bun/DOM/zgui dependencies so both QuickJS shell/plugins and unit tests
 * share one deterministic physics core.
 */

export type MotionScheme = "standard" | "expressive" | "reduced";

export type SpringRole =
  | "fastSpatial"
  | "defaultSpatial"
  | "slowSpatial"
  | "fastEffects"
  | "defaultEffects"
  | "slowEffects";

export interface SpringSpec {
  readonly stiffness: number;
  readonly dampingRatio: number;
}

export interface SpringSample {
  readonly value: number;
  readonly velocity: number;
  readonly settled: boolean;
}

export const SPRING_EPSILON = Object.freeze({
  px: 0.1,
  unit: 0.001,
  deg: 0.05,
} as const);

export const M3_SPRINGS = Object.freeze({
  standard: Object.freeze({
    fastSpatial: Object.freeze({ stiffness: 1400, dampingRatio: 0.9 }),
    defaultSpatial: Object.freeze({ stiffness: 700, dampingRatio: 0.9 }),
    slowSpatial: Object.freeze({ stiffness: 300, dampingRatio: 0.9 }),
    fastEffects: Object.freeze({ stiffness: 3800, dampingRatio: 1.0 }),
    defaultEffects: Object.freeze({ stiffness: 1600, dampingRatio: 1.0 }),
    slowEffects: Object.freeze({ stiffness: 800, dampingRatio: 1.0 }),
  }),
  expressive: Object.freeze({
    fastSpatial: Object.freeze({ stiffness: 800, dampingRatio: 0.6 }),
    defaultSpatial: Object.freeze({ stiffness: 380, dampingRatio: 0.8 }),
    slowSpatial: Object.freeze({ stiffness: 200, dampingRatio: 0.8 }),
    fastEffects: Object.freeze({ stiffness: 3800, dampingRatio: 1.0 }),
    defaultEffects: Object.freeze({ stiffness: 1600, dampingRatio: 1.0 }),
    slowEffects: Object.freeze({ stiffness: 800, dampingRatio: 1.0 }),
  }),
} as const);

export const M3_EASINGS = Object.freeze({
  emphasizedDecelerate: "cubic-bezier(0.05, 0.7, 0.1, 1.0)",
  emphasizedAccelerate: "cubic-bezier(0.3, 0.0, 0.8, 0.15)",
  standard: "cubic-bezier(0.2, 0.0, 0.0, 1.0)",
  standardDecelerate: "cubic-bezier(0.0, 0.0, 0.0, 1.0)",
  standardAccelerate: "cubic-bezier(0.3, 0.0, 1.0, 1.0)",
  linear: "linear",
} as const);

export const M3_DURATIONS = Object.freeze({
  short1: 50,
  short2: 100,
  short3: 150,
  short4: 200,
  medium1: 250,
  medium2: 300,
  medium3: 350,
  medium4: 400,
  long1: 450,
  long2: 500,
  long3: 550,
  long4: 600,
} as const);

export function isSpatialRole(role: SpringRole): boolean {
  return role === "fastSpatial" || role === "defaultSpatial" || role === "slowSpatial";
}

export function resolveMotionScheme(
  configured?: MotionScheme,
  hostReduced?: boolean,
): MotionScheme {
  if (hostReduced) return "reduced";
  return configured ?? "standard";
}

export function resolveSpringSpec(
  scheme: MotionScheme,
  role: SpringRole,
  overrideScheme?: "expressive",
): SpringSpec {
  if (scheme === "reduced") {
    return M3_SPRINGS.standard.fastEffects;
  }
  const activeScheme = overrideScheme === "expressive" ? "expressive" : scheme;
  return M3_SPRINGS[activeScheme][role];
}

/**
 * Exact closed-form analytical solution for a unit-mass damped harmonic oscillator (`m = 1`).
 * Numerically stable for arbitrary stiffness (including M3 `fast.effects` `k = 3800, ζ = 1.0`)
 * at any frame interval (`60Hz`–`240Hz`).
 */
export function sampleSpring(
  spec: SpringSpec,
  from: number,
  target: number,
  initialVelocity: number,
  elapsedSec: number,
  epsilon: number = SPRING_EPSILON.unit,
): SpringSample {
  if (!Number.isFinite(from) || !Number.isFinite(target) || !Number.isFinite(initialVelocity)) {
    return { value: Number.isFinite(target) ? target : 0, velocity: 0, settled: true };
  }
  const x0 = from - target;
  const v0 = initialVelocity;
  if (Math.abs(x0) <= epsilon && Math.abs(v0) <= epsilon * 10) {
    return { value: target, velocity: 0, settled: true };
  }

  const w0 = Math.sqrt(spec.stiffness);
  const z = spec.dampingRatio;
  const t = Math.max(0, elapsedSec);

  let dx: number;
  let v: number;

  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z);
    const decay = Math.exp(-z * w0 * t);
    const c = Math.cos(wd * t);
    const s = Math.sin(wd * t);
    const b = (v0 + z * w0 * x0) / wd;
    dx = decay * (x0 * c + b * s);
    v = decay * (v0 * c - ((z * w0 * v0 + spec.stiffness * x0) / wd) * s);
  } else if (z === 1) {
    const decay = Math.exp(-w0 * t);
    const a = v0 + w0 * x0;
    dx = decay * (x0 + a * t);
    v = decay * (v0 - w0 * a * t);
  } else {
    const root = Math.sqrt(z * z - 1);
    const r1 = -w0 * (z - root);
    const r2 = -w0 * (z + root);
    const c2 = (v0 - r1 * x0) / (r2 - r1);
    const c1 = x0 - c2;
    const e1 = Math.exp(r1 * t);
    const e2 = Math.exp(r2 * t);
    dx = c1 * e1 + c2 * e2;
    v = c1 * r1 * e1 + c2 * r2 * e2;
  }

  if (!Number.isFinite(dx) || !Number.isFinite(v)) {
    return { value: target, velocity: 0, settled: true };
  }

  const settled = Math.abs(dx) <= epsilon && Math.abs(v) <= epsilon * 10;
  return settled
    ? { value: target, velocity: 0, settled: true }
    : { value: target + dx, velocity: v, settled: false };
}

/**
 * Returns `true` while the ticker needs another frame, or `false` once settled so the shared
 * frame loop terminates automatically with zero idle CPU.
 */
export type FrameTicker = (nowMs: number) => boolean;

export interface FrameSchedulerHost {
  readonly now: () => number;
  readonly requestFrame: (callback: (timestampMs: number) => void) => number;
  readonly cancelFrame: (id: number) => void;
}

type GlobalMotionHost = {
  readonly performance?: { readonly now?: () => number };
  readonly __zgui?: { readonly getReducedMotion?: () => boolean };
};

export function isHostReducedMotion(): boolean {
  const host = globalThis as unknown as GlobalMotionHost;
  return host.__zgui?.getReducedMotion?.() === true;
}

const defaultHost: FrameSchedulerHost = {
  now: () => {
    const perf = (globalThis as unknown as GlobalMotionHost).performance;
    return typeof perf?.now === "function" ? perf.now() : Date.now();
  },
  requestFrame: callback => requestAnimationFrame(callback),
  cancelFrame: id => cancelAnimationFrame(id),
};

export interface FrameScheduler {
  readonly register: (ticker: FrameTicker) => () => void;
  readonly activeCount: () => number;
  readonly now: () => number;
}

export function createFrameScheduler(host: FrameSchedulerHost = defaultHost): FrameScheduler {
  const active = new Set<FrameTicker>();
  let frameId: number | undefined;

  function step(timestampMs: number): void {
    frameId = undefined;
    const nowMs = Number.isFinite(timestampMs) ? timestampMs : host.now();
    // Snapshot so tickers can safely register or unregister during a pass.
    for (const ticker of [...active]) {
      if (!active.has(ticker)) continue;
      if (!ticker(nowMs)) {
        active.delete(ticker);
      }
    }
    if (active.size > 0 && frameId === undefined) {
      frameId = host.requestFrame(step);
    }
  }

  return {
    register(ticker) {
      active.add(ticker);
      if (frameId === undefined) {
        frameId = host.requestFrame(step);
      }
      return () => {
        active.delete(ticker);
        if (active.size === 0 && frameId !== undefined) {
          host.cancelFrame(frameId);
          frameId = undefined;
        }
      };
    },
    activeCount: () => active.size,
    now: () => host.now(),
  };
}

const sharedScheduler = createFrameScheduler();

export function registerFrameTicker(ticker: FrameTicker): () => void {
  return sharedScheduler.register(ticker);
}

export function activeMotionTickerCount(): number {
  return sharedScheduler.activeCount();
}

export function motionNowMs(): number {
  return sharedScheduler.now();
}
