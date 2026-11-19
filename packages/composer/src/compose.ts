import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import type { HostCapabilities } from "@z-shell/plugin-api";

import {
  assertCapabilityApproval,
  normalizeCapabilities,
  unionHostCapabilities,
  type PluginCapabilities,
} from "./capabilities.ts";
import { computeContentDigest } from "./digest.ts";
import {
  parsePluginManifest,
  redactSecretSettings,
  resolveSettings,
  type ParsedPluginEntry,
  type ParsedPluginManifest,
} from "./manifest.ts";
import { isRecord } from "./type-guards.ts";

export interface ComposeEntryInstance {
  readonly pluginId: string;
  readonly entryId: string;
  readonly instanceId: string;
  readonly outputId?: string;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export interface ComposePluginsOptions {
  readonly registryPath: string;
  readonly outDir: string;
  readonly candidateId: string;
  readonly entryInstances?: readonly ComposeEntryInstance[];
  /** Optional settings.toml; only its [plugin_settings] table is consumed. */
  readonly settingsPath?: string;
}

export interface ComposeReport {
  readonly candidateId: string;
  readonly status: "candidate_published";
  readonly nativeAcceptance: null;
  readonly pluginDigests: Readonly<Record<string, string>>;
  readonly capabilityUnion: HostCapabilities;
  readonly plugins: readonly Record<string, unknown>[];
  readonly entryInstances: readonly Record<string, unknown>[];
}

interface RegistryPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly pluginApi: number;
  readonly root: string;
  readonly contentDigest: string;
  readonly enabled: boolean;
  readonly revoked: boolean;
  readonly requestedCapabilities: PluginCapabilities;
  readonly approvedCapabilities: PluginCapabilities | null;
}

const REGISTRY_PLUGIN_KEYS: Record<string, true> = {
  id: true,
  name: true,
  version: true,
  plugin_api: true,
  source: true,
  content_digest: true,
  enabled: true,
  revoked: true,
  requested_capabilities: true,
  approved_capabilities: true,
  accepted_build_id: true,
};

function record(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be an object/table`);
  return value;
}

function knownKeys(value: Record<string, unknown>, allowed: Record<string, true>, context: string): void {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(allowed, key)) throw new Error(`unknown key ${JSON.stringify(key)} in ${context}`);
  }
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean`);
  return value;
}

function capabilities(value: unknown, context: string): PluginCapabilities {
  const input = record(value, context);
  knownKeys(input, { host: true, bus: true }, context);
  if (!Object.hasOwn(input, "host") || !Object.hasOwn(input, "bus")) {
    throw new Error(`${context} requires host and bus objects`);
  }
  record(input.host, `${context}.host`);
  record(input.bus, `${context}.bus`);
  return normalizeCapabilities(input as unknown as PluginCapabilities);
}

function registrySource(value: unknown, context: string): string {
  const source = record(value, context);
  const kind = string(source.kind, `${context}.kind`);
  if (kind === "path") {
    knownKeys(source, { kind: true, root: true }, context);
  } else if (kind === "git") {
    knownKeys(source, { kind: true, url: true, rev: true, ref_name: true, root: true }, context);
    string(source.url, `${context}.url`);
    const rev = string(source.rev, `${context}.rev`);
    if (!/^[0-9a-f]{40}$/.test(rev)) throw new Error(`${context}.rev must be a 40-hex commit SHA`);
    if (source.ref_name !== undefined) string(source.ref_name, `${context}.ref_name`);
  } else {
    throw new Error(`${context}.kind must be path or git`);
  }
  const root = string(source.root, `${context}.root`);
  if (!isAbsolute(root)) throw new Error(`${context}.root must be absolute`);
  return root;
}

