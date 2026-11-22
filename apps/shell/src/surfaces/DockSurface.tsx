import {
  Button, For, Image, LayerSurface, Show, createEffect, createMemo, createSignal, onCleanup,
  type Accessor, type BlurRegion, type Monitor, type NativeChild, type NativeStyle, type NativeWindowRect,
} from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { SUPERELLIPSE_EXPONENT, roundedRectBlurRegion } from "../blur.ts";
import { ShellIcon } from "../icons.tsx";
import { SPRING_EPSILON, createM3Spring, useMotionScheme } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import { buildDockItems, formatSurfaceName, resolveMonitorLogicalSize, type DockEntry } from "../topics.ts";

const primary = "var(--color-primary)";
const outline = "var(--color-outline-variant)";
const onSurfaceVariant = "var(--color-on-surface-variant)";
const tileSize = 46;
const dockGap = 8;
const dockPadding = 10;
const dockHeight = 60;
const dockBottomMargin = 10;
const dockLayerHeight = 112;
const triggerStripHeight = 8;
const autoHideDelayMs = 500;
const hiddenSlideOffset = dockHeight + dockBottomMargin + 18;
const capsule = {
  height: `${dockHeight}px`, alignItems: "center", gap: `${dockGap}px`, padding: `0 ${dockPadding}px`,
  borderRadius: "22px",
  backgroundColor: "var(--color-surface-container)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
  boxShadow: "var(--shadow-level-2)",
  overflow: "visible",
} satisfies NativeStyle;
const tile = {
  display: "flex", width: `${tileSize}px`, height: `${tileSize}px`, flexShrink: 0, alignItems: "center", justifyContent: "center",
} satisfies NativeStyle;
const tileVisual = {
  display: "flex", width: "38px", height: "38px", flexShrink: 0, alignItems: "center", justifyContent: "center",
} satisfies NativeStyle;
const tileIcon = { width: "34px", height: "34px", borderRadius: "10px", "object-fit": "contain" } as const;
const tileStack = {
  position: "relative", width: `${tileSize}px`, height: `${dockHeight}px`, flexShrink: 0,
  alignItems: "center", justifyContent: "center",
} as const;
const dot = { width: "4px", height: "4px", flexShrink: 0, borderRadius: "2px", "--zgui-corner-shape": "none", backgroundColor: "color-mix(in srgb, var(--color-on-surface) 84%, transparent)" } as const;
const tints = ["primary", "secondary", "tertiary"] as const;

