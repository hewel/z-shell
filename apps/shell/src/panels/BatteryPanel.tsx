import { Button, For, Show, createMemo, type NativeChild } from "@hewel/zgui";
import { ShellIcon, type ShellIconName } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { PANEL_MAX_HEIGHTS, formatBytesGiB, formatDurationSeconds, maxThermalCelsius, type BatteryState } from "../topics.ts";

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
const headerBtn = {
  display: "flex", width: "36px", height: "36px", borderRadius: "10px",
  alignItems: "center", justifyContent: "center", flexShrink: 0, backgroundColor: containerHighest,
} as const;
const hiddenSection = { display: "none" } as const;
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
const defaultProfiles = ["performance", "balanced", "power-saver"] as const;

const profileMeta: Readonly<Record<string, { readonly label: string; readonly detail: string; readonly icon: ShellIconName }>> = {
  performance: { label: "Performance", detail: "Maximum CPU boost and fan headroom", icon: "cpu" },
  balanced: { label: "Balanced", detail: "Standard desktop responsiveness & thermals", icon: "battery" },
  "power-saver": { label: "Power saver", detail: "Lower clocks & extended unplugged runtime", icon: "batteryCharging" },
};

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
    <column style={{ width: "100%", gap: "10px", flexDirection: "column" }}>
      <row style={{ alignItems: "center", gap: "8px" }}>
        <Show when={props.onBack} fallback={<box style={hiddenSection} />}>
          {onBack => (
            <Button testId="qs-back" ariaLabel="Back" onClick={onBack()} style={headerBtn}>
              <ShellIcon name="arrowLeft" size={16} color={onSurface} />
            </Button>
          )}
        </Show>
        <text role="heading" style={{ flexGrow: 1, flexBasis: "0px", ...clipped, fontSize: "20px", fontWeight: 600 }}>
          Battery & power
        </text>
        <Button testId="battery-open-settings" ariaLabel="Open power settings" onClick={() => openSettingsWindow("power")} style={headerBtn}>
          <ShellIcon name="settings" size={16} color={onSurface} />
        </Button>
      </row>

      <column style={{ ...card, padding: "14px", gap: "10px" }}>
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <row style={{ alignItems: "baseline", gap: "8px" }}>
            <text testId="battery-percent" data-tabular="true" style={{
              fontFamily: "var(--font-mono)", fontSize: "34px", fontWeight: 600, lineHeight: "38px",
              color: primary, fontVariantNumeric: "tabular-nums",
            }}>
              {percent(battery()?.percentage)}
            </text>
            <text style={{ fontSize: "13px", fontWeight: 500, color: charging() ? primary : muted }}>
              {battery() ? batteryLabels[battery()!.state] : "No battery"}
            </text>
          </row>
          <Show when={watts()} fallback={<box style={hiddenSection} />}>
            {w => (
              <row style={{
                alignItems: "center", gap: "4px", padding: "4px 8px", borderRadius: "8px",
                backgroundColor: containerHighest, color: onSurface, flexShrink: 0,
              }}>
                <ShellIcon name={charging() ? "batteryCharging" : "battery"} size={14} color={primary} />
                <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                  {w()}
                </text>
              </row>
            )}
          </Show>
        </row>
        <box ariaHidden style={{ width: "100%", height: "8px", borderRadius: "4px", backgroundColor: containerHighest, overflow: "hidden" }}>
          <box data-percent-fill="true" style={{ width: `${pctValue()}%`, height: "100%", borderRadius: "4px", backgroundColor: primary }} />
        </box>
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <text style={{ ...clipped, fontSize: "12px", color: muted }}>
            {remaining() ? (charging() ? `${remaining()} until full` : `${remaining()} remaining`) : (power.data()?.on_ac ? "AC power online" : "On battery")}
          </text>
          <Show when={power.data()?.on_ac !== null} fallback={<box style={hiddenSection} />}>
            <text style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted, flexShrink: 0 }}>
              {power.data()?.on_ac ? "AC" : "Battery"}
            </text>
          </Show>
        </row>
      </column>

      <column style={card}>
        <text role="heading" style={{ fontSize: "13px", fontWeight: 600, color: muted }}>Power profile</text>
        <column style={{ gap: "6px" }}>
          <For each={profiles()?.profiles.length ? profiles()!.profiles : defaultProfiles} keyed={name => name}>
            {name => {
              const active = () => name() === profiles()?.active_profile;
              const info = () => profileMeta[name()] ?? { label: name(), detail: "System power profile", icon: "battery" as const };
              return (
                <Button testId={`battery-profile-${name()}`} selected={active()} disabled={!profiles()?.available}
                  onClick={() => { void invokePublic("power.set-profile", { profile: name() }); }}
                  style={{
                    display: "flex", flexDirection: "row", alignItems: "center", gap: "10px",
                    minHeight: "52px", padding: "8px 10px", borderRadius: "14px",
                    backgroundColor: active() ? primaryContainer : containerHighest,
                    border: active() ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
                    color: active() ? onPrimaryContainer : onSurface,
                    opacity: profiles()?.available === false ? 0.5 : 1,
                  }}>
                  <box ariaHidden style={{
                    display: "flex", width: "32px", height: "32px", borderRadius: "10px", flexShrink: 0,
                    alignItems: "center", justifyContent: "center",
                    backgroundColor: active() ? "color-mix(in srgb, var(--color-primary) 18%, transparent)" : containerHigh,
                  }}>
                    <ShellIcon name={info().icon} size={16} color={active() ? onPrimaryContainer : muted} />
                  </box>
                  <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "1px", alignItems: "flex-start" }}>
                    <text style={{ ...clipped, fontSize: "13px", fontWeight: 600 }}>{info().label}</text>
                    <text style={{ ...clipped, fontSize: "11px", color: active() ? onPrimaryContainer : muted, opacity: active() ? 0.8 : 1 }}>
                      {info().detail}
                    </text>
                  </column>
                  <Show when={active()} fallback={<box style={hiddenSection} />}>
                    <ShellIcon name="check" size={16} color={active() ? onPrimaryContainer : muted} />
                  </Show>
                </Button>
              );
            }}
          </For>
        </column>
      </column>

      <row style={{
        alignItems: "center", justifyContent: "space-between", gap: "8px",
        borderRadius: "14px", backgroundColor: containerHigh, padding: "10px 12px",
      }}>
        <text style={{ fontSize: "12px", fontWeight: 500, color: muted }}>Battery health</text>
        <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: onSurface, fontVariantNumeric: "tabular-nums" }}>
          {healthSummary()}
        </text>
      </row>
    </column>
  );
}

export function BatteryPanel(): NativeChild {
  return (
    <scroll testId="panel-battery" style={{
      width: "100%", maxHeight: `${PANEL_MAX_HEIGHTS.battery}px`, overflow: "hidden auto",
      backgroundColor: container, color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px",
    }}>
      <column style={{ padding: "14px", flexDirection: "column" }}>
        <BatteryPowerContent />
      </column>
    </scroll>
  );
}
