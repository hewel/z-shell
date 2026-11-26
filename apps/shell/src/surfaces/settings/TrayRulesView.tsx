import { Button, For, Image, Show, createMemo, createSignal, type NativeChild } from "@hewel/zgui";
import { M3Button, M3SegmentedControl } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
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
  outline,
  primary,
  primaryContainer,
} from "./shared.tsx";

const DEFAULT_ACTIONS: readonly { readonly id: TrayDefaultAction; readonly label: string; readonly testId: string }[] = [
  { id: "show", label: "Show in bar", testId: "tray-rules-default-show" },
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
  readonly imeManaged: boolean;
}

function TrayRuleIcon(props: { readonly entry: TrayRuleEntry }): NativeChild {
  const { hostClient } = useShellStore();
  const { src } = useDaemonMedia(hostClient, () => props.entry.activeItem?.icon, { fetchCommand: "tray.fetch-blob" });
  const fallbackLetter = () => {
    const first = Array.from(props.entry.label.trim())[0];
    return first && /^[\p{L}\p{N}]$/u.test(first) ? first.toUpperCase() : null;
  };
  return (
    <Show when={src()} fallback={
      <Show when={!props.entry.imeManaged && fallbackLetter()} fallback={
        <box style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: "24px", height: "24px", borderRadius: "6px", flexShrink: 0,
          backgroundColor: containerHighest,
        }}>
          <ShellIcon name="apps" size={14} color={muted} />
        </box>
      }>
        {letter => (
          <box style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: "24px", height: "24px", borderRadius: "6px", flexShrink: 0,
            backgroundColor: primaryContainer, color: onPrimaryContainer, fontWeight: 700, fontSize: "11px",
          }}>
            <text>{letter()}</text>
          </box>
        )}
      </Show>
    }>
      {image => <Image src={image()} style={{ width: "24px", height: "24px", borderRadius: "6px", objectFit: "contain", flexShrink: 0 }} />}
    </Show>
  );
}

