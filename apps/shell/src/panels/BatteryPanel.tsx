import { Button, For, Show, createMemo, cx, type NativeChild } from "@hewel/zgui";
import { M3IconButton, M3LinearProgress } from "@z-shell/sdk/primitives";
import { ShellIcon, type ShellIconName } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { PANEL_MAX_HEIGHTS, formatBytesGiB, formatDurationSeconds, maxThermalCelsius, type BatteryState } from "../topics.ts";
import styles from "./BatteryPanel.module.css";

const primary = "var(--color-primary)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const defaultProfiles = ["performance", "balanced", "power-saver"] as const;

export const POWER_PROFILE_META: Readonly<Record<string, { readonly label: string; readonly detail: string; readonly shortDetail: string; readonly icon: ShellIconName }>> = {
  performance: { label: "Performance", detail: "Maximum CPU boost and fan headroom", shortDetail: "Max boost clocks", icon: "cpu" },
  balanced: { label: "Balanced", detail: "Standard desktop responsiveness & thermals", shortDetail: "Recommended", icon: "battery" },
  "power-saver": { label: "Power saver", detail: "Lower clocks & extended unplugged runtime", shortDetail: "Quiet & cool", icon: "batteryCharging" },
};
const profileMeta = POWER_PROFILE_META;

const batteryLabels: Readonly<Record<BatteryState, string>> = {
  unknown: "Unknown",
  charging: "Charging",
  discharging: "Discharging",
  full: "Full",
  pending_charge: "Pending charge",
  pending_discharge: "Pending discharge",
};

