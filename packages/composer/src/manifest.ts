import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  PLUGIN_API_LEVEL,
  formatPluginEntryId,
  isValidPluginId,
  type BusPermissions,
  type HostCapabilities,
  type PluginEntryKind,
} from "@z-shell/plugin-api";

import { isRecord } from "./type-guards.ts";

const ENTRY_KINDS = [
  "widget",
  "shortcut",
  "panel",
  "service",
  "launcher_provider",
  "settings_page",
  "layer",
] as const satisfies readonly PluginEntryKind[];

const TOP_LEVEL_KEYS: Record<string, true> = {
  id: true,
  name: true,
  version: true,
  plugin_api: true,
  author: true,
  license: true,
  description: true,
  dependencies: true,
  host_capabilities: true,
  bus_permissions: true,
  setting: true,
  ...Object.fromEntries(ENTRY_KINDS.map((kind) => [kind, true])),
} as Record<string, true>;
const HOST_CAPABILITY_KEYS: Record<string, true> = {
  commands: true,
  image_prefixes: true,
  unix_sockets: true,
  named_sockets: true,
  shell_surfaces: true,
  control_channel: true,
};
const BUS_PERMISSION_KEYS: Record<string, true> = {
  topics_read: true,
  topics_publish: true,
  commands_register: true,
  inhibitors: true,
};
const ENTRY_KEYS: Record<string, true> = {
  id: true,
  entry: true,
  title: true,
  description: true,
  width_tier: true,
  setting: true,
};
const SETTING_KEYS: Record<string, true> = {
  key: true,
  type: true,
  default: true,
  min: true,
  max: true,
  secret: true,
};

// Exact item patterns from zgui-js/schemas/package.schema.json $defs/hostPaths & $defs/socketName.
export const HOST_LITERAL_PATH_PATTERN =
  /^\/(?:$|(?:(?!\.{1,2}(?:\/|$))[^/\\\u0000-\u001f\u007f-\u009f]+\/)*(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f-\u009f]+$)/;
export const HOST_TEMPLATE_PATH_PATTERN =
  /^\$(?:XDG_RUNTIME_DIR|HOME|XDG_DATA_HOME)(?:\/(?!\.{1,2}(?:\/|$))(?:\$WAYLAND_DISPLAY(?=\/|$)|(?:[^$/\\\u0000-\u001f\u007f-\u009f]|\$\{WAYLAND_DISPLAY\})+))*$/;
export const HOST_PATH_PATTERN = new RegExp(
  `^(?:${HOST_LITERAL_PATH_PATTERN.source.slice(1)}|${HOST_TEMPLATE_PATH_PATTERN.source.slice(1, -1)})$`,
);
export const HOST_NAMED_SOCKET_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
// Exact command item pattern from zgui-js/schemas/package.schema.json capabilities.commands.
export const HOST_COMMAND_PATTERN = /^(?=.*[^ ])[^\u0000-\u001f\u007f-\u009f]+$/;

export type PluginSettingType = "string" | "integer" | "number" | "boolean";
export type PluginSettingValue = string | number | boolean;

export interface PluginSettingSchema {
  readonly key: string;
  readonly type: PluginSettingType;
  readonly default?: PluginSettingValue;
  readonly min?: number;
  readonly max?: number;
  readonly secret: boolean;
}

export type PanelWidthTier = "compact" | "standard";

export interface ParsedPluginEntry {
  readonly id: string;
  readonly entryId: string;
  readonly kind: PluginEntryKind;
  readonly entry: string;
  readonly absoluteEntry: string;
  readonly title?: string;
  readonly description?: string;
  readonly widthTier?: PanelWidthTier;
  readonly settings: readonly PluginSettingSchema[];
}

export interface ParsedPluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly pluginApi: number;
  readonly author?: string;
  readonly license: string;
  readonly description?: string;
  readonly dependencies: readonly string[];
  readonly hostCapabilities: HostCapabilities;
  readonly busPermissions: BusPermissions;
  readonly settings: readonly PluginSettingSchema[];
  readonly entries: readonly ParsedPluginEntry[];
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be a table`);
  return value;
}

function assertKnownKeys(record: Record<string, unknown>, allowed: Record<string, true>, context: string): void {
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(allowed, key)) throw new Error(`unknown key ${JSON.stringify(key)} in ${context}`);
  }
}

function requireString(value: unknown, context: string, nonEmpty = false): string {
  if (typeof value !== "string" || (nonEmpty && value.trim().length === 0)) {
    throw new Error(`${context} must be ${nonEmpty ? "a non-empty" : "a"} string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, context: string): string | undefined {
  return record[key] === undefined ? undefined : requireString(record[key], `${context}.${key}`);
}

