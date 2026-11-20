import { getOwner, onCleanup, runWithOwner } from "@hewel/zgui";
import { connectUnixSocket, type HostServiceError } from "@hewel/zgui-services";
import type { BusTransport, Unsubscribe } from "./transport.ts";

export interface ZguiSocketTransportOptions {
  readonly onError?: (error: HostServiceError) => void;
}

export function createZguiSocketTransport(
  path: string,
  options?: ZguiSocketTransportOptions,
): BusTransport {
  const lineListeners = new Set<(line: string) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;

  // Own the cleanup here so closing explicitly and then disposing the owner only closes once.
  const socket = runWithOwner(null, () => connectUnixSocket(path, {
    framing: "line",
    onMessage(line) {
      if (closed) return;
      for (const listener of [...lineListeners]) {
        try {
          listener(line);
        } catch {
          // One listener must not interrupt delivery to the others.
        }
        if (closed) break;
      }
    },
    onClose(error) {
      if (closed) return;
      closed = true;
      const listeners = [...closeListeners];
      lineListeners.clear();
      closeListeners.clear();
      if (error !== null) {
        try {
          options?.onError?.(error);
        } catch {
          // The error hook must not prevent close notification.
        }
      }
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // Deliver close to all listeners even if one fails.
        }
      }
    },
  }));

  function close(): void {
    if (closed) return;
    closed = true;
    lineListeners.clear();
    closeListeners.clear();
    socket.close();
  }
  if (getOwner()) onCleanup(close);

  return {
    sendLine(line: string): void {
      if (closed) throw new Error("zgui socket transport is closed");
      if (line.endsWith("\n")) {
        line = line.slice(0, line.endsWith("\r\n") ? -2 : -1);
      }
      if (line.includes("\n") || line.includes("\r")) {
        throw new Error("zgui socket transport expects a single line");
      }
      socket.send(line);
    },
    onLine(listener: (line: string) => void): Unsubscribe {
      if (!closed) lineListeners.add(listener);
      return () => { lineListeners.delete(listener); };
    },
    onClose(listener: () => void): Unsubscribe {
      if (!closed) closeListeners.add(listener);
      return () => { closeListeners.delete(listener); };
    },
    close,
  };
}
