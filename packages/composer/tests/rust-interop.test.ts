import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { composePlugins } from "../src/index.ts";

describe("Rust z-shell plugin CLI -> @z-shell/composer interop", () => {
  test("composes a plugin registered, audited, approved, and enabled by Rust z-shell plugin CLI", () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const tempDir = mkdtempSync(join(tmpdir(), "z-shell-plugin-interop-"));

    try {
      const build = Bun.spawnSync(["cargo", "build", "--bin", "z-shell"], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(build.exitCode).toBe(0);

      const meta = Bun.spawnSync(["cargo", "metadata", "--format-version", "1", "--no-deps"], {
        cwd: repoRoot,
        stdout: "pipe",
      });
      const targetDir = (JSON.parse(meta.stdout.toString()) as { target_directory: string })
        .target_directory;
      const cliBin = join(targetDir, "debug", "z-shell");

      const configDir = join(tempDir, "config");
      const stateDir = join(tempDir, "state");
      const pluginDir = join(tempDir, "ai-usage-plugin");
      mkdirSync(join(pluginDir, "src"), { recursive: true });

      writeFileSync(
        join(pluginDir, "plugin.toml"),
        [
          'id = "z-shell/ai-usage"',
          'name = "AI Usage"',
          'version = "1.0.0"',
          "plugin_api = 1",
          'author = "z-shell"',
          'license = "MIT"',
          "",
          "[host_capabilities]",
          'commands = ["ai-usagebar"]',
          'image_prefixes = ["/run/user/1000/z-shell/media"]',
          "shell_surfaces = false",
          "control_channel = false",
          "",
          "[bus_permissions]",
          'topics_read = ["settings"]',
          'topics_publish = ["plugin.z-shell.ai-usage.quotas"]',
          'commands_register = ["plugin.z-shell.ai-usage.refresh"]',
          "inhibitors = false",
          "",
          "[[setting]]",
          'key = "refresh_seconds"',
          'type = "integer"',
          "default = 300",
          "min = 30",
          "max = 3600",
          "",
          "[[service]]",
          'id = "collector"',
          'entry = "src/collector.ts"',
          'title = "Quota Collector"',
          "",
          "[[widget]]",
          'id = "bar-ring"',
          'entry = "src/bar-ring.tsx"',
          'title = "Quota Ring"',
          "",
          "  [[widget.setting]]",
          '  key = "compact"',
          '  type = "boolean"',
          "  default = true",
          "",
        ].join("\n"),
      );
      writeFileSync(join(pluginDir, "src", "collector.ts"), "export default function collector() {}\n");
      writeFileSync(join(pluginDir, "src", "bar-ring.tsx"), "export default function barRing() { return null; }\n");

      const runCli = (args: string[]) =>
        Bun.spawnSync(
          [cliBin, "--config-dir", configDir, "--state-dir", stateDir, "--json", ...args],
          { stdout: "pipe", stderr: "pipe" },
        );

      // 1. Add local path plugin via Rust CLI
      const addRes = runCli(["plugin", "add", "--path", pluginDir]);
      expect(addRes.exitCode, addRes.stderr.toString()).toBe(0);

      // 2. Enable before approve must fail loudly
      const prematureEnable = runCli(["plugin", "enable", "z-shell/ai-usage"]);
      expect(prematureEnable.exitCode).not.toBe(0);

      // 3. Audit, approve, then enable via Rust CLI
      const auditRes = runCli(["plugin", "audit", "z-shell/ai-usage"]);
      expect(auditRes.exitCode, auditRes.stderr.toString()).toBe(0);

      const approveRes = runCli(["plugin", "approve", "z-shell/ai-usage"]);
      expect(approveRes.exitCode, approveRes.stderr.toString()).toBe(0);

      const enableRes = runCli(["plugin", "enable", "z-shell/ai-usage"]);
      expect(enableRes.exitCode, enableRes.stderr.toString()).toBe(0);

      // 4. Bun @z-shell/composer reads the exact Rust-generated registry.json and verifies SHA-256 parity!
      const registryPath = join(stateDir, "plugins", "registry.json");
      const outDir = join(tempDir, "out");
      const report = composePlugins({
        registryPath,
        outDir,
        candidateId: "interop-cand-1",
        entryInstances: [
          {
            pluginId: "z-shell/ai-usage",
            entryId: "z-shell/ai-usage:bar-ring",
            instanceId: "dp1-ring",
            outputId: "DP-1",
            settings: { compact: true },
          },
          {
            pluginId: "z-shell/ai-usage",
            entryId: "z-shell/ai-usage:bar-ring",
            instanceId: "hdmi-ring",
            outputId: "HDMI-A-1",
            settings: { compact: false },
          },
        ],
      });

      expect(report.status).toBe("candidate_published");
      expect(report.nativeAcceptance).toBeNull();
      expect(report.capabilityUnion).toEqual({
        commands: ["ai-usagebar"],
        imagePrefixes: ["/run/user/1000/z-shell/media"],
      });

      const manifestCaps = JSON.parse(
        readFileSync(join(outDir, "manifest-capabilities.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(manifestCaps).toEqual({
        commands: ["ai-usagebar"],
        imagePrefixes: ["/run/user/1000/z-shell/media"],
      });
      expect("sessionLock" in manifestCaps).toBe(false);

      const composedSource = readFileSync(join(outDir, "composed-plugins.ts"), "utf8");
      expect(composedSource).toContain("dp1-ring");
      expect(composedSource).toContain("hdmi-ring");
      expect(composedSource).toContain("collector");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
