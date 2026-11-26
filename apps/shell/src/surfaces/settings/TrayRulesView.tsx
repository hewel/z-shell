import { Button, For, Show, createMemo, createSignal, type NativeChild } from "@hewel/zgui";
import { M3Button, M3SegmentedControl } from "@z-shell/sdk/primitives";
import { ShellIcon } from "../../icons.tsx";
import { useShellStore } from "../../store.ts";
import {
  DEFAULT_BAR_TRAY_SETTINGS,
  isImeTrayItem,
  trayRuleKey,
  type TrayDefaultAction,
  type TrayItem,
  type TrayItemRule,
} from "../../topics.ts";
import {
  clipped,
  container,
  containerHigh,
  containerHighest,
  grow,
  muted,
  onPrimaryContainer,
  onSurface,
  primary,
  primaryContainer,
} from "./shared.tsx";

const DEFAULT_ACTIONS: readonly { readonly id: TrayDefaultAction; readonly label: string; readonly testId: string }[] = [
  { id: "show", label: "Show", testId: "tray-rules-default-show" },
  { id: "collapse", label: "Collapse", testId: "tray-rules-default-collapse" },
];

const ITEM_RULE_OPTIONS: readonly { readonly id: TrayItemRule; readonly label: string }[] = [
  { id: "show", label: "Show" },
  { id: "collapse", label: "Collapse" },
  { id: "hide", label: "Hide" },
];

interface TrayRuleEntry {
  readonly rowKey: string;
  readonly ruleKey: string | null;
  readonly label: string;
  readonly subtitle: string;
  readonly activeItem: TrayItem | null;
  readonly savedRule: TrayItemRule | null;
}

