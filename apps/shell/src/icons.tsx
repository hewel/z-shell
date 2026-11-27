import { createMemo, cx } from "@hewel/zgui";
import styles from "./icons.module.css";
import { createM3Spring, createPhaseLoop, useMotionScheme } from "./motion.ts";
import {
  SHELL_ROSETTE_PATH,
  buildMediaEqStatePath,
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
  const resolvedColor = () => props.color ?? "var(--color-on-surface)";
  const sizePx = () => props.size ?? 16;
  const useFilled = () => Boolean(icon().expressiveFilledOnly);
  const resolvedSize = () => `${sizePx()}px`;
  return (
    <vector
      d={icon().d}
      viewBox={icon().viewBox}
      ariaHidden={props.label ? null : true}
      ariaLabel={props.label ?? null}
      testId={props.testId ?? null}
      class={styles.icon}
      style={{
        width: resolvedSize(),
        height: resolvedSize(),
        color: resolvedColor(),
        "--zgui-fill": useFilled() ? resolvedColor() : "transparent",
        "--zgui-stroke": useFilled() ? "transparent" : resolvedColor(),
        "--zgui-stroke-width": useFilled() ? "0px" : resolveIconStrokeWidthPx(sizePx(), props.strokeWidth ?? 2),
      }}
    />
  );
}

/**
 * Playback-driven 5-bar waveform glyph on the canonical 24x24 Tabler grid.
 * - `"continuous"` mode breathes smoothly while `active` is true (stopping at 0% idle CPU when false or `reduced`),
 *   settling back to the exact resting `mediaEq` silhouette.
 * - `"state"` mode performs a single `defaultSpatial` expand/compress transition without a background loop (0% bar CPU).
 */
export function MediaEqIcon(props: {
  readonly active: boolean;
  readonly mode?: "continuous" | "state" | undefined;
  readonly size?: number | undefined;
  readonly color?: string | undefined;
  readonly strokeWidth?: number | undefined;
  readonly testId?: string | undefined;
  readonly label?: string | undefined;
}) {
  const scheme = useMotionScheme();
  const isContinuous = () => (props.mode ?? "continuous") === "continuous";
  const level = createM3Spring(
    () => (isContinuous() ? (props.active && scheme() !== "reduced" ? 1 : 0) : (props.active ? 1 : 0)),
    "defaultSpatial",
    { scheme },
  );
  const phase = createPhaseLoop(() => isContinuous() && props.active, 1, scheme);
  const path = createMemo(() => (
    isContinuous()
      ? buildMediaEqWavePath(level(), phase())
      : buildMediaEqStatePath(level())
  ));
  const resolvedColor = () => props.color ?? "var(--color-on-surface)";
  const sizePx = () => props.size ?? 16;
  const resolvedSize = () => `${sizePx()}px`;
  return (
    <vector
      d={path()}
      viewBox="0 0 24 24"
      ariaHidden={props.label ? null : true}
      ariaLabel={props.label ?? null}
      testId={props.testId ?? null}
      class={cx(styles.icon, styles.outline)}
      style={{
        width: resolvedSize(),
        height: resolvedSize(),
        color: resolvedColor(),
        "--zgui-stroke": resolvedColor(),
        "--zgui-stroke-width": resolveIconStrokeWidthPx(sizePx(), props.strokeWidth ?? 2),
      }}
    />
  );
}
