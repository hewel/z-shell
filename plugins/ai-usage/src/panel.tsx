import { Button, For, Show, createMemo, createSignal, type Accessor, type NativeChild } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { M3Collapsible, M3IconButton, M3LinearProgress } from "@z-shell/sdk/primitives";
import { SPRING_EPSILON, createM3Spring, useGlobalMotionScheme, useTopic, type MotionScheme } from "@z-shell/sdk/zgui";
import type { AiUsageSnapshot, QuotaEntry } from "./service.ts";

const muted = "var(--color-on-surface-variant)";
const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const subcard = {
  flexDirection: "column", gap: "10px", padding: "12px", borderRadius: "16px",
  backgroundColor: containerHigh,
} as const;
const heading = { fontWeight: 600 } as const;
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

// Material Icons 24x24 glyphs (`auto_awesome`, `refresh`, `settings`, `expand_more`).
const AUTO_AWESOME =
  "M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25L19 15z";
const REFRESH_ICON =
  "M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z";
const SETTINGS_ICON =
  "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z";
const EXPAND_MORE = "M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z";

function formatPercent(value: number | null): string {
  return value == null ? "—" : `${Math.round(value)}%`;
}

function resetDetail(kind: string | null, time: string | null): string {
  return kind && time ? `${kind} · ${time}` : kind ?? time ?? "Time unavailable";
}

function ProviderQuotaCard(props: {
  readonly provider: string;
  readonly entries: readonly QuotaEntry[];
  readonly defaultExpanded: boolean;
  readonly scheme: Accessor<MotionScheme>;
}): NativeChild {
  const [expanded, setExpanded] = createSignal(props.defaultExpanded);
  const chevronDeg = createM3Spring(() => expanded() ? 180 : 0, "fastSpatial", {
    scheme: props.scheme,
    epsilon: SPRING_EPSILON.deg,
  });
  const primaryEntry = () => props.entries[0];
  const extraEntries = () => props.entries.slice(1);

  return (
    <column style={subcard}>
      <Button ariaLabel={`Toggle ${props.provider} details`} expanded={expanded()}
        onClick={() => setExpanded(open => !open)} style={{
          display: "flex", flexDirection: "row", alignItems: "center", gap: "10px",
          width: "100%", minHeight: "34px", padding: "4px 6px", margin: "-4px -6px", borderRadius: "10px",
          backgroundColor: "transparent", color: onSurface,
        }}>
        <box ariaHidden style={{
          display: "flex", width: "34px", height: "34px", borderRadius: "10px", flexShrink: 0,
          alignItems: "center", justifyContent: "center", backgroundColor: containerHighest,
        }}>
          <vector d={AUTO_AWESOME} viewBox="0 0 24 24" style={{ width: "16px", height: "16px", color: primary }} />
        </box>
        <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "1px", alignItems: "flex-start" }}>
          <text style={{ ...clipped, ...heading, fontSize: "13px" }}>{props.provider}</text>
          <text style={{ ...clipped, fontSize: "11px", color: muted }}>
            {`${props.entries.length} ${props.entries.length === 1 ? "window" : "windows"}`}
          </text>
        </column>
        <Show when={extraEntries().length > 0}>
          <vector ariaHidden d={EXPAND_MORE} viewBox="0 0 24 24" style={{
            width: "18px", height: "18px", color: muted, flexShrink: 0,
            transform: `rotate(${chevronDeg().toFixed(1)}deg)`,
          }} />
        </Show>
      </Button>

      <Show when={primaryEntry()}>
        {entry => <MetricBar quota={entry()} />}
      </Show>

      <M3Collapsible open={expanded() && extraEntries().length > 0} estimatedHeight={Math.max(54, extraEntries().length * 58)}>
        <column style={{ gap: "8px" }}>
          <For each={extraEntries()} keyed={item => `${item.provider}:${item.label}`}>
            {entry => <MetricBar quota={entry()} />}
          </For>
        </column>
      </M3Collapsible>
    </column>
  );
}

