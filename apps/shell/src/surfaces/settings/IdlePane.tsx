import { Button, For, Show, TextField, createEffect, createMemo, createSignal, onCleanup, type Accessor, type NativeChild } from "@hewel/zgui";
import { M3Button, M3CardAction, M3InteractiveCard, M3SegmentedControl, M3Switch } from "@z-shell/sdk/primitives";
import { createOpacityEnter, useMotionScheme } from "../../motion.ts";
import { useShellStore } from "../../store.ts";
import {
  formatKeepAwakeRemaining,
  supportsOsSleepBlock,
  supportsTimedKeepAwake,
  type IdleAction,
} from "../../topics.ts";

const KEEP_AWAKE_PRESETS = [
  { id: "1800", label: "30m", seconds: 1800, testId: "settings-keep-awake-30m" },
  { id: "3600", label: "1h", seconds: 3600, testId: "settings-keep-awake-1h" },
  { id: "7200", label: "2h", seconds: 7200, testId: "settings-keep-awake-2h" },
  { id: "indefinite", label: "Forever", seconds: null, testId: "settings-keep-awake-inf" },
] as const;

function presetIdForDuration(seconds: number | null | undefined): string {
  if (seconds === null) return "indefinite";
  const matched = KEEP_AWAKE_PRESETS.find(p => p.seconds === seconds);
  return matched ? matched.id : "3600";
}
import {
  clipped,
  container,
  containerHigh,
  containerHighest,
  grow,
  muted,
  onPrimary,
  onPrimaryContainer,
  onSurface,
  primary,
  primaryContainer,
} from "./shared.tsx";

const IDLE_ACTIONS = {
  lock: "Lock",
  screen_off: "Screen off",
  suspend: "Suspend",
  lock_and_suspend: "Lock + sleep",
} as const;

const IDLE_ACTION_KINDS = [
  { id: "lock", label: "Lock", testId: "settings-idle-action-lock" },
  { id: "screen_off", label: "Screen off", testId: "settings-idle-action-screen_off" },
  { id: "suspend", label: "Suspend", testId: "settings-idle-action-suspend" },
  { id: "lock_and_suspend", label: "Lock + sleep", testId: "settings-idle-action-lock_and_suspend" },
  { id: "custom_command", label: "Command", testId: "settings-idle-action-custom_command" },
] as const;

const inputField = {
  height: "32px",
  borderRadius: "8px",
  padding: "6px 8px",
  backgroundColor: container,
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 65%, transparent)",
  color: onSurface,
  fontFamily: "var(--font-mono)",
  fontSize: "12px",
} as const;

interface EditableIdleRule {
  name: string;
  enabled: boolean;
  timeout_seconds: number;
  locked_timeout_seconds: number | null;
  action: IdleAction;
  resume_command: readonly string[] | null;
  pre_action_fade_seconds: number;
}

function actionKindOf(action: IdleAction): typeof IDLE_ACTION_KINDS[number]["id"] {
  return typeof action === "string" ? action : "custom_command";
}

function customCommandOf(action: IdleAction): readonly string[] | null {
  return typeof action === "object" ? action.custom_command : null;
}

function formatRuleTitle(action: IdleAction, name: string): string {
  const label = typeof action === "string" ? IDLE_ACTIONS[action] : "Custom command";
  const normalizedName = name.trim().toLowerCase().replaceAll("-", "_");
  const defaultSlug = typeof action === "string" ? action : "custom_command";
  if (!normalizedName || normalizedName === defaultSlug) return label;
  return `${label} · ${name}`;
}

function formatRuleDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function RuleEditorCard(props: {
  rule: Accessor<EditableIdleRule>;
  dirty: Accessor<boolean>;
  animate: boolean;
  onUpdate: (name: string, updater: (rule: EditableIdleRule) => EditableIdleRule) => void;
  onRemove: () => void;
  onApply: () => void;
}): NativeChild {
  const scheme = useMotionScheme();
  const fade = createOpacityEnter("fastEffects", scheme);
  return (
    <column style={{
      borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px",
      opacity: props.animate ? Math.max(0, Math.min(1, fade())) : 1,
    }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
        <text style={{ fontSize: "13px", fontWeight: 600 }}>{`Rule editor · ${props.rule().name}`}</text>
        <M3Button variant="text" danger size="sm" onClick={props.onRemove}>
          <text>Remove</text>
        </M3Button>
      </row>

      <M3SegmentedControl
        ariaLabel="Idle action"
        compact
        options={IDLE_ACTION_KINDS}
        value={actionKindOf(props.rule().action)}
        onChange={kind => {
          const nextAction: IdleAction = kind === "custom_command"
            ? (typeof props.rule().action === "object" ? props.rule().action : { custom_command: [] })
            : kind;
          props.onUpdate(props.rule().name, r => ({ ...r, action: nextAction }));
        }}
      />

      <Show when={actionKindOf(props.rule().action) === "custom_command"}>
        <column style={{ gap: "4px", width: "100%" }}>
          <text style={{ fontSize: "11px", fontWeight: 500, color: primary }}>
            Action command (required argv, space-separated)
          </text>
          <TextField
            testId="settings-idle-custom-command"
            ariaLabel="Action command"
            placeholder="e.g. brightnessctl -d *::kbd_backlight set 0"
            value={(customCommandOf(props.rule().action) ?? []).join(" ")}
            onInput={ev => {
              const parts = ev.value.trim().split(/\s+/).filter(Boolean);
              props.onUpdate(props.rule().name, r => ({ ...r, action: { custom_command: parts } }));
            }}
            style={{
              ...inputField,
              border: (customCommandOf(props.rule().action)?.length ?? 0) === 0
                ? "1px solid var(--color-error)"
                : "1px solid color-mix(in srgb, var(--color-primary) 55%, transparent)",
            }}
          />
        </column>
      </Show>

      <row style={{ gap: "8px", width: "100%" }}>
        <column style={{ ...grow, gap: "4px" }}>
          <text style={{ fontSize: "11px", color: muted }}>After (seconds)</text>
          <TextField ariaLabel="Idle timeout seconds" value={String(props.rule().timeout_seconds)}
            onInput={ev => {
              const n = Number.parseInt(ev.value, 10);
              if (Number.isFinite(n) && n >= 0 && n <= 86400) {
                props.onUpdate(props.rule().name, r => ({ ...r, timeout_seconds: n }));
              }
            }} style={inputField} />
        </column>
        <column style={{ ...grow, gap: "4px" }}>
          <text style={{ fontSize: "11px", color: muted }}>When locked (s)</text>
          <TextField ariaLabel="Locked timeout seconds" value={props.rule().locked_timeout_seconds == null ? "" : String(props.rule().locked_timeout_seconds)}
            placeholder="Optional"
            onInput={ev => {
              const trimmed = ev.value.trim();
              if (!trimmed) {
                props.onUpdate(props.rule().name, r => ({ ...r, locked_timeout_seconds: null }));
                return;
              }
              const n = Number.parseInt(trimmed, 10);
              if (Number.isFinite(n) && n >= 1 && n <= 86400) {
                props.onUpdate(props.rule().name, r => ({ ...r, locked_timeout_seconds: n }));
              }
            }} style={inputField} />
        </column>
        <column style={{ ...grow, gap: "4px" }}>
          <text style={{ fontSize: "11px", color: muted }}>Warning (0–60s)</text>
          <TextField ariaLabel="Warning fade seconds" value={String(props.rule().pre_action_fade_seconds)}
            onInput={ev => {
              const n = Number.parseInt(ev.value, 10);
              if (Number.isFinite(n) && n >= 0 && n <= 60) {
                props.onUpdate(props.rule().name, r => ({ ...r, pre_action_fade_seconds: n }));
              }
            }} style={inputField} />
        </column>
      </row>

      <column style={{ gap: "4px", width: "100%" }}>
        <text style={{ fontSize: "11px", color: muted }}>Resume command (optional argv, space-separated)</text>
        <TextField ariaLabel="Resume command" placeholder="e.g. niri msg action power-on-monitors"
          value={props.rule().resume_command ? props.rule().resume_command!.join(" ") : ""}
          onInput={ev => {
            const parts = ev.value.trim().split(/\s+/).filter(Boolean);
            props.onUpdate(props.rule().name, r => ({ ...r, resume_command: parts.length > 0 ? parts : null }));
          }} style={inputField} />
      </column>

      <Show when={props.dirty()}>
        {() => {
          const missingCommand = () => {
            const cmd = customCommandOf(props.rule().action);
            return cmd !== null && cmd.length === 0;
          };
          return (
            <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px", paddingTop: "4px" }}>
              <row style={{ alignItems: "center", gap: "6px", minWidth: "0px" }}>
                <box ariaHidden style={{ width: "6px", height: "6px", borderRadius: "3px", "--zgui-corner-shape": "none", backgroundColor: primary, flexShrink: 0 }} />
                <text style={{ ...clipped, fontSize: "11px", color: muted }}>
                  {missingCommand()
                    ? "Enter an action command before applying"
                    : "Unsaved changes · Apply to commit to host idle daemon"}
                </text>
              </row>
              <Button
                testId="settings-idle-apply"
                disabled={missingCommand()}
                onClick={props.onApply}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", height: "30px",
                  padding: "0 14px", borderRadius: "10px", backgroundColor: primary, color: onPrimary,
                  fontSize: "12px", fontWeight: 600, flexShrink: 0,
                  opacity: missingCommand() ? 0.45 : 1,
                }}
              >
                <text>Apply</text>
              </Button>
            </row>
          );
        }}
      </Show>
    </column>
  );
}

