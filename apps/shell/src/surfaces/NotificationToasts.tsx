import { Button, For, Image, LayerSurface, Show, createEffect, createMemo, createSignal, mountStylesheet, onCleanup, type Accessor, type NativeChild, type NativeNode } from "@hewel/zgui";
import { M3CardAction, M3InteractiveCard } from "@z-shell/sdk/primitives";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { SUPERELLIPSE_EXPONENT, createRoundedBlurGroup, type RoundedBlurGroup } from "../blur.ts";
import { ShellIcon } from "../icons.tsx";
import { createEnterProgress, createOpacityEnter, createPresence, createRetainedPresence, useMotionScheme, type M3Spring } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { resolveNotificationMediaLayout, splitNotificationActions, type NotificationItem } from "../topics.ts";

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
  onCleanup(() => detach?.());
  return node => { detach = track(node); };
}

function ToastCard({ toast, track, blur, stackSpatial, stackOpacity, promoted, staggerIndex = 0 }: {
  toast: Accessor<NotificationItem>;
  track: TrackNode;
  blur: RoundedBlurGroup;
  stackSpatial: M3Spring;
  stackOpacity: M3Spring;
  promoted: boolean;
  staggerIndex?: number;
}): NativeChild {
  const { hostClient, invokePublic } = useShellStore();
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
        <Show when={toast().body}>
          <text style={{ color: muted, fontSize: "12px", maxHeight: "56px", overflow: "hidden" }}>{toast().body}</text>
        </Show>
      </column>
    </row>
  );

  const inputRef = trackedRef(track);
  const blurRef = blur.useTarget(22);

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
        <M3CardAction style={{ flexShrink: 0 }}>
          <Button ariaLabel="Dismiss notification" testId={`toast-dismiss-${toast().id}`}
            style={{ ...pill, borderRadius: "999px", "--zgui-corner-shape": "none", padding: "0", width: "28px", minHeight: "28px", backgroundColor: containerHigh, color: muted }}
            onClick={() => { void invokePublic("notifications.dismiss", { id: toast().id }); }}>
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

function ToastDeckPeek({ count, track, onExpand }: {
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
      testId="toast-deck-peek"
      onClick={onExpand}
      style={{ width: "100%", alignItems: "center", gap: "0px" }}
    >
      <box ariaHidden testId="toast-deck-layer-1" class="toast-deck-layer-1" />
      <Show when={count >= 3}>
        <box ariaHidden testId="toast-deck-layer-2" class="toast-deck-layer-2" />
      </Show>
    </column>
  );
}

function ToastFooter({ count, next, track, blur, inert, progress, opacity, onExpand }: {
  count: number;
  next: NotificationItem;
  track: TrackNode;
  blur: RoundedBlurGroup;
  inert: boolean;
  progress: M3Spring;
  opacity: M3Spring;
  onExpand: () => void;
}): NativeChild {
  const { invokePublic } = useShellStore();
  const scheme = useMotionScheme();
  const inputRef = trackedRef(track);
  const blurRef = blur.useTarget(16);
  const nextLabel = () => (next.app_name ? `${next.app_name} · ${next.summary}` : next.summary);
  return (
    <M3InteractiveCard
      layout="row"
      ref={node => { inputRef(node); blurRef(node); }}
      testId="toast-more-footer"
      actionTestId="toast-expand-toggle"
      ariaLabel={`Show ${count - 1} more notifications`}
      inert={inert}
      onClick={onExpand}
      style={{
        borderRadius: "16px", backgroundColor: container, border: outline, boxShadow: "var(--shadow-level-2)",
        padding: "6px 10px", gap: "8px", alignItems: "center",
        opacity: Math.max(0, Math.min(1, opacity())),
        transform: scheme() === "reduced" ? "none" : `translateY(${((1 - progress()) * 10).toFixed(2)}px)`,
      }}
    >
      <row style={{
        alignItems: "center", justifyContent: "center", gap: "3px", flexShrink: 0,
        height: "24px", padding: "0 8px", borderRadius: "999px", "--zgui-corner-shape": "none",
        backgroundColor: primaryContainer, color: onPrimaryContainer,
      }}>
        <text style={{ fontSize: "11px", lineHeight: "14px", fontWeight: 600 }}>+{count - 1} more</text>
        <ShellIcon name="expandMore" size={14} color={onPrimaryContainer} />
      </row>
      <text style={{ ...clipped, flexGrow: 1, color: muted, fontSize: "12px" }}>{nextLabel()}</text>
      <M3CardAction style={{ flexShrink: 0 }}>
        <Button testId="toast-clear-all" style={{ ...pill, minHeight: "24px", padding: "2px 8px", color: primary, fontSize: "11px" }}
          onClick={() => { void invokePublic("notifications.clear", {}); }}>
          <text>Clear all</text>
        </Button>
      </M3CardAction>
    </M3InteractiveCard>
  );
}

