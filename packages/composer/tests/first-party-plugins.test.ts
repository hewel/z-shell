import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createPluginContext } from "@z-shell/plugin-api";
import { ZShellClient, type InhibitorEntry } from "@z-shell/sdk";
import { connectUnixSocket } from "@z-shell/sdk/bun";

import { buildShellPreviewFixture } from "../../../apps/shell/tests/fixture-builder.ts";
import { expectCleanPreview, nativeHost, runPreview } from "../../../apps/shell/tests/preview-harness.ts";
import { NOSLEEP_DEFAULTS, createNoSleepPlugin } from "../../../plugins/nosleep/src/service.ts";
import {
  THEME_BRIDGES_DEFAULTS,
  createThemeBridgesPlugin,
  type ShojiWmThemeRequest,
  type ThemeBridgesStatus,
} from "../../../plugins/theme-bridges/src/service.ts";
import { buildShellApplication, composePlugins } from "../src/index.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SHELL_DIR = join(REPO_ROOT, "apps", "shell");

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
        namedSockets: ["niri"],
        shellSurfaces: true,
        controlChannel: true,
        unixSockets: ["$XDG_RUNTIME_DIR/shojiwm-${WAYLAND_DISPLAY}.sock"],
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

  test("end-to-end: z-shell plugin -> @z-shell/composer -> @hewel/zgui-build -> native-host preview mounts all composed plugin UIs", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "z-shell-first-party-preview-"));
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

      const outDir = join(tempDir, "composed");
      const report = composePlugins({
        registryPath: join(stateDir, "plugins", "registry.json"),
        outDir,
        candidateId: "first-party-preview-candidate",
        entryInstances: [
          {
            pluginId: "z-shell/ai-usage",
            entryId: "z-shell/ai-usage:bar-quota",
            instanceId: "ai-quota-bar",
          },
          {
            pluginId: "z-shell/ai-usage",
            entryId: "z-shell/ai-usage:panel",
            instanceId: "ai-quota-panel",
          },
          {
            pluginId: "z-shell/nosleep",
            entryId: "z-shell/nosleep:bar-indicator",
            instanceId: "nosleep-bar",
          },
          {
            pluginId: "z-shell/nosleep",
            entryId: "z-shell/nosleep:panel",
            instanceId: "nosleep-panel",
          },
          {
            pluginId: "z-shell/niri-overview",
            entryId: "z-shell/niri-overview:overview",
            instanceId: "niri-overview-layer",
          },
          {
            pluginId: "z-shell/theme-bridges",
            entryId: "z-shell/theme-bridges:bridges",
            instanceId: "theme-bridges-settings",
          },
        ],
      });
      expect(report.status).toBe("candidate_published");

      const stagedShellDir = join(tempDir, "shell");
      mkdirSync(stagedShellDir);
      for (const entry of ["package.json", "tsconfig.json", "assets", "src", "preview"]) {
        cpSync(join(SHELL_DIR, entry), join(stagedShellDir, entry), { recursive: true });
      }
      symlinkSync(join(REPO_ROOT, "node_modules"), join(stagedShellDir, "node_modules"), "dir");
      const composedSource = readFileSync(join(outDir, "composed-plugins.ts"), "utf8");
      for (const plugin of plugins) {
        expect(composedSource).toContain(`${plugin.id}:service`);
      }
      expect(composedSource).toContain('"widthTier": "compact"');
      // This preview fixture mocks daemon-published plugin topics rather than live plugin services
      // (which spawn external commands/sockets; service startup/teardown is tested in
      // apps/shell/tests/plugin-services.test.ts and the live z-shelld test below).
      const uiOnlyComposed = composedSource.replace(
        /export const services: readonly ComposedServiceDescriptor\[\] = \[[\s\S]*?\] as const;/,
        "export const services: readonly ComposedServiceDescriptor[] = [] as const;",
      );
      expect(uiOnlyComposed).not.toBe(composedSource);
      writeFileSync(join(stagedShellDir, "src", "plugins", "composed.ts"), uiOnlyComposed);

      const published = await buildShellApplication({
        app: "shell",
        appDirectory: stagedShellDir,
        capabilitiesFile: join(outDir, "manifest-capabilities.json"),
      });
      expect(published.manifest.id).toBe("dev.zshell.shell");
      expect(published.manifest.capabilities).toMatchObject({
        commands: ["ai-usagebar"],
        namedSockets: ["niri"],
        shellSurfaces: true,
        sessionLock: true,
        controlChannel: true,
      });

      const aiUsageSnapshot = {
        quotas: [{
          provider: "Codex",
          label: "Five-hour window",
          usedPercent: 16,
          remainingPercent: 84,
          resetsAt: null,
          status: "ok",
        }],
        codexResets: null,
        updatedAt: 1_700_000_000_000,
        lastError: null,
        stale: false,
        offlineBlocked: false,
        backoffMs: 0,
      };
      const noSleepSnapshot = {
        active: true,
        manualActive: true,
        activeAgents: [],
        scope: "sleep",
        cookieHeld: true,
        lastCheckedAtMs: 1_700_000_000_000,
        lastError: null,
      };
      const niriClosedSnapshot = {
        capability: "available",
        resetting: false,
        open: false,
        outputs: [{ name: "DP-1", width: 1440, height: 900 }],
        layouts: [],
      };
      const niriOpenSnapshot = {
        ...niriClosedSnapshot,
        open: true,
        layouts: [{
          output: "DP-1",
          workspaceId: 1,
          index: 1,
          active: true,
          focused: true,
          x: 0.125,
          y: 0.125,
          width: 0.75,
          height: 0.75,
          windows: [{
            id: 11,
            title: "Terminal",
            appId: "org.example.Terminal",
            floating: false,
            focused: true,
            x: 0.25,
            y: 0.25,
            width: 0.375,
            height: 0.375,
          }],
        }],
      };

      const fixtureValue = buildShellPreviewFixture({ id: "z-shell-first-party-plugins" });
      const publicSocket = fixtureValue.services.sockets[0]!;
      const initialPluginTopics = [
        { id: 26, instanceId: 25, topic: "plugin.z-shell.niri-overview.state", data: niriClosedSnapshot },
        { id: 27, instanceId: 26, topic: "plugin.z-shell.ai-usage.quotas", data: aiUsageSnapshot },
        { id: 28, instanceId: 27, topic: "plugin.z-shell.nosleep.state", data: noSleepSnapshot },
      ] as const;
      for (const subscription of initialPluginTopics) {
        publicSocket.send.push(JSON.stringify({
          jsonrpc: "2.0",
          id: subscription.id,
          method: "topic.subscribe",
          params: { topic: subscription.topic },
        }));
        publicSocket.events.push({
          kind: "message",
          atMs: 4,
          text: JSON.stringify({
            jsonrpc: "2.0",
            id: subscription.id,
            result: {
              daemon_instance_id: "preview-daemon",
              topic_instance_id: subscription.instanceId,
              topic: subscription.topic,
              revision: 1,
              data: subscription.data,
            },
          }),
        });
      }
      publicSocket.send.push(JSON.stringify({
        jsonrpc: "2.0",
        id: 29,
        method: "topic.subscribe",
        params: { topic: "plugin.z-shell.ai-usage.quotas" },
      }));
      publicSocket.events.push({
        kind: "message",
        atMs: 35,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 29,
          result: {
            daemon_instance_id: "preview-daemon",
            topic_instance_id: 26,
            topic: "plugin.z-shell.ai-usage.quotas",
            revision: 1,
            data: aiUsageSnapshot,
          },
        }),
      });
      publicSocket.events.push({
        kind: "message",
        atMs: 50,
        text: JSON.stringify({
          jsonrpc: "2.0",
          method: "topic.update",
          params: {
            daemon_instance_id: "preview-daemon",
            topic_instance_id: 25,
            topic: "plugin.z-shell.niri-overview.state",
            revision: 2,
            source_baseline: false,
            data: niriOpenSnapshot,
          },
        }),
      });
      publicSocket.send.push(JSON.stringify({
        jsonrpc: "2.0",
        id: 30,
        method: "command.invoke",
        params: {
          name: "plugin.z-shell.niri-overview.toggle",
          args: [],
          payload: { open: false },
        },
      }));
      publicSocket.events.push({
        kind: "message",
        atMs: 65,
        text: JSON.stringify({ jsonrpc: "2.0", id: 30, result: {} }),
      });
      publicSocket.events.push({ kind: "close", atMs: 70, error: null });

      const fixture = join(tempDir, "fixture.json");
      const scenario = join(tempDir, "scenario.json");
      const previewOut = join(tempDir, "preview-out");
      writeFileSync(fixture, JSON.stringify(fixtureValue, null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-first-party-plugins",
        requiredCapabilities: ["surface.multiple", "virtual-time"],
        steps: [
          {
            id: "outputs",
            op: "monitors.set",
            monitors: [{
              id: "dp-1",
              name: "DP-1",
              x: 0,
              y: 0,
              width: 1440,
              height: 900,
              scale: 1,
              refreshRateMilliHz: 60000,
            }],
          },
          { id: "daemon-events", op: "clock.advance", byMs: 30 },
          { id: "ready", op: "settle" },
          {
            id: "ai-widget-mounted",
            op: "assert",
            target: { surface: "bar-dp-1", testId: "plugin-ai-usage-widget" },
            check: { property: "exists", equals: true },
          },
          {
            id: "ai-widget-quota",
            op: "assert",
            target: { surface: "bar-dp-1", testId: "plugin-ai-usage-widget" },
            check: { property: "text", equals: "84%" },
          },
          {
            id: "nosleep-widget-mounted",
            op: "assert",
            target: { surface: "bar-dp-1", testId: "plugin-nosleep-widget" },
            check: { property: "exists", equals: true },
          },
          {
            id: "nosleep-widget-active",
            op: "assert",
            target: { surface: "bar-dp-1", testId: "plugin-nosleep-widget" },
            check: { property: "name", equals: "NoSleep: Awake" },
          },
          {
            id: "open-ai-panel",
            op: "pointer.click",
            target: { surface: "bar-dp-1", testId: "plugin-ai-usage-widget" },
            button: "primary",
          },
          { id: "present-ai-panel", op: "clock.advance", byMs: 10 },
          {
            id: "ai-panel-mounted",
            op: "assert",
            target: { surface: "plugin-panel-ai-quota-panel", testId: "plugin-ai-usage-panel" },
            check: { property: "exists", equals: true },
          },
          { id: "dismiss-ai-panel", op: "popupDone", surface: "plugin-panel-ai-quota-panel" },
          { id: "niri-update", op: "clock.advance", byMs: 20 },
          {
            id: "niri-workspace-mounted",
            op: "assert",
            target: { surface: "niri-overview-dp-1", testId: "niri-ws-1" },
            check: { property: "exists", equals: true },
          },
          {
            id: "niri-window-mounted",
            op: "assert",
            target: { surface: "niri-overview-dp-1", testId: "niri-win-11" },
            check: { property: "exists", equals: true },
          },
          { id: "escape-overview", op: "key.press", surface: "niri-overview-dp-1", key: "Escape" },
          { id: "toggle-reply", op: "clock.advance", byMs: 5 },
          { id: "daemon-disconnect", op: "clock.advance", byMs: 5 },
          { id: "finished", op: "settle" },
        ],
      }, null, 2));

      expect(existsSync(nativeHost)).toBe(true);
      const result = runPreview(published.dist, fixture, scenario, previewOut);
      expectCleanPreview(result, 0, 7);
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
