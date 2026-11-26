import { Button, For, Show, TextField, createEffect, createMemo, createSignal, cx, onCleanup, type Accessor, type NativeChild } from "@hewel/zgui";
import { M3Button, M3CardAction, M3InteractiveCard, M3SegmentedControl, M3Switch } from "@z-shell/sdk/primitives";
import { createOpacityEnter, useMotionScheme } from "../../motion.ts";
import { useShellStore } from "../../store.ts";
import {
  formatKeepAwakeRemaining,
  supportsOsSleepBlock,
  supportsTimedKeepAwake,
  type IdleAction,
} from "../../topics.ts";
import styles from "./IdlePane.module.css";

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
    <column
      class={cx(styles.editorCard)}
      style={{ opacity: props.animate ? Math.max(0, Math.min(1, fade())) : 1 }}
    >
      <row class={cx(styles.editorHeaderRow)}>
        <text class={cx(styles.sectionTitle)}>{`Rule editor · ${props.rule().name}`}</text>
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
        <column class={cx(styles.commandSection)}>
          <text class={cx(styles.commandLabel)}>
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
            class={cx(styles.commandInput)}
            data-missing={(customCommandOf(props.rule().action)?.length ?? 0) === 0 ? "true" : null}
          />
        </column>
      </Show>

      <row class={cx(styles.fieldsRow)}>
        <column class={cx(styles.fieldCol)}>
          <text class={cx(styles.fieldLabel)}>After (seconds)</text>
          <TextField ariaLabel="Idle timeout seconds" value={String(props.rule().timeout_seconds)}
            onInput={ev => {
              const n = Number.parseInt(ev.value, 10);
              if (Number.isFinite(n) && n >= 0 && n <= 86400) {
                props.onUpdate(props.rule().name, r => ({ ...r, timeout_seconds: n }));
              }
            }} class={cx(styles.inputField)} />
        </column>
        <column class={cx(styles.fieldCol)}>
          <text class={cx(styles.fieldLabel)}>When locked (s)</text>
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
            }} class={cx(styles.inputField)} />
        </column>
        <column class={cx(styles.fieldCol)}>
          <text class={cx(styles.fieldLabel)}>Warning (0–60s)</text>
          <TextField ariaLabel="Warning fade seconds" value={String(props.rule().pre_action_fade_seconds)}
            onInput={ev => {
              const n = Number.parseInt(ev.value, 10);
              if (Number.isFinite(n) && n >= 0 && n <= 60) {
                props.onUpdate(props.rule().name, r => ({ ...r, pre_action_fade_seconds: n }));
              }
            }} class={cx(styles.inputField)} />
        </column>
      </row>

      <column class={cx(styles.commandSection)}>
        <text class={cx(styles.fieldLabel)}>Resume command (optional argv, space-separated)</text>
        <TextField ariaLabel="Resume command" placeholder="e.g. niri msg action power-on-monitors"
          value={props.rule().resume_command ? props.rule().resume_command!.join(" ") : ""}
          onInput={ev => {
            const parts = ev.value.trim().split(/\s+/).filter(Boolean);
            props.onUpdate(props.rule().name, r => ({ ...r, resume_command: parts.length > 0 ? parts : null }));
          }} class={cx(styles.inputField)} />
      </column>

      <Show when={props.dirty()}>
        {() => {
          const missingCommand = () => {
            const cmd = customCommandOf(props.rule().action);
            return cmd !== null && cmd.length === 0;
          };
          return (
            <row class={cx(styles.dirtyRow)}>
              <row class={cx(styles.dirtyLead)}>
                <box ariaHidden class={cx(styles.dirtyDot)} />
                <text class={cx(styles.dirtyLabel)}>
                  {missingCommand()
                    ? "Enter an action command before applying"
                    : "Unsaved changes · Apply to commit to host idle daemon"}
                </text>
              </row>
              <Button
                testId="settings-idle-apply"
                disabled={missingCommand()}
                onClick={props.onApply}
                class={cx(styles.applyButton)}
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
    <column testId="settings-idle-pane" class={cx(styles.pane)}>
      <column testId="settings-keep-awake-card" class={cx(styles.keepAwakeCard)}>
        <row class={cx(styles.keepAwakeHeader)}>
          <column class={cx(styles.keepAwakeTitleCol)}>
            <row class={cx(styles.keepAwakeTitleRow)}>
              <text class={cx(styles.sectionTitle)}>Keep awake</text>
              <row class={cx(styles.serviceBadge)} data-running={serviceStatus() === "running" ? "true" : null}>
                <box ariaHidden class={cx(styles.serviceDot)} data-running={serviceStatus() === "running" ? "true" : null} />
                <text>{serviceStatus() === "running" ? "Watching" : serviceStatus()}</text>
              </row>
            </row>
            <text testId="settings-keep-awake-subtitle" class={cx(styles.keepAwakeSubtitle)}>{keepAwakeSubtitle()}</text>
          </column>
          <row class={cx(styles.keepAwakeControls)}>
            <text
              testId="settings-keep-awake-status"
              data-tabular="true"
              class={cx(styles.keepAwakeStatus)}
              data-active={caffeine() ? "true" : null}
            >
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
            <row testId="settings-keep-awake-os-block-warning" class={cx(styles.warningBanner)}>
              <text class={cx(styles.warningText)}>
                {`OS sleep block unavailable: ${reason()}`}
              </text>
            </row>
          )}
        </Show>
        <row class={cx(styles.presetRow)}>
          <text class={cx(styles.presetLabel)}>
            {timedSupported() ? "Auto-expire timer" : "Timed presets require updated z-shelld"}
          </text>
          <box class={cx(styles.presetSegmented)}>
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
            />
          </box>
        </row>
      </column>

      <column class={cx(styles.rulesCard)}>
        <row class={cx(styles.rulesHeader)}>
          <text class={cx(styles.sectionTitle)}>Idle rules</text>
          <Button testId="settings-idle-add" onClick={addRule} class={cx(styles.addRuleButton)}>
            <text>+ Add rule</text>
          </Button>
        </row>
        <For each={draftRules()} keyed={rule => rule.name} fallback={<text class={cx(styles.emptyText)}>No declarative idle rules configured</text>}>
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
                class={cx(styles.ruleCard)}
                data-selected={selected() ? "true" : null}
              >
                <column class={cx(styles.ruleTextCol)}>
                  <text class={cx(styles.ruleTitle)}>{formatRuleTitle(rule().action, rule().name)}</text>
                  <text data-tabular="true" class={cx(styles.ruleMeta)} data-selected={selected() ? "true" : null}>
                    {`after ${formatRuleDuration(rule().timeout_seconds)}${rule().locked_timeout_seconds ? ` · locked ${formatRuleDuration(rule().locked_timeout_seconds!)}` : ""}${rule().enabled ? "" : " · Disabled"}`}
                  </text>
                </column>
                <M3CardAction class={cx(styles.cardAction)}>
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
        <column class={cx(styles.inhibitorsCard)}>
          <text class={cx(styles.sectionTitle)}>Active inhibitors</text>
          <For each={idle.data()?.active_inhibitors} keyed={item => `${item.source.source}:${item.scope}:${item.reason}`}>
            {item => (
              <row class={cx(styles.inhibitorRow)}>
                <text class={cx(styles.inhibitorSource)}>{`${item().source.source} · ${item().scope}`}</text>
                <text class={cx(styles.inhibitorReason)}>{item().reason}</text>
              </row>
            )}
          </For>
        </column>
      </Show>
    </column>
  );
}