export function TrayRulesView(props: { readonly onBack: () => void }): NativeChild {
  const { settings, tray, ime, invokeHostResult } = useShellStore();
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const traySettings = () => settings.data()?.bar.tray ?? DEFAULT_BAR_TRAY_SETTINGS;
  const showImeIndicator = () => Boolean(ime.data()?.available && ime.data()?.mode !== "disabled");

  const applyTraySettings = async (next: {
    readonly default_action: TrayDefaultAction;
    readonly rules: Readonly<Record<string, TrayItemRule>>;
  }) => {
    setErrorMessage(null);
    const res = await invokeHostResult("settings.patch", { bar: { tray: next } });
    if (!res.ok) {
      setErrorMessage(res.error);
    }
  };

  const setDefaultAction = (nextDefault: TrayDefaultAction) => {
    const current = traySettings();
    if (current.default_action === nextDefault) return;
    void applyTraySettings({
      default_action: nextDefault,
      rules: current.rules,
    });
  };

  const setAppRule = (key: string, nextRule: TrayItemRule) => {
    const current = traySettings();
    void applyTraySettings({
      default_action: current.default_action,
      rules: { ...current.rules, [key]: nextRule },
    });
  };

  const clearAppRule = (key: string) => {
    const current = traySettings();
    if (!Object.hasOwn(current.rules, key)) return;
    const nextRules = { ...current.rules };
    delete nextRules[key];
    void applyTraySettings({
      default_action: current.default_action,
      rules: nextRules,
    });
  };

  const rows = createMemo((): readonly TrayRuleEntry[] => {
    const activeItems = (tray.data()?.items ?? []).filter(item => !(showImeIndicator() && isImeTrayItem(item)));
    const rules = traySettings().rules;
    const seenKeys = new Set<string>();
    const list: TrayRuleEntry[] = [];

    for (const item of activeItems) {
      const key = trayRuleKey(item);
      if (key !== null) {
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const savedRule = Object.hasOwn(rules, key) ? rules[key]! : null;
        list.push({
          rowKey: `active:${key}`,
          ruleKey: key,
          label: item.title?.trim() || key,
          subtitle: key,
          activeItem: item,
          savedRule,
        });
      } else {
        list.push({
          rowKey: `transient:${item.id}`,
          ruleKey: null,
          label: "Unnamed tray item",
          subtitle: item.id,
          activeItem: item,
          savedRule: null,
        });
      }
    }

    for (const key of Object.keys(rules).sort()) {
      if (seenKeys.has(key)) continue;
      list.push({
        rowKey: `saved:${key}`,
        ruleKey: key,
        label: key,
        subtitle: "Saved rule (not currently running)",
        activeItem: null,
        savedRule: rules[key]!,
      });
    }

    return list;
  });

  return (
    <column testId="settings-tray-rules-view" style={{ gap: "12px", width: "100%", height: "100%" }}>
      <row style={{ alignItems: "center", justifyContent: "space-between", gap: "10px", flexShrink: 0 }}>
        <row style={{ alignItems: "center", gap: "10px", minWidth: "0px", flexGrow: 1 }}>
          <Button
            testId="settings-tray-rules-back"
            ariaLabel="Back to Bar and layout"
            onClick={props.onBack}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "32px", height: "32px", borderRadius: "10px", flexShrink: 0,
              backgroundColor: containerHigh,
            }}
          >
            <ShellIcon name="arrowLeft" size={16} color={onSurface} />
          </Button>
          <column style={{ ...grow, gap: "2px" }}>
            <text role="heading" style={{ fontSize: "18px", fontWeight: 600, lineHeight: "24px" }}>
              System tray rules
            </text>
            <text style={{ ...clipped, fontSize: "12px", color: muted, lineHeight: "16px" }}>
              Control whether tray applications stay on the bar, collapse into overflow, or stay hidden
            </text>
          </column>
        </row>
      </row>

      <Show when={errorMessage()}>
        {msg => (
          <row testId="settings-tray-rules-error" style={{
            alignItems: "center", gap: "8px", padding: "10px 12px", borderRadius: "12px",
            backgroundColor: "var(--color-error-container)", color: "var(--color-on-error-container)",
            flexShrink: 0,
          }}>
            <ShellIcon name="warning" size={16} color="var(--color-on-error-container)" />
            <text style={{ ...grow, fontSize: "12px", lineHeight: "16px" }}>{msg()}</text>
          </row>
        )}
      </Show>

      <scroll style={{ ...grow, minHeight: "0px", width: "100%", overflow: "hidden auto" }}>
        <column style={{ gap: "12px", width: "100%" }}>
          <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "10px" }}>
            <row style={{ alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
              <column style={{ ...grow, gap: "2px" }}>
                <text style={{ fontSize: "13px", fontWeight: 600 }}>New apps default</text>
                <text style={{ ...clipped, fontSize: "11px", color: muted }}>
                  Default placement for tray apps without an explicit per-app rule
                </text>
              </column>
              <M3SegmentedControl
                ariaLabel="New apps default"
                compact
                options={DEFAULT_ACTIONS}
                value={traySettings().default_action}
                onChange={next => setDefaultAction(next)}
                style={{ width: "176px", flexShrink: 0 }}
              />
            </row>
          </column>

          <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "14px", gap: "8px" }}>
            <row style={{ alignItems: "center", justifyContent: "space-between" }}>
              <text style={{ fontSize: "13px", fontWeight: 600 }}>Applications & rules</text>
              <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", color: muted, fontVariantNumeric: "tabular-nums" }}>
                {`${Object.keys(traySettings().rules).length} saved`}
              </text>
            </row>

            <For
              each={rows()}
              keyed={row => row.rowKey}
              fallback={
                <text style={{ fontSize: "12px", color: muted, padding: "8px 0" }}>
                  No active tray applications or saved rules.
                </text>
              }
            >
              {entry => {
                const effectiveRule = (): TrayItemRule => entry().savedRule ?? traySettings().default_action;
                return (
                  <row testId={`tray-rule-row-${entry().ruleKey ?? "transient"}`} style={{
                    alignItems: "center", justifyContent: "space-between", gap: "10px",
                    padding: "10px 12px", borderRadius: "12px", backgroundColor: container,
                  }}>
                    <column style={{ ...grow, gap: "2px" }}>
                      <row style={{ alignItems: "center", gap: "6px" }}>
                        <text style={{ ...clipped, fontSize: "12px", fontWeight: 600 }}>{entry().label}</text>
                        <Show when={entry().activeItem && entry().ruleKey !== null}>
                          <box style={{
                            display: "flex", alignItems: "center", justifyContent: "center",
                            height: "18px", padding: "0 6px", borderRadius: "6px",
                            backgroundColor: primaryContainer, color: onPrimaryContainer,
                          }}>
                            <text style={{ fontSize: "10px", lineHeight: "14px", fontWeight: 600 }}>Active</text>
                          </box>
                        </Show>
                      </row>
                      <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "11px", color: muted }}>
                        {entry().subtitle}
                      </text>
                    </column>
                    <Show
                      when={entry().ruleKey}
                      fallback={
                        <box testId="tray-rule-transient-badge" style={{
                          display: "flex", alignItems: "center", justifyContent: "center",
                          height: "24px", padding: "0 8px", borderRadius: "8px",
                          backgroundColor: containerHighest, flexShrink: 0,
                        }}>
                          <text style={{ fontSize: "11px", lineHeight: "14px", color: muted }}>
                            Session-only (no stable ID)
                          </text>
                        </box>
                      }
                    >
                      {key => (
                        <row style={{ alignItems: "center", gap: "6px", flexShrink: 0 }}>
                          <M3SegmentedControl
                            ariaLabel={`Rule for ${entry().label}`}
                            compact
                            options={ITEM_RULE_OPTIONS.map(opt => ({
                              ...opt,
                              testId: `tray-rule-set-${key()}-${opt.id}`,
                            }))}
                            value={effectiveRule()}
                            onChange={next => setAppRule(key(), next)}
                            style={{ width: "224px", flexShrink: 0 }}
                          />
                          <Show when={entry().savedRule !== null}>
                            <M3Button
                              testId={`tray-rule-reset-${key()}`}
                              variant="text"
                              size="sm"
                              onClick={() => clearAppRule(key())}
                            >
                              <text style={{ color: primary }}>Reset</text>
                            </M3Button>
                          </Show>
                        </row>
                      )}
                    </Show>
                  </row>
                );
              }}
            </For>
          </column>
        </column>
      </scroll>
    </column>
  );
}
