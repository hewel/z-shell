import { Show, cx, type NativeChild } from "@hewel/zgui";
import { M3Switch } from "@z-shell/sdk/primitives";
import styles from "./shared.module.css";

export const primary = "var(--color-primary)";
export const onPrimary = "var(--color-on-primary)";
export const primaryContainer = "var(--color-primary-container)";
export const onPrimaryContainer = "var(--color-on-primary-container)";
export const onSurface = "var(--color-on-surface)";
export const muted = "var(--color-on-surface-variant)";
export const outline = "var(--color-outline)";
export const surface = "var(--color-surface)";
export const container = "var(--color-surface-container)";
export const containerHigh = "var(--color-surface-container-high)";
export const containerHighest = "var(--color-surface-container-highest)";
export const grow = { flexGrow: 1, flexBasis: "0px", minWidth: "0px" } as const;
export const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
export const hiddenSection = { display: "none" } as const;

export function SettingsSwitch(props: {
  label: string;
  detail?: string;
  checked: boolean;
  disabled?: boolean;
  compact?: boolean;
  testId?: string;
  onToggle: () => void;
}): NativeChild {
  return (
    <row class={cx(styles.switchRow)} data-compact={props.compact ? "true" : null}>
      <column class={cx(styles.switchTextColumn)}>
        <text class={cx(styles.switchLabel)}>{props.label}</text>
        <Show when={props.detail} fallback={<box class={cx(styles.hiddenSection)} />}>
          <text class={cx(styles.switchDetail)}>{props.detail}</text>
        </Show>
      </column>
      <M3Switch
        checked={props.checked}
        ariaLabel={props.label}
        {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
        {...(props.testId !== undefined ? { testId: props.testId } : {})}
        onToggle={props.onToggle}
      />
    </row>
  );
}
