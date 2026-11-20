import type {} from "@hewel/zgui/runtime-globals";
import { createNoSleepPlugin, type NoSleepRuntime } from "./service.ts";

export function createZguiNoSleepRuntime(): NoSleepRuntime {
  return {
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

export function createZguiNoSleepPlugin() {
  return createNoSleepPlugin(createZguiNoSleepRuntime());
}

export default createZguiNoSleepPlugin();
