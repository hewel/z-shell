import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { syncCssModuleTypes } from "@hewel/zgui-build";
import {
  buildShellApplication,
  composePlugins,
  parsePluginManifest,
  type ComposeEntryInstance,
} from "@z-shell/composer";

const repoRoot = resolve(import.meta.dir, "..");
const appDirectory = resolve(repoRoot, "apps/shell");
const standalone = process.argv.includes("--standalone");

function resolveXdgPath(envVar: string, fallbackSubdir: string, ...parts: string[]): string {
  const base = process.env[envVar]?.trim();
  return join(base && base.length > 0 ? base : join(homedir(), fallbackSubdir), ...parts);
}

interface RegistryPluginEntry {
  readonly id: string;
  readonly enabled?: boolean;
  readonly revoked?: boolean;
  readonly source?: {
    readonly kind?: string;
    readonly root?: string;
    readonly bundle_path?: string;
  };
}

interface RegistryFile {
  readonly plugins?: Readonly<Record<string, RegistryPluginEntry>>;
  [key: string]: unknown;
}

function pluginSourceDir(plugin: RegistryPluginEntry): string | undefined {
  if (plugin.source?.kind === "path" && typeof plugin.source.root === "string") {
    return plugin.source.root;
  }
  if (typeof plugin.source?.bundle_path === "string") {
    return plugin.source.bundle_path;
  }
  if (typeof plugin.source?.root === "string") {
    return plugin.source.root;
  }
  return undefined;
}

interface ExplicitBarPluginSlot {
  readonly entry: string;
  readonly instance: string;
  readonly output?: string;
  readonly settings?: Readonly<Record<string, unknown>>;
}

function readExplicitBarPluginSlots(settingsPath: string | undefined): ExplicitBarPluginSlot[] {
  if (!settingsPath || !existsSync(settingsPath)) return [];
  try {
    const parsed = Bun.TOML.parse(readFileSync(settingsPath, "utf8")) as {
      bar?: { plugins?: Record<string, unknown> };
    };
    const zones = parsed.bar?.plugins;
    if (!zones || typeof zones !== "object") return [];
    const collected: ExplicitBarPluginSlot[] = [];
    for (const zone of ["left", "center", "right", "hidden"]) {
      const items = zones[zone];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const slot = item as Record<string, unknown>;
        if (typeof slot.entry !== "string" || typeof slot.instance !== "string") continue;
        collected.push({
          entry: slot.entry,
          instance: slot.instance,
          ...(typeof slot.output === "string" ? { output: slot.output } : {}),
          ...(slot.settings && typeof slot.settings === "object"
            ? { settings: slot.settings as Readonly<Record<string, unknown>> }
            : {}),
        });
      }
    }
    return collected;
  } catch {
    return [];
  }
}

function inspectEnabledPlugins(registryPath: string, settingsPath?: string): {
  instances: ComposeEntryInstance[];
  missingIds: Set<string>;
  hasAnyEnabled: boolean;
} {
  const raw = JSON.parse(readFileSync(registryPath, "utf8")) as RegistryFile;
  const entries = Object.values(raw.plugins ?? {}).filter(
    plugin => plugin.enabled === true && plugin.revoked !== true,
  );
  const explicitSlots = readExplicitBarPluginSlots(settingsPath);
  const instances: ComposeEntryInstance[] = [];
  const missingIds = new Set<string>();
  let hasAnyEnabled = false;
  for (const plugin of entries) {
    const root = pluginSourceDir(plugin);
    if (!root || !existsSync(root) || !existsSync(join(root, "plugin.toml"))) {
      missingIds.add(plugin.id);
      console.warn(
        `[z-shell build] Skipping enabled plugin "${plugin.id}": bundle root is missing at ${root ?? "<unspecified>"}. Run \`z-shell plugin remove ${plugin.id}\` to clean up your registry.`,
      );
      continue;
    }
    hasAnyEnabled = true;
    const manifest = parsePluginManifest(root);
    const slug = manifest.id.replace(/[^a-zA-Z0-9_-]+/g, "-");
    for (const entry of manifest.entries) {
      if (entry.kind === "service") continue;
      const matchingSlots = entry.kind === "widget"
        ? explicitSlots.filter(slot => slot.entry === entry.entryId)
        : [];
      const hasDefaultSlot = matchingSlots.some(slot => slot.instance === "default");
      if (!hasDefaultSlot) {
        instances.push({
          pluginId: manifest.id,
          entryId: entry.entryId,
          instanceId: `${slug}-${entry.id}`,
          ...(entry.kind === "widget" ? { instanceSlug: "default" } : {}),
        });
      }
      const seenInstanceIds = new Set<string>();
      for (const slot of matchingSlots) {
        const outputSuffix = slot.output ? `-${slot.output.replace(/[^a-zA-Z0-9_-]+/g, "-")}` : "";
        const instanceId = slot.instance === "default" && !slot.output
          ? `${slug}-${entry.id}`
          : `${slug}-${entry.id}-${slot.instance}${outputSuffix}`;
        if (seenInstanceIds.has(instanceId)) continue;
        seenInstanceIds.add(instanceId);
        instances.push({
          pluginId: manifest.id,
          entryId: entry.entryId,
          instanceId,
          instanceSlug: slot.instance,
          ...(slot.output !== undefined ? { outputId: slot.output } : {}),
          ...(slot.settings !== undefined ? { settings: slot.settings } : {}),
        });
      }
    }
  }
  return { instances, missingIds, hasAnyEnabled };
}

