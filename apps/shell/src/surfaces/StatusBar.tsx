import {
  Button, For, Image, LayerSurface, Show, createDelay, createEffect, createMemo, createSignal, cx, getWindowRect, onCleanup,
  type Accessor, type ButtonProps, type Monitor, type NativeNode, type NativeStyle, type NativeWheelEvent, type NativeWindowRect,
} from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { MiniSparkline, SplitDualArcGauge } from "../charts/TelemetryCharts.tsx";
import { MediaEqIcon, ShellIcon } from "../icons.tsx";
import { SPRING_EPSILON, createEnterProgress, createM3Spring, useMotionScheme } from "../motion.ts";
import { useShellStore, type PluginBarWidgetSlot } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import {
  DEFAULT_BAR_SETTINGS, computeMemoryBreakdown, filterWorkspacesForMonitor, findActiveWindowForMonitor,
  formatBarClock, formatSurfaceName, hasTrayMenu, isImeTrayItem, isMediaPlayerAudible, isTrayActivateMenuFallback, partitionPluginBarWidgets, partitionTrayItems, resolveBarLayout, resolveBarPopupAnchor, resolveDesktopApp, resolveWorkspaceLabel, selectActiveMediaPlayer,
  type ResolvedBarLayout, type TrayItem, type WaylandWindow, type WaylandWorkspace,
} from "../topics.ts";
import styles from "./StatusBar.module.css";

interface BarClock {
  readonly horizontal: string;
  readonly hours: string;
  readonly minutes: string;
  readonly seconds: string;
}

type StyleObj = Exclude<NativeStyle, string>;
type TrackBlurNode = (node: NativeNode) => () => void;

function useBlurRef(track: TrackBlurNode): (node: NativeNode) => void {
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

function Divider(props: { vertical: boolean; short?: boolean }) {
  return (
    <box
      ariaHidden
      data-vertical={props.vertical ? "true" : "false"}
      data-short={props.short ? "true" : "false"}
      class={styles.divider}
    />
  );
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

const WS_SLOT_WIDTH_H = 24;
const WS_SLOT_GAP = 2;

function WorkspaceButton(props: {
  workspace: WaylandWorkspace;
  ordinalIndex: number;
  vertical: boolean;
  docked: boolean;
  workspaceNumbers: boolean;
  activate: () => void;
  registerNode: (id: number, node: NativeNode) => void;
}) {
  const scheme = useMotionScheme();
  const activeFade = createM3Spring(() => (props.workspace.active ? 1 : 0), "fastEffects", { scheme });
  const label = () => resolveWorkspaceLabel(props.workspace, props.workspaceNumbers, props.ordinalIndex);
  const compact = () => props.docked || props.vertical;
  return (
    <Button
      ref={node => props.registerNode(props.workspace.workspace_id, node)}
      testId={`ws-${props.workspace.workspace_id}`}
      ariaLabel={label() ? `Workspace ${label()}` : `Workspace ${props.ordinalIndex + 1}`}
      onClick={props.activate}
      data-vertical={props.vertical ? "true" : "false"}
      data-docked={props.docked ? "true" : "false"}
      data-wide-active={!props.vertical && props.workspace.active && label().length > 1 ? "true" : "false"}
      class={styles.wsButton}
    >
      <box data-press-visual="compact" ariaHidden class={styles.wsButtonInner}>
        <Show when={props.workspace.active} fallback={
          <box
            testId={`ws-dot-${props.workspace.workspace_id}`}
            ariaHidden
            data-compact={compact() ? "true" : "false"}
            data-urgent={props.workspace.urgent ? "true" : "false"}
            class={styles.wsDot}
            style={{
              opacity: props.workspace.urgent ? 1 : Math.max(0.15, (1 - activeFade()) * 0.55),
              transform: scheme() === "reduced" ? "none" : `scale(${(1 - activeFade() * 0.3).toFixed(4)})`,
            }}
          />
        }>
          <Show when={label().length > 0} fallback={
            <box
              testId={`ws-cutout-${props.workspace.workspace_id}`}
              ariaHidden
              data-compact={compact() ? "true" : "false"}
              data-docked={props.docked ? "true" : "false"}
              class={styles.wsCutout}
              style={{ opacity: Math.max(0, Math.min(1, activeFade())) }}
            />
          }>
            <text
              data-vertical={props.vertical ? "true" : "false"}
              data-urgent={props.workspace.urgent ? "true" : "false"}
              class={styles.wsActiveLabel}
              style={{ opacity: Math.max(0, Math.min(1, activeFade())) }}
            >
              {label()}
            </text>
          </Show>
        </Show>
      </box>
    </Button>
  );
}

function WorkspaceTrack(props: {
  workspaces: Accessor<readonly WaylandWorkspace[]>;
  vertical: boolean;
  docked: boolean;
  workspaceNumbers: boolean;
  activate: (id: number) => void;
}) {
  const scheme = useMotionScheme();
  const indexedWorkspaces = createMemo(() =>
    props.workspaces().map((workspace, ordinalIndex) => ({ workspace, ordinalIndex })),
  );
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
      const btnSize = props.docked ? 24 : 28;
      return { offset: idx * (btnSize + WS_SLOT_GAP), size: btnSize };
    }
    const minSlot = WS_SLOT_WIDTH_H;
    const label = ws ? resolveWorkspaceLabel(ws, props.workspaceNumbers, idx) : "";
    const estWidth = label.length > 1 ? Math.max(minSlot, label.length * 7 + 12) : minSlot;
    return { offset: idx * (minSlot + WS_SLOT_GAP), size: estWidth };
  };

  const measureActiveRect = (): { readonly offset: number; readonly size: number } | null => {
    const ws = activeWorkspace();
    if (!ws || !trackNode) return null;
    const btn = buttonNodes.get(ws.workspace_id);
    if (!btn) return null;
    const trackRect = getWindowRect(trackNode);
    const btnRect = getWindowRect(btn);
    if (!trackRect || !btnRect || btnRect.width <= 1 || btnRect.height <= 1) return null;
    if (props.vertical) {
      return { offset: btnRect.y - trackRect.y, size: btnRect.height };
    }
    return { offset: btnRect.x - trackRect.x, size: Math.max(WS_SLOT_WIDTH_H, btnRect.width) };
  };

  const [targetOffset, setTargetOffset] = createSignal(fallbackRect().offset);
  const [targetSize, setTargetSize] = createSignal(fallbackRect().size);
  const slideOffset = createM3Spring(targetOffset, "fastSpatial", { scheme, epsilon: SPRING_EPSILON.px });
  const slideSize = createM3Spring(targetSize, "fastSpatial", { scheme, epsilon: SPRING_EPSILON.px });
  const pillOpacity = createM3Spring(() => (activeIndex() >= 0 ? 1 : 0), "fastEffects", { scheme });

  let initialized = false;
  createEffect(
    () => [activeWorkspace()?.workspace_id, props.workspaces().length, props.vertical, props.docked, props.workspaceNumbers] as const,
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
    <box
      ref={node => { trackNode = node; }}
      data-vertical={props.vertical ? "true" : "false"}
      class={styles.wsTrack}
    >
      <box
        data-active-indicator="true"
        ariaHidden
        data-vertical={props.vertical ? "true" : "false"}
        data-docked={props.docked ? "true" : "false"}
        data-urgent={activeWorkspace()?.urgent ? "true" : "false"}
        class={styles.wsIndicator}
        style={props.vertical
          ? {
              height: `${Math.max(props.docked ? 24 : 28, slideSize()).toFixed(2)}px`,
              opacity: Math.max(0, Math.min(1, pillOpacity())),
              transform: `translateY(${slideOffset().toFixed(2)}px)`,
            }
          : {
              width: `${Math.max(WS_SLOT_WIDTH_H, slideSize()).toFixed(2)}px`,
              opacity: Math.max(0, Math.min(1, pillOpacity())),
              transform: `translateX(${slideOffset().toFixed(2)}px)`,
            }}
      />
      <For each={indexedWorkspaces()} keyed={entry => entry.workspace.workspace_id}>
        {entry => (
          <WorkspaceButton
            workspace={entry().workspace}
            ordinalIndex={entry().ordinalIndex}
            vertical={props.vertical}
            docked={props.docked}
            workspaceNumbers={props.workspaceNumbers}
            activate={() => props.activate(entry().workspace.workspace_id)}
            registerNode={registerNode}
          />
        )}
      </For>
    </box>
  );
}

