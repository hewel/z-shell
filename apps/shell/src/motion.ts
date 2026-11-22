import {
  createEffect,
  createSignal,
  untrack,
  type Accessor,
  type NativeAnimationEvent,
  type NativeNode,
  type NativeTransitionEvent,
} from "@hewel/zgui";
import { createRetainedPresence as createZguiRetainedPresence } from "@hewel/zgui/primitives";
import {
  M3_DURATIONS,
  M3_EASINGS,
  M3_SPRINGS,
  SPRING_EPSILON,
  createLinearProgress,
  createM3Spring,
  createPhaseLoop,
  createPresence,
  isHostReducedMotion,
  resolveMotionScheme,
  type M3Spring,
  type MotionScheme,
  type PresenceOptions,
  type PresenceState,
  type SpringRole,
} from "@z-shell/sdk/zgui";
import { useShellStore } from "./store.ts";
import type { BarPosition } from "./topics.ts";

export {
  M3_DURATIONS,
  M3_EASINGS,
  M3_SPRINGS,
  SPRING_EPSILON,
  createLinearProgress,
  createM3Spring,
  createPhaseLoop,
  createPresence,
  resolveMotionScheme,
  type M3Spring,
  type MotionScheme,
  type PresenceOptions,
  type PresenceState,
  type SpringRole,
};

export interface MotionStyle {
  readonly opacity: number;
  readonly transform: string;
  readonly transformOrigin: string;
}

/** Reads `[theme].motion_scheme` from daemon settings, overridden by host reduced-motion preference. */
export function useMotionScheme(): Accessor<MotionScheme> {
  const { settings } = useShellStore();
  return () => resolveMotionScheme(settings.data()?.theme.motion_scheme, isHostReducedMotion());
}

export const SHELL_MOTION_CSS = `
[data-dock-visual] {
  transition-property: transform, background-color;
  transition-duration: var(--motion-duration-short3);
  transition-timing-function: var(--motion-easing-standard);
}
[data-dock-item]:hover > [data-dock-visual] {
  transform: translateY(-3px) scale(1.06);
}
[data-dock-item]:active > [data-dock-visual] {
  transform: translateY(-1px) scale(0.95);
}
[data-dock-trigger] {
  transition-property: background-color;
  transition-duration: var(--motion-duration-short2);
  transition-timing-function: var(--motion-easing-standard);
}
[data-dock-trigger]:hover {
  background-color: var(--color-surface-container-highest);
}
[data-dock-trigger]:active {
  background-color: var(--color-primary-container);
}
[data-ws-pill] {
  transition-property: width, height, background-color, opacity;
  transition-duration: var(--motion-duration-short4);
  transition-timing-function: var(--motion-easing-emphasized-decelerate);
}
[data-qs-tile] {
  transition-property: background-color, border-color;
  transition-duration: var(--motion-duration-short2);
  transition-timing-function: var(--motion-easing-standard);
}
[data-percent-fill] {
  transition-property: width;
  transition-duration: var(--motion-duration-short2);
  transition-timing-function: var(--motion-easing-standard);
}
[data-switch-track] {
  transition-property: background-color;
  transition-duration: var(--motion-duration-short2);
  transition-timing-function: var(--motion-easing-standard);
}
[data-switch-thumb] {
  transition-property: width, transform, background-color;
  transition-duration: var(--motion-duration-short2);
  transition-timing-function: var(--motion-easing-standard);
}
[data-switch-root]:active [data-switch-thumb] {
  width: 20px;
}
`;

export function createEnterProgress(
  role: SpringRole = "defaultSpatial",
  options?: { readonly scheme?: Accessor<MotionScheme>; readonly overrideScheme?: "expressive" },
): M3Spring {
  return createM3Spring(() => 1, role, {
    initial: 0,
    ...(options?.scheme ? { scheme: options.scheme } : {}),
    ...(options?.overrideScheme ? { overrideScheme: options.overrideScheme } : {}),
  });
}

export function createOpacityEnter(
  role: Extract<SpringRole, "fastEffects" | "defaultEffects" | "slowEffects"> = "fastEffects",
  scheme?: Accessor<MotionScheme>,
): M3Spring {
  return createM3Spring(() => 1, role, {
    initial: 0,
    ...(scheme ? { scheme } : {}),
  });
}

export function panelMotionStyle(
  spatialProgress: number,
  position: BarPosition = "top",
  centered = false,
  options?: { readonly opacity?: number; readonly reduced?: boolean },
): MotionStyle {
  const opacity = Math.max(0, Math.min(1, options?.opacity ?? spatialProgress));
  if (options?.reduced) {
    return { opacity, transform: "none", transformOrigin: "center" };
  }
  const remaining = 1 - spatialProgress;
  const scale = 0.95 + spatialProgress * 0.05;
  switch (position) {
    case "left":
      return {
        opacity,
        transform: `translateX(${(-6 * remaining).toFixed(2)}px) scale(${scale.toFixed(4)})`,
        transformOrigin: centered ? "center left" : "bottom left",
      };
    case "right":
      return {
        opacity,
        transform: `translateX(${(6 * remaining).toFixed(2)}px) scale(${scale.toFixed(4)})`,
        transformOrigin: centered ? "center right" : "bottom right",
      };
    default:
      return {
        opacity,
        transform: `translateY(${(-6 * remaining).toFixed(2)}px) scale(${scale.toFixed(4)})`,
        transformOrigin: centered ? "top center" : "top right",
      };
  }
}

/**
 * Two-layer shell/content micro-parallax (docs/design/motion.md §5.9):
 * inner content settles ~20-30ms behind the outer shell unfold with a subtle 4px glide.
 */