function registryPlugin(value: unknown, key: string): RegistryPlugin {
  const context = `registry plugin ${key}`;
  const input = record(value, context);
  knownKeys(input, REGISTRY_PLUGIN_KEYS, context);
  const id = string(input.id, `${context}.id`);
  if (id !== key) throw new Error(`${context} id does not match its registry key`);
  const pluginApi = input.plugin_api;
  if (typeof pluginApi !== "number" || !Number.isInteger(pluginApi)) {
    throw new Error(`${context}.plugin_api must be an integer`);
  }
  const contentDigest = string(input.content_digest, `${context}.content_digest`);
  if (!/^sha256:[0-9a-f]{64}$/.test(contentDigest)) {
    throw new Error(`${context}.content_digest has invalid format`);
  }
  if (input.accepted_build_id !== null && input.accepted_build_id !== undefined) {
    string(input.accepted_build_id, `${context}.accepted_build_id`);
  }
  const approved = input.approved_capabilities;
  return {
    id,
    name: string(input.name, `${context}.name`),
    version: string(input.version, `${context}.version`),
    pluginApi,
    root: registrySource(input.source, `${context}.source`),
    contentDigest,
    enabled: boolean(input.enabled, `${context}.enabled`),
    revoked: boolean(input.revoked, `${context}.revoked`),
    requestedCapabilities: capabilities(input.requested_capabilities, `${context}.requested_capabilities`),
    approvedCapabilities: approved === null || approved === undefined
      ? null
      : capabilities(approved, `${context}.approved_capabilities`),
  };
}

function readRegistry(path: string): RegistryPlugin[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to read plugin registry ${path}`, { cause: error });
  }
  const input = record(parsed, "registry");
  knownKeys(input, { schema_version: true, plugins: true }, "registry");
  if (input.schema_version !== 1) throw new Error("registry.schema_version must be 1");
  const plugins = record(input.plugins, "registry.plugins");
  return Object.entries(plugins).map(([key, value]) => registryPlugin(value, key));
}

function readPluginSettings(path: string | undefined): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (!path) return result;
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to parse user plugin settings ${path}`, { cause: error });
  }
  const settings = record(parsed, "settings.toml").plugin_settings;
  if (settings === undefined) return result;
  for (const [pluginId, overrides] of Object.entries(record(settings, "plugin_settings"))) {
    result.set(pluginId, record(overrides, `plugin_settings.${pluginId}`));
  }
  return result;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function descriptor(entry: ParsedPluginEntry, settings: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    entryId: entry.entryId,
    kind: entry.kind,
    settings: redactSecretSettings(entry.settings, settings),
  };
  if (entry.title !== undefined) result.title = entry.title;
  if (entry.description !== undefined) result.description = entry.description;
  return result;
}

interface EnabledPlugin {
  readonly registry: RegistryPlugin;
  readonly manifest: ParsedPluginManifest;
  readonly publicSettings: Record<string, unknown>;
}

