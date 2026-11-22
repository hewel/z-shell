import { Show, type NativeChild } from "@hewel/zgui";
import { M3Switch } from "@z-shell/sdk/primitives";

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

export function ShellSwitch(props: {
  checked: boolean;
  ariaLabel: string;
  disabled?: boolean;
  testId?: string;
  onToggle: () => void;
}): NativeChild {
  return (
    <M3Switch
      checked={props.checked}
      ariaLabel={props.ariaLabel}
      {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
      {...(props.testId !== undefined ? { testId: props.testId } : {})}
      onToggle={props.onToggle}
    />
  );
}

export function SettingsSwitch(props: {
  label: string;
  detail?: string;
  checked: boolean;
  disabled?: boolean;
  testId?: string;
  onToggle: () => void;
}): NativeChild {
  return (
    <row style={{
      ...grow, alignItems: "center", justifyContent: "space-between", gap: "10px",
      padding: "10px 12px", borderRadius: "14px", backgroundColor: container,
    }}>
      <column style={{ ...grow, gap: "1px" }}>
        <text style={{ ...clipped, fontSize: "12px", fontWeight: 500 }}>{props.label}</text>
        <Show when={props.detail} fallback={<box style={hiddenSection} />}>
          <text style={{ ...clipped, fontSize: "11px", color: muted }}>{props.detail}</text>
        </Show>
      </column>
      <ShellSwitch
        checked={props.checked}
        ariaLabel={props.label}
        {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
        {...(props.testId !== undefined ? { testId: props.testId } : {})}
        onToggle={props.onToggle}
      />
    </row>
  );
}