function percent(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value)}%`;
}

function TelemetryCard(props: { icon: ShellIconName; label: string; value: string; detail?: string | undefined }) {
  return (
    <column class={styles.telemetryCard}>
      <row class={styles.telemetryHeader}>
        <ShellIcon name={props.icon} size={14} color={primary} />
        <text class={styles.telemetryLabel}>{props.label}</text>
      </row>
      <text data-tabular="true" class={styles.telemetryValue}>
        {props.value}
      </text>
      <Show when={props.detail} fallback={<box class={styles.hiddenSection} />}>
        <text class={styles.telemetryDetail}>{props.detail}</text>
      </Show>
    </column>
  );
}

export function SystemTelemetryCards() {
  const { telemetry } = useShellStore();
  const memory = createMemo(() => {
    const sizes = telemetry.data()?.memory;
    return sizes ? { used: formatBytesGiB(sizes.used_bytes), detail: `of ${formatBytesGiB(sizes.total_bytes)}` } : undefined;
  });
  const heat = createMemo(() => {
    const max = maxThermalCelsius(telemetry.data()?.temperatures ?? []);
    return max == null ? "—" : `${max}°C`;
  });
  return (
    <row ariaLabel="System telemetry" class={styles.telemetryRow}>
      <TelemetryCard icon="cpu" label="CPU" value={percent(telemetry.data()?.cpu_usage_percent)} />
      <TelemetryCard icon="memory" label="Memory" value={memory()?.used ?? "—"} detail={memory()?.detail} />
      <TelemetryCard icon="thermometer" label="Heat" value={heat()} />
    </row>
  );
}

/**
 * Paper `04B · Battery & Power` (`396px`) content used both as a Control Center Shared Axis X
 * sub-panel (with Back button) and when opened directly via the standalone `battery` panel route.
 */
export function BatteryPowerContent(props: { onBack?: () => void }): NativeChild {
  const { power, invokePublic, openSettingsWindow } = useShellStore();
  const battery = () => power.data()?.battery;
  const profiles = () => power.data()?.profiles;
  const charging = () => battery()?.state === "charging" || battery()?.state === "pending_charge" || battery()?.state === "full";
  const pctValue = () => Math.max(0, Math.min(100, battery()?.percentage ?? 0));
  const remaining = () => formatDurationSeconds(
    charging() ? battery()?.time_to_full_seconds : battery()?.time_to_empty_seconds,
  );
  const watts = () => battery()?.energy_rate_watts != null ? `${battery()!.energy_rate_watts!.toFixed(1)} W` : null;
  const healthSummary = createMemo(() => {
    const b = battery();
    const parts: string[] = [];
    if (b?.capacity_percent != null) parts.push(`${Math.round(b.capacity_percent)}%`);
    if (b?.charge_cycles != null) parts.push(`${b.charge_cycles} cycles`);
    if (power.data()?.available) parts.push("UPower");
    return parts.join(" · ") || "Unavailable";
  });

  return (
    <column class={styles.content}>
      <row class={styles.headerRow}>
        <Show when={props.onBack} fallback={<box class={styles.hiddenSection} />}>
          {onBack => (
            <M3IconButton testId="qs-back" ariaLabel="Back" variant="filled-tonal" onClick={onBack()}>
              <ShellIcon name="arrowLeft" size={16} color={onSurface} />
            </M3IconButton>
          )}
        </Show>
        <text role="heading" class={cx(styles.headerTitle, styles.clipped)}>
          Battery & power
        </text>
        <M3IconButton testId="battery-open-settings" ariaLabel="Open power settings" variant="filled-tonal" onClick={() => openSettingsWindow("power")}>
          <ShellIcon name="settings" size={16} color={onSurface} />
        </M3IconButton>
      </row>

      <column class={styles.heroCard}>
        <row class={styles.spaceBetweenRow}>
          <row class={styles.heroPercentRow}>
            <text testId="battery-percent" data-tabular="true" class={styles.heroPercent}>
              {percent(battery()?.percentage)}
            </text>
            <text class={styles.heroState} data-charging={charging() ? "true" : "false"}>
              {battery() ? batteryLabels[battery()!.state] : "No battery"}
            </text>
          </row>
          <Show when={watts()} fallback={<box class={styles.hiddenSection} />}>
            {w => (
              <row class={styles.wattsBadge}>
                <ShellIcon name={charging() ? "batteryCharging" : "battery"} size={14} color={primary} />
                <text data-tabular="true" class={styles.wattsText}>
                  {w()}
                </text>
              </row>
            )}
          </Show>
        </row>
        <M3LinearProgress value={pctValue()} ariaLabel="Battery level" />
        <row class={styles.spaceBetweenRow}>
          <text class={cx(styles.remainingText, styles.clipped)}>
            {remaining() ? (charging() ? `${remaining()} until full` : `${remaining()} remaining`) : (power.data()?.on_ac ? "AC power online" : "On battery")}
          </text>
          <Show when={power.data()?.on_ac !== null} fallback={<box class={styles.hiddenSection} />}>
            <text class={styles.acLabel}>
              {power.data()?.on_ac ? "AC" : "Battery"}
            </text>
          </Show>
        </row>
      </column>

      <column class={styles.card}>
        <text role="heading" class={styles.sectionTitle}>Power profile</text>
        <column class={styles.profileList}>
          <For each={profiles()?.profiles.length ? profiles()!.profiles : defaultProfiles} keyed={name => name}>
            {name => {
              const active = () => name() === profiles()?.active_profile;
              const info = () => profileMeta[name()] ?? { label: name(), detail: "System power profile", icon: "battery" as const };
              return (
                <Button
                  testId={`battery-profile-${name()}`}
                  selected={active()}
                  disabled={!profiles()?.available}
                  class={styles.profileButton}
                  data-active={active() ? "true" : "false"}
                  data-unavailable={profiles()?.available === false ? "true" : "false"}
                  onClick={() => { void invokePublic("power.set-profile", { profile: name() }); }}
                >
                  <box ariaHidden class={styles.profileIconWell} data-active={active() ? "true" : "false"}>
                    <ShellIcon name={info().icon} size={16} color={active() ? onPrimaryContainer : muted} />
                  </box>
                  <column class={styles.profileTextCol}>
                    <text class={cx(styles.profileName, styles.clipped)}>{info().label}</text>
                    <text class={cx(styles.profileDetail, styles.clipped)} data-active={active() ? "true" : "false"}>
                      {info().detail}
                    </text>
                  </column>
                  <Show when={active()} fallback={<box class={styles.hiddenSection} />}>
                    <ShellIcon name="check" size={16} color={active() ? onPrimaryContainer : muted} />
                  </Show>
                </Button>
              );
            }}
          </For>
        </column>
      </column>

      <row class={styles.healthRow}>
        <text class={styles.healthLabel}>Battery health</text>
        <text data-tabular="true" class={styles.healthValue}>
          {healthSummary()}
        </text>
      </row>
    </column>
  );
}

export function BatteryPanel(): NativeChild {
  return (
    <scroll testId="panel-battery" class={styles.panelScroll} style={{ maxHeight: `${PANEL_MAX_HEIGHTS.battery}px` }}>
      <column class={styles.panelBody}>
        <BatteryPowerContent />
      </column>
    </scroll>
  );
}
