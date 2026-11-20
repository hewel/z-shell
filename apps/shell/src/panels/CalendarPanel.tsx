import { Button, For, Image, Show, createMemo, createSignal, onCleanup, type Accessor } from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShojiIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { buildMonthCalendarGrid, formatBarClock, formatFullDate, formatMonthYear, type NotificationItem } from "../topics.ts";
import { SystemTelemetryCards } from "./BatteryPanel.tsx";

const primary = "var(--color-primary)";
const onPrimary = "var(--color-on-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const card = { borderRadius: "20px", backgroundColor: container, padding: "12px", gap: "8px" } as const;
const pill = { display: "flex", borderRadius: "16px", minHeight: "30px", padding: "4px 9px", flexShrink: 0, alignItems: "center", justifyContent: "center", backgroundColor: containerHigh } as const;
const imageTile = { width: "30px", height: "30px", borderRadius: "8px", flexShrink: 0 } as const;
const iconImage = { ...imageTile, "object-fit": "contain" } as const;
const attachmentImage = { width: "100%", height: "96px", borderRadius: "8px", "object-fit": "contain" } as const;
const gridCell = { display: "flex", flexBasis: "0px", flexGrow: 1, minWidth: "0px", height: "28px", alignItems: "center", justifyContent: "center" } as const;
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

  return (
    <row testId={`cal-notif-${item().id}`} style={{ ...card, borderRadius: "16px", alignItems: "flex-start" }}>
      <Show when={icon.src()} fallback={
        <box style={{ ...imageTile, display: "flex", backgroundColor: containerHigh, alignItems: "center", justifyContent: "center" }}>
          <ShojiIcon name="bell" color={primary} />
        </box>
      }>
        <Image src={icon.src()} style={iconImage} />
      </Show>
      <column style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "4px" }}>
        <text style={{ color: muted, fontSize: "11px" }}>{item().app_name}</text>
        <text style={{ fontWeight: 600 }}>{item().summary}</text>
        <Show when={item().body}><text style={{ color: muted }}>{item().body}</text></Show>
        <Show when={attachment.src()}>
          <Image src={attachment.src()} style={attachmentImage} />
        </Show>
        <Show when={item().actions.length > 0}>
          <row style={{ flexWrap: "wrap", gap: "4px" }}>
            <For each={item().actions} keyed={action => action.key}>
              {action => (
                <Button testId={`cal-notif-action-${item().id}-${action().key}`}
                  style={{ ...pill, backgroundColor: "var(--color-primary-container)", color: "var(--color-on-primary-container)" }}
                  onClick={() => { void invokePublic("notifications.invoke-action", { id: item().id, action_key: action().key }); }}>
                  <text>{action().label}</text>
                </Button>
              )}
            </For>
          </row>
        </Show>
      </column>
      <Button testId={`cal-notif-dismiss-${item().id}`} ariaLabel="Dismiss notification" style={pill}
        onClick={() => { void invokePublic("notifications.dismiss", { id: item().id }); }}>
        <text>×</text>
      </Button>
    </row>
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
    <scroll testId="panel-calendar" style={{ width: "100%", height: "100%", maxHeight: "calc(100vh - 2px)", overflow: "auto", backgroundColor: "var(--color-surface)", color: onSurface, fontFamily: "system-ui", fontSize: "13px" }}>
      <column style={{ padding: "16px", gap: "12px", flexDirection: "column" }}>
        <row style={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
          <column style={{ gap: "2px" }}>
            <row style={{ alignItems: "baseline", gap: "4px" }}>
              <text style={{ fontSize: "34px", fontWeight: 600, color: primary }}>{`${clock().hours}:${clock().minutes}`}</text>
              <text style={{ fontSize: "16px", color: muted }}>{clock().seconds}</text>
            </row>
            <text style={{ color: muted }}>{formatFullDate(midnight())}</text>
          </column>
          <Button testId="cal-dnd-toggle" checked={dnd()} onClick={() => { void invokePublic("notifications.set-dnd", { dnd: !dnd() }); }}
            style={{ ...pill, flexDirection: "row", gap: "5px", backgroundColor: dnd() ? "var(--color-primary-container)" : containerHigh,
              color: dnd() ? "var(--color-on-primary-container)" : onSurface }}>
            <ShojiIcon name={dnd() ? "bellOff" : "bell"} size={14} color="currentColor" />
            <text>Do Not Disturb</text>
          </Button>
        </row>
        <column style={card}>
          <row style={{ alignItems: "center", gap: "6px" }}>
            <Button testId="cal-prev-month" ariaLabel="Previous month" style={pill} onClick={() => moveMonth(-1)}>
              <ShojiIcon name="chevronLeft" size={14} />
            </Button>
            <text testId="cal-month-title" style={{ flexGrow: 1, minWidth: "0px", fontWeight: 600 }}>{formatMonthYear(viewYear(), viewMonth())}</text>
            <Button testId="cal-today" style={pill} onClick={() => {
              setViewYear(today().getFullYear());
              setViewMonth(today().getMonth());
            }}><text>Today</text></Button>
            <Button testId="cal-next-month" ariaLabel="Next month" style={pill} onClick={() => moveMonth(1)}>
              <ShojiIcon name="chevronRight" size={14} />
            </Button>
          </row>
          <column style={{ gap: "2px" }}>
            <row>
              <For each={weekdays} keyed={false}>{day => <box style={gridCell}><text style={{ color: muted, fontSize: "11px" }}>{day()}</text></box>}</For>
            </row>
            <For each={rowStarts} keyed={false}>
              {start => (
                <row>
                  <For each={weekdays} keyed={false}>
                    {(_, index) => {
                      const cell = () => grid()[start() + index]!;
                      return (
                        <box testId={cell().isToday ? "cal-today-cell" : null} style={{ ...gridCell, opacity: cell().inMonth ? 1 : 0.4 }}>
                          <box style={{ display: "flex", width: "28px", height: "28px", borderRadius: "14px", alignItems: "center", justifyContent: "center",
                            backgroundColor: cell().isToday ? primary : "transparent", color: cell().isToday ? onPrimary : onSurface }}>
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
        <SystemTelemetryCards />
        <column style={{ gap: "8px" }}>
          <row style={{ alignItems: "center", gap: "8px" }}>
            <text style={{ fontSize: "16px", fontWeight: 600 }}>Notifications</text>
            <text testId="cal-notif-count" style={{ borderRadius: "10px", padding: "3px 7px", backgroundColor: "var(--color-secondary-container)", color: "var(--color-on-secondary-container)" }}>{history().length}</text>
            <Button testId="cal-clear-all" style={{ ...pill, marginLeft: "auto" }} onClick={() => { void invokePublic("notifications.clear", {}); }}>
              <text>Clear all</text>
            </Button>
          </row>
          <Show when={history().length > 0} fallback={<text style={{ color: muted, padding: "8px 0" }}>No notifications</text>}>
            <For each={history()} keyed={item => item.id}>{item => <NotificationRow item={item} />}</For>
          </Show>
        </column>
      </column>
    </scroll>
  );
}
