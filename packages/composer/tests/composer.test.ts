import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildShellApplication } from "../src/build.ts";
import {
  assertCapabilityApproval,
  diffCapabilities,
  normalizeCapabilities,
  normalizeHostCapabilities,
  unionHostCapabilities,
} from "../src/capabilities.ts";
import { composePlugins } from "../src/compose.ts";
import { computeContentDigest } from "../src/digest.ts";
import { parsePluginManifest, redactSecretSettings } from "../src/manifest.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "z-shell-composer-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writePlugin(root: string, manifest: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "plugin.toml"), manifest);
  writeFileSync(join(root, "src", "worker.ts"), "export default function worker() {}\n");
  writeFileSync(join(root, "src", "indicator.tsx"), "export default function Indicator() {}\n");
}

function writeApprovedRegistry(
  registryPath: string,
  root: string,
  options: {
    enabled?: boolean;
    revoked?: boolean;
    expandRequested?: boolean;
    approved?: boolean;
    digest?: string;
  } = {},
): void {
  const manifest = parsePluginManifest(root);
  const approved = normalizeCapabilities({
    host: manifest.hostCapabilities,
    bus: manifest.busPermissions,
  });
  const requested = options.expandRequested
    ? normalizeCapabilities({
        host: { ...approved.host, commands: [...(approved.host.commands ?? []), "unapproved-command"] },
        bus: approved.bus,
      })
    : approved;
  mkdirSync(join(registryPath, ".."), { recursive: true });
  writeFileSync(registryPath, JSON.stringify({
    schema_version: 1,
    plugins: {
      [manifest.id]: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        plugin_api: manifest.pluginApi,
        source: { kind: "path", root },
        content_digest: options.digest ?? computeContentDigest(root),
        enabled: options.enabled ?? true,
        revoked: options.revoked ?? false,
        requested_capabilities: requested,
        approved_capabilities: options.approved === false ? null : approved,
        accepted_build_id: null,
      },
    },
  }));
}

