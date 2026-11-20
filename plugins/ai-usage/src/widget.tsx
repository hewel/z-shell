import { Button, createMemo, type Accessor, type NativeChild } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { useTopic } from "@z-shell/sdk/zgui";
import type { AiUsageSnapshot } from "./service.ts";

function compactReset(reset: string): string {
  const timestamp = Date.parse(reset);
  if (!Number.isFinite(timestamp)) return reset;
  const minutes = Math.ceil((timestamp - Date.now()) / 60_000);
  if (minutes <= 0) return "due";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.ceil(hours / 24)}d`;
}

export default function Widget(props: {
  readonly client: Accessor<ZShellClient | undefined>;
  readonly vertical: boolean;
  readonly onOpenPanel?: () => void;
}): NativeChild {
  const { data: snapshot } = useTopic<AiUsageSnapshot>(props.client, "plugin.z-shell.ai-usage.quotas");
  const summary = createMemo(() => {
    const quota = snapshot()?.quotas[0];
    const remaining = quota?.remainingPercent;
    const percent = remaining == null ? "—" : `${Math.round(remaining)}%`;
    const reset = quota?.resetsAt;
    return { percent, horizontal: reset ? `${percent} · ${compactReset(reset)}` : percent };
  });

  return (
    <Button testId="plugin-ai-usage-widget" ariaLabel={`AI Usage: ${summary().horizontal}`}
      onClick={() => {
        if (props.onOpenPanel) props.onOpenPanel();
        else void props.client()?.invokeCommand("plugin.z-shell.ai-usage.refresh").catch(() => undefined);
      }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        width: props.vertical ? "32px" : "auto", height: "32px", borderRadius: "16px",
        padding: props.vertical ? "0" : "0 10px",
        border: props.vertical ? "2px solid var(--color-primary)" : "none",
        backgroundColor: "var(--color-surface-container)", color: "var(--color-on-surface)",
        opacity: snapshot()?.stale || snapshot()?.offlineBlocked ? 0.55 : 1,
      }}>
      <text style={{ fontSize: props.vertical ? "10px" : "12px", fontWeight: 600, whiteSpace: "nowrap" }}>
        {props.vertical ? summary().percent : summary().horizontal}
      </text>
    </Button>
  );
}
