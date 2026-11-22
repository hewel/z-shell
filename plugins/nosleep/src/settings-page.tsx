import { Button, For, Show, TextField, createEffect, createSignal, type NativeChild } from "@hewel/zgui";
import { M3Button, M3SegmentedControl, M3Switch } from "@z-shell/sdk/primitives";
import { useTopic, type PluginSettingsProps } from "@z-shell/sdk/zgui";
import { NOSLEEP_DEFAULTS, type NoSleepSnapshot } from "./service.ts";

const primary = "var(--color-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const grow = { flexGrow: 1, flexBasis: "0px", minWidth: "0px" } as const;

const SCOPES = [
  { id: "sleep", label: "sleep" },
  { id: "idle", label: "idle" },
  { id: "lock", label: "lock" },
] as const;
const POLL_PRESETS = [1000, 2000, 5000, 10000] as const;

export default function NosleepSettingsPage(props: PluginSettingsProps): NativeChild {
  const { data: snapshot } = useTopic<NoSleepSnapshot>(props.client, "plugin.z-shell.nosleep.state");
  const [scope, setScope] = createSignal<string>(NOSLEEP_DEFAULTS.inhibit_scope);
  const [pollMs, setPollMs] = createSignal<number>(NOSLEEP_DEFAULTS.poll_interval_ms);
  const [agentDir, setAgentDir] = createSignal<string>("");
  const [dirFocused, setDirFocused] = createSignal(false);
  const [savedNotice, setSavedNotice] = createSignal<string | null>(null);

  createEffect(() => props.readSettings, reader => {
    if (!reader) return;
    void reader().then(values => {
      if (typeof values.inhibit_scope === "string") setScope(values.inhibit_scope);
      if (typeof values.poll_interval_ms === "number") setPollMs(values.poll_interval_ms);
      if (typeof values.agent_working_dir === "string") setAgentDir(values.agent_working_dir);
    });
  });

  async function save(patch: Record<string, unknown>, label: string): Promise<void> {
    if (!props.patchSettings) return;
    const committed = await props.patchSettings(patch);
    if (committed) setSavedNotice(label);
  }

  const manual = () => snapshot()?.manualActive === true;

  return (
    <column testId="plugin-nosleep-settings" style={{ gap: "12px", width: "100%", color: onSurface, fontFamily: "var(--font-sans)" }}>
      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
          <column style={{ ...grow, gap: "2px" }}>
            <text style={{ fontSize: "13px", fontWeight: 600 }}>Manual sleep block policy</text>
            <text style={{ fontSize: "11px", color: muted }}>
              {`Current state: ${snapshot()?.active ? "Awake" : "Idle"} · Lease auto-releases on disconnect`}
            </text>
          </column>
          <M3Switch
            testId="nosleep-settings-toggle"
            checked={manual()}
            ariaLabel="Toggle manual nosleep"
            onToggle={() => void props.client()?.invokeCommand("plugin.z-shell.nosleep.toggle").catch(() => undefined)}
          />
        </row>

        <box ariaHidden style={{ width: "100%", height: "1px", backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 45%, transparent)" }} />

        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <text style={{ fontSize: "12px", fontWeight: 500 }}>Inhibit scope</text>
          <M3SegmentedControl
            ariaLabel="Inhibit scope"
            options={SCOPES}
            value={scope()}
            compact
            style={{ width: "220px" }}
            onChange={next => { setScope(next); void save({ inhibit_scope: next }, `Scope set to ${next}`); }}
          />
        </row>

        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <text style={{ fontSize: "12px", fontWeight: 500 }}>Agent poll interval</text>
          <row style={{ gap: "4px" }}>
            <For each={POLL_PRESETS} keyed={ms => ms}>
              {ms => {
                const active = () => pollMs() === ms();
                return (
                  <Button selected={active()} onClick={() => { setPollMs(ms()); void save({ poll_interval_ms: ms() }, `Poll set to ${ms()}ms`); }}
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
        <row style={{ alignItems: "center", justifyContent: "space-between" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>Agent idle guard</text>
          <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: primary, fontVariantNumeric: "tabular-nums" }}>
            {`${snapshot()?.activeAgents.length ?? 0} active`}
          </text>
        </row>
        <row data-composite-input="true" style={{
          gap: "6px", alignItems: "center", height: "38px", borderRadius: "10px", padding: "3px 4px 3px 10px",
          backgroundColor: container,
          border: dirFocused()
            ? `2px solid ${primary}`
            : "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
        }}>
          <TextField class="shell-composite-field" ariaLabel="Agent working directory" placeholder="/path/to/agent-markers" value={agentDir()}
            onFocus={() => setDirFocused(true)} onBlur={() => setDirFocused(false)}
            onInput={ev => setAgentDir(ev.value)} style={{
              ...grow, height: "30px", padding: "4px 2px",
              backgroundColor: "transparent", color: onSurface, fontFamily: "var(--font-mono)", fontSize: "12px",
            }} />
          <M3Button
            testId="nosleep-settings-save-dir"
            variant="filled"
            size="sm"
            onClick={() => void save({ agent_working_dir: agentDir().trim() }, "Saved marker directory")}
          >
            <text>Save</text>
          </M3Button>
        </row>
        <For each={snapshot()?.activeAgents ?? []} keyed={agent => agent.id}
          fallback={<text style={{ fontSize: "12px", color: muted }}>No active agents detected</text>}>
          {agent => (
            <row style={{ borderRadius: "10px", backgroundColor: container, padding: "8px 10px", justifyContent: "space-between", alignItems: "center" }}>
              <text style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}>{agent().label ?? agent().id}</text>
              <box ariaHidden style={{ width: "6px", height: "6px", borderRadius: "3px", backgroundColor: primary }} />
            </row>
          )}
        </For>
        <Show when={savedNotice()}>
          {notice => <text style={{ fontSize: "11px", color: primary }}>{notice()}</text>}
        </Show>
      </column>
    </column>
  );
}
