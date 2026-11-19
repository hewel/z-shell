/**
 * Plugin manifest, capability, and scoped lifecycle contract for z-shell TSX plugins.
 * Strict ES2022 with zero Node/Bun/browser globals so plugins run inside zgui-js QuickJS.
 */

import {
  MAX_IDENTIFIER_LEN,
  MAX_SEGMENT_LEN,
  type CommandHandler,
  type CommandInvokeResult,
  type InhibitorScope,
  type SubscribeOptions,
  type TopicListener,
  type TopicSnapshot,
  type ZShellClient,
} from "@z-shell/sdk";

/** Current cumulative plugin API compatibility level (independent of package semver and bus protocol). */
export const PLUGIN_API_LEVEL = 1 as const;

export type PluginEntryKind =
  | "widget"
  | "shortcut"
  | "panel"
  | "service"
  | "launcher_provider"
  | "settings_page"
  | "layer";

export interface PluginEntryDescriptor {
  /** Entry slug unique within this plugin (`author/plugin:entry`). */
  readonly name: string;
  readonly kind: PluginEntryKind;
  readonly title: string;
  readonly description?: string;
}

/**
 * Host capabilities aligned with `zgui-js/packages/build/src/build.ts` manifest schema.
 *
 * Ordinary plugins may NEVER declare `sessionLock`; the plugin composer resolves, minimizes,
 * and audits concrete paths before sealing the composed package into `zgui-js`'s `manifest.json`.
 */
export interface HostCapabilities {
  /** Allowlisted executable names or canonical paths (`zgui-js` field: `commands`). */
  readonly commands?: readonly string[];
  /** Read-only canonical absolute media directory prefixes (`zgui-js` field: `imagePrefixes`). */
  readonly imagePrefixes?: readonly string[];
  /** Canonical Unix domain socket paths (`zgui-js` field: `unixSockets`). */
  readonly unixSockets?: readonly string[];
  /** Requests additional `zwlr_layer_shell_v1` shell surfaces (`zgui-js` field: `shellSurfaces`). */
  readonly shellSurfaces?: boolean;
  /** Requests inbound control channel access (`zgui-js` field: `controlChannel`). */
  readonly controlChannel?: boolean;
}

/** Separate daemon-bus permission declarations audited by the plugin composer. */
export interface BusPermissions {
  readonly topicsRead?: readonly string[];
  readonly topicsPublish?: readonly string[];
  readonly commandsRegister?: readonly string[];
  readonly inhibitors?: boolean;
}

/**
 * Typed descriptor derived from `plugin.toml` (the single source of truth).
 */
export interface PluginManifest<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  /** Canonical plugin ID in `author/plugin` format. */
  readonly id: string;
  /** Package semantic version (`MAJOR.MINOR.PATCH`). */
  readonly version: string;
  /** Cumulative minimum `plugin_api` level required. */
  readonly pluginApi: number;
  readonly title: string;
  readonly description?: string;
  readonly entries: readonly PluginEntryDescriptor[];
  readonly defaults: TConfig;
  readonly hostCapabilities?: HostCapabilities;
  readonly busPermissions?: BusPermissions;
}

/** Per-mounted entry instance metadata (`PluginId → EntryId → InstanceId`). */
export interface EntryInstanceScope {
  readonly entryId: string;
  readonly instanceId: string;
  readonly outputId?: string;
}

/**
 * Scoped plugin runtime handle: intentionally omits raw `ZShellClient` so plugins interact only
 * through namespace-prefixed, revocable operations.
 */
export interface PluginContext<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  readonly pluginId: string;
  readonly config: Readonly<TConfig>;
  readonly instance?: EntryInstanceScope;
  subscribe<T = unknown>(
    topic: string,
    listenerOrOptions: TopicListener<T> | SubscribeOptions<T>,
  ): Promise<{ readonly snapshot: TopicSnapshot<T>; readonly unsubscribe: () => Promise<void> }>;
  registerTopic(
    subtopic: string,
    initial: unknown,
  ): Promise<{ readonly topic_instance_id: number; readonly revision: number }>;
  publishTopic(subtopic: string, data: unknown): Promise<{ readonly revision: number }>;
  unregisterTopic(subtopic: string): Promise<void>;
  registerCommand(
    subcommand: string,
    description: string,
    handler: CommandHandler,
  ): Promise<() => Promise<void>>;
  invokeCommand(
    name: string,
    args?: readonly string[],
    payload?: unknown,
  ): Promise<CommandInvokeResult>;
  acquireInhibitor(scope: InhibitorScope, reason: string): Promise<{ readonly cookie: number }>;
  releaseInhibitor(cookie: number): Promise<void>;
}

export type PluginCleanup = () => void | Promise<void>;

export interface PluginDefinition<
  TConfig extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly manifest: PluginManifest<TConfig>;
  setup(ctx: PluginContext<TConfig>): PluginCleanup | void | Promise<PluginCleanup | void>;
}

const SLUG_RE = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/;

export function isValidSlug(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SEGMENT_LEN && SLUG_RE.test(value);
}

/** Validates dot-separated topic/command identifiers identically to `z-shell-protocol`. */
export function isValidTopicName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LEN) {
    return false;
  }
  return value.split(".").every(isValidSlug);
}

