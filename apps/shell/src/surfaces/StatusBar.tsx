import {
  Button, For, Image, LayerSurface, Show, createEffect, createMemo, createSignal, getWindowRect, onCleanup,
  type Accessor, type ButtonProps, type Monitor, type NativeEvent, type NativeNode, type NativeStyle, type NativeWheelEvent, type NativeWindowRect,
} from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { createRoundedBlurGroup, type RoundedBlurGroup } from "../blur.ts";
import { MiniSparkline, SplitDualArcGauge } from "../charts/TelemetryCharts.tsx";
import { ShellIcon } from "../icons.tsx";
import { SPRING_EPSILON, createEnterProgress, createM3Spring, useMotionScheme } from "../motion.ts";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import {
  DEFAULT_BAR_SETTINGS, computeMemoryBreakdown, filterWorkspacesForMonitor, findActiveWindowForMonitor,
  formatBarClock, formatSurfaceName, isImeTrayItem, resolveBarLayout, resolveBarPopupAnchor, resolveDesktopApp, selectActiveMediaPlayer,
  type ResolvedBarLayout, type TrayItem, type WaylandWindow, type WaylandWorkspace,
} from "../topics.ts";

const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const error = "var(--color-error)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const islandBorder = "1px solid var(--border-bar-floating)";
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
  ...center, gap: "4px", height: "24px", backgroundColor: primaryContainer, color: onPrimaryContainer,
  borderRadius: "999px", "--zgui-corner-shape": "none", padding: "0 7px", fontSize: "11px", fontWeight: 600,
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