function optionalBoolean(record: Record<string, unknown>, key: string, context: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${context}.${key} must be a boolean`);
  return value;
}

function stringArray(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${context} must be an array of strings`);
  return value.map((item, index) => requireString(item, `${context}[${index}]`, true));
}

function parseHostCapabilities(value: unknown): HostCapabilities {
  const record = requireRecord(value ?? {}, "host_capabilities");
  assertKnownKeys(record, HOST_CAPABILITY_KEYS, "host_capabilities");

  const commands = stringArray(record.commands, "host_capabilities.commands");
  for (const command of commands) {
    if (!HOST_COMMAND_PATTERN.test(command)) {
      throw new Error(`invalid host command ${JSON.stringify(command)}`);
    }
  }
  const imagePrefixes = stringArray(record.image_prefixes, "host_capabilities.image_prefixes");
  const unixSockets = stringArray(record.unix_sockets, "host_capabilities.unix_sockets");
  const namedSockets = stringArray(record.named_sockets, "host_capabilities.named_sockets");
  for (const [context, paths] of [
    ["host_capabilities.image_prefixes", imagePrefixes],
    ["host_capabilities.unix_sockets", unixSockets],
  ] as const) {
    for (const path of paths) {
      if (!HOST_PATH_PATTERN.test(path)) {
        throw new Error(`${context} contains non-canonical host path ${JSON.stringify(path)}`);
      }
    }
  }
  for (const name of namedSockets) {
    if (!HOST_NAMED_SOCKET_PATTERN.test(name)) {
      throw new Error(`host_capabilities.named_sockets contains invalid socket name ${JSON.stringify(name)}`);
    }
  }

  const result: {
    commands?: string[];
    imagePrefixes?: string[];
    unixSockets?: string[];
    namedSockets?: string[];
    shellSurfaces?: boolean;
    controlChannel?: boolean;
  } = {};
  if (record.commands !== undefined) result.commands = commands;
  if (record.image_prefixes !== undefined) result.imagePrefixes = imagePrefixes;
  if (record.unix_sockets !== undefined) result.unixSockets = unixSockets;
  if (record.named_sockets !== undefined) result.namedSockets = namedSockets;
  const shellSurfaces = optionalBoolean(record, "shell_surfaces", "host_capabilities");
  const controlChannel = optionalBoolean(record, "control_channel", "host_capabilities");
  if (shellSurfaces !== undefined) result.shellSurfaces = shellSurfaces;
  if (controlChannel !== undefined) result.controlChannel = controlChannel;
  return result;
}

function parseBusPermissions(value: unknown): BusPermissions {
  const record = requireRecord(value ?? {}, "bus_permissions");
  assertKnownKeys(record, BUS_PERMISSION_KEYS, "bus_permissions");
  const topicsRead = stringArray(record.topics_read, "bus_permissions.topics_read");
  const topicsPublish = stringArray(record.topics_publish, "bus_permissions.topics_publish");
  const commandsRegister = stringArray(record.commands_register, "bus_permissions.commands_register");
  for (const [context, names] of [
    ["bus_permissions.topics_publish", topicsPublish],
    ["bus_permissions.commands_register", commandsRegister],
  ] as const) {
    for (const name of names) {
      if (!name.startsWith("plugin.")) {
        throw new Error(`${context} entry ${JSON.stringify(name)} must start with plugin.`);
      }
    }
  }

  const result: {
    topicsRead?: string[];
    topicsPublish?: string[];
    commandsRegister?: string[];
    inhibitors?: boolean;
  } = {};
  if (record.topics_read !== undefined) result.topicsRead = topicsRead;
  if (record.topics_publish !== undefined) result.topicsPublish = topicsPublish;
  if (record.commands_register !== undefined) result.commandsRegister = commandsRegister;
  const inhibitors = optionalBoolean(record, "inhibitors", "bus_permissions");
  if (inhibitors !== undefined) result.inhibitors = inhibitors;
  return result;
}

