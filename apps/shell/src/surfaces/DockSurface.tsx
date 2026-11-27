import {
  Button, For, Image, LayerSurface, Show, createDelay, createEffect, createMemo, createSignal, cx,
  type Accessor, type Monitor, type NativeChild, type NativeNode, type NativeWindowRect,
} from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { mintActivationToken, withActivationToken } from "../activation.ts";
import { ShellIcon } from "../icons.tsx";
import { SPRING_EPSILON, createM3Spring, useMotionScheme, type M3Spring } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { buildDockItems, formatSurfaceName, resolveMonitorLogicalSize, type DockEntry } from "../topics.ts";
import styles from "./DockSurface.module.css";

const tileSize = 46;
const dockGap = 8;
const dockPadding = 10;
const dockHeight = 60;
const dockBottomMargin = 10;
const dockLayerHeight = 112;
const triggerStripHeight = 8;
const autoHideDelayMs = 500;
const hiddenSlideOffset = dockHeight + dockBottomMargin + 18;
const tints = ["primary", "secondary", "tertiary"] as const;

function DockApp(props: { entry: Accessor<DockEntry> }) {
  const { hostClient, invokePublic, invokeHost } = useShellStore();
  const { src } = useDaemonMedia(hostClient, () => props.entry().icon, { fetchCommand: "launcher.fetch-blob" });
  const tint = createMemo(() => {
    let hash = 0;
    for (const char of props.entry().appId) hash = (Math.imul(31, hash) + char.codePointAt(0)!) >>> 0;
    return tints[hash % tints.length];
  });
  const initial = createMemo(() => {
    const label = props.entry().title.trim();
    const id = (label || props.entry().appId).replace(/\.desktop$/i, "");
    return String.fromCodePoint(id.codePointAt(id.lastIndexOf(".") + 1) ?? 0x3f).toUpperCase();
  });
  function activate() {
    const { appId, desktopId, windows } = props.entry();
    const window = windows[0];
    if (window) {
      void invokePublic("wayland.window.activate", { window_id: window.window_id });
      return;
    }
    const id = desktopId ?? appId;
    const tokenPromise = mintActivationToken(id);
    void tokenPromise.then(token =>
      invokePublic("apps.launch", withActivationToken({ id }, token)),
    );
  }
  function togglePin() {
    const { appId, pinned } = props.entry();
    void invokeHost("apps.pin", { id: appId, pinned: !pinned });
  }
  return (
    <column class={styles.tileStack}>
      <Button testId={`dock-${props.entry().pinned ? "app" : "running"}-${props.entry().appId}`} ariaLabel={props.entry().title}
        data-dock-item="true"
        onClick={activate}
        onPointerDown={event => {
          // Mouse secondary presses are pointer events; long presses emit contextmenu.
          if (event.button !== "secondary") return;
          event.preventDefault();
          togglePin();
        }}
        onContextMenu={event => {
          event.preventDefault();
          togglePin();
        }}
        class={styles.tileButton}>
        <box
          data-dock-visual="true"
          ariaHidden
          class={styles.tileVisual}
          data-tint={src() ? null : tint()}
        >
          <Show when={src()} fallback={
            <text class={styles.fallbackInitial}>
              {initial()}
            </text>
          }>
            {image => <Image ariaHidden src={image()} class={styles.tileIcon} />}
          </Show>
        </box>
      </Button>
      <row ariaHidden class={styles.dotsRow}>
        <Show when={!props.entry().focused}>
          <Show when={props.entry().pinned} fallback={<box class={cx(styles.dot, styles.dotUnpinned)} />}>
            <For each={props.entry().windows} keyed={window => window.window_id}>{() => <box class={styles.dot} />}</For>
          </Show>
        </Show>
      </row>
    </column>
  );
}

type DockSlot =
  | { readonly key: string; readonly kind: "app"; readonly entry: DockEntry }
  | { readonly key: string; readonly kind: "divider" };

function DockCapsule(props: {
  monitorId: string;
  slideProgress: M3Spring;
  animatedWidth: M3Spring;
  capsuleRef?: (node: NativeNode) => void;
  pinned: readonly DockEntry[];
  runningOnly: readonly DockEntry[];
}) {
  const { theme, togglePanel, dismissOverlay } = useShellStore();
  useShellTheme(theme.data);
  const scheme = useMotionScheme();
  const slots = createMemo<readonly DockSlot[]>(() => {
    const result: DockSlot[] = props.pinned.map(entry => ({ key: `pinned:${entry.appId}`, kind: "app", entry }));
    if (props.pinned.length > 0 && props.runningOnly.length > 0) {
      result.push({ key: "divider", kind: "divider" });
    }
    for (const entry of props.runningOnly) {
      result.push({ key: `running:${entry.appId}`, kind: "app", entry });
    }
    return result;
  });
  const focusedOffset = createMemo(() => {
    let x = 0;
    for (const slot of slots()) {
      if (slot.kind === "divider") {
        x += 1 + dockGap;
      } else {
        if (slot.entry.focused) return x + (tileSize - 16) / 2;
        x += tileSize + dockGap;
      }
    }
    return null;
  });
  const focusBarX = createM3Spring(() => focusedOffset() ?? 0, "fastSpatial", { scheme, epsilon: SPRING_EPSILON.px });
  const focusBarOpacity = createM3Spring(() => (focusedOffset() !== null ? 1 : 0), "fastEffects", { scheme });

  return (
    <row
      ref={props.capsuleRef}
      testId={`dock-root-${props.monitorId}`}
      role="toolbar"
      ariaLabel="Dock"
      onClick={() => dismissOverlay()}
      class={styles.capsule}
      style={{
        width: `${Math.round(props.animatedWidth())}px`,
        transform: `translateY(${(props.slideProgress() * hiddenSlideOffset).toFixed(2)}px)`,
        opacity: Math.max(0, Math.min(1, 1 - props.slideProgress() * 0.45)),
      }}
    >
      <column class={styles.tileStack}>
        <Button
          testId="dock-launcher"
          ariaLabel="Open launcher"
          data-dock-trigger="true"
          onClick={event => {
            event.stopPropagation();
            togglePanel("launcher", { monitorId: props.monitorId });
          }}
          class={styles.tileButton}
        >
          <box data-press-visual="compact" ariaHidden class={styles.launcherVisual}>
            <ShellIcon name="apps" size={20} color="var(--color-primary)" />
          </box>
        </Button>
      </column>
      <scroll class={styles.itemsScroll}>
        <row class={styles.itemsRow}>
          <box
            ariaHidden
            class={styles.focusPill}
            style={{
              opacity: Math.max(0, Math.min(1, focusBarOpacity())),
              transform: `translateX(${focusBarX().toFixed(2)}px)`,
            }}
          />
          <For each={slots()} keyed={slot => slot.key}>
            {slot => (
              <Show when={slot().kind === "app"} fallback={<box ariaHidden class={styles.divider} />}>
                <DockApp entry={() => (slot() as Extract<DockSlot, { readonly kind: "app" }>).entry} />
              </Show>
            )}
          </For>
        </row>
      </scroll>
    </row>
  );
}