const validManifest = `
id = "z-shell/example"
name = "Example Plugin"
version = "1.2.3"
plugin_api = 1

[host_capabilities]
commands = ["notify-send"]
image_prefixes = ["/tmp/plugin-images"]

[bus_permissions]
topics_read = ["settings"]
topics_publish = ["plugin.z-shell.example.state"]
commands_register = ["plugin.z-shell.example.ping"]

[[setting]]
key = "refresh_seconds"
type = "integer"
default = 300
min = 30
max = 3600

[[setting]]
key = "token"
type = "string"
default = "do-not-export"
secret = true

[[service]]
id = "worker"
entry = "src/worker.ts"
title = "Background Worker"

[[widget]]
id = "indicator"
entry = "src/indicator.tsx"

  [[widget.setting]]
  key = "compact"
  type = "boolean"
  default = true
`;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("capabilities", () => {
  test("normalizes, sorts, deduplicates, and unions only non-default authority", () => {
    expect(normalizeHostCapabilities({
      commands: ["zsh", "notify-send", "zsh"],
      imagePrefixes: ["/tmp/images", "/tmp/images"],
      unixSockets: [],
      shellSurfaces: false,
      controlChannel: true,
    })).toEqual({
      commands: ["notify-send", "zsh"],
      imagePrefixes: ["/tmp/images"],
      controlChannel: true,
    });
    expect(unionHostCapabilities([
      { commands: ["zsh"], shellSurfaces: true },
      { commands: ["notify-send"], imagePrefixes: ["/"] },
    ])).toEqual({
      commands: ["notify-send", "zsh"],
      imagePrefixes: ["/"],
      shellSurfaces: true,
    });
    expect(JSON.stringify(unionHostCapabilities([{}]))).not.toContain("sessionLock");
  });

  test("accepts schema-compliant named sockets and rejects invalid names", () => {
    expect(normalizeHostCapabilities({
      namedSockets: ["niri", "hyprland_ipc-1", "niri"],
    })).toEqual({ namedSockets: ["hyprland_ipc-1", "niri"] });

    for (const name of ["1bad", "bad name", `a${"1".repeat(64)}`]) {
      expect(() => normalizeHostCapabilities({ namedSockets: [name] }))
        .toThrow(/host\.namedSockets.*schema-compliant/);
    }
  });

  test("accepts only constrained runtime path templates for image prefixes and Unix sockets", () => {
    const validPaths = [
      "$XDG_RUNTIME_DIR/z-shell/media",
      "$XDG_RUNTIME_DIR/z-shell/bus-${WAYLAND_DISPLAY}.sock",
      "$HOME/.cache/$WAYLAND_DISPLAY",
      "$XDG_DATA_HOME/icons",
      "$XDG_RUNTIME_DIR",
    ];
    const invalidPaths = [
      "$OTHER/foo",
      "$XDG_RUNTIME_DIR/../escape",
      "$XDG_RUNTIME_DIR/foo$BAR",
      "$XDG_RUNTIME_DIR/",
    ];

    for (const property of ["imagePrefixes", "unixSockets"] as const) {
      expect(normalizeHostCapabilities({ [property]: validPaths })).toEqual({
        [property]: [...validPaths].sort(),
      });
      for (const path of invalidPaths) {
        expect(() => normalizeHostCapabilities({ [property]: [path] }))
          .toThrow(new RegExp(`host\\.${property}.*schema-compliant`));
      }
    }
  });

  test("merges, deduplicates, and sorts named sockets across plugins", () => {
    expect(unionHostCapabilities([
      { namedSockets: ["niri", "shared_socket"] },
      { namedSockets: ["hyprland_ipc-1", "shared_socket"] },
    ])).toEqual({
      namedSockets: ["hyprland_ipc-1", "niri", "shared_socket"],
    });
  });

  test("reports named socket additions and removals in capability approval diffs", () => {
    const approved = {
      host: { namedSockets: ["niri", "old_socket"] },
      bus: {},
    };
    const requested = {
      host: { namedSockets: ["niri", "hyprland_ipc-1"] },
      bus: {},
    };
    const diff = diffCapabilities(approved, requested);

    expect(diff.added.host.namedSockets).toEqual(["hyprland_ipc-1"]);
    expect(diff.removed.host.namedSockets).toEqual(["old_socket"]);
    expect(diff.requiresApproval).toBe(true);
    expect(() => assertCapabilityApproval(requested, approved)).toThrow(/unapproved capability expansion/);
    expect(() => assertCapabilityApproval(
      { host: { namedSockets: ["niri"] }, bus: {} },
      approved,
    )).not.toThrow();
  });

  test("requires approval for host or bus expansion but not removal", () => {
    const approved = {
      host: { commands: ["notify-send"] },
      bus: { topicsRead: ["settings"] },
    };
    const requested = {
      host: { commands: ["notify-send", "zsh"] },
      bus: { topicsRead: [], commandsRegister: ["plugin.z-shell.example.ping"] },
    };
    const diff = diffCapabilities(approved, requested);
    expect(diff.added).toEqual({
      host: { commands: ["zsh"] },
      bus: { commandsRegister: ["plugin.z-shell.example.ping"] },
    });
    expect(diff.removed).toEqual({ host: {}, bus: { topicsRead: ["settings"] } });
    expect(diff.requiresApproval).toBe(true);
    expect(() => assertCapabilityApproval(requested, approved)).toThrow(/approval|unapproved/i);
    expect(() => assertCapabilityApproval(requested, requested)).not.toThrow();
    expect(diffCapabilities(approved, { host: {}, bus: {} }).requiresApproval).toBe(false);
  });

  test("always rejects revoked plugins even with empty requested capabilities", () => {
    expect(() => assertCapabilityApproval(
      { host: {}, bus: {} },
      { host: {}, bus: {} },
      true,
    )).toThrow(/revoked/i);
  });
});

describe("buildShellApplication", () => {
  test("rejects session lock capabilities before invoking the build", async () => {
    for (const key of ["sessionLock", "session_lock"] as const) {
      const extraCapabilities = { namedSockets: ["niri"], [key]: true };
      await expect(buildShellApplication({
        appDirectory: "/unused",
        extraCapabilities,
      })).rejects.toThrow("sessionLock is never grantable through plugin composition");
    }
  });
});

describe("computeContentDigest", () => {
  test("matches the contract's byte-stream digest and ignores .git", () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, "nested"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "alpha\n");
    writeFileSync(join(root, "nested", "b.bin"), Buffer.from([0, 1, 255]));
    writeFileSync(join(root, ".git", "ignored"), "not hashed");

    expect(computeContentDigest(root)).toBe(
      "sha256:cd5749f5a5d58859370dd22510e17987d9ce90810b1f3367ffadb2359891c2b5",
    );
    writeFileSync(join(root, ".git", "ignored"), "changed");
    expect(computeContentDigest(root)).toBe(
      "sha256:cd5749f5a5d58859370dd22510e17987d9ce90810b1f3367ffadb2359891c2b5",
    );
  });

  test("rejects a non-entry symlink escaping during the digest walk", () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    writeFileSync(join(outside, "secret"), "outside");
    symlinkSync(join(outside, "secret"), join(root, "escape"));

    expect(() => computeContentDigest(root)).toThrow(/outside|escapes|symlink/i);
  });
});

