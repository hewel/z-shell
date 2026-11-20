import { createContext, createSignal, onCleanup, runWithOwner, useContext, useMonitors, type Accessor, type Monitor } from "@hewel/zgui";
import { mountOwned } from "@hewel/zgui/renderer";
import { getResolvedCapabilities, onControlMessage } from "@hewel/zgui-services";
import { ZShellClient, type BusHelloResult, type BusTransport } from "@z-shell/sdk";
import { createZguiSocketTransport, useTopic, type TopicState } from "@z-shell/sdk/zgui";
import type { ThemeTopicSnapshot } from "./theme.ts";

export type SocketStatus = "disconnected" | "connecting" | "ready" | "error";

export type ShellSocketPaths = {
  readonly publicSocket: string | null;
  readonly hostSocket: string | null;
};

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

export interface ShellStore {
  readonly monitors: Accessor<readonly Monitor[]>;
  readonly publicClient: Accessor<ZShellClient | undefined>;
  readonly hostClient: Accessor<ZShellClient | undefined>;
  readonly publicStatus: Accessor<SocketStatus>;
  readonly hostStatus: Accessor<SocketStatus>;
  readonly publicHello: Accessor<BusHelloResult | undefined>;
  readonly hostHello: Accessor<BusHelloResult | undefined>;
  readonly lastError: Accessor<string | undefined>;
  readonly theme: TopicState<ThemeTopicSnapshot>;
}

export function createShellStore(): ShellStore {
  const monitors = useMonitors();
  const { publicSocket, hostSocket } = resolveShellSocketPaths(getResolvedCapabilities().unixSockets);
  const [lastError, setLastError] = createSignal<string>();
  let disposed = false;

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
      setLastError(error instanceof Error ? error.message : String(error));
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
  let disposeTheme: (() => void) | undefined;
  onCleanup(() => {
    disposed = true;
    closePublic?.();
    closeHost?.();
    disposeTheme?.();
  });
  // Solid disposes child effects first. Close the bus before topic cleanup to
  // avoid sending an unsubscribe on a connection that is about to disappear.
  let theme!: TopicState<ThemeTopicSnapshot>;
  disposeTheme = runWithOwner(null, () => mountOwned(() => {
    theme = useTopic<ThemeTopicSnapshot>(publicClient, "theme");
  }));

  onControlMessage(args => {
    switch (args[0]) {
      case "status":
        return {
          publicStatus: publicStatus(),
          hostStatus: hostStatus(),
          themeDark: theme.data()?.dark ?? true,
          daemonVersion: publicHello()?.daemon_version ?? hostHello()?.daemon_version ?? null,
          monitors: monitors().map(monitor => monitor.name),
        };
      case "ping":
        return "pong";
    }
  });

  return { monitors, publicClient, hostClient, publicStatus, hostStatus, publicHello, hostHello, lastError, theme };
}

export const ShellProvider = createContext<ShellStore | undefined>();

export function useShellStore(): ShellStore {
  const store = useContext(ShellProvider);
  if (!store) throw new Error("useShellStore requires a ShellProvider");
  return store;
}
