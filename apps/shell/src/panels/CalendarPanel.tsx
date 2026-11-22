import { Button, For, Image, Show, createMemo, createSignal, onCleanup, type Accessor } from "@hewel/zgui";
import { M3Button } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { PANEL_MAX_HEIGHTS, buildMonthCalendarGrid, formatBarClock, formatFullDate, formatMonthYear, splitNotificationActions, type NotificationItem } from "../topics.ts";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const containerHighest = "var(--color-surface-container-highest)";
const card = { borderRadius: "16px", backgroundColor: containerHigh, padding: "12px", gap: "8px" } as const;
const pill = {
  display: "flex", borderRadius: "10px", minHeight: "30px", padding: "4px 10px",
  flexShrink: 0, alignItems: "center", justifyContent: "center", backgroundColor: containerHighest,
} as const;
const imageTile = { width: "32px", height: "32px", borderRadius: "8px", flexShrink: 0 } as const;
const iconImage = { ...imageTile, objectFit: "cover", overflow: "hidden" } as const;
const attachmentImage = { width: "100%", height: "84px", borderRadius: "8px", objectFit: "contain" } as const;
const gridCell = { display: "flex", flexBasis: "0px", flexGrow: 1, minWidth: "0px", height: "30px", alignItems: "center", justifyContent: "center" } as const;
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const rowStarts = [0, 7, 14, 21, 28, 35] as const;

function NotificationRow(props: { item: Accessor<NotificationItem> }) {
  const { hostClient, invokePublic } = useShellStore();
  const { item } = props;
  const icon = useDaemonMedia(hostClient, () => {
    const ref = item().icon;
    return typeof ref === "string" ? null : ref;
  }, { fetchCommand: "notifications.fetch-blob" });
  const attachment = useDaemonMedia(hostClient, () => item().attachment, { fetchCommand: "notifications.fetch-blob" });
  const actions = createMemo(() => splitNotificationActions(item().actions));

  const bodyContent = () => (
    <row style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "10px", alignItems: "flex-start" }}>
      <Show when={icon.src()} fallback={
        <box style={{ ...imageTile, display: "flex", backgroundColor: containerHighest, alignItems: "center", justifyContent: "center" }}>
          <ShellIcon name="bell" size={16} color={primary} />
        </box>
      }>
        <Image src={icon.src()} style={iconImage} />
      </Show>
      <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "3px" }}>
        <text style={{ color: muted, fontSize: "11px" }}>{item().app_name}</text>
        <text style={{ fontWeight: 600, fontSize: "13px" }}>{item().summary}</text>
        <Show when={item().body}><text style={{ color: muted, fontSize: "12px" }}>{item().body}</text></Show>
        <Show when={attachment.src()}>
          <Image src={attachment.src()} style={attachmentImage} />
        </Show>
      </column>
    </row>
  );

  return (
    <column testId={`cal-notif-${item().id}`} style={{
      borderRadius: "14px", backgroundColor: containerHigh, padding: "10px", gap: "8px",
    }}>
      <row style={{ gap: "10px", alignItems: "flex-start" }}>
        <Show when={actions().defaultAction} fallback={bodyContent()}>
          {defaultAction => (
            <Button
              testId={`cal-notif-default-${item().id}`}
              ariaLabel={defaultAction().label.trim() || `Open ${item().summary || item().app_name}`}
              onClick={() => { void invokePublic("notifications.invoke-action", { id: item().id, action_key: defaultAction().key }); }}
              style={{
                flexGrow: 1, flexBasis: "0px", minWidth: "0px", display: "flex", flexDirection: "row",
                alignItems: "flex-start", borderRadius: "10px", padding: "2px", margin: "-2px",
                backgroundColor: "transparent", color: onSurface, textAlign: "left",
              }}
            >
              {bodyContent()}
            </Button>
          )}
        </Show>
        <Button testId={`cal-notif-dismiss-${item().id}`} ariaLabel="Dismiss notification"
          style={{ ...pill, width: "28px", padding: "0px" }}
          onClick={() => { void invokePublic("notifications.dismiss", { id: item().id }); }}>
          <ShellIcon name="close" size={14} color={muted} />
        </Button>
      </row>
      <Show when={actions().buttonActions.length > 0}>
        <row style={{ flexWrap: "wrap", gap: "6px", paddingLeft: "42px" }}>
          <For each={actions().buttonActions} keyed={action => action.key}>
            {action => (
              <Button testId={`cal-notif-action-${item().id}-${action().key}`}
                style={{ ...pill, backgroundColor: "var(--color-secondary-container)", color: "var(--color-on-secondary-container)", fontSize: "11px" }}
                onClick={() => { void invokePublic("notifications.invoke-action", { id: item().id, action_key: action().key }); }}>
                <text>{action().label}</text>
              </Button>
            )}
          </For>
        </row>
      </Show>
    </column>
  );
}

