import { Button, For, Image, LayerSurface, Show, createEffect, createMemo, createSignal, cx, onCleanup, type Accessor, type NativeChild, type NativeNode } from "@hewel/zgui";
import { M3CardAction, M3Collapsible, M3InteractiveCard } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { createEnterProgress, createOpacityEnter, createRetainedPresence, useMotionScheme, type M3Spring } from "../motion.ts";
import { usePinnedOutput, useShellStore } from "../store.ts";
import {
  formatNotificationBody,
  groupNotificationPopups,
  resolveMonitorLogicalSize,
  resolveNotificationMediaLayout,
  splitNotificationActions,
  type NotificationItem,
} from "../topics.ts";
import styles from "./NotificationToasts.module.css";

const notificationMedia = { fetchCommand: "notifications.fetch-blob" } as const;

type TrackNode = (node: NativeNode) => () => void;

function trackedRef(track: TrackNode): (node: NativeNode) => void {
  let detach: (() => void) | undefined;
  onCleanup(() => {
    detach?.();
    detach = undefined;
  });
  return node => {
    detach?.();
    detach = track(node);
  };
}

function ToastCard({
  toast,
  track,
  trackBlur,
  stackSpatial,
  stackOpacity,
  promoted,
  staggerIndex = 0,
  groupCount = 1,
  groupExpanded = false,
  onToggleGroup,
  onDismissGroup,
}: {
  toast: Accessor<NotificationItem>;
  track: TrackNode;
  trackBlur: TrackNode;
  stackSpatial: M3Spring;
  stackOpacity: M3Spring;
  promoted: boolean;
  staggerIndex?: number;
  groupCount?: Accessor<number> | number;
  groupExpanded?: Accessor<boolean> | boolean;
  onToggleGroup?: () => void;
  onDismissGroup?: () => void;
}): NativeChild {
  const { hostClient, invokePublic } = useShellStore();
  const countValue = () => (typeof groupCount === "function" ? groupCount() : groupCount);
  const expandedValue = () => (typeof groupExpanded === "function" ? groupExpanded() : groupExpanded);
  const mediaLayout = createMemo(() => resolveNotificationMediaLayout(toast()));
  const leading = useDaemonMedia(hostClient, () => mediaLayout().leadingMedia, notificationMedia);
  const badge = useDaemonMedia(hostClient, () => mediaLayout().appBadge, notificationMedia);
  const preview = useDaemonMedia(hostClient, () => mediaLayout().previewBanner, notificationMedia);
  const scheme = useMotionScheme();
  const cardReflow = createEnterProgress("defaultSpatial", { scheme });
  const cardFade = createOpacityEnter("fastEffects", scheme);
  const combinedOpacity = () => Math.max(0, Math.min(1, cardFade() * stackOpacity()));
  const flipDeltaY = propsOr(promoted, 44, 14 + Math.min(staggerIndex, 4) * 10);
  const actions = createMemo(() => splitNotificationActions(toast().actions));
  const formattedBody = createMemo(() => formatNotificationBody(toast().body));

  const bodyContent = () => (
    <row class={styles.bodyRow}>
      <box class={styles.iconWrapper}>
        <Show when={leading.src()} fallback={
          <box testId={`toast-fallback-${toast().id}`} data-kind={mediaLayout().fallbackKind} class={styles.iconFallback}>
            <ShellIcon
              name={mediaLayout().fallbackKind === "image" ? "image" : "bell"}
              size={18}
              color={mediaLayout().fallbackKind === "image" ? "var(--color-on-primary-container)" : "var(--color-primary)"}
            />
          </box>
        }>
          <box testId={`toast-icon-${toast().id}`} class={styles.iconBox}>
            <Image src={leading.src()} class={styles.leadingImage} />
          </box>
        </Show>
        <Show when={badge.src()}>
          <box testId={`toast-badge-${toast().id}`} class={styles.badgeBox}>
            <Image src={badge.src()} class={styles.badgeImage} />
          </box>
        </Show>
      </box>
      <column class={styles.textColumn}>
        <text class={styles.appName}>{toast().app_name}</text>
        <text class={styles.summary}>{toast().summary}</text>
        <Show when={formattedBody()}>
          {body => (
            <text testId={`toast-body-${toast().id}`} class={cx(styles.bodyText, "notification-body")}>{body()}</text>
          )}
        </Show>
      </column>
    </row>
  );

  const inputRef = trackedRef(track);
  const blurRef = trackedRef(trackBlur);

  return (
    <M3InteractiveCard
      layout="column"
      ref={node => { inputRef(node); blurRef(node); }}
      testId={`toast-card-${toast().id}`}
      actionTestId={`toast-default-${toast().id}`}
      ariaLabel={actions().defaultAction ? (actions().defaultAction!.label.trim() || `Open ${toast().summary || toast().app_name}`) : null}
      onClick={actions().defaultAction
        ? () => {
            const def = actions().defaultAction;
            if (def) void invokePublic("notifications.invoke-action", { id: toast().id, action_key: def.key });
          }
        : undefined}
      class={styles.toastCard}
      style={{
        opacity: combinedOpacity(),
        transform: scheme() === "reduced"
          ? "none"
          : `translateX(${((1 - stackSpatial()) * 24).toFixed(2)}px) translateY(${((1 - cardReflow()) * flipDeltaY).toFixed(2)}px) scale(${(0.96 + stackSpatial() * 0.04).toFixed(4)})`,
      }}
    >
      <row class={styles.topRow}>
        {bodyContent()}
        <Show when={countValue() > 1 && onToggleGroup !== undefined}>
          <M3CardAction class={styles.cardActionShrink}>
            <Button
              testId={`toast-group-toggle-${toast().id}`}
              ariaLabel={expandedValue()
                ? `Collapse notifications from ${toast().app_name || "app"}`
                : `Expand ${countValue() - 1} more notifications from ${toast().app_name || "app"}`}
              expanded={expandedValue()}
              class={styles.groupToggle}
              onClick={() => onToggleGroup?.()}
            >
              <text data-tabular="true" class={styles.groupToggleText}>
                {expandedValue() ? `${countValue()}` : `+${countValue() - 1}`}
              </text>
              <ShellIcon name={expandedValue() ? "expandLess" : "expandMore"} size={14} color="var(--color-on-primary-container)" />
            </Button>
          </M3CardAction>
        </Show>
        <M3CardAction class={styles.cardActionShrink}>
          <Button
            ariaLabel={!expandedValue() && countValue() > 1 ? `Dismiss all notifications from ${toast().app_name || "app"}` : "Dismiss notification"}
            testId={`toast-dismiss-${toast().id}`}
            class={styles.dismissButton}
            onClick={() => {
              if (!expandedValue() && countValue() > 1 && onDismissGroup) {
                onDismissGroup();
              } else {
                void invokePublic("notifications.dismiss", { id: toast().id });
              }
            }}
          >
            <ShellIcon name="close" size={14} color="var(--color-on-surface-variant)" />
          </Button>
        </M3CardAction>
      </row>
      <Show when={preview.src()}>
        <box testId={`toast-attachment-${toast().id}`} data-fit={mediaLayout().previewFit} class={styles.previewFrame}>
          <Image src={preview.src()} data-fit={mediaLayout().previewFit} class={styles.previewImage} />
        </box>
      </Show>
      <Show when={actions().buttonActions.length > 0}>
        <row class={styles.actionsRow}>
          <For each={actions().buttonActions} keyed={action => action.key}>
            {action => (
              <M3CardAction class={styles.actionSlot}>
                <Button
                  testId={`toast-action-${toast().id}-${action().key}`}
                  class={styles.actionButton}
                  onClick={() => { void invokePublic("notifications.invoke-action", { id: toast().id, action_key: action().key }); }}
                >
                  <text class={styles.clipped}>{action().label}</text>
                </Button>
              </M3CardAction>
            )}
          </For>
        </row>
      </Show>
    </M3InteractiveCard>
  );
}