function validateSettingValue(value: unknown, type: PluginSettingType, context: string): PluginSettingValue {
  if (type === "string" && typeof value === "string") return value;
  if (type === "boolean" && typeof value === "boolean") return value;
  if (type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (type === "number" && typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${context} does not match declared setting type ${type}`);
}

function parseSettings(value: unknown, context: string): PluginSettingSchema[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${context} must be an array of tables`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const itemContext = `${context}[${index}]`;
    const record = requireRecord(item, itemContext);
    assertKnownKeys(record, SETTING_KEYS, itemContext);
    const key = requireString(record.key, `${itemContext}.key`, true);
    if (seen.has(key)) throw new Error(`duplicate setting key ${JSON.stringify(key)} in ${context}`);
    seen.add(key);
    const type = requireString(record.type, `${itemContext}.type`);
    if (type !== "string" && type !== "integer" && type !== "number" && type !== "boolean") {
      throw new Error(`${itemContext}.type has unsupported value ${JSON.stringify(type)}`);
    }
    const secret = optionalBoolean(record, "secret", itemContext) ?? false;
    const result: {
      key: string;
      type: PluginSettingType;
      default?: PluginSettingValue;
      min?: number;
      max?: number;
      secret: boolean;
    } = { key, type, secret };

    if (!Object.hasOwn(record, "default")) {
      throw new Error(`${itemContext}.default is required`);
    }
    result.default = validateSettingValue(record.default, type, `${itemContext}.default`);
    for (const bound of ["min", "max"] as const) {
      const boundValue = record[bound];
      if (boundValue === undefined) continue;
      if (type !== "integer" && type !== "number") {
        throw new Error(`${itemContext}.${bound} is only valid for numeric settings`);
      }
      result[bound] = validateSettingValue(boundValue, type, `${itemContext}.${bound}`) as number;
    }
    if (result.min !== undefined && result.max !== undefined && result.min > result.max) {
      throw new Error(`${itemContext}.min must not exceed max`);
    }
    if (typeof result.default === "number") {
      if (result.min !== undefined && result.default < result.min) {
        throw new Error(`${itemContext}.default is below min`);
      }
      if (result.max !== undefined && result.default > result.max) {
        throw new Error(`${itemContext}.default exceeds max`);
      }
    }
    return result;
  });
}

