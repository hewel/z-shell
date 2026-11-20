import { Button, For, Show, createMemo } from "@hewel/zgui";
import { ShellIcon, type ShellIconName } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { formatBytesGiB, formatDurationSeconds, maxThermalCelsius, type BatteryState } from "../topics.ts";

const primary = "var(--color-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const card = { borderRadius: "16px", backgroundColor: containerHigh, padding: "12px", gap: "10px" } as const;
const metric = { flexBasis: "0px", flexGrow: 1, minWidth: "0px", borderRadius: "10px", padding: "8px", gap: "2px" } as const;
const pill = { display: "flex", borderRadius: "10px", minHeight: "32px", padding: "0 10px", alignItems: "center", justifyContent: "center" } as const;
const hiddenSection = { display: "none" } as const;
const defaultProfiles = ["power-saver", "balanced", "performance"] as const;
const profileLabels: Readonly<Record<string, string>> = { "power-saver": "Power Saver", balanced: "Balanced", performance: "Performance" };
const batteryLabels: Readonly<Record<BatteryState, string>> = {
  unknown: "Unknown",
  charging: "Charging",
  discharging: "Discharging",
  full: "Full",
  pending_charge: "Pending charge",
  pending_discharge: "Pending discharge",
};

function percent(value: number | null | undefined) {
  return value == null ? "—" : `${Math.round(value)}%`;
}

function TelemetryCard(props: { icon: ShellIconName; label: string; value: string; detail?: string | undefined }) {
  return (
    <column style={{ ...metric, backgroundColor: containerHigh, borderRadius: "14px", gap: "4px", padding: "10px" }}>
      <row style={{ alignItems: "center", gap: "4px" }}>
        <ShellIcon name={props.icon} size={14} color={primary} />
        <text style={{ color: muted, fontSize: "11px" }}>{props.label}</text>
      </row>
      <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "15px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
        {props.value}
      </text>
      <Show when={props.detail} fallback={<box style={hiddenSection} />}>
        <text style={{ color: muted, fontSize: "10px" }}>{props.detail}</text>
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
    <row ariaLabel="System telemetry" style={{ gap: "8px" }}>
      <TelemetryCard icon="cpu" label="CPU" value={percent(telemetry.data()?.cpu_usage_percent)} />
      <TelemetryCard icon="memory" label="Memory" value={memory()?.used ?? "—"} detail={memory()?.detail} />
      <TelemetryCard icon="thermometer" label="Heat" value={heat()} />
    </row>
  );
}

function BatteryMetric(props: { label: string; value: string }) {
  return (
    <column style={{ ...metric, backgroundColor: containerHighest }}>
      <text style={{ color: muted, fontSize: "11px" }}>{props.label}</text>
      <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "13px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
        {props.value}
      </text>
    </column>
  );
}

export function BatteryPanel() {
  const { power, invokePublic } = useShellStore();
  const battery = () => power.data()?.battery;
  const profiles = () => power.data()?.profiles;
  const charging = () => battery()?.state === "charging" || battery()?.state === "full";
  const remaining = () => formatDurationSeconds(battery()?.time_to_full_seconds ?? battery()?.time_to_empty_seconds);
  const watts = () => battery()?.energy_rate_watts?.toFixed(1);

  return (
    <scroll testId="panel-battery" style={{
      width: "100%", maxHeight: "100vh", overflow: "hidden auto",
      backgroundColor: container, color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px",
    }}>
      <column style={{ padding: "14px", gap: "10px", flexDirection: "column" }}>
        <column style={{ ...card, padding: "14px" }}>
          <row style={{ alignItems: "center", gap: "8px" }}>
            <ShellIcon name={charging() ? "batteryCharging" : "battery"} size={22} color={primary} />
            <text style={{ fontWeight: 600 }}>Battery</text>
            <Show when={battery()}>
              {current => (
                <text style={{
                  marginLeft: "auto", borderRadius: "10px", padding: "4px 8px", fontSize: "11px", fontWeight: 500,
                  backgroundColor: charging() ? primaryContainer : "var(--color-secondary-container)",
                  color: charging() ? onPrimaryContainer : "var(--color-on-secondary-container)",
                }}>
                  {batteryLabels[current().state]}
                </text>
              )}
            </Show>
          </row>
          <row style={{ alignItems: "baseline", gap: "8px" }}>
            <text testId="battery-percent" data-tabular="true" style={{
              fontFamily: "var(--font-mono)", fontSize: "34px", fontWeight: 600, color: primary, fontVariantNumeric: "tabular-nums",
            }}>
              {percent(battery()?.percentage)}
            </text>
            <Show when={remaining()}>
              <text style={{ color: muted }}>{remaining()}</text>
            </Show>
          </row>
          <row style={{ gap: "8px" }}>
            <BatteryMetric label="Power" value={watts() === undefined ? "—" : `${watts()} W`} />
            <BatteryMetric label="Health" value={percent(battery()?.capacity_percent)} />
            <BatteryMetric label="Cycles" value={String(battery()?.charge_cycles ?? "—")} />
          </row>
        </column>
        <column style={card}>
          <text style={{ fontWeight: 600 }}>Power Profile</text>
          <row style={{ gap: "6px", flexWrap: "wrap" }}>
            <For each={profiles()?.profiles ?? defaultProfiles} keyed={name => name}>
              {name => {
                const active = () => name() === profiles()?.active_profile;
                return (
                  <Button testId={`battery-profile-${name()}`} selected={active()}
                    onClick={() => { void invokePublic("power.set-profile", { profile: name() }); }}
                    style={{
                      ...pill,
                      backgroundColor: active() ? primaryContainer : containerHighest,
                      border: active() ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
                      color: active() ? onPrimaryContainer : onSurface,
                      fontWeight: active() ? 600 : 500,
                    }}>
                    <text>{profileLabels[name()] ?? name()}</text>
                  </Button>
                );
              }}
            </For>
          </row>
        </column>
        <SystemTelemetryCards />
      </column>
    </scroll>
  );
}
