import {
  PLUGIN_API_LEVEL,
  definePlugin,
  type PluginContext,
  type PluginDefinition,
} from "@z-shell/plugin-api";
import type { CommandInvokeResult } from "@z-shell/sdk";

export interface ThemeBridgesConfig extends Record<string, unknown> {
  readonly enable_shojiwm: boolean;
  readonly enable_zen_browser: boolean;
  readonly shojiwm_socket: string;
  readonly zen_chrome_dir: string;
}

export interface ThemeTopicPayload {
  readonly mode: string;
  readonly roles: Readonly<Record<string, string>>;
  readonly revision?: number;
}

export type BridgeTargetState = "disabled" | "idle" | "applied" | "reverted" | "conflict" | "error";

export interface BridgeTargetStatus {
  readonly state: BridgeTargetState;
  readonly target: string | null;
  readonly lastRevision: number | null;
  readonly message: string | null;
}

export interface ThemeBridgesStatus {
  readonly lastThemeRevision: number | null;
  readonly shojiwm: BridgeTargetStatus;
  readonly zenBrowser: BridgeTargetStatus;
}

export interface ShojiWmThemeRequest {
  readonly method: "theme.set";
  readonly params: {
    readonly mode: string;
    readonly roles: Readonly<Record<string, string>>;
    readonly revision: number;
  };
}

export interface ZenRecoveryRecord {
  readonly schemaVersion: 1;
  readonly originalExists: boolean;
  readonly originalContent: string | null;
  readonly managedHash: string;
}

/**
 * Host-provided adapters keeping Theme Bridges strictly ES2022 / QuickJS-safe.
 */
export interface ThemeBridgesRuntime {
  sendShojiWmTheme?(socketPath: string, payload: ShojiWmThemeRequest): Promise<void> | void;
  readFile?(path: string): Promise<string | null> | string | null;
  writeFileAtomic?(path: string, content: string): Promise<void> | void;
  removeFile?(path: string): Promise<void> | void;
  hashContent?(content: string): string;
}

export const THEME_BRIDGES_DEFAULTS: ThemeBridgesConfig = Object.freeze({
  enable_shojiwm: false,
  enable_zen_browser: false,
  shojiwm_socket: "",
  zen_chrome_dir: "",
});

const USER_CHROME_FILE = "userChrome.css";
const RECOVERY_FILE = "z-shell-theme-recovery.json";

/**
 * Pure-ES2022 deterministic 64-bit FNV-1a pair digest (16 hex chars x 2) used when no host SHA-256
 * helper is supplied, guaranteeing zero Node/DOM globals in QuickJS.
 */
export function deterministicContentHash(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i);
    h1 ^= code & 0xff;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (code >>> 8) ^ (code & 0xff);
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  const hex1 = h1.toString(16).padStart(8, "0");
  const hex2 = h2.toString(16).padStart(8, "0");
  return `fnv1a:${hex1}${hex2}:${content.length}`;
}

