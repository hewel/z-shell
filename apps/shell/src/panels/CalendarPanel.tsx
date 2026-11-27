import { Button, For, Image, Show, createDelay, createMemo, createSignal, cx, type Accessor } from "@hewel/zgui";
import { M3Button, M3CardAction, M3InteractiveCard } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { invokeNotificationAction } from "../activation.ts";
import { ShellIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { PANEL_MAX_HEIGHTS, buildMonthCalendarGrid, formatBarClock, formatFullDate, formatMonthYear, formatNotificationBody, resolveNotificationMediaLayout, splitNotificationActions, type NotificationItem } from "../topics.ts";
import styles from "./CalendarPanel.module.css";

const primary = "var(--color-primary)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const rowStarts = [0, 7, 14, 21, 28, 35] as const;

function NotificationRow(props: { item: Accessor<NotificationItem> }) {
  const { hostClient, invokePublic } = useShellStore();
  const mediaLayout = createMemo(() => resolveNotificationMediaLayout(props.item()));
  const leading = useDaemonMedia(hostClient, () => mediaLayout().leadingMedia, { fetchCommand: "notifications.fetch-blob" });
  const badge = useDaemonMedia(hostClient, () => mediaLayout().appBadge, { fetchCommand: "notifications.fetch-blob" });
  const preview = useDaemonMedia(hostClient, () => mediaLayout().previewBanner, { fetchCommand: "notifications.fetch-blob" });
  const actions = createMemo(() => splitNotificationActions(props.item().actions));
  const formattedBody = createMemo(() => formatNotificationBody(props.item().body));

  const bodyContent = () => (
    <row class={styles.notifBodyMain}>
      <box testId={`cal-notif-leading-${props.item().id}`} class={styles.notifLeadingWrap}>
        <Show when={leading.src()} fallback={
          <box
            testId={`cal-notif-fallback-${props.item().id}`}
            class={cx(styles.imageTile, styles.notifFallback)}
            data-kind={mediaLayout().fallbackKind}
          >
            <ShellIcon
              name={mediaLayout().fallbackKind === "image" ? "image" : "bell"}
              size={17}
              color={mediaLayout().fallbackKind === "image" ? onPrimaryContainer : primary}
            />
          </box>
        }>
          <box class={cx(styles.imageTile, styles.notifAvatarWrap)}>
            <Image
              testId={`cal-notif-avatar-${props.item().id}`}
              src={leading.src()}
              class={styles.notifAvatarImg}
            />
          </box>
        </Show>
        <Show when={badge.src()}>
          <box testId={`cal-notif-badge-${props.item().id}`} class={styles.notifAppBadge}>
            <Image src={badge.src()} class={styles.notifAppBadgeImg} />
          </box>
        </Show>
      </box>
      <column class={styles.notifTextCol}>
        <text class={styles.notifAppName}>{props.item().app_name}</text>
        <text class={styles.notifSummary}>{props.item().summary}</text>
        <Show when={formattedBody()}>
          {body => (
            <text testId={`cal-notif-body-${props.item().id}`} class={cx(styles.notifBody, "notification-body")}>{body()}</text>
          )}
        </Show>
      </column>
    </row>
  );

  return (
    <M3InteractiveCard
      layout="column"
      testId={`cal-notif-${props.item().id}`}
      actionTestId={`cal-notif-default-${props.item().id}`}
      ariaLabel={actions().defaultAction ? (actions().defaultAction!.label.trim() || `Open ${props.item().summary || props.item().app_name}`) : null}
      onClick={actions().defaultAction
        ? () => {
            const def = actions().defaultAction;
            if (def) void invokeNotificationAction(invokePublic, props.item(), def.key);
          }
        : undefined}
      class={styles.notifCard}
    >
      <row class={styles.notifRow}>
        {bodyContent()}
        <M3CardAction class={styles.notifActionWrap}>
          <Button
            testId={`cal-notif-dismiss-${props.item().id}`}
            ariaLabel="Dismiss notification"
            class={cx(styles.pill, styles.iconBtn)}
            onClick={() => { void invokePublic("notifications.dismiss", { id: props.item().id }); }}
          >
            <ShellIcon name="close" size={14} color={muted} />
          </Button>
        </M3CardAction>
      </row>
      <Show when={preview.src()}>
        <box testId={`cal-notif-preview-${props.item().id}`} class={styles.notifPreviewFrame} data-fit={mediaLayout().previewFit}>
          <Image src={preview.src()} class={styles.notifPreviewImg} data-fit={mediaLayout().previewFit} />
        </box>
      </Show>
      <Show when={actions().buttonActions.length > 0}>
        <row class={styles.notifActionsRow}>
          <For each={actions().buttonActions} keyed={action => action.key}>
            {action => (
              <M3CardAction>
                <Button
                  testId={`cal-notif-action-${props.item().id}-${action().key}`}
                  class={cx(styles.pill, styles.notifActionBtn)}
                  onClick={() => {
                    void invokeNotificationAction(invokePublic, props.item(), action().key);
                  }}
                >
                  <text>{action().label}</text>
                </Button>
              </M3CardAction>
            )}
          </For>
        </row>
      </Show>
    </M3InteractiveCard>
  );
}

export function CalendarPanel() {
  const { notifications, invokePublic } = useShellStore();
  const initialNow = Date.now();
  const [nowMs, setNowMs] = createSignal(initialNow);
  const initialDate = new Date(initialNow);
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

  const clockDelay = createDelay();
  const tick = () => {
    const now = Date.now();
    setNowMs(now);
    clockDelay.schedule(1_000 - (now % 1_000), tick);
  };
  clockDelay.schedule(1_000 - (initialNow % 1_000), tick);

  function moveMonth(offset: number) {
    const date = new Date(viewYear(), viewMonth() + offset, 1);
    setViewYear(date.getFullYear());
    setViewMonth(date.getMonth());
  }

  return (
    <column testId="panel-calendar" class={styles.panel} style={{ maxHeight: `${PANEL_MAX_HEIGHTS.calendar}px` }}>
      <column class={styles.topSection}>
        <row class={styles.clockHeaderRow}>
          <column class={styles.clockCol}>
            <row class={styles.clockRow}>
              <text testId="cal-clock-hm" class={styles.clockHm}>
                {`${clock().hours}:${clock().minutes}`}
              </text>
              <text data-tabular="true" class={styles.clockSeconds}>
                {clock().seconds}
              </text>
            </row>
            <text class={styles.dateText}>{formatFullDate(midnight())}</text>
          </column>
          <Button
            testId="cal-dnd-toggle"
            checked={dnd()}
            class={styles.dndToggle}
            data-active={dnd() ? "true" : "false"}
            onClick={() => { void invokePublic("notifications.set-dnd", { dnd: !dnd() }); }}
          >
            <ShellIcon name="sleep" size={14} color={dnd() ? onPrimaryContainer : onSurface} />
            <text>Do Not Disturb</text>
          </Button>
        </row>
        <column class={styles.calendarCard}>
          <row class={styles.monthHeaderRow}>
            <text testId="cal-month-title" class={styles.monthTitle}>
              {formatMonthYear(viewYear(), viewMonth())}
            </text>
            <Button
              testId="cal-today"
              class={cx(styles.pill, styles.todayBtn)}
              onClick={() => {
                setViewYear(today().getFullYear());
                setViewMonth(today().getMonth());
              }}
            >
              <text>Today</text>
            </Button>
            <Button testId="cal-prev-month" ariaLabel="Previous month" class={cx(styles.pill, styles.iconBtn)} onClick={() => moveMonth(-1)}>
              <ShellIcon name="chevronLeft" size={14} />
            </Button>
            <Button testId="cal-next-month" ariaLabel="Next month" class={cx(styles.pill, styles.iconBtn)} onClick={() => moveMonth(1)}>
              <ShellIcon name="chevronRight" size={14} />
            </Button>
          </row>
          <column class={styles.calendarGrid}>
            <row>
              <For each={weekdays} keyed={false}>{day => <box class={styles.gridCell}><text class={styles.weekdayLabel}>{day()}</text></box>}</For>
            </row>
            <For each={rowStarts} keyed={false}>
              {start => (
                <row>
                  <For each={weekdays} keyed={false}>
                    {(_, index) => {
                      const cell = () => grid()[start() + index]!;
                      return (
                        <box testId={cell().isToday ? "cal-today-cell" : null} class={styles.gridCell} data-muted={!cell().inMonth ? "true" : "false"}>
                          <box class={styles.dayBadge} data-today={cell().isToday ? "true" : "false"}>
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
        <box ariaHidden class={styles.divider} />
        <row class={styles.notifHeaderRow}>
          <text class={styles.notifHeading}>Notifications</text>
          <text testId="cal-notif-count" data-tabular="true" class={styles.notifCount}>
            {history().length}
          </text>
          <M3Button
            testId="cal-clear-all"
            variant="text"
            size="sm"
            class={styles.clearAllBtn}
            onClick={() => { void invokePublic("notifications.clear", {}); }}
          >
            <text>Clear all</text>
          </M3Button>
        </row>
      </column>
      <scroll testId="cal-notif-scroll" role="scrollView" ariaLabel="Notifications list" class={styles.notifScroll}>
        <column class={styles.notifList}>
          <Show when={history().length > 0} fallback={
            <column testId="cal-notif-empty" class={styles.notifEmpty}>
              <ShellIcon name="bell" size={22} color={muted} />
              <text class={styles.notifEmptyTitle}>All caught up</text>
              <text class={styles.notifEmptySubtitle}>No unread notifications</text>
            </column>
          }>
            <For each={history()} keyed={item => item.id}>{item => <NotificationRow item={item} />}</For>
          </Show>
        </column>
      </scroll>
    </column>
  );
}