function writeFilteredRegistry(
  registryPath: string,
  missingIds: ReadonlySet<string>,
  destPath: string,
): string {
  if (missingIds.size === 0) return registryPath;
  const raw = JSON.parse(readFileSync(registryPath, "utf8")) as RegistryFile;
  const plugins = { ...(raw.plugins ?? {}) };
  for (const id of missingIds) {
    const entry = plugins[id];
    if (entry) {
      plugins[id] = { ...entry, enabled: false };
    }
  }
  writeFileSync(destPath, JSON.stringify({ ...raw, plugins }, null, 2));
  return destPath;
}

function publishComposedDist(targetAppDir: string, sourceDist: string): string {
  const targetDist = join(targetAppDir, "dist");
  if (resolve(sourceDist) === resolve(targetDist)) return targetDist;
  const generationsDir = join(targetAppDir, ".zgui-generations");
  mkdirSync(generationsDir, { recursive: true });
  const token = randomUUID();
  const stagingDir = join(generationsDir, `.building-${token}`);
  const generationDir = join(generationsDir, token);
  const linkPath = join(targetAppDir, `.dist-${token}`);
  let published = false;
  try {
    cpSync(sourceDist, stagingDir, { recursive: true, dereference: true });
    renameSync(stagingDir, generationDir);
    symlinkSync(relative(targetAppDir, generationDir), linkPath, "dir");
    try {
      if (!lstatSync(targetDist).isSymbolicLink()) {
        rmSync(targetDist, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(linkPath, targetDist);
    published = true;
    return targetDist;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(linkPath, { force: true });
    if (!published) rmSync(generationDir, { recursive: true, force: true });
  }
}

const t0 = performance.now();
const registryPath = resolveXdgPath("XDG_STATE_HOME", ".local/state", "z-shell", "plugins", "registry.json");
const settingsPath = resolveXdgPath("XDG_CONFIG_HOME", ".config", "z-shell", "settings.toml");
const inspected = !standalone && existsSync(registryPath)
  ? inspectEnabledPlugins(registryPath, settingsPath)
  : { instances: [], missingIds: new Set<string>(), hasAnyEnabled: false };

if (!inspected.hasAnyEnabled) {
  const published = await buildShellApplication({ app: "shell", appDirectory });
  const ms = Math.round(performance.now() - t0);
  console.log(`Built ${published.manifest.id} (standalone) -> ${published.dist} (${ms}ms)`);
} else {
  const stageRoot = mkdtempSync(join(repoRoot, "apps", ".shell-compose-stage-"));
  const composeOutDir = join(stageRoot, "composed");
  const stagedShellDir = join(stageRoot, "shell");
  try {
    const effectiveRegistryPath = writeFilteredRegistry(
      registryPath,
      inspected.missingIds,
      join(stageRoot, "registry.filtered.json"),
    );
    const report = composePlugins({
      registryPath: effectiveRegistryPath,
      ...(existsSync(settingsPath) ? { settingsPath } : {}),
      outDir: composeOutDir,
      candidateId: `local-${Date.now()}`,
      entryInstances: inspected.instances,
    });

    await syncCssModuleTypes({
      project: join(appDirectory, "tsconfig.json"),
      include: [join(repoRoot, "plugins/*/src")],
    });

    mkdirSync(stagedShellDir, { recursive: true });
    for (const entry of ["package.json", "tsconfig.json", "assets", "src", "preview"]) {
      const source = join(appDirectory, entry);
      if (existsSync(source)) {
        cpSync(source, join(stagedShellDir, entry), { recursive: true });
      }
    }
    const appNodeModules = join(appDirectory, "node_modules");
    if (existsSync(appNodeModules)) {
      symlinkSync(appNodeModules, join(stagedShellDir, "node_modules"), "dir");
    }

    const composedSource = readFileSync(join(composeOutDir, "composed-plugins.ts"), "utf8");
    writeFileSync(join(stagedShellDir, "src", "plugins", "composed.ts"), composedSource);

    const published = await buildShellApplication({
      app: "shell",
      appDirectory: stagedShellDir,
      capabilitiesFile: join(composeOutDir, "manifest-capabilities.json"),
      cssModuleInclude: [join(repoRoot, "packages/sdk/src"), join(repoRoot, "plugins/*/src")],
    });

    const targetDist = publishComposedDist(appDirectory, published.dist);

    const ms = Math.round(performance.now() - t0);
    const pluginIds = Object.keys(report.pluginDigests).sort();
    console.log(
      `Built ${published.manifest.id} (${pluginIds.length} plugins: ${pluginIds.join(", ")}) -> ${targetDist} (${ms}ms)`,
    );
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}
