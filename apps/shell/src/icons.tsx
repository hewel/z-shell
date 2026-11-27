import { createDelay, createEffect, createMemo, createSignal, cx, onCleanup } from "@hewel/zgui";
import styles from "./icons.module.css";
import { createM3Spring, createPhaseLoop, useMotionScheme } from "./motion.ts";
import {
  SHELL_ROSETTE_PATH,
  buildMediaEqWavePath,
  resolveIconStrokeWidthPx,
} from "./shapes.ts";
import { TABLER_ICON_PATHS } from "./tabler-icons.generated.ts";

export interface ShellIconDefinition {
  readonly viewBox: string;
  readonly d: string;
  readonly expressiveFilledOnly?: boolean;
}

export const SHELL_ICON_PATHS = {
  shellEmblem: {
    viewBox: "0 0 64 64",
    d: SHELL_ROSETTE_PATH,
    expressiveFilledOnly: true,
  },
  ...TABLER_ICON_PATHS,
} as const satisfies Readonly<Record<string, ShellIconDefinition>>;

export type ShellIconName = keyof typeof SHELL_ICON_PATHS;

export { resolveIconStrokeWidthPx };

function VectorGlyph(props: {
  readonly d: string;
  readonly viewBox: string;
  readonly size: number;
  readonly color: string;
  readonly strokeWidth: number;
  readonly filled?: boolean | undefined;
  readonly testId?: string | undefined;
  readonly label?: string | undefined;
}) {
  const resolvedSize = () => `${props.size}px`;
  const useFilled = () => Boolean(props.filled);
  return (
    <vector
      d={props.d}
      viewBox={props.viewBox}
      ariaHidden={props.label ? null : true}
      ariaLabel={props.label ?? null}
      testId={props.testId ?? null}
      class={useFilled() ? styles.icon : cx(styles.icon, styles.outline)}
      style={{
        width: resolvedSize(),
        height: resolvedSize(),
        color: props.color,
        ...(useFilled() ? { "--zgui-fill": props.color } : {}),
        "--zgui-stroke": useFilled() ? "transparent" : props.color,
        "--zgui-stroke-width": useFilled() ? "0px" : resolveIconStrokeWidthPx(props.size, props.strokeWidth),
      }}
    />
  );
}

/**
 * Render a Tier 1 Tabler v3.53 system UI icon (pure 2px round Outline on a 24x24
 * viewBox, scaled proportionally to `size / 24` CSS pixels) or the Tier 2 M3
 * Expressive `shellEmblem` mark.
 */
export function ShellIcon(props: {
  name: ShellIconName;
  size?: number | undefined;
  color?: string | undefined;
  strokeWidth?: number | undefined;
  testId?: string | undefined;
  label?: string | undefined;
}) {
  const icon = (): ShellIconDefinition => SHELL_ICON_PATHS[props.name];
  return (
    <VectorGlyph
      d={icon().d}
      viewBox={icon().viewBox}
      size={props.size ?? 16}
      color={props.color ?? "var(--color-on-surface)"}
      strokeWidth={props.strokeWidth ?? 2}
      filled={icon().expressiveFilledOnly}
      testId={props.testId}
      label={props.label}
    />
  );
}

interface MediaEqIconProps {
  readonly active: boolean;
  /** Optional timer cadence in ms (e.g. `42` for ~24fps) to avoid full-refresh bar redraws. */
  readonly stepMs?: number | undefined;
  readonly size?: number | undefined;
  readonly color?: string | undefined;
  readonly inactiveColor?: string | undefined;
  readonly strokeWidth?: number | undefined;
  readonly testId?: string | undefined;
  readonly label?: string | undefined;
}

/**
 * Playback-driven 5-bar waveform glyph on the canonical 24x24 Tabler grid.
 * Breathes smoothly while `active` is true and `scheme !== "reduced"` (either on the shared
 * frame loop or throttled via `stepMs`), and settles back to the exact resting `mediaEq`
 * silhouette at 0% idle CPU when inactive, muted, or in reduced motion.
 */
export function MediaEqIcon(props: MediaEqIconProps) {
  const scheme = useMotionScheme();
  const useThrottledTimer = () => (props.stepMs ?? 0) > 0;
  const waveAmplitude = createM3Spring(() => (props.active && scheme() !== "reduced" ? 1 : 0), "defaultSpatial", { scheme });
  const colorMix = createM3Spring(() => (props.active ? 1 : 0), "fastEffects", { scheme });
  const sharedPhase = createPhaseLoop(() => props.active && !useThrottledTimer(), 1, scheme);
  const [throttledPhase, setThrottledPhase] = createSignal(0);

  const delay = createDelay();
  let lastMs: number | undefined;
  onCleanup(() => delay.cancel());
  createEffect(
    () => (props.active && scheme() !== "reduced" && useThrottledTimer() ? props.stepMs! : 0),
    intervalMs => {
      delay.cancel();
      if (intervalMs <= 0) {
        lastMs = undefined;
        return;
      }
      lastMs = Date.now();
      const tick = () => {
        const nowMs = Date.now();
        const dt = Math.min(0.1, Math.max(intervalMs / 1000, (nowMs - (lastMs ?? nowMs)) / 1000));
        lastMs = nowMs;
        setThrottledPhase(prev => prev + dt);
        delay.schedule(intervalMs, tick);
      };
      delay.schedule(intervalMs, tick);
    },
  );

  const path = createMemo(() =>
    buildMediaEqWavePath(waveAmplitude(), useThrottledTimer() ? throttledPhase() : sharedPhase()),
  );
  const resolvedColor = () => {
    const activeColor = props.color ?? "var(--color-on-surface)";
    const inactiveColor = props.inactiveColor;
    if (!inactiveColor || inactiveColor === activeColor) {
      return activeColor;
    }
    const pct = Math.round(Math.max(0, Math.min(1, colorMix())) * 100);
    if (pct >= 100) return activeColor;
    if (pct <= 0) return inactiveColor;
    return `color-mix(in srgb, ${activeColor} ${pct}%, ${inactiveColor})`;
  };
  return (
    <VectorGlyph
      d={path()}
      viewBox="0 0 24 24"
      size={props.size ?? 16}
      color={resolvedColor()}
      strokeWidth={props.strokeWidth ?? 2}
      testId={props.testId}
      label={props.label}
    />
  );
}