function ActiveWindowPill(props: { window: Accessor<WaylandWindow>; vertical: boolean; docked: boolean; trackBlur: TrackBlurNode }) {
  const { apps, hostClient } = useShellStore();
  const app = createMemo(() => resolveDesktopApp(apps.data()?.apps, props.window().app_id));
  const { src } = useDaemonMedia(hostClient, () => app()?.icon, { fetchCommand: "launcher.fetch-blob" });
  const blurRef = useBlurRef(node => props.trackBlur(node));
  return (
    <box
      ref={blurRef}
      testId="bar-active-window"
      ariaLabel={props.window().title}
      data-vertical={props.vertical ? "true" : "false"}
      data-docked={props.docked ? "true" : "false"}
      class={cx(styles.segment, styles.segmentSurface, styles.activeWindow)}
    >
      <Show when={src()} fallback={
        props.vertical
          ? (
            <box data-docked={props.docked ? "true" : "false"} class={styles.activeWindowFallback}>
              <ShellIcon name="terminal" size={14} color="var(--color-primary)" />
            </box>
          )
          : <ShellIcon name="terminal" size={16} color="var(--color-primary)" />
      }>
        {image => (
          <Image
            ariaHidden
            src={image()}
            data-vertical={props.vertical ? "true" : "false"}
            class={styles.activeWindowIcon}
          />
        )}
      </Show>
      <Show when={!props.vertical}>
        <text testId="bar-active-window-title" class={styles.activeWindowTitle}>
          {props.window().title ?? app()?.title ?? props.window().app_id}
        </text>
      </Show>
    </box>
  );
}

