import {
  createEffect,
  createSignal,
  createSpring,
  getOwner,
  getReducedMotion,
  onCleanup,
  untrack,
  type Accessor,
} from "@hewel/zgui";
import type { ZShellClient } from "./client.ts";
import {
  SPRING_EPSILON,
  isHostReducedMotion,
  isSpatialRole,
  motionNowMs,
  registerFrameTicker,
  resolveMotionScheme,
  resolveSpringSpec,
  type MotionScheme,
  type SpringRole,
} from "./motion.ts";

/** Canonical props injected by `PluginHost` into every plugin `[[settings_page]]` entry. */
export interface PluginSettingsProps {
  readonly client: Accessor<ZShellClient | undefined>;
  readonly readSettings?: () => Promise<Readonly<Record<string, unknown>>>;
  readonly patchSettings?: (
    patch: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
}

const [configuredMotionScheme, setConfiguredMotionScheme] = createSignal<MotionScheme>("standard");

/** Syncs the shell's active `[theme].motion_scheme` setting into the shared motion runtime. */
export function setGlobalMotionScheme(scheme: MotionScheme | undefined): void {
  setConfiguredMotionScheme(scheme ?? "standard");
}

function readHostReducedMotion(): boolean {
  try {
    return getReducedMotion();
  } catch {
    return isHostReducedMotion();
  }
}

/**
 * Resolves the effective M3 motion scheme shared by core shell surfaces and plugins,
 * combining the synced `settings.toml` preference with host reduced-motion accessibility.
 */
export function useGlobalMotionScheme(): Accessor<MotionScheme> {
  return () => resolveMotionScheme(configuredMotionScheme(), readHostReducedMotion());
}

export interface M3SpringOptions {
  readonly scheme?: Accessor<MotionScheme>;
  readonly overrideScheme?: "expressive";
  readonly epsilon?: number;
  readonly initial?: number;
}

export type M3Spring = Accessor<number> & {
  readonly jump: (value: number) => void;
  readonly impulse: (velocity: number) => void;
  readonly settled: Accessor<boolean>;
};

export interface PresenceState {
  readonly mounted: Accessor<boolean>;
  readonly progress: M3Spring;
  readonly opacity: M3Spring;
  /** Immediately retires the surface without exit animation (e.g. Wayland compositor `onDismiss`). */
  readonly dismissInstant: () => void;
}

export interface PresenceOptions {
  readonly scheme?: Accessor<MotionScheme>;
  readonly enterRole?: SpringRole;
  readonly enterOpacityRole?: Extract<SpringRole, "fastEffects" | "defaultEffects" | "slowEffects">;
  readonly exitRole?: Extract<SpringRole, "fastEffects" | "defaultEffects" | "slowEffects">;
  readonly overrideScheme?: "expressive";
  /** When true while `visible()` becomes false, skips exit animation and unmounts synchronously. */
  readonly instantExit?: Accessor<boolean>;
}

function attachSpringControls(
  read: Accessor<number>,
  settled: Accessor<boolean>,
  jump: (value: number) => void,
  impulse: (velocity: number) => void,
): M3Spring {
  return Object.defineProperties(read, {
    jump: { value: jump, enumerable: true },
    impulse: { value: impulse, enumerable: true },
    settled: { value: settled, enumerable: true },
  }) as M3Spring;
}

/**
 * Reactive Solid 2.0 Material Design 3 spring backed by `@hewel/zgui`'s shared `createSpring`
 * ticker (automatic rootless-shell zero-region parking/resumption, independent `settled` signal).
 * Preserves live velocity on mid-flight retargeting and obeys WCAG 2.2 SC 2.3.3 reduced motion.
 */
export function createM3Spring(
  target: Accessor<number>,
  role: SpringRole | Accessor<SpringRole>,
  options: M3SpringOptions = {},
): M3Spring {
  const epsilon = options.epsilon ?? SPRING_EPSILON.unit;
  const currentRole = (): SpringRole => (typeof role === "function" ? role() : role);
  const effectiveScheme = (): MotionScheme =>
    resolveMotionScheme(options.scheme ? options.scheme() : configuredMotionScheme(), readHostReducedMotion());
  const isSpatialReduced = (): boolean => effectiveScheme() === "reduced" && isSpatialRole(currentRole());
  const activeSpec = () => resolveSpringSpec(effectiveScheme(), currentRole(), options.overrideScheme);

  let lastFinite = 0;
  const safeTarget = (): number => {
    const next = target();
    if (Number.isFinite(next)) {
      lastFinite = next;
      return next;
    }
    return lastFinite;
  };
  const initialTarget = untrack(safeTarget);
  const initialPos =
    !untrack(isSpatialReduced) && options.initial !== undefined && Number.isFinite(options.initial)
      ? options.initial
      : initialTarget;

  const spring = createSpring(safeTarget, {
    stiffness: () => activeSpec().stiffness,
    // M3 tokens specify unit-mass damping ratio ζ; zgui's createSpring takes damping c = 2ζ√k.
    damping: () => {
      const spec = activeSpec();
      return 2 * spec.dampingRatio * Math.sqrt(spec.stiffness);
    },
    mass: 1,
    precision: epsilon,
    velocityPrecision: epsilon * 10,
    initial: initialPos,
  });

  createEffect(
    () => [isSpatialReduced(), safeTarget()] as const,
    ([snap, next]) => {
      if (snap) spring.jump(next);
    },
  );

  return attachSpringControls(
    () => (isSpatialReduced() ? safeTarget() : spring()),
    () => (isSpatialReduced() ? true : spring.settled()),
    next => {
      if (!Number.isFinite(next)) return;
      spring.jump(next);
    },
    deltaVelocity => {
      if (!Number.isFinite(deltaVelocity) || deltaVelocity === 0) return;
      if (effectiveScheme() === "reduced") return;
      spring.impulse(deltaVelocity);
    },
  );
}

/**
 * Coordinates enter/exit presence without blocking input during exit: mounts immediately when
 * `visible()` becomes true, animates out on programmatic close using `exitRole` (`fastEffects` by
 * default), and unmounts once settled. Call `dismissInstant()` (or supply `instantExit`) for
 * compositor-driven dismissals and security-critical instant hides.
 */
export function createPresence(
  visible: Accessor<boolean>,
  options: PresenceOptions = {},
): PresenceState {
  const initialVisible = untrack(visible);
  const [exiting, setExiting] = createSignal(false);
  let wasVisible = initialVisible;
  let skipNextExit = false;
  const enterRole = options.enterRole ?? "defaultSpatial";
  const enterOpacityRole = options.enterOpacityRole ?? "fastEffects";
  const exitRole = options.exitRole ?? "fastEffects";
  const progress = createM3Spring(
    () => (visible() ? 1 : 0),
    () => (visible() ? enterRole : exitRole),
    {
      ...(options.scheme ? { scheme: options.scheme } : {}),
      ...(options.overrideScheme ? { overrideScheme: options.overrideScheme } : {}),
      initial: initialVisible ? 1 : 0,
    },
  );
  const opacity = createM3Spring(
    () => (visible() ? 1 : 0),
    () => (visible() ? enterOpacityRole : exitRole),
    {
      ...(options.scheme ? { scheme: options.scheme } : {}),
      initial: initialVisible ? 1 : 0,
    },
  );

  const dismissInstant = (): void => {
    skipNextExit = true;
    setExiting(false);
    if (!untrack(visible)) {
      wasVisible = false;
      progress.jump(0);
      opacity.jump(0);
    }
  };

  createEffect(visible, isVisible => {
    if (isVisible) {
      wasVisible = true;
      skipNextExit = false;
      setExiting(false);
      return;
    }
    const shouldExit = wasVisible && !skipNextExit && !options.instantExit?.();
    wasVisible = false;
    skipNextExit = false;
    if (shouldExit) {
      setExiting(true);
    } else {
      setExiting(false);
      progress.jump(0);
      opacity.jump(0);
    }
  });

  createEffect(
    () => exiting() && !visible() && opacity.settled() && opacity() <= SPRING_EPSILON.unit,
    done => {
      if (done) setExiting(false);
    },
  );

  // `mounted` is strictly derived: whenever `visible()` is true the surface can never desync to unmounted.
  const mounted = (): boolean => visible() || exiting();
  return { mounted, progress, opacity, dismissInstant };
}

/**
 * Linear 0 -> 1 progress ramp driven through the single shared frame scheduler (for timed warning
 * scrims such as `pre_action_fade_seconds`). Jumps to 1 immediately when `durationMs <= 0` or
 * reduced motion is active, and unregisters cleanly once finished (0% idle CPU).
 */
export function createLinearProgress(
  durationMs: Accessor<number>,
  scheme?: Accessor<MotionScheme>,
): Accessor<number> {
  const [value, setValue] = createSignal(0);
  let unregister: (() => void) | undefined;
  let disposed = false;

  const stop = () => {
    unregister?.();
    unregister = undefined;
  };

  if (getOwner()) {
    onCleanup(() => {
      disposed = true;
      stop();
    });
  }

  createEffect(() => [durationMs(), scheme ? scheme() : configuredMotionScheme()] as const, ([ms, activeScheme]) => {
    stop();
    const resolved = resolveMotionScheme(activeScheme, readHostReducedMotion());
    if (resolved === "reduced" || !Number.isFinite(ms) || ms <= 0) {
      setValue(1);
      return;
    }
    const startMs = motionNowMs();
    setValue(0);
    unregister = registerFrameTicker(nowMs => {
      if (disposed) return false;
      const t = Math.max(0, Math.min(1, (nowMs - startMs) / ms));
      setValue(t);
      if (t >= 1) {
        unregister = undefined;
        return false;
      }
      return true;
    });
  });

  return value;
}

/**
 * Continuous bounded phase ticker driven through the single shared frame loop (for Media Player's
 * playing waveform). Stops immediately when `active()` is false or reduced motion is active.
 */
export function createPhaseLoop(
  active: Accessor<boolean>,
  speedUnitsPerSec: number,
  scheme?: Accessor<MotionScheme>,
): Accessor<number> {
  const [phase, setPhase] = createSignal(0);
  let unregister: (() => void) | undefined;
  let lastMs: number | undefined;
  let disposed = false;

  const stop = () => {
    unregister?.();
    unregister = undefined;
    lastMs = undefined;
  };

  if (getOwner()) {
    onCleanup(() => {
      disposed = true;
      stop();
    });
  }

  createEffect(() => active() && resolveMotionScheme(scheme?.(), readHostReducedMotion()) !== "reduced", running => {
    if (!running || disposed) {
      stop();
      return;
    }
    if (unregister !== undefined) return;
    lastMs = motionNowMs();
    unregister = registerFrameTicker(nowMs => {
      if (disposed) return false;
      const dt = Math.min(0.1, Math.max(0, (nowMs - (lastMs ?? nowMs)) / 1000));
      lastMs = nowMs;
      setPhase(prev => prev + dt * speedUnitsPerSec);
      return true;
    });
  });

  return phase;
}
