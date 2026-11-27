import styles from "./icons.module.css";
import { SHELL_ROSETTE_PATH, resolveIconStrokeWidthPx } from "./shapes.ts";
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
