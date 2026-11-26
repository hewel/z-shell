import { Button, For, createEffect, createMemo, createSignal, type NativeChild } from "@hewel/zgui";
import { M3CardAction, M3InteractiveCard, M3SegmentedControl, M3Slider } from "@z-shell/sdk/primitives";
import { ShellIcon } from "../../icons.tsx";
import { useShellStore } from "../../store.ts";
import {
  DEFAULT_BAR_TRAY_SETTINGS,
  formatBarClock,
  isImeTrayItem,
  partitionTrayItems,
  type BarPosition,
  type BarStyle,
} from "../../topics.ts";
import {
  SettingsSwitch,
  clipped,
  container,
  containerHigh,
  containerHighest,
  grow,
  muted,
  onPrimaryContainer,
  onSurface,
  primary,
  primaryContainer,
} from "./shared.tsx";

const BAR_STYLES: readonly { readonly id: BarStyle; readonly label: string; readonly testId: string }[] = [
  { id: "floating", label: "Floating islands", testId: "settings-bar-style-floating" },
  { id: "docked", label: "Docked flush", testId: "settings-bar-style-docked" },
];

const BAR_POSITIONS: readonly { readonly id: BarPosition; readonly label: string; readonly testId: string }[] = [
  { id: "top", label: "Top", testId: "settings-bar-pos-top" },
  { id: "left", label: "Left", testId: "settings-bar-pos-left" },
  { id: "right", label: "Right", testId: "settings-bar-pos-right" },
];

const GAP_PRESETS = [0, 8, 12, 14, 16, 24] as const;

