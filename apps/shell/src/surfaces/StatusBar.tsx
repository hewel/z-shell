import {
  Button, For, Image, LayerSurface, Show, createEffect, createMemo, createSignal, getWindowRect, onCleanup,
  type Accessor, type ButtonProps, type Monitor, type NativeEvent, type NativeNode, type NativeStyle, type NativeWheelEvent, type NativeWindowRect,
} from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { createEnterProgress, createM3Spring, useMotionScheme } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import {
  DEFAULT_BAR_SETTINGS, filterWorkspacesForMonitor, findActiveWindowForMonitor,
  formatBarClock, formatSurfaceName, resolveBarLayout, resolveBarPopupAnchor, resolveDesktopApp, selectActiveMediaPlayer,
  type ResolvedBarLayout, type TrayItem, type WaylandWindow, type WaylandWorkspace,
} from "../topics.ts";

const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const error = "var(--color-error)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const islandBorder = "1px solid color-mix(in srgb, var(--color-outline-variant) 48%, transparent)";
const activeIslandBorder = "1px solid color-mix(in srgb, var(--color-primary) 60%, transparent)";
const dockedEdgeBorder = "1px solid color-mix(in srgb, var(--color-outline-variant) 48%, transparent)";

const center = { display: "flex", alignItems: "center", justifyContent: "center" } as const;
const group = { display: "flex", alignItems: "center", flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "8px" } as const;
const verticalGroup = { ...group, flexDirection: "column" } as const;
const clippedText = { minWidth: "0px", maxWidth: "224px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
const iconButton = { ...center, width: "26px", height: "28px", flexShrink: 0, borderRadius: "8px" } as const;
const verticalIconButton = { ...center, width: "32px", height: "26px", flexShrink: 0, borderRadius: "8px" } as const;
const compactIconButton = { ...center, width: "26px", height: "28px", flexShrink: 0, borderRadius: "8px" } as const;
const verticalCompactIconButton = { ...center, width: "32px", height: "26px", flexShrink: 0, borderRadius: "8px" } as const;
const notificationBadge = {
  ...center, gap: "4px", backgroundColor: primaryContainer, color: onPrimaryContainer,
  borderRadius: "999px", padding: "2px 6px", fontSize: "11px", fontWeight: 600,
} as const;
const outline = "color-mix(in srgb, var(--color-outline-variant) 65%, transparent)";
const tabular = { fontVariantNumeric: "tabular-nums" } as const;

interface BarClock {
  readonly horizontal: string;
  readonly hours: string;
  readonly minutes: string;
  readonly seconds: string;
}

type StyleObj = Exclude<NativeStyle, string>;

function segmentChrome(vertical: boolean, docked: boolean, active = false): StyleObj {
  if (docked) {
    return {
      ...center,
      flexShrink: 0,
      flexDirection: vertical ? "column" : "row",
      borderRadius: "8px",
      backgroundColor: active ? primaryContainer : "transparent",
      color: active ? onPrimaryContainer : onSurface,
      border: active ? "1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)" : "1px solid transparent",
    };
  }
  return {
    ...center,
    flexShrink: 0,
    flexDirection: vertical ? "column" : "row",
    borderRadius: vertical ? "999px" : "16px",
    backgroundColor: active ? "var(--color-surface-container-high)" : "var(--color-surface-container)",
    color: onSurface,
    border: active ? activeIslandBorder : islandBorder,
    boxShadow: "var(--shadow-level-1)",
  };
}

function Divider(props: { vertical: boolean; short?: boolean }) {
  return <box ariaHidden style={{
    flexShrink: 0,
    backgroundColor: outline,
    width: props.vertical ? (props.short ? "16px" : "20px") : "1px",
    height: props.vertical ? "1px" : props.short ? "12px" : "14px",
  }} />;
}

function wheelDirection(event: NativeWheelEvent): number {
  return Math.sign(Math.abs(event.delta.y) >= Math.abs(event.delta.x) ? event.delta.y : event.delta.x);
}

function secondaryAction(activate: (node: NativeNode) => void): Pick<ButtonProps, "onPointerDown" | "onContextMenu"> {
  return {
    // zgui emits contextmenu for touch long presses; mouse input arrives as a secondary press.
    onPointerDown(event) {
      if (event.button !== "secondary") return;
      event.preventDefault();
      activate(event.currentTarget);
    },
    onContextMenu(event) {
      event.preventDefault();
      activate(event.currentTarget);
    },
  };
}

function WorkspaceButton(props: { workspace: WaylandWorkspace; vertical: boolean; docked: boolean; activate: () => void }) {
  const scheme = useMotionScheme();
  const activeMorph = createM3Spring(() => (props.workspace.active ? 1 : 0), "fastSpatial", { scheme });
  const label = () => props.workspace.name || String(props.workspace.coordinates[0] ?? props.workspace.workspace_id);
  const fill = () => props.workspace.urgent ? error : props.workspace.active ? primary : muted;
  const activeLabel = {
    maxWidth: "22px", fontSize: "11px", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden",
    ...tabular,
  } as const;
  const dotSize = () => props.docked ? "6px" : "8px";
  return (
    <Button testId={`ws-${props.workspace.workspace_id}`} ariaLabel={`Workspace ${label()}`} onClick={props.activate} style={{
      ...center,
      flexShrink: 0,
      width: props.vertical ? "28px" : props.workspace.active ? "28px" : "24px",
      height: props.vertical ? (props.workspace.active ? "30px" : "24px") : "28px",
      borderRadius: "10px",
      backgroundColor: "transparent",
    }}>
      <Show when={props.workspace.active} fallback={
        <box ariaHidden data-ws-pill="true" style={{
          width: dotSize(),
          height: dotSize(),
          borderRadius: "999px",
          backgroundColor: fill(),
          opacity: props.workspace.urgent ? 1 : 0.55,
          transform: scheme() === "reduced" ? "none" : `scale(${(1 + activeMorph() * 0.25).toFixed(4)})`,
        }} />
      }>
        <box ariaHidden data-ws-pill="true" style={{
          ...center,
          minWidth: props.vertical ? "22px" : "23px",
          height: props.vertical ? "26px" : "20px",
          padding: props.vertical ? "2px 0" : "0 6px",
          borderRadius: "999px",
          backgroundColor: fill(),
          color: props.workspace.urgent ? "var(--color-on-error)" : "var(--color-on-primary)",
          transform: scheme() === "reduced" ? "none" : `scale(${(0.86 + activeMorph() * 0.14).toFixed(4)})`,
        }}>
          <text style={activeLabel}>{label()}</text>
        </box>
      </Show>
    </Button>
  );
}

function ActiveWindowPill(props: { window: Accessor<WaylandWindow>; vertical: boolean; docked: boolean }) {
  const { apps, hostClient } = useShellStore();
  const app = createMemo(() => resolveDesktopApp(apps.data()?.apps, props.window().app_id));
  const { src } = useDaemonMedia(hostClient, () => app()?.icon, { fetchCommand: "launcher.fetch-blob" });
  const base = () => segmentChrome(props.vertical, props.docked);
  return (
    <box testId="bar-active-window" ariaLabel={props.window().title} style={
      props.vertical
        ? { ...base(), width: props.docked ? "30px" : "40px", height: props.docked ? "30px" : "40px" }
        : {
            ...base(),
            height: props.docked ? "28px" : "32px",
            justifyContent: "flex-start",
            padding: props.docked ? "0 8px" : "0 12px",
            gap: "8px",
            flexShrink: 1,
            minWidth: "0px",
            overflow: "hidden",
          }
    }>
      <Show when={src()} fallback={<ShellIcon name="terminal" size={16} color={primary} />}>
        {image => <Image ariaHidden src={image()} style={{ width: "16px", height: "16px", borderRadius: "4px", flexShrink: 0, objectFit: "contain" }} />}
      </Show>
      <Show when={!props.vertical}>
        <text testId="bar-active-window-title" style={clippedText}>{props.window().title ?? app()?.title ?? props.window().app_id}</text>
      </Show>
    </box>
  );
}

function TrayButton(props: { item: TrayItem; vertical: boolean; monitorId: string; surfaceName: string; layout: ResolvedBarLayout }) {
  const { hostClient, invokePublic, openTrayMenu } = useShellStore();
  const { src } = useDaemonMedia(hostClient, () => props.item.icon, { fetchCommand: "tray.fetch-blob" });
  const anchorFor = (node: NativeNode): NativeWindowRect =>
    resolveBarPopupAnchor(props.layout, { align: "target", targetRect: getWindowRect(node) });
  return (
    <Button testId={`tray-item-${props.item.id}`} ariaLabel={props.item.title || props.item.id}
      style={props.vertical ? verticalCompactIconButton : compactIconButton}
      onClick={event => {
        const item = props.item;
        if (item.item_is_menu && item.menu) {
          event.stopPropagation();
          openTrayMenu({ itemId: item.id, monitorId: props.monitorId, parentSurface: props.surfaceName, anchorRect: anchorFor(event.currentTarget) });
        } else {
          void invokePublic("tray.activate", { id: item.id });
        }
      }}
      {...secondaryAction(node => {
        const item = props.item;
        if (item.menu) {
          openTrayMenu({ itemId: item.id, monitorId: props.monitorId, parentSurface: props.surfaceName, anchorRect: anchorFor(node) });
        } else {
          void invokePublic("tray.context-menu", { id: item.id });
        }
      })}>
      <Show when={src()} fallback={
        <box style={{ ...center, width: "18px", height: "18px", borderRadius: "6px", backgroundColor: primaryContainer, color: onPrimaryContainer, fontWeight: 700, fontSize: "10px" }}>
          <text>{props.item.title?.[0]?.toUpperCase() ?? "•"}</text>
        </box>
      }>
        {image => <Image src={image()} style={{ width: "18px", height: "18px", borderRadius: "4px", objectFit: "contain" }} />}
      </Show>
    </Button>
  );
}

function NotificationBadgePill(props: { count: number; dnd: boolean; vertical: boolean }) {
  const scheme = useMotionScheme();
  const pop = createEnterProgress("fastSpatial", { scheme });
  return (
    <box testId="bar-notifications-badge" style={{
      ...notificationBadge,
      transform: scheme() === "reduced" ? "none" : `scale(${(0.7 + pop() * 0.3).toFixed(4)})`,
    }}>
      <ShellIcon name={props.dnd ? "bellOff" : "bell"} size={props.vertical ? 10 : 12} color={onPrimaryContainer} />
      <text style={tabular}>{props.count}</text>
    </box>
  );
}

function ClockPill(props: {
  vertical: boolean;
  docked: boolean;
  active: boolean;
  clock: Accessor<BarClock>;
  seconds: boolean;
  monitorId: string;
  surfaceName: string;
  layout: ResolvedBarLayout;
}) {
  const { notifications, togglePanel } = useShellStore();
  const count = () => notifications.data()?.history.length ?? 0;
  const dnd = () => notifications.data()?.dnd ?? false;
  const base = () => segmentChrome(props.vertical, props.docked, props.active);
  return (
    <Button testId="bar-clock" ariaLabel={props.clock().horizontal}
      onClick={event => {
        event.stopPropagation();
        togglePanel("calendar", {
          monitorId: props.monitorId,
          parentSurface: props.surfaceName,
          anchorRect: resolveBarPopupAnchor(props.layout, { align: "center", targetRect: getWindowRect(event.currentTarget) }),
        });
      }}
      style={props.vertical
        ? { ...base(), width: props.docked ? "34px" : "40px", gap: "3px", padding: "6px 0", fontWeight: 600, lineHeight: 1.15 }
        : { ...base(), height: props.docked ? "28px" : "32px", gap: "8px", padding: "0 12px", whiteSpace: "nowrap" }}>
      <Show when={props.vertical} fallback={
        <text testId="bar-clock-text" style={{ ...tabular, fontWeight: 500 }}>{props.clock().horizontal}</text>
      }>
        <box testId="bar-clock-text" style={{ ...center, flexDirection: "column" }}>
          <text style={tabular}>{props.clock().hours}</text>
          <text style={tabular}>{props.clock().minutes}</text>
          <Show when={props.seconds}><text style={{ ...tabular, fontSize: "10px", color: muted }}>{props.clock().seconds}</text></Show>
        </box>
      </Show>
      <Show when={count() > 0 || dnd()}>
        <Divider vertical={props.vertical} short />
        <NotificationBadgePill count={count()} dnd={dnd()} vertical={props.vertical} />
      </Show>
    </Button>
  );
}

function SystemPill(props: {
  vertical: boolean;
  docked: boolean;
  active: boolean;
  monitorId: string;
  surfaceName: string;
  layout: ResolvedBarLayout;
}) {
  const { ime, privacy, network, bluetooth, audio, power, togglePanel, invokePublic, openImeMenu } = useShellStore();
  const quickSettings = (event: NativeEvent) => {
    event.stopPropagation();
    togglePanel("quick-settings", {
      monitorId: props.monitorId,
      parentSurface: props.surfaceName,
      anchorRect: resolveBarPopupAnchor(props.layout, { align: "end", targetRect: getWindowRect(event.currentTarget) }),
    });
  };
  const btnStyle = () => props.vertical ? verticalCompactIconButton : compactIconButton;
  const networkIcon = createMemo(() => {
    const state = network.data();
    if (!state?.available) return "wifiOff";
    if (state.ethernet.some(device => device.carrier)) return "ethernet";
    return state.wifi.enabled && state.wifi.hardware_enabled ? "wifi" : "wifiOff";
  });
  const bluetoothPowered = createMemo(() => bluetooth.data()?.adapters.some(adapter => adapter.powered) ?? false);
  const bluetoothConnected = createMemo(() => bluetooth.data()?.devices.some(device => device.connected) ?? false);
  const sink = createMemo(() => {
    const state = audio.data();
    return state?.sinks.find(device => device.name === state.default_sink);
  });
  const audioIcon = createMemo(() => {
    const device = sink();
    return !device || device.muted || device.volume <= 0 ? "volumeMute" : device.volume < 0.5 ? "volumeLow" : "volumeHigh";
  });
  const base = () => segmentChrome(props.vertical, props.docked, props.active);
  return (
    <box testId="bar-system" style={props.vertical
      ? { ...base(), width: props.docked ? "34px" : "40px", gap: "2px", padding: "4px 0" }
      : { ...base(), height: props.docked ? "28px" : "32px", gap: "2px", padding: "0 6px" }}>
      <Show when={ime.data()?.available && ime.data()?.mode !== "disabled"}>
        <Button testId="bar-ime" ariaLabel="Input method" ariaHasPopup="menu"
          style={{
            ...center, minWidth: "26px", height: "24px", padding: "0 6px", borderRadius: "999px",
            backgroundColor: primaryContainer, color: onPrimaryContainer, fontWeight: 700, fontSize: "11px",
          }}
          onClick={() => { void invokePublic("ime.toggle", {}); }}
          {...secondaryAction(node => {
            openImeMenu({
              monitorId: props.monitorId,
              parentSurface: props.surfaceName,
              anchorRect: resolveBarPopupAnchor(props.layout, { align: "target", targetRect: getWindowRect(node) }),
            });
          })}>
          <text>{ime.data()?.active_im?.short_label || "EN"}</text>
        </Button>
        <Divider vertical={props.vertical} />
      </Show>
      <Show when={privacy.data()?.audio_capture.state === "active"}>
        <box testId="bar-privacy" ariaLabel="Microphone in use" style={{ ...center, width: "20px", height: "18px", borderRadius: "10px", backgroundColor: "var(--color-error-container)" }}>
          <ShellIcon name="mic" size={13} color="var(--color-on-error-container)" />
        </box>
      </Show>
      <Button testId="bar-network" ariaLabel="Network settings" style={btnStyle()} onClick={quickSettings}>
        <ShellIcon name={networkIcon()} size={15}
          color={props.active && props.docked ? onPrimaryContainer : networkIcon() === "wifiOff" ? muted : onSurface} />
      </Button>
      <Button testId="bar-bluetooth" ariaLabel="Bluetooth settings" style={btnStyle()} onClick={quickSettings}>
        <ShellIcon name={bluetoothPowered() || bluetoothConnected() ? "bluetooth" : "bluetoothOff"} size={15}
          color={props.active && props.docked ? onPrimaryContainer : bluetoothConnected() ? primary : bluetoothPowered() ? onSurface : muted} />
      </Button>
      <Button testId="bar-audio" ariaLabel="Audio settings" style={btnStyle()} onClick={quickSettings}
        onWheel={event => {
          const device = sink();
          const direction = wheelDirection(event);
          if (!device || direction === 0) return;
          event.preventDefault();
          const volume = Math.max(0, Math.min(1, device.volume - direction * 0.05));
          void invokePublic("audio.set-volume", { kind: "sink", index: device.index, volume });
        }}
        {...secondaryAction(() => {
          const device = sink();
          if (device) void invokePublic("audio.set-mute", { kind: "sink", index: device.index, muted: !device.muted });
        })}>
        <ShellIcon name={audioIcon()} size={15} color={props.active && props.docked ? onPrimaryContainer : onSurface} />
      </Button>
      <Show when={power.data()?.battery}>
        {battery => (
          <Button testId="bar-battery" ariaLabel="Battery"
            onClick={event => {
              event.stopPropagation();
              togglePanel("battery", {
                monitorId: props.monitorId,
                parentSurface: props.surfaceName,
                anchorRect: resolveBarPopupAnchor(props.layout, { align: "end", targetRect: getWindowRect(event.currentTarget) }),
              });
            }}
            style={{
              ...center,
              flexDirection: props.vertical ? "column" : "row",
              gap: props.vertical ? "2px" : "4px",
              height: props.vertical ? "auto" : "28px",
              padding: props.vertical ? "3px 0" : "0 4px",
              flexShrink: 0,
            }}>
            <ShellIcon name={battery().state === "charging" || battery().state === "full" ? "batteryCharging" : "battery"} size={15}
              color={props.active && props.docked
                ? onPrimaryContainer
                : battery().state === "discharging" && (battery().percentage ?? 100) < 20
                  ? error : battery().state === "charging" ? primary : onSurface} />
            <text testId="bar-battery-text" data-tabular="true" style={{ fontFamily: "var(--font-mono)", fontSize: "11px", fontVariantNumeric: "tabular-nums" }}>
              {battery().percentage == null ? "—" : `${Math.round(battery().percentage ?? 0)}%`}
            </text>
          </Button>
        )}
      </Show>
    </box>
  );
}

function BarContent(props: {
  monitor: Monitor;
  layout: ResolvedBarLayout;
  launcher: boolean;
  clock: Accessor<BarClock>;
  seconds: boolean;
}) {
  const store = useShellStore();
  const { activePanel, togglePanel, dismissOverlay, invokePublic } = store;
  useShellTheme(store.theme.data);
  const vertical = createMemo(() => props.layout.isVertical);
  const docked = createMemo(() => props.layout.style === "docked");
  const surfaceName = () => formatSurfaceName("bar", props.monitor.id);
  const workspaces = createMemo(() => filterWorkspacesForMonitor(store.workspaces.data(), store.outputs.data(), props.monitor.name));
  const activeWindow = createMemo(() => findActiveWindowForMonitor(store.windows.data(), store.outputs.data(), props.monitor.name));
  const player = createMemo(() => selectActiveMediaPlayer(store.media.data()));
  const mediaLabel = createMemo(() => {
    const active = player();
    return active ? [active.metadata.title, active.metadata.artists.join(", ")].filter(Boolean).join(" — ") || active.identity : "";
  });
  const slots = createMemo(() => store.pluginBarWidgets().filter(slot => slot.outputId == null || slot.outputId === props.monitor.id));
  const activateWorkspace = (id: number) => { void invokePublic("wayland.workspace.activate", { workspace_id: id }); };

  const rootStyle = createMemo((): StyleObj => {
    const isDocked = docked();
    const isVertical = vertical();
    const bleed = props.layout.shadowBleed;
    const bleedPadding = `${bleed.top}px ${bleed.right}px ${bleed.bottom}px ${bleed.left}px`;
    const base: StyleObj = {
      ...center,
      justifyContent: "space-between",
      color: onSurface,
      fontFamily: "var(--font-sans)",
      fontSize: "12px",
      overflow: isDocked ? "hidden" : "visible",
      backgroundColor: isDocked ? "var(--color-surface-container)" : "transparent",
    };
    if (isVertical) {
      return {
        ...base,
        width: `${props.layout.width}px`,
        height: `${props.layout.height}px`,
        padding: isDocked ? "8px 0" : bleedPadding,
        flexDirection: "column",
        ...(isDocked && props.layout.position === "left" ? { borderRight: dockedEdgeBorder } : {}),
        ...(isDocked && props.layout.position === "right" ? { borderLeft: dockedEdgeBorder } : {}),
      };
    }
    return {
      ...base,
      width: "100%",
      height: `${props.layout.height}px`,
      padding: isDocked ? "0 10px" : bleedPadding,
      ...(isDocked ? { borderBottom: dockedEdgeBorder } : {}),
    };
  });

  return (
    <box testId={`bar-root-${props.monitor.id}`} data-theme-rev={String(store.theme.revision())}
      data-position={props.layout.position} data-bar-style={props.layout.style} data-active-panel={activePanel() ?? "none"}
      onClick={() => dismissOverlay()}
      style={rootStyle()}>
      <box style={vertical() ? verticalGroup : group}>
        <Show when={props.launcher}>
          <Button testId="bar-launcher" ariaLabel="Launcher"
            style={vertical()
              ? { ...segmentChrome(true, docked(), activePanel() === "launcher"), width: docked() ? "30px" : "40px", height: docked() ? "30px" : "40px" }
              : { ...segmentChrome(false, docked(), activePanel() === "launcher"), width: docked() ? "28px" : "32px", height: docked() ? "28px" : "32px" }}
            onClick={event => {
              event.stopPropagation();
              togglePanel("launcher", { monitorId: props.monitor.id });
            }}>
            <ShellIcon name="apps" size={18} color={primary} />
          </Button>
        </Show>
        <Show when={docked() && props.launcher}><Divider vertical={vertical()} /></Show>
        <box testId="bar-workspaces" style={vertical()
          ? { ...segmentChrome(true, docked()), width: docked() ? "32px" : "40px", gap: "2px", padding: "6px 0" }
          : { ...segmentChrome(false, docked()), height: docked() ? "28px" : "32px", gap: "2px", padding: "0 6px" }}
          onWheel={event => {
            const direction = wheelDirection(event);
            const items = workspaces();
            if (!direction || items.length === 0) return;
            event.preventDefault();
            const active = items.findIndex(workspace => workspace.active);
            const next = active < 0 ? (direction > 0 ? 0 : items.length - 1) : (active + direction + items.length) % items.length;
            const target = items[next];
            if (next !== active && target) activateWorkspace(target.workspace_id);
          }}>
          <For each={workspaces()} keyed={workspace => workspace.workspace_id}>
            {workspace => <WorkspaceButton workspace={workspace()} vertical={vertical()} docked={docked()} activate={() => activateWorkspace(workspace().workspace_id)} />}
          </For>
          <Divider vertical={vertical()} short />
          <Button testId="bar-overview" ariaLabel="Overview" selected={activePanel() === "overview"}
            style={vertical() ? verticalIconButton : iconButton}
            onClick={event => {
              event.stopPropagation();
              togglePanel("overview", { monitorId: props.monitor.id });
            }}>
            <ShellIcon name="overview" size={16} color={activePanel() === "overview" ? primary : muted} />
          </Button>
        </box>
        <Show when={activeWindow()}>
          {window => <>
            <Show when={docked()}><Divider vertical={vertical()} /></Show>
            <ActiveWindowPill window={window} vertical={vertical()} docked={docked()} />
          </>}
        </Show>
      </box>
      <ClockPill vertical={vertical()} docked={docked()} active={activePanel() === "calendar"}
        clock={props.clock} seconds={props.seconds} monitorId={props.monitor.id} surfaceName={surfaceName()} layout={props.layout} />
      <box style={{ ...(vertical() ? verticalGroup : group), justifyContent: "flex-end" }}>
        <Show when={slots().length > 0}>
          <box testId="bar-plugin-slots" onClick={event => event.stopPropagation()} style={vertical()
            ? { ...segmentChrome(true, docked()), width: docked() ? "32px" : "40px", gap: "4px", padding: "6px 0" }
            : { ...segmentChrome(false, docked()), height: docked() ? "28px" : "32px", gap: "6px", padding: "0 8px" }}>
            <For each={slots()}>{slot => () => slot.render({ vertical: vertical() })}</For>
          </box>
        </Show>
        <Show when={player()}>
          {active => <>
            <Show when={docked() && slots().length > 0}><Divider vertical={vertical()} /></Show>
            <Button testId="bar-media" ariaLabel={mediaLabel()}
              style={vertical()
                ? { ...segmentChrome(true, docked(), activePanel() === "media"), width: docked() ? "30px" : "40px", height: docked() ? "30px" : "40px" }
                : {
                    ...segmentChrome(false, docked(), activePanel() === "media"),
                    height: docked() ? "28px" : "32px",
                    justifyContent: "flex-start",
                    padding: docked() ? "0 8px" : "0 12px",
                    gap: "8px",
                    flexShrink: 1,
                    minWidth: "0px",
                    overflow: "hidden",
                  }}
              onClick={event => {
                event.stopPropagation();
                togglePanel("media", {
                  monitorId: props.monitor.id,
                  parentSurface: surfaceName(),
                  anchorRect: resolveBarPopupAnchor(props.layout, { align: "target", targetRect: getWindowRect(event.currentTarget) }),
                });
              }}
              {...secondaryAction(() => {
                void invokePublic("media.play-pause", { player_id: active().id });
              })}
              onWheel={event => {
                const direction = wheelDirection(event);
                if (!direction) return;
                event.preventDefault();
                void invokePublic(direction > 0 ? "media.next" : "media.previous", { player_id: active().id });
              }}>
              <ShellIcon name="mediaEq" size={16} color={primary} />
              <Show when={!vertical()}><text testId="bar-media-text" style={clippedText}>{mediaLabel()}</text></Show>
            </Button>
          </>}
        </Show>
        <Show when={(store.tray.data()?.items.length ?? 0) > 0}>
          <Show when={docked()}><Divider vertical={vertical()} /></Show>
          <box testId="bar-tray" style={vertical()
            ? { ...segmentChrome(true, docked()), width: docked() ? "30px" : "40px", gap: "2px", padding: "4px 0" }
            : { ...segmentChrome(false, docked()), height: docked() ? "28px" : "32px", gap: "2px", padding: "0 4px" }}>
            <For each={store.tray.data()?.items} keyed={item => item.id}>
              {item => <TrayButton item={item()} vertical={vertical()} monitorId={props.monitor.id} surfaceName={surfaceName()} layout={props.layout} />}
            </For>
          </box>
        </Show>
        <Show when={docked()}><Divider vertical={vertical()} /></Show>
        <SystemPill vertical={vertical()} docked={docked()} active={activePanel() === "quick-settings" || activePanel() === "battery"}
          monitorId={props.monitor.id} surfaceName={surfaceName()} layout={props.layout} />
      </box>
    </box>
  );
}

export function StatusBar() {
  const { monitors, outputs, settings } = useShellStore();
  const barSettings = () => settings.data()?.bar ?? DEFAULT_BAR_SETTINGS;
  const [now, setNow] = createSignal(Date.now());
  const clockSeconds = () => barSettings().clock_seconds;
  let timer: number | undefined;
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  createEffect(clockSeconds, seconds => {
    const period = seconds ? 1_000 : 60_000;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      timer = setTimeout(tick, period - (time % period));
    };
    if (timer !== undefined) clearTimeout(timer);
    tick();
  });
  const clock = createMemo(() => formatBarClock(now(), { clock24h: barSettings().clock_24h, clockSeconds: clockSeconds() }));

  return (
    <For each={monitors()} keyed={monitor => monitor.id}>
      {monitor => {
        const layout = createMemo(() => resolveBarLayout(barSettings(), monitor(), outputs.data()));
        return (
          <LayerSurface name={formatSurfaceName("bar", monitor().id)} output={monitor().id} layer="top" anchor={[...layout().anchor]}
            width={layout().width} height={layout().height} margin={layout().margin} exclusiveZone={layout().exclusiveZone}
            inputRegion={layout().inputRegion ? [...layout().inputRegion!] : "full"} keyboard="none">
            <BarContent monitor={monitor()} layout={layout()} launcher={barSettings().launcher_enabled !== false} clock={clock} seconds={clockSeconds()} />
          </LayerSurface>
        );
      }}
    </For>
  );
}
