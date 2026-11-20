import { Button, For, Image, LayerSurface, Show, createSignal, onCleanup, type Accessor, type NativeChild, type NativeNode } from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShojiIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import type { NotificationItem } from "../topics.ts";

const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const container = "var(--color-surface-container)";
const containerHigh = "var(--color-surface-container-high)";
const outline = "1px solid var(--color-outline-variant)";
const clipped = { minWidth: "0px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
const pill = {
  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  borderRadius: "999px", padding: "4px 10px", minHeight: "26px", fontSize: "12px",
} as const;
const iconTile = { width: "36px", height: "36px", borderRadius: "10px", flexShrink: 0 } as const;
const notificationMedia = { fetchCommand: "notifications.fetch-blob" } as const;

type TrackNode = (node: NativeNode) => () => void;

function trackedRef(track: TrackNode): (node: NativeNode) => void {
  let detach: (() => void) | undefined;
  onCleanup(() => detach?.());
  return node => { detach = track(node); };
}

function ToastCard({ toast, track }: { toast: Accessor<NotificationItem>; track: TrackNode }): NativeChild {
  const { hostClient, invokePublic } = useShellStore();
  const icon = useDaemonMedia(hostClient, () => {
    const ref = toast().icon;
    return typeof ref === "string" ? null : ref;
  }, notificationMedia);
  const attachment = useDaemonMedia(hostClient, () => toast().attachment, notificationMedia);

  return (
    <column ref={trackedRef(track)} testId={`toast-card-${toast().id}`} style={{
      borderRadius: "20px", backgroundColor: container, border: outline, padding: "14px", gap: "10px", color: onSurface,
    }}>
      <row style={{ gap: "10px", alignItems: "center" }}>
        <Show when={icon.src()} fallback={
          <box style={{ ...iconTile, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: containerHigh }}>
            <ShojiIcon name="bell" color={primary} />
          </box>
        }>
          <Image src={icon.src()} style={{ ...iconTile, "object-fit": "contain" }} />
        </Show>
        <column style={{ flexGrow: 1, minWidth: "0px", gap: "2px" }}>
          <text style={{ ...clipped, color: muted, fontSize: "11px" }}>{toast().app_name}</text>
          <text style={{ ...clipped, fontSize: "14px", fontWeight: 600 }}>{toast().summary}</text>
        </column>
        <Button ariaLabel="Dismiss notification" testId={`toast-dismiss-${toast().id}`}
          style={{ ...pill, padding: "0", width: "26px", backgroundColor: containerHigh, color: muted, fontSize: "16px" }}
          onClick={() => { void invokePublic("notifications.dismiss", { id: toast().id }); }}>
          <text>×</text>
        </Button>
      </row>
      <Show when={toast().body}>
        <text style={{ color: muted, fontSize: "13px", maxHeight: "72px", overflow: "hidden" }}>{toast().body}</text>
      </Show>
      <Show when={attachment.src()}>
        <Image testId={`toast-attachment-${toast().id}`} src={attachment.src()}
          style={{ width: "100%", height: "96px", borderRadius: "12px", "object-fit": "contain" }} />
      </Show>
      <Show when={toast().actions.length > 0}>
        <scroll style={{ maxHeight: "96px" }}>
          <row style={{ flexWrap: "wrap", gap: "6px" }}>
            <For each={toast().actions} keyed={action => action.key}>
              {action => (
                <Button testId={`toast-action-${toast().id}-${action().key}`}
                  style={{ ...pill, maxWidth: "100%", backgroundColor: "var(--color-primary-container)", color: "var(--color-on-primary-container)" }}
                  onClick={() => { void invokePublic("notifications.invoke-action", { id: toast().id, action_key: action().key }); }}>
                  <text style={clipped}>{action().label}</text>
                </Button>
              )}
            </For>
          </row>
        </scroll>
      </Show>
    </column>
  );
}

function ToastFooter({ count, next, track }: { count: number; next: NotificationItem; track: TrackNode }): NativeChild {
  const { invokePublic } = useShellStore();
  return (
    <row ref={trackedRef(track)} testId="toast-more-footer" style={{
      borderRadius: "16px", backgroundColor: container, border: outline, padding: "6px 8px", gap: "8px", alignItems: "center",
    }}>
      <box style={{ ...pill, backgroundColor: containerHigh, color: primary }}><text>+{count - 1} more</text></box>
      <text style={{ ...clipped, flexGrow: 1, color: muted, fontSize: "12px" }}>{next.summary}</text>
      <Button testId="toast-clear-all" style={{ ...pill, color: primary }}
        onClick={() => { void invokePublic("notifications.clear", {}); }}>
        <text>Clear all</text>
      </Button>
    </row>
  );
}

function ToastSurface({ output, popups }: { output: string; popups: Accessor<readonly NotificationItem[]> }): NativeChild {
  const [trackedNodes, setTrackedNodes] = createSignal<readonly NativeNode[]>([]);
  const track: TrackNode = node => {
    setTrackedNodes(nodes => [...nodes, node]);
    return () => setTrackedNodes(nodes => nodes.filter(candidate => candidate !== node));
  };

  return (
    <LayerSurface name="notification-toasts" output={output} layer="overlay" anchor={["top", "right"]}
      margin={{ top: 64, right: 16 }} width={352} height={420} keyboard="none" inputRegion={trackedNodes()}>
      <column style={{ width: "100%", gap: "8px" }}>
        <Show when={popups()[0]}>{toast => <ToastCard toast={toast} track={track} />}</Show>
        <Show when={popups()[1]}>{next => <ToastFooter count={popups().length} next={next()} track={track} />}</Show>
      </column>
    </LayerSurface>
  );
}

export function NotificationToasts(): NativeChild {
  const { monitors, notifications } = useShellStore();
  const primaryMonitor = () => monitors()[0];
  const popups = () => notifications.data()?.popups ?? [];
  return (
    <Show when={!notifications.data()?.dnd && popups().length > 0 && primaryMonitor()?.id} keyed>
      {output => <ToastSurface output={output} popups={popups} />}
    </Show>
  );
}
