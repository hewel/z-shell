import { Button, For, Show, TextField, createEffect, createSignal, cx, type NativeChild } from "@hewel/zgui";
import { useTopic, type PluginSettingsProps } from "@z-shell/sdk/zgui";
import type { AiUsageSnapshot } from "./service.ts";
import styles from "./settings-page.module.css";

const REFRESH_PRESETS = [60, 180, 300, 600, 900] as const;
const TIMEOUT_PRESETS = [2000, 5000, 10000, 15000] as const;

export default function AiUsageSettingsPage(props: PluginSettingsProps): NativeChild {
  const { data: snapshot } = useTopic<AiUsageSnapshot>(() => props.client(), "plugin.z-shell.ai-usage.quotas");
  const [refreshSeconds, setRefreshSeconds] = createSignal(300);
  const [timeoutMs, setTimeoutMs] = createSignal(5000);
  const [codexUrl, setCodexUrl] = createSignal("");
  const [urlFocused, setUrlFocused] = createSignal(false);
  const [savedNotice, setSavedNotice] = createSignal<string | null>(null);

  createEffect(() => props.readSettings, reader => {
    if (!reader) return;
    void reader().then(values => {
      if (typeof values.refresh_seconds === "number") setRefreshSeconds(values.refresh_seconds);
      if (typeof values.timeout_ms === "number") setTimeoutMs(values.timeout_ms);
      if (typeof values.codex_resets_url === "string") setCodexUrl(values.codex_resets_url);
    });
  });

  async function save(patch: Record<string, unknown>, label: string): Promise<void> {
    if (!props.patchSettings) return;
    const committed = await props.patchSettings(patch);
    if (committed) setSavedNotice(label);
  }

  return (
    <column testId="plugin-ai-usage-settings" class={styles.page}>
      <column class={styles.card}>
        <row class={styles.sectionHeader}>
          <column class={styles.growCol}>
            <text class={styles.sectionTitle}>Active quota providers</text>
            <text class={styles.sectionDesc}>
              {`${snapshot()?.quotas.length ?? 0} windows reported by ai-usagebar`}
            </text>
          </column>
          <Button
            testId="ai-settings-refresh"
            onClick={() => void props.client()?.invokeCommand("plugin.z-shell.ai-usage.refresh").catch(() => undefined)}
            class={styles.refreshBtn}
          >
            <text>Refresh now</text>
          </Button>
        </row>

        <row class={styles.quotaGrid}>
          <For each={snapshot()?.quotas ?? []} keyed={item => `${item.provider}:${item.label}`}
            fallback={<text class={styles.sectionDesc}>Waiting for quota telemetry</text>}>
            {quota => (
              <column class={styles.quotaTile}>
                <text class={styles.quotaProvider}>{quota().provider}</text>
                <text data-tabular="true" class={styles.quotaValue}>
                  {`${quota().label} · ${quota().remainingPercent == null ? "—" : `${Math.round(quota().remainingPercent!)}%`}`}
                </text>
              </column>
            )}
          </For>
        </row>

        <box ariaHidden class={styles.divider} />

        <row class={styles.settingRow}>
          <text class={styles.settingLabel}>Usage refresh interval</text>
          <row class={styles.presetRow}>
            <For each={REFRESH_PRESETS} keyed={sec => sec}>
              {sec => {
                const active = () => refreshSeconds() === sec();
                return (
                  <Button
                    selected={active()}
                    data-active={active() ? "true" : null}
                    onClick={() => { setRefreshSeconds(sec()); void save({ refresh_seconds: sec() }, `Refresh set to ${sec()}s`); }}
                    class={styles.presetBtn}
                  >
                    <text>{sec() >= 60 ? `${sec() / 60}m` : `${sec()}s`}</text>
                  </Button>
                );
              }}
            </For>
          </row>
        </row>

        <row class={styles.settingRow}>
          <text class={styles.settingLabel}>Command timeout</text>
          <row class={styles.presetRow}>
            <For each={TIMEOUT_PRESETS} keyed={ms => ms}>
              {ms => {
                const active = () => timeoutMs() === ms();
                return (
                  <Button
                    selected={active()}
                    data-active={active() ? "true" : null}
                    onClick={() => { setTimeoutMs(ms()); void save({ timeout_ms: ms() }, `Timeout set to ${ms()}ms`); }}
                    class={styles.presetBtn}
                  >
                    <text>{`${ms() / 1000}s`}</text>
                  </Button>
                );
              }}
            </For>
          </row>
        </row>
      </column>

      <column class={styles.card}>
        <column class={styles.growCol}>
          <text class={styles.sectionTitle}>Codex Resets feed URL</text>
          <text class={styles.sectionDesc}>Optional read-only status JSON endpoint (leave blank to disable)</text>
        </column>
        <row data-composite-input="true" data-focused={urlFocused() ? "true" : null} class={styles.compositeInput}>
          <TextField
            class={cx("shell-composite-field", styles.urlInput)}
            ariaLabel="Codex Resets URL"
            placeholder="https://..."
            value={codexUrl()}
            onFocus={() => setUrlFocused(true)}
            onBlur={() => setUrlFocused(false)}
            onInput={ev => setCodexUrl(ev.value)}
          />
          <Button
            testId="ai-settings-save-url"
            onClick={() => void save({ codex_resets_url: codexUrl().trim() }, "Saved feed URL")}
            class={styles.saveBtn}
          >
            <text>Save</text>
          </Button>
        </row>
        <Show when={savedNotice()}>
          {notice => <text class={styles.savedNotice}>{notice()}</text>}
        </Show>
      </column>
    </column>
  );
}