export function TrayRulesView(props: { readonly onBack: () => void }): NativeChild {
  const { settings, tray, ime, invokeHostResult } = useShellStore();
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const traySettings = () => settings.data()?.bar.tray ?? DEFAULT_BAR_TRAY_SETTINGS;
  const showImeIndicator = () => Boolean(ime.data()?.available && ime.data()?.mode !== "disabled");

  const patchTray = async (trayPatch: unknown) => {
    setErrorMessage(null);
    const res = await invokeHostResult("settings.patch", { bar: { tray: trayPatch } });
    if (!res.ok) {
      setErrorMessage(res.error);
    }
  };

  const setDefaultAction = (nextDefault: TrayDefaultAction) => {
    const current = traySettings();
    if (current.default_action === nextDefault) return;
    void patchTray({ default_action: nextDefault });
  };

  const setAppRule = (key: string, nextRule: TrayItemRule) => {
    void patchTray({ rules: { [key]: nextRule } });
  };

  const clearAppRule = (key: string) => {
    if (!Object.hasOwn(traySettings().rules, key)) return;
    void patchTray({ rules: { [key]: null } });
  };

  const resetAllTrayRules = () => {
    void patchTray(null);
  };

  const isDefaultTray = () =>
    traySettings().default_action === "show" && Object.keys(traySettings().rules).length === 0;

  const runningCount = createMemo(() =>
    (tray.data()?.items ?? []).filter(item => !(showImeIndicator() && isImeTrayItem(item))).length,
  );

  const rows = createMemo((): readonly TrayRuleEntry[] => {
    const activeItems = tray.data()?.items ?? [];
    const rules = traySettings().rules;
    const seenKeys = new Set<string>();
    const list: TrayRuleEntry[] = [];

    for (const item of activeItems) {
      const imeManaged = showImeIndicator() && isImeTrayItem(item);
      const key = trayRuleKey(item);
      if (key !== null) {
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const savedRule = Object.hasOwn(rules, key) ? rules[key]! : null;
        list.push({
          rowKey: `active:${key}`,
          ruleKey: key,
          label: item.title?.trim() || key,
          subtitle: imeManaged ? `${key} · Managed by IME` : `${key} · Running`,
          activeItem: item,
          savedRule,
          imeManaged,
        });
      } else {
        list.push({
          rowKey: `transient:${item.id}`,
          ruleKey: null,
          label: "Unnamed tray item",
          subtitle: imeManaged ? `${item.id} · Managed by IME` : item.id,
          activeItem: item,
          savedRule: null,
          imeManaged,
        });
      }
    }

    for (const key of Object.keys(rules).sort()) {
      if (seenKeys.has(key)) continue;
      list.push({
        rowKey: `saved:${key}`,
        ruleKey: key,
        label: key,
        subtitle: "Saved rule · Not running",
        activeItem: null,
        savedRule: rules[key]!,
        imeManaged: false,
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
              width: "30px", height: "30px", borderRadius: "10px", flexShrink: 0,
              backgroundColor: containerHigh,
            }}
          >
            <box data-press-visual="compact" ariaHidden style={{ display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
              <ShellIcon name="arrowLeft" size={16} color={onSurface} />
            </box>
          </Button>
          <column style={{ ...grow, gap: "2px" }}>
            <row style={{ alignItems: "center", gap: "8px" }}>
              <text role="heading" style={{ fontSize: "18px", fontWeight: 600, letterSpacing: "-0.015em", lineHeight: "24px" }}>
                System tray
              </text>
              <box style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: "2px 7px", borderRadius: "6px", backgroundColor: containerHigh, flexShrink: 0,
              }}>
                <text style={{ fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "12px", color: muted }}>[bar.tray]</text>
              </box>
            </row>
            <text style={{ ...clipped, fontSize: "11px", color: muted, lineHeight: "15px" }}>
              Pin important apps, collapse background icons, or hide redundant entries
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
          <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "12px 14px", gap: "10px" }}>
            <row style={{ alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
              <column style={{ ...grow, gap: "2px" }}>
                <text style={{ fontSize: "13px", fontWeight: 600, lineHeight: "18px" }}>New tray icons</text>
                <text style={{ ...clipped, fontSize: "11px", color: muted, lineHeight: "15px" }}>
                  Default placement for apps not listed below
                </text>
              </column>
              <M3SegmentedControl
                ariaLabel="New tray icons"
                compact
                options={DEFAULT_ACTIONS}
                value={traySettings().default_action}
                onChange={next => setDefaultAction(next)}
                style={{ width: "196px", flexShrink: 0 }}
              />
            </row>
          </column>

          <column style={{ borderRadius: "16px", backgroundColor: containerHigh, padding: "12px 14px", gap: "8px" }}>
            <row style={{ alignItems: "center", justifyContent: "space-between" }}>
              <text style={{ fontSize: "13px", fontWeight: 600 }}>Application visibility</text>
              <text data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "10px", color: outline, fontVariantNumeric: "tabular-nums" }}>
                {`${Object.keys(traySettings().rules).length} rules · ${runningCount()} running`}
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
                    padding: "9px 10px", borderRadius: "12px", backgroundColor: container,
                  }}>
                    <TrayRuleIcon entry={entry()} />
                    <column style={{ ...grow, gap: "1px" }}>
                      <text style={{ ...clipped, fontSize: "12px", fontWeight: 600, lineHeight: "16px" }}>{entry().label}</text>
                      <text style={{ ...clipped, fontFamily: "var(--font-mono)", fontSize: "10px", color: muted, lineHeight: "14px" }}>
                        {entry().subtitle}
                      </text>
                    </column>
                    <Show
                      when={!entry().imeManaged}
                      fallback={
                        <box testId="tray-rule-ime-badge" style={{
                          display: "flex", alignItems: "center", justifyContent: "center",
                          height: "24px", padding: "0 8px", borderRadius: "8px",
                          backgroundColor: containerHighest, flexShrink: 0,
                        }}>
                          <text style={{ fontSize: "11px", lineHeight: "14px", color: muted }}>
                            Managed by IME
                          </text>
                        </box>
                      }
                    >
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
                              style={{ width: "212px", flexShrink: 0 }}
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
                    </Show>
                  </row>
                );
              }}
            </For>
          </column>
        </column>
      </scroll>

      <row style={{ alignItems: "center", justifyContent: "space-between", flexShrink: 0, paddingTop: "2px", width: "100%" }}>
        <text style={{ fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "14px", color: outline }}>
          Rules sync live to [bar.tray] in settings.toml
        </text>
        <M3Button
          testId="tray-rules-reset-all"
          variant="text"
          size="sm"
          disabled={isDefaultTray()}
          onClick={resetAllTrayRules}
        >
          <text style={{ color: muted }}>Reset defaults</text>
        </M3Button>
      </row>
    </column>
  );
}