export const isValidCommandName = isValidTopicName;

/** Validates canonical `author/plugin` identifiers identically to `z-shell-protocol`. */
export function isValidPluginId(id: string): boolean {
  if (id.length === 0 || id.length > MAX_IDENTIFIER_LEN) {
    return false;
  }
  const parts = id.split("/");
  if (parts.length !== 2) return false;
  const [author, name] = parts;
  return author !== undefined && name !== undefined && isValidSlug(author) && isValidSlug(name);
}

export function formatPluginEntryId(pluginId: string, entryName: string): string {
  if (!isValidPluginId(pluginId)) {
    throw new Error(`invalid plugin id: ${JSON.stringify(pluginId)}`);
  }
  if (!isValidSlug(entryName)) {
    throw new Error(`invalid plugin entry name: ${JSON.stringify(entryName)}`);
  }
  const full = `${pluginId}:${entryName}`;
  if (full.length > MAX_IDENTIFIER_LEN) {
    throw new Error(`plugin entry id exceeds ${MAX_IDENTIFIER_LEN} bytes: ${full}`);
  }
  return full;
}

export function pluginTopicName(pluginId: string, subtopic: string): string {
  if (!isValidPluginId(pluginId)) {
    throw new Error(`invalid plugin id: ${JSON.stringify(pluginId)}`);
  }
  const full = `plugin.${pluginId.replace("/", ".")}.${subtopic}`;
  if (!isValidTopicName(full)) {
    throw new Error(`invalid plugin topic name: ${JSON.stringify(full)}`);
  }
  return full;
}

export function pluginCommandName(pluginId: string, subcommand: string): string {
  if (!isValidPluginId(pluginId)) {
    throw new Error(`invalid plugin id: ${JSON.stringify(pluginId)}`);
  }
  const full = `plugin.${pluginId.replace("/", ".")}.${subcommand}`;
  if (!isValidCommandName(full)) {
    throw new Error(`invalid plugin command name: ${JSON.stringify(full)}`);
  }
  return full;
}

/** Validates manifest identifiers and returns a deeply frozen [`PluginDefinition`]. */
export function definePlugin<TConfig extends Record<string, unknown>>(
  definition: PluginDefinition<TConfig>,
): PluginDefinition<TConfig> {
  const { manifest } = definition;
  if (!isValidPluginId(manifest.id)) {
    throw new Error(`invalid plugin id in manifest: ${JSON.stringify(manifest.id)}`);
  }
  if (!Number.isInteger(manifest.pluginApi) || manifest.pluginApi < 1) {
    throw new Error(`pluginApi must be a positive integer, got ${manifest.pluginApi}`);
  }
  const seenEntries = new Set<string>();
  const frozenEntries = manifest.entries.map((entry) => {
    formatPluginEntryId(manifest.id, entry.name);
    if (seenEntries.has(entry.name)) {
      throw new Error(`duplicate entry name ${JSON.stringify(entry.name)} in ${manifest.id}`);
    }
    seenEntries.add(entry.name);
    return Object.freeze({ ...entry });
  });

  const frozenManifest: PluginManifest<TConfig> = Object.freeze({
    ...manifest,
    entries: Object.freeze(frozenEntries),
    defaults: Object.freeze({ ...manifest.defaults }),
  });

  return Object.freeze({
    manifest: frozenManifest,
    setup: definition.setup,
  });
}

/** Creates a scoped [`PluginContext`] without exposing the raw [`ZShellClient`]. */
export function createPluginContext<TConfig extends Record<string, unknown>>(
  pluginId: string,
  client: ZShellClient,
  defaults: TConfig,
  overrides?: Partial<TConfig>,
  instance?: EntryInstanceScope,
): PluginContext<TConfig> {
  if (!isValidPluginId(pluginId)) {
    throw new Error(`invalid plugin id: ${JSON.stringify(pluginId)}`);
  }
  const config = Object.freeze({ ...defaults, ...overrides }) as Readonly<TConfig>;
  const ctxBase: PluginContext<TConfig> = {
    pluginId,
    config,
    ...(instance !== undefined ? { instance: Object.freeze({ ...instance }) } : {}),
    subscribe(topic, listenerOrOptions) {
      return client.subscribe(topic, listenerOrOptions);
    },
    registerTopic(subtopic, initial) {
      return client.registerTopic(pluginTopicName(pluginId, subtopic), initial, pluginId);
    },
    publishTopic(subtopic, data) {
      return client.publishTopic(pluginTopicName(pluginId, subtopic), data);
    },
    unregisterTopic(subtopic) {
      return client.unregisterTopic(pluginTopicName(pluginId, subtopic));
    },
    registerCommand(subcommand, description, handler) {
      return client.registerCommand(
        pluginCommandName(pluginId, subcommand),
        description,
        handler,
        pluginId,
      );
    },
    invokeCommand(name, args, payload) {
      return client.invokeCommand(name, args, payload);
    },
    acquireInhibitor(scope, reason) {
      return client.acquireInhibitor(scope, reason, pluginId);
    },
    releaseInhibitor(cookie) {
      return client.releaseInhibitor(cookie);
    },
  };
  return Object.freeze(ctxBase);
}
