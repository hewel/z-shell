import { createContext, createDelay, createEffect, createMemo, createSignal, flush, getSessionGeneration, onCleanup, runWithOwner, untrack, useContext, useMonitors, type Accessor, type Monitor, type NativeChild, type NativeWindowRect } from "@hewel/zgui";
import { mountOwned } from "@hewel/zgui/renderer";
import { getResolvedCapabilities, onControlMessage, type JsonValue } from "@hewel/zgui-services";
import { ZShellClient, type BusHelloResult, type BusTransport, type CommandInvokeResult } from "@z-shell/sdk";
import { createZguiSocketTransport, setGlobalMotionScheme, useTopic, type TopicState } from "@z-shell/sdk/zgui";
import { composedPlugins } from "./plugins/composed.ts";
import type { ThemeTopicSnapshot } from "./theme.ts";
import { formatSurfaceName, isSessionLockActive, resolveActiveMonitor, resolveBarLayout, resolveBarPopupAnchor, resolvePinnedOutput } from "./topics.ts";
import type {
  ClipboardSnapshot,
  DesktopAppsSnapshot,
  DesktopImePanelSnapshot,
  DesktopImeSnapshot,
  DesktopMediaSnapshot,
  DesktopNotificationsSnapshot,
  DesktopTraySnapshot,
  IdleSnapshot,
  LockSnapshot,
  OsdPayload,
  PinnedOutputState,
  PolkitSnapshot,
  PowerConfirmAction,
  PublicSettingsSummary,
  SystemAudioSnapshot,
  SystemBluetoothSnapshot,
  SystemBrightnessSnapshot,
  SystemNetworkSnapshot,
  SystemPowerSnapshot,
  SystemPrivacySnapshot,
  SystemTelemetrySnapshot,
  SystemUserSnapshot,
  WallpaperSnapshot,
  WaylandOutputsSnapshot,
  WaylandWindowsSnapshot,
  WaylandWorkspacesSnapshot,
} from "./topics.ts";

export const SHELL_SUBSCRIBED_TOPICS = [
  "theme", "settings", "wallpaper",
  "wayland.outputs", "wayland.workspaces", "wayland.windows",
  "desktop.media", "desktop.tray", "desktop.notifications", "desktop.ime",
  "system.audio", "system.privacy", "system.network", "system.bluetooth", "system.power",
  "clipboard", "system.brightness", "system.telemetry", "system.user", "session.idle",
  "desktop.apps", "desktop.ime.panel",
  "session.lock", "session.polkit",
] as const;

export type SocketStatus = "disconnected" | "connecting" | "ready" | "error";

export type ShellSocketPaths = {
  readonly publicSocket: string | null;
  readonly hostSocket: string | null;
};

const PANEL_IDS = ["launcher", "overview", "calendar", "media", "quick-settings", "battery", "system-monitor", "clipboard"] as const;
export type PanelId = typeof PANEL_IDS[number];

export const SYSTEM_MONITOR_TABS = ["overview", "cpu", "memory", "gpu", "storage"] as const;
export type SystemMonitorTab = typeof SYSTEM_MONITOR_TABS[number];

function isSystemMonitorTab(value: unknown): value is SystemMonitorTab {
  return typeof value === "string" && (SYSTEM_MONITOR_TABS as readonly string[]).includes(value);
}

export type PanelTarget = {
  readonly id: PanelId;
  readonly parentSurface: string;
  readonly anchorRect: NativeWindowRect;
  readonly monitorId?: string;
};

export type PanelAnchor = {
  readonly parentSurface?: string;
  readonly anchorRect?: NativeWindowRect;
  readonly monitorId?: string;
};

export type TrayMenuTarget = {
  readonly itemId: string;
  readonly parentSurface: string;
  readonly anchorRect: NativeWindowRect;
  readonly monitorId?: string;
};

export type TrayOverflowTarget = {
  readonly parentSurface: string;
  readonly anchorRect: NativeWindowRect;
  readonly monitorId?: string;
};

export type SettingsSubpage = "wallpaper-library" | "tray-rules" | "plugin-detail";

export type ImeMenuTarget = {
  readonly parentSurface: string;
  readonly anchorRect: NativeWindowRect;
  readonly monitorId?: string;
};

export type PluginBarWidgetSlot = {
  readonly id: string;
  readonly pluginId?: string;
  readonly entryId?: string;
  readonly instanceSlug?: string;
  readonly outputId?: string;
  readonly render: (props: { readonly vertical: boolean }) => NativeChild;
};

export type PluginSettingsPageEntry = {
  readonly id: string;
  readonly pluginId: string;
  readonly title: string;
  readonly render: () => NativeChild;
};

type BarOverlay =
  | { readonly kind: "panel"; readonly target: PanelTarget }
  | { readonly kind: "tray"; readonly target: TrayMenuTarget }
  | { readonly kind: "tray-overflow"; readonly target: TrayOverflowTarget }
  | { readonly kind: "ime"; readonly target: ImeMenuTarget }
  | { readonly kind: "plugin"; readonly instanceId: string; readonly pluginId?: string; readonly monitorId?: string };

export type BarOverlayKind = BarOverlay["kind"];

