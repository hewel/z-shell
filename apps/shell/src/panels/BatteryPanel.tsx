import { Button, For, Show, createMemo } from "@hewel/zgui";
import { ShojiIcon, type ShojiIconName } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { formatBytesGiB, formatDurationSeconds, maxThermalCelsius, type BatteryState } from "../topics.ts";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const card = { borderRadius: "20px", backgroundColor: container, padding: "12px", gap: "10px" } as const;
const metric = { flexBasis: "0px", flexGrow: 1, minWidth: "0px", borderRadius: "12px", padding: "8px", gap: "2px" } as const;
const pill = { display: "flex", borderRadius: "16px", minHeight: "32px", padding: "0 10px", alignItems: "center", justifyContent: "center" } as const;
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

function TelemetryCard(props: { icon: ShojiIconName; label: string; value: string; detail?: string }) {
  return (
    <column style={{ ...metric, backgroundColor: container, borderRadius: "16px", gap: "4px", padding: "10px" }}>
      <row style={{ alignItems: "center", gap: "4px" }}>
        <ShojiIcon name={props.icon} size={14} color={primary} />
        <text style={{ color: muted, fontSize: "11px" }}>{props.label}</text>
      </row>
      <text style={{ fontSize: "16px", fontWeight: 600 }}>{props.value}</text>
      <Show when={props.detail}>
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
    <column style={{ ...metric, backgroundColor: containerHigh }}>
      <text style={{ color: muted, fontSize: "11px" }}>{props.label}</text>
      <text style={{ fontWeight: 600 }}>{props.value}</text>
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
    <scroll testId="panel-battery" style={{ width: "100%", height: "100%", maxHeight: "calc(100vh - 2px)", overflow: "auto", backgroundColor: "var(--color-surface)", color: onSurface, fontFamily: "system-ui", fontSize: "13px" }}>
      <column style={{ padding: "16px", gap: "12px", flexDirection: "column" }}>
        <column style={{ ...card, padding: "14px" }}>
          <row style={{ alignItems: "center", gap: "8px" }}>
            <ShojiIcon name={charging() ? "batteryCharging" : "battery"} size={22} color={primary} />
            <text style={{ fontWeight: 600 }}>Battery</text>
            <Show when={battery()}>
              {current => (
                <text style={{ marginLeft: "auto", borderRadius: "12px", padding: "4px 8px", fontSize: "11px",
                  backgroundColor: charging() ? "var(--color-primary-container)" : "var(--color-secondary-container)",
                  color: charging() ? "var(--color-on-primary-container)" : "var(--color-on-secondary-container)" }}>
                  {batteryLabels[current().state]}
                </text>
              )}
            </Show>
          </row>
          <row style={{ alignItems: "baseline", gap: "8px" }}>
            <text testId="battery-percent" style={{ fontSize: "34px", fontWeight: 600, color: primary }}>{percent(battery()?.percentage)}</text>
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
                    style={{ ...pill, backgroundColor: active() ? primary : containerHigh, color: active() ? onPrimary : onSurface }}>
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