function generateModule(
  plugins: readonly EnabledPlugin[],
  instances: readonly (ComposeEntryInstance & { readonly publicSettings: Record<string, unknown> })[],
): string {
  const serviceDescriptors = plugins.flatMap(({ manifest, publicSettings }) =>
    manifest.entries.filter((entry) => entry.kind === "service").map((entry) => {
      const resolvedServiceSettings = redactSecretSettings(
        entry.settings,
        resolveSettings(entry.settings, {}, entry.entryId),
      );
      return {
        pluginId: manifest.id,
        ...descriptor(entry, resolvedServiceSettings),
        entryId: entry.entryId,
        pluginSettings: publicSettings,
        importKey: entry.entryId,
      };
    })
  );
  const usedEntryIds = new Set<string>([
    ...serviceDescriptors.map((entry) => entry.entryId),
    ...instances.map((instance) => instance.entryId),
  ]);
  const imports = [...usedEntryIds].sort(compareUtf8).map((entryId) => {
    for (const { manifest } of plugins) {
      const entry = manifest.entries.find((candidate) => candidate.entryId === entryId);
      if (entry) return { entryId, path: entry.absoluteEntry };
    }
    throw new Error(`internal entry import resolution failed for ${entryId}`);
  });
  const instanceDescriptors = instances.map((instance) => {
    const plugin = plugins.find((candidate) => candidate.manifest.id === instance.pluginId);
    if (!plugin) throw new Error(`internal plugin resolution failed for ${instance.pluginId}`);
    const entry = plugin.manifest.entries.find((candidate) => candidate.entryId === instance.entryId);
    if (!entry) throw new Error(`internal entry resolution failed for ${instance.entryId}`);
    const result: Record<string, unknown> = {
      pluginId: instance.pluginId,
      ...descriptor(entry, instance.publicSettings),
      pluginSettings: plugin.publicSettings,
      instanceId: instance.instanceId,
      importKey: instance.entryId,
    };
    if (instance.outputId !== undefined) result.outputId = instance.outputId;
    return result;
  });
  instanceDescriptors.sort((left, right) =>
    compareUtf8(
      `${left.pluginId as string}\0${left.entryId as string}\0${left.instanceId as string}`,
      `${right.pluginId as string}\0${right.entryId as string}\0${right.instanceId as string}`,
    )
  );
  serviceDescriptors.sort((left, right) => compareUtf8(left.entryId as string, right.entryId as string));

  const lines = [
    "// Generated by @z-shell/composer. Do not edit.",
    'import type { PluginEntryKind } from "@z-shell/plugin-api";',
    ...imports.map(({ path }, index) => `import * as pluginEntry${index} from ${JSON.stringify(path)};`),
    "",
    "export interface ComposedServiceDescriptor {",
    "  readonly pluginId: string;",
    "  readonly id: string;",
    "  readonly entryId: string;",
    '  readonly kind: Extract<PluginEntryKind, "service">;',
    "  readonly entry: string;",
    "  readonly title?: string;",
    "  readonly description?: string;",
    "  readonly settings: Readonly<Record<string, unknown>>;",
    "  readonly pluginSettings: Readonly<Record<string, unknown>>;",
    "  readonly importKey: string;",
    "}",
    "",
    "export interface ComposedEntryInstanceDescriptor {",
    "  readonly pluginId: string;",
    "  readonly id: string;",
    "  readonly entryId: string;",
    '  readonly kind: Exclude<PluginEntryKind, "service">;',
    "  readonly entry: string;",
    "  readonly title?: string;",
    "  readonly description?: string;",
    "  readonly settings: Readonly<Record<string, unknown>>;",
    "  readonly pluginSettings: Readonly<Record<string, unknown>>;",
    "  readonly instanceId: string;",
    "  readonly outputId?: string;",
    "  readonly importKey: string;",
    "}",
    "",
    "export const entryImports = {",
    ...imports.map(({ entryId }, index) => `  ${JSON.stringify(entryId)}: pluginEntry${index},`),
    "} as const;",
    "",
    `export const services: readonly ComposedServiceDescriptor[] = ${JSON.stringify(serviceDescriptors, null, 2)} as const;`,
    "",
    `export const entryInstances: readonly ComposedEntryInstanceDescriptor[] = ${JSON.stringify(instanceDescriptors, null, 2)} as const;`,
    "",
    "export const composedPlugins = { entryImports, services, entryInstances } as const;",
    "export default composedPlugins;",
    "",
  ];
  return lines.join("\n");
}

