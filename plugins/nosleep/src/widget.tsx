import { Button, Show, type Accessor, type NativeChild } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { useTopic } from "@z-shell/sdk/zgui";
import type { NoSleepSnapshot } from "./service.ts";

const coffee = "M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm0 5h-2V5h2v3zM4 19h16v2H4z";

export default function Widget(props: {
  readonly client: Accessor<ZShellClient | undefined>;
  readonly vertical: boolean;
  readonly onOpenPanel?: () => void;
}): NativeChild {
  const { data: snapshot } = useTopic<NoSleepSnapshot>(props.client, "plugin.z-shell.nosleep.state");
  const active = () => snapshot()?.active === true;

  return (
    <Button testId="plugin-nosleep-widget" data-active={active() ? "true" : "false"}
      ariaLabel={active() ? "NoSleep: Awake" : "NoSleep: Idle"}
      onClick={() => void props.client()?.invokeCommand("plugin.z-shell.nosleep.toggle").catch(() => undefined)}
      onPointerDown={event => {
        // Mouse right-click arrives as a secondary press; touch uses contextmenu.
        if (event.button !== "secondary" || !props.onOpenPanel) return;
        event.preventDefault();
        props.onOpenPanel();
      }}
      onContextMenu={event => {
        if (!props.onOpenPanel) return;
        event.preventDefault();
        props.onOpenPanel();
      }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, position: "relative",
        width: "26px", height: "26px", borderRadius: "999px",
        backgroundColor: active() ? "var(--color-primary-container)" : "transparent",
        color: active() ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)",
      }}>
      <vector d={coffee} viewBox="0 0 24 24" ariaHidden style={{ width: "16px", height: "16px" }} />
      <Show when={(snapshot()?.activeAgents.length ?? 0) > 0}>
        <box testId="nosleep-agent-dot" ariaHidden style={{
          position: "absolute", top: "1px", right: "1px", pointerEvents: "none",
          width: "6px", height: "6px", borderRadius: "3px", backgroundColor: "var(--color-primary)",
        }} />
      </Show>
    </Button>
  );
}
