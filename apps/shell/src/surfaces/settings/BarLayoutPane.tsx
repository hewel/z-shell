import { Button, For, createMemo, type NativeChild } from "@hewel/zgui";
import { M3CardAction, M3InteractiveCard, M3SegmentedControl } from "@z-shell/sdk/primitives";
import { ShellIcon } from "../../icons.tsx";
import { PrecisionSliderRow } from "../../panels/QuickSettingsPanel.tsx";
import { useShellStore } from "../../store.ts";
import {
  DEFAULT_BAR_TRAY_SETTINGS,
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
  grow,
  muted,
  onPrimaryContainer,
  primary,
  primaryContainer,
} from "./shared.tsx";

const BAR_STYLES: readonly { readonly id: BarStyle; readonly label: string; readonly testId: string }[] = [
  { id: "floating", label: "Floating", testId: "settings-bar-style-floating" },
  { id: "docked", label: "Docked", testId: "settings-bar-style-docked" },
];

const BAR_POSITIONS: readonly { readonly id: BarPosition; readonly label: string; readonly testId: string }[] = [
  { id: "top", label: "Top", testId: "settings-bar-pos-top" },
  { id: "left", label: "Left", testId: "settings-bar-pos-left" },
  { id: "right", label: "Right", testId: "settings-bar-pos-right" },
];

const GAP_PRESETS = [0, 8, 14, 20] as const;

