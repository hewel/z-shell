import type { BusPermissions, HostCapabilities } from "@z-shell/plugin-api";

import { HOST_COMMAND_PATTERN, HOST_NAMED_SOCKET_PATTERN, HOST_PATH_PATTERN } from "./manifest.ts";
import { isRecord } from "./type-guards.ts";

export interface PluginCapabilities {
  readonly host: HostCapabilities;
  readonly bus: BusPermissions;
}

export interface CapabilityDiff {
  readonly added: PluginCapabilities;
  readonly removed: PluginCapabilities;
  readonly requiresApproval: boolean;
}

const HOST_KEYS: Record<string, true> = {
  commands: true,
  imagePrefixes: true,
  unixSockets: true,
  namedSockets: true,
  shellSurfaces: true,
  controlChannel: true,
};
const BUS_KEYS: Record<string, true> = {
  topicsRead: true,
  topicsPublish: true,
  commandsRegister: true,
  inhibitors: true,
};

function assertKnownKeys(value: Record<string, unknown>, allowed: Record<string, true>, context: string): void {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(allowed, key)) {
      if (key === "sessionLock" || key === "session_lock") {
        throw new Error("sessionLock is never grantable through plugin composition");
      }
      throw new Error(`unknown capability key ${JSON.stringify(key)} in ${context}`);
    }
  }
}

function normalizedStrings(
  value: unknown,
  context: string,
  pattern?: RegExp,
  requiredPrefix?: string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  const unique = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`${context}[${index}] must be a non-empty string`);
    }
    if (pattern && !pattern.test(item)) throw new Error(`${context}[${index}] is not schema-compliant`);
    if (requiredPrefix && !item.startsWith(requiredPrefix)) {
      throw new Error(`${context}[${index}] must start with ${requiredPrefix}`);
    }
    unique.add(item);
  }
  return [...unique].sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
}

