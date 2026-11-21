import { Button, For, Show, TextField, createEffect, createSignal, type NativeChild } from "@hewel/zgui";
import { useTopic, type PluginSettingsProps } from "@z-shell/sdk/zgui";
import type { AiUsageSnapshot } from "./service.ts";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const grow = { flexGrow: 1, flexBasis: "0px", minWidth: "0px" } as const;
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;

const REFRESH_PRESETS = [60, 180, 300, 600, 900] as const;
const TIMEOUT_PRESETS = [2000, 5000, 10000, 15000] as const;

export default function AiUsageSettingsPage(props: PluginSettingsProps): NativeChild {
  const { data: snapshot } = useTopic<AiUsageSnapshot>(props.client, "plugin.z-shell.ai-usage.quotas");
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
    <column testId="plugin-ai-usage-settings" style={{ gap: "12px", width: "100%", color: onSurface, fontFamily: "var(--font-sans)" }}>
      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <column style={{ ...grow, gap: "2px" }}>
            <text style={{ fontSize: "13px", fontWeight: 600 }}>Active quota providers</text>
            <text style={{ fontSize: "11px", color: muted }}>
              {`${snapshot()?.quotas.length ?? 0} windows reported by ai-usagebar`}
            </text>
          </column>
          <Button testId="ai-settings-refresh"
            onClick={() => void props.client()?.invokeCommand("plugin.z-shell.ai-usage.refresh").catch(() => undefined)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", minHeight: "28px",
              padding: "4px 12px", borderRadius: "8px", backgroundColor: primaryContainer, color: onPrimaryContainer,
              fontSize: "12px", fontWeight: 600,
            }}>
            <text>Refresh now</text>
          </Button>
        </row>

        <row style={{ gap: "8px", flexWrap: "wrap" }}>
          <For each={snapshot()?.quotas ?? []} keyed={item => `${item.provider}:${item.label}`}
            fallback={<text style={{ fontSize: "12px", color: muted }}>Waiting for quota telemetry</text>}>
            {quota => (
              <column style={{ ...grow, minWidth: "160px", borderRadius: "14px", backgroundColor: container, padding: "10px", gap: "2px" }}>
                <text style={{ ...clipped, fontSize: "12px", fontWeight: 600 }}>{quota().provider}</text>
                <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: primary, fontVariantNumeric: "tabular-nums" }}>
                  {`${quota().label} · ${quota().remainingPercent == null ? "—" : `${Math.round(quota().remainingPercent!)}%`}`}
                </text>
              </column>
            )}
          </For>
        </row>

        <box ariaHidden style={{ width: "100%", height: "1px", backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 45%, transparent)" }} />

        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <text style={{ fontSize: "12px", fontWeight: 500 }}>Usage refresh interval</text>
          <row style={{ gap: "4px" }}>
            <For each={REFRESH_PRESETS} keyed={sec => sec}>
              {sec => {
                const active = () => refreshSeconds() === sec();
                return (
                  <Button selected={active()} onClick={() => { setRefreshSeconds(sec()); void save({ refresh_seconds: sec() }, `Refresh set to ${sec()}s`); }}
                    style={{
                      display: "flex", minHeight: "26px", padding: "2px 8px", borderRadius: "8px", alignItems: "center", justifyContent: "center",
                      backgroundColor: active() ? primaryContainer : container,
                      color: active() ? onPrimaryContainer : muted,
                      fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 500,
                    }}>
                    <text>{sec() >= 60 ? `${sec() / 60}m` : `${sec()}s`}</text>
                  </Button>
                );
              }}
            </For>
          </row>
        </row>

        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <text style={{ fontSize: "12px", fontWeight: 500 }}>Command timeout</text>
          <row style={{ gap: "4px" }}>
            <For each={TIMEOUT_PRESETS} keyed={ms => ms}>
              {ms => {
                const active = () => timeoutMs() === ms();
                return (
                  <Button selected={active()} onClick={() => { setTimeoutMs(ms()); void save({ timeout_ms: ms() }, `Timeout set to ${ms()}ms`); }}
                    style={{
                      display: "flex", minHeight: "26px", padding: "2px 8px", borderRadius: "8px", alignItems: "center", justifyContent: "center",
                      backgroundColor: active() ? primaryContainer : container,
                      color: active() ? onPrimaryContainer : muted,
                      fontFamily: "var(--font-mono)", fontSize: "11px", fontWeight: 500,
                    }}>
                    <text>{`${ms() / 1000}s`}</text>
                  </Button>
                );
              }}
            </For>
          </row>
        </row>
      </column>

      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
        <column style={{ gap: "2px" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>Codex Resets feed URL</text>
          <text style={{ fontSize: "11px", color: muted }}>Optional read-only status JSON endpoint (leave blank to disable)</text>
        </column>
        <row data-composite-input="true" style={{
          gap: "6px", alignItems: "center", height: "38px", borderRadius: "10px", padding: "3px 4px 3px 10px",
          backgroundColor: container,
          border: urlFocused()
            ? `2px solid ${primary}`
            : "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
        }}>
          <TextField class="shell-composite-field" ariaLabel="Codex Resets URL" placeholder="https://..." value={codexUrl()}
            onFocus={() => setUrlFocused(true)} onBlur={() => setUrlFocused(false)}
            onInput={ev => setCodexUrl(ev.value)} style={{
              ...grow, height: "30px", padding: "4px 2px",
              backgroundColor: "transparent", color: onSurface, fontFamily: "var(--font-mono)", fontSize: "12px",
            }} />
          <Button testId="ai-settings-save-url" onClick={() => void save({ codex_resets_url: codexUrl().trim() }, "Saved feed URL")}
            style={{
              display: "flex", height: "30px", padding: "0 14px", borderRadius: "8px", alignItems: "center", justifyContent: "center",
              backgroundColor: primary, color: onPrimary, fontSize: "12px", fontWeight: 600, flexShrink: 0,
            }}>
            <text>Save</text>
          </Button>
        </row>
        <Show when={savedNotice()}>
          {notice => <text style={{ fontSize: "11px", color: primary }}>{notice()}</text>}
        </Show>
      </column>
    </column>
  );
}