function propsOr(cond: boolean, a: number, b: number): number {
  return cond ? a : b;
}

function ToastDeckPeek({ headId, count, track, onExpand }: {
  headId: number;
  count: number;
  track: TrackNode;
  onExpand: () => void;
}): NativeChild {
  const inputRef = trackedRef(track);
  return (
    <column
      ref={inputRef}
      testId={`toast-deck-peek-${headId}`}
      onClick={onExpand}
      class={styles.deckPeek}
    >
      <box ariaHidden testId={`toast-deck-layer-1-${headId}`} class="toast-deck-layer-1" />
      <Show when={count >= 3}>
        <box ariaHidden testId={`toast-deck-layer-2-${headId}`} class="toast-deck-layer-2" />
      </Show>
    </column>
  );
}

function ToastSurface({ output, monitorHeight, popups, visible, spatial, opacity }: {
  output: string;
  monitorHeight: Accessor<number>;
  popups: Accessor<readonly NotificationItem[]>;
  visible: Accessor<boolean>;
  spatial: M3Spring;
  opacity: M3Spring;
}): NativeChild {
  const { settings, publicClient, invokePublic } = useShellStore();
  const [trackedNodes, setTrackedNodes] = createSignal<readonly NativeNode[]>([]);
  const [blurNodes, setBlurNodes] = createSignal<readonly NativeNode[]>([]);
  const [promoted, setPromoted] = createSignal(false);
  const [expandedKeys, setExpandedKeys] = createSignal<readonly string[]>([]);
  const [hovered, setHovered] = createSignal(false);
  const grouped = createMemo(() => groupNotificationPopups(popups(), 3));

  let lastHeadId: number | undefined;
  createEffect(() => popups()[0]?.id, headId => {
    if (lastHeadId !== undefined && headId !== undefined && headId !== lastHeadId) {
      setPromoted(true);
    }
    lastHeadId = headId;
  });

  createEffect(() => grouped().groups.filter(group => group.items.length > 1).map(group => group.appKey), multiKeys => {
    setExpandedKeys(prev => {
      const next = prev.filter(key => multiKeys.includes(key));
      return next.length === prev.length ? prev : next;
    });
  });

  // Pause daemon 5s auto-expiry whenever the user is hovering or viewing any expanded app group.
  let lastPaused = false;
  createEffect(() => visible() && (expandedKeys().length > 0 || hovered()), paused => {
    if (paused === lastPaused) return;
    lastPaused = paused;
    void invokePublic("notifications.set-paused", { paused });
  });
  onCleanup(() => {
    if (!lastPaused) return;
    lastPaused = false;
    // Defer by a microtask so whole-app teardown lets ShellStoreProvider mark itself disposed first,
    // while live unmounts (e.g. monitor hotplug or DND) still resume the daemon countdown cleanly.
    queueMicrotask(() => {
      void invokePublic("notifications.set-paused", { paused: false });
    });
  });

  const toggleGroup = (appKey: string) => {
    setExpandedKeys(prev => (prev.includes(appKey) ? prev.filter(key => key !== appKey) : [...prev, appKey]));
  };

  const dismissGroup = async (items: readonly NotificationItem[]) => {
    const client = publicClient();
    if (client) {
      try {
        for (let offset = 0; offset < items.length; offset += 64) {
          const slice = items.slice(offset, offset + 64).map(item => ({ id: item.id, revision: item.revision }));
          await client.invokeCommand("notifications.dismiss-popups", [], { items: slice });
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        const isUnknownCommand =
          (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === -32601)
          || message.includes("unknown command")
          || message.includes("method not found");
        if (!isUnknownCommand) return;
      }
    }
    for (const item of items) {
      void invokePublic("notifications.dismiss", { id: item.id });
    }
  };

  let disposed = false;
  onCleanup(() => { disposed = true; });
  const track: TrackNode = node => {
    if (disposed) return () => {};
    setTrackedNodes(nodes => (nodes.includes(node) ? nodes : [...nodes, node]));
    return () => {
      if (disposed) return;
      setTrackedNodes(nodes => nodes.filter(candidate => candidate !== node));
    };
  };
  const trackBlur: TrackNode = node => {
    if (disposed) return () => {};
    setBlurNodes(nodes => (nodes.includes(node) ? nodes : [...nodes, node]));
    return () => {
      if (disposed) return;
      setBlurNodes(nodes => nodes.filter(candidate => candidate !== node));
    };
  };
  const topMargin = createMemo(() => {
    const bar = settings.data()?.bar;
    if (bar?.position && bar.position !== "top") return 14;
    return bar?.style === "docked" ? 48 : 58;
  });
  const anyExpanded = () => expandedKeys().length > 0;
  const surfaceHeight = createMemo(() =>
    anyExpanded() || grouped().groups.length > 1
      ? Math.min(760, Math.max(456, Math.round(monitorHeight() - topMargin() - 20)))
      : 456,
  );
  const scrollMaxHeight = createMemo(() => Math.max(240, surfaceHeight() - 12));

  return (
    <LayerSurface name="notification-toasts" output={output} layer="overlay" anchor={["top", "right"]}
      margin={{ top: Math.max(0, topMargin() - 12), right: 0 }} width={396} height={surfaceHeight()} keyboard="none"
      inputRegion={trackedNodes()} blurRegion={blurNodes().length > 0 ? blurNodes() : "none"}>
      <column
        inert={!visible()}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        class={styles.toastSurfaceRoot}
      >
        <scroll
          testId="toast-expanded-scroll"
          role="scrollView"
          ariaLabel="Active notifications"
          class={styles.scrollArea}
          style={{ maxHeight: `${scrollMaxHeight()}px` }}
        >
          <column class={styles.toastList}>
            <For each={grouped().groups} keyed={group => group.appKey}>
              {(group, groupIndex) => {
                const head = () => group().items[0]!;
                const rest = () => group().items.slice(1);
                const isMulti = () => group().items.length > 1;
                const isExpanded = () => isMulti() && expandedKeys().includes(group().appKey);
                return (
                  <column testId={`toast-group-${head().id}`} class={styles.toastGroup}>
                    <ToastCard
                      toast={head}
                      track={track}
                      trackBlur={trackBlur}
                      stackSpatial={spatial}
                      stackOpacity={opacity}
                      promoted={groupIndex() === 0 && promoted()}
                      groupCount={() => group().items.length}
                      groupExpanded={isExpanded}
                      onToggleGroup={() => toggleGroup(group().appKey)}
                      onDismissGroup={() => { void dismissGroup(group().items); }}
                    />
                    <Show when={isMulti() && !isExpanded()}>
                      <ToastDeckPeek
                        headId={head().id}
                        count={group().items.length}
                        track={track}
                        onExpand={() => toggleGroup(group().appKey)}
                      />
                    </Show>
                    <M3Collapsible open={isExpanded()} estimatedHeight={Math.max(84, rest().length * 96)}>
                      <column class={styles.expandedRest}>
                        <For each={rest()} keyed={item => item.id}>
                          {(item, itemIndex) => (
                            <ToastCard
                              toast={item}
                              track={track}
                              trackBlur={trackBlur}
                              stackSpatial={spatial}
                              stackOpacity={opacity}
                              promoted={false}
                              staggerIndex={itemIndex() + 1}
                            />
                          )}
                        </For>
                      </column>
                    </M3Collapsible>
                  </column>
                );
              }}
            </For>
          </column>
        </scroll>
      </column>
    </LayerSurface>
  );
}

export function NotificationToasts(): NativeChild {
  const { monitors, notifications, outputs } = useShellStore();
  const scheme = useMotionScheme();
  const dnd = () => notifications.data()?.dnd === true;
  const hasPopups = createMemo(() => !dnd() && (notifications.data()?.popups.length ?? 0) > 0);
  const pinnedOutput = usePinnedOutput(() => (hasPopups() ? true : null));
  const target = createMemo(() => {
    const output = pinnedOutput();
    const popups = notifications.data()?.popups;
    return output && popups?.length ? { output, popups } : null;
  });
  const presence = createRetainedPresence(target, {
    scheme,
    enterRole: "defaultSpatial",
    enterOpacityRole: "fastEffects",
    exitRole: "fastEffects",
    instantExit: dnd,
  });
  return (
    <Show when={presence.value()?.output} keyed>
      {output => {
        const monitorHeight = createMemo(() => {
          const monitor = monitors().find(candidate => candidate.id === output);
          return monitor ? resolveMonitorLogicalSize(monitor, outputs.data()).height : 900;
        });
        return (
          <ToastSurface
            output={output}
            monitorHeight={monitorHeight}
            popups={() => presence.value()?.popups ?? []}
            visible={presence.visible}
            spatial={presence.progress}
            opacity={presence.opacity}
          />
        );
      }}
    </Show>
  );
}