function segmentChrome(vertical: boolean, docked: boolean, active = false, interactive = false): StyleObj {
  if (docked) {
    return {
      ...center,
      flexShrink: 0,
      flexDirection: vertical ? "column" : "row",
      borderRadius: "8px",
      ...(interactive
        ? {}
        : {
            backgroundColor: active ? primaryContainer : "transparent",
            border: active ? "1px solid color-mix(in srgb, var(--color-primary) 35%, transparent)" : "1px solid transparent",
          }),
      color: active ? onPrimaryContainer : onSurface,
    };
  }
  return {
    ...center,
    flexShrink: 0,
    flexDirection: vertical ? "column" : "row",
    borderRadius: vertical ? "999px" : "16px",
    "--zgui-corner-shape": "none",
    ...(interactive
      ? {}
      : {
          backgroundColor: active ? "var(--surface-bar-floating-active)" : "var(--surface-bar-floating)",
          border: active ? activeIslandBorder : islandBorder,
        }),
    color: onSurface,
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

const WS_SLOT_WIDTH_H = 26;
const WS_SLOT_HEIGHT_V = 26;
const WS_SLOT_GAP = 2;

function WorkspaceButton(props: {
  workspace: WaylandWorkspace;
  vertical: boolean;
  docked: boolean;
  activate: () => void;
  registerNode: (id: number, node: NativeNode) => void;
}) {
  const scheme = useMotionScheme();
  const activeFade = createM3Spring(() => (props.workspace.active ? 1 : 0), "fastEffects", { scheme });
  const label = () => props.workspace.name || String(props.workspace.coordinates[0] ?? props.workspace.workspace_id);
  const dotFill = () => props.workspace.urgent ? error : muted;
  const activeLabel = () => ({
    maxWidth: props.vertical ? "22px" : "84px",
    fontSize: "11px",
    fontWeight: 700,
    whiteSpace: "nowrap",
    overflow: "hidden",
    color: props.workspace.urgent ? "var(--color-on-error)" : "var(--color-on-primary)",
    ...tabular,
  }) as const;
  const dotSize = () => props.docked ? "6px" : "8px";
  return (
    <Button
      ref={node => props.registerNode(props.workspace.workspace_id, node)}
      testId={`ws-${props.workspace.workspace_id}`}
      ariaLabel={`Workspace ${label()}`}
      onClick={props.activate}
      style={{
        ...center,
        position: "relative",
        zIndex: 1,
        flexShrink: 0,
        minWidth: props.vertical ? "28px" : `${WS_SLOT_WIDTH_H}px`,
        height: props.vertical ? `${WS_SLOT_HEIGHT_V}px` : "28px",
        padding: !props.vertical && props.workspace.active ? "0 8px" : "0px",
        borderRadius: "10px",
        backgroundColor: "transparent",
      }}>
      <box data-press-visual="compact" ariaHidden style={{ ...center, position: "relative", width: "100%", height: "100%" }}>
        <Show when={props.workspace.active} fallback={
          <box ariaHidden style={{
            width: dotSize(),
            height: dotSize(),
            borderRadius: "999px",
            "--zgui-corner-shape": "none",
            backgroundColor: dotFill(),
            opacity: props.workspace.urgent ? 1 : Math.max(0.15, (1 - activeFade()) * 0.55),
            transform: scheme() === "reduced" ? "none" : `scale(${(1 - activeFade() * 0.3).toFixed(4)})`,
          }} />
        }>
          <text style={{ ...activeLabel(), opacity: Math.max(0, Math.min(1, activeFade())) }}>{label()}</text>
        </Show>
      </box>
    </Button>
  );
}

function WorkspaceTrack(props: {
  workspaces: Accessor<readonly WaylandWorkspace[]>;
  vertical: boolean;
  docked: boolean;
  activate: (id: number) => void;
}) {
  const scheme = useMotionScheme();
  const activeIndex = createMemo(() => props.workspaces().findIndex(ws => ws.active));
  const activeWorkspace = createMemo(() => {
    const idx = activeIndex();
    return idx >= 0 ? props.workspaces()[idx] : undefined;
  });
  let trackNode: NativeNode | undefined;
  const buttonNodes = new Map<number, NativeNode>();
  const registerNode = (id: number, node: NativeNode) => {
    buttonNodes.set(id, node);
  };

  const fallbackRect = (): { readonly offset: number; readonly size: number } => {
    const idx = Math.max(0, activeIndex());
    const ws = activeWorkspace();
    if (props.vertical) {
      return { offset: idx * (WS_SLOT_HEIGHT_V + WS_SLOT_GAP), size: 24 };
    }
    const label = ws ? (ws.name || String(ws.coordinates[0] ?? ws.workspace_id)) : "";
    const estWidth = Math.max(WS_SLOT_WIDTH_H, label.length * 7 + 16);
    return { offset: idx * (WS_SLOT_WIDTH_H + WS_SLOT_GAP), size: estWidth };
  };

  const measureActiveRect = (): { readonly offset: number; readonly size: number } | null => {
    const ws = activeWorkspace();
    if (!ws || !trackNode) return null;
    const btn = buttonNodes.get(ws.workspace_id);
    if (!btn) return null;
    const trackRect = getWindowRect(trackNode);
    const btnRect = getWindowRect(btn);
    if (!trackRect || !btnRect || btnRect.width <= 1 || btnRect.height <= 1) return null;
    return props.vertical
      ? { offset: btnRect.y - trackRect.y + (btnRect.height - 24) / 2, size: 24 }
      : { offset: btnRect.x - trackRect.x, size: Math.max(24, btnRect.width) };
  };

  const [targetOffset, setTargetOffset] = createSignal(fallbackRect().offset);
  const [targetSize, setTargetSize] = createSignal(fallbackRect().size);
  const slideOffset = createM3Spring(targetOffset, "fastSpatial", { scheme, epsilon: SPRING_EPSILON.px });
  const slideSize = createM3Spring(targetSize, "fastSpatial", { scheme, epsilon: SPRING_EPSILON.px });
  const pillOpacity = createM3Spring(() => (activeIndex() >= 0 ? 1 : 0), "fastEffects", { scheme });
  const pillFill = () => activeWorkspace()?.urgent ? error : primary;

  let initialized = false;
  createEffect(
    () => [activeWorkspace()?.workspace_id, props.workspaces().length, props.vertical] as const,
    ([activeId]) => {
      if (activeId === undefined) return;
      const shouldJump = !initialized;
      initialized = true;
      const apply = (snap: boolean) => {
        const next = measureActiveRect() ?? fallbackRect();
        if (snap) {
          slideOffset.jump(next.offset);
          slideSize.jump(next.size);
          pillOpacity.jump(1);
        }
        setTargetOffset(next.offset);
        setTargetSize(next.size);
      };
      apply(shouldJump);
      queueMicrotask(() => apply(shouldJump));
    },
  );

  return (
    <box ref={node => { trackNode = node; }} style={{
      position: "relative",
      display: "flex",
      flexDirection: props.vertical ? "column" : "row",
      alignItems: "center",
      gap: `${WS_SLOT_GAP}px`,
      flexShrink: 0,
    }}>
      <box ariaHidden style={{
        position: "absolute",
        pointerEvents: "none",
        left: props.vertical ? "2px" : "0px",
        top: props.vertical ? "0px" : "4px",
        width: props.vertical ? "24px" : `${Math.max(24, slideSize()).toFixed(2)}px`,
        height: props.vertical ? `${Math.max(24, slideSize()).toFixed(2)}px` : "20px",
        borderRadius: "999px",
        "--zgui-corner-shape": "none",
        backgroundColor: pillFill(),
        opacity: Math.max(0, Math.min(1, pillOpacity())),
        transform: props.vertical
          ? `translateY(${slideOffset().toFixed(2)}px)`
          : `translateX(${slideOffset().toFixed(2)}px)`,
      }} />
      <For each={props.workspaces()} keyed={workspace => workspace.workspace_id}>
        {workspace => (
          <WorkspaceButton
            workspace={workspace()}
            vertical={props.vertical}
            docked={props.docked}
            activate={() => props.activate(workspace().workspace_id)}
            registerNode={registerNode}
          />
        )}
      </For>
    </box>
  );
}

function ActiveWindowPill(props: { window: Accessor<WaylandWindow>; vertical: boolean; docked: boolean; blur: RoundedBlurGroup }) {
  const { apps, hostClient } = useShellStore();
  const app = createMemo(() => resolveDesktopApp(apps.data()?.apps, props.window().app_id));
  const { src } = useDaemonMedia(hostClient, () => app()?.icon, { fetchCommand: "launcher.fetch-blob" });
  const base = () => segmentChrome(props.vertical, props.docked);
  const blurRef = props.blur.useTarget();
  return (
    <box ref={blurRef} testId="bar-active-window" ariaLabel={props.window().title} style={
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
  const fallbackLetter = () => {
    const trimmed = props.item.title?.trim() ?? "";
    const first = trimmed ? Array.from(trimmed)[0] : undefined;
    return first && /^[\p{L}\p{N}]$/u.test(first) ? first.toUpperCase() : null;
  };
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
        <Show when={fallbackLetter()} fallback={
          <box style={{
            ...center, width: "18px", height: "18px", borderRadius: "6px",
            backgroundColor: "var(--color-surface-container-highest)",
          }}>
            <ShellIcon name="apps" size={12} color={muted} />
          </box>
        }>
          {letter => (
            <box style={{
              ...center, width: "18px", height: "18px", borderRadius: "6px",
              backgroundColor: primaryContainer, color: onPrimaryContainer, fontWeight: 700, fontSize: "10px",
            }}>
              <text>{letter()}</text>
            </box>
          )}
        </Show>
      }>
        {image => <Image src={image()} style={{ width: "18px", height: "18px", borderRadius: "4px", objectFit: "contain" }} />}
      </Show>
    </Button>
  );
}

function NotificationBadgePill(props: { count: number; dnd: boolean; vertical: boolean; docked?: boolean; onActiveContainer?: boolean }) {
  const scheme = useMotionScheme();
  const pop = createEnterProgress("fastSpatial", { scheme });
  const circleSize = () => (props.docked ? "26px" : "28px");
  return (
    <box testId="bar-notifications-badge" style={{
      ...notificationBadge,
      ...(props.vertical
        ? {
            width: circleSize(),
            height: circleSize(),
            maxWidth: circleSize(),
            padding: "0px",
            flexDirection: "column",
            gap: "1px",
            fontSize: "9px",
            lineHeight: "10px",
            overflow: "hidden",
          }
        : {}),
      ...(props.onActiveContainer
        ? { backgroundColor: "color-mix(in srgb, var(--color-on-primary-container) 14%, transparent)" }
        : {}),
      transform: scheme() === "reduced" ? "none" : `scale(${(0.7 + pop() * 0.3).toFixed(4)})`,
    }}>
      <ShellIcon name={props.dnd ? "bellOff" : "bell"} size={props.vertical ? 10 : 12} color={onPrimaryContainer} />
      <text style={{ ...tabular, ...(props.vertical ? { fontSize: "9px", lineHeight: "10px" } : {}) }}>{props.count}</text>
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
  blur: RoundedBlurGroup;
}) {
  const { notifications, togglePanel } = useShellStore();
  const count = () => notifications.data()?.history.length ?? 0;
  const dnd = () => notifications.data()?.dnd ?? false;
  const base = () => segmentChrome(props.vertical, props.docked, props.active, true);
  const blurRef = props.blur.useTarget();
  return (
    <Button ref={blurRef} testId="bar-clock" ariaLabel={props.clock().horizontal}
      data-bar-segment={props.docked ? "docked" : "floating"}
      data-active={props.active ? "true" : null}
      onClick={event => {
        event.stopPropagation();
        togglePanel("calendar", {
          monitorId: props.monitorId,
          parentSurface: props.surfaceName,
          anchorRect: resolveBarPopupAnchor(props.layout, { align: "center", targetRect: getWindowRect(event.currentTarget) }),
        });
      }}
      style={props.vertical
        ? {
            ...base(),
            width: props.docked ? "34px" : "40px",
            gap: "4px",
            // Concentric bottom cap: 28px (R=14) circle inside 40px (R=20) with 1px border -> 1+5=6px inset (6+14=20).
            padding: props.docked
              ? (count() > 0 || dnd() ? "6px 0 4px 0" : "6px 0")
              : (count() > 0 || dnd() ? "8px 0 5px 0" : "8px 0"),
            fontWeight: 600,
            lineHeight: 1.15,
          }
        : {
            ...base(),
            height: props.docked ? "28px" : "32px",
            gap: "8px",
            // Asymmetric optical cap padding: right cap holds 24px (R=12px) badge inside 1px border -> 1+3=4px == vertical inset.
            padding: !props.docked && (count() > 0 || dnd()) ? "0 3px 0 12px" : "0 12px",
            whiteSpace: "nowrap",
          }}>
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
        <NotificationBadgePill count={count()} dnd={dnd()} vertical={props.vertical} docked={props.docked} onActiveContainer={props.active && props.docked} />
      </Show>
    </Button>
  );
}

function SystemMonitorTrigger(props: {
  vertical: boolean;
  docked: boolean;
  active: boolean;
  monitorId: string;
  surfaceName: string;
  layout: ResolvedBarLayout;
  blur: RoundedBlurGroup;
}) {
  const { telemetry, togglePanel } = useShellStore();
  const blurRef = props.blur.useTarget();
  const cpuPct = () => telemetry.data()?.cpu_usage_percent ?? null;
  const ramPct = () => computeMemoryBreakdown(telemetry.data()?.memory)?.usedPercent ?? null;
  const cpuLabel = () => (cpuPct() === null ? "—" : `${Math.round(cpuPct()!)}%`);
  const ramLabel = () => (ramPct() === null ? "—" : `${Math.round(ramPct()!)}%`);
  const sparkline = () => telemetry.data()?.history?.window_60s.cpu_percent ?? null;
  const base = () => segmentChrome(props.vertical, props.docked, props.active, true);

  return (
    <Button
      ref={blurRef}
      testId="bar-sysmon"
      ariaLabel={`System monitor · CPU ${cpuLabel()} · RAM ${ramLabel()}`}
      data-bar-segment={props.docked ? "docked" : "floating"}
      data-active={props.active ? "true" : null}
      onClick={event => {
        event.stopPropagation();
        togglePanel("system-monitor", {
          monitorId: props.monitorId,
          parentSurface: props.surfaceName,
          anchorRect: resolveBarPopupAnchor(props.layout, {
            align: "target",
            targetRect: getWindowRect(event.currentTarget),
          }),
        });
      }}
      style={props.vertical
        ? {
            ...base(),
            width: props.docked ? "34px" : "40px",
            height: props.docked ? "34px" : "40px",
            padding: "0px",
            borderRadius: props.docked ? "8px" : "999px",
            "--zgui-corner-shape": "none",
          }
        : {
            ...base(),
            height: props.docked ? "28px" : "32px",
            // Asymmetric optical cap padding: 24px (R=12) circular pulse badge inside 32px (R=16) capsule with 1px border -> 1+3=4px.
            padding: props.docked ? "0 8px 0 4px" : "0 10px 0 3px",
            gap: "6px",
            whiteSpace: "nowrap",
          }}
    >
      <Show when={props.vertical} fallback={
        <row data-press-visual="compact" style={{ display: "flex", alignItems: "center", gap: "6px", pointerEvents: "none" }}>
          <box ariaHidden style={{
            ...center,
            width: props.docked ? "22px" : "24px",
            height: props.docked ? "22px" : "24px",
            borderRadius: "999px",
            "--zgui-corner-shape": "none",
            backgroundColor: props.active && props.docked
              ? "color-mix(in srgb, var(--color-on-primary-container) 14%, transparent)"
              : primaryContainer,
            flexShrink: 0,
          }}>
            <ShellIcon name="pulse" size={13} color={onPrimaryContainer} />
          </box>
          <text testId="bar-sysmon-cpu" data-tabular="true" style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            fontWeight: 600,
            lineHeight: "14px",
            color: props.active && props.docked ? onPrimaryContainer : onSurface,
            fontVariantNumeric: "tabular-nums",
          }}>
            {cpuLabel()}
          </text>
          <Show when={sparkline()}>
            {series => <MiniSparkline values={series()} color={props.active && props.docked ? onPrimaryContainer : primary} />}
          </Show>
          <Divider vertical={false} short />
          <text testId="bar-sysmon-ram" data-tabular="true" style={{
            fontFamily: "var(--font-mono)",
            fontSize: "11px",
            fontWeight: 500,
            lineHeight: "14px",
            color: props.active && props.docked ? onPrimaryContainer : muted,
            fontVariantNumeric: "tabular-nums",
          }}>
            {ramLabel()}
          </text>
        </row>
      }>
        <box data-press-visual="compact" style={{ ...center, pointerEvents: "none" }}>
          <SplitDualArcGauge
            cpuPercent={cpuPct()}
            ramPercent={ramPct()}
            size={props.docked ? 26 : 30}
            iconColor={props.active && props.docked ? onPrimaryContainer : onSurface}
          />
        </box>
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
  blur: RoundedBlurGroup;
}) {
  const { ime, privacy, network, bluetooth, audio, power, togglePanel, invokePublic, openImeMenu } = useShellStore();
  let systemNode: NativeNode | undefined;
  const blurRef = props.blur.useTarget();
  const quickSettings = (event: NativeEvent) => {
    event.stopPropagation();
    const anchorNode = props.vertical ? (systemNode ?? event.currentTarget) : event.currentTarget;
    togglePanel("quick-settings", {
      monitorId: props.monitorId,
      parentSurface: props.surfaceName,
      anchorRect: resolveBarPopupAnchor(props.layout, { align: "end", targetRect: getWindowRect(anchorNode) }),
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
  const hasIme = () => Boolean(ime.data()?.available && ime.data()?.mode !== "disabled");
  const base = () => segmentChrome(props.vertical, props.docked, props.active);
  const verticalImeSize = () => (props.docked ? "26px" : "30px");
  return (
    <box ref={node => { systemNode = node; blurRef(node); }} testId="bar-system" style={props.vertical
      ? {
          ...base(),
          width: props.docked ? "34px" : "40px",
          gap: "2px",
          // Concentric top cap: 30px (R=15) IME circle inside 40px (R=20) with 1px border -> 1+4=5px inset (5+15=20);
          // generous bottom cap padding keeps icons well inside the bottom semicircle.
          padding: props.docked
            ? "4px 0 6px 0"
            : (hasIme() ? "4px 0 10px 0" : "10px 0"),
        }
      : {
          ...base(),
          height: props.docked ? "28px" : "32px",
          gap: "2px",
          // Asymmetric optical cap padding: left cap holds 24px (R=12px) IME pill inside 1px border -> 1+3=4px == vertical inset.
          padding: !props.docked && hasIme() ? "0 8px 0 3px" : "0 6px",
        }}>
      <Show when={hasIme()}>
        <Button testId="bar-ime" ariaLabel="Input method" ariaHasPopup="menu"
          style={{
            ...center,
            width: props.vertical ? verticalImeSize() : "auto",
            minWidth: props.vertical ? verticalImeSize() : "26px",
            ...(props.vertical ? { maxWidth: verticalImeSize(), overflow: "hidden" } : {}),
            height: props.vertical ? verticalImeSize() : "24px",
            padding: props.vertical ? "0px" : "0 6px",
            borderRadius: "999px",
            "--zgui-corner-shape": "none",
            backgroundColor: props.active && props.docked
              ? "color-mix(in srgb, var(--color-on-primary-container) 14%, transparent)"
              : primaryContainer,
            color: onPrimaryContainer,
            fontWeight: 700,
            fontSize: props.vertical ? (props.docked ? "11px" : "12px") : "11px",
            lineHeight: props.vertical ? "1" : "14px",
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
              const anchorNode = props.vertical ? (systemNode ?? event.currentTarget) : event.currentTarget;
              togglePanel("battery", {
                monitorId: props.monitorId,
                parentSurface: props.surfaceName,
                anchorRect: resolveBarPopupAnchor(props.layout, { align: "end", targetRect: getWindowRect(anchorNode) }),
              });
            }}
            style={{
              ...center,
              flexDirection: props.vertical ? "column" : "row",
              gap: props.vertical ? "2px" : "4px",
              height: props.vertical ? "auto" : "28px",
              padding: props.vertical ? "3px 4px" : "0 4px",
              borderRadius: "8px",
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
  blur: RoundedBlurGroup;
}) {
  const store = useShellStore();
  const { activePanel, togglePanel, dismissOverlay, invokePublic } = store;
  useShellTheme(store.theme.data);
  const workspacesRef = props.blur.useTarget();
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
  const showImeIndicator = createMemo(() => Boolean(store.ime.data()?.available && store.ime.data()?.mode !== "disabled"));
  const trayItems = createMemo(() =>
    (store.tray.data()?.items ?? []).filter(item => !(showImeIndicator() && isImeTrayItem(item))),
  );
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
          {() => {
            const launcherRef = props.blur.useTarget();
            return (
              <Button ref={launcherRef} testId="bar-launcher" ariaLabel="Launcher"
                data-bar-segment={docked() ? "docked" : "floating"}
                data-active={activePanel() === "launcher" ? "true" : null}
                style={vertical()
                  ? { ...segmentChrome(true, docked(), activePanel() === "launcher", true), width: docked() ? "30px" : "40px", height: docked() ? "30px" : "40px" }
                  : { ...segmentChrome(false, docked(), activePanel() === "launcher", true), width: docked() ? "28px" : "32px", height: docked() ? "28px" : "32px" }}
                onClick={event => {
                  event.stopPropagation();
                  togglePanel("launcher", { monitorId: props.monitor.id });
                }}>
                <box data-press-visual="compact" ariaHidden style={center}>
                  <ShellIcon name="apps" size={18} color={primary} />
                </box>
              </Button>
            );
          }}
        </Show>
        <Show when={docked() && props.launcher}><Divider vertical={vertical()} /></Show>
        <box ref={workspacesRef} testId="bar-workspaces" style={vertical()
          ? { ...segmentChrome(true, docked()), width: docked() ? "32px" : "40px", gap: "2px", padding: "8px 0 10px 0" }
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
          <WorkspaceTrack workspaces={workspaces} vertical={vertical()} docked={docked()} activate={activateWorkspace} />
          <Divider vertical={vertical()} short />
          <Button testId="bar-overview" ariaLabel="Overview" selected={activePanel() === "overview"}
            style={vertical() ? verticalIconButton : iconButton}
            onClick={event => {
              event.stopPropagation();
              togglePanel("overview", { monitorId: props.monitor.id });
            }}>
            <box data-press-visual="compact" ariaHidden style={center}>
              <ShellIcon name="overview" size={16} color={activePanel() === "overview" ? primary : muted} />
            </box>
          </Button>
        </box>
        <Show when={activeWindow()}>
          {window => <>
            <Show when={docked()}><Divider vertical={vertical()} /></Show>
            <ActiveWindowPill window={window} vertical={vertical()} docked={docked()} blur={props.blur} />
          </>}
        </Show>
      </box>
      <ClockPill vertical={vertical()} docked={docked()} active={activePanel() === "calendar"}
        clock={props.clock} seconds={props.seconds} monitorId={props.monitor.id} surfaceName={surfaceName()} layout={props.layout} blur={props.blur} />
      <box style={{ ...(vertical() ? verticalGroup : group), justifyContent: "flex-end" }}>
        <Show when={slots().length > 0}>
          {() => {
            const slotsRef = props.blur.useTarget();
            return (
              <box ref={slotsRef} testId="bar-plugin-slots" onClick={event => event.stopPropagation()} style={vertical()
                ? { ...segmentChrome(true, docked()), width: docked() ? "32px" : "40px", gap: "4px", padding: "8px 0" }
                : { ...segmentChrome(false, docked()), height: docked() ? "28px" : "32px", gap: "4px", padding: docked() ? "0 6px" : "0 2px" }}>
                <For each={slots()}>{slot => () => slot.render({ vertical: vertical() })}</For>
              </box>
            );
          }}
        </Show>
        <Show when={player()}>
          {active => {
            const mediaRef = props.blur.useTarget();
            return <>
              <Show when={docked() && slots().length > 0}><Divider vertical={vertical()} /></Show>
              <Button ref={mediaRef} testId="bar-media" ariaLabel={mediaLabel()}
                data-bar-segment={docked() ? "docked" : "floating"}
                data-active={activePanel() === "media" ? "true" : null}
                style={vertical()
                  ? { ...segmentChrome(true, docked(), activePanel() === "media", true), width: docked() ? "30px" : "40px", height: docked() ? "30px" : "40px" }
                  : {
                      ...segmentChrome(false, docked(), activePanel() === "media", true),
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
            </>;
          }}
        </Show>
        <Show when={docked() && (slots().length > 0 || Boolean(player()))}><Divider vertical={vertical()} /></Show>
        <SystemMonitorTrigger
          vertical={vertical()}
          docked={docked()}
          active={activePanel() === "system-monitor"}
          monitorId={props.monitor.id}
          surfaceName={surfaceName()}
          layout={props.layout}
          blur={props.blur}
        />
        <Show when={trayItems().length > 0}>
          {() => {
            const trayRef = props.blur.useTarget();
            return <>
              <Show when={docked()}><Divider vertical={vertical()} /></Show>
              <box ref={trayRef} testId="bar-tray" style={vertical()
                ? { ...segmentChrome(true, docked()), width: docked() ? "30px" : "40px", gap: "2px", padding: "8px 0" }
                : { ...segmentChrome(false, docked()), height: docked() ? "28px" : "32px", gap: "2px", padding: "0 4px" }}>
                <For each={trayItems()} keyed={item => item.id}>
                  {item => <TrayButton item={item()} vertical={vertical()} monitorId={props.monitor.id} surfaceName={surfaceName()} layout={props.layout} />}
                </For>
              </box>
            </>;
          }}
        </Show>
        <Show when={docked()}><Divider vertical={vertical()} /></Show>
        <SystemPill vertical={vertical()} docked={docked()} active={activePanel() === "quick-settings" || activePanel() === "battery"}
          monitorId={props.monitor.id} surfaceName={surfaceName()} layout={props.layout} blur={props.blur} />
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
        const blur = createRoundedBlurGroup(
          () => (layout().isVertical ? 20 : 16),
          () => layout().style === "floating",
        );
        return (
          <LayerSurface name={formatSurfaceName("bar", monitor().id)} output={monitor().id} layer="top" anchor={[...layout().anchor]}
            width={layout().width} height={layout().height} margin={layout().margin} exclusiveZone={layout().exclusiveZone}
            inputRegion={layout().inputRegion ? [...layout().inputRegion!] : "full"} blurRegion={blur.region()} keyboard="none">
            <BarContent monitor={monitor()} layout={layout()} launcher={barSettings().launcher_enabled !== false} clock={clock} seconds={clockSeconds()} blur={blur} />
          </LayerSurface>
        );
      }}
    </For>
  );
}
