import { Button, Show, createMemo, type Accessor, type NativeChild, type NativeNode } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { SPRING_EPSILON, createM3Spring, useGlobalMotionScheme, useTopic } from "@z-shell/sdk/zgui";
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

const TRACK_RING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="2.2"/></svg>`;
// Material Icons 24x24 `auto_awesome` glyph (DESIGN.md Material-First Icon Rule).
const MATERIAL_AUTO_AWESOME_PATH =
  "M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z";

function buildQuotaArcSvg(percent: number | null): string {
  const clamped = Math.max(0, Math.min(100, percent ?? 0));
  const r = 9.2;
  let arc = "";
  if (clamped >= 99.5) {
    arc = `<circle cx="12" cy="12" r="${r}" fill="none" stroke="currentColor" stroke-width="2.2"/>`;
  } else if (clamped > 0.5) {
    const theta = (clamped / 100) * Math.PI * 2 - Math.PI / 2;
    const x = (12 + r * Math.cos(theta)).toFixed(2);
    const y = (12 + r * Math.sin(theta)).toFixed(2);
    const largeArc = clamped > 50 ? 1 : 0;
    arc = `<path d="M12 2.8A${r} ${r} 0 ${largeArc} 1 ${x} ${y}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${arc}<g transform="translate(6 6) scale(0.5)"><path d="${MATERIAL_AUTO_AWESOME_PATH}" fill="currentColor"/></g></svg>`;
}

export default function Widget(props: {
  readonly client: Accessor<ZShellClient | undefined>;
  readonly vertical: boolean;
  readonly onOpenPanel?: (entryId?: string, anchor?: NativeNode) => void;
}): NativeChild {
  const { data: snapshot } = useTopic<AiUsageSnapshot>(props.client, "plugin.z-shell.ai-usage.quotas");
  const summary = createMemo(() => {
    const quota = snapshot()?.quotas[0];
    const remaining = quota?.remainingPercent ?? null;
    const percent = remaining == null ? "—" : `${Math.round(remaining)}%`;
    const reset = quota?.resetsAt;
    return { remaining, percent, horizontal: reset ? `${percent} · ${compactReset(reset)}` : percent };
  });
  const scheme = useGlobalMotionScheme();
  const animatedPercent = createM3Spring(() => summary().remaining ?? 0, "defaultSpatial", {
    scheme,
    epsilon: SPRING_EPSILON.px,
  });
  const ringSize = () => props.vertical ? "24px" : "20px";

  return (
    <Button testId="plugin-ai-usage-widget" ariaLabel={`AI Usage: ${summary().horizontal}`}
      onClick={event => {
        event.stopPropagation();
        if (props.onOpenPanel) props.onOpenPanel(undefined, event.currentTarget);
        else void props.client()?.invokeCommand("plugin.z-shell.ai-usage.refresh").catch(() => undefined);
      }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", flexGrow: 1, flexShrink: 0, gap: "6px",
        width: props.vertical ? "100%" : "auto",
        minWidth: "24px",
        height: props.vertical ? "auto" : "100%",
        minHeight: "24px",
        borderRadius: "inherit",
        padding: props.vertical ? "0px" : "0 8px",
        backgroundColor: "transparent", color: "inherit",
        opacity: snapshot()?.stale || snapshot()?.offlineBlocked ? 0.55 : 1,
      }}>
      <row data-press-visual="compact" style={{ display: "flex", alignItems: "center", gap: "6px", pointerEvents: "none" }}>
        <box ariaHidden style={{ position: "relative", width: ringSize(), height: ringSize(), flexShrink: 0 }}>
          <vector svg={TRACK_RING_SVG} style={{
            position: "absolute", inset: "0px", width: ringSize(), height: ringSize(),
            color: "var(--color-surface-container-highest)",
          }} />
          <vector svg={buildQuotaArcSvg(summary().remaining == null ? null : animatedPercent())} style={{
            position: "absolute", inset: "0px", width: ringSize(), height: ringSize(),
            color: "var(--color-primary)",
          }} />
        </box>
        <Show when={!props.vertical}>
          <text data-tabular="true" style={{
            fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 500, whiteSpace: "nowrap",
            fontVariantNumeric: "tabular-nums",
          }}>
            {summary().horizontal}
          </text>
        </Show>
      </row>
    </Button>
  );
}
