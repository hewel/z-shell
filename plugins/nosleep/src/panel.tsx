import { For, Show, type Accessor, type NativeChild } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { M3IconButton, M3Switch } from "@z-shell/sdk/primitives";
import { useTopic } from "@z-shell/sdk/zgui";
import { NOSLEEP_DEFAULTS, type NoSleepSnapshot } from "./service.ts";

const primary = "var(--color-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const coffee = "M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm0 5h-2V5h2v3zM4 19h16v2H4z";
const smartToy = "M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zM7.5 11.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5S9.83 13 9 13s-1.5-.67-1.5-1.5zM16 17H8v-2h8v2zm-.5-4c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z";
const settingsIcon = "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z";

export default function Panel(props: {
  readonly client: Accessor<ZShellClient | undefined>;
  readonly onClose?: () => void;
  readonly onOpenSettings?: () => void;
}): NativeChild {
  const { data: snapshot } = useTopic<NoSleepSnapshot>(props.client, "plugin.z-shell.nosleep.state");
  const active = () => snapshot()?.active === true;
  const manual = () => snapshot()?.manualActive === true;

  return (
    <column testId="plugin-nosleep-panel" style={{
      width: "100%", padding: "14px", gap: "10px", flexDirection: "column",
      backgroundColor: container, color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px",
    }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <column style={{ flexGrow: 1, flexBasis: "0px", gap: "2px", minWidth: "0px" }}>
          <text role="heading" style={{ fontSize: "20px", fontWeight: 600 }}>Nosleep</text>
          <text style={{ fontSize: "11px", color: muted }}>
            {`Sleep block & agent guard · ${snapshot()?.scope ?? NOSLEEP_DEFAULTS.inhibit_scope}`}
          </text>
        </column>
        <row style={{ alignItems: "center", gap: "6px", flexShrink: 0 }}>
          <box style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            height: "24px", padding: "0 10px", borderRadius: "999px", "--zgui-corner-shape": "none",
            fontSize: "11px", lineHeight: "14px", fontWeight: 600,
            backgroundColor: active() ? primaryContainer : containerHigh,
            color: active() ? onPrimaryContainer : muted,
          }}>
            <text>{active() ? "Awake" : "Idle"}</text>
          </box>
          <Show when={props.onOpenSettings}>
            {openSettings => (
              <M3IconButton testId="nosleep-open-settings" ariaLabel="Open Nosleep settings" variant="filled-tonal" onClick={openSettings()}>
                <vector d={settingsIcon} viewBox="0 0 24 24" style={{ width: "16px", height: "16px", color: onSurface }} />
              </M3IconButton>
            )}
          </Show>
        </row>
      </row>

      <row style={{
        alignItems: "center", gap: "10px", borderRadius: "16px", padding: "12px",
        backgroundColor: containerHigh,
      }}>
        <box ariaHidden style={{
          display: "flex", width: "34px", height: "34px", borderRadius: "10px", flexShrink: 0,
          alignItems: "center", justifyContent: "center",
          backgroundColor: manual() ? primaryContainer : containerHighest,
        }}>
          <vector d={coffee} viewBox="0 0 24 24" style={{ width: "18px", height: "18px", color: manual() ? primary : muted }} />
        </box>
        <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "2px" }}>
          <text style={{ fontWeight: 600, fontSize: "13px" }}>Manual protection</text>
          <text style={{ fontSize: "11px", color: muted }}>Keep screen and session awake</text>
        </column>
        <M3Switch
          testId="nosleep-toggle-btn"
          checked={manual()}
          ariaLabel={manual() ? "Disable manual" : "Enable manual"}
          onToggle={() => void props.client()?.invokeCommand("plugin.z-shell.nosleep.toggle").catch(() => undefined)}
        />
      </row>

      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "12px", gap: "8px" }}>
        <row style={{ alignItems: "center", gap: "8px" }}>
          <vector d={smartToy} viewBox="0 0 24 24" ariaHidden style={{ width: "16px", height: "16px", color: primary }} />
          <text role="heading" style={{ fontWeight: 600, fontSize: "13px", flexGrow: 1 }}>Agent protection</text>
          <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted, fontVariantNumeric: "tabular-nums" }}>
            {snapshot()?.activeAgents.length ?? 0} active
          </text>
        </row>
        <box ariaHidden style={{ width: "100%", height: "1px", backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 50%, transparent)" }} />
        <For each={snapshot()?.activeAgents ?? []} keyed={agent => agent.id}
          fallback={<text style={{ color: muted, fontSize: "12px" }}>No active agents detected</text>}>
          {agent => (
            <row style={{ alignItems: "center", justifyContent: "space-between", padding: "6px 8px", borderRadius: "10px", backgroundColor: containerHighest }}>
              <text style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}>{agent().label ?? agent().id}</text>
              <box ariaHidden style={{ width: "6px", height: "6px", borderRadius: "3px", backgroundColor: primary }} />
            </row>
          )}
        </For>
      </column>

      <box ariaHidden style={{ width: "100%", height: "1px", backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 45%, transparent)" }} />
      <text style={{ fontSize: "11px", color: muted, lineHeight: "15px" }}>
        Left-click the bar icon to toggle manual protection · Right-click to open panel
      </text>
    </column>
  );
}