function validateEntryPath(_pluginRoot: string, canonicalRoot: string, entry: string): string {
  if (entry.length === 0 || isAbsolute(entry) || entry.includes("\0")) {
    throw new Error(`entry path must be relative and non-empty: ${JSON.stringify(entry)}`);
  }
  if (entry.split(/[\\/]/).includes("..")) {
    throw new Error(`entry path must not contain '..': ${JSON.stringify(entry)}`);
  }
  const candidate = resolve(canonicalRoot, entry);
  const pathRelation = relative(canonicalRoot, candidate);
  if (pathRelation.length === 0 || pathRelation === ".." || pathRelation.startsWith(`..${sep}`)) {
    throw new Error(`entry path must remain strictly inside plugin root: ${entry}`);
  }
  let canonicalEntry: string;
  try {
    canonicalEntry = realpathSync(candidate);
    if (!statSync(canonicalEntry).isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new Error(`entry path is not an existing regular file: ${entry}`, { cause: error });
  }
  const canonicalRelation = relative(canonicalRoot, canonicalEntry);
  if (
    canonicalRelation.length === 0 ||
    canonicalRelation === ".." ||
    canonicalRelation.startsWith(`..${sep}`) ||
    isAbsolute(canonicalRelation)
  ) {
    throw new Error(`entry path escapes plugin root through a symlink: ${entry}`);
  }
  return canonicalEntry;
}

function parseEntries(
  document: Record<string, unknown>,
  pluginId: string,
  pluginRoot: string,
  canonicalRoot: string,
): ParsedPluginEntry[] {
  const entries: ParsedPluginEntry[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(document)) {
    if (!(ENTRY_KINDS as readonly string[]).includes(key)) continue;
    const kind = key as PluginEntryKind;
    if (!Array.isArray(value)) throw new Error(`${kind} must be an array of tables`);
    for (const [index, item] of value.entries()) {
      const context = `${kind}[${index}]`;
      const record = requireRecord(item, context);
      assertKnownKeys(record, ENTRY_KEYS, context);
      const id = requireString(record.id, `${context}.id`, true);
      const entryId = formatPluginEntryId(pluginId, id);
      if (new TextEncoder().encode(entryId).length > 128) {
        throw new Error(`entry id exceeds 128 UTF-8 bytes: ${entryId}`);
      }
      if (seen.has(entryId)) throw new Error(`duplicate plugin entry id ${entryId}`);
      seen.add(entryId);
      const entry = requireString(record.entry, `${context}.entry`, true);
      const result: {
        id: string;
        entryId: string;
        kind: PluginEntryKind;
        entry: string;
        absoluteEntry: string;
        title?: string;
        description?: string;
        widthTier?: PanelWidthTier;
        settings: PluginSettingSchema[];
      } = {
        id,
        entryId,
        kind,
        entry,
        absoluteEntry: validateEntryPath(pluginRoot, canonicalRoot, entry),
        settings: parseSettings(record.setting, `${context}.setting`),
      };
      const title = optionalString(record, "title", context);
      const description = optionalString(record, "description", context);
      const widthTier = optionalString(record, "width_tier", context);
      if (widthTier !== undefined) {
        if (kind !== "panel") {
          throw new Error(`${context}.width_tier is only valid on [[panel]] entries`);
        }
        if (widthTier !== "compact" && widthTier !== "standard") {
          throw new Error(`${context}.width_tier must be "compact" or "standard", got ${JSON.stringify(widthTier)}`);
        }
        result.widthTier = widthTier;
      }
      if (title !== undefined) result.title = title;
      if (description !== undefined) result.description = description;
      entries.push(result);
    }
  }
  return entries;
}

/** Parses and validates plugin.toml without importing or executing plugin source files. */
export function parsePluginManifest(pluginRoot: string): ParsedPluginManifest {
  const canonicalRoot = realpathSync(pluginRoot);
  const manifestPath = validateEntryPath(pluginRoot, canonicalRoot, "plugin.toml");
  let document: unknown;
  try {
    document = Bun.TOML.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`failed to parse static plugin manifest ${manifestPath}`, { cause: error });
  }
  const record = requireRecord(document, "plugin.toml");
  assertKnownKeys(record, TOP_LEVEL_KEYS, "plugin.toml");
  const id = requireString(record.id, "id", true);
  if (!isValidPluginId(id) || new TextEncoder().encode(id).length > 128) {
    throw new Error(`invalid canonical plugin id ${JSON.stringify(id)}`);
  }
  const name = requireString(record.name, "name", true);
  const version = requireString(record.version, "version", true);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`version must be strict MAJOR.MINOR.PATCH semver: ${JSON.stringify(version)}`);
  }
  const pluginApi = record.plugin_api;
  if (
    typeof pluginApi !== "number" ||
    !Number.isInteger(pluginApi) ||
    pluginApi < 1 ||
    pluginApi > PLUGIN_API_LEVEL
  ) {
    throw new Error(`plugin_api must be a positive integer <= ${PLUGIN_API_LEVEL}`);
  }
  const result: {
    id: string;
    name: string;
    version: string;
    pluginApi: number;
    author?: string;
    license: string;
    description?: string;
    dependencies: string[];
    hostCapabilities: HostCapabilities;
    busPermissions: BusPermissions;
    settings: PluginSettingSchema[];
    entries: ParsedPluginEntry[];
  } = {
    id,
    name,
    version,
    pluginApi,
    license: optionalString(record, "license", "plugin.toml") ?? "MIT",
    dependencies: stringArray(record.dependencies, "dependencies"),
    hostCapabilities: parseHostCapabilities(record.host_capabilities),
    busPermissions: parseBusPermissions(record.bus_permissions),
    settings: parseSettings(record.setting, "setting"),
    entries: parseEntries(record, id, pluginRoot, canonicalRoot),
  };
  const author = optionalString(record, "author", "plugin.toml");
  const description = optionalString(record, "description", "plugin.toml");
  if (author !== undefined) result.author = author;
  if (description !== undefined) result.description = description;
  return result;
}

/** Validates overrides and resolves declared defaults without dropping secret values internally. */
export function resolveSettings(
  schemas: readonly PluginSettingSchema[],
  overrides: Readonly<Record<string, unknown>>,
  context: string,
): Record<string, PluginSettingValue> {
  const byKey = new Map(schemas.map((schema) => [schema.key, schema]));
  for (const key of Object.keys(overrides)) {
    if (!byKey.has(key)) throw new Error(`undeclared setting override ${JSON.stringify(key)} in ${context}`);
  }
  const resolved: Record<string, PluginSettingValue> = {};
  for (const schema of schemas) {
    const value = Object.hasOwn(overrides, schema.key) ? overrides[schema.key] : schema.default;
    if (value === undefined) continue;
    const validated = validateSettingValue(value, schema.type, `${context}.${schema.key}`);
    if (typeof validated === "number") {
      if (schema.min !== undefined && validated < schema.min) {
        throw new Error(`${context}.${schema.key} is below min ${schema.min}`);
      }
      if (schema.max !== undefined && validated > schema.max) {
        throw new Error(`${context}.${schema.key} exceeds max ${schema.max}`);
      }
    }
    resolved[schema.key] = validated;
  }
  return resolved;
}

/** Removes secret values before descriptors or reports cross a public boundary. */
export function redactSecretSettings(
  schemas: readonly PluginSettingSchema[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const secrets = new Set(schemas.filter((schema) => schema.secret).map((schema) => schema.key));
  return Object.fromEntries(Object.entries(values).filter(([key]) => !secrets.has(key)));
}