describe("parsePluginManifest", () => {
  test("parses the seven-entry manifest schema and redacts secret defaults", () => {
    const root = temporaryDirectory();
    writePlugin(root, validManifest);

    const manifest = parsePluginManifest(root);

    expect(manifest.id).toBe("z-shell/example");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.entries.map((entry) => entry.entryId)).toEqual([
      "z-shell/example:worker",
      "z-shell/example:indicator",
    ]);
    expect(manifest.settings[0]?.min).toBe(30);
    expect(redactSecretSettings(manifest.settings, {
      refresh_seconds: 60,
      token: "private-value",
    })).toEqual({ refresh_seconds: 60 });
  });

  test("rejects session_lock and sessionLock host capabilities", () => {
    for (const key of ["session_lock", "sessionLock"]) {
      const root = temporaryDirectory();
      writePlugin(root, validManifest.replace("[host_capabilities]", `[host_capabilities]\n${key} = true`));
      expect(() => parsePluginManifest(root)).toThrow(/unknown.*host_capabilities|session_?[Ll]ock/i);
    }
  });

  test("rejects an entry symlink escaping the canonical plugin root", () => {
    const root = temporaryDirectory();
    const outside = temporaryDirectory();
    writePlugin(root, validManifest);
    writeFileSync(join(outside, "escape.ts"), "export default 1;\n");
    rmSync(join(root, "src", "worker.ts"));
    symlinkSync(join(outside, "escape.ts"), join(root, "src", "worker.ts"));

    expect(() => parsePluginManifest(root)).toThrow(/outside|escapes|strictly inside/i);
    expect(realpathSync(root)).toBe(root);
  });
});

