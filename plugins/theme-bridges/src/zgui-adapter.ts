import { getOwner, onCleanup } from "@hewel/zgui";
import { connectUnixSocket, type UnixSocket } from "@hewel/zgui-services";
import { createThemeBridgesPlugin, type ThemeBridgesRuntime } from "./service.ts";

export function createZguiThemeBridgesRuntime(): ThemeBridgesRuntime {
  return {
    async sendShojiWmTheme(socketPath, payload) {
      let socket: UnixSocket | undefined;
      let cancelDeadline: (() => void) | undefined;
      try {
        // The native bundle targets ES2022; Promise.withResolvers is not in that contract.
        await new Promise<void>((resolve, reject) => {
          socket = connectUnixSocket(socketPath, {
            framing: "line",
            onMessage: () => resolve(),
            onClose: error => reject(error ?? new Error("ShojiWM disconnected before replying")),
          });
          if (getOwner()) onCleanup(() => reject(new Error("ShojiWM request cancelled")));
          const deadline = setTimeout(() => reject(new Error("ShojiWM did not reply within 5 seconds")), 5_000);
          cancelDeadline = () => clearTimeout(deadline);
          socket.send(JSON.stringify(payload));
        });
      } finally {
        cancelDeadline?.();
        socket?.close();
      }
    },
  };
}

export function createZguiThemeBridgesPlugin() {
  return createThemeBridgesPlugin(createZguiThemeBridgesRuntime());
}

export default createZguiThemeBridgesPlugin();
