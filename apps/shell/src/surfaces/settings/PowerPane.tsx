import { Button, For, Show, cx, type NativeChild } from "@hewel/zgui";
import { ShellIcon } from "../../icons.tsx";
import { POWER_PROFILE_META, SystemTelemetryCards } from "../../panels/BatteryPanel.tsx";
import { useShellStore } from "../../store.ts";
import styles from "./PowerPane.module.css";
import { onPrimaryContainer, primary } from "./shared.tsx";

export function PowerPane(): NativeChild {
  const { power, invokePublic } = useShellStore();
  const battery = () => power.data()?.battery;
  return (
    <column testId="settings-power-pane" class={cx(styles.pane)}>
      <Show when={battery()}>{b => (
        <row class={cx(styles.metricsRow)}>
          <column class={cx(styles.metricCard)}>
            <text class={cx(styles.metricLabel)}>Battery charge</text>
            <text data-tabular="true" class={cx(styles.metricValuePrimary)}>
              {b().percentage != null ? `${Math.round(b().percentage!)}%` : "—"}
            </text>
            <text class={cx(styles.metricSub)}>{b().state}</text>
          </column>
          <column class={cx(styles.metricCard)}>
            <text class={cx(styles.metricLabel)}>Power draw</text>
            <text data-tabular="true" class={cx(styles.metricValue)}>
              {b().energy_rate_watts != null ? `${b().energy_rate_watts!.toFixed(1)} W` : "—"}
            </text>
            <text class={cx(styles.metricSub)}>{power.data()?.on_ac ? "AC online" : "On battery"}</text>
          </column>
          <column class={cx(styles.metricCard)}>
            <text class={cx(styles.metricLabel)}>Battery health</text>
            <text data-tabular="true" class={cx(styles.metricValue)}>
              {b().capacity_percent != null ? `${Math.round(b().capacity_percent!)}%` : "—"}
            </text>
            <text data-tabular="true" class={cx(styles.metricSubMono)}>
              {b().charge_cycles != null ? `${b().charge_cycles} cycles` : "UPower"}
            </text>
          </column>
        </row>
      )}</Show>

      <column class={cx(styles.profilesCard)}>
        <text class={cx(styles.sectionTitle)}>Active power profile</text>
        <row class={cx(styles.profilesRow)}>
          <For each={power.data()?.profiles.profiles} keyed={profile => profile} fallback={<text class={cx(styles.emptyText)}>No profiles available</text>}>
            {profile => {
              const active = () => power.data()?.profiles.active_profile === profile();
              const info = () => POWER_PROFILE_META[profile()] ?? { label: profile(), detail: "Power profile", shortDetail: "Power profile", icon: "battery" as const };
              return (
                <Button
                  selected={active()}
                  data-active={active() ? "true" : null}
                  onClick={() => void invokePublic("power.set-profile", { profile: profile() })}
                  class={cx(styles.profileButton)}
                >
                  <row class={cx(styles.profileTitleRow)}>
                    <ShellIcon name={info().icon} size={15} color={active() ? onPrimaryContainer : primary} />
                    <text class={cx(styles.profileName)}>{info().label}</text>
                  </row>
                  <text class={cx(styles.profileDetail)} data-active={active() ? "true" : null}>
                    {active() ? `Active · ${info().shortDetail}` : info().shortDetail}
                  </text>
                </Button>
              );
            }}
          </For>
        </row>
      </column>

      <SystemTelemetryCards />
    </column>
  );
}