export function BarLayoutPane(props?: { readonly onOpenTrayRules?: () => void }): NativeChild {
  const { settings, outputs, monitors, tray, ime, invokeHost } = useShellStore();
  const bar = () => settings.data()?.bar;
  const imeSettings = () => settings.data()?.ime;
  const [lastEnabledImeMode, setLastEnabledImeMode] = createSignal<"indicator_only" | "kimpanel">("indicator_only");
  createEffect(
    () => imeSettings()?.mode,
    mode => {
      if (mode === "indicator_only" || mode === "kimpanel") {
        setLastEnabledImeMode(mode);
      }
    },
  );
  const traySettings = () => bar()?.tray ?? DEFAULT_BAR_TRAY_SETTINGS;
  const showImeIndicator = () => Boolean(ime.data()?.available && ime.data()?.mode !== "disabled");
  const trayCounts = createMemo(() => {
    const items = (tray.data()?.items ?? []).filter(item => !(showImeIndicator() && isImeTrayItem(item)));
    const partitioned = partitionTrayItems(items, traySettings());
    const savedHidden = Object.values(traySettings().rules).filter(rule => rule === "hide").length;
    return {
      visible: partitioned.visible.length,
      collapsed: partitioned.collapsed.length,
      hidden: Math.max(partitioned.hidden.length, savedHidden),
      ruleCount: Object.keys(traySettings().rules).length,
    };
  });
  const style = (): BarStyle => bar()?.style ?? "floating";
  const position = (): BarPosition => bar()?.position ?? "top";
  const gaps = () => bar()?.gaps ?? 14;
  const patchBar = (patch: Record<string, unknown>) => {
    void invokeHost("settings.patch", { bar: patch });
  };
  const patchIme = (patch: Record<string, unknown>) => {
    void invokeHost("settings.patch", { ime: patch });
  };
  const primaryOutput = createMemo(() => outputs.data()?.outputs[0]);
  const monitorLabel = createMemo(() => {
    const out = primaryOutput();
    if (out) {
      const hz = out.refresh_mhz ? ` @ ${Math.round(out.refresh_mhz / 1000)}Hz` : "";
      const dims = out.width && out.height ? `${out.width}×${out.height}` : "active";
      return `${out.name ?? "Output"} · ${dims}${hz}`;
    }
    const m = monitors()[0];
    return m ? `${m.name} · ${m.width}×${m.height}` : "No outputs detected";
  });
  const sampleClock = () => formatBarClock(Date.now(), { clock24h: bar()?.clock_24h !== false, clockSeconds: false }).horizontal;
  const imeEnabled = () => imeSettings()?.mode !== "disabled";

  return (
    <column testId="settings-bar-pane" style={{ gap: "10px", width: "100%" }}>
      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "12px 14px", gap: "10px" }}>
        <row style={{ gap: "12px", width: "100%" }}>
          <column style={{ ...grow, gap: "6px" }}>
            <text style={{ fontSize: "12px", fontWeight: 600, color: onSurface }}>Bar style</text>
            <M3SegmentedControl
              ariaLabel="Bar style"
              options={BAR_STYLES}
              value={style()}
              onChange={next => patchBar({ style: next })}
            />
          </column>

          <column style={{ ...grow, gap: "6px" }}>
            <text style={{ fontSize: "12px", fontWeight: 600, color: onSurface }}>Screen edge</text>
            <M3SegmentedControl
              ariaLabel="Screen edge"
              options={BAR_POSITIONS}
              value={position()}
              onChange={next => patchBar({ position: next })}
            />
          </column>
        </row>

        <box ariaHidden style={{ width: "100%", height: "1px", backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 45%, transparent)" }} />

        <column style={{ gap: "6px" }}>
          <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
            <row style={{ alignItems: "baseline", gap: "8px" }}>
              <text style={{ fontSize: "13px", fontWeight: 600 }}>Outer &amp; popover gaps</text>
              <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600, color: primary, fontVariantNumeric: "tabular-nums" }}>
                {gaps()} px
              </text>
            </row>
            <row style={{ gap: "4px" }}>
              <For each={GAP_PRESETS} keyed={v => v}>
                {preset => {
                  const active = () => gaps() === preset();
                  return (
                    <Button selected={active()} onClick={() => patchBar({ gaps: preset() })} style={{
                      display: "flex", minWidth: "28px", minHeight: "24px", padding: "0 8px", borderRadius: "8px",
                      alignItems: "center", justifyContent: "center",
                      backgroundColor: active() ? primaryContainer : container,
                      border: active() ? "1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)" : "1px solid transparent",
                      color: active() ? onPrimaryContainer : muted,
                      fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: active() ? 600 : 500,
                    }}>
                      <text data-tabular="true" style={{ fontVariantNumeric: "tabular-nums" }}>{preset()}</text>
                    </Button>
                  );
                }}
              </For>
            </row>
          </row>
          <row style={{ width: "100%" }}>
            <M3Slider
              label="Outer & popover gaps"
              testId="settings-bar-gaps-slider"
              value={Math.round((gaps() / 64) * 100)}
              onChange={pct => patchBar({ gaps: Math.round((pct / 100) * 64) })}
            />
          </row>
        </column>
      </column>

      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "12px 14px", gap: "8px" }}>
        <text style={{ fontSize: "13px", fontWeight: 600 }}>Modules &amp; clock</text>
        <row style={{ gap: "8px", width: "100%" }}>
          <SettingsSwitch compact testId="settings-bar-launcher" label="Launcher trigger" detail="Material apps grid"
            checked={bar()?.launcher_enabled !== false}
            onToggle={() => patchBar({ launcher_enabled: !(bar()?.launcher_enabled !== false) })} />
          <SettingsSwitch compact testId="settings-bar-dock" label="Bottom dock" detail="Auto-hide pinned apps"
            checked={bar()?.dock_enabled !== false}
            onToggle={() => patchBar({ dock_enabled: !(bar()?.dock_enabled !== false) })} />
        </row>
        <row style={{ gap: "8px", width: "100%" }}>
          <SettingsSwitch compact testId="settings-bar-24h" label="24-hour clock" detail={sampleClock()}
            checked={bar()?.clock_24h !== false}
            onToggle={() => patchBar({ clock_24h: !(bar()?.clock_24h !== false) })} />
          <SettingsSwitch compact testId="settings-bar-seconds" label="Show seconds" detail="Off in bar · On in Calendar"
            checked={bar()?.clock_seconds === true}
            onToggle={() => patchBar({ clock_seconds: !(bar()?.clock_seconds === true) })} />
        </row>
        <row style={{ gap: "8px", width: "100%" }}>
          <SettingsSwitch compact testId="settings-ime-indicator" label="IME indicator" detail="Show layout badge + OSD"
            checked={imeEnabled()}
            onToggle={() => patchIme(
              imeEnabled()
                ? { mode: "disabled", switch_osd: false }
                : { mode: lastEnabledImeMode(), switch_osd: true },
            )} />
          <SettingsSwitch compact testId="settings-bar-workspace-numbers" label="Workspace numbers" detail="Numbered active pill"
            checked={bar()?.workspace_numbers !== false}
            onToggle={() => patchBar({ workspace_numbers: !(bar()?.workspace_numbers !== false) })} />
        </row>
      </column>

      <M3InteractiveCard
        layout="row"
        testId="settings-bar-tray-card"
        actionTestId="settings-bar-tray-configure"
        ariaLabel="Configure system tray rules"
        onClick={() => props?.onOpenTrayRules?.()}
        style={{
          borderRadius: "16px", backgroundColor: containerHigh, padding: "10px 14px",
          alignItems: "center", justifyContent: "space-between", gap: "10px",
        }}
      >
        <row style={{ ...grow, alignItems: "center", gap: "10px", minWidth: "0px" }}>
          <ShellIcon name="menu" size={16} color={primary} />
          <text style={{ fontSize: "13px", fontWeight: 600, flexShrink: 0 }}>System tray</text>
          <text data-tabular="true" style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted, fontVariantNumeric: "tabular-nums" }}>
            {`${trayCounts().visible} pinned · ${trayCounts().collapsed} collapsed · ${trayCounts().hidden} hidden`}
          </text>
        </row>
        <M3CardAction style={{ flexShrink: 0 }}>
          <row style={{ alignItems: "center", gap: "4px", height: "28px", padding: "0 10px", borderRadius: "8px", backgroundColor: containerHighest }}>
            <text style={{ fontSize: "11px", lineHeight: "14px", fontWeight: 500, color: onSurface }}>Configure</text>
            <ShellIcon name="chevronRight" size={14} color={muted} />
          </row>
        </M3CardAction>
      </M3InteractiveCard>

      <row style={{
        alignItems: "center", justifyContent: "space-between", gap: "10px",
        borderRadius: "14px", backgroundColor: containerHigh, padding: "9px 14px",
      }}>
        <row style={{ alignItems: "center", gap: "8px", minWidth: "0px" }}>
          <ShellIcon name="overview" size={16} color={primary} />
          <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px" }}>{monitorLabel()}</text>
        </row>
        <box style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          height: "24px", padding: "0 10px", borderRadius: "8px", backgroundColor: primaryContainer, color: onPrimaryContainer,
          fontSize: "11px", lineHeight: "14px", fontWeight: 600, flexShrink: 0,
        }}>
          <text>{monitors().length <= 1 ? "Primary · Bar visible" : `${monitors().length} displays · Bar visible`}</text>
        </box>
      </row>
    </column>
  );
}