function TrayButton(props: { item: TrayItem; vertical: boolean; docked: boolean; monitorId: string; surfaceName: string; layout: ResolvedBarLayout }) {
  const { hostClient, invokePublic, openTrayMenu } = useShellStore();
  const { src } = useDaemonMedia(hostClient, () => props.item.icon, { fetchCommand: "tray.fetch-blob" });
  const anchorFor = (node: NativeNode): NativeWindowRect =>
    resolveBarPopupAnchor(props.layout, { align: "target", targetRect: getWindowRect(node) });
  const fallbackLetter = () => {
    const trimmed = props.item.title?.trim() ?? "";
    const first = trimmed ? Array.from(trimmed)[0] : undefined;
    return first && /^[\p{L}\p{N}]$/u.test(first) ? first.toUpperCase() : null;
  };
  const large = () => props.vertical && !props.docked;
  return (
    <Button
      testId={`tray-item-${props.item.id}`}
      ariaLabel={props.item.title || props.item.id}
      data-vertical={props.vertical ? "true" : "false"}
      data-docked={props.docked ? "true" : "false"}
      class={styles.trayButton}
      onClick={event => {
        const item = props.item;
        const anchorRect = anchorFor(event.currentTarget);
        if (item.item_is_menu && hasTrayMenu(item)) {
          event.stopPropagation();
          openTrayMenu({ itemId: item.id, monitorId: props.monitorId, parentSurface: props.surfaceName, anchorRect });
        } else {
          void invokePublic("tray.activate", { id: item.id }).then(res => {
            if (isTrayActivateMenuFallback(res)) {
              openTrayMenu({
                itemId: item.id,
                monitorId: props.monitorId,
                parentSurface: props.surfaceName,
                anchorRect,
              });
            }
          });
        }
      }}
      {...secondaryAction(node => {
        const item = props.item;
        if (hasTrayMenu(item)) {
          openTrayMenu({ itemId: item.id, monitorId: props.monitorId, parentSurface: props.surfaceName, anchorRect: anchorFor(node) });
        } else {
          void invokePublic("tray.context-menu", { id: item.id });
        }
      })}
    >
      <box data-press-visual="compact" ariaHidden class={styles.pressInner}>
        <Show when={src()} fallback={
          <Show when={fallbackLetter()} fallback={
            <box data-large={large() ? "true" : "false"} class={styles.trayFallback}>
              <ShellIcon name="apps" size={12} color="var(--color-on-surface-variant)" />
            </box>
          }>
            {letter => (
              <box data-large={large() ? "true" : "false"} class={styles.trayLetterFallback}>
                <text>{letter()}</text>
              </box>
            )}
          </Show>
        }>
          {image => <Image src={image()} data-large={large() ? "true" : "false"} class={styles.trayIconImage} />}
        </Show>
      </box>
    </Button>
  );
}

function NotificationBadgePill(props: { count: number; dnd: boolean; vertical: boolean; docked?: boolean; onActiveContainer?: boolean }) {
  const scheme = useMotionScheme();
  const pop = createEnterProgress("fastSpatial", { scheme });
  return (
    <box
      testId="bar-notifications-badge"
      data-vertical={props.vertical ? "true" : "false"}
      data-docked={props.docked ? "true" : "false"}
      data-on-active={props.onActiveContainer ? "true" : "false"}
      class={styles.notificationBadge}
      style={{ transform: scheme() === "reduced" ? "none" : `scale(${(0.7 + pop() * 0.3).toFixed(4)})` }}
    >
      <ShellIcon
        name={props.dnd ? "bellOff" : "bell"}
        size={props.vertical ? 10 : props.docked ? 11 : 12}
        color="var(--color-on-primary-container)"
      />
      <text
        data-vertical={props.vertical ? "true" : "false"}
        data-docked={props.docked ? "true" : "false"}
        class={styles.notificationCount}
      >
        {props.count}
      </text>
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
  trackBlur: TrackBlurNode;
}) {
  const { notifications, togglePanel } = useShellStore();
  const count = () => notifications.data()?.history.length ?? 0;
  const dnd = () => notifications.data()?.dnd ?? false;
  const hasBadge = () => count() > 0 || dnd();
  const blurRef = useBlurRef(node => props.trackBlur(node));
  return (
    <Button
      ref={blurRef}
      testId="bar-clock"
      ariaLabel={props.clock().horizontal}
      data-bar-segment={props.docked ? "docked" : "floating"}
      data-active={props.active ? "true" : null}
      data-vertical={props.vertical ? "true" : "false"}
      data-docked={props.docked ? "true" : "false"}
      data-has-badge={hasBadge() ? "true" : "false"}
      class={cx(styles.segment, styles.clockButton)}
      onClick={event => {
        event.stopPropagation();
        togglePanel("calendar", {
          monitorId: props.monitorId,
          parentSurface: props.surfaceName,
          anchorRect: resolveBarPopupAnchor(props.layout, { align: "center", targetRect: getWindowRect(event.currentTarget) }),
        });
      }}
    >
      <box data-press-visual="compact" data-vertical={props.vertical ? "true" : "false"} class={styles.clockInner}>
        <Show when={props.vertical} fallback={
          <text testId="bar-clock-text" class={styles.clockText}>{props.clock().horizontal}</text>
        }>
          <box testId="bar-clock-text" class={styles.clockStack}>
            <text class={styles.clockDigit}>{props.clock().hours}</text>
            <text class={styles.clockDigit}>{props.clock().minutes}</text>
            <Show when={props.seconds}><text class={styles.clockSeconds}>{props.clock().seconds}</text></Show>
          </box>
        </Show>
        <Show when={hasBadge()}>
          <Divider vertical={props.vertical} short />
          <NotificationBadgePill count={count()} dnd={dnd()} vertical={props.vertical} docked={props.docked} onActiveContainer={props.active && props.docked} />
        </Show>
      </box>
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
  trackBlur: TrackBlurNode;
}) {
  const { telemetry, togglePanel } = useShellStore();
  const blurRef = useBlurRef(node => props.trackBlur(node));
  const cpuPct = () => telemetry.data()?.cpu_usage_percent ?? null;
  const ramPct = () => computeMemoryBreakdown(telemetry.data()?.memory)?.usedPercent ?? null;
  const cpuLabel = () => (cpuPct() === null ? "—" : `${Math.round(cpuPct()!)}%`);
  const ramLabel = () => (ramPct() === null ? "—" : `${Math.round(ramPct()!)}%`);
  const sparkline = () => telemetry.data()?.history?.window_60s.cpu_percent ?? null;
  const onActiveDocked = () => props.active && props.docked;

  return (
    <Button
      ref={blurRef}
      testId="bar-sysmon"
      ariaLabel={`System monitor · CPU ${cpuLabel()} · RAM ${ramLabel()}`}
      data-bar-segment={props.docked ? "docked" : "floating"}
      data-active={props.active ? "true" : null}
      data-vertical={props.vertical ? "true" : "false"}
      data-docked={props.docked ? "true" : "false"}
      class={cx(styles.segment, styles.sysmonButton)}
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
    >
      <Show when={props.vertical} fallback={
        <row data-press-visual="compact" class={styles.sysmonRow}>
          <box
            ariaHidden
            data-docked={props.docked ? "true" : "false"}
            data-on-active={onActiveDocked() ? "true" : "false"}
            class={styles.sysmonBadge}
          >
            <ShellIcon name="pulse" size={13} color="var(--color-on-primary-container)" />
          </box>
          <text
            testId="bar-sysmon-cpu"
            data-tabular="true"
            data-on-active={onActiveDocked() ? "true" : "false"}
            class={styles.sysmonCpu}
          >
            {cpuLabel()}
          </text>
          <Show when={sparkline()}>
            {series => <MiniSparkline values={series()} color={onActiveDocked() ? "var(--color-on-primary-container)" : "var(--color-primary)"} />}
          </Show>
          <Divider vertical={false} short />
          <text
            testId="bar-sysmon-ram"
            data-tabular="true"
            data-on-active={onActiveDocked() ? "true" : "false"}
            class={styles.sysmonRam}
          >
            {ramLabel()}
          </text>
        </row>
      }>
        <box data-press-visual="compact" class={styles.pressInner}>
          <SplitDualArcGauge
            cpuPercent={cpuPct()}
            ramPercent={ramPct()}
            size={props.docked ? 26 : 30}
            iconColor={onActiveDocked() ? "var(--color-on-primary-container)" : "var(--color-on-surface)"}
          />
        </box>
      </Show>
    </Button>
  );
}