export function resolveShellSocketPaths(unixSockets: readonly string[]): ShellSocketPaths {
  const find = (kind: "bus" | "host") => {
    const prefix = `${kind}-`;
    const plain = `${kind}.sock`;
    return unixSockets.find(path => {
      const name = path.slice(path.lastIndexOf("/") + 1);
      return name === plain || (name.startsWith(prefix) && name.endsWith(".sock") && name.length > prefix.length + 5);
    }) ?? null;
  };
  return { publicSocket: find("bus"), hostSocket: find("host") };
}

interface ShellTopics {
  readonly theme: TopicState<ThemeTopicSnapshot>;
  readonly settings: TopicState<PublicSettingsSummary>;
  readonly wallpaper: TopicState<WallpaperSnapshot>;
  readonly outputs: TopicState<WaylandOutputsSnapshot>;
  readonly workspaces: TopicState<WaylandWorkspacesSnapshot>;
  readonly windows: TopicState<WaylandWindowsSnapshot>;
  readonly media: TopicState<DesktopMediaSnapshot>;
  readonly tray: TopicState<DesktopTraySnapshot>;
  readonly notifications: TopicState<DesktopNotificationsSnapshot>;
  readonly ime: TopicState<DesktopImeSnapshot>;
  readonly audio: TopicState<SystemAudioSnapshot>;
  readonly privacy: TopicState<SystemPrivacySnapshot>;
  readonly network: TopicState<SystemNetworkSnapshot>;
  readonly bluetooth: TopicState<SystemBluetoothSnapshot>;
  readonly power: TopicState<SystemPowerSnapshot>;
  readonly clipboard: TopicState<ClipboardSnapshot>;
  readonly brightness: TopicState<SystemBrightnessSnapshot>;
  readonly telemetry: TopicState<SystemTelemetrySnapshot>;
  readonly user: TopicState<SystemUserSnapshot>;
  readonly idle: TopicState<IdleSnapshot>;
  readonly apps: TopicState<DesktopAppsSnapshot>;
  readonly imePanel: TopicState<DesktopImePanelSnapshot>;
  readonly sessionLock: TopicState<LockSnapshot>;
  readonly polkit: TopicState<PolkitSnapshot>;
}

export type QuickSettingsPageId = "main" | "wifi" | "bluetooth" | "sound" | "battery";

export interface ShellStore extends ShellTopics {
  readonly monitors: Accessor<readonly Monitor[]>;
  readonly activeMonitor: Accessor<Monitor | undefined>;
  readonly powerDialogMonitor: Accessor<Monitor | undefined>;
  recordActiveMonitor(monitorId: string): void;
  readonly publicClient: Accessor<ZShellClient | undefined>;
  readonly hostClient: Accessor<ZShellClient | undefined>;
  readonly publicStatus: Accessor<SocketStatus>;
  readonly hostStatus: Accessor<SocketStatus>;
  readonly publicHello: Accessor<BusHelloResult | undefined>;
  readonly hostHello: Accessor<BusHelloResult | undefined>;
  readonly lastError: Accessor<string | undefined>;
  invokePublic(name: string, payload?: unknown): Promise<CommandInvokeResult | undefined>;
  invokeHost(name: string, payload?: unknown): Promise<CommandInvokeResult | undefined>;
  readonly invokeHostResult: (name: string, payload?: unknown) => Promise<
    { readonly ok: true; readonly result: CommandInvokeResult } | { readonly ok: false; readonly error: string }
  >;
  readonly activePanel: Accessor<PanelId | null>;
  readonly activePanelTarget: Accessor<PanelTarget | null>;
  readonly overlayKind: Accessor<BarOverlayKind | null>;
  readonly barPopupGrab: Accessor<boolean>;
  readonly ungrabbedBarPopupMonitorId: Accessor<string | null>;
  recordBarPointerDown(): void;
  dismissBarPopupFromCompositor(kind: BarOverlayKind): void;
  togglePanel(id: PanelId, target?: PanelAnchor): void;
  readonly quickSettingsPage: Accessor<QuickSettingsPageId>;
  setQuickSettingsPage(page: QuickSettingsPageId): void;
  toggleQuickSettingsPage(page: QuickSettingsPageId, target?: PanelAnchor): void;
  readonly pendingQuickSettingsSubpage: Accessor<Exclude<QuickSettingsPageId, "main"> | null>;
  openQuickSettingsSubpage(page: Exclude<QuickSettingsPageId, "main">): void;
  consumeQuickSettingsSubpage(): Exclude<QuickSettingsPageId, "main"> | null;
  closePanels(): void;
  dismissOverlay(): void;
  readonly activePluginPanelId: Accessor<string | null>;
  readonly activePluginPanelTarget: Accessor<{ readonly instanceId: string; readonly pluginId?: string; readonly monitorId?: string } | null>;
  togglePluginPanel(instanceId: string, monitorId?: string, pluginId?: string): boolean;
  openPluginPanel(instanceId: string, monitorId?: string, pluginId?: string): void;
  closePluginPanel(): void;
  readonly activeTrayMenu: Accessor<TrayMenuTarget | null>;
  openTrayMenu(target: TrayMenuTarget): void;
  closeTrayMenu(): void;
  readonly activeTrayOverflow: Accessor<TrayOverflowTarget | null>;
  openTrayOverflow(target: TrayOverflowTarget): void;
  closeTrayOverflow(): void;
  readonly activeImeMenu: Accessor<ImeMenuTarget | null>;
  openImeMenu(target: ImeMenuTarget): void;
  closeImeMenu(): void;
  readonly pendingPowerAction: Accessor<PowerConfirmAction | null>;
  readonly requestPowerDialog: (action: PowerConfirmAction, monitorId?: string) => void;
  readonly closePowerDialog: () => void;
  readonly activeOsd: Accessor<OsdPayload | null>;
  showOsd(osd: Omit<OsdPayload, "seq">): void;
  readonly pluginBarWidgets: Accessor<readonly PluginBarWidgetSlot[]>;
  registerPluginBarWidget(slot: PluginBarWidgetSlot): () => void;
  readonly pluginSettingsPages: Accessor<readonly PluginSettingsPageEntry[]>;
  registerPluginSettingsPage(page: PluginSettingsPageEntry): () => void;
  readonly pluginUpdatesCount: Accessor<number>;
  setPluginUpdatesCount(count: number): void;
  readonly settingsWindowOpen: Accessor<boolean>;
  readonly settingsWindowTab: Accessor<string>;
  readonly settingsSubpage: Accessor<SettingsSubpage | null>;
  setSettingsSubpage(subpage: SettingsSubpage | null): void;
  openSettingsWindow(tab?: string, subpage?: SettingsSubpage | null): void;
  closeSettingsWindow(): void;
  readonly systemMonitorWindowOpen: Accessor<boolean>;
  readonly systemMonitorWindowTab: Accessor<SystemMonitorTab>;
  openSystemMonitorWindow(tab?: SystemMonitorTab): void;
  closeSystemMonitorWindow(): void;
}