export function popoverContentMotionStyle(
  spatialProgress: number,
  opacityProgress: number,
  reduced = false,
): { readonly opacity: number; readonly transform: string } {
  const clampedOpacity = Math.max(0, Math.min(1, opacityProgress));
  if (reduced) {
    return { opacity: clampedOpacity, transform: "none" };
  }
  const delayedOpacity = Math.max(0, Math.min(1, (clampedOpacity - 0.14) / 0.86));
  const glideY = (1 - Math.max(0, Math.min(1.04, spatialProgress))) * -4;
  return {
    opacity: delayedOpacity,
    transform: `translateY(${glideY.toFixed(2)}px)`,
  };
}

export function scrimBackdrop(maxPercent: number, progress: number, dark = true): string {
  const effectiveMax = dark ? maxPercent : Math.min(28, Math.round(maxPercent * 0.5));
  const pct = (effectiveMax * Math.max(0, Math.min(1, progress))).toFixed(1);
  return `color-mix(in srgb, var(--color-scrim) ${pct}%, transparent)`;
}

export function dialogMotionStyle(
  spatialProgress: number,
  options?: { readonly opacity?: number; readonly reduced?: boolean; readonly fromScale?: number; readonly fromY?: number },
): MotionStyle {
  const opacity = Math.max(0, Math.min(1, options?.opacity ?? spatialProgress));
  if (options?.reduced) {
    return { opacity, transform: "none", transformOrigin: "center" };
  }
  const fromScale = options?.fromScale ?? 0.94;
  const fromY = options?.fromY ?? 10;
  const scale = fromScale + spatialProgress * (1 - fromScale);
  const offsetY = (1 - spatialProgress) * fromY;
  return {
    opacity,
    transform: `translateY(${offsetY.toFixed(2)}px) scale(${scale.toFixed(4)})`,
    transformOrigin: "center",
  };
}

/**
 * Retains the last non-nullish value across programmatic M3 `fastEffects` (~100ms) exit animations
 * via `@hewel/zgui/primitives`'s `createRetainedPresence` (safe falsy/function payload retention,
 * single-exit generation tracking, CSS + JS dual-gate), while adding M3 spatial/opacity springs
 * and synchronous `dismissInstant()` / `instantExit` retirement for Wayland grab/lock rules.
 */
export function createRetainedPresence<T>(
  source: Accessor<T | null | undefined>,
  options: PresenceOptions = {},
): {
  readonly value: Accessor<NonNullable<T> | null>;
  readonly visible: Accessor<boolean>;
  readonly progress: M3Spring;
  readonly opacity: M3Spring;
  readonly dismissInstant: () => void;
  readonly ref: (node: NativeNode) => void;
  readonly onEnd: (event: NativeAnimationEvent | NativeTransitionEvent) => void;
} {
  const initialPresent = untrack(source) != null;
  const visible = (): boolean => source() != null;
  const enterRole = options.enterRole ?? "defaultSpatial";
  const enterOpacityRole = options.enterOpacityRole ?? "fastEffects";
  const exitRole = options.exitRole ?? "fastEffects";

  const progress = createM3Spring(
    () => (visible() ? 1 : 0),
    () => (visible() ? enterRole : exitRole),
    {
      ...(options.scheme ? { scheme: options.scheme } : {}),
      ...(options.overrideScheme ? { overrideScheme: options.overrideScheme } : {}),
      initial: initialPresent ? 1 : 0,
    },
  );
  const opacity = createM3Spring(
    () => (visible() ? 1 : 0),
    () => (visible() ? enterOpacityRole : exitRole),
    {
      ...(options.scheme ? { scheme: options.scheme } : {}),
      initial: initialPresent ? 1 : 0,
    },
  );

  const [retired, setRetired] = createSignal(false);
  let skipNextExit = false;
  let hasCssSurface = false;

  const retained = createZguiRetainedPresence(source, {
    settled: () => retired() || (opacity.settled() && opacity() <= SPRING_EPSILON.unit),
  });

  createEffect(visible, isVisible => {
    if (isVisible) {
      skipNextExit = false;
      setRetired(false);
      return;
    }
    const instant = skipNextExit || Boolean(options.instantExit?.());
    skipNextExit = false;
    if (instant || (!hasCssSurface && untrack(opacity.settled) && untrack(opacity) <= SPRING_EPSILON.unit)) {
      setRetired(true);
      progress.jump(0);
      opacity.jump(0);
    }
  });

  const dismissInstant = (): void => {
    skipNextExit = true;
    if (!untrack(visible)) {
      setRetired(true);
      progress.jump(0);
      opacity.jump(0);
    }
  };

  return {
    value: () => {
      if (retired() || !retained.mounted()) return null;
      const current = retained.value();
      return current !== undefined ? current : null;
    },
    visible,
    progress,
    opacity,
    dismissInstant,
    ref: node => {
      hasCssSurface = true;
      retained.ref(node);
    },
    onEnd: retained.onEnd,
  };
}

/**
 * M3 Shared Axis X style (`±24px` horizontal slide + 30% delayed opacity ramp).
 * Used for Control Center parent <-> sub-panel drill-down while keeping `PopupSurface height="auto"`.
 */
export function sharedAxisXStyle(
  spatialProgress: number,
  direction: 1 | -1,
  reduced = false,
): { readonly opacity: number; readonly transform: string } {
  const clamped = Math.max(0, Math.min(1, spatialProgress));
  // Opacity ramps in over the latter 70% of the incoming transition.
  const opacity = reduced ? clamped : Math.max(0, Math.min(1, (clamped - 0.15) / 0.7));
  if (reduced) {
    return { opacity, transform: "none" };
  }
  const offsetX = (1 - spatialProgress) * 24 * direction;
  return {
    opacity,
    transform: `translateX(${offsetX.toFixed(2)}px)`,
  };
}