function SystemPill(props: {
  vertical: boolean;
  docked: boolean;
  monitorId: string;
  surfaceName: string;
  layout: ResolvedBarLayout;
  trackBlur: TrackBlurNode;
}) {
  const {
    ime, idle, privacy, network, bluetooth, audio, power,
    activePanel, activePanelTarget, quickSettingsPage, activeImeMenu,
    togglePanel, toggleQuickSettingsPage, invokePublic, openImeMenu, openSettingsWindow,
  } = useShellStore();
  let systemNode: NativeNode | undefined;
  const blurRef = useBlurRef(node => props.trackBlur(node));
  const anchorFor = (targetNode: NativeNode): NativeWindowRect =>
    resolveBarPopupAnchor(props.layout, { align: "end", targetRect: getWindowRect(props.vertical ? (systemNode ?? targetNode) : targetNode) });
  const qsOpenHere = () => activePanel() === "quick-settings"
    && (activePanelTarget()?.parentSurface === props.surfaceName || activePanelTarget()?.monitorId === props.monitorId);
  const batteryPanelHere = () => activePanel() === "battery"
    && (activePanelTarget()?.parentSurface === props.surfaceName || activePanelTarget()?.monitorId === props.monitorId);
  const networkActive = () => qsOpenHere() && quickSettingsPage() === "wifi";
  const bluetoothActive = () => qsOpenHere() && quickSettingsPage() === "bluetooth";
  const audioActive = () => qsOpenHere() && quickSettingsPage() === "sound";
  const batteryActive = () => batteryPanelHere() || (qsOpenHere() && quickSettingsPage() === "battery");
  const mainQsActive = () => qsOpenHere() && quickSettingsPage() === "main";
  const imeActive = () => activeImeMenu()?.parentSurface === props.surfaceName;
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

  return (
    <box
      ref={node => { systemNode = node; blurRef(node); }}
      testId="bar-system"
      data-vertical={props.vertical ? "true" : "false"}
      data-docked={props.docked ? "true" : "false"}
      data-has-ime={hasIme() ? "true" : "false"}
      class={cx(styles.segment, styles.segmentSurface, styles.systemPill)}
    >
      <Show when={hasIme()}>
        <Button
          testId="bar-ime"
          ariaLabel="Input method"
          ariaHasPopup="menu"
          data-vertical={props.vertical ? "true" : "false"}
          data-docked={props.docked ? "true" : "false"}
          data-active={imeActive() ? "true" : "false"}
          data-on-active="false"
          class={styles.imeButton}
          onClick={() => { void invokePublic("ime.toggle", {}); }}
          {...secondaryAction(node => {
            openImeMenu({
              monitorId: props.monitorId,
              parentSurface: props.surfaceName,
              anchorRect: resolveBarPopupAnchor(props.layout, { align: "target", targetRect: getWindowRect(node) }),
            });
          })}
        >
          <box data-press-visual="compact" ariaHidden class={styles.pressInner}>
            <text>{ime.data()?.active_im?.short_label || "EN"}</text>
          </box>
        </Button>
        <Show when={!props.docked}>
          <Divider vertical={props.vertical} />
        </Show>
      </Show>
      <Show when={idle.data()?.caffeine}>
        <Button
          testId="bar-keep-awake"
          ariaLabel="Keep awake active"
          data-vertical={props.vertical ? "true" : "false"}
          data-docked={props.docked ? "true" : "false"}
          class={styles.sysBtn}
          onClick={event => {
            event.stopPropagation();
            openSettingsWindow("idle");
          }}
        >
          <box data-press-visual="compact" ariaHidden class={styles.pressInner}>
            <ShellIcon name="coffee" size={14} color="var(--color-primary)" />
          </box>
        </Button>
      </Show>
      <Show when={privacy.data()?.audio_capture.state === "active"}>
        <Button
          testId="bar-privacy"
          ariaLabel="Microphone in use"
          data-vertical={props.vertical ? "true" : "false"}
          data-docked={props.docked ? "true" : "false"}
          class={cx(styles.sysBtn, styles.privacyButton)}
          onClick={event => {
            event.stopPropagation();
            toggleQuickSettingsPage("sound", {
              monitorId: props.monitorId,
              parentSurface: props.surfaceName,
              anchorRect: anchorFor(event.currentTarget),
            });
          }}
        >
          <box data-press-visual="compact" ariaHidden class={styles.pressInner}>
            <ShellIcon name="mic" size={13} color="var(--color-on-error-container)" />
          </box>
        </Button>
      </Show>
      <Button
        testId="bar-network"
        ariaLabel="Network settings"
        data-vertical={props.vertical ? "true" : "false"}
        data-docked={props.docked ? "true" : "false"}
        data-active={networkActive() ? "true" : "false"}
        class={styles.sysBtn}
        onClick={event => {
          event.stopPropagation();
          toggleQuickSettingsPage("wifi", {
            monitorId: props.monitorId,
            parentSurface: props.surfaceName,
            anchorRect: anchorFor(event.currentTarget),
          });
        }}
      >
        <box data-press-visual="compact" ariaHidden class={styles.pressInner}>
          <ShellIcon
            name={networkIcon()}
            size={15}
            color={networkActive() ? "var(--color-on-primary-container)" : networkIcon() === "wifiOff" ? "var(--color-on-surface-variant)" : "var(--color-on-surface)"}
          />
        </box>
      </Button>
      <Button
        testId="bar-bluetooth"
        ariaLabel="Bluetooth settings"
        data-vertical={props.vertical ? "true" : "false"}
        data-docked={props.docked ? "true" : "false"}
        data-active={bluetoothActive() ? "true" : "false"}
        class={styles.sysBtn}
        onClick={event => {
          event.stopPropagation();
          toggleQuickSettingsPage("bluetooth", {
            monitorId: props.monitorId,
            parentSurface: props.surfaceName,
            anchorRect: anchorFor(event.currentTarget),
          });
        }}
      >
        <box data-press-visual="compact" ariaHidden class={styles.pressInner}>
          <ShellIcon
            name={bluetoothPowered() || bluetoothConnected() ? "bluetooth" : "bluetoothOff"}
            size={15}
            color={bluetoothActive() ? "var(--color-on-primary-container)" : bluetoothConnected() ? "var(--color-primary)" : bluetoothPowered() ? "var(--color-on-surface)" : "var(--color-on-surface-variant)"}
          />
        </box>
      </Button>
      <Button
        testId="bar-audio"
        ariaLabel="Audio settings"
        data-vertical={props.vertical ? "true" : "false"}
        data-docked={props.docked ? "true" : "false"}
        data-active={audioActive() ? "true" : "false"}
        class={styles.sysBtn}
        onClick={event => {
          event.stopPropagation();
          toggleQuickSettingsPage("sound", {
            monitorId: props.monitorId,
            parentSurface: props.surfaceName,
            anchorRect: anchorFor(event.currentTarget),
          });
        }}
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
        })}
      >
        <box data-press-visual="compact" ariaHidden class={styles.pressInner}>
          <ShellIcon name={audioIcon()} size={15} color={audioActive() ? "var(--color-on-primary-container)" : "var(--color-on-surface)"} />
        </box>
      </Button>
      <Show when={power.data()?.battery}>
        {battery => (
          <Button
            testId="bar-battery"
            ariaLabel="Battery"
            data-vertical={props.vertical ? "true" : "false"}
            data-docked={props.docked ? "true" : "false"}
            data-active={batteryActive() ? "true" : "false"}
            class={styles.batteryButton}
            onClick={event => {
              event.stopPropagation();
              togglePanel("battery", {
                monitorId: props.monitorId,
                parentSurface: props.surfaceName,
                anchorRect: anchorFor(event.currentTarget),
              });
            }}
          >
            <box data-press-visual="compact" ariaHidden data-vertical={props.vertical ? "true" : "false"} class={styles.batteryInner}>
              <ShellIcon
                name={battery().state === "charging" || battery().state === "full" ? "batteryCharging" : "battery"}
                size={15}
                color={batteryActive()
                  ? "var(--color-on-primary-container)"
                  : battery().state === "discharging" && (battery().percentage ?? 100) < 20
                    ? "var(--color-error)"
                    : battery().state === "charging"
                      ? "var(--color-primary)"
                      : "var(--color-on-surface)"}
              />
              <text testId="bar-battery-text" data-tabular="true" class={styles.batteryText}>
                {battery().percentage == null ? "—" : `${Math.round(battery().percentage ?? 0)}%`}
              </text>
            </box>
          </Button>
        )}
      </Show>
      <Button
        testId="bar-quick-settings"
        ariaLabel="Quick settings"
        data-vertical={props.vertical ? "true" : "false"}
        data-docked={props.docked ? "true" : "false"}
        data-active={mainQsActive() ? "true" : "false"}
        class={styles.sysBtn}
        onClick={event => {
          event.stopPropagation();
          toggleQuickSettingsPage("main", {
            monitorId: props.monitorId,
            parentSurface: props.surfaceName,
            anchorRect: anchorFor(event.currentTarget),
          });
        }}
      >
        <box data-press-visual="compact" ariaHidden class={styles.pressInner}>
          <ShellIcon
            name="tune"
            size={15}
            color={mainQsActive() ? "var(--color-on-primary-container)" : "var(--color-on-surface)"}
          />
        </box>
      </Button>
    </box>
  );
}

