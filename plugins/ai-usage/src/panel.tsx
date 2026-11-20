import { Button, For, Show, type Accessor, type NativeChild } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { useTopic } from "@z-shell/sdk/zgui";
import type { AiUsageSnapshot, QuotaEntry } from "./service.ts";

const muted = "var(--color-on-surface-variant)";
const primary = "var(--color-primary)";
const subcard = {
  flexDirection: "column", gap: "6px", padding: "10px", borderRadius: "10px",
  backgroundColor: "var(--color-surface-container-high)",
} as const;
const heading = { fontWeight: 600 } as const;

function formatPercent(value: number | null): string {
  return value == null ? "—" : `${Math.round(value)}%`;
}

function QuotaWindow(props: { readonly quota: Accessor<QuotaEntry> }) {
  const remaining = () => props.quota().remainingPercent;
  return (
    <column style={subcard}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <text style={heading}>{`${props.quota().provider} · ${props.quota().label}`}</text>
        <text style={{ ...heading, color: primary }}>{formatPercent(remaining())}</text>
      </row>
      <box role="progressIndicator" ariaLabel="Quota remaining" ariaValueMin={0} ariaValueMax={100} ariaValueNow={remaining()}
        style={{ height: "4px", borderRadius: "2px", overflow: "hidden", backgroundColor: "var(--color-surface-container-highest)" }}>
        <box style={{ width: `${remaining() ?? 0}%`, height: "100%", borderRadius: "2px", backgroundColor: primary }} />
      </box>
      <text style={{ color: muted }}>{props.quota().resetsAt ? `Resets: ${props.quota().resetsAt}` : "Reset time unavailable"}</text>
    </column>
  );
}

function resetDetail(kind: string | null, time: string | null): string {
  return kind && time ? `${kind} · ${time}` : kind ?? time ?? "Time unavailable";
}

export default function Panel(props: {
  readonly client: Accessor<ZShellClient | undefined>;
  readonly onClose?: () => void;
}): NativeChild {
  const { data: snapshot } = useTopic<AiUsageSnapshot>(props.client, "plugin.z-shell.ai-usage.quotas");

  return (
    <column testId="plugin-ai-usage-panel" style={{
      width: "100%", padding: "16px", gap: "12px", flexDirection: "column", borderRadius: "16px",
      backgroundColor: "var(--color-surface-container)", color: "var(--color-on-surface)",
      fontFamily: "var(--font-sans)", fontSize: "13px",
    }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <text role="heading" style={{ fontSize: "16px", fontWeight: 700 }}>AI Usage</text>
        <Button testId="ai-usage-refresh" onClick={() => void props.client()?.invokeCommand("plugin.z-shell.ai-usage.refresh").catch(() => undefined)}
          style={{ padding: "6px 10px", borderRadius: "14px", backgroundColor: "var(--color-primary-container)", color: "var(--color-on-primary-container)" }}>
          <text style={heading}>Refresh</text>
        </Button>
      </row>
      <Show when={snapshot()?.offlineBlocked || snapshot()?.lastError != null}>
        <column role="status" style={{ ...subcard, backgroundColor: "var(--color-error-container)", color: "var(--color-on-error-container)" }}>
          <Show when={snapshot()?.offlineBlocked}><text>Offline mode blocks Codex Resets updates.</text></Show>
          <Show when={snapshot()?.lastError}>{error => <text>{`Data may be stale: ${error().message}`}</text>}</Show>
        </column>
      </Show>
      <For each={snapshot()?.quotas ?? []} keyed={false} fallback={<text style={{ color: muted }}>No quota data available</text>}>
        {quota => <QuotaWindow quota={quota} />}
      </For>
      <Show when={snapshot()?.codexResets}>
        {resets => (
          <column style={subcard}>
            <text role="heading" style={heading}>Codex Resets</text>
            <text style={{ color: muted }}>{`Forecast chance: ${formatPercent(resets().forecastChancePercent)}`}</text>
            <Show when={resets().latest}>
              {event => <text style={{ color: muted }}>{`Latest: ${resetDetail(event().kind, event().announcedAt ?? event().scheduledFor)}`}</text>}
            </Show>
            <Show when={resets().scheduled}>
              {event => <text style={{ color: muted }}>{`Scheduled: ${resetDetail(event().kind, event().scheduledFor ?? event().announcedAt)}`}</text>}
            </Show>
          </column>
        )}
      </Show>
    </column>
  );
}