export function IdlePane(): NativeChild {
  const { idle, invokePublic, invokeHost } = useShellStore();
  const caffeine = () => idle.data()?.caffeine ?? false;
  const timedSupported = () => supportsTimedKeepAwake(idle.data());
  const keepAwakeTimed = () => Boolean(caffeine() && idle.data()?.caffeine_expires_at_ms != null);
  const [nowMs, setNowMs] = createSignal(Date.now());
  createEffect(keepAwakeTimed, active => {
    if (!active) return;
    let timer: number | undefined;
    const tick = () => {
      const now = Date.now();
      setNowMs(now);
      timer = setTimeout(tick, 1_000 - (now % 1_000));
    };
    tick();
    onCleanup(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  });
  const keepAwakeStatus = () => {
    const snap = idle.data();
    if (!caffeine()) return "Off";
    if (!timedSupported()) return "Awake";
    return formatKeepAwakeRemaining(snap?.caffeine_expires_at_ms, nowMs());
  };
  const selectedPreset = () => presetIdForDuration(idle.data()?.caffeine_duration_seconds);
  const sleepBlockStatus = () => idle.data()?.sleep_block_status;
  const osSleepBlockSupported = () => supportsOsSleepBlock(idle.data());
  const unavailableSleepBlockReason = () => {
    const status = sleepBlockStatus();
    return status?.status === "unavailable" ? status.reason : null;
  };
  const keepAwakeSubtitle = () => {
    if (!caffeine()) return "Manual sleep inhibit · Allow screen-off";
    const status = sleepBlockStatus();
    if (status?.status === "held") return "OS sleep block active · Screen-off & lock allowed";
    if (status?.status === "unavailable") return "Local idle sleep only · OS sleep block unavailable";
    if (!osSleepBlockSupported()) return "Local idle sleep inhibit · Update z-shelld for OS sleep block";
    return "Manual sleep inhibit · Allow screen-off";
  };
  const serviceStatus = () => idle.data()?.service_status?.status ?? "stopped";
  const [draftRules, setDraftRules] = createSignal<EditableIdleRule[]>([]);
  const [selectedName, setSelectedName] = createSignal<string | null>(null);
  const [editorAnimated, setEditorAnimated] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);

  createEffect(() => idle.data()?.rules, rules => {
    if (!rules || dirty()) return;
    const cloned = rules.map(r => ({ ...r }));
    setDraftRules(cloned);
    if (cloned.length > 0 && (!selectedName() || !cloned.some(r => r.name === selectedName()))) {
      setSelectedName(cloned[0]!.name);
    }
  });

  const selectedRule = createMemo(() => draftRules().find(r => r.name === selectedName()) ?? null);

  function selectRule(name: string): void {
    if (name !== selectedName()) setEditorAnimated(true);
    setSelectedName(name);
  }

  function updateRule(name: string, updater: (rule: EditableIdleRule) => EditableIdleRule): void {
    setDraftRules(prev => prev.map(rule => (rule.name === name ? updater(rule) : rule)));
    setDirty(true);
  }

  function addRule(): void {
    const existing = new Set(draftRules().map(r => r.name));
    let n = draftRules().length + 1;
    let name = `rule-${n}`;
    while (existing.has(name)) name = `rule-${++n}`;
    const next: EditableIdleRule = {
      name,
      enabled: false,
      timeout_seconds: 300,
      locked_timeout_seconds: null,
      action: "lock",
      resume_command: null,
      pre_action_fade_seconds: 2,
    };
    setDraftRules(prev => [...prev, next]);
    selectRule(name);
    setDirty(true);
  }

  function removeSelected(): void {
    const current = selectedName();
    if (!current) return;
    const next = draftRules().filter(r => r.name !== current);
    setDraftRules(next);
    setSelectedName(next[0]?.name ?? null);
    setDirty(true);
  }

  async function applyRules(): Promise<void> {
    const serialized = draftRules().map(rule => ({
      name: rule.name,
      enabled: rule.enabled,
      timeout_seconds: rule.timeout_seconds,
      locked_timeout_seconds: rule.locked_timeout_seconds,
      action: rule.action,
      resume_command: rule.resume_command,
      pre_action_fade_seconds: rule.pre_action_fade_seconds,
    }));
    const res = await invokeHost("settings.patch", { idle: { rules: serialized } });
    if (res) setDirty(false);
  }

  return (
    <column testId="settings-idle-pane" style={{ gap: "12px", width: "100%" }}>
      <column testId="settings-keep-awake-card" style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "12px 14px", gap: "10px" }}>
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
          <column style={{ ...grow, gap: "2px" }}>
            <row style={{ alignItems: "center", gap: "8px" }}>
              <text style={{ fontSize: "13px", fontWeight: 600 }}>Keep awake</text>
              <row style={{
                alignItems: "center", gap: "5px", padding: "2px 8px", borderRadius: "999px", "--zgui-corner-shape": "none",
                backgroundColor: serviceStatus() === "running" ? primaryContainer : containerHighest,
                color: serviceStatus() === "running" ? onPrimaryContainer : muted,
                fontSize: "11px", fontWeight: 600,
              }}>
                <box ariaHidden style={{ width: "6px", height: "6px", borderRadius: "3px", backgroundColor: serviceStatus() === "running" ? primary : muted }} />
                <text>{serviceStatus() === "running" ? "Watching" : serviceStatus()}</text>
              </row>
            </row>
            <text testId="settings-keep-awake-subtitle" style={{ fontSize: "11px", color: muted }}>{keepAwakeSubtitle()}</text>
          </column>
          <row style={{ alignItems: "center", gap: "8px", flexShrink: 0 }}>
            <text testId="settings-keep-awake-status" data-tabular="true" style={{
              fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 500,
              color: caffeine() ? primary : muted, fontVariantNumeric: "tabular-nums",
            }}>
              {keepAwakeStatus()}
            </text>
            <M3Switch
              testId="settings-idle-caffeine"
              ariaLabel="Keep awake"
              checked={caffeine()}
              onToggle={() => void invokePublic("idle.caffeine", { enabled: !caffeine() })}
            />
          </row>
        </row>
        <Show when={unavailableSleepBlockReason()}>
          {reason => (
            <row testId="settings-keep-awake-os-block-warning" style={{
              alignItems: "center", gap: "8px", padding: "6px 10px", borderRadius: "10px",
              backgroundColor: "var(--color-error-container)", color: "var(--color-on-error-container)",
            }}>
              <text style={{ ...clipped, fontSize: "11px", lineHeight: "15px", fontWeight: 500 }}>
                {`OS sleep block unavailable: ${reason()}`}
              </text>
            </row>
          )}
        </Show>
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
          <text style={{ fontSize: "11px", color: muted, whiteSpace: "nowrap", flexShrink: 0 }}>
            {timedSupported() ? "Auto-expire timer" : "Timed presets require updated z-shelld"}
          </text>
          <M3SegmentedControl
            ariaLabel="Keep awake duration preset"
            compact
            options={KEEP_AWAKE_PRESETS.map(preset => ({
              ...preset,
              disabled: !timedSupported(),
            }))}
            value={selectedPreset()}
            onChange={id => {
              const preset = KEEP_AWAKE_PRESETS.find(p => p.id === id);
              if (!preset) return;
              void invokePublic("idle.caffeine", {
                enabled: caffeine(),
                duration_seconds: preset.seconds,
              });
            }}
            style={{ width: "280px", flexShrink: 0 }}
          />
        </row>
      </column>

      <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "8px" }}>
        <row style={{ alignItems: "center", justifyContent: "space-between" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>Idle rules</text>
          <Button testId="settings-idle-add" onClick={addRule} style={{
            display: "flex", alignItems: "center", justifyContent: "center", minHeight: "26px",
            padding: "4px 10px", borderRadius: "8px", backgroundColor: containerHighest, color: onSurface,
            fontSize: "11px", fontWeight: 600,
          }}>
            <text>+ Add rule</text>
          </Button>
        </row>
        <For each={draftRules()} keyed={rule => rule.name} fallback={<text style={{ fontSize: "12px", color: muted }}>No declarative idle rules configured</text>}>
          {rule => {
            const selected = () => selectedName() === rule().name;
            return (
              <M3InteractiveCard
                layout="row"
                testId={`settings-idle-rule-card-${rule().name}`}
                actionTestId={`settings-idle-rule-${rule().name}`}
                ariaLabel={formatRuleTitle(rule().action, rule().name)}
                selected={selected()}
                onClick={() => selectRule(rule().name)}
                style={{
                  borderRadius: "14px", padding: "8px 10px", alignItems: "center", gap: "10px",
                  backgroundColor: selected() ? primaryContainer : container,
                  border: selected() ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
                  color: selected() ? onPrimaryContainer : onSurface,
                }}
              >
                <column style={{ ...grow, gap: "1px", minHeight: "32px", justifyContent: "center" }}>
                  <text style={{ ...clipped, fontSize: "13px", fontWeight: 600 }}>{formatRuleTitle(rule().action, rule().name)}</text>
                  <text data-tabular="true" style={{
                    ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", fontVariantNumeric: "tabular-nums",
                    color: selected() ? onPrimaryContainer : muted, opacity: selected() ? 0.8 : 1,
                  }}>
                    {`after ${formatRuleDuration(rule().timeout_seconds)}${rule().locked_timeout_seconds ? ` · locked ${formatRuleDuration(rule().locked_timeout_seconds!)}` : ""}${rule().enabled ? "" : " · Disabled"}`}
                  </text>
                </column>
                <M3CardAction style={{ flexShrink: 0 }}>
                  <M3Switch
                    testId={`settings-idle-switch-${rule().name}`}
                    ariaLabel={`Enable ${rule().name}`}
                    checked={rule().enabled}
                    onToggle={() => updateRule(rule().name, r => ({ ...r, enabled: !r.enabled }))}
                  />
                </M3CardAction>
              </M3InteractiveCard>
            );
          }}
        </For>
      </column>

      <Show when={selectedName()} keyed>
        {_name => (
          <Show when={selectedRule()}>
            {rule => (
              <RuleEditorCard
                rule={rule}
                dirty={dirty}
                animate={editorAnimated()}
                onUpdate={updateRule}
                onRemove={removeSelected}
                onApply={() => void applyRules()}
              />
            )}
          </Show>
        )}
      </Show>

      <Show when={(idle.data()?.active_inhibitors.length ?? 0) > 0}>
        <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "8px" }}>
          <text style={{ fontSize: "13px", fontWeight: 600 }}>Active inhibitors</text>
          <For each={idle.data()?.active_inhibitors} keyed={item => `${item.source.source}:${item.scope}:${item.reason}`}>
            {item => (
              <row style={{ borderRadius: "10px", backgroundColor: containerHighest, padding: "8px 10px", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <text style={{ ...clipped, fontWeight: 500, fontSize: "12px", lineHeight: "16px" }}>{`${item().source.source} · ${item().scope}`}</text>
                <text style={{ ...clipped, fontSize: "11px", lineHeight: "14px", color: muted }}>{item().reason}</text>
              </row>
            )}
          </For>
        </column>
      </Show>
    </column>
  );
}