function booleanValue(value: unknown, context: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean`);
  return value;
}

export function normalizeHostCapabilities(value?: HostCapabilities | null): HostCapabilities {
  const input = value ?? {};
  if (!isRecord(input)) throw new Error("host capabilities must be an object");
  assertKnownKeys(input, HOST_KEYS, "host");
  const commands = normalizedStrings(input.commands, "host.commands", HOST_COMMAND_PATTERN);
  const imagePrefixes = normalizedStrings(input.imagePrefixes, "host.imagePrefixes", HOST_PATH_PATTERN);
  const unixSockets = normalizedStrings(input.unixSockets, "host.unixSockets", HOST_PATH_PATTERN);
  const namedSockets = normalizedStrings(input.namedSockets, "host.namedSockets", HOST_NAMED_SOCKET_PATTERN);
  const shellSurfaces = booleanValue(input.shellSurfaces, "host.shellSurfaces");
  const controlChannel = booleanValue(input.controlChannel, "host.controlChannel");
  const result: {
    commands?: string[];
    imagePrefixes?: string[];
    unixSockets?: string[];
    namedSockets?: string[];
    shellSurfaces?: boolean;
    controlChannel?: boolean;
  } = {};
  if (commands.length > 0) result.commands = commands;
  if (imagePrefixes.length > 0) result.imagePrefixes = imagePrefixes;
  if (unixSockets.length > 0) result.unixSockets = unixSockets;
  if (namedSockets.length > 0) result.namedSockets = namedSockets;
  if (shellSurfaces) result.shellSurfaces = true;
  if (controlChannel) result.controlChannel = true;
  return result;
}

export function normalizeBusPermissions(value?: BusPermissions | null): BusPermissions {
  const input = value ?? {};
  if (!isRecord(input)) throw new Error("bus permissions must be an object");
  assertKnownKeys(input, BUS_KEYS, "bus");
  const topicsRead = normalizedStrings(input.topicsRead, "bus.topicsRead");
  const topicsPublish = normalizedStrings(input.topicsPublish, "bus.topicsPublish", undefined, "plugin.");
  const commandsRegister = normalizedStrings(
    input.commandsRegister,
    "bus.commandsRegister",
    undefined,
    "plugin.",
  );
  const inhibitors = booleanValue(input.inhibitors, "bus.inhibitors");
  const result: {
    topicsRead?: string[];
    topicsPublish?: string[];
    commandsRegister?: string[];
    inhibitors?: boolean;
  } = {};
  if (topicsRead.length > 0) result.topicsRead = topicsRead;
  if (topicsPublish.length > 0) result.topicsPublish = topicsPublish;
  if (commandsRegister.length > 0) result.commandsRegister = commandsRegister;
  if (inhibitors) result.inhibitors = true;
  return result;
}

export function normalizeCapabilities(value: PluginCapabilities): PluginCapabilities {
  if (!isRecord(value)) throw new Error("capabilities must be an object");
  assertKnownKeys(value, { host: true, bus: true }, "capabilities");
  return {
    host: normalizeHostCapabilities(value.host as HostCapabilities),
    bus: normalizeBusPermissions(value.bus as BusPermissions),
  };
}

export function unionHostCapabilities(capabilities: readonly HostCapabilities[]): HostCapabilities {
  const normalized = capabilities.map((capability) => normalizeHostCapabilities(capability));
  return normalizeHostCapabilities({
    commands: normalized.flatMap((capability) => capability.commands ?? []),
    imagePrefixes: normalized.flatMap((capability) => capability.imagePrefixes ?? []),
    unixSockets: normalized.flatMap((capability) => capability.unixSockets ?? []),
    namedSockets: normalized.flatMap((capability) => capability.namedSockets ?? []),
    shellSurfaces: normalized.some((capability) => capability.shellSurfaces === true),
    controlChannel: normalized.some((capability) => capability.controlChannel === true),
  });
}

function listDifference(left: readonly string[] | undefined, right: readonly string[] | undefined): string[] {
  const rightValues = new Set(right ?? []);
  return (left ?? []).filter((value) => !rightValues.has(value));
}

function diffHost(approved: HostCapabilities, requested: HostCapabilities): HostCapabilities {
  const result: {
    commands?: string[];
    imagePrefixes?: string[];
    unixSockets?: string[];
    namedSockets?: string[];
    shellSurfaces?: boolean;
    controlChannel?: boolean;
  } = {};
  const commands = listDifference(approved.commands, requested.commands);
  const imagePrefixes = listDifference(approved.imagePrefixes, requested.imagePrefixes);
  const unixSockets = listDifference(approved.unixSockets, requested.unixSockets);
  const namedSockets = listDifference(approved.namedSockets, requested.namedSockets);
  if (commands.length > 0) result.commands = commands;
  if (imagePrefixes.length > 0) result.imagePrefixes = imagePrefixes;
  if (unixSockets.length > 0) result.unixSockets = unixSockets;
  if (namedSockets.length > 0) result.namedSockets = namedSockets;
  if (approved.shellSurfaces === true && requested.shellSurfaces !== true) result.shellSurfaces = true;
  if (approved.controlChannel === true && requested.controlChannel !== true) result.controlChannel = true;
  return result;
}

function diffBus(approved: BusPermissions, requested: BusPermissions): BusPermissions {
  const result: {
    topicsRead?: string[];
    topicsPublish?: string[];
    commandsRegister?: string[];
    inhibitors?: boolean;
  } = {};
  const topicsRead = listDifference(approved.topicsRead, requested.topicsRead);
  const topicsPublish = listDifference(approved.topicsPublish, requested.topicsPublish);
  const commandsRegister = listDifference(approved.commandsRegister, requested.commandsRegister);
  if (topicsRead.length > 0) result.topicsRead = topicsRead;
  if (topicsPublish.length > 0) result.topicsPublish = topicsPublish;
  if (commandsRegister.length > 0) result.commandsRegister = commandsRegister;
  if (approved.inhibitors === true && requested.inhibitors !== true) result.inhibitors = true;
  return result;
}

function hasCapabilities(value: PluginCapabilities): boolean {
  return [
    value.host.commands,
    value.host.imagePrefixes,
    value.host.unixSockets,
    value.host.namedSockets,
    value.bus.topicsRead,
    value.bus.topicsPublish,
    value.bus.commandsRegister,
  ].some((items) => (items?.length ?? 0) > 0) ||
    value.host.shellSurfaces === true ||
    value.host.controlChannel === true ||
    value.bus.inhibitors === true;
}

export function diffCapabilities(
  approved: PluginCapabilities | null | undefined,
  requested: PluginCapabilities,
): CapabilityDiff {
  const oldValue = approved ? normalizeCapabilities(approved) : { host: {}, bus: {} };
  const newValue = normalizeCapabilities(requested);
  const added = {
    host: diffHost(newValue.host, oldValue.host),
    bus: diffBus(newValue.bus, oldValue.bus),
  };
  const removed = {
    host: diffHost(oldValue.host, newValue.host),
    bus: diffBus(oldValue.bus, newValue.bus),
  };
  return { added, removed, requiresApproval: hasCapabilities(added) };
}

export function assertCapabilityApproval(
  requested: PluginCapabilities,
  approved: PluginCapabilities | null | undefined,
  revoked = false,
): void {
  if (revoked) throw new Error("revoked plugin cannot be composed");
  if (!approved) throw new Error("requested capabilities have no approval snapshot");
  const diff = diffCapabilities(approved, requested);
  if (diff.requiresApproval) {
    throw new Error(`unapproved capability expansion: ${JSON.stringify(diff.added)}`);
  }
}