function MonitorDock(props: {
  monitor: Accessor<Monitor>;
  pinned: Accessor<readonly DockEntry[]>;
  runningOnly: Accessor<readonly DockEntry[]>;
  idealWidth: Accessor<number>;
}): NativeChild {
  const { outputs } = useShellStore();
  const [hovered, setHovered] = createSignal(false);
  const [revealed, setRevealed] = createSignal(true);
  const hideDelay = createDelay();

  createEffect(hovered, isHovered => {
    hideDelay.cancel();
    if (isHovered) {
      setRevealed(true);
      return;
    }
    hideDelay.schedule(autoHideDelayMs, () => {
      setRevealed(false);
    });
  });

  const size = createMemo(() => resolveMonitorLogicalSize(props.monitor(), outputs.data()));
  const layerWidth = createMemo(() => Math.max(1, Math.round(size().width)));
  const capsuleWidth = createMemo(() => Math.max(1, Math.min(props.idealWidth(), layerWidth() - 32)));
  // Keep a full-width bottom-edge trigger strip active even while hidden; expand to the
  // dock capsule + bottom bridge only while revealed so windows behind remain click-through.
  const inputRegion = createMemo<readonly NativeWindowRect[]>(() => {
    const width = layerWidth();
    const edge: NativeWindowRect = {
      x: 0,
      y: dockLayerHeight - triggerStripHeight,
      width,
      height: triggerStripHeight,
    };
    if (!revealed()) return [edge];
    const capsuleRegionWidth = Math.min(width, Math.ceil(capsuleWidth()) + 16);
    const left = Math.max(0, Math.floor((width - capsuleRegionWidth) / 2));
    const top = Math.max(0, dockLayerHeight - dockHeight - dockBottomMargin - 12);
    return [
      { x: left, y: top, width: capsuleRegionWidth, height: dockLayerHeight - top },
      edge,
    ];
  });

  const scheme = useMotionScheme();
  const slideProgress = createM3Spring(() => (revealed() ? 0 : 1), "defaultSpatial", { scheme });
  const animatedWidth = createM3Spring(capsuleWidth, "defaultSpatial", { scheme, epsilon: SPRING_EPSILON.px });
  const [capsuleNode, setCapsuleNode] = createSignal<NativeNode | null>(null);

  return (
    <LayerSurface name={formatSurfaceName("dock", props.monitor().id)} output={props.monitor().id} layer="top"
      anchor={["bottom", "left", "right"]} margin={{ bottom: 0 }} width={layerWidth()} height={dockLayerHeight}
      exclusiveZone={0} keyboard="none" inputRegion={inputRegion()} blurRegion={capsuleNode() ? [capsuleNode()!] : "none"}>
      <box
        testId={`dock-surface-${props.monitor().id}`}
        class={styles.dockSurface}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <DockCapsule
          monitorId={props.monitor().id}
          slideProgress={slideProgress}
          animatedWidth={animatedWidth}
          capsuleRef={setCapsuleNode}
          pinned={props.pinned()}
          runningOnly={props.runningOnly()}
        />
      </box>
    </LayerSurface>
  );
}

export function DockSurface(): NativeChild {
  const { apps, monitors, settings, windows } = useShellStore();
  const dock = createMemo(() => buildDockItems(apps.data()?.pinned_apps ?? [], windows.data()?.windows ?? [], apps.data()?.apps));
  const idealWidth = createMemo(() => {
    const { pinned, runningOnly } = dock();
    const count = pinned.length + runningOnly.length;
    const divider = pinned.length > 0 && runningOnly.length > 0 ? 1 + dockGap : 0;
    return tileSize + count * (tileSize + dockGap) + divider + 2 * (dockPadding + 1);
  });
  return (
    <Show when={settings.data()?.bar.dock_enabled !== false && (dock().pinned.length > 0 || dock().runningOnly.length > 0)}>
      <For each={monitors()} keyed={monitor => monitor.id}>
        {monitor => (
          <MonitorDock monitor={monitor} pinned={() => dock().pinned} runningOnly={() => dock().runningOnly} idealWidth={idealWidth} />
        )}
      </For>
    </Show>
  );
}
