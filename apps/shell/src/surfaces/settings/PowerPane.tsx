import { Button, For, Show, type NativeChild } from "@hewel/zgui";
import { ShellIcon } from "../../icons.tsx";
import { POWER_PROFILE_META, SystemTelemetryCards } from "../../panels/BatteryPanel.tsx";
import { useShellStore } from "../../store.ts";
import {
  container,
  containerHigh,
  grow,
  muted,
  onPrimaryContainer,
  onSurface,
  primary,
  primaryContainer,
} from "./shared.tsx";

export function PowerPane(): NativeChild {
  const { power, invokePublic } = useShellStore();
  const battery = () => power.data()?.battery;
  return (
    <column testId="settings-power-pane" style={{ gap: "12px", width: "100%" }}>
      <Show when={battery()}>{b => (
        <row style={{ gap: "10px", width: "100%" }}>
          <column style={{ ...grow, borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "4px" }}>
            <text style={{ fontSize: "11px", color: muted }}>Battery charge</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "22px", fontWeight: 600, color: primary, fontVariantNumeric: "tabular-nums" }}>
              {b().percentage != null ? `${Math.round(b().percentage!)}%` : "—"}
            </text>
            <text style={{ fontSize: "11px", color: muted }}>{b().state}</text>
          </column>
          <column style={{ ...grow, borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "4px" }}>
            <text style={{ fontSize: "11px", color: muted }}>Power draw</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "22px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {b().energy_rate_watts != null ? `${b().energy_rate_watts!.toFixed(1)} W` : "—"}
            </text>
            <text style={{ fontSize: "11px", color: muted }}>{power.data()?.on_ac ? "AC online" : "On battery"}</text>
          </column>
          <column style={{ ...grow, borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "4px" }}>
            <text style={{ fontSize: "11px", color: muted }}>Battery health</text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "22px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
              {b().capacity_percent != null ? `${Math.round(b().capacity_percent!)}%` : "—"}
            </text>
            <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted, fontVariantNumeric: "tabular-nums" }}>
              {b().charge_cycles != null ? `${b().charge_cycles} cycles` : "UPower"}
            </text>
          </column>
        </row>
      )}</Show>

      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
        <text style={{ fontSize: "13px", fontWeight: 600 }}>Active power profile</text>
        <row style={{ gap: "8px" }}>
          <For each={power.data()?.profiles.profiles} keyed={profile => profile} fallback={<text style={{ fontSize: "12px", color: muted }}>No profiles available</text>}>
            {profile => {
              const active = () => power.data()?.profiles.active_profile === profile();
              const info = () => POWER_PROFILE_META[profile()] ?? { label: profile(), detail: "Power profile", shortDetail: "Power profile", icon: "battery" as const };
              return (
                <Button selected={active()} onClick={() => void invokePublic("power.set-profile", { profile: profile() })} style={{
                  ...grow, display: "flex", flexDirection: "column", minHeight: "64px", borderRadius: "14px",
                  padding: "10px", alignItems: "flex-start", justifyContent: "center", gap: "4px",
                  backgroundColor: active() ? primaryContainer : container,
                  border: active() ? "1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)" : "1px solid transparent",
                  color: active() ? onPrimaryContainer : onSurface,
                }}>
                  <row style={{ alignItems: "center", gap: "6px" }}>
                    <ShellIcon name={info().icon} size={15} color={active() ? onPrimaryContainer : primary} />
                    <text style={{ fontSize: "12px", fontWeight: 600 }}>{info().label}</text>
                  </row>
                  <text style={{ fontSize: "11px", color: active() ? onPrimaryContainer : muted, opacity: active() ? 0.8 : 1 }}>
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
