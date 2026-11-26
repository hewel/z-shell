import { Button, For, Image, LayerSurface, Show, createEffect, createMemo, createSignal, mountStylesheet, onCleanup, type Accessor, type NativeChild, type NativeNode } from "@hewel/zgui";
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

const primary = "var(--color-primary)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--surface-popover)";
const containerHigh = "var(--color-surface-container-high)";
const outline = "1px solid var(--border-popover)";
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
const pill = {
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  borderRadius: "10px", padding: "6px 10px", minHeight: "30px", fontSize: "12px", fontWeight: 500,
} as const;
const iconTile = { width: "40px", height: "40px", borderRadius: "10px", flexShrink: 0 } as const;
const previewFrame = {
  width: "100%", height: "120px", borderRadius: "12px", overflow: "hidden",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 42%, transparent)",
} as const;
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
    <row style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "10px", alignItems: "flex-start" }}>
      <box style={{ position: "relative", width: "40px", height: "40px", flexShrink: 0 }}>
        <Show when={leading.src()} fallback={
          <box testId={`toast-fallback-${toast().id}`} style={{
            ...iconTile, display: "flex", alignItems: "center", justifyContent: "center",
            backgroundColor: mediaLayout().fallbackKind === "image" ? primaryContainer : containerHigh,
          }}>
            <ShellIcon
              name={mediaLayout().fallbackKind === "image" ? "image" : "bell"}
              size={18}
              color={mediaLayout().fallbackKind === "image" ? onPrimaryContainer : primary}
            />
          </box>
        }>
          <box testId={`toast-icon-${toast().id}`} style={{ ...iconTile, overflow: "hidden" }}>
            <Image
              src={leading.src()}
              style={{
                width: "100%", height: "100%", borderRadius: "10px",
                objectFit: mediaLayout().leadingKind === "avatar" ? "cover" : "cover",
              }}
            />
          </box>
        </Show>
        <Show when={badge.src()}>
          <box
            testId={`toast-badge-${toast().id}`}
            style={{
              position: "absolute", right: "-3px", bottom: "-3px",
              width: "18px", height: "18px", borderRadius: "999px", "--zgui-corner-shape": "none",
              backgroundColor: container, border: `2px solid ${container}`,
              overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <Image src={badge.src()} style={{ width: "100%", height: "100%", borderRadius: "999px", "--zgui-corner-shape": "none", objectFit: "cover" }} />
          </box>
        </Show>
      </box>
      <column style={{ flexGrow: 1, minWidth: "0px", gap: "2px" }}>
        <text style={{ ...clipped, color: muted, fontSize: "11px" }}>{toast().app_name}</text>
        <text style={{ ...clipped, fontSize: "14px", fontWeight: 600 }}>{toast().summary}</text>
        <Show when={formattedBody()}>
          {body => (
            <text testId={`toast-body-${toast().id}`} class="notification-body" style={{ color: muted, fontSize: "12px", maxHeight: "56px", overflow: "hidden" }}>{body()}</text>
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
      style={{
        borderRadius: "22px", backgroundColor: container, border: outline, boxShadow: "var(--shadow-level-2)",
        padding: "14px", gap: "10px", color: onSurface,
        opacity: combinedOpacity(),
        transform: scheme() === "reduced"
          ? "none"
          : `translateX(${((1 - stackSpatial()) * 24).toFixed(2)}px) translateY(${((1 - cardReflow()) * flipDeltaY).toFixed(2)}px) scale(${(0.96 + stackSpatial() * 0.04).toFixed(4)})`,
        transformOrigin: "top right",
      }}
    >
      <row style={{ gap: "10px", alignItems: "flex-start" }}>
        {bodyContent()}
        <Show when={countValue() > 1 && onToggleGroup !== undefined}>
          <M3CardAction style={{ flexShrink: 0 }}>
            <Button
              testId={`toast-group-toggle-${toast().id}`}
              ariaLabel={expandedValue()
                ? `Collapse notifications from ${toast().app_name || "app"}`
                : `Expand ${countValue() - 1} more notifications from ${toast().app_name || "app"}`}
              expanded={expandedValue()}
              style={{
                display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: "2px",
                height: "28px", minHeight: "28px", padding: "0 8px",
                borderRadius: "8px",
                backgroundColor: primaryContainer, color: onPrimaryContainer,
              }}
              onClick={() => onToggleGroup?.()}
            >
              <text
                data-tabular="true"
                style={{ fontSize: "11px", lineHeight: "14px", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
              >
                {expandedValue() ? `${countValue()}` : `+${countValue() - 1}`}
              </text>
              <ShellIcon name={expandedValue() ? "expandLess" : "expandMore"} size={14} color={onPrimaryContainer} />
            </Button>
          </M3CardAction>
        </Show>
        <M3CardAction style={{ flexShrink: 0 }}>
          <Button
            ariaLabel={!expandedValue() && countValue() > 1 ? `Dismiss all notifications from ${toast().app_name || "app"}` : "Dismiss notification"}
            testId={`toast-dismiss-${toast().id}`}
            style={{ ...pill, borderRadius: "999px", "--zgui-corner-shape": "none", padding: "0", width: "28px", minHeight: "28px", backgroundColor: containerHigh, color: muted }}
            onClick={() => {
              if (!expandedValue() && countValue() > 1 && onDismissGroup) {
                onDismissGroup();
              } else {
                void invokePublic("notifications.dismiss", { id: toast().id });
              }
            }}
          >
            <ShellIcon name="close" size={14} color={muted} />
          </Button>
        </M3CardAction>
      </row>
      <Show when={preview.src()}>
        <box testId={`toast-attachment-${toast().id}`} style={previewFrame}>
          <Image src={preview.src()} style={{ width: "100%", height: "100%", borderRadius: "12px", objectFit: "cover" }} />
        </box>
      </Show>
      <Show when={actions().buttonActions.length > 0}>
        <row style={{ flexWrap: "wrap", gap: "8px" }}>
          <For each={actions().buttonActions} keyed={action => action.key}>
            {action => (
              <M3CardAction style={{ flexGrow: 1, flexBasis: "0px", minWidth: "0px" }}>
                <Button testId={`toast-action-${toast().id}-${action().key}`}
                  style={{
                    ...pill, width: "100%",
                    backgroundColor: "var(--color-secondary-container)", color: "var(--color-on-secondary-container)",
                  }}
                  onClick={() => { void invokePublic("notifications.invoke-action", { id: toast().id, action_key: action().key }); }}>
                  <text style={clipped}>{action().label}</text>
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
  mountStylesheet("z-shell-toast-deck", `
    .toast-deck-layer-1 {
      width: 92%;
      height: 8px;
      border-radius: 0 0 16px 16px;
      background-color: var(--color-surface-container);
      border-left: 1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent);
      border-right: 1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent);
    }
    .toast-deck-layer-2 {
      width: 84%;
      height: 6px;
      border-radius: 0 0 14px 14px;
      background-color: var(--color-surface-container-low);
      border-left: 1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent);
      border-right: 1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent);
    }
  `);
  const inputRef = trackedRef(track);
  return (
    <column
      ref={inputRef}
      testId={`toast-deck-peek-${headId}`}
      onClick={onExpand}
      style={{ width: "100%", alignItems: "center", gap: "0px" }}
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
        style={{ width: "100%", height: "100%", padding: "0px" }}
      >
        <scroll
          testId="toast-expanded-scroll"
          role="scrollView"
          ariaLabel="Active notifications"
          style={{ width: "100%", maxHeight: `${scrollMaxHeight()}px`, overflowY: "auto" }}
        >
          <column style={{ width: "100%", padding: "12px 14px 28px 22px", gap: "8px" }}>
            <For each={grouped().groups} keyed={group => group.appKey}>
              {(group, groupIndex) => {
                const head = () => group().items[0]!;
                const rest = () => group().items.slice(1);
                const isMulti = () => group().items.length > 1;
                const isExpanded = () => isMulti() && expandedKeys().includes(group().appKey);
                return (
                  <column testId={`toast-group-${head().id}`} style={{ width: "100%", gap: "0px" }}>
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
                      <column style={{ width: "100%", gap: "8px", paddingTop: "8px" }}>
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
