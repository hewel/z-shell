import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { computeContentDigest, parsePluginManifest } from "@z-shell/composer";
import { createPluginContext } from "@z-shell/plugin-api";
import { FixtureTransport, ZShellClient, type CommandInvokeResult } from "@z-shell/sdk";

import {
  THEME_BRIDGES_DEFAULTS,
  createThemeBridgesPlugin,
  type ShojiWmThemeRequest,
  type ThemeBridgesStatus,
} from "../src/service.ts";

const PLUGIN_ROOT = resolve(import.meta.dir, "..");

function createThemeBusHarness(initialTheme: unknown) {
  const topics = new Map<string, { revision: number; data: unknown }>([
    ["theme", { revision: 1, data: initialTheme }],
  ]);
  const pendingReplies = new Map<
    number,
    { resolve: (result: CommandInvokeResult) => void; reject: (err: Error) => void }
  >();
  let nextCallId = 1;

  const transport = new FixtureTransport((frame) => {
    switch (frame.method) {
      case "bus.hello":
        return {
          result: {
            protocol_version: 1,
            daemon_version: "0.1.0-test",
            daemon_instance_id: "daemon-test",
            role: "public",
            client_id: 1,
          },
        };
      case "topic.subscribe": {
        const params = frame.params as { topic: string };
        const entry = topics.get(params.topic) ?? { revision: 1, data: {} };
        return {
          result: {
            topic: params.topic,
            topic_instance_id: 1,
            revision: entry.revision,
            data: entry.data,
            owner: { kind: "core" },
          },
        };
      }
      case "topic.unsubscribe":
      case "topic.unregister":
      case "command.register":
      case "command.unregister":
        return { result: {} };
      case "command.reply": {
        const params = frame.params as {
          call_id: number;
          result?: CommandInvokeResult;
          error?: string;
        };
        const pending = pendingReplies.get(params.call_id);
        if (pending) {
          pendingReplies.delete(params.call_id);
          if (params.error !== undefined) {
            pending.reject(new Error(params.error));
          } else {
            pending.resolve(params.result ?? {});
          }
        }
        return { result: {} };
      }
      case "topic.register": {
        const params = frame.params as { topic: string; initial: unknown };
        topics.set(params.topic, { revision: 1, data: params.initial });
        return { result: { topic_instance_id: 2, revision: 1 } };
      }
      case "topic.publish": {
        const params = frame.params as { topic: string; data: unknown };
        const prev = topics.get(params.topic)?.revision ?? 0;
        const revision = prev + 1;
        topics.set(params.topic, { revision, data: params.data });
        return { result: { revision } };
      }
      default:
        return { error: { code: "method_not_found", message: `unexpected method: ${frame.method}` } };
    }
  });

  function pushThemeUpdate(revision: number, data: unknown): void {
    topics.set("theme", { revision, data });
    transport.emitTopicUpdate({
      topic: "theme",
      topic_instance_id: 1,
      revision,
      data,
      source_baseline: false,
    });
  }

  function dispatchCommand(name: string, payload?: unknown): Promise<CommandInvokeResult> {
    const call_id = nextCallId++;
    const promise = new Promise<CommandInvokeResult>((resolveReply, rejectReply) => {
      pendingReplies.set(call_id, { resolve: resolveReply, reject: rejectReply });
    });
    transport.emitCommandDispatch({
      call_id,
      name,
      args: [],
      ...(payload !== undefined ? { payload } : {}),
    });
    return promise;
  }

  return { transport, topics, pushThemeUpdate, dispatchCommand };
}