export function BarLayoutPane(props?: { readonly onOpenTrayRules?: () => void }): NativeChild {
  const { settings, outputs, monitors, tray, ime, invokeHost } = useShellStore();
  const bar = () => settings.data()?.bar;
  const imeSettings = () => settings.data()?.ime;
  const traySettings = () => bar()?.tray ?? DEFAULT_BAR_TRAY_SETTINGS;
  const showImeIndicator = () => Boolean(ime.data()?.available && ime.data()?.mode !== "disabled");
  const trayCounts = createMemo(() => {
    const items = (tray.data()?.items ?? []).filter(item => !(showImeIndicator() && isImeTrayItem(item)));
    const partitioned = partitionTrayItems(items, traySettings());
    return {
      visible: partitioned.visible.length,
      collapsed: partitioned.collapsed.length,
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

  return (
    <column testId="settings-bar-pane" style={{ gap: "12px", width: "100%" }}>
      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "12px" }}>
        <row style={{ gap: "12px", width: "100%" }}>
          <column style={{ ...grow, gap: "6px" }}>
            <text style={{ fontSize: "12px", fontWeight: 600, color: muted }}>Bar style</text>
            <M3SegmentedControl
              ariaLabel="Bar style"
              options={BAR_STYLES}
              value={style()}
              onChange={next => patchBar({ style: next })}
            />
          </column>

          <column style={{ ...grow, gap: "6px" }}>
            <text style={{ fontSize: "12px", fontWeight: 600, color: muted }}>Screen edge</text>
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
              <text style={{ fontSize: "12px", fontWeight: 600 }}>Tiling gap</text>
              <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: primary, fontVariantNumeric: "tabular-nums" }}>
                {gaps()}px
              </text>
            </row>
            <row style={{ gap: "4px" }}>
              <For each={GAP_PRESETS} keyed={v => v}>
                {preset => {
                  const active = () => gaps() === preset();
                  return (
                    <Button selected={active()} onClick={() => patchBar({ gaps: preset() })} style={{
                      display: "flex", minHeight: "24px", padding: "2px 8px", borderRadius: "8px",
                      alignItems: "center", justifyContent: "center",
                      backgroundColor: active() ? primaryContainer : container,
                      color: active() ? onPrimaryContainer : muted,
                      fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 500,
                    }}>
                      <text>{preset()}px</text>
                    </Button>
                  );
                }}
              </For>
            </row>
          </row>
          <PrecisionSliderRow
            label="Tiling gap"
            icon="overview"
            value={Math.round((gaps() / 64) * 100)}
            valueLabel={`${gaps()}px`}
            showTrailingSlot={false}
            onChange={pct => patchBar({ gaps: Math.round((pct / 100) * 64) })}
          />
        </column>
      </column>

      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
        <text style={{ fontSize: "13px", fontWeight: 600 }}>Modules & clock</text>
        <row style={{ gap: "8px", width: "100%" }}>
          <SettingsSwitch testId="settings-bar-launcher" label="Launcher button" detail="Show apps trigger in bar"
            checked={bar()?.launcher_enabled !== false}
            onToggle={() => patchBar({ launcher_enabled: !(bar()?.launcher_enabled !== false) })} />
          <SettingsSwitch testId="settings-bar-dock" label="Bottom dock" detail="Auto-hiding pinned app dock"
            checked={bar()?.dock_enabled !== false}
            onToggle={() => patchBar({ dock_enabled: !(bar()?.dock_enabled !== false) })} />
        </row>
        <row style={{ gap: "8px", width: "100%" }}>
          <SettingsSwitch testId="settings-bar-24h" label="24-hour clock" detail="Use 24h time format"
            checked={bar()?.clock_24h !== false}
            onToggle={() => patchBar({ clock_24h: !(bar()?.clock_24h !== false) })} />
          <SettingsSwitch testId="settings-bar-seconds" label="Clock seconds (1Hz)" detail="Off by default to prevent flicker"
            checked={bar()?.clock_seconds === true}
            onToggle={() => patchBar({ clock_seconds: !(bar()?.clock_seconds === true) })} />
        </row>
        <row style={{ gap: "8px", width: "100%" }}>
          <SettingsSwitch testId="settings-ime-osd" label="IME switch OSD" detail="Show popup when active input method changes"
            checked={imeSettings()?.switch_osd !== false}
            onToggle={() => patchIme({ switch_osd: !(imeSettings()?.switch_osd !== false) })} />
          <box ariaHidden style={{ ...grow }} />
        </row>
      </column>

      <M3InteractiveCard
        layout="row"
        testId="settings-bar-tray-card"
        actionTestId="settings-bar-tray-configure"
        ariaLabel="Configure system tray rules"
        onClick={() => props?.onOpenTrayRules?.()}
        style={{
          borderRadius: "16px", backgroundColor: containerHigh, padding: "12px 14px",
          alignItems: "center", justifyContent: "space-between", gap: "10px",
        }}
      >
        <column style={{ ...grow, gap: "2px" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>System tray</text>
          <text style={{ ...clipped, fontSize: "11px", color: muted }}>
            {`Default: ${traySettings().default_action === "collapse" ? "Collapse" : "Show"} · ${trayCounts().collapsed} collapsed · ${trayCounts().ruleCount} ${trayCounts().ruleCount === 1 ? "rule" : "rules"}`}
          </text>
        </column>
        <M3CardAction style={{ flexShrink: 0 }}>
          <row style={{ alignItems: "center", gap: "4px", height: "28px", padding: "0 8px", borderRadius: "8px", backgroundColor: container }}>
            <text style={{ fontSize: "12px", lineHeight: "16px", fontWeight: 500, color: onPrimaryContainer }}>Configure</text>
            <ShellIcon name="chevronRight" size={14} color={muted} />
          </row>
        </M3CardAction>
      </M3InteractiveCard>

      <row style={{
        alignItems: "center", justifyContent: "space-between", gap: "10px",
        borderRadius: "14px", backgroundColor: containerHigh, padding: "10px 14px",
      }}>
        <row style={{ alignItems: "center", gap: "8px", minWidth: "0px" }}>
          <ShellIcon name="overview" size={16} color={primary} />
          <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px" }}>{monitorLabel()}</text>
        </row>
        <box style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          height: "22px", padding: "0 8px", borderRadius: "8px", backgroundColor: primaryContainer, color: onPrimaryContainer,
          fontSize: "11px", lineHeight: "14px", fontWeight: 600, flexShrink: 0,
        }}>
          <text>{`${monitors().length} ${monitors().length === 1 ? "display" : "displays"} · Bar visible`}</text>
        </box>
      </row>
    </column>
  );
}
