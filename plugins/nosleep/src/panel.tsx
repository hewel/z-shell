import { Button, For, type Accessor, type NativeChild } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { useTopic } from "@z-shell/sdk/zgui";
import { NOSLEEP_DEFAULTS, type NoSleepSnapshot } from "./service.ts";

const muted = "var(--color-on-surface-variant)";
const pill = { padding: "6px 10px", borderRadius: "14px", backgroundColor: "var(--color-surface-container-high)" } as const;
const row = { alignItems: "center", justifyContent: "space-between", gap: "8px" } as const;

export default function Panel(props: {
  readonly client: Accessor<ZShellClient | undefined>;
  readonly onClose?: () => void;
}): NativeChild {
  const { data: snapshot } = useTopic<NoSleepSnapshot>(props.client, "plugin.z-shell.nosleep.state");
  const active = () => snapshot()?.active === true;

  return (
    <column testId="plugin-nosleep-panel" style={{
      width: "100%", padding: "16px", gap: "12px", flexDirection: "column", borderRadius: "20px",
      backgroundColor: "var(--color-surface-container)", color: "var(--color-on-surface)",
      fontFamily: "system-ui", fontSize: "13px",
    }}>
      <row style={row}>
        <text role="heading" style={{ fontSize: "16px", fontWeight: 700 }}>NoSleep</text>
        <box style={{
          ...pill,
          backgroundColor: active() ? "var(--color-primary-container)" : pill.backgroundColor,
          color: active() ? "var(--color-on-primary-container)" : muted,
        }}>
          <text>{active() ? "Awake" : "Idle"}</text>
        </box>
      </row>
      <row style={row}>
        <box ariaLabel="Inhibition scope" style={pill}><text>{snapshot()?.scope ?? NOSLEEP_DEFAULTS.inhibit_scope}</text></box>
        <Button testId="nosleep-toggle-btn"
          onClick={() => void props.client()?.invokeCommand("plugin.z-shell.nosleep.toggle").catch(() => undefined)}
          style={pill}>
          <text style={{ fontWeight: 600 }}>{snapshot()?.manualActive ? "Disable manual" : "Enable manual"}</text>
        </Button>
      </row>
      <column style={{ gap: "6px" }}>
        <text role="heading" style={{ fontWeight: 600 }}>Active agents</text>
        <For each={snapshot()?.activeAgents ?? []} keyed={agent => agent.id}
          fallback={<text style={{ color: muted }}>No active agents detected</text>}>
          {agent => <text style={{ color: muted }}>{agent().label ?? agent().id}</text>}
        </For>
      </column>
    </column>
  );
}