function PluginSlotIsland(props: {
  slot: PluginBarWidgetSlot;
  vertical: boolean;
  docked: boolean;
  monitorId: string;
  trackBlur: TrackBlurNode;
}) {
  const { activePluginPanelTarget } = useShellStore();
  const blurRef = useBlurRef(node => props.trackBlur(node));
  const active = () => {
    const target = activePluginPanelTarget();
    return Boolean(
      target
      && props.slot.pluginId
      && target.pluginId === props.slot.pluginId
      && (target.monitorId == null || target.monitorId === props.monitorId),
    );
  };
  return (
    <box
      ref={blurRef}
      testId={`bar-plugin-slot-${props.slot.id}`}
      data-active={active() ? "true" : null}
      data-vertical={props.vertical ? "true" : "false"}
      data-docked={props.docked ? "true" : "false"}
      onClick={event => event.stopPropagation()}
      class={cx(styles.segment, styles.segmentSurface, styles.pluginSlot)}
    >
      {props.slot.render({ vertical: props.vertical })}
    </box>
  );
}

function BarContent(props: {
  monitor: Monitor;
  layout: ResolvedBarLayout;
  launcher: boolean;
  workspaceNumbers: boolean;
  clock: Accessor<BarClock>;
  seconds: boolean;
  trackBlur: TrackBlurNode;
}) {
  const store = useShellStore();
  const { activePanel, togglePanel, dismissOverlay, invokePublic } = store;
  useShellTheme(store.theme.data);
  const workspacesRef = useBlurRef(node => props.trackBlur(node));
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
  const pluginZones = createMemo(() =>
    partitionPluginBarWidgets(store.pluginBarWidgets(), store.settings.data()?.bar.plugins, props.monitor),
  );
  const showImeIndicator = createMemo(() => Boolean(store.ime.data()?.available && store.ime.data()?.mode !== "disabled"));
  const trayItems = createMemo(() =>
    (store.tray.data()?.items ?? []).filter(item => !(showImeIndicator() && isImeTrayItem(item))),
  );
  const trayPartition = createMemo(() => partitionTrayItems(trayItems(), store.settings.data()?.bar.tray));
  const activateWorkspace = (id: number) => { void invokePublic("wayland.workspace.activate", { workspace_id: id }); };

  const rootStyle = createMemo((): StyleObj => {
    const isDocked = docked();
    const isVertical = vertical();
    const bleed = props.layout.shadowBleed;
    const sizeStyle: StyleObj = isVertical
      ? { width: `${props.layout.width}px`, height: `${props.layout.height}px` }
      : { height: `${props.layout.height}px` };
    if (isDocked) return sizeStyle;
    return {
      ...sizeStyle,
      padding: `${bleed.top}px ${bleed.right}px ${bleed.bottom}px ${bleed.left}px`,
    };
  });

  return (
    <box
      testId={`bar-root-${props.monitor.id}`}
      data-theme-rev={String(store.theme.revision())}
      data-position={props.layout.position}
      data-bar-style={props.layout.style}
      data-vertical={vertical() ? "true" : "false"}
      data-active-panel={activePanel() ?? "none"}
      onPointerDown={() => store.recordBarPointerDown()}
      onClick={() => dismissOverlay()}
      class={styles.barRoot}
      style={rootStyle()}
    >
      <box data-vertical={vertical() ? "true" : "false"} class={styles.group}>
        <Show when={props.launcher}>
          {() => {
            const launcherRef = useBlurRef(props.trackBlur);
            return (
              <Button
                ref={launcherRef}
                testId="bar-launcher"
                ariaLabel="Launcher"
                data-bar-segment={docked() ? "docked" : "floating"}
                data-active={activePanel() === "launcher" ? "true" : null}
                data-vertical={vertical() ? "true" : "false"}
                data-docked={docked() ? "true" : "false"}
                class={cx(styles.segment, styles.launcherButton)}
                onClick={event => {
                  event.stopPropagation();
                  togglePanel("launcher", { monitorId: props.monitor.id });
                }}
              >
                <box data-press-visual="compact" ariaHidden class={styles.pressInner}>
                  <ShellIcon name="apps" size={18} color="var(--color-primary)" />
                </box>
              </Button>
            );
          }}
        </Show>
        <box
          ref={workspacesRef}
          testId="bar-workspaces"
          data-vertical={vertical() ? "true" : "false"}
          data-docked={docked() ? "true" : "false"}
          class={cx(styles.segment, styles.segmentSurface, styles.workspacesIsland)}
          onWheel={event => {
            const direction = wheelDirection(event);
            const items = workspaces();
            if (!direction || items.length === 0) return;
            event.preventDefault();
            const active = items.findIndex(workspace => workspace.active);
            const next = active < 0 ? (direction > 0 ? 0 : items.length - 1) : (active + direction + items.length) % items.length;
            const target = items[next];
            if (next !== active && target) activateWorkspace(target.workspace_id);
          }}
        >
          <WorkspaceTrack workspaces={workspaces} vertical={vertical()} docked={docked()} workspaceNumbers={props.workspaceNumbers} activate={activateWorkspace} />
          <Show when={workspaces().length > 0}><Divider vertical={vertical()} short /></Show>
          <Button
            testId="bar-overview"
            ariaLabel="Overview"
            selected={activePanel() === "overview"}
            data-vertical={vertical() ? "true" : "false"}
            data-docked={docked() ? "true" : "false"}
            class={styles.overviewButton}
            onClick={event => {
              event.stopPropagation();
              togglePanel("overview", { monitorId: props.monitor.id });
            }}
          >
            <box data-press-visual="compact" ariaHidden class={styles.pressInner}>
              <ShellIcon
                name="overview"
                size={docked() ? 14 : 15}
                color={activePanel() === "overview" ? "var(--color-primary)" : "var(--color-on-surface-variant)"}
              />
            </box>
          </Button>
        </box>
        <Show when={activeWindow()}>
          {window => <ActiveWindowPill window={window} vertical={vertical()} docked={docked()} trackBlur={props.trackBlur} />}
        </Show>
        <For each={pluginZones().left} keyed={slot => slot.id}>
          {slot => <PluginSlotIsland slot={slot()} vertical={vertical()} docked={docked()} monitorId={props.monitor.id} trackBlur={props.trackBlur} />}
        </For>
      </box>
      <Show when={pluginZones().center.length > 0} fallback={
        <ClockPill vertical={vertical()} docked={docked()} active={activePanel() === "calendar"}
          clock={props.clock} seconds={props.seconds} monitorId={props.monitor.id} surfaceName={surfaceName()} layout={props.layout} trackBlur={props.trackBlur} />
      }>
        <box data-vertical={vertical() ? "true" : "false"} class={styles.centerZone}>
          <ClockPill vertical={vertical()} docked={docked()} active={activePanel() === "calendar"}
            clock={props.clock} seconds={props.seconds} monitorId={props.monitor.id} surfaceName={surfaceName()} layout={props.layout} trackBlur={props.trackBlur} />
          <For each={pluginZones().center} keyed={slot => slot.id}>
            {slot => <PluginSlotIsland slot={slot()} vertical={vertical()} docked={docked()} monitorId={props.monitor.id} trackBlur={props.trackBlur} />}
          </For>
        </box>
      </Show>
      <box data-vertical={vertical() ? "true" : "false"} data-align="end" class={styles.group}>
        <For each={pluginZones().right} keyed={slot => slot.id}>
          {slot => <PluginSlotIsland slot={slot()} vertical={vertical()} docked={docked()} monitorId={props.monitor.id} trackBlur={props.trackBlur} />}
        </For>
        <Show when={player()}>
          {active => {
            const mediaRef = useBlurRef(props.trackBlur);
            const mediaAudible = () => isMediaPlayerAudible(active(), store.audio.data());
            const dockedMediaActive = () => docked() && activePanel() === "media";
            const mediaActiveColor = () => (dockedMediaActive() ? "var(--color-on-primary-container)" : "var(--color-primary)");
            const mediaInactiveColor = () => (dockedMediaActive() ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)");
            return (
              <Button
                ref={mediaRef}
                testId="bar-media"
                ariaLabel={mediaLabel()}
                data-bar-segment={docked() ? "docked" : "floating"}
                data-active={activePanel() === "media" ? "true" : null}
                data-vertical={vertical() ? "true" : "false"}
                data-docked={docked() ? "true" : "false"}
                class={cx(styles.segment, styles.mediaButton)}
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
                }}
              >
                <row data-press-visual="compact" data-docked={docked() ? "true" : "false"} class={styles.mediaInner}>
                  <MediaEqIcon
                    active={mediaAudible()}
                    stepMs={42}
                    size={16}
                    color={mediaActiveColor()}
                    inactiveColor={mediaInactiveColor()}
                    testId="bar-media-eq"
                  />
                  <Show when={!vertical()}><text testId="bar-media-text" class={styles.mediaText}>{mediaLabel()}</text></Show>
                </row>
              </Button>
            );
          }}
        </Show>
        <SystemMonitorTrigger
          vertical={vertical()}
          docked={docked()}
          active={activePanel() === "system-monitor"}
          monitorId={props.monitor.id}
          surfaceName={surfaceName()}
          layout={props.layout}
          trackBlur={props.trackBlur}
        />
        <Show when={trayPartition().visible.length > 0 || trayPartition().collapsed.length > 0}>
          {() => {
            const trayRef = useBlurRef(props.trackBlur);
            const overflowActive = () => store.activeTrayOverflow()?.parentSurface === surfaceName();
            const overflowIcon = () => {
              const pos = props.layout.position;
              const open = overflowActive();
              if (pos === "left") return open ? "chevronLeft" : "chevronRight";
              if (pos === "right") return open ? "chevronRight" : "chevronLeft";
              return open ? "expandLess" : "expandMore";
            };
            return (
              <box
                ref={trayRef}
                testId="bar-tray"
                data-vertical={vertical() ? "true" : "false"}
                data-docked={docked() ? "true" : "false"}
                class={cx(styles.segment, styles.segmentSurface, styles.trayIsland)}
              >
                <Show when={trayPartition().collapsed.length > 0}>
                  <Button
                    testId="bar-tray-overflow-toggle"
                    ariaLabel={`Hidden tray icons (${trayPartition().collapsed.length})`}
                    ariaHasPopup="menu"
                    expanded={overflowActive()}
                    data-vertical={vertical() ? "true" : "false"}
                    data-docked={docked() ? "true" : "false"}
                    data-active={overflowActive() ? "true" : "false"}
                    class={styles.trayOverflowToggle}
                    onClick={event => {
                      event.stopPropagation();
                      store.openTrayOverflow({
                        monitorId: props.monitor.id,
                        parentSurface: surfaceName(),
                        anchorRect: resolveBarPopupAnchor(props.layout, { align: "target", targetRect: getWindowRect(event.currentTarget) }),
                      });
                    }}
                    {...secondaryAction(() => store.openSettingsWindow("bar", "tray-rules"))}
                  >
                    <box data-press-visual="compact" ariaHidden class={styles.pressInner}>
                      <ShellIcon
                        name={overflowIcon()}
                        size={14}
                        color={overflowActive() ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)"}
                      />
                    </box>
                  </Button>
                </Show>
                <For each={trayPartition().visible} keyed={item => item.id}>
                  {item => <TrayButton item={item()} vertical={vertical()} docked={docked()} monitorId={props.monitor.id} surfaceName={surfaceName()} layout={props.layout} />}
                </For>
              </box>
            );
          }}
        </Show>
        <Show when={docked()}><Divider vertical={vertical()} /></Show>
        <SystemPill vertical={vertical()} docked={docked()}
          monitorId={props.monitor.id} surfaceName={surfaceName()} layout={props.layout} trackBlur={props.trackBlur} />
      </box>
    </box>
  );
}