function ToastExpandedHeader({ count, track, blur, onCollapse }: {
  count: Accessor<number>;
  track: TrackNode;
  blur: RoundedBlurGroup;
  onCollapse: () => void;
}): NativeChild {
  const { invokePublic } = useShellStore();
  const inputRef = trackedRef(track);
  const blurRef = blur.useTarget(16);
  return (
    <row
      ref={node => { inputRef(node); blurRef(node); }}
      testId="toast-expanded-header"
      style={{
        borderRadius: "16px", backgroundColor: container, border: outline, boxShadow: "var(--shadow-level-2)",
        padding: "6px 10px", gap: "8px", alignItems: "center",
      }}
    >
      <Button
        testId="toast-collapse-toggle"
        ariaLabel="Show less notifications"
        onClick={onCollapse}
        style={{
          display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: "4px",
          flexShrink: 0, height: "26px", padding: "0 10px", borderRadius: "10px",
          backgroundColor: primaryContainer, color: onPrimaryContainer,
        }}
      >
        <ShellIcon name="expandLess" size={14} color={onPrimaryContainer} />
        <text style={{ fontSize: "11px", lineHeight: "14px", fontWeight: 600 }}>Show less</text>
      </Button>
      <text
        data-tabular="true"
        style={{
          ...clipped, flexGrow: 1, color: muted, fontFamily: "var(--font-mono)",
          fontSize: "11px", fontVariantNumeric: "tabular-nums",
        }}
      >
        {`${count()} active`}
      </text>
      <Button
        testId="toast-clear-all"
        style={{ ...pill, minHeight: "24px", padding: "2px 8px", color: primary, fontSize: "11px" }}
        onClick={() => { void invokePublic("notifications.clear", {}); }}
      >
        <text>Clear all</text>
      </Button>
    </row>
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
  const { settings, invokePublic } = useShellStore();
  const scheme = useMotionScheme();
  const [trackedNodes, setTrackedNodes] = createSignal<readonly NativeNode[]>([]);
  const [promoted, setPromoted] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);
  let lastHeadId: number | undefined;
  createEffect(() => popups()[0]?.id, headId => {
    if (lastHeadId !== undefined && headId !== undefined && headId !== lastHeadId) {
      setPromoted(true);
    }
    lastHeadId = headId;
  });
  createEffect(() => popups().length, len => {
    if (len <= 1 && expanded()) setExpanded(false);
  });

  // Pause daemon 5s auto-expiry whenever the user is hovering or viewing the expanded stack.
  let lastPaused = false;
  createEffect(() => visible() && (expanded() || hovered()), paused => {
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

  const [retainedFooter, setRetainedFooter] = createSignal<{ readonly count: number; readonly next: NotificationItem } | null>(null);
  createEffect(() => {
    const list = popups();
    return list.length > 1 && list[1] ? { count: list.length, next: list[1] } : null;
  }, entry => {
    if (entry) setRetainedFooter(entry);
  });
  const isExpandedStack = () => expanded() && popups().length > 1;
  const footerPresence = createPresence(() => popups().length > 1 && !expanded(), {
    scheme,
    enterRole: "fastSpatial",
    enterOpacityRole: "fastEffects",
    exitRole: "fastEffects",
  });
  const track: TrackNode = node => {
    setTrackedNodes(nodes => [...nodes, node]);
    return () => setTrackedNodes(nodes => nodes.filter(candidate => candidate !== node));
  };
  const blur = createRoundedBlurGroup(22, () => visible() && spatial.settled(), SUPERELLIPSE_EXPONENT);
  const topMargin = createMemo(() => {
    const bar = settings.data()?.bar;
    if (bar?.position && bar.position !== "top") return 14;
    return bar?.style === "docked" ? 48 : 58;
  });
  const surfaceHeight = createMemo(() =>
    isExpandedStack()
      ? Math.min(720, Math.max(456, Math.round(monitorHeight() - topMargin() - 20)))
      : 456,
  );
  const expandedScrollMaxHeight = createMemo(() => Math.max(240, surfaceHeight() - 78));

  return (
    <LayerSurface name="notification-toasts" output={output} layer="overlay" anchor={["top", "right"]}
      margin={{ top: Math.max(0, topMargin() - 12), right: 0 }} width={396} height={surfaceHeight()} keyboard="none"
      inputRegion={trackedNodes()} blurRegion={blur.region()}>
      <column
        inert={!visible()}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        style={{ width: "100%", height: "100%", padding: isExpandedStack() ? "12px 0 0 0" : "12px 14px 28px 22px", gap: "8px" }}
      >
        <Show
          when={isExpandedStack()}
          fallback={
            <>
              <column style={{ width: "100%", gap: "0px" }}>
                <Show when={popups()[0]?.id} keyed>
                  {_id => <ToastCard toast={() => popups()[0]!} track={track} blur={blur} stackSpatial={spatial} stackOpacity={opacity} promoted={promoted()} />}
                </Show>
                <Show when={popups().length > 1}>
                  <ToastDeckPeek count={popups().length} track={track} onExpand={() => setExpanded(true)} />
                </Show>
              </column>
              <Show when={footerPresence.mounted() && retainedFooter()}>
                {footer => (
                  <ToastFooter
                    count={footer().count}
                    next={footer().next}
                    track={track}
                    blur={blur}
                    inert={popups().length <= 1 || expanded()}
                    progress={footerPresence.progress}
                    opacity={footerPresence.opacity}
                    onExpand={() => setExpanded(true)}
                  />
                )}
              </Show>
            </>
          }
        >
          <box style={{ width: "100%", padding: "0 14px 0 22px", flexShrink: 0 }}>
            <ToastExpandedHeader
              count={() => popups().length}
              track={track}
              blur={blur}
              onCollapse={() => setExpanded(false)}
            />
          </box>
          <scroll
            testId="toast-expanded-scroll"
            role="scrollView"
            ariaLabel="Active notifications"
            style={{ width: "100%", maxHeight: `${expandedScrollMaxHeight()}px`, overflowY: "auto" }}
          >
            <column style={{ width: "100%", padding: "2px 14px 28px 22px", gap: "8px" }}>
              <For each={popups()} keyed={item => item.id}>
                {(item, index) => (
                  <ToastCard
                    toast={item}
                    track={track}
                    blur={blur}
                    stackSpatial={spatial}
                    stackOpacity={opacity}
                    promoted={false}
                    staggerIndex={index()}
                  />
                )}
              </For>
            </column>
          </scroll>
        </Show>
      </column>
    </LayerSurface>
  );
}

export function NotificationToasts(): NativeChild {
  const { activeMonitor, notifications } = useShellStore();
  const scheme = useMotionScheme();
  const dnd = () => notifications.data()?.dnd === true;
  const target = createMemo(() => {
    if (dnd()) return null;
    const popups = notifications.data()?.popups ?? [];
    const output = activeMonitor()?.id;
    return popups.length > 0 && output ? { output, popups } : null;
  });
  const presence = createRetainedPresence(target, {
    scheme,
    enterRole: "defaultSpatial",
    enterOpacityRole: "fastEffects",
    exitRole: "fastEffects",
    instantExit: dnd,
  });
  const monitorHeight = () => activeMonitor()?.height ?? 900;
  return (
    <Show when={presence.value()?.output} keyed>
      {output => (
        <ToastSurface
          output={output}
          monitorHeight={monitorHeight}
          popups={() => presence.value()?.popups ?? []}
          visible={presence.visible}
          spatial={presence.progress}
          opacity={presence.opacity}
        />
      )}
    </Show>
  );
}
