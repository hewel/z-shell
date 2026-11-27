import { Button, For, Image, Show, createMemo, createSignal, cx, type NativeChild } from "@hewel/zgui";
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
import styles from "./TrayRulesView.module.css";
import { muted, onSurface } from "./shared.tsx";

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
        <box class={cx(styles.iconWell)}>
          <ShellIcon name="apps" size={14} color={muted} />
        </box>
      }>
        {letter => (
          <box class={cx(styles.letterWell)}>
            <text>{letter()}</text>
          </box>
        )}
      </Show>
    }>
      {image => <Image src={image()} class={cx(styles.trayIconImage)} />}
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
    <column testId="settings-tray-rules-view" class={cx(styles.view)}>
      <row class={cx(styles.headerRow)}>
        <row class={cx(styles.headerLead)}>
          <Button
            testId="settings-tray-rules-back"
            ariaLabel="Back to Bar and layout"
            onClick={props.onBack}
            class={cx(styles.backButton)}
          >
            <box data-press-visual="compact" ariaHidden class={cx(styles.backPressVisual)}>
              <ShellIcon name="arrowLeft" size={16} color={onSurface} />
            </box>
          </Button>
          <column class={cx(styles.titleCol)}>
            <row class={cx(styles.headingRow)}>
              <text role="heading" class={cx(styles.heading)}>
                System tray
              </text>
              <box class={cx(styles.sectionBadge)}>
                <text class={cx(styles.sectionBadgeText)}>[bar.tray]</text>
              </box>
            </row>
            <text class={cx(styles.subtitle)}>
              Pin important apps, collapse background icons, or hide redundant entries
            </text>
          </column>
        </row>
      </row>

      <Show when={errorMessage()}>
        {msg => (
          <row testId="settings-tray-rules-error" class={cx(styles.errorBanner)}>
            <ShellIcon name="warning" size={16} color="var(--color-on-error-container)" />
            <text class={cx(styles.errorText)}>{msg()}</text>
          </row>
        )}
      </Show>

      <scroll class={cx(styles.scrollArea)}>
        <column class={cx(styles.scrollContent)}>
          <column class={cx(styles.card)}>
            <row class={cx(styles.cardRow)}>
              <column class={cx(styles.cardMeta)}>
                <text class={cx(styles.cardTitle)}>New tray icons</text>
                <text class={cx(styles.cardSubtitle)}>
                  Default placement for apps not listed below
                </text>
              </column>
              <box class={cx(styles.defaultActionSegmented)}>
                <M3SegmentedControl
                  ariaLabel="New tray icons"
                  compact
                  options={DEFAULT_ACTIONS}
                  value={traySettings().default_action}
                  onChange={next => setDefaultAction(next)}
                />
              </box>
            </row>
          </column>

          <column class={cx(styles.rulesCard)}>
            <row class={cx(styles.rulesHeader)}>
              <text class={cx(styles.sectionTitle)}>Application visibility</text>
              <text data-tabular="true" class={cx(styles.rulesCount)}>
                {`${Object.keys(traySettings().rules).length} rules · ${runningCount()} running`}
              </text>
            </row>

            <For
              each={rows()}
              keyed={row => row.rowKey}
              fallback={
                <text class={cx(styles.emptyText)}>
                  No active tray applications or saved rules.
                </text>
              }
            >
              {entry => {
                const effectiveRule = (): TrayItemRule => entry().savedRule ?? traySettings().default_action;
                return (
                  <row testId={`tray-rule-row-${entry().ruleKey ?? "transient"}`} class={cx(styles.ruleRow)}>
                    <TrayRuleIcon entry={entry()} />
                    <column class={cx(styles.ruleTextCol)}>
                      <text class={cx(styles.ruleLabel)}>{entry().label}</text>
                      <text class={cx(styles.ruleSubtitle)}>
                        {entry().subtitle}
                      </text>
                    </column>
                    <Show
                      when={!entry().imeManaged}
                      fallback={
                        <box testId="tray-rule-ime-badge" class={cx(styles.statusBadge)}>
                          <text class={cx(styles.statusBadgeText)}>
                            Managed by IME
                          </text>
                        </box>
                      }
                    >
                      <Show
                        when={entry().ruleKey}
                        fallback={
                          <box testId="tray-rule-transient-badge" class={cx(styles.statusBadge)}>
                            <text class={cx(styles.statusBadgeText)}>
                              Session-only (no stable ID)
                            </text>
                          </box>
                        }
                      >
                        {key => (
                          <row class={cx(styles.ruleControls)}>
                            <box class={cx(styles.itemRuleSegmented)}>
                              <M3SegmentedControl
                                ariaLabel={`Rule for ${entry().label}`}
                                compact
                                options={ITEM_RULE_OPTIONS.map(opt => ({
                                  ...opt,
                                  testId: `tray-rule-set-${key()}-${opt.id}`,
                                }))}
                                value={effectiveRule()}
                                onChange={next => setAppRule(key(), next)}
                              />
                            </box>
                            <Show when={entry().savedRule !== null}>
                              <M3Button
                                testId={`tray-rule-reset-${key()}`}
                                variant="text"
                                size="sm"
                                onClick={() => clearAppRule(key())}
                              >
                                <text class={cx(styles.resetText)}>Reset</text>
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

      <row class={cx(styles.footerRow)}>
        <text class={cx(styles.footerHint)}>
          Rules sync live to [bar.tray] in settings.toml
        </text>
        <M3Button
          testId="tray-rules-reset-all"
          variant="text"
          size="sm"
          disabled={isDefaultTray()}
          onClick={resetAllTrayRules}
        >
          <text class={cx(styles.resetAllText)}>Reset defaults</text>
        </M3Button>
      </row>
    </column>
  );
}
