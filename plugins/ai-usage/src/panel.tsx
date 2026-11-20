import { Button, For, Show, type Accessor, type NativeChild } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { useTopic } from "@z-shell/sdk/zgui";
import type { AiUsageSnapshot, QuotaEntry } from "./service.ts";

const muted = "var(--color-on-surface-variant)";
const primary = "var(--color-primary)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const subcard = {
  flexDirection: "column", gap: "8px", padding: "12px", borderRadius: "16px",
  backgroundColor: containerHigh,
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
        <text style={{ ...heading, fontSize: "13px" }}>{`${props.quota().provider} · ${props.quota().label}`}</text>
        <text data-tabular="true" style={{
          ...heading, fontFamily: "var(--font-mono)", fontSize: "12px", color: primary, fontVariantNumeric: "tabular-nums",
        }}>
          {formatPercent(remaining())}
        </text>
      </row>
      <box role="progressIndicator" ariaLabel="Quota remaining" ariaValueMin={0} ariaValueMax={100} ariaValueNow={remaining()}
        style={{ height: "6px", borderRadius: "3px", overflow: "hidden", backgroundColor: containerHighest }}>
        <box data-percent-fill="true" style={{ width: `${remaining() ?? 0}%`, height: "100%", borderRadius: "3px", backgroundColor: primary }} />
      </box>
      <text style={{ color: muted, fontFamily: "var(--font-mono)", fontSize: "11px" }}>
        {props.quota().resetsAt ? `Resets: ${props.quota().resetsAt}` : "Reset time unavailable"}
      </text>
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
      width: "100%", padding: "14px", gap: "10px", flexDirection: "column",
      backgroundColor: container, color: "var(--color-on-surface)",
      fontFamily: "var(--font-sans)", fontSize: "13px",
    }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <column style={{ gap: "2px" }}>
          <text role="heading" style={{ fontSize: "18px", fontWeight: 600 }}>AI Usage</text>
          <text style={{ fontSize: "11px", color: muted }}>Rolling provider quota telemetry</text>
        </column>
        <Button testId="ai-usage-refresh" onClick={() => void props.client()?.invokeCommand("plugin.z-shell.ai-usage.refresh").catch(() => undefined)}
          style={{
            padding: "6px 12px", borderRadius: "10px",
            backgroundColor: "var(--color-primary-container)", color: "var(--color-on-primary-container)", fontSize: "12px",
          }}>
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
          <>
            <box ariaHidden style={{ width: "100%", height: "1px", backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 45%, transparent)" }} />
            <column style={subcard}>
              <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <text role="heading" style={{ ...heading, fontSize: "13px" }}>Codex resets</text>
                <text data-tabular="true" style={{
                  fontFamily: "var(--font-mono)", fontSize: "11px", padding: "2px 8px", borderRadius: "8px",
                  backgroundColor: containerHighest, color: primary, fontVariantNumeric: "tabular-nums",
                }}>
                  {`Forecast ${formatPercent(resets().forecastChancePercent)}`}
                </text>
              </row>
              <Show when={resets().latest}>
                {event => <text style={{ color: muted, fontFamily: "var(--font-mono)", fontSize: "11px" }}>{`Latest: ${resetDetail(event().kind, event().announcedAt ?? event().scheduledFor)}`}</text>}
              </Show>
              <Show when={resets().scheduled}>
                {event => <text style={{ color: muted, fontFamily: "var(--font-mono)", fontSize: "11px" }}>{`Scheduled: ${resetDetail(event().kind, event().scheduledFor ?? event().announcedAt)}`}</text>}
              </Show>
            </column>
          </>
        )}
      </Show>
    </column>
  );
}
