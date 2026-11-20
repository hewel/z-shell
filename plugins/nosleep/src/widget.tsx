import { Button, Show, type Accessor, type NativeChild } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { useTopic } from "@z-shell/sdk/zgui";
import type { NoSleepSnapshot } from "./service.ts";

const coffee = "M20 3H4v10c0 2.21 1.79 4 4 4h6c2.21 0 4-1.79 4-4v-3h2c1.11 0 2-.89 2-2V5c0-1.11-.89-2-2-2zm0 5h-2V5h2v3zM4 19h16v2H4z";
const smartToy = "M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zM7.5 11.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5S9.83 13 9 13s-1.5-.67-1.5-1.5zM16 17H8v-2h8v2zm-.5-4c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z";

export default function Widget(props: {
  readonly client: Accessor<ZShellClient | undefined>;
  readonly vertical: boolean;
  readonly onOpenPanel?: () => void;
}): NativeChild {
  const { data: snapshot } = useTopic<NoSleepSnapshot>(props.client, "plugin.z-shell.nosleep.state");
  const active = () => snapshot()?.active === true;
  const hasAgents = () => (snapshot()?.activeAgents.length ?? 0) > 0;

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
        display: "flex", flexDirection: props.vertical ? "column" : "row",
        alignItems: "center", justifyContent: "center", flexShrink: 0, gap: "4px",
        minWidth: "26px", minHeight: "26px", padding: hasAgents() ? "2px 4px" : "0px",
        borderRadius: "999px",
        backgroundColor: active() ? "var(--color-primary-container)" : "transparent",
        color: active() ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)",
      }}>
      <vector d={coffee} viewBox="0 0 24 24" ariaHidden style={{ width: "16px", height: "16px", flexShrink: 0 }} />
      <Show when={hasAgents()}>
        <vector testId="nosleep-agent-dot" d={smartToy} viewBox="0 0 24 24" ariaHidden
          style={{ width: "14px", height: "14px", flexShrink: 0, color: "var(--color-primary)" }} />
      </Show>
    </Button>
  );
}
