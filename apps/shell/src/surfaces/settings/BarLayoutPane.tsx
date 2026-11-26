import { Button, For, createEffect, createMemo, createSignal, cx, type NativeChild } from "@hewel/zgui";
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
import styles from "./BarLayoutPane.module.css";
import { SettingsSwitch, muted, primary } from "./shared.tsx";

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
    <column testId="settings-bar-pane" class={cx(styles.pane)}>
      <column class={cx(styles.topCard)}>
        <row class={cx(styles.splitRow)}>
          <column class={cx(styles.fieldCol)}>
            <text class={cx(styles.fieldLabel)}>Bar style</text>
            <M3SegmentedControl
              ariaLabel="Bar style"
              options={BAR_STYLES}
              value={style()}
              onChange={next => patchBar({ style: next })}
            />
          </column>

          <column class={cx(styles.fieldCol)}>
            <text class={cx(styles.fieldLabel)}>Screen edge</text>
            <M3SegmentedControl
              ariaLabel="Screen edge"
              options={BAR_POSITIONS}
              value={position()}
              onChange={next => patchBar({ position: next })}
            />
          </column>
        </row>

        <box ariaHidden class={cx(styles.divider)} />

        <column class={cx(styles.gapsSection)}>
          <row class={cx(styles.gapsHeaderRow)}>
            <row class={cx(styles.gapsTitleRow)}>
              <text class={cx(styles.sectionTitle)}>Outer &amp; popover gaps</text>
              <text data-tabular="true" class={cx(styles.gapsValue)}>
                {gaps()} px
              </text>
            </row>
            <row class={cx(styles.presetsRow)}>
              <For each={GAP_PRESETS} keyed={v => v}>
                {preset => {
                  const active = () => gaps() === preset();
                  return (
                    <Button
                      selected={active()}
                      data-active={active() ? "true" : null}
                      onClick={() => patchBar({ gaps: preset() })}
                      class={cx(styles.presetButton)}
                    >
                      <text data-tabular="true" class={cx(styles.tabularText)}>{preset()}</text>
                    </Button>
                  );
                }}
              </For>
            </row>
          </row>
          <row class={cx(styles.sliderRow)}>
            <M3Slider
              label="Outer & popover gaps"
              testId="settings-bar-gaps-slider"
              value={Math.round((gaps() / 64) * 100)}
              onChange={pct => patchBar({ gaps: Math.round((pct / 100) * 64) })}
            />
          </row>
        </column>
      </column>

      <column class={cx(styles.modulesCard)}>
        <text class={cx(styles.sectionTitle)}>Modules &amp; clock</text>
        <row class={cx(styles.switchRow)}>
          <SettingsSwitch compact testId="settings-bar-launcher" label="Launcher trigger" detail="Material apps grid"
            checked={bar()?.launcher_enabled !== false}
            onToggle={() => patchBar({ launcher_enabled: !(bar()?.launcher_enabled !== false) })} />
          <SettingsSwitch compact testId="settings-bar-dock" label="Bottom dock" detail="Auto-hide pinned apps"
            checked={bar()?.dock_enabled !== false}
            onToggle={() => patchBar({ dock_enabled: !(bar()?.dock_enabled !== false) })} />
        </row>
        <row class={cx(styles.switchRow)}>
          <SettingsSwitch compact testId="settings-bar-24h" label="24-hour clock" detail={sampleClock()}
            checked={bar()?.clock_24h !== false}
            onToggle={() => patchBar({ clock_24h: !(bar()?.clock_24h !== false) })} />
          <SettingsSwitch compact testId="settings-bar-seconds" label="Show seconds" detail="Off in bar · On in Calendar"
            checked={bar()?.clock_seconds === true}
            onToggle={() => patchBar({ clock_seconds: !(bar()?.clock_seconds === true) })} />
        </row>
        <row class={cx(styles.switchRow)}>
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
        class={cx(styles.trayCard)}
      >
        <row class={cx(styles.trayCardLead)}>
          <ShellIcon name="menu" size={16} color={primary} />
          <text class={cx(styles.trayTitle)}>System tray</text>
          <text data-tabular="true" class={cx(styles.trayCounts)}>
            {`${trayCounts().visible} pinned · ${trayCounts().collapsed} collapsed · ${trayCounts().hidden} hidden`}
          </text>
        </row>
        <M3CardAction class={cx(styles.cardAction)}>
          <row class={cx(styles.configurePill)}>
            <text class={cx(styles.configureLabel)}>Configure</text>
            <ShellIcon name="chevronRight" size={14} color={muted} />
          </row>
        </M3CardAction>
      </M3InteractiveCard>

      <row class={cx(styles.monitorCard)}>
        <row class={cx(styles.monitorLead)}>
          <ShellIcon name="overview" size={16} color={primary} />
          <text data-tabular="true" class={cx(styles.monitorLabel)}>{monitorLabel()}</text>
        </row>
        <box class={cx(styles.displayBadge)}>
          <text>{monitors().length <= 1 ? "Primary · Bar visible" : `${monitors().length} displays · Bar visible`}</text>
        </box>
      </row>
    </column>
  );
}
