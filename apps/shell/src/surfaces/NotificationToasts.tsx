import { Button, For, Image, LayerSurface, Show, createMemo, createSignal, onCleanup, type Accessor, type NativeChild, type NativeNode } from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { createEnterProgress, createOpacityEnter, createRetainedPresence, useMotionScheme, type M3Spring } from "../motion.ts";
import { useShellStore } from "../store.ts";
import type { NotificationItem } from "../topics.ts";

const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const outline = "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)";
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
const pill = {
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  borderRadius: "10px", padding: "6px 10px", minHeight: "30px", fontSize: "12px", fontWeight: 500,
} as const;
const iconTile = { width: "36px", height: "36px", borderRadius: "10px", flexShrink: 0 } as const;
const notificationMedia = { fetchCommand: "notifications.fetch-blob" } as const;

type TrackNode = (node: NativeNode) => () => void;

function trackedRef(track: TrackNode): (node: NativeNode) => void {
  let detach: (() => void) | undefined;
  onCleanup(() => detach?.());
  return node => { detach = track(node); };
}

function ToastCard({ toast, track, stackSpatial, stackOpacity }: {
  toast: Accessor<NotificationItem>;
  track: TrackNode;
  stackSpatial: M3Spring;
  stackOpacity: M3Spring;
}): NativeChild {
  const { hostClient, invokePublic } = useShellStore();
  const icon = useDaemonMedia(hostClient, () => {
    const ref = toast().icon;
    return typeof ref === "string" ? null : ref;
  }, notificationMedia);
  const attachment = useDaemonMedia(hostClient, () => toast().attachment, notificationMedia);
  const scheme = useMotionScheme();
  const cardReflow = createEnterProgress("defaultSpatial", { scheme });
  const cardFade = createOpacityEnter("fastEffects", scheme);
  const combinedOpacity = () => Math.max(0, Math.min(1, cardFade() * stackOpacity()));

  return (
    <column ref={trackedRef(track)} testId={`toast-card-${toast().id}`} style={{
      borderRadius: "22px", backgroundColor: container, border: outline, boxShadow: "var(--shadow-level-2)",
      padding: "14px", gap: "10px", color: onSurface,
      opacity: combinedOpacity(),
      transform: scheme() === "reduced"
        ? "none"
        : `translateX(${((1 - stackSpatial()) * 24).toFixed(2)}px) translateY(${((1 - cardReflow()) * 14).toFixed(2)}px) scale(${(0.96 + stackSpatial() * 0.04).toFixed(4)})`,
      transformOrigin: "top right",
    }}>
      <row style={{ gap: "10px", alignItems: "flex-start" }}>
        <Show when={icon.src()} fallback={
          <box style={{ ...iconTile, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: containerHigh }}>
            <ShellIcon name="bell" size={18} color={primary} />
          </box>
        }>
          <Image src={icon.src()} style={{ ...iconTile, objectFit: "contain" }} />
        </Show>
        <column style={{ flexGrow: 1, minWidth: "0px", gap: "2px" }}>
          <text style={{ ...clipped, color: muted, fontSize: "11px" }}>{toast().app_name}</text>
          <text style={{ ...clipped, fontSize: "14px", fontWeight: 600 }}>{toast().summary}</text>
          <Show when={toast().body}>
            <text style={{ color: muted, fontSize: "12px", maxHeight: "56px", overflow: "hidden" }}>{toast().body}</text>
          </Show>
        </column>
        <Button ariaLabel="Dismiss notification" testId={`toast-dismiss-${toast().id}`}
          style={{ ...pill, padding: "0", width: "28px", minHeight: "28px", backgroundColor: containerHigh, color: muted }}
          onClick={() => { void invokePublic("notifications.dismiss", { id: toast().id }); }}>
          <ShellIcon name="close" size={14} color={muted} />
        </Button>
      </row>
      <Show when={attachment.src()}>
        <Image testId={`toast-attachment-${toast().id}`} src={attachment.src()}
          style={{ width: "100%", height: "96px", borderRadius: "10px", objectFit: "contain" }} />
      </Show>
      <Show when={toast().actions.length > 0}>
        <row style={{ flexWrap: "wrap", gap: "8px" }}>
          <For each={toast().actions} keyed={action => action.key}>
            {action => (
              <Button testId={`toast-action-${toast().id}-${action().key}`}
                style={{
                  ...pill, flexGrow: 1, flexBasis: "0px", minWidth: "0px",
                  backgroundColor: "var(--color-secondary-container)", color: "var(--color-on-secondary-container)",
                }}
                onClick={() => { void invokePublic("notifications.invoke-action", { id: toast().id, action_key: action().key }); }}>
                <text style={clipped}>{action().label}</text>
              </Button>
            )}
          </For>
        </row>
      </Show>
    </column>
  );
}

function ToastFooter({ count, next, track }: { count: number; next: NotificationItem; track: TrackNode }): NativeChild {
  const { invokePublic } = useShellStore();
  return (
    <row ref={trackedRef(track)} testId="toast-more-footer" style={{
      borderRadius: "16px", backgroundColor: container, border: outline, boxShadow: "var(--shadow-level-2)",
      padding: "6px 10px", gap: "8px", alignItems: "center",
    }}>
      <box style={{ ...pill, minHeight: "24px", padding: "2px 8px", backgroundColor: containerHigh, color: primary, fontSize: "11px" }}>
        <text>+{count - 1} more</text>
      </box>
      <text style={{ ...clipped, flexGrow: 1, color: muted, fontSize: "12px" }}>{next.summary}</text>
      <Button testId="toast-clear-all" style={{ ...pill, minHeight: "24px", padding: "2px 8px", color: primary, fontSize: "11px" }}
        onClick={() => { void invokePublic("notifications.clear", {}); }}>
        <text>Clear all</text>
      </Button>
    </row>
  );
}

function ToastSurface({ output, popups, spatial, opacity }: {
  output: string;
  popups: Accessor<readonly NotificationItem[]>;
  spatial: M3Spring;
  opacity: M3Spring;
}): NativeChild {
  const { settings } = useShellStore();
  const [trackedNodes, setTrackedNodes] = createSignal<readonly NativeNode[]>([]);
  const track: TrackNode = node => {
    setTrackedNodes(nodes => [...nodes, node]);
    return () => setTrackedNodes(nodes => nodes.filter(candidate => candidate !== node));
  };
  const topMargin = createMemo(() => {
    const bar = settings.data()?.bar;
    if (bar?.position && bar.position !== "top") return 14;
    return bar?.style === "docked" ? 48 : 58;
  });

  return (
    <LayerSurface name="notification-toasts" output={output} layer="overlay" anchor={["top", "right"]}
      margin={{ top: Math.max(0, topMargin() - 12), right: 0 }} width={396} height={456} keyboard="none" inputRegion={trackedNodes()}>
      <column style={{ width: "100%", padding: "12px 14px 28px 22px", gap: "8px" }}>
        <Show when={popups()[0]?.id} keyed>
          {_id => <ToastCard toast={() => popups()[0]!} track={track} stackSpatial={spatial} stackOpacity={opacity} />}
        </Show>
        <Show when={popups()[1]}>{next => <ToastFooter count={popups().length} next={next()} track={track} />}</Show>
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
  return (
    <Show when={presence.value()?.output} keyed>
      {output => (
        <ToastSurface
          output={output}
          popups={() => presence.value()?.popups ?? []}
          spatial={presence.progress}
          opacity={presence.opacity}
        />
      )}
    </Show>
  );
}