function DockApp(props: { entry: Accessor<DockEntry> }) {
  const { hostClient, invokePublic, invokeHost } = useShellStore();
  const entry = props.entry;
  const { src } = useDaemonMedia(hostClient, () => entry().icon, { fetchCommand: "launcher.fetch-blob" });
  const tint = createMemo(() => {
    let hash = 0;
    for (const char of entry().appId) hash = (Math.imul(31, hash) + char.codePointAt(0)!) >>> 0;
    return tints[hash % tints.length];
  });
  const initial = createMemo(() => {
    const label = entry().title.trim();
    const id = (label || entry().appId).replace(/\.desktop$/i, "");
    return String.fromCodePoint(id.codePointAt(id.lastIndexOf(".") + 1) ?? 0x3f).toUpperCase();
  });
  function activate() {
    const { appId, windows } = entry();
    const window = windows[0];
    if (window) void invokePublic("wayland.window.activate", { window_id: window.window_id });
    else void invokePublic("launcher.activate", { provider_id: "desktop", item_id: appId });
  }
  function togglePin() {
    const { appId, pinned } = entry();
    void invokeHost("apps.pin", { id: appId, pinned: !pinned });
  }
  return (
    <column style={tileStack}>
      <Button testId={`dock-${entry().pinned ? "app" : "running"}-${entry().appId}`} ariaLabel={entry().title}
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
        style={{ ...tile, borderRadius: "12px", backgroundColor: "transparent", overflow: "visible" }}>
        <box data-dock-visual="true" ariaHidden style={{
          ...tileVisual,
          pointerEvents: "none",
          marginBottom: "2px",
          borderRadius: "10px",
          backgroundColor: src() ? "transparent" : `var(--color-${tint()}-container)`,
          color: `var(--color-on-${tint()}-container)`,
        }}>
          <Show when={src()} fallback={
            <text style={{ fontFamily: "var(--font-sans)", fontSize: "16px", fontWeight: 700 }}>
              {initial()}
            </text>
          }>
            {image => <Image ariaHidden src={image()} style={tileIcon} />}
          </Show>
        </box>
      </Button>
      <row ariaHidden style={{
        position: "absolute", bottom: "2px", height: "4px", maxWidth: `${tileSize}px`,
        alignItems: "center", justifyContent: "center", gap: "2px", overflow: "hidden", pointerEvents: "none",
      }}>
        <Show when={!entry().focused}>
          <Show when={entry().pinned} fallback={<box style={{ ...dot, backgroundColor: onSurfaceVariant }} />}>
            <For each={entry().windows} keyed={window => window.window_id}>{() => <box style={dot} />}</For>
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
  width: number;
  revealed: Accessor<boolean>;
  pinned: readonly DockEntry[];
  runningOnly: readonly DockEntry[];
}) {
  const { theme, togglePanel, dismissOverlay } = useShellStore();
  useShellTheme(theme.data);
  const scheme = useMotionScheme();
  const slideProgress = createM3Spring(() => props.revealed() ? 0 : 1, "defaultSpatial", { scheme });
  const animatedWidth = createM3Spring(() => props.width, "defaultSpatial", { scheme, epsilon: SPRING_EPSILON.px });
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
    <row testId={`dock-root-${props.monitorId}`} role="toolbar" ariaLabel="Dock" onClick={() => dismissOverlay()} style={{
      ...capsule,
      width: `${Math.round(animatedWidth())}px`,
      transform: `translateY(${(slideProgress() * hiddenSlideOffset).toFixed(2)}px)`,
      opacity: Math.max(0, Math.min(1, 1 - slideProgress() * 0.45)),
    }}>
      <column style={tileStack}>
        <Button testId="dock-launcher" ariaLabel="Open launcher" data-dock-trigger="true" onClick={event => {
          event.stopPropagation();
          togglePanel("launcher", { monitorId: props.monitorId });
        }}
          style={{ ...tile, borderRadius: "12px", backgroundColor: "transparent" }}>
          <box data-press-visual="compact" ariaHidden style={{
            ...tileVisual, marginBottom: "2px", borderRadius: "10px",
            backgroundColor: "var(--color-surface-container-high)",
          }}>
            <ShellIcon name="apps" size={20} color={primary} />
          </box>
        </Button>
      </column>
      <scroll style={{ flexGrow: 1, flexShrink: 1, minWidth: "0px", height: `${dockHeight}px`, overflow: "auto hidden" }}>
        <row style={{ position: "relative", height: `${dockHeight}px`, alignItems: "center", gap: `${dockGap}px` }}>
          <box ariaHidden style={{
            position: "absolute",
            left: "0px",
            bottom: "3px",
            width: "16px",
            height: "3px",
            borderRadius: "2px",
            "--zgui-corner-shape": "none",
            backgroundColor: primary,
            pointerEvents: "none",
            opacity: Math.max(0, Math.min(1, focusBarOpacity())),
            transform: `translateX(${focusBarX().toFixed(2)}px)`,
          }} />
          <For each={slots()} keyed={slot => slot.key}>
            {slot => slot().kind === "divider"
              ? <box ariaHidden style={{ width: "1px", height: "30px", flexShrink: 0, backgroundColor: outline }} />
              : <DockApp entry={() => (slot() as Extract<DockSlot, { readonly kind: "app" }>).entry} />}
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
  let hideTimer: number | undefined;
  const clearHideTimer = () => {
    if (hideTimer !== undefined) {
      clearTimeout(hideTimer);
      hideTimer = undefined;
    }
  };
  onCleanup(clearHideTimer);

  createEffect(hovered, isHovered => {
    clearHideTimer();
    if (isHovered) {
      setRevealed(true);
      return;
    }
    hideTimer = setTimeout(() => {
      hideTimer = undefined;
      setRevealed(false);
    }, autoHideDelayMs);
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

  const blurRegion = createMemo<BlurRegion>(() => {
    if (!revealed()) return "none";
    const width = capsuleWidth();
    const strips = roundedRectBlurRegion(
      {
        x: (layerWidth() - width) / 2,
        y: dockLayerHeight - dockBottomMargin - dockHeight,
        width,
        height: dockHeight,
      },
      22,
      1,
      SUPERELLIPSE_EXPONENT,
    );
    return strips.length > 0 ? strips : "none";
  });

  return (
    <LayerSurface name={formatSurfaceName("dock", props.monitor().id)} output={props.monitor().id} layer="top"
      anchor={["bottom", "left", "right"]} margin={{ bottom: 0 }} width={layerWidth()} height={dockLayerHeight}
      exclusiveZone={0} keyboard="none" inputRegion={inputRegion()} blurRegion={blurRegion()}>
      <box testId={`dock-surface-${props.monitor().id}`} style={{
        // Fill the full LayerSurface viewport (including the bottom-edge trigger strip) instead of
        // shrinking to the content-sized :root height.
        position: "fixed",
        left: "0px",
        top: "0px",
        width: "100%",
        height: `${dockLayerHeight}px`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: `${dockBottomMargin}px`,
        overflow: "hidden",
      }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}>
        <DockCapsule
          monitorId={props.monitor().id}
          width={capsuleWidth()}
          revealed={revealed}
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
