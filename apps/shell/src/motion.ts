import { createEffect, createSignal, type Accessor } from "@hewel/zgui";
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
  width: 22px;
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
  const scale = 0.94 + spatialProgress * 0.06;
  switch (position) {
    case "left":
      return {
        opacity,
        transform: `translateX(${(-8 * remaining).toFixed(2)}px) scale(${scale.toFixed(4)})`,
        transformOrigin: centered ? "center left" : "bottom left",
      };
    case "right":
      return {
        opacity,
        transform: `translateX(${(8 * remaining).toFixed(2)}px) scale(${scale.toFixed(4)})`,
        transformOrigin: centered ? "center right" : "bottom right",
      };
    default:
      return {
        opacity,
        transform: `translateY(${(-8 * remaining).toFixed(2)}px) scale(${scale.toFixed(4)})`,
        transformOrigin: centered ? "top center" : "top right",
      };
  }
}

export function scrimBackdrop(maxPercent: number, progress: number): string {
  const pct = (maxPercent * Math.max(0, Math.min(1, progress))).toFixed(1);
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
 * Keeps the last non-null value alive while a programmatic `fastEffects` (~100ms) exit animation
 * runs, swaps immediately on non-null handoffs, and retires synchronously on `dismissInstant()`.
 */
export function createRetainedPresence<T>(
  source: Accessor<T | null | undefined>,
  options: PresenceOptions = {},
): {
  readonly value: Accessor<T | null>;
  readonly visible: Accessor<boolean>;
  readonly progress: M3Spring;
  readonly opacity: M3Spring;
  readonly dismissInstant: () => void;
} {
  const initial = source();
  const [retained, setRetained] = createSignal<{ readonly current: T } | null>(
    initial != null ? { current: initial } : null,
  );
  const visible = () => source() != null;
  const presence = createPresence(visible, options);

  createEffect(source, next => {
    if (next != null) setRetained({ current: next });
  });

  createEffect(presence.mounted, isMounted => {
    if (!isMounted && source() == null) setRetained(null);
  });

  const dismissInstant = (): void => {
    presence.dismissInstant();
    setRetained(null);
  };

  return {
    value: () => (presence.mounted() ? (source() ?? retained()?.current ?? null) : null),
    visible,
    progress: presence.progress,
    opacity: presence.opacity,
    dismissInstant,
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
