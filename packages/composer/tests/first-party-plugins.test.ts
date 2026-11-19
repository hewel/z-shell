import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createPluginContext } from "@z-shell/plugin-api";
import { ZShellClient, type InhibitorEntry } from "@z-shell/sdk";
import { connectUnixSocket } from "@z-shell/sdk/bun";

import { NOSLEEP_DEFAULTS, createNoSleepPlugin } from "../../../plugins/nosleep/src/service.ts";
import {
  THEME_BRIDGES_DEFAULTS,
  createThemeBridgesPlugin,
  type ShojiWmThemeRequest,
  type ThemeBridgesStatus,
} from "../../../plugins/theme-bridges/src/service.ts";
import { composePlugins } from "../src/index.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

function resolveBinaries(): { cliBin: string; daemonBin: string } {
  const meta = Bun.spawnSync(["cargo", "metadata", "--format-version", "1", "--no-deps"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
  });
  expect(meta.exitCode).toBe(0);
  const targetDir = (JSON.parse(meta.stdout.toString()) as { target_directory: string })
    .target_directory;
  return {
    cliBin: join(targetDir, "debug", "z-shell"),
    daemonBin: join(targetDir, "debug", "z-shelld"),
  };
}

describe("First-party reference plugins end-to-end", () => {
  test("Rust CLI + @z-shell/composer register, approve, enable, and compose all 4 first-party plugins", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "z-shell-first-party-compose-"));
    try {
      const { cliBin } = resolveBinaries();
      const configDir = join(tempDir, "config");
      const stateDir = join(tempDir, "state");
      const runCli = (args: string[]) =>
        Bun.spawnSync(
          [cliBin, "--config-dir", configDir, "--state-dir", stateDir, "--json", ...args],
          { stdout: "pipe", stderr: "pipe" },
        );

      const plugins = [
        { id: "z-shell/ai-usage", dir: join(REPO_ROOT, "plugins", "ai-usage") },
        { id: "z-shell/nosleep", dir: join(REPO_ROOT, "plugins", "nosleep") },
        { id: "z-shell/theme-bridges", dir: join(REPO_ROOT, "plugins", "theme-bridges") },
        { id: "z-shell/niri-overview", dir: join(REPO_ROOT, "plugins", "niri-overview") },
      ] as const;

      for (const plugin of plugins) {
        const add = runCli(["plugin", "add", "--path", plugin.dir]);
        expect(add.exitCode, `add ${plugin.id}: ${add.stderr.toString()}`).toBe(0);

        const audit = runCli(["plugin", "audit", plugin.id]);
        expect(audit.exitCode, `audit ${plugin.id}: ${audit.stderr.toString()}`).toBe(0);

        const approve = runCli(["plugin", "approve", plugin.id]);
        expect(approve.exitCode, `approve ${plugin.id}: ${approve.stderr.toString()}`).toBe(0);

        const enable = runCli(["plugin", "enable", plugin.id]);
        expect(enable.exitCode, `enable ${plugin.id}: ${enable.stderr.toString()}`).toBe(0);
      }

      const registryPath = join(stateDir, "plugins", "registry.json");
      const outDir = join(tempDir, "composed");
      const report = composePlugins({
        registryPath,
        outDir,
        candidateId: "first-party-cand-1",
      });

      expect(report.status).toBe("candidate_published");
      expect(Object.keys(report.pluginDigests).sort()).toEqual([
        "z-shell/ai-usage",
        "z-shell/niri-overview",
        "z-shell/nosleep",
        "z-shell/theme-bridges",
      ]);

      const manifestCaps = JSON.parse(
        readFileSync(join(outDir, "manifest-capabilities.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(manifestCaps).toEqual({
        commands: ["ai-usagebar"],
        shellSurfaces: true,
        controlChannel: true,
      });
      expect("sessionLock" in manifestCaps).toBe(false);

      const composedSource = readFileSync(join(outDir, "composed-plugins.ts"), "utf8");
      for (const plugin of plugins) {
        expect(composedSource).toContain(`${plugin.id}:service`);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("z-shell/nosleep drives real z-shelld bus inhibitors and auto-cleans on abrupt disconnect", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "z-shell-nosleep-live-"));
    const { daemonBin } = resolveBinaries();
    const configDir = join(tempDir, "config");
    const stateDir = join(tempDir, "state");
    const runtimeDir = join(tempDir, "runtime");
    const publicSock = join(runtimeDir, "bus.sock");
    const hostSock = join(runtimeDir, "host.sock");

    const daemon = Bun.spawn(
      [
        daemonBin,
        "--config-dir",
        configDir,
        "--state-dir",
        stateDir,
        "--runtime-dir",
        runtimeDir,
        "--socket",
        publicSock,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    let hostClient: ZShellClient | undefined;
    let observerClient: ZShellClient | undefined;
    let pluginTransport: Awaited<ReturnType<typeof connectUnixSocket>> | undefined;

    try {
      const deadline = Date.now() + 5000;
      while ((!existsSync(publicSock) || !existsSync(hostSock)) && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      expect(existsSync(publicSock)).toBe(true);
      expect(existsSync(hostSock)).toBe(true);

      pluginTransport = await connectUnixSocket(publicSock);
      const pluginClient = await ZShellClient.connect(pluginTransport, "nosleep-plugin");
      observerClient = await ZShellClient.connect(
        await connectUnixSocket(publicSock),
        "observer",
      );
      hostClient = await ZShellClient.connect(await connectUnixSocket(hostSock), "host");

      const plugin = createNoSleepPlugin();
      const ctx = createPluginContext("z-shell/nosleep", pluginClient, NOSLEEP_DEFAULTS);
      await plugin.setup(ctx);

      const latestInhibitors: InhibitorEntry[][] = [];
      const sub = await observerClient.subscribe<InhibitorEntry[]>("inhibitors", (update) => {
        latestInhibitors.push(update.data);
      });
      expect(sub.snapshot.data).toEqual([]);

      // Invoke plugin.z-shell.nosleep.toggle from a second live bus client!
      const toggleResult = await observerClient.invokeCommand("plugin.z-shell.nosleep.toggle", [
        "on",
      ]);
      expect((toggleResult.data as { cookieHeld: boolean }).cookieHeld).toBe(true);

      // Wait for live inhibitors topic update containing z-shell/nosleep lease.
      const waitForInhibitor = async (expectedCount: number) => {
        const until = Date.now() + 3000;
        while (Date.now() < until) {
          const last = latestInhibitors.at(-1);
          if (last && last.length === expectedCount) {
            return last;
          }
          await Bun.sleep(20);
        }
        return latestInhibitors.at(-1) ?? [];
      };

      const activeList = await waitForInhibitor(1);
      expect(activeList.length).toBe(1);
      const owner = activeList[0]?.owner;
      expect(owner?.kind).toBe("plugin");
      if (owner?.kind === "plugin") {
        expect(owner.plugin_id).toBe("z-shell/nosleep");
      }
      expect(activeList[0]?.scope).toBe("sleep");

      // Abruptly sever the plugin's UDS connection without calling cleanup -> z-shelld MUST
      // automatically revoke the inhibitor lease AND clean up plugin topic/commands!
      pluginTransport.close();
      const clearedList = await waitForInhibitor(0);
      expect(clearedList).toEqual([]);

      const topicsAfter = await observerClient.listTopics();
      expect(topicsAfter.some((entry) => entry.topic === "plugin.z-shell.nosleep.state")).toBe(
        false,
      );

      // Verify z-shell/theme-bridges parses live z-shelld `theme` TopicSnapshot ({ scheme, dark })!
      const shojiSent: ShojiWmThemeRequest[] = [];
      const zenFiles = new Map<string, string>();
      const themeBridges = createThemeBridgesPlugin({
        sendShojiWmTheme: (_sock, payload) => {
          shojiSent.push(payload);
        },
        readFile: (path) => zenFiles.get(path) ?? null,
        writeFileAtomic: (path, content) => {
          zenFiles.set(path, content);
        },
        removeFile: (path) => {
          zenFiles.delete(path);
        },
      });
      const themeCtx = createPluginContext(
        "z-shell/theme-bridges",
        observerClient,
        THEME_BRIDGES_DEFAULTS,
        {
          enable_shojiwm: true,
          shojiwm_socket: "/run/user/1000/shojiwm.sock",
          enable_zen_browser: true,
          zen_chrome_dir: "/tmp/zen-live/chrome",
        },
      );
      const cleanupThemeBridges = await themeBridges.setup(themeCtx);
      expect(shojiSent.length).toBeGreaterThanOrEqual(1);
      expect(shojiSent[0]?.method).toBe("theme.set");
      expect(Object.keys(shojiSent[0]?.params.roles ?? {}).length).toBeGreaterThan(10);
      expect(zenFiles.get("/tmp/zen-live/chrome/userChrome.css")).toContain("--zen-primary-color:");

      const reapply = await hostClient.invokeCommand("plugin.z-shell.theme-bridges.reapply");
      const bridgeStatus = reapply.data as ThemeBridgesStatus;
      expect(bridgeStatus.shojiwm.state).toBe("applied");
      expect(bridgeStatus.zenBrowser.state).toBe("applied");
      await cleanupThemeBridges?.();

      await sub.unsubscribe();
      await hostClient.invokeCommand("quit");
      await daemon.exited;
    } finally {
      pluginTransport?.close();
      observerClient?.close();
      hostClient?.close();
      daemon.kill();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
