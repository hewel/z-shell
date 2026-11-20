import { createContext, createSignal, flush, onCleanup, runWithOwner, useContext, useMonitors, type Accessor, type Monitor, type NativeChild, type NativeWindowRect } from "@hewel/zgui";
import { mountOwned } from "@hewel/zgui/renderer";
import { getResolvedCapabilities, onControlMessage, type JsonValue } from "@hewel/zgui-services";
import { ZShellClient, type BusHelloResult, type BusTransport, type CommandInvokeResult } from "@z-shell/sdk";
import { createZguiSocketTransport, useTopic, type TopicState } from "@z-shell/sdk/zgui";
import type { ThemeTopicSnapshot } from "./theme.ts";
import type {
  DesktopImeSnapshot,
  DesktopMediaSnapshot,
  DesktopNotificationsSnapshot,
  DesktopTraySnapshot,
  PublicSettingsSummary,
  SystemAudioSnapshot,
  SystemBluetoothSnapshot,
  SystemNetworkSnapshot,
  SystemPowerSnapshot,
  SystemPrivacySnapshot,
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
] as const;

export type SocketStatus = "disconnected" | "connecting" | "ready" | "error";

export type ShellSocketPaths = {
  readonly publicSocket: string | null;
  readonly hostSocket: string | null;
};

const PANEL_IDS = ["launcher", "overview", "calendar", "media", "quick-settings", "battery", "clipboard"] as const;
export type PanelId = typeof PANEL_IDS[number];

export type TrayMenuTarget = {
  readonly itemId: string;
  readonly parentSurface: string;
  readonly anchorRect: NativeWindowRect;
};

export type ImeMenuTarget = {
  readonly parentSurface: string;
  readonly anchorRect: NativeWindowRect;
};

export type PluginBarWidgetSlot = {
  readonly id: string;
  readonly outputId?: string;
  readonly render: (props: { readonly vertical: boolean }) => NativeChild;
};

type BarOverlay =
  | { readonly kind: "panel"; readonly panel: PanelId }
  | { readonly kind: "tray"; readonly target: TrayMenuTarget }
  | { readonly kind: "ime"; readonly target: ImeMenuTarget };

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
}

export interface ShellStore extends ShellTopics {
  readonly monitors: Accessor<readonly Monitor[]>;
  readonly publicClient: Accessor<ZShellClient | undefined>;
  readonly hostClient: Accessor<ZShellClient | undefined>;
  readonly publicStatus: Accessor<SocketStatus>;
  readonly hostStatus: Accessor<SocketStatus>;
  readonly publicHello: Accessor<BusHelloResult | undefined>;
  readonly hostHello: Accessor<BusHelloResult | undefined>;
  readonly lastError: Accessor<string | undefined>;
  invokePublic(name: string, payload?: unknown): Promise<CommandInvokeResult | undefined>;
  invokeHost(name: string, payload?: unknown): Promise<CommandInvokeResult | undefined>;
  readonly activePanel: Accessor<PanelId | null>;
  togglePanel(id: PanelId): void;
  closePanels(): void;
  readonly activeTrayMenu: Accessor<TrayMenuTarget | null>;
  openTrayMenu(target: TrayMenuTarget): void;
  closeTrayMenu(): void;
  readonly activeImeMenu: Accessor<ImeMenuTarget | null>;
  openImeMenu(target: ImeMenuTarget): void;
  closeImeMenu(): void;
  readonly pluginBarWidgets: Accessor<readonly PluginBarWidgetSlot[]>;
  registerPluginBarWidget(slot: PluginBarWidgetSlot): () => void;
}

export function createShellStore(): ShellStore {
  const monitors = useMonitors();
  const { publicSocket, hostSocket } = resolveShellSocketPaths(getResolvedCapabilities().unixSockets);
  const [lastError, setLastError] = createSignal<string>();
  let disposed = false;
  const [overlay, setOverlay] = createSignal<BarOverlay | null>(null);
  const activePanel = () => {
    const active = overlay();
    return active?.kind === "panel" ? active.panel : null;
  };
  const activeTrayMenu = () => {
    const active = overlay();
    return active?.kind === "tray" ? active.target : null;
  };
  const activeImeMenu = () => {
    const active = overlay();
    return active?.kind === "ime" ? active.target : null;
  };
  const togglePanel = (panel: PanelId) => {
    setOverlay(active => active?.kind === "panel" && active.panel === panel ? null : { kind: "panel", panel });
  };
  const closeOverlay = (kind: BarOverlay["kind"]) => {
    setOverlay(active => active?.kind === kind ? null : active);
  };

  const [pluginBarWidgets, setPluginBarWidgets] = createSignal<readonly PluginBarWidgetSlot[]>([]);
  function registerPluginBarWidget(slot: PluginBarWidgetSlot): () => void {
    const registration = { ...slot };
    setPluginBarWidgets(slots => [...slots, registration]);
    return () => setPluginBarWidgets(slots => slots.includes(registration)
      ? slots.filter(candidate => candidate !== registration)
      : slots);
  }

  function reportError(error: unknown): void {
    if (!disposed) setLastError(error instanceof Error ? error.message : String(error));
  }

  async function invoke(client: ZShellClient | undefined, name: string, payload?: unknown) {
    try {
      return await client?.invokeCommand(name, [], payload);
    } catch (error) {
      reportError(error);
      return undefined;
    }
  }

  function open(path: string | null, name: string) {
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
  const { client: hostClient, status: hostStatus, hello: hostHello, close: closeHost } = open(hostSocket, "z-shell-host");
  let disposeTopics: (() => void) | undefined;
  onCleanup(() => {
    disposed = true;
    closePublic?.();
    closeHost?.();
    disposeTopics?.();
  });
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
      ime: useTopic<DesktopImeSnapshot>(publicClient, "desktop.ime"),
      audio: useTopic<SystemAudioSnapshot>(publicClient, "system.audio"),
      privacy: useTopic<SystemPrivacySnapshot>(publicClient, "system.privacy"),
      network: useTopic<SystemNetworkSnapshot>(publicClient, "system.network"),
      bluetooth: useTopic<SystemBluetoothSnapshot>(publicClient, "system.bluetooth"),
      power: useTopic<SystemPowerSnapshot>(publicClient, "system.power"),
    };
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
        if (args[1] === "close") {
          setOverlay(null);
          return { activePanel: null };
        }
        const panel = PANEL_IDS.find(id => id === args[1]);
        if (panel !== undefined) {
          // Solid commits signal writes after the callback unless we flush before replying.
          flush(() => togglePanel(panel));
          return { activePanel: activePanel() };
        }
        break;
      }
    }
  });

  return {
    monitors, publicClient, hostClient, publicStatus, hostStatus, publicHello, hostHello, lastError,
    ...topics,
    invokePublic: (name, payload) => invoke(publicClient(), name, payload),
    invokeHost: (name, payload) => invoke(hostClient(), name, payload),
    activePanel,
    togglePanel,
    closePanels: () => closeOverlay("panel"),
    activeTrayMenu,
    openTrayMenu: target => setOverlay({ kind: "tray", target }),
    closeTrayMenu: () => closeOverlay("tray"),
    activeImeMenu,
    openImeMenu: target => setOverlay({ kind: "ime", target }),
    closeImeMenu: () => closeOverlay("ime"),
    pluginBarWidgets,
    registerPluginBarWidget,
  };
}

export const ShellProvider = createContext<ShellStore | undefined>();

export function useShellStore(): ShellStore {
  const store = useContext(ShellProvider);
  if (!store) throw new Error("useShellStore requires a ShellProvider");
  return store;
}
