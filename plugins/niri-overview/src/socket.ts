import type { NiriEvent, NiriOutput, NiriSocketTransport, NiriState, NiriWindow, NiriWorkspace } from "./service.ts";

interface UnixSocket {
  send(line: string): void;
  close(): void;
}

interface NiriHost {
  connectUnixSocket(path: string, options: {
    framing: "line";
    onMessage(line: string): void;
    onClose(): void;
  }): UnixSocket;
}

const host = globalThis as {
  readonly __zguiServices?: NiriHost;
  setTimeout?(cb: () => void, delayMs: number): unknown;
  clearTimeout?(timer: unknown): void;
};

export function scheduleNiriRetry(delayMs: number, cb: () => void): (() => void) | undefined {
  if (!host.setTimeout || !host.clearTimeout) return undefined;
  const timer = host.setTimeout(cb, delayMs);
  return () => host.clearTimeout?.(timer);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid Niri object");
  return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("invalid Niri list");
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid Niri number");
  return value;
}

function id(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid Niri ID");
  return value;
}

function geometry(value: unknown): NiriWindow["geometry"] {
  if (value == null) return null;
  const layout = object(value);
  if (layout.tile_pos_in_workspace_view == null) return null;
  const [x, y] = list(layout.tile_pos_in_workspace_view);
  const [width, height] = list(layout.tile_size);
  return { x: number(x), y: number(y), width: number(width), height: number(height) };
}

function outputList(value: unknown): NiriOutput[] {
  const outputs: NiriOutput[] = [];
  for (const [name, raw] of Object.entries(object(value))) {
    const output = object(raw);
    if (output.logical == null) continue;
    const logical = object(output.logical);
    outputs.push({ name, width: number(logical.width), height: number(logical.height) });
  }
  return outputs;
}

function workspace(value: unknown): NiriWorkspace {
  const ws = object(value);
  return {
    id: id(ws.id), index: number(ws.idx), output: typeof ws.output === "string" ? ws.output : null,
    active: ws.is_active === true, focused: ws.is_focused === true,
  };
}

function window(value: unknown): NiriWindow {
  const win = object(value);
  return {
    id: id(win.id), workspaceId: win.workspace_id == null ? null : id(win.workspace_id),
    ...(typeof win.title === "string" ? { title: win.title } : {}),
    ...(typeof win.app_id === "string" ? { appId: win.app_id } : {}),
    floating: win.is_floating === true, focused: win.is_focused === true,
    geometry: win.is_minimized === true ? null : geometry(win.layout),
  };
}

function event(value: unknown): NiriEvent | undefined {
  const frame = object(value);
  if ("WorkspacesChanged" in frame) return { type: "WorkspacesChanged", workspaces: list(object(frame.WorkspacesChanged).workspaces).map(workspace) };
  if ("WorkspaceActivated" in frame) {
    const ws = object(frame.WorkspaceActivated);
    return { type: "WorkspaceActivated", id: id(ws.id), focused: ws.focused === true };
  }
  if ("WindowsChanged" in frame) return { type: "WindowsChanged", windows: list(object(frame.WindowsChanged).windows).map(window) };
  if ("WindowOpenedOrChanged" in frame) return { type: "WindowOpenedOrChanged", window: window(object(frame.WindowOpenedOrChanged).window) };
  if ("WindowClosed" in frame) return { type: "WindowClosed", id: id(object(frame.WindowClosed).id) };
  if ("WindowFocusChanged" in frame) {
    const focused = object(frame.WindowFocusChanged).id;
    return { type: "WindowFocusChanged", id: focused === null ? null : id(focused) };
  }
  if ("WindowLayoutsChanged" in frame) {
    const changes = new Map<number, NiriWindow["geometry"]>();
    for (const change of list(object(frame.WindowLayoutsChanged).changes)) {
      const [key, layout] = list(change);
      changes.set(id(key), geometry(layout));
    }
    return { type: "WindowLayoutsChanged", changes };
  }
  return undefined;
}

/** `socketPath` must be the canonical, host-approved path resolved from NIRI_SOCKET by the composition. */
export function createNiriSocketTransport(
  socketPath: string | undefined, native: NiriHost | undefined = host.__zguiServices,
): NiriSocketTransport {
  let baseline: Promise<NiriState> | undefined;
  let closeActive: (() => void) | undefined;

  return {
    isAvailable: () => !!socketPath && typeof native?.connectUnixSocket === "function",
    requestSnapshot() {
      if (!baseline) return Promise.reject(new Error("Niri event stream is not active"));
      return baseline;
    },
    subscribeEvents(onEvent, onDisconnect) {
      if (!socketPath || !native?.connectUnixSocket) throw new Error("Niri socket service unavailable");
      closeActive?.();
      let socket: UnixSocket | undefined;
      let step = 0;
      let closed = false;
      let outputs: NiriOutput[] = [];
      let workspaces: NiriWorkspace[] = [];
      let windows: NiriWindow[] = [];
      // ES2022 does not have Promise.withResolvers. The socket callbacks settle this baseline.
      let resolve!: (state: NiriState) => void;
      let reject!: (reason: Error) => void;
      const pending = new Promise<NiriState>((yes, no) => { resolve = yes; reject = no; });
      baseline = pending;
      void pending.catch(() => undefined); // The socket can close before the caller asks for its baseline.
      const cancelDeadline = scheduleNiriRetry(5_000, disconnect);

      function close(): void {
        if (closed) return;
        closed = true;
        cancelDeadline?.();
        socket?.close();
        reject(new Error("Niri event stream closed"));
        if (baseline === pending) {
          baseline = undefined;
          closeActive = undefined;
        }
      }

      function disconnect(): void {
        if (closed) return;
        close();
        onDisconnect();
      }

      closeActive = close;
      try {
        socket = native.connectUnixSocket(socketPath, {
          framing: "line",
          onClose: disconnect,
          onMessage(line) {
            if (closed) return;
            try {
              const frame: unknown = JSON.parse(line);
              if (step === 4) {
                const update = event(frame);
                if (update) onEvent(update);
                return;
              }
              const payload = object(frame).Ok;
              switch (step++) {
                case 0: outputs = outputList(object(payload).Outputs); break;
                case 1: workspaces = list(object(payload).Workspaces).map(workspace); break;
                case 2: windows = list(object(payload).Windows).map(window); break;
                case 3:
                  if (payload !== "Handled") throw new Error("Niri did not accept EventStream");
                  cancelDeadline?.();
                  resolve({ outputs, workspaces, windows });
                  break;
              }
            } catch {
              disconnect();
            }
          },
        });
        if (closed) {
          socket.close();
          return close;
        }
        // Take the baseline and enable EventStream on the same ordered connection.
        // EventStream's initial workspace/window events then reconcile changes during the queries.
        for (const request of ["Outputs", "Workspaces", "Windows", "EventStream"]) socket.send(JSON.stringify(request));
      } catch (error) {
        close();
        throw error;
      }
      return close;
    },
  };
}