export function CalendarPanel() {
  const { notifications, invokePublic } = useShellStore();
  const [nowMs, setNowMs] = createSignal(Date.now());
  const initialDate = new Date(nowMs());
  const [viewYear, setViewYear] = createSignal(initialDate.getFullYear());
  const [viewMonth, setViewMonth] = createSignal(initialDate.getMonth());
  const clock = createMemo(() => formatBarClock(nowMs(), { clock24h: true, clockSeconds: true }));
  const midnight = createMemo(() => new Date(nowMs()).setHours(0, 0, 0, 0));
  const today = createMemo(() => new Date(midnight()));
  const grid = createMemo(() => buildMonthCalendarGrid(viewYear(), viewMonth(), {
    year: today().getFullYear(), month: today().getMonth() + 1, day: today().getDate(),
  }));
  const dnd = () => notifications.data()?.dnd ?? false;
  const history = () => notifications.data()?.history ?? [];

  const tick = () => {
    const now = Date.now();
    setNowMs(now);
    timer = setTimeout(tick, 1_000 - (now % 1_000));
  };
  let timer = setTimeout(tick, 1_000 - (initialDate.getTime() % 1_000));
  onCleanup(() => clearTimeout(timer));

  function moveMonth(offset: number) {
    const date = new Date(viewYear(), viewMonth() + offset, 1);
    setViewYear(date.getFullYear());
    setViewMonth(date.getMonth());
  }

  return (
    <column testId="panel-calendar" style={{
      width: "100%", maxHeight: `${PANEL_MAX_HEIGHTS.calendar}px`, overflow: "hidden",
      padding: "14px", gap: "12px", flexDirection: "column",
      backgroundColor: container, color: onSurface, fontFamily: "var(--font-sans)", fontSize: "13px",
    }}>
      <column style={{ gap: "12px", flexShrink: 0 }}>
        <row style={{ alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
          <column style={{ gap: "2px" }}>
            <row style={{ alignItems: "baseline", gap: "4px" }}>
              <text testId="cal-clock-hm" style={{
                fontSize: "44px", fontWeight: 400, lineHeight: "50px", letterSpacing: "-0.02em",
                fontVariantNumeric: "tabular-nums", color: primary,
              }}>
                {`${clock().hours}:${clock().minutes}`}
              </text>
              <text data-tabular="true" style={{
                fontFamily: "var(--font-mono)", fontSize: "16px", color: muted, fontVariantNumeric: "tabular-nums",
              }}>
                {clock().seconds}
              </text>
            </row>
            <text style={{ color: muted, fontSize: "13px" }}>{formatFullDate(midnight())}</text>
          </column>
          <Button testId="cal-dnd-toggle" checked={dnd()} onClick={() => { void invokePublic("notifications.set-dnd", { dnd: !dnd() }); }}
            style={{
              ...pill, borderRadius: "10px", flexDirection: "row", gap: "6px", padding: "5px 11px",
              backgroundColor: dnd() ? "var(--color-primary-container)" : containerHigh,
              border: dnd() ? "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)" : "1px solid transparent",
              color: dnd() ? "var(--color-on-primary-container)" : onSurface, fontSize: "12px", fontWeight: 500,
            }}>
            <ShellIcon name="sleep" size={14} color="currentColor" />
            <text>Do Not Disturb</text>
          </Button>
        </row>
        <column style={card}>
          <row style={{ alignItems: "center", gap: "6px" }}>
            <text testId="cal-month-title" style={{ flexGrow: 1, minWidth: "0px", fontSize: "15px", fontWeight: 600 }}>
              {formatMonthYear(viewYear(), viewMonth())}
            </text>
            <Button testId="cal-today" style={{
              ...pill, backgroundColor: "var(--color-secondary-container)", color: "var(--color-on-secondary-container)",
              fontSize: "11px", fontWeight: 600,
            }} onClick={() => {
              setViewYear(today().getFullYear());
              setViewMonth(today().getMonth());
            }}><text>Today</text></Button>
            <Button testId="cal-prev-month" ariaLabel="Previous month" style={{ ...pill, width: "28px", padding: "0px" }} onClick={() => moveMonth(-1)}>
              <ShellIcon name="chevronLeft" size={14} />
            </Button>
            <Button testId="cal-next-month" ariaLabel="Next month" style={{ ...pill, width: "28px", padding: "0px" }} onClick={() => moveMonth(1)}>
              <ShellIcon name="chevronRight" size={14} />
            </Button>
          </row>
          <column style={{ gap: "2px" }}>
            <row>
              <For each={weekdays} keyed={false}>{day => <box style={gridCell}><text style={{ color: muted, fontSize: "11px", fontWeight: 500 }}>{day()}</text></box>}</For>
            </row>
            <For each={rowStarts} keyed={false}>
              {start => (
                <row>
                  <For each={weekdays} keyed={false}>
                    {(_, index) => {
                      const cell = () => grid()[start() + index]!;
                      return (
                        <box testId={cell().isToday ? "cal-today-cell" : null} style={{ ...gridCell, opacity: cell().inMonth ? 1 : 0.38 }}>
                          <box style={{
                            display: "flex", width: "28px", height: "28px", borderRadius: "10px", alignItems: "center", justifyContent: "center",
                            backgroundColor: cell().isToday ? primary : "transparent",
                            color: cell().isToday ? onPrimary : onSurface,
                            fontWeight: cell().isToday ? 600 : 400,
                            fontVariantNumeric: "tabular-nums",
                          }}>
                            <text>{cell().day}</text>
                          </box>
                        </box>
                      );
                    }}
                  </For>
                </row>
              )}
            </For>
          </column>
        </column>
        <box ariaHidden style={{ width: "100%", height: "1px", backgroundColor: "color-mix(in srgb, var(--color-outline-variant) 50%, transparent)" }} />
        <row style={{ alignItems: "center", gap: "8px" }}>
          <text style={{ fontSize: "15px", fontWeight: 600 }}>Notifications</text>
          <text testId="cal-notif-count" data-tabular="true" style={{
            borderRadius: "999px", "--zgui-corner-shape": "none", padding: "2px 8px", fontSize: "11px", fontWeight: 600,
            fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums",
            backgroundColor: "var(--color-secondary-container)", color: "var(--color-on-secondary-container)",
          }}>
            {history().length}
          </text>
          <M3Button
            testId="cal-clear-all"
            variant="text"
            size="sm"
            style={{ marginLeft: "auto" }}
            onClick={() => { void invokePublic("notifications.clear", {}); }}
          >
            <text>Clear all</text>
          </M3Button>
        </row>
      </column>
      <scroll testId="cal-notif-scroll" role="scrollView" ariaLabel="Notifications list" style={{
        flexGrow: 1, flexShrink: 1, minHeight: "0px", width: "100%", overflow: "hidden auto",
      }}>
        <column style={{ gap: "8px", paddingRight: "4px", paddingBottom: "2px" }}>
          <Show when={history().length > 0} fallback={
            <column testId="cal-notif-empty" style={{
              width: "100%", borderRadius: "14px", backgroundColor: containerHigh,
              padding: "24px 16px", alignItems: "center", justifyContent: "center", gap: "6px",
            }}>
              <ShellIcon name="bell" size={22} color={muted} />
              <text style={{ fontSize: "13px", fontWeight: 600, color: onSurface }}>All caught up</text>
              <text style={{ fontSize: "12px", color: muted }}>No unread notifications</text>
            </column>
          }>
            <For each={history()} keyed={item => item.id}>{item => <NotificationRow item={item} />}</For>
          </Show>
        </column>
      </scroll>
    </column>
  );
}