export function StatusBar() {
  const { monitors, outputs, settings } = useShellStore();
  const barSettings = () => settings.data()?.bar ?? DEFAULT_BAR_SETTINGS;
  const [now, setNow] = createSignal(Date.now());
  const clockSeconds = () => barSettings().clock_seconds;
  const clockDelay = createDelay();
  createEffect(clockSeconds, seconds => {
    const period = seconds ? 1_000 : 60_000;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      clockDelay.schedule(period - (time % period), tick);
    };
    tick();
    return () => clockDelay.cancel();
  });
  const clock = createMemo(() => formatBarClock(now(), { clock24h: barSettings().clock_24h, clockSeconds: clockSeconds() }));

  return (
    <For each={monitors()} keyed={monitor => monitor.id}>
      {monitor => {
        const layout = createMemo(() => resolveBarLayout(barSettings(), monitor(), outputs.data()));
        const [blurNodes, setBlurNodes] = createSignal<readonly NativeNode[]>([]);
        let disposed = false;
        onCleanup(() => { disposed = true; });
        const trackBlur: TrackBlurNode = node => {
          if (disposed) return () => {};
          setBlurNodes(nodes => (nodes.includes(node) ? nodes : [...nodes, node]));
          return () => {
            if (disposed) return;
            setBlurNodes(nodes => nodes.filter(candidate => candidate !== node));
          };
        };
        return (
          <LayerSurface name={formatSurfaceName("bar", monitor().id)} output={monitor().id} layer="top" anchor={[...layout().anchor]}
            width={layout().width} height={layout().height} margin={layout().margin} exclusiveZone={layout().exclusiveZone}
            inputRegion={layout().inputRegion ? [...layout().inputRegion!] : "full"}
            blurRegion={layout().style === "floating" && blurNodes().length > 0 ? blurNodes() : "none"} keyboard="none">
            <Show when={layout().style} keyed>
              {_style => (
                <BarContent
                  monitor={monitor()}
                  layout={layout()}
                  launcher={barSettings().launcher_enabled !== false}
                  workspaceNumbers={barSettings().workspace_numbers !== false}
                  clock={clock}
                  seconds={clockSeconds()}
                  trackBlur={trackBlur}
                />
              )}
            </Show>
          </LayerSurface>
        );
      }}
    </For>
  );
}
