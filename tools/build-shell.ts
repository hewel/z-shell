import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
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

interface RegistryFile {
  readonly plugins?: Readonly<Record<string, {
    readonly id: string;
    readonly enabled?: boolean;
    readonly revoked?: boolean;
    readonly source?: { readonly root?: string };
  }>>;
}

function collectDefaultEntryInstances(registryPath: string): ComposeEntryInstance[] {
  const raw = JSON.parse(readFileSync(registryPath, "utf8")) as RegistryFile;
  const entries = Object.values(raw.plugins ?? {}).filter(
    plugin => plugin.enabled === true && plugin.revoked !== true && typeof plugin.source?.root === "string",
  );
  const instances: ComposeEntryInstance[] = [];
  for (const plugin of entries) {
    const manifest = parsePluginManifest(plugin.source!.root!);
    const slug = manifest.id.replace(/[^a-zA-Z0-9_-]+/g, "-");
    for (const entry of manifest.entries) {
      if (entry.kind === "service") continue;
      instances.push({
        pluginId: manifest.id,
        entryId: entry.entryId,
        instanceId: `${slug}-${entry.id}`,
      });
    }
  }
  return instances;
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
const enabledInstances = !standalone && existsSync(registryPath) ? collectDefaultEntryInstances(registryPath) : [];

if (enabledInstances.length === 0) {
  const published = await buildShellApplication({ app: "shell", appDirectory });
  const ms = Math.round(performance.now() - t0);
  console.log(`Built ${published.manifest.id} (standalone) -> ${published.dist} (${ms}ms)`);
} else {
  const stageRoot = mkdtempSync(join(repoRoot, "apps", ".shell-compose-stage-"));
  const composeOutDir = join(stageRoot, "composed");
  const stagedShellDir = join(stageRoot, "shell");
  try {
    const report = composePlugins({
      registryPath,
      ...(existsSync(settingsPath) ? { settingsPath } : {}),
      outDir: composeOutDir,
      candidateId: `local-${Date.now()}`,
      entryInstances: enabledInstances,
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