describe("z-shell/theme-bridges plugin", () => {
  test("plugin.toml passes static manifest validation and deterministic digest", () => {
    const manifest = parsePluginManifest(PLUGIN_ROOT);
    expect(manifest.id).toBe("z-shell/theme-bridges");
    expect(manifest.busPermissions.topicsRead).toEqual(["theme"]);
    expect(manifest.busPermissions.topicsPublish).toEqual(["plugin.z-shell.theme-bridges.status"]);
    expect(manifest.busPermissions.commandsRegister).toEqual([
      "plugin.z-shell.theme-bridges.reapply",
      "plugin.z-shell.theme-bridges.revert",
    ]);
    expect(computeContentDigest(PLUGIN_ROOT)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("bridges stay disabled by default without touching sockets or files", async () => {
    const harness = createThemeBusHarness({
      mode: "dark",
      roles: { primary: "#6750a4", surface: "#141218" },
    });
    const client = await ZShellClient.connect(harness.transport);

    let called = false;
    const plugin = createThemeBridgesPlugin({
      sendShojiWmTheme: () => {
        called = true;
      },
      writeFileAtomic: () => {
        called = true;
      },
    });
    const ctx = createPluginContext("z-shell/theme-bridges", client, THEME_BRIDGES_DEFAULTS);
    const cleanup = await plugin.setup(ctx);

    const status = harness.topics.get("plugin.z-shell.theme-bridges.status")
      ?.data as ThemeBridgesStatus;
    expect(called).toBe(false);
    expect(status.shojiwm.state).toBe("disabled");
    expect(status.zenBrowser.state).toBe("disabled");

    await cleanup?.();
  });

  test("isolates ShojiWM failure while applying and reverting Zen Browser CSS with conflict detection", async () => {
    const harness = createThemeBusHarness({
      mode: "dark",
      roles: { primary: "#d0bcff", surface: "#141218", on_surface: "#e6e0e9" },
    });
    const client = await ZShellClient.connect(harness.transport);

    const files = new Map<string, string>([
      ["/tmp/zen-profile/chrome/userChrome.css", "/* user original css */\n"],
    ]);
    const shojiRequests: { socket: string; payload: ShojiWmThemeRequest }[] = [];
    let failShoji = true;

    const plugin = createThemeBridgesPlugin({
      sendShojiWmTheme: (socketPath, payload) => {
        shojiRequests.push({ socket: socketPath, payload });
        if (failShoji) {
          throw new Error("shojiwm socket ENOENT");
        }
      },
      readFile: (path) => files.get(path) ?? null,
      writeFileAtomic: (path, content) => {
        files.set(path, content);
      },
      removeFile: (path) => {
        files.delete(path);
      },
    });

    const ctx = createPluginContext("z-shell/theme-bridges", client, THEME_BRIDGES_DEFAULTS, {
      enable_shojiwm: true,
      shojiwm_socket: "/run/user/1000/shojiwm.sock",
      enable_zen_browser: true,
      zen_chrome_dir: "/tmp/zen-profile/chrome",
    });
    const cleanup = await plugin.setup(ctx);

    // ShojiWM failed, yet Zen Browser still applied cleanly and preserved original backup!
    const status1 = harness.topics.get("plugin.z-shell.theme-bridges.status")
      ?.data as ThemeBridgesStatus;
    expect(status1.shojiwm.state).toBe("error");
    expect(status1.shojiwm.message).toContain("ENOENT");
    expect(status1.zenBrowser.state).toBe("applied");
    expect(files.get("/tmp/zen-profile/chrome/userChrome.css")).toContain("--zen-primary-color: #d0bcff;");
    expect(files.has("/tmp/zen-profile/chrome/z-shell-theme-recovery.json")).toBe(true);

    // Recover ShojiWM and push live theme update -> both bridges apply!
    failShoji = false;
    harness.pushThemeUpdate(2, {
      mode: "light",
      roles: { primary: "#6750a4", surface: "#fef7ff", on_surface: "#1d1b20" },
    });
    await Bun.sleep(20);
    const status2 = harness.topics.get("plugin.z-shell.theme-bridges.status")
      ?.data as ThemeBridgesStatus;
    expect(status2.shojiwm.state).toBe("applied");
    expect(status2.shojiwm.lastRevision).toBe(2);
    expect(shojiRequests.at(-1)?.payload.method).toBe("theme.set");
    expect(shojiRequests.at(-1)?.payload.params.mode).toBe("light");
    expect(status2.zenBrowser.state).toBe("applied");
    expect(files.get("/tmp/zen-profile/chrome/userChrome.css")).toContain("--zen-primary-color: #6750a4;");

    // Simulate external user edit to userChrome.css -> reapply must detect conflict and refuse clobber!
    const customUserCss = "/* manual edit by user */\n";
    files.set("/tmp/zen-profile/chrome/userChrome.css", customUserCss);
    const conflictReply = await harness.dispatchCommand("plugin.z-shell.theme-bridges.reapply");
    const conflictStatus = conflictReply.data as ThemeBridgesStatus;
    expect(conflictStatus.zenBrowser.state).toBe("conflict");
    expect(files.get("/tmp/zen-profile/chrome/userChrome.css")).toBe(customUserCss);

    // Non-forced revert also refuses to overwrite externally edited file!
    const blockedRevert = await harness.dispatchCommand("plugin.z-shell.theme-bridges.revert");
    expect((blockedRevert.data as ThemeBridgesStatus).zenBrowser.state).toBe("conflict");
    expect(files.get("/tmp/zen-profile/chrome/userChrome.css")).toBe(customUserCss);

    // Forced revert restores the original pre-bridge userChrome.css and removes recovery record!
    const forcedRevert = await harness.dispatchCommand("plugin.z-shell.theme-bridges.revert", {
      force: true,
    });
    expect((forcedRevert.data as ThemeBridgesStatus).zenBrowser.state).toBe("reverted");
    expect(files.get("/tmp/zen-profile/chrome/userChrome.css")).toBe("/* user original css */\n");
    expect(files.has("/tmp/zen-profile/chrome/z-shell-theme-recovery.json")).toBe(false);

    await cleanup?.();
  });
});