function isBarPopupOverlay(active: BarOverlay | null): boolean {
  if (!active) return false;
  if (active.kind !== "panel") return true;
  return active.target.parentSurface.length > 0
    && active.target.id !== "launcher"
    && active.target.id !== "overview"
    && active.target.id !== "clipboard";
}

const COMPOSITOR_DISMISS_PRESS_WINDOW_MS = 80;

export function createShellStore(): ShellStore {
  const monitors = useMonitors();
  const { publicSocket, hostSocket } = resolveShellSocketPaths(getResolvedCapabilities().unixSockets);
  const [lastError, setLastError] = createSignal<string>();
  const [lastMonitorId, setLastMonitorId] = createSignal<string | null>(null);
  const [powerDialogMonitorId, setPowerDialogMonitorId] = createSignal<string | null>(null);
  let disposed = false;
  const [overlay, setOverlay] = createSignal<BarOverlay | null>(null);
  const [barPopupGrab, setBarPopupGrab] = createSignal(true);
  let lastBarPointerDownAtMs: number | null = null;
  let lastCompositorDismiss: {
    readonly overlay: BarOverlay;
    readonly quickSettingsPage: QuickSettingsPageId;
    readonly atMs: number;
    fromBarPress: boolean;
  } | null = null;
  const [quickSettingsPage, setQuickSettingsPage] = createSignal<QuickSettingsPageId>("main");
  const [pendingQuickSettingsSubpage, setPendingQuickSettingsSubpage] = createSignal<Exclude<QuickSettingsPageId, "main"> | null>(null);
  const recordActiveMonitor = (monitorId: string) => {
    if (monitorId.length > 0) setLastMonitorId(monitorId);
  };
  const activeMonitor = () => resolveActiveMonitor(monitors(), {
    windows: topics?.windows.data(),
    outputs: topics?.outputs.data(),
    lastMonitorId: lastMonitorId(),
  });
  const powerDialogMonitor = () => resolveActiveMonitor(monitors(), {
    preferredMonitorId: powerDialogMonitorId(),
    windows: topics?.windows.data(),
    outputs: topics?.outputs.data(),
    lastMonitorId: lastMonitorId(),
  });
  const activePanelTarget = () => {
    const active = overlay();
    return active?.kind === "panel" ? active.target : null;
  };
  const activePanel = () => activePanelTarget()?.id ?? null;
  const activeTrayMenu = () => {
    const active = overlay();
    return active?.kind === "tray" ? active.target : null;
  };
  const activeTrayOverflow = () => {
    const active = overlay();
    return active?.kind === "tray-overflow" ? active.target : null;
  };
  const activeImeMenu = () => {
    const active = overlay();
    return active?.kind === "ime" ? active.target : null;
  };
  const activePluginPanelTarget = () => {
    const active = overlay();
    return active?.kind === "plugin"
      ? {
          instanceId: active.instanceId,
          ...(active.pluginId !== undefined ? { pluginId: active.pluginId } : {}),
          ...(active.monitorId !== undefined ? { monitorId: active.monitorId } : {}),
        }
      : null;
  };
  const activePluginPanelId = () => activePluginPanelTarget()?.instanceId ?? null;
  const overlayKind = () => overlay()?.kind ?? null;
  function inferMonitorId(parentSurface: string | undefined, outputs: readonly Monitor[]): string | undefined {
    if (!parentSurface) return undefined;
    return outputs.find(monitor => formatSurfaceName("bar", monitor.id) === parentSurface)?.id;
  }
  function overlayMonitorId(active: BarOverlay | null, outputs: readonly Monitor[]): string | undefined {
    if (!active) return undefined;
    if (active.kind === "plugin") return active.monitorId;
    return active.target.monitorId ?? inferMonitorId(active.target.parentSurface, outputs);
  }
  const ungrabbedBarPopupMonitorId = createMemo((): string | null => {
    const active = overlay();
    if (!isBarPopupOverlay(active) || barPopupGrab()) return null;
    return overlayMonitorId(active, monitors()) ?? activeMonitor()?.id ?? null;
  });
  function defaultPanelAnchor(
    id: PanelId,
    outputs: readonly Monitor[],
    preferredMonitorId?: string | null,
  ): Omit<PanelTarget, "id"> {
    const monitor = resolveActiveMonitor(outputs, {
      preferredMonitorId,
      windows: topics?.windows.data(),
      outputs: topics?.outputs.data(),
      lastMonitorId: lastMonitorId(),
    });
    const size = 32;
    // Keep the logical panel state available to control callers without an output.
    if (!monitor) return { parentSurface: "", anchorRect: { x: 0, y: 0, width: size, height: size } };
    const layout = resolveBarLayout(topics.settings.data()?.bar, monitor, topics.outputs.data());
    const align = id === "calendar" ? "center" : "end";
    return {
      parentSurface: formatSurfaceName("bar", monitor.id),
      anchorRect: resolveBarPopupAnchor(layout, { align }),
      monitorId: monitor.id,
    };
  }
  const overviewPluginLayer = composedPlugins.entryInstances.find(
    instance => instance.kind === "layer" && instance.id === "overview",
  );
  const recordBarPointerDown = () => {
    const now = Date.now();
    lastBarPointerDownAtMs = now;
    if (lastCompositorDismiss) {
      if (now - lastCompositorDismiss.atMs <= COMPOSITOR_DISMISS_PRESS_WINDOW_MS) {
        lastCompositorDismiss.fromBarPress = true;
      } else {
        lastCompositorDismiss = null;
      }
    }
  };
  const dismissBarPopupFromCompositor = (kind: BarOverlayKind) => {
    const active = overlay();
    if (active?.kind !== kind) return;
    const now = Date.now();
    lastCompositorDismiss = {
      overlay: active,
      quickSettingsPage: quickSettingsPage(),
      atMs: now,
      fromBarPress: lastBarPointerDownAtMs !== null && now - lastBarPointerDownAtMs <= COMPOSITOR_DISMISS_PRESS_WINDOW_MS,
    };
    setOverlay(null);
    setBarPopupGrab(true);
  };
  const consumeBarCompositorDismiss = () => {
    const record = lastCompositorDismiss;
    lastCompositorDismiss = null;
    if (!record) return null;
    return record.fromBarPress || Date.now() - record.atMs <= COMPOSITOR_DISMISS_PRESS_WINDOW_MS
      ? record
      : null;
  };
  const readOverlayTransition = () => {
    const current = overlay();
    const recent = current === null ? consumeBarCompositorDismiss() : ((lastCompositorDismiss = null), null);
    const effective = current ?? recent?.overlay ?? null;
    return { current, recent, effective };
  };
  const clearOverlayWithGrab = () => {
    lastCompositorDismiss = null;
    setBarPopupGrab(true);
    setOverlay(null);
  };
  const commitBarOverlay = (
    next: BarOverlay,
    inPlace: boolean,
    recent: NonNullable<ReturnType<typeof consumeBarCompositorDismiss>> | null,
    current: BarOverlay | null,
  ) => {
    // Switching directly between bar popups skips seat grab on the replacement popup so
    // Smithay/Niri does not immediately dismiss it against the outgoing popup's press serial.
    if (!inPlace) {
      const hadActiveGrab = recent !== null || (isBarPopupOverlay(current) && barPopupGrab());
      setBarPopupGrab(!hadActiveGrab);
    }
    setOverlay(next);
  };
  function resolveAnchor(target: PanelAnchor | undefined, id: PanelId, fallbackOverlay: BarOverlay | null): Omit<PanelTarget, "id"> {
    const currentOutputs = monitors();
    const explicitMonitorId = target?.monitorId ?? inferMonitorId(target?.parentSurface, currentOutputs);
    if (explicitMonitorId) recordActiveMonitor(explicitMonitorId);
    if (target?.parentSurface !== undefined && target.anchorRect !== undefined) {
      return {
        parentSurface: target.parentSurface,
        anchorRect: target.anchorRect,
        ...(explicitMonitorId ? { monitorId: explicitMonitorId } : {}),
      };
    }
    return defaultPanelAnchor(id, currentOutputs, explicitMonitorId ?? overlayMonitorId(fallbackOverlay, currentOutputs));
  }
  const isLocked = () => isSessionLockActive(topics?.sessionLock.data());
  const togglePanel = (id: PanelId, target?: PanelAnchor) => {
    if (isLocked()) return;
    const currentOutputs = monitors();
    const explicitMonitorId = target?.monitorId ?? inferMonitorId(target?.parentSurface, currentOutputs);
    if (explicitMonitorId) recordActiveMonitor(explicitMonitorId);
    if (id === "overview" && overviewPluginLayer) {
      clearOverlayWithGrab();
      const commandPrefix = `plugin.${overviewPluginLayer.pluginId.replace("/", ".")}`;
      void invoke(publicClient(), `${commandPrefix}.toggle`, {});
      return;
    }
    if (id === "launcher" || id === "overview" || id === "clipboard") {
      lastCompositorDismiss = null;
      setBarPopupGrab(true);
      setOverlay(active => {
        const resolved = resolveAnchor(target, id, active);
        if (active?.kind === "panel" && active.target.id === id
          && (target === undefined || active.target.parentSurface === resolved.parentSurface)) {
          return null;
        }
        return { kind: "panel", target: { ...resolved, id } };
      });
      return;
    }
    const { current, recent, effective } = readOverlayTransition();
    const resolved = resolveAnchor(target, id, effective);
    if (effective?.kind === "panel" && effective.target.id === id
      && (target === undefined || effective.target.parentSurface === resolved.parentSurface)) {
      clearOverlayWithGrab();
      return;
    }
    const inPlace = current?.kind === "panel"
      && current.target.id === id
      && current.target.parentSurface === resolved.parentSurface;
    commitBarOverlay({ kind: "panel", target: { ...resolved, id } }, inPlace, recent, current);
  };
  const toggleQuickSettingsPage = (page: QuickSettingsPageId, target?: PanelAnchor) => {
    if (isLocked()) return;
    const { current, recent, effective } = readOverlayTransition();
    const resolved = resolveAnchor(target, "quick-settings", effective);
    const effectiveQsPage = current ? quickSettingsPage() : (recent?.quickSettingsPage ?? quickSettingsPage());
    const sameSurfaceOpen = effective?.kind === "panel"
      && effective.target.id === "quick-settings"
      && (target === undefined || effective.target.parentSurface === resolved.parentSurface);
    if (sameSurfaceOpen && effectiveQsPage === page) {
      clearOverlayWithGrab();
      return;
    }
    const inPlace = current?.kind === "panel"
      && current.target.id === "quick-settings"
      && current.target.parentSurface === resolved.parentSurface;
    setQuickSettingsPage(page);
    setPendingQuickSettingsSubpage(page === "main" ? null : page);
    commitBarOverlay({ kind: "panel", target: { ...resolved, id: "quick-settings" } }, inPlace, recent, current);
  };
  const closeOverlay = (kind: BarOverlay["kind"]) => {
    if (overlay()?.kind !== kind) return;
    clearOverlayWithGrab();
  };
  const togglePluginPanel = (instanceId: string, monitorId?: string, pluginId?: string): boolean => {
    if (isLocked()) return false;
    if (monitorId) recordActiveMonitor(monitorId);
    const { current, recent, effective } = readOverlayTransition();
    if (
      effective?.kind === "plugin"
      && effective.instanceId === instanceId
      && (monitorId === undefined || effective.monitorId === monitorId)
    ) {
      clearOverlayWithGrab();
      return false;
    }
    const inPlace = current?.kind === "plugin"
      && current.instanceId === instanceId
      && current.monitorId === monitorId;
    commitBarOverlay(
      {
        kind: "plugin",
        instanceId,
        ...(pluginId !== undefined ? { pluginId } : {}),
        ...(monitorId ? { monitorId } : {}),
      },
      inPlace,
      recent,
      current,
    );
    return true;
  };

  const [pendingPowerAction, setPendingPowerAction] = createSignal<PowerConfirmAction | null>(null);
  const requestPowerDialog = (action: PowerConfirmAction, monitorId?: string) => {
    const currentOutputs = monitors();
    const active = overlay();
    const targetMonitorId = monitorId
      ?? overlayMonitorId(active, currentOutputs)
      ?? null;
    if (targetMonitorId) recordActiveMonitor(targetMonitorId);
    setPowerDialogMonitorId(targetMonitorId);
    clearOverlayWithGrab();
    setPendingPowerAction(action);
  };
  const closePowerDialog = () => {
    setPendingPowerAction(null);
    setPowerDialogMonitorId(null);
  };

  const [activeOsd, setActiveOsd] = createSignal<OsdPayload | null>(null);
  let osdSeq = 0;
  const osdDelay = createDelay();
  function showOsd(osd: Omit<OsdPayload, "seq">): void {
    if (disposed) return;
    setActiveOsd({ ...osd, seq: ++osdSeq });
    osdDelay.schedule(1500, () => {
      setActiveOsd(null);
    });
  }

  const [pluginBarWidgets, setPluginBarWidgets] = createSignal<readonly PluginBarWidgetSlot[]>([]);
  function registerPluginBarWidget(slot: PluginBarWidgetSlot): () => void {
    const registration = { ...slot };
    setPluginBarWidgets(slots => [...slots, registration]);
    return () => setPluginBarWidgets(slots => slots.includes(registration)
      ? slots.filter(candidate => candidate !== registration)
      : slots);
  }

  const [pluginSettingsPages, setPluginSettingsPages] = createSignal<readonly PluginSettingsPageEntry[]>([]);
  function registerPluginSettingsPage(page: PluginSettingsPageEntry): () => void {
    const registration = { ...page };
    setPluginSettingsPages(pages => [...pages, registration]);
    return () => setPluginSettingsPages(pages => pages.includes(registration)
      ? pages.filter(candidate => candidate !== registration)
      : pages);
  }

  const [pluginUpdatesCount, setPluginUpdatesCount] = createSignal(0);
  const [settingsWindowOpen, setSettingsWindowOpen] = createSignal(false);
  const [settingsWindowTab, setSettingsWindowTab] = createSignal("appearance");
  const [settingsSubpage, setSettingsSubpage] = createSignal<SettingsSubpage | null>(null);
  function openSettingsWindow(tab?: string, subpage?: SettingsSubpage | null): void {
    if (tab) setSettingsWindowTab(tab);
    setSettingsSubpage(subpage ?? null);
    clearOverlayWithGrab();
    setSettingsWindowOpen(true);
  }
  function closeSettingsWindow(): void {
    setSettingsWindowOpen(false);
  }

  const [systemMonitorWindowOpen, setSystemMonitorWindowOpen] = createSignal(false);
  const [systemMonitorWindowTab, setSystemMonitorWindowTab] = createSignal<SystemMonitorTab>("overview");
  function openSystemMonitorWindow(tab?: SystemMonitorTab): void {
    if (tab) setSystemMonitorWindowTab(tab);
    clearOverlayWithGrab();
    setSystemMonitorWindowOpen(true);
  }
  function closeSystemMonitorWindow(): void {
    setSystemMonitorWindowOpen(false);
  }

  function reportError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (!disposed) setLastError(message);
    return message;
  }

  async function invoke(client: ZShellClient | undefined, name: string, payload?: unknown) {
    try {
      return await client?.invokeCommand(name, [], payload);
    } catch (error) {
      reportError(error);
      return undefined;
    }
  }

  function open(path: string | null, name: string, onConnected?: (client: ZShellClient) => void) {
    const [client, setClient] = createSignal<ZShellClient>();
    const [status, setStatus] = createSignal<SocketStatus>(path === null ? "disconnected" : "connecting");
    const hello = () => client()?.helloInfo;
    if (path === null) return { client, status, hello, close: undefined };

    let transport: BusTransport | undefined;
    let connected: ZShellClient | undefined;
    let stopWatchingClose: (() => void) | undefined;
    let peerClosed = false;
    const onError = (error: unknown) => {
      if (disposed) return;
      reportError(error);
      setStatus("error");
    };
    const close = () => {
      stopWatchingClose?.();
      if (connected) connected.close();
      else transport?.close();
    };

    async function connect(socketPath: string) {
      try {
        // Own the transport until bus.hello returns a client that can close it.
        transport = runWithOwner(null, () => createZguiSocketTransport(socketPath, { onError }));
        const connecting = ZShellClient.connect(transport, name, { onError });
        stopWatchingClose = transport.onClose(() => {
          peerClosed = true;
          if (disposed) return;
          setClient(undefined);
          setStatus(previous => previous === "error" ? previous : "disconnected");
        });
        connected = await connecting;
        if (disposed || peerClosed) {
          connected.close();
          return;
        }
        onConnected?.(connected);
        setClient(connected);
        setStatus("ready");
      } catch (error) {
        if (disposed) return;
        close();
        onError(error);
      }
    }
    void connect(path);
    return { client, status, hello, close };
  }

  const { client: publicClient, status: publicStatus, hello: publicHello, close: closePublic } = open(publicSocket, "z-shell-ui");
  const { client: hostClient, status: hostStatus, hello: hostHello, close: closeHost } = open(hostSocket, "z-shell-host", connected => {
    // Register before publishing the host client, so this is always request 2.
    void connected.invokeCommand("host.session-register", [], { ui_session_generation: getSessionGeneration() }).catch(reportError);
  });
  let disposeTopics: (() => void) | undefined;
  onCleanup(() => {
    disposed = true;
    osdDelay.cancel();
    closePublic?.();
    closeHost?.();
    disposeTopics?.();
  });

  function subscribeOsd<T>(topic: string, compare: (current: T, previous: T) => void): TopicState<T> {
    let previous: T | undefined;
    const reset = () => { previous = undefined; };
    const state = useTopic<T>(publicClient, topic, {
      onLiveUpdate({ data }) {
        const lastSeen = previous;
        previous = data;
        if (lastSeen !== undefined) compare(data, lastSeen);
      },
      onBaselineUpdate({ data }) { previous = data; },
      onRemoved: reset,
      onReset: reset,
    });
    // Initial subscribe snapshots are only exposed through data(). Update
    // callbacks also remember samples synchronously, before Solid flushes.
    createEffect(state.data, data => { previous = data; });
    return state;
  }

  // Solid disposes child effects first. Close the bus before topic cleanup to
  // avoid sending an unsubscribe on a connection that is about to disappear.
  let topics!: ShellTopics;
  disposeTopics = runWithOwner(null, () => mountOwned(() => {
    topics = {
      theme: useTopic<ThemeTopicSnapshot>(publicClient, "theme"),
      settings: useTopic<PublicSettingsSummary>(publicClient, "settings"),
      wallpaper: useTopic<WallpaperSnapshot>(publicClient, "wallpaper"),
      outputs: useTopic<WaylandOutputsSnapshot>(publicClient, "wayland.outputs"),
      workspaces: useTopic<WaylandWorkspacesSnapshot>(publicClient, "wayland.workspaces"),
      windows: useTopic<WaylandWindowsSnapshot>(publicClient, "wayland.windows"),
      media: useTopic<DesktopMediaSnapshot>(publicClient, "desktop.media"),
      tray: useTopic<DesktopTraySnapshot>(publicClient, "desktop.tray"),
      notifications: useTopic<DesktopNotificationsSnapshot>(publicClient, "desktop.notifications"),
      ime: subscribeOsd<DesktopImeSnapshot>("desktop.ime", (current, previous) => {
        const im = current.active_im;
        if (current.switch_osd === true && im &&
          (im.unique_name !== previous.active_im?.unique_name || im.short_label !== previous.active_im?.short_label)) {
          showOsd({ kind: "ime", label: im.label || im.short_label });
        }
      }),
      audio: subscribeOsd<SystemAudioSnapshot>("system.audio", (current, previous) => {
        const sink = current.sinks.find(device => device.name === current.default_sink);
        const lastSink = previous.sinks.find(device => device.name === previous.default_sink);
        if (!sink || !lastSink) return;
        const { volume, muted } = sink;
        if (muted !== lastSink.muted) {
          showOsd({ kind: "mute", label: muted ? "Muted" : "Unmuted", value: Math.round(volume * 100), muted });
        } else if (volume !== lastSink.volume) {
          showOsd({ kind: "volume", label: "Volume", value: Math.round(volume * 100), muted });
        }
      }),
      privacy: useTopic<SystemPrivacySnapshot>(publicClient, "system.privacy"),
      network: useTopic<SystemNetworkSnapshot>(publicClient, "system.network"),
      bluetooth: useTopic<SystemBluetoothSnapshot>(publicClient, "system.bluetooth"),
      power: useTopic<SystemPowerSnapshot>(publicClient, "system.power"),
      clipboard: useTopic<ClipboardSnapshot>(publicClient, "clipboard"),
      brightness: subscribeOsd<SystemBrightnessSnapshot>("system.brightness", (current, previous) => {
        const device = current.devices[0];
        const lastDevice = previous.devices[0];
        if (!device || !lastDevice || device.max_brightness <= 0 || lastDevice.max_brightness <= 0) return;
        const ratio = device.brightness / device.max_brightness;
        if (ratio !== lastDevice.brightness / lastDevice.max_brightness) {
          showOsd({ kind: "brightness", label: "Brightness", value: Math.round(ratio * 100) });
        }
      }),
      telemetry: useTopic<SystemTelemetrySnapshot>(publicClient, "system.telemetry"),
      user: useTopic<SystemUserSnapshot>(publicClient, "system.user"),
      idle: useTopic<IdleSnapshot>(publicClient, "session.idle"),
      apps: useTopic<DesktopAppsSnapshot>(publicClient, "desktop.apps"),
      imePanel: useTopic<DesktopImePanelSnapshot>(publicClient, "desktop.ime.panel"),
      sessionLock: useTopic<LockSnapshot>(publicClient, "session.lock"),
      polkit: useTopic<PolkitSnapshot>(publicClient, "session.polkit"),
    };
    createEffect(() => topics.settings.data()?.theme.motion_scheme, setGlobalMotionScheme);
    createEffect(
      () => isSessionLockActive(topics.sessionLock.data()),
      locked => {
        if (locked) clearOverlayWithGrab();
      },
    );
  }));

  onControlMessage((args): JsonValue | undefined => {
    switch (args[0]) {
      case "status":
        return {
          publicStatus: publicStatus(),
          hostStatus: hostStatus(),
          themeDark: topics.theme.data()?.dark ?? true,
          daemonVersion: publicHello()?.daemon_version ?? hostHello()?.daemon_version ?? null,
          monitors: monitors().map(monitor => monitor.name),
          activePanel: activePanel(),
        };
      case "ping":
        return "pong";
      case "panel": {
        const panel = PANEL_IDS.find(id => id === args[1]);
        if (args[1] === "close" || panel !== undefined) {
          // Solid commits signal writes after the callback unless we flush before replying.
          flush(() => panel === undefined ? clearOverlayWithGrab() : togglePanel(panel));
          return { activePanel: activePanel() };
        }
        break;
      }
      case "settings": {
        const action = args[1];
        if (action === "close") {
          flush(closeSettingsWindow);
          return { settingsWindowOpen: false };
        }
        flush(() => openSettingsWindow(typeof action === "string" && action !== "open" ? action : undefined));
        return { settingsWindowOpen: settingsWindowOpen(), settingsWindowTab: settingsWindowTab() };
      }
      case "monitor": {
        const action = args[1];
        if (action === "close") {
          flush(closeSystemMonitorWindow);
          return { systemMonitorWindowOpen: false };
        }
        flush(() => openSystemMonitorWindow(isSystemMonitorTab(action) ? action : undefined));
        return { systemMonitorWindowOpen: systemMonitorWindowOpen(), systemMonitorWindowTab: systemMonitorWindowTab() };
      }
      case "power": {
        const action = args[1];
        if (action === "close") {
          flush(closePowerDialog);
          return { pendingPowerAction: null };
        }
        if (action === "lock" || action === "suspend" || action === "reboot" || action === "poweroff" || action === "logout") {
          flush(() => requestPowerDialog(action));
          return { pendingPowerAction: pendingPowerAction() };
        }
        break;
      }
    }
  });

  return {
    monitors, activeMonitor, powerDialogMonitor, recordActiveMonitor,
    publicClient, hostClient, publicStatus, hostStatus, publicHello, hostHello, lastError,
    ...topics,
    invokePublic: (name, payload) => invoke(publicClient(), name, payload),
    invokeHost: (name, payload) => invoke(hostClient(), name, payload),
    async invokeHostResult(name, payload) {
      const client = hostClient();
      if (!client) return { ok: false, error: "Host bus is not connected" };
      try {
        return { ok: true, result: await client.invokeCommand(name, [], payload) };
      } catch (error) {
        return { ok: false, error: reportError(error) };
      }
    },
    activePanel,
    activePanelTarget,
    overlayKind,
    barPopupGrab,
    ungrabbedBarPopupMonitorId,
    recordBarPointerDown,
    dismissBarPopupFromCompositor,
    togglePanel,
    quickSettingsPage,
    setQuickSettingsPage,
    toggleQuickSettingsPage,
    pendingQuickSettingsSubpage,
    openQuickSettingsSubpage: page => {
      if (isLocked()) return;
      const { current, recent, effective } = readOverlayTransition();
      const resolved = resolveAnchor(undefined, "quick-settings", effective);
      const inPlace = current?.kind === "panel"
        && current.target.id === "quick-settings"
        && current.target.parentSurface === resolved.parentSurface;
      setQuickSettingsPage(page);
      setPendingQuickSettingsSubpage(page);
      commitBarOverlay({ kind: "panel", target: { ...resolved, id: "quick-settings" } }, inPlace, recent, current);
    },
    consumeQuickSettingsSubpage: () => {
      const next = pendingQuickSettingsSubpage();
      if (next !== null) setPendingQuickSettingsSubpage(null);
      return next;
    },
    closePanels: () => {
      const kind = overlay()?.kind;
      if (kind === "panel" || kind === "plugin") clearOverlayWithGrab();
    },
    dismissOverlay: () => clearOverlayWithGrab(),
    activePluginPanelId,
    activePluginPanelTarget,
    togglePluginPanel,
    openPluginPanel: (instanceId, monitorId, pluginId) => {
      if (isLocked()) return;
      if (monitorId) recordActiveMonitor(monitorId);
      const { current, recent } = readOverlayTransition();
      const inPlace = current?.kind === "plugin"
        && current.instanceId === instanceId
        && current.monitorId === monitorId;
      commitBarOverlay(
        {
          kind: "plugin",
          instanceId,
          ...(pluginId !== undefined ? { pluginId } : {}),
          ...(monitorId ? { monitorId } : {}),
        },
        inPlace,
        recent,
        current,
      );
    },
    closePluginPanel: () => closeOverlay("plugin"),
    activeTrayMenu,
    openTrayMenu: target => {
      if (isLocked()) return;
      const monitorId = target.monitorId ?? inferMonitorId(target.parentSurface, monitors());
      if (monitorId) recordActiveMonitor(monitorId);
      const { current, recent } = readOverlayTransition();
      const inPlace = current?.kind === "tray"
        && current.target.itemId === target.itemId
        && current.target.parentSurface === target.parentSurface;
      commitBarOverlay({ kind: "tray", target }, inPlace, recent, current);
    },
    closeTrayMenu: () => closeOverlay("tray"),
    activeTrayOverflow,
    openTrayOverflow: target => {
      if (isLocked()) return;
      const monitorId = target.monitorId ?? inferMonitorId(target.parentSurface, monitors());
      if (monitorId) recordActiveMonitor(monitorId);
      const { current, recent, effective } = readOverlayTransition();
      if (effective?.kind === "tray-overflow" && effective.target.parentSurface === target.parentSurface) {
        clearOverlayWithGrab();
        return;
      }
      commitBarOverlay({ kind: "tray-overflow", target }, false, recent, current);
    },
    closeTrayOverflow: () => closeOverlay("tray-overflow"),
    activeImeMenu,
    openImeMenu: target => {
      if (isLocked()) return;
      const monitorId = target.monitorId ?? inferMonitorId(target.parentSurface, monitors());
      if (monitorId) recordActiveMonitor(monitorId);
      const { current, recent } = readOverlayTransition();
      const inPlace = current?.kind === "ime" && current.target.parentSurface === target.parentSurface;
      commitBarOverlay({ kind: "ime", target }, inPlace, recent, current);
    },
    closeImeMenu: () => closeOverlay("ime"),
    pendingPowerAction,
    requestPowerDialog,
    closePowerDialog,
    activeOsd,
    showOsd,
    pluginBarWidgets,
    registerPluginBarWidget,
    pluginSettingsPages,
    registerPluginSettingsPage,
    pluginUpdatesCount,
    setPluginUpdatesCount,
    settingsWindowOpen,
    settingsWindowTab,
    settingsSubpage,
    setSettingsSubpage,
    openSettingsWindow,
    closeSettingsWindow,
    systemMonitorWindowOpen,
    systemMonitorWindowTab,
    openSystemMonitorWindow,
    closeSystemMonitorWindow,
  };
}

export const ShellProvider = createContext<ShellStore | undefined>();

export function useShellStore(): ShellStore {
  const store = useContext(ShellProvider);
  if (!store) throw new Error("useShellStore requires a ShellProvider");
  return store;
}

/**
 * Pins an overlay to the active output when its session starts.
 * Tracks monitor hotplug, but samples focus only when acquiring an output.
 */
export function usePinnedOutput<K = true>(
  sessionKey: Accessor<K | null | undefined>,
): Accessor<string | null> {
  const { monitors, activeMonitor } = useShellStore();
  const pinned = createMemo<PinnedOutputState<K>>(previous => {
    const key = sessionKey() ?? null;
    return resolvePinnedOutput(
      previous,
      key,
      key === null ? [] : monitors(),
      () => untrack(activeMonitor)?.id ?? null,
    );
  });
  return () => pinned().outputId;
}
