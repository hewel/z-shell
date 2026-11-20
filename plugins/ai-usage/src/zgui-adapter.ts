import type {} from "@hewel/zgui/runtime-globals";
import { spawnCommand } from "@hewel/zgui-services";
import { createAiUsagePlugin, type AiUsageRuntime } from "./service.ts";

export function createZguiAiUsageRuntime(): AiUsageRuntime {
  return {
    execCommand(cmd, args) {
      const request = spawnCommand(cmd, args);
      let cancelled = false;
      return {
        promise: request.promise,
        cancel() {
          if (cancelled) return;
          cancelled = true;
          request.cancel();
        },
      };
    },
    fetchJson() {
      // The native host has no HTTP service; do not bypass its capability model.
      throw new Error("HTTP adapter unavailable");
    },
    now: Date.now,
    schedule(delayMs, callback) {
      let timer: number | undefined = setTimeout(() => {
        timer = undefined;
        callback();
      }, delayMs);
      return () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
      };
    },
  };
}

export function createZguiAiUsagePlugin() {
  return createAiUsagePlugin(createZguiAiUsageRuntime());
}

export default createZguiAiUsagePlugin();