describe("composePlugins", () => {
  test("composes one singleton service and two output widget instances", async () => {
    const root = temporaryDirectory();
    const state = temporaryDirectory();
    const outDir = join(temporaryDirectory(), "out");
    const registryPath = join(state, "registry.json");
    const settingsPath = join(state, "settings.toml");
    writePlugin(root, validManifest);
    writeApprovedRegistry(registryPath, root);
    writeFileSync(settingsPath, `
[plugin_settings."z-shell/example"]
refresh_seconds = 60
token = "instance-secret"
`);

    const report = composePlugins({
      registryPath,
      outDir,
      candidateId: "candidate-smoke",
      settingsPath,
      entryInstances: [
        {
          pluginId: "z-shell/example",
          entryId: "z-shell/example:indicator",
          instanceId: "bar-dp-1",
          outputId: "DP-1",
          settings: { compact: false },
        },
        {
          pluginId: "z-shell/example",
          entryId: "z-shell/example:indicator",
          instanceId: "bar-hdmi-a-1",
          outputId: "HDMI-A-1",
          settings: { compact: true },
        },
      ],
    });

    const source = readFileSync(join(outDir, "composed-plugins.ts"), "utf8");
    expect(source).toContain("z-shell/example:worker");
    expect(source).toContain("DP-1");
    expect(source).toContain("HDMI-A-1");
    expect(source).not.toContain("instance-secret");
    expect(source).not.toContain("do-not-export");
    expect(JSON.parse(readFileSync(join(outDir, "manifest-capabilities.json"), "utf8"))).toEqual({
      commands: ["notify-send"],
      imagePrefixes: ["/tmp/plugin-images"],
    });
    expect(JSON.parse(readFileSync(join(outDir, "compose-report.json"), "utf8"))).toMatchObject({
      candidateId: "candidate-smoke",
      status: "candidate_published",
      nativeAcceptance: null,
      pluginDigests: { "z-shell/example": computeContentDigest(root) },
      capabilityUnion: {
        commands: ["notify-send"],
        imagePrefixes: ["/tmp/plugin-images"],
      },
    });
    expect(readFileSync(join(outDir, "compose-report.json"), "utf8")).not.toContain("instance-secret");

    // Runtime-selected generated artifact: this test intentionally exercises the module-loading boundary.
    const generated = await import(join(outDir, "composed-plugins.ts"));
    expect(generated.default.services).toHaveLength(1);
    expect(generated.default.entryInstances.map((instance: { outputId: string }) => instance.outputId)).toEqual([
      "DP-1",
      "HDMI-A-1",
    ]);
    expect(generated.default.entryInstances[0].settings).toEqual({ compact: false });
    expect(generated.default.entryInstances[1].settings).toEqual({ compact: true });
    expect(generated.default.services[0].pluginSettings).toEqual({ refresh_seconds: 60 });
    expect(generated.default.services[0].settings).toEqual({});
    expect(report.status).toBe("candidate_published");
  });

  test("rejects symlinked plugin.toml escaping root and allows settings for disabled plugins", () => {
    const outside = temporaryDirectory();
    const root = temporaryDirectory();
    writeFileSync(join(outside, "escaped.toml"), validManifest);
    symlinkSync(join(outside, "escaped.toml"), join(root, "plugin.toml"));
    expect(() => parsePluginManifest(root)).toThrow(/escapes|symlink/i);

    const disabledRoot = temporaryDirectory();
    const state = temporaryDirectory();
    const registryPath = join(state, "registry.json");
    const settingsPath = join(state, "settings.toml");
    writePlugin(disabledRoot, validManifest);
    writeApprovedRegistry(registryPath, disabledRoot, { enabled: false });
    writeFileSync(settingsPath, `[plugin_settings."z-shell/example"]\nrefresh_seconds = 90\n`);
    const report = composePlugins({
      registryPath,
      outDir: join(state, "out"),
      candidateId: "candidate-disabled-settings",
      settingsPath,
    });
    expect(report.plugins).toHaveLength(0);
  });

  test("fails closed on unapproved expansion, revocation, and digest drift", () => {
    for (const mode of ["expanded", "revoked", "tampered"] as const) {
      const root = temporaryDirectory();
      const state = temporaryDirectory();
      const registryPath = join(state, "registry.json");
      writePlugin(root, validManifest);
      writeApprovedRegistry(registryPath, root, {
        expandRequested: mode === "expanded",
        revoked: mode === "revoked",
      });
      if (mode === "tampered") writeFileSync(join(root, "src", "worker.ts"), "tampered\n");

      expect(() => composePlugins({
        registryPath,
        outDir: join(state, "out"),
        candidateId: `candidate-${mode}`,
      })).toThrow(/unapproved|revoked|digest/i);
    }
  });

  test("rejects undeclared shared and per-instance setting overrides", () => {
    for (const instanceOverride of [false, true]) {
      const root = temporaryDirectory();
      const state = temporaryDirectory();
      const registryPath = join(state, "registry.json");
      const settingsPath = join(state, "settings.toml");
      writePlugin(root, validManifest);
      writeApprovedRegistry(registryPath, root);
      writeFileSync(settingsPath, instanceOverride ? "" : `
[plugin_settings."z-shell/example"]
undeclared = true
`);

      expect(() => composePlugins({
        registryPath,
        outDir: join(state, "out"),
        candidateId: "candidate-settings",
        settingsPath,
        entryInstances: [{
          pluginId: "z-shell/example",
          entryId: "z-shell/example:indicator",
          instanceId: "bar",
          settings: instanceOverride ? { undeclared: true } : {},
        }],
      })).toThrow(/undeclared|unknown.*setting/i);
    }
  });

  test("emits paths and commands accepted by the exact zgui-js schema regexes", () => {
    const root = temporaryDirectory();
    const state = temporaryDirectory();
    const registryPath = join(state, "registry.json");
    const outDir = join(state, "out");
    writePlugin(root, validManifest.replace(
      'image_prefixes = ["/tmp/plugin-images"]',
      'image_prefixes = ["/", "/tmp/plugin-images"]\nunix_sockets = ["/run/user/1000/plugin.sock"]',
    ));
    writeApprovedRegistry(registryPath, root);
    composePlugins({ registryPath, outDir, candidateId: "candidate-schema" });

    const schema = JSON.parse(readFileSync(
      join(import.meta.dir, "../../../../zgui-js/schemas/package.schema.json"),
      "utf8",
    ));
    const capabilities = JSON.parse(readFileSync(join(outDir, "manifest-capabilities.json"), "utf8"));
    const hostPath = new RegExp(schema.$defs.hostPaths.items.pattern);
    const command = new RegExp(schema.properties.capabilities.properties.commands.items.pattern);
    expect(capabilities.imagePrefixes.every((path: string) => hostPath.test(path))).toBe(true);
    expect(capabilities.unixSockets.every((path: string) => hostPath.test(path))).toBe(true);
    expect(capabilities.commands.every((name: string) => command.test(name))).toBe(true);
    expect(Object.hasOwn(capabilities, "sessionLock")).toBe(false);
  });
});