/** Statically validates enabled registry plugins and publishes candidate composition artifacts. */
export function composePlugins(options: ComposePluginsOptions): ComposeReport {
  if (options.candidateId.length === 0) throw new Error("candidateId must be non-empty");
  const registry = readRegistry(options.registryPath).sort((left, right) => compareUtf8(left.id, right.id));
  const userSettings = readPluginSettings(options.settingsPath);
  const enabled: EnabledPlugin[] = [];
  for (const plugin of registry) {
    if (!plugin.enabled) continue;
    assertCapabilityApproval(plugin.requestedCapabilities, plugin.approvedCapabilities, plugin.revoked);
    const manifest = parsePluginManifest(plugin.root);
    if (
      manifest.id !== plugin.id ||
      manifest.name !== plugin.name ||
      manifest.version !== plugin.version ||
      manifest.pluginApi !== plugin.pluginApi
    ) {
      throw new Error(`registry metadata drift for ${plugin.id}`);
    }
    const liveCapabilities = normalizeCapabilities({
      host: manifest.hostCapabilities,
      bus: manifest.busPermissions,
    });
    if (JSON.stringify(liveCapabilities) !== JSON.stringify(plugin.requestedCapabilities)) {
      throw new Error(`requested capability drift for ${plugin.id}`);
    }
    const liveDigest = computeContentDigest(plugin.root);
    if (liveDigest !== plugin.contentDigest) {
      throw new Error(`content_digest mismatch for ${plugin.id}: expected ${plugin.contentDigest}, got ${liveDigest}`);
    }
    const overrides = userSettings.get(plugin.id) ?? {};
    const settings = resolveSettings(manifest.settings, overrides, `plugin_settings.${plugin.id}`);
    enabled.push({
      registry: plugin,
      manifest,
      publicSettings: redactSecretSettings(manifest.settings, settings),
    });
  }

  const registeredIds = new Set(registry.map((plugin) => plugin.id));
  for (const pluginId of userSettings.keys()) {
    if (!registeredIds.has(pluginId)) {
      throw new Error(`plugin_settings.${pluginId} targets an unknown plugin`);
    }
  }

  const enabledById = new Map(enabled.map((plugin) => [plugin.manifest.id, plugin]));
  const seenInstances = new Set<string>();
  const resolvedInstances = (options.entryInstances ?? []).map((instance) => {
    const plugin = enabledById.get(instance.pluginId);
    if (!plugin) throw new Error(`entry instance targets disabled or unknown plugin ${instance.pluginId}`);
    const entry = plugin.manifest.entries.find((candidate) => candidate.entryId === instance.entryId);
    if (!entry) throw new Error(`entry instance references unknown entry ${instance.entryId}`);
    if (entry.kind === "service") throw new Error(`service entry ${instance.entryId} is already a singleton`);
    string(instance.instanceId, "entry instance instanceId");
    if (instance.outputId !== undefined) string(instance.outputId, "entry instance outputId");
    const scope = `${instance.pluginId}\0${instance.entryId}\0${instance.instanceId}`;
    if (seenInstances.has(scope)) throw new Error(`duplicate entry instance ${scope}`);
    seenInstances.add(scope);
    const settings = resolveSettings(
      entry.settings,
      instance.settings ?? {},
      `entry instance ${instance.instanceId}`,
    );
    return { ...instance, publicSettings: redactSecretSettings(entry.settings, settings) };
  });

  const pluginDigests = Object.fromEntries(enabled.map((plugin) => [
    plugin.manifest.id,
    plugin.registry.contentDigest,
  ]));
  const capabilityUnion = unionHostCapabilities(enabled.map((plugin) => plugin.registry.requestedCapabilities.host));
  const report: ComposeReport = {
    candidateId: options.candidateId,
    status: "candidate_published",
    nativeAcceptance: null,
    pluginDigests,
    capabilityUnion,
    plugins: enabled.map(({ manifest, publicSettings }) => ({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      settings: publicSettings,
      entries: manifest.entries.map((entry) => descriptor(entry, resolveSettings(entry.settings, {}, entry.entryId))),
    })),
    entryInstances: resolvedInstances.map((instance) => ({
      pluginId: instance.pluginId,
      entryId: instance.entryId,
      instanceId: instance.instanceId,
      ...(instance.outputId === undefined ? {} : { outputId: instance.outputId }),
      settings: instance.publicSettings,
    })),
  };

  // Stage all candidate files in a temp directory first, then atomically replace target files so
  // a failed compose never corrupts a previously published candidate.
  mkdirSync(options.outDir, { recursive: true });
  const stageDir = mkdtempSync(join(dirname(options.outDir), ".z-shell-compose-stage-"));
  try {
    const files: readonly (readonly [string, string])[] = [
      ["composed-plugins.ts", generateModule(enabled, resolvedInstances)],
      ["manifest-capabilities.json", `${JSON.stringify(capabilityUnion, null, 2)}\n`],
      ["compose-report.json", `${JSON.stringify(report, null, 2)}\n`],
    ];
    for (const [name, content] of files) {
      writeFileSync(join(stageDir, name), content);
    }
    for (const [name] of files) {
      renameSync(join(stageDir, name), join(options.outDir, name));
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
  return report;
}