function MetricBar(props: { readonly quota: QuotaEntry }): NativeChild {
  const remaining = () => props.quota.remainingPercent;
  return (
    <column style={{ gap: "4px" }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <text style={{ fontSize: "12px", color: muted }}>{props.quota.label}</text>
        <text data-tabular="true" style={{
          ...heading, fontFamily: "var(--font-mono)", fontSize: "12px", color: primary, fontVariantNumeric: "tabular-nums",
        }}>
          {formatPercent(remaining())}
        </text>
      </row>
      <M3LinearProgress value={remaining() ?? 0} ariaLabel={`${props.quota.label} remaining`} />
      <text style={{ color: muted, fontFamily: "var(--font-mono)", fontSize: "11px" }}>
        {props.quota.resetsAt ? `Resets: ${props.quota.resetsAt}` : "Reset time unavailable"}
      </text>
    </column>
  );
}

export default function Panel(props: {
  readonly client: Accessor<ZShellClient | undefined>;
  readonly onClose?: () => void;
  readonly onOpenSettings?: () => void;
}): NativeChild {
  const { data: snapshot } = useTopic<AiUsageSnapshot>(props.client, "plugin.z-shell.ai-usage.quotas");
  const scheme = useGlobalMotionScheme();
  const groups = createMemo(() => {
    const byProvider = new Map<string, QuotaEntry[]>();
    for (const quota of snapshot()?.quotas ?? []) {
      const list = byProvider.get(quota.provider) ?? [];
      list.push(quota);
      byProvider.set(quota.provider, list);
    }
    return [...byProvider.entries()].map(([provider, entries]) => ({ provider, entries }));
  });

  return (
    <column testId="plugin-ai-usage-panel" style={{
      width: "100%", padding: "14px", gap: "10px", flexDirection: "column",
      backgroundColor: "transparent", color: onSurface,
      fontFamily: "var(--font-sans)", fontSize: "13px",
    }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "2px" }}>
          <text role="heading" style={{ fontSize: "20px", fontWeight: 600 }}>AI usage</text>
          <text style={{ fontSize: "11px", color: muted }}>Remaining quota</text>
        </column>
        <row style={{ gap: "6px", flexShrink: 0 }}>
          <M3IconButton
            testId="ai-usage-refresh"
            ariaLabel="Refresh AI usage"
            variant="filled-tonal"
            onClick={() => void props.client()?.invokeCommand("plugin.z-shell.ai-usage.refresh").catch(() => undefined)}
          >
            <vector d={REFRESH_ICON} viewBox="0 0 24 24" style={{ width: "16px", height: "16px", color: onSurface }} />
          </M3IconButton>
          <Show when={props.onOpenSettings}>
            {openSettings => (
              <M3IconButton testId="ai-usage-open-settings" ariaLabel="Open AI usage settings" variant="filled-tonal" onClick={openSettings()}>
                <vector d={SETTINGS_ICON} viewBox="0 0 24 24" style={{ width: "16px", height: "16px", color: onSurface }} />
              </M3IconButton>
            )}
          </Show>
        </row>
      </row>

      <Show when={snapshot()?.offlineBlocked || snapshot()?.lastError != null}>
        <column role="status" style={{ ...subcard, backgroundColor: "var(--color-error-container)", color: "var(--color-on-error-container)" }}>
          <Show when={snapshot()?.offlineBlocked}><text>Offline mode blocks Codex Resets updates.</text></Show>
          <Show when={snapshot()?.lastError}>{error => <text>{`Data may be stale: ${error().message}`}</text>}</Show>
        </column>
      </Show>

      <For each={groups()} keyed={group => group.provider} fallback={<text style={{ color: muted }}>No quota data available</text>}>
        {(group, index) => (
          <ProviderQuotaCard provider={group().provider} entries={group().entries} defaultExpanded={index() === 0} scheme={scheme} />
        )}
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
