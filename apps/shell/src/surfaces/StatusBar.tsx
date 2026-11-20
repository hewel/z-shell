import {
  Button, For, Image, LayerSurface, Show, createEffect, createMemo, createSignal, getWindowRect, onCleanup,
  type Accessor, type ButtonProps, type Monitor, type NativeEvent, type NativeNode, type NativeStyle, type NativeWheelEvent, type NativeWindowRect,
} from "@hewel/zgui";
import { useDaemonMedia } from "@z-shell/sdk/zgui";
import { ShellIcon } from "../icons.tsx";
import { useShellStore } from "../store.ts";
import { useShellTheme } from "../theme.ts";
import {
  DEFAULT_BAR_SETTINGS, TOP_BAR_HEIGHT, VERTICAL_BAR_WIDTH, filterWorkspacesForMonitor, findActiveWindowForMonitor,
  formatBarClock, formatSurfaceName, resolveBarLayout, resolveBarPopupAnchor, resolveDesktopApp, selectActiveMediaPlayer,
  type ResolvedBarLayout, type TrayItem, type WaylandWindow, type WaylandWorkspace,
} from "../topics.ts";

const primary = "var(--color-primary)";
const onSurface = "var(--color-on-surface)";
const muted = "var(--color-on-surface-variant)";
const error = "var(--color-error)";
const primaryContainer = "var(--color-primary-container)";
const onPrimaryContainer = "var(--color-on-primary-container)";
const center = { display: "flex", alignItems: "center", justifyContent: "center" } as const;
const bar = {
  ...center,
  justifyContent: "space-between",
  borderRadius: "16px",
  backgroundColor: "var(--color-surface)",
  color: onSurface,
  fontFamily: "var(--font-sans)",
  fontSize: "12px",
  overflow: "hidden",
} satisfies NativeStyle;
const horizontalBar = { ...bar, width: "100%", height: `${TOP_BAR_HEIGHT}px`, padding: "0 14px" } satisfies NativeStyle;
const verticalBar = { ...bar, width: `${VERTICAL_BAR_WIDTH}px`, padding: "14px 6px", flexDirection: "column" } as const;
const group = { display: "flex", alignItems: "center", flexGrow: 1, flexBasis: "0px", minWidth: "0px", gap: "10px" } as const;
const verticalGroup = { ...group, flexDirection: "column" } as const;
const pill = { ...center, flexShrink: 0, backgroundColor: "var(--color-surface-container)" } as const;
const horizontalPill = { ...pill, height: "32px", borderRadius: "16px" } as const;
const verticalPill = { ...pill, width: "40px", borderRadius: "999px", flexDirection: "column" } as const;
const horizontalCircle = { ...horizontalPill, width: "32px" } as const;
const verticalCircle = { ...verticalPill, height: "40px" } as const;
const horizontalLabelPill = { ...horizontalPill, justifyContent: "flex-start", padding: "0 12px", gap: "8px", flexShrink: 1, minWidth: "0px", overflow: "hidden" } as const;
const clippedText = { minWidth: "0px", maxWidth: "224px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
const iconButton = { ...center, width: "28px", height: "32px", flexShrink: 0 } as const;
const verticalIconButton = { ...center, width: "36px", height: "28px", flexShrink: 0 } as const;
const compactIconButton = { ...center, width: "26px", height: "32px", flexShrink: 0 } as const;
const verticalCompactIconButton = { ...center, width: "36px", height: "26px", flexShrink: 0 } as const;
const notificationBadge = { ...center, gap: "4px", backgroundColor: primaryContainer, color: onPrimaryContainer, borderRadius: "10px", padding: "2px 6px" } as const;
const outline = "var(--color-outline-variant)";

interface BarClock {
  readonly horizontal: string;
  readonly hours: string;
  readonly minutes: string;
  readonly seconds: string;
}

function Divider(props: { vertical: boolean; short?: boolean }) {
  return <box ariaHidden style={{
    flexShrink: 0,
    backgroundColor: outline,
    width: props.vertical ? "18px" : "1px",
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

function WorkspaceButton(props: { workspace: WaylandWorkspace; vertical: boolean; activate: () => void }) {
  const label = () => props.workspace.name || String(props.workspace.coordinates[0] ?? props.workspace.workspace_id);
  const fill = () => props.workspace.urgent ? error : props.workspace.active ? primary : muted;
  const activeLabel = { maxWidth: "22px", fontSize: "11px", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden" } as const;
  return (
    <Button testId={`ws-${props.workspace.workspace_id}`} ariaLabel={`Workspace ${label()}`} onClick={props.activate} style={{
      ...center,
      flexShrink: 0,
      width: props.vertical ? "28px" : props.workspace.active ? "28px" : "24px",
      height: props.vertical ? (props.workspace.active ? "32px" : "24px") : "32px",
      borderRadius: props.vertical ? "14px" : "10px",
      backgroundColor: props.vertical && props.workspace.active ? fill() : "transparent",
      color: props.workspace.urgent ? "var(--color-on-error)" : "var(--color-on-primary)",
    }}>
      <Show when={props.vertical} fallback={
        <box ariaHidden data-ws-pill="true" style={{
          width: props.workspace.active ? "24px" : "8px",
          height: props.workspace.active ? "10px" : "8px",
          borderRadius: props.workspace.active ? "999px" : "4px",
          backgroundColor: fill(),
          opacity: props.workspace.active || props.workspace.urgent ? 1 : 0.55,
        }} />
      }>
        <Show when={props.workspace.active} fallback={
          <box ariaHidden data-ws-pill="true" style={{ width: "6px", height: "6px", borderRadius: "3px", backgroundColor: fill(), opacity: props.workspace.urgent ? 1 : 0.55 }} />
        }>
          <text style={activeLabel}>{label()}</text>
        </Show>
      </Show>
    </Button>
  );
}

function ActiveWindowPill(props: { window: Accessor<WaylandWindow>; vertical: boolean }) {
  const { apps, hostClient } = useShellStore();
  const app = createMemo(() => resolveDesktopApp(apps.data()?.apps, props.window().app_id));
  const { src } = useDaemonMedia(hostClient, () => app()?.icon, { fetchCommand: "launcher.fetch-blob" });
  return (
    <box testId="bar-active-window" ariaLabel={props.window().title} style={props.vertical ? verticalCircle : horizontalLabelPill}>
      <Show when={src()} fallback={<ShellIcon name="terminal" color={primary} />}>
        {image => <Image ariaHidden src={image()} style={{ width: "16px", height: "16px", borderRadius: "4px", flexShrink: 0, "object-fit": "contain" }} />}
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
        <box style={{ ...center, width: "16px", height: "16px", borderRadius: "8px", backgroundColor: primaryContainer, color: onPrimaryContainer, fontWeight: 700, fontSize: "10px" }}>
          <text>{props.item.title?.[0]?.toUpperCase() ?? "•"}</text>
        </box>
      }>
        {image => <Image src={image()} style={{ width: "16px", height: "16px" }} />}
      </Show>
    </Button>
  );
}

function ClockPill(props: { vertical: boolean; clock: Accessor<BarClock>; seconds: boolean; monitorId: string; surfaceName: string; layout: ResolvedBarLayout }) {
  const { notifications, togglePanel } = useShellStore();
  const count = () => notifications.data()?.history.length ?? 0;
  const dnd = () => notifications.data()?.dnd ?? false;
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
      style={props.vertical ? { ...verticalPill, gap: "2px", padding: "8px 0", fontWeight: 700, lineHeight: 1.2 }
        : { ...horizontalPill, gap: "8px", padding: "0 12px", whiteSpace: "nowrap" }}>
      <Show when={props.vertical} fallback={<text testId="bar-clock-text">{props.clock().horizontal}</text>}>
        <box testId="bar-clock-text" style={{ ...center, flexDirection: "column" }}>
          <text>{props.clock().hours}</text>
          <text>{props.clock().minutes}</text>
          <Show when={props.seconds}><text>{props.clock().seconds}</text></Show>
        </box>
      </Show>
      <Show when={count() > 0 || (!props.vertical && dnd())}>
        <Show when={!props.vertical}><Divider vertical={false} short /></Show>
        <box testId="bar-notifications-badge" style={notificationBadge}>
          <Show when={!props.vertical}><ShellIcon name={dnd() ? "bellOff" : "bell"} size={12} color={onPrimaryContainer} /></Show>
          <text>{count()}</text>
        </box>
      </Show>
    </Button>
  );
}

function SystemPill(props: { vertical: boolean; monitorId: string; surfaceName: string; layout: ResolvedBarLayout }) {
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
  return (
    <box testId="bar-system" style={props.vertical ? { ...verticalPill, gap: "2px", padding: "4px 0" }
      : { ...horizontalPill, gap: "2px", padding: "0 4px" }}>
      <Show when={ime.data()?.available && ime.data()?.mode !== "disabled"}>
        <Button testId="bar-ime" ariaLabel="Input method" ariaHasPopup="menu"
          style={{ ...center, minWidth: "28px", height: "24px", padding: "0 6px", borderRadius: "999px", backgroundColor: primaryContainer, color: onPrimaryContainer, fontWeight: 700 }}
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
        <ShellIcon name={networkIcon()} color={networkIcon() === "wifiOff" ? muted : onSurface} />
      </Button>
      <Button testId="bar-bluetooth" ariaLabel="Bluetooth settings" style={btnStyle()} onClick={quickSettings}>
        <ShellIcon name={bluetoothPowered() || bluetoothConnected() ? "bluetooth" : "bluetoothOff"}
          color={bluetoothConnected() ? primary : bluetoothPowered() ? onSurface : muted} />
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
        <ShellIcon name={audioIcon()} />
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
              height: props.vertical ? "auto" : "32px",
              padding: props.vertical ? "4px 0" : "0 4px",
              flexShrink: 0,
            }}>
            <ShellIcon name={battery().state === "charging" || battery().state === "full" ? "batteryCharging" : "battery"}
              color={battery().state === "discharging" && (battery().percentage ?? 100) < 20
                ? error : battery().state === "charging" ? primary : onSurface} />
            <text testId="bar-battery-text">{battery().percentage == null ? "—" : `${Math.round(battery().percentage ?? 0)}%`}</text>
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

  // A native surface's root can resolve percentage height to its intrinsic height after reconfiguration.
  const rootStyle = createMemo(() => vertical() ? { ...verticalBar, height: `${props.layout.height}px` } : horizontalBar);

  return (
    <box testId={`bar-root-${props.monitor.id}`} data-theme-rev={String(store.theme.revision())}
      data-position={props.layout.position} data-active-panel={activePanel() ?? "none"}
      onClick={() => dismissOverlay()}
      style={rootStyle()}>
      <box style={vertical() ? verticalGroup : group}>
        <Show when={props.launcher}>
          <Button testId="bar-launcher" ariaLabel="Launcher" style={vertical() ? verticalCircle : horizontalCircle}
            onClick={event => {
              event.stopPropagation();
              togglePanel("launcher", { monitorId: props.monitor.id });
            }}>
            <ShellIcon name="apps" size={20} color={primary} />
          </Button>
        </Show>
        <box testId="bar-workspaces" style={vertical() ? { ...verticalPill, gap: "2px", padding: "6px 0" }
          : { ...horizontalPill, gap: "2px", padding: "0 6px" }}
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
            {workspace => <WorkspaceButton workspace={workspace()} vertical={vertical()} activate={() => activateWorkspace(workspace().workspace_id)} />}
          </For>
          <Divider vertical={vertical()} />
          <Button testId="bar-overview" ariaLabel="Overview" style={vertical() ? verticalIconButton : iconButton}
            onClick={event => {
              event.stopPropagation();
              togglePanel("overview", { monitorId: props.monitor.id });
            }}>
            <ShellIcon name="overview" color={muted} />
          </Button>
        </box>
        <Show when={activeWindow()}>
          {window => <ActiveWindowPill window={window} vertical={vertical()} />}
        </Show>
      </box>
      <ClockPill vertical={vertical()} clock={props.clock} seconds={props.seconds} monitorId={props.monitor.id} surfaceName={surfaceName()} layout={props.layout} />
      <box style={{ ...(vertical() ? verticalGroup : group), justifyContent: "flex-end" }}>
        <Show when={slots().length > 0}>
          <box testId="bar-plugin-slots" onClick={event => event.stopPropagation()} style={vertical() ? { ...verticalPill, gap: "4px", padding: "6px 0" }
            : { ...horizontalPill, gap: "6px", padding: "0 8px" }}>
            <For each={slots()}>{slot => () => slot.render({ vertical: vertical() })}</For>
          </box>
        </Show>
        <Show when={player()}>
          {active => (
            <Button testId="bar-media" ariaLabel={mediaLabel()} style={vertical() ? verticalCircle : horizontalLabelPill}
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
              <ShellIcon name="mediaEq" color={primary} />
              <Show when={!vertical()}><text testId="bar-media-text" style={clippedText}>{mediaLabel()}</text></Show>
            </Button>
          )}
        </Show>
        <Show when={(store.tray.data()?.items.length ?? 0) > 0}>
          <box testId="bar-tray" style={vertical() ? { ...verticalPill, gap: "2px", padding: "4px 0" }
            : { ...horizontalPill, gap: "2px", padding: "0 4px" }}>
            <For each={store.tray.data()?.items} keyed={item => item.id}>
              {item => <TrayButton item={item()} vertical={vertical()} monitorId={props.monitor.id} surfaceName={surfaceName()} layout={props.layout} />}
            </For>
          </box>
        </Show>
        <SystemPill vertical={vertical()} monitorId={props.monitor.id} surfaceName={surfaceName()} layout={props.layout} />
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
            width={layout().width} height={layout().height} margin={layout().margin} exclusiveZone={layout().exclusiveZone} keyboard="none">
            <BarContent monitor={monitor()} layout={layout()} launcher={barSettings().launcher_enabled !== false} clock={clock} seconds={clockSeconds()} />
          </LayerSurface>
        );
      }}
    </For>
  );
}
