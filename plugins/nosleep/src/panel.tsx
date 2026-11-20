import { Button, For, type Accessor, type NativeChild } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { useTopic } from "@z-shell/sdk/zgui";
import { NOSLEEP_DEFAULTS, type NoSleepSnapshot } from "./service.ts";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const coffee = "M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm0 5h-2V5h2v3zM4 19h16v2H4z";
const smartToy = "M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zM7.5 11.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5S9.83 13 9 13s-1.5-.67-1.5-1.5zM16 17H8v-2h8v2zm-.5-4c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z";

export default function Panel(props: {
  readonly client: Accessor<ZShellClient | undefined>;
  readonly onClose?: () => void;
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
        <column style={{ gap: "2px", minWidth: "0px" }}>
          <text role="heading" style={{ fontSize: "18px", fontWeight: 600 }}>Nosleep</text>
          <text style={{ fontSize: "11px", color: muted }}>
            {`Scope: ${snapshot()?.scope ?? NOSLEEP_DEFAULTS.inhibit_scope}`}
          </text>
        </column>
        <box style={{
          padding: "5px 10px", borderRadius: "999px", fontSize: "11px", fontWeight: 600,
          backgroundColor: active() ? primaryContainer : containerHigh,
          color: active() ? onPrimaryContainer : muted,
        }}>
          <text>{active() ? "Awake" : "Idle"}</text>
        </box>
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
        <Button testId="nosleep-toggle-btn" checked={manual()} ariaLabel={manual() ? "Disable manual" : "Enable manual"}
          onClick={() => void props.client()?.invokeCommand("plugin.z-shell.nosleep.toggle").catch(() => undefined)}
          style={{
            display: "flex", width: "42px", height: "24px", borderRadius: "999px", padding: "3px", flexShrink: 0,
            alignItems: "center", justifyContent: manual() ? "flex-end" : "flex-start",
            backgroundColor: manual() ? primary : containerHighest,
          }}>
          <box ariaHidden style={{
            width: "18px", height: "18px", borderRadius: "999px",
            backgroundColor: manual() ? onPrimary : muted,
          }} />
        </Button>
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