function joinPath(dir: string, leaf: string): string {
  const trimmed = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  return `${trimmed}/${leaf}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseThemePayload(raw: unknown, topicRevision: number): ThemeTopicPayload | null {
  if (!isPlainRecord(raw)) {
    return null;
  }
  const paletteObj = isPlainRecord(raw.palette) ? raw.palette : raw;
  const rolesRaw = isPlainRecord(raw.scheme)
    ? raw.scheme
    : paletteObj.roles ?? raw.roles;
  if (!isPlainRecord(rolesRaw)) {
    return null;
  }
  const roles: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(rolesRaw)) {
    if (typeof value === "string" && value.length > 0) {
      roles[key] = value;
      count += 1;
    }
  }
  if (count === 0) {
    return null;
  }
  const modeRaw = raw.mode ?? paletteObj.mode;
  const mode =
    typeof modeRaw === "string" && modeRaw.length > 0
      ? modeRaw
      : typeof raw.dark === "boolean"
        ? raw.dark
          ? "dark"
          : "light"
        : "dark";
  const revRaw = raw.revision;
  const revision =
    typeof revRaw === "number" && Number.isInteger(revRaw) && revRaw >= 0
      ? revRaw
      : topicRevision;
  return { mode, roles, revision };
}

function parseRecoveryRecord(raw: string): ZenRecoveryRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed) || parsed.schemaVersion !== 1) {
      return null;
    }
    if (typeof parsed.originalExists !== "boolean") {
      return null;
    }
    if (parsed.originalContent !== null && typeof parsed.originalContent !== "string") {
      return null;
    }
    if (typeof parsed.managedHash !== "string" || parsed.managedHash.length === 0) {
      return null;
    }
    return {
      schemaVersion: 1,
      originalExists: parsed.originalExists,
      originalContent: parsed.originalContent,
      managedHash: parsed.managedHash,
    };
  } catch {
    return null;
  }
}

/**
 * Generates deterministic, self-contained Zen Browser `userChrome.css` variables from a z-shell
 * Material 3 theme payload.
 */
export function generateZenUserChromeCss(theme: ThemeTopicPayload): string {
  const keys = Object.keys(theme.roles).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines: string[] = [
    "/* Generated by z-shell/theme-bridges. Do not edit while managed; run revert first. */",
    `/* mode: ${theme.mode} */`,
    ":root {",
  ];
  for (const key of keys) {
    const cssKey = key.replace(/[^a-zA-Z0-9_-]/g, "-");
    const color = theme.roles[key];
    if (color !== undefined) {
      lines.push(`  --z-shell-${cssKey}: ${color};`);
    }
  }
  const primary = theme.roles.primary ?? theme.roles.accent;
  const surface = theme.roles.surface ?? theme.roles.background;
  const onSurface = theme.roles.on_surface ?? theme.roles.onSurface;
  if (primary !== undefined) {
    lines.push(`  --zen-primary-color: ${primary};`);
  }
  if (surface !== undefined) {
    lines.push(`  --zen-main-browser-background: ${surface};`);
  }
  if (onSurface !== undefined) {
    lines.push(`  --toolbar-color: ${onSurface};`);
  }
  lines.push("}", "");
  return lines.join("\n");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createThemeBridgesPlugin(
  runtime: ThemeBridgesRuntime = {},
): PluginDefinition<ThemeBridgesConfig> {
  return definePlugin<ThemeBridgesConfig>({
    manifest: {
      id: "z-shell/theme-bridges",
      version: "0.1.0",
      pluginApi: PLUGIN_API_LEVEL,
      title: "Theme Bridges",
      description:
        "Subscribes to the z-shell theme topic to drive optional ShojiWM theme.set UDS and reversible Zen Browser chrome styling",
      entries: [
        {
          name: "service",
          kind: "service",
          title: "External Theme Bridges",
          description:
            "Propagates z-shell Material 3 palette updates to optional ShojiWM and Zen Browser targets with conflict detection",
        },
      ],
      defaults: THEME_BRIDGES_DEFAULTS,
      hostCapabilities: {
        controlChannel: true,
      },
      busPermissions: {
        topicsRead: ["theme"],
        topicsPublish: ["plugin.z-shell.theme-bridges.status"],
        commandsRegister: [
          "plugin.z-shell.theme-bridges.reapply",
          "plugin.z-shell.theme-bridges.revert",
        ],
        inhibitors: false,
      },
    },

    async setup(ctx: PluginContext<ThemeBridgesConfig>) {
      const enableShojiWm = ctx.config.enable_shojiwm === true;
      const enableZen = ctx.config.enable_zen_browser === true;
      const shojiSocket =
        typeof ctx.config.shojiwm_socket === "string" ? ctx.config.shojiwm_socket.trim() : "";
      const zenChromeDir =
        typeof ctx.config.zen_chrome_dir === "string" ? ctx.config.zen_chrome_dir.trim() : "";
      const hashContent = runtime.hashContent ?? deterministicContentHash;

      let closed = false;
      let latestTheme: ThemeTopicPayload | null = null;
      let lastThemeRevision: number | null = null;
      let queue: Promise<void> = Promise.resolve();

      let shojiStatus: BridgeTargetStatus = {
        state: enableShojiWm ? "idle" : "disabled",
        target: enableShojiWm && shojiSocket.length > 0 ? shojiSocket : null,
        lastRevision: null,
        message: enableShojiWm ? null : "ShojiWM bridge disabled in settings",
      };
      let zenStatus: BridgeTargetStatus = {
        state: enableZen ? "idle" : "disabled",
        target: enableZen && zenChromeDir.length > 0 ? joinPath(zenChromeDir, USER_CHROME_FILE) : null,
        lastRevision: null,
        message: enableZen ? null : "Zen Browser bridge disabled in settings",
      };

      function snapshotStatus(): ThemeBridgesStatus {
        return {
          lastThemeRevision,
          shojiwm: { ...shojiStatus },
          zenBrowser: { ...zenStatus },
        };
      }

      function enqueue<T>(task: () => Promise<T>): Promise<T> {
        const next = queue.then(task, task);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      }

      async function applyShojiWm(theme: ThemeTopicPayload, revision: number): Promise<void> {
        if (!enableShojiWm) {
          shojiStatus = {
            state: "disabled",
            target: null,
            lastRevision: null,
            message: "ShojiWM bridge disabled in settings",
          };
          return;
        }
        if (shojiSocket.length === 0) {
          shojiStatus = {
            state: "error",
            target: null,
            lastRevision: shojiStatus.lastRevision,
            message: "shojiwm_socket setting is empty",
          };
          return;
        }
        if (runtime.sendShojiWmTheme === undefined) {
          shojiStatus = {
            state: "error",
            target: shojiSocket,
            lastRevision: shojiStatus.lastRevision,
            message: "ShojiWM UDS adapter unavailable",
          };
          return;
        }
        try {
          await runtime.sendShojiWmTheme(shojiSocket, {
            method: "theme.set",
            params: {
              mode: theme.mode,
              roles: theme.roles,
              revision,
            },
          });
          shojiStatus = {
            state: "applied",
            target: shojiSocket,
            lastRevision: revision,
            message: null,
          };
        } catch (err) {
          // Never throw or roll back the shell palette when an optional external target fails.
          shojiStatus = {
            state: "error",
            target: shojiSocket,
            lastRevision: shojiStatus.lastRevision,
            message: errorMessage(err),
          };
        }
      }

      async function applyZenBrowser(theme: ThemeTopicPayload, revision: number): Promise<void> {
        if (!enableZen) {
          zenStatus = {
            state: "disabled",
            target: null,
            lastRevision: null,
            message: "Zen Browser bridge disabled in settings",
          };
          return;
        }
        if (zenChromeDir.length === 0) {
          zenStatus = {
            state: "error",
            target: null,
            lastRevision: zenStatus.lastRevision,
            message: "zen_chrome_dir setting is empty",
          };
          return;
        }
        const cssPath = joinPath(zenChromeDir, USER_CHROME_FILE);
        const recoveryPath = joinPath(zenChromeDir, RECOVERY_FILE);
        if (runtime.readFile === undefined || runtime.writeFileAtomic === undefined) {
          zenStatus = {
            state: "error",
            target: cssPath,
            lastRevision: zenStatus.lastRevision,
            message: "Zen Browser file adapter unavailable",
          };
          return;
        }

        try {
          const existingCss = await runtime.readFile(cssPath);
          const existingRecoveryRaw = await runtime.readFile(recoveryPath);
          let recovery: ZenRecoveryRecord | null = null;

          if (existingRecoveryRaw !== null) {
            recovery = parseRecoveryRecord(existingRecoveryRaw);
            if (recovery === null) {
              zenStatus = {
                state: "conflict",
                target: cssPath,
                lastRevision: zenStatus.lastRevision,
                message: "recovery record is corrupted; refusing to overwrite userChrome.css",
              };
              return;
            }
            if (existingCss !== null && hashContent(existingCss) !== recovery.managedHash) {
              zenStatus = {
                state: "conflict",
                target: cssPath,
                lastRevision: zenStatus.lastRevision,
                message: "userChrome.css was modified externally; refusing to overwrite",
              };
              return;
            }
          }

          const cssContent = generateZenUserChromeCss(theme);
          const nextRecord: ZenRecoveryRecord = {
            schemaVersion: 1,
            originalExists: recovery !== null ? recovery.originalExists : existingCss !== null,
            originalContent: recovery !== null ? recovery.originalContent : existingCss,
            managedHash: hashContent(cssContent),
          };
          await runtime.writeFileAtomic(recoveryPath, `${JSON.stringify(nextRecord, null, 2)}\n`);
          await runtime.writeFileAtomic(cssPath, cssContent);

          zenStatus = {
            state: "applied",
            target: cssPath,
            lastRevision: revision,
            message: null,
          };
        } catch (err) {
          zenStatus = {
            state: "error",
            target: cssPath,
            lastRevision: zenStatus.lastRevision,
            message: errorMessage(err),
          };
        }
      }

      async function revertZenBrowser(force: boolean): Promise<void> {
        if (zenChromeDir.length === 0) {
          zenStatus = {
            state: enableZen ? "idle" : "disabled",
            target: null,
            lastRevision: null,
            message: "zen_chrome_dir setting is empty",
          };
          return;
        }
        const cssPath = joinPath(zenChromeDir, USER_CHROME_FILE);
        const recoveryPath = joinPath(zenChromeDir, RECOVERY_FILE);
        if (
          runtime.readFile === undefined ||
          runtime.writeFileAtomic === undefined ||
          runtime.removeFile === undefined
        ) {
          zenStatus = {
            state: "error",
            target: cssPath,
            lastRevision: zenStatus.lastRevision,
            message: "Zen Browser file adapter unavailable",
          };
          return;
        }
        try {
          const recoveryRaw = await runtime.readFile(recoveryPath);
          if (recoveryRaw === null) {
            zenStatus = {
              state: "reverted",
              target: cssPath,
              lastRevision: null,
              message: "no active Zen Browser theme recovery record",
            };
            return;
          }
          const recovery = parseRecoveryRecord(recoveryRaw);
          if (recovery === null) {
            zenStatus = {
              state: "conflict",
              target: cssPath,
              lastRevision: zenStatus.lastRevision,
              message: "recovery record is corrupted; cannot revert safely",
            };
            return;
          }
          const currentCss = await runtime.readFile(cssPath);
          if (!force && currentCss !== null && hashContent(currentCss) !== recovery.managedHash) {
            zenStatus = {
              state: "conflict",
              target: cssPath,
              lastRevision: zenStatus.lastRevision,
              message: "userChrome.css was modified externally; pass force=true to revert",
            };
            return;
          }

          if (recovery.originalExists && recovery.originalContent !== null) {
            await runtime.writeFileAtomic(cssPath, recovery.originalContent);
          } else {
            await runtime.removeFile(cssPath);
          }
          await runtime.removeFile(recoveryPath);
          zenStatus = {
            state: "reverted",
            target: cssPath,
            lastRevision: null,
            message: null,
          };
        } catch (err) {
          zenStatus = {
            state: "error",
            target: cssPath,
            lastRevision: zenStatus.lastRevision,
            message: errorMessage(err),
          };
        }
      }

      async function applyAll(theme: ThemeTopicPayload, revision: number): Promise<ThemeBridgesStatus> {
        if (closed) {
          return snapshotStatus();
        }
        latestTheme = theme;
        lastThemeRevision = revision;
        // Apply each bridge independently so a failure in one never blocks the other.
        await applyShojiWm(theme, revision);
        await applyZenBrowser(theme, revision);
        const status = snapshotStatus();
        if (!closed) {
          await ctx.publishTopic("status", status);
        }
        return status;
      }

      await ctx.registerTopic("status", snapshotStatus());

      const { snapshot: initialTheme, unsubscribe } = await ctx.subscribe("theme", (update) => {
        const parsed = parseThemePayload(update.data, update.revision);
        if (parsed !== null) {
          void enqueue(() => applyAll(parsed, parsed.revision ?? update.revision));
        }
      });

      const initialParsed = parseThemePayload(initialTheme.data, initialTheme.revision);
      if (initialParsed !== null) {
        await enqueue(() => applyAll(initialParsed, initialParsed.revision ?? initialTheme.revision));
      }

      const unregisterReapply = await ctx.registerCommand(
        "reapply",
        "Re-apply the latest committed shell theme to enabled external bridges",
        async (): Promise<CommandInvokeResult> => {
          const status = await enqueue(async () => {
            if (latestTheme === null) {
              return snapshotStatus();
            }
            return applyAll(latestTheme, lastThemeRevision ?? 0);
          });
          return {
            message: latestTheme === null ? "no theme snapshot received yet" : "theme bridges reapplied",
            data: status,
          };
        },
      );

      const unregisterRevert = await ctx.registerCommand(
        "revert",
        "Revert reversible Zen Browser chrome styling back to its pre-bridge state",
        async ({ payload }): Promise<CommandInvokeResult> => {
          const force =
            isPlainRecord(payload) && typeof payload.force === "boolean" ? payload.force : false;
          const status = await enqueue(async () => {
            await revertZenBrowser(force);
            const next = snapshotStatus();
            if (!closed) {
              await ctx.publishTopic("status", next);
            }
            return next;
          });
          return {
            message:
              status.zenBrowser.state === "reverted"
                ? "Zen Browser theme reverted"
                : status.zenBrowser.message ?? "Zen Browser revert did not complete",
            data: status,
          };
        },
      );

      return async () => {
        closed = true;
        await unsubscribe().catch(() => undefined);
        await queue;
        await unregisterReapply().catch(() => undefined);
        await unregisterRevert().catch(() => undefined);
        await ctx.unregisterTopic("status").catch(() => undefined);
      };
    },
  });
}

export default createThemeBridgesPlugin();
