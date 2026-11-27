import { For, Show, createMemo, createSignal, cx, untrack, type Accessor, type NativeChild } from "@hewel/zgui";
import type { ZShellClient } from "@z-shell/sdk";
import { M3Collapsible, M3IconButton, M3InteractiveCard, M3LinearProgress } from "@z-shell/sdk/primitives";
import { SPRING_EPSILON, createM3Spring, useGlobalMotionScheme, useTopic, type MotionScheme } from "@z-shell/sdk/zgui";
import styles from "./panel.module.css";
import type { AiUsageSnapshot, QuotaEntry } from "./service.ts";

// Tabler Icons v3.53 24x24 Outline glyphs (`sparkles`, `refresh`, `settings`, `chevron-down`).
const AUTO_AWESOME =
  "M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6";
const REFRESH_ICON = "M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4\nM4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4";
const SETTINGS_ICON =
  "M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065\nM9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0";
const EXPAND_MORE = "M6 9l6 6l6 -6";

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
  const [expanded, setExpanded] = createSignal(untrack(() => props.defaultExpanded));
  const chevronDeg = createM3Spring(() => expanded() ? 180 : 0, "fastSpatial", {
    scheme: () => props.scheme(),
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
      class={cx(styles.subcard, styles.subcardInteractive)}
    >
      <row class={styles.providerHeader}>
        <box ariaHidden class={styles.providerIconWell}>
          <vector d={AUTO_AWESOME} viewBox="0 0 24 24" class={styles.providerIcon} />
        </box>
        <column class={styles.providerTitleCol}>
          <text class={styles.providerTitle}>{props.provider}</text>
          <text class={styles.providerSubtitle}>
            {`${props.entries.length} ${props.entries.length === 1 ? "window" : "windows"}`}
          </text>
        </column>
        <Show when={extraEntries().length > 0}>
          <vector ariaHidden d={EXPAND_MORE} viewBox="0 0 24 24" class={styles.chevronIcon} style={{
            transform: `rotate(${chevronDeg().toFixed(1)}deg)`,
          }} />
        </Show>
      </row>

      <Show when={primaryEntry()}>
        {entry => <MetricBar quota={entry()} />}
      </Show>

      <M3Collapsible open={expanded() && extraEntries().length > 0} estimatedHeight={Math.max(54, extraEntries().length * 58)}>
        <column class={styles.extraEntries}>
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
    <column class={styles.metricCol}>
      <row class={styles.metricHeader}>
        <text class={styles.metricLabel}>{props.quota.label}</text>
        <text data-tabular="true" class={styles.metricValue}>
          {formatPercent(remaining())}
        </text>
      </row>
      <M3LinearProgress value={remaining() ?? 0} ariaLabel={`${props.quota.label} remaining`} />
      <text class={styles.monoMuted}>
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
  const { data: snapshot } = useTopic<AiUsageSnapshot>(() => props.client(), "plugin.z-shell.ai-usage.quotas");
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
    <column testId="plugin-ai-usage-panel" class={styles.panel}>
      <row class={styles.headerRow}>
        <column class={styles.headerTitles}>
          <text role="heading" class={styles.panelTitle}>AI usage</text>
          <text class={styles.panelSubtitle}>Remaining quota</text>
        </column>
        <row class={styles.headerActions}>
          <M3IconButton
            testId="ai-usage-refresh"
            ariaLabel="Refresh AI usage"
            variant="filled-tonal"
            onClick={() => void props.client()?.invokeCommand("plugin.z-shell.ai-usage.refresh").catch(() => undefined)}
          >
            <vector d={REFRESH_ICON} viewBox="0 0 24 24" class={styles.actionIcon} />
          </M3IconButton>
          <Show when={props.onOpenSettings}>
            {openSettings => (
              <M3IconButton testId="ai-usage-open-settings" ariaLabel="Open AI usage settings" variant="filled-tonal" onClick={openSettings()}>
                <vector d={SETTINGS_ICON} viewBox="0 0 24 24" class={styles.actionIcon} />
              </M3IconButton>
            )}
          </Show>
        </row>
      </row>

      <Show when={snapshot()?.offlineBlocked || snapshot()?.lastError != null}>
        <column role="status" class={cx(styles.subcard, styles.errorCard)}>
          <Show when={snapshot()?.offlineBlocked}><text>Offline mode blocks Codex Resets updates.</text></Show>
          <Show when={snapshot()?.lastError}>{error => <text>{`Data may be stale: ${error().message}`}</text>}</Show>
        </column>
      </Show>

      <For each={groups()} keyed={group => group.provider} fallback={<text class={styles.emptyText}>No quota data available</text>}>
        {(group, index) => (
          <ProviderQuotaCard provider={group().provider} entries={group().entries} defaultExpanded={index() === 0} scheme={scheme} />
        )}
      </For>

      <Show when={snapshot()?.codexResets}>
        {resets => (
          <>
            <box ariaHidden class={styles.divider} />
            <column class={styles.subcard}>
              <row class={styles.resetsHeader}>
                <text role="heading" class={styles.resetsTitle}>Codex resets</text>
                <text data-tabular="true" class={styles.forecastBadge}>
                  {`Forecast ${formatPercent(resets().forecastChancePercent)}`}
                </text>
              </row>
              <Show when={resets().latest}>
                {event => <text class={styles.monoMuted}>{`Latest: ${resetDetail(event().kind, event().announcedAt ?? event().scheduledFor)}`}</text>}
              </Show>
              <Show when={resets().scheduled}>
                {event => <text class={styles.monoMuted}>{`Scheduled: ${resetDetail(event().kind, event().scheduledFor ?? event().announcedAt)}`}</text>}
              </Show>
            </column>
          </>
        )}
      </Show>
    </column>
  );
}
