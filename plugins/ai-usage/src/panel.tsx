import { For, Show, createMemo, createSignal, type Accessor, type NativeChild } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { M3Collapsible, M3IconButton, M3InteractiveCard, M3LinearProgress } from "@z-shell/sdk/primitives";
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

// Tabler Icons v3.53 24x24 Outline glyphs (`sparkles`, `refresh`, `settings`, `chevron-down`).
const AUTO_AWESOME =
  "M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6";
const REFRESH_ICON = "M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4\nM4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4";
const SETTINGS_ICON =
  "M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065\nM9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0";
const EXPAND_MORE = "M6 9l6 6l6 -6";
const strokeStyle = {
  "--zgui-fill": "transparent",
  "--zgui-stroke-width": "2px",
  "--zgui-stroke-linecap": "round",
  "--zgui-stroke-linejoin": "round",
} as const;

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
    <M3InteractiveCard
      layout="column"
      ariaLabel={extraEntries().length > 0 ? `Toggle ${props.provider} details` : null}
      expanded={expanded()}
      onClick={extraEntries().length > 0 ? () => setExpanded(open => !open) : undefined}
      style={{ ...subcard, color: onSurface }}
    >
      <row style={{ alignItems: "center", gap: "10px", width: "100%", minHeight: "34px" }}>
        <box ariaHidden style={{
          display: "flex", width: "34px", height: "34px", borderRadius: "10px", flexShrink: 0,
          alignItems: "center", justifyContent: "center", backgroundColor: containerHighest,
        }}>
          <vector d={AUTO_AWESOME} viewBox="0 0 24 24" style={{ width: "16px", height: "16px", color: primary, "--zgui-stroke": primary, ...strokeStyle }} />
        </box>
        <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "1px", alignItems: "flex-start" }}>
          <text style={{ ...clipped, ...heading, fontSize: "13px" }}>{props.provider}</text>
          <text style={{ ...clipped, fontSize: "11px", color: muted }}>
            {`${props.entries.length} ${props.entries.length === 1 ? "window" : "windows"}`}
          </text>
        </column>
        <Show when={extraEntries().length > 0}>
          <vector ariaHidden d={EXPAND_MORE} viewBox="0 0 24 24" style={{
            width: "18px", height: "18px", color: muted, "--zgui-stroke": muted, ...strokeStyle, flexShrink: 0,
            transform: `rotate(${chevronDeg().toFixed(1)}deg)`,
          }} />
        </Show>
      </row>

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
    </M3InteractiveCard>
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
            <vector d={REFRESH_ICON} viewBox="0 0 24 24" style={{ width: "16px", height: "16px", color: onSurface, "--zgui-stroke": onSurface, ...strokeStyle }} />
          </M3IconButton>
          <Show when={props.onOpenSettings}>
            {openSettings => (
              <M3IconButton testId="ai-usage-open-settings" ariaLabel="Open AI usage settings" variant="filled-tonal" onClick={openSettings()}>
                <vector d={SETTINGS_ICON} viewBox="0 0 24 24" style={{ width: "16px", height: "16px", color: onSurface, "--zgui-stroke": onSurface, ...strokeStyle }} />
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
