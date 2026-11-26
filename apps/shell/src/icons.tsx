import styles from "./icons.module.css";
import { SHELL_ROSETTE_PATH } from "./shapes.ts";
import { TABLER_ICON_PATHS } from "./tabler-icons.generated.ts";

export interface ShellIconDefinition {
  readonly viewBox: string;
  readonly d: string;
  readonly filledD?: string;
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

/**
 * Render a Tier 1 Tabler v3.53 system UI icon (2px round Outline by default, or
 * native Tabler Filled when `filled` is set and a filled variant exists) or the
 * Tier 2 M3 Expressive `shellEmblem` mark.
 */
export function ShellIcon(props: {
  name: ShellIconName;
  size?: number | undefined;
  color?: string | undefined;
  filled?: boolean | undefined;
  strokeWidth?: number | undefined;
  testId?: string | undefined;
  label?: string | undefined;
}) {
  const icon = (): ShellIconDefinition => SHELL_ICON_PATHS[props.name];
  const resolvedColor = () => props.color ?? "var(--color-on-surface)";
  const filledPath = () => (props.filled ? icon().filledD : undefined);
  const useFilled = () => Boolean(icon().expressiveFilledOnly || filledPath());
  const resolvedD = () => filledPath() ?? icon().d;
  const resolvedSize = () => `${props.size ?? 16}px`;
  return (
    <vector
      d={resolvedD()}
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
        "--zgui-stroke-width": useFilled() ? "0px" : `${props.strokeWidth ?? 2}px`,
      }}
    />
  );
}
