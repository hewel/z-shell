import { Button, Show, createMemo, type Accessor, type NativeChild, type NativeNode } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { SPRING_EPSILON, createM3Spring, useGlobalMotionScheme, useTopic } from "@z-shell/sdk/zgui";
import type { AiUsageSnapshot } from "./service.ts";
import styles from "./widget.module.css";

function compactReset(reset: string): string {
  const timestamp = Date.parse(reset);
  if (!Number.isFinite(timestamp)) return reset;
  const minutes = Math.ceil((timestamp - Date.now()) / 60_000);
  if (minutes <= 0) return "due";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.ceil(hours / 24)}d`;
}

const TRACK_RING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
// Tabler Icons v3.53 Outline `sparkles` glyph (Col B pure outline center badge).
const TABLER_SPARKLES_OUTLINE_PATH =
  "M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6";

function buildQuotaArcSvg(percent: number | null): string {
  const clamped = Math.max(0, Math.min(100, percent ?? 0));
  const r = 9.2;
  let arc = "";
  if (clamped >= 99.5) {
    arc = `<circle cx="12" cy="12" r="${r}" fill="none" stroke="currentColor" stroke-width="2"/>`;
  } else if (clamped > 0.5) {
    const theta = (clamped / 100) * Math.PI * 2 - Math.PI / 2;
    const x = (12 + r * Math.cos(theta)).toFixed(2);
    const y = (12 + r * Math.sin(theta)).toFixed(2);
    const largeArc = clamped > 50 ? 1 : 0;
    arc = `<path d="M12 2.8A${r} ${r} 0 ${largeArc} 1 ${x} ${y}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${arc}<g transform="translate(6 6) scale(0.5)"><path d="${TABLER_SPARKLES_OUTLINE_PATH}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
}

export default function Widget(props: {
  readonly client: Accessor<ZShellClient | undefined>;
  readonly vertical: boolean;
  readonly onOpenPanel?: (entryId?: string, anchor?: NativeNode) => void;
}): NativeChild {
  const { data: snapshot } = useTopic<AiUsageSnapshot>(() => props.client(), "plugin.z-shell.ai-usage.quotas");
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

  return (
    <Button
      testId="plugin-ai-usage-widget"
      ariaLabel={`AI Usage: ${summary().horizontal}`}
      data-vertical={props.vertical ? "true" : null}
      data-stale={snapshot()?.stale || snapshot()?.offlineBlocked ? "true" : null}
      class={styles.widgetButton}
      onClick={event => {
        event.stopPropagation();
        if (props.onOpenPanel) props.onOpenPanel(undefined, event.currentTarget);
        else void props.client()?.invokeCommand("plugin.z-shell.ai-usage.refresh").catch(() => undefined);
      }}
    >
      <row data-press-visual="compact" class={styles.widgetVisual}>
        <box ariaHidden class={styles.ringBox} data-vertical={props.vertical ? "true" : null}>
          <vector svg={TRACK_RING_SVG} class={styles.ringTrack} data-vertical={props.vertical ? "true" : null} />
          <vector
            svg={buildQuotaArcSvg(summary().remaining == null ? null : animatedPercent())}
            class={styles.ringArc}
            data-vertical={props.vertical ? "true" : null}
          />
        </box>
        <Show when={!props.vertical}>
          <text data-tabular="true" class={styles.widgetText}>
            {summary().horizontal}
          </text>
        </Show>
      </row>
    </Button>
  );
}
