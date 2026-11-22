import {
  PLUGIN_API_LEVEL,
  definePlugin,
  type PluginContext,
  type PluginDefinition,
} from "@z-shell/plugin-api";
import type { CommandInvokeResult, InhibitorScope } from "@z-shell/sdk";

export interface NoSleepConfig extends Record<string, unknown> {
  readonly poll_interval_ms: number;
  readonly agent_working_dir: string;
  readonly inhibit_scope: string;
}

export interface AgentMarker {
  readonly id: string;
  readonly label?: string;
  readonly updatedAtMs?: number;
}

export interface NoSleepSnapshot {
  readonly active: boolean;
  readonly manualActive: boolean;
  readonly manualExpiresAtMs: number | null;
  readonly manualDurationSeconds: number | null;
  readonly activeAgents: readonly AgentMarker[];
  readonly scope: InhibitorScope;
  readonly cookieHeld: boolean;
  readonly lastCheckedAtMs: number | null;
  readonly lastError: string | null;
}

export type CancelTimer = () => void;

/**
 * Host-provided runtime hooks so NoSleep stays strictly ES2022 / QuickJS-safe without Node/Bun globals.
 */
export interface NoSleepRuntime {
  listActiveAgents?(workingDir: string): Promise<readonly AgentMarker[]> | readonly AgentMarker[];
  now?(): number;
  schedule?(delayMs: number, callback: () => void): CancelTimer;
}

export const NOSLEEP_DEFAULTS: NoSleepConfig = Object.freeze({
  poll_interval_ms: 2000,
  agent_working_dir: "",
  inhibit_scope: "sleep",
});

function parseScope(value: unknown): InhibitorScope {
  if (value === "idle" || value === "sleep" || value === "lock") {
    return value;
  }
  return "sleep";
}

function normalizePollInterval(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.trunc(value);
    if (rounded >= 500 && rounded <= 60_000) {
      return rounded;
    }
  }
  return NOSLEEP_DEFAULTS.poll_interval_ms;
}

function normalizeAgents(raw: readonly AgentMarker[]): AgentMarker[] {
  const seen = new Set<string>();
  const normalized: AgentMarker[] = [];
  for (const item of raw) {
    const id = item.id.trim();
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const entry: AgentMarker = {
      id,
      ...(item.label !== undefined && item.label.trim().length > 0
        ? { label: item.label.trim() }
        : {}),
      ...(item.updatedAtMs !== undefined && Number.isFinite(item.updatedAtMs)
        ? { updatedAtMs: item.updatedAtMs }
        : {}),
    };
    normalized.push(entry);
  }
  normalized.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return normalized;
}

function agentsEqual(a: readonly AgentMarker[], b: readonly AgentMarker[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left === undefined ||
      right === undefined ||
      left.id !== right.id ||
      left.label !== right.label ||
      left.updatedAtMs !== right.updatedAtMs
    ) {
      return false;
    }
  }
  return true;
}

interface ParsedToggleRequest {
  readonly enabled: boolean;
  readonly durationSeconds?: number | null;
}

function parseToggleCommand(
  args: readonly string[],
  payload: unknown,
  current: boolean,
): ParsedToggleRequest {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const rawDuration = record.duration_seconds;
    const hasDuration = "duration_seconds" in record;
    const durationSeconds =
      typeof rawDuration === "number" && Number.isFinite(rawDuration) && rawDuration > 0
        ? Math.trunc(rawDuration)
        : rawDuration === null
          ? null
          : undefined;
    if (typeof record.enabled === "boolean") {
      return {
        enabled: record.enabled,
        ...(hasDuration && durationSeconds !== undefined ? { durationSeconds } : {}),
      };
    }
    if (hasDuration && durationSeconds !== undefined) {
      return { enabled: true, durationSeconds };
    }
  }
  const first = args[0]?.trim().toLowerCase();
  if (first === "on" || first === "true" || first === "enable" || first === "1") {
    return { enabled: true };
  }
  if (first === "off" || first === "false" || first === "disable" || first === "0") {
    return { enabled: false };
  }
  return { enabled: !current };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createNoSleepPlugin(runtime: NoSleepRuntime = {}): PluginDefinition<NoSleepConfig> {
  return definePlugin<NoSleepConfig>({
    manifest: {
      id: "z-shell/nosleep",
      version: "0.1.0",
      pluginApi: PLUGIN_API_LEVEL,
      title: "NoSleep",
      description:
        "Manual sleep inhibition and Herdr agent-working detection backed by z-shelld bus inhibitors",
      entries: [
        {
          name: "service",
          kind: "service",
          title: "NoSleep Inhibitor Service",
          description:
            "Reconciles manual toggles and active agent markers into one z-shelld bus inhibitor lease",
        },
      ],
      defaults: NOSLEEP_DEFAULTS,
      hostCapabilities: {
        controlChannel: true,
      },
      busPermissions: {
        topicsRead: [],
        topicsPublish: ["plugin.z-shell.nosleep.state"],
        commandsRegister: ["plugin.z-shell.nosleep.toggle", "plugin.z-shell.nosleep.status"],
        inhibitors: true,
      },
    },

    async setup(ctx: PluginContext<NoSleepConfig>) {
      const scope = parseScope(ctx.config.inhibit_scope);
      const pollIntervalMs = normalizePollInterval(ctx.config.poll_interval_ms);
      const workingDir =
        typeof ctx.config.agent_working_dir === "string"
          ? ctx.config.agent_working_dir.trim()
          : "";
      const now = runtime.now ?? (() => Date.now());

      let manualActive = false;
      let manualExpiresAtMs: number | null = null;
      let manualDurationSeconds: number | null = null;
      let activeAgents: AgentMarker[] = [];
      let heldCookie: number | null = null;
      let lastCheckedAtMs: number | null = null;
      let lastError: string | null = null;
      let closed = false;
      let cancelTimer: CancelTimer | null = null;
      let cancelManualTimer: CancelTimer | null = null;
      let queue: Promise<void> = Promise.resolve();

      function clearManualExpiry(): void {
        cancelManualTimer?.();
        cancelManualTimer = null;
        manualExpiresAtMs = null;
        manualDurationSeconds = null;
      }

      function armManualExpiry(durationSeconds: number): void {
        clearManualExpiry();
        manualDurationSeconds = durationSeconds;
        manualExpiresAtMs = now() + durationSeconds * 1000;
        if (runtime.schedule !== undefined && !closed) {
          cancelManualTimer = runtime.schedule(durationSeconds * 1000, () => {
            cancelManualTimer = null;
            void enqueue(async () => {
              manualActive = false;
              manualExpiresAtMs = null;
              manualDurationSeconds = null;
              return reconcileAndPublish(true);
            });
          });
        }
      }

      function buildSnapshot(): NoSleepSnapshot {
        return {
          active: manualActive || activeAgents.length > 0,
          manualActive,
          manualExpiresAtMs,
          manualDurationSeconds,
          activeAgents: activeAgents.slice(),
          scope,
          cookieHeld: heldCookie !== null,
          lastCheckedAtMs,
          lastError,
        };
      }

      function buildReason(): string {
        if (manualActive && activeAgents.length > 0) {
          return `nosleep manual + ${activeAgents.length} active agent(s)`;
        }
        if (manualActive) {
          return "nosleep manual override";
        }
        if (activeAgents.length === 1) {
          const only = activeAgents[0];
          return `agent working: ${only?.label ?? only?.id ?? "agent"}`;
        }
        return `${activeAgents.length} agents working`;
      }

      function enqueue<T>(task: () => Promise<T>): Promise<T> {
        const next = queue.then(task, task);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      }

      async function reconcileAndPublish(forcePublish: boolean): Promise<NoSleepSnapshot> {
        if (closed) {
          return buildSnapshot();
        }
        const desiredActive = manualActive || activeAgents.length > 0;
        let stateChanged = forcePublish;

        if (desiredActive && heldCookie === null) {
          try {
            const acquired = await ctx.acquireInhibitor(scope, buildReason());
            heldCookie = acquired.cookie;
            if (lastError !== null) {
              lastError = null;
            }
            stateChanged = true;
          } catch (err) {
            const msg = `failed to acquire inhibitor: ${errorMessage(err)}`;
            if (lastError !== msg) {
              lastError = msg;
              stateChanged = true;
            }
          }
        } else if (!desiredActive && heldCookie !== null) {
          const cookie = heldCookie;
          try {
            await ctx.releaseInhibitor(cookie);
            heldCookie = null;
            if (lastError !== null) {
              lastError = null;
            }
            stateChanged = true;
          } catch (err) {
            const msg = `failed to release inhibitor: ${errorMessage(err)}`;
            if (lastError !== msg) {
              lastError = msg;
              stateChanged = true;
            }
          }
        }

        const snapshot = buildSnapshot();
        if (stateChanged && !closed) {
          await ctx.publishTopic("state", snapshot);
        }
        return snapshot;
      }

      async function pollAgents(forcePublish = false): Promise<NoSleepSnapshot> {
        if (closed) {
          return buildSnapshot();
        }
        let changed = forcePublish;
        if (workingDir.length > 0 && runtime.listActiveAgents !== undefined) {
          lastCheckedAtMs = now();
          try {
            const found = normalizeAgents(await runtime.listActiveAgents(workingDir));
            if (!agentsEqual(activeAgents, found)) {
              activeAgents = found;
              changed = true;
            }
            if (lastError !== null && lastError.startsWith("failed to scan agent markers:")) {
              lastError = null;
              changed = true;
            }
          } catch (err) {
            const msg = `failed to scan agent markers: ${errorMessage(err)}`;
            if (lastError !== msg) {
              lastError = msg;
              changed = true;
            }
          }
        }
        return reconcileAndPublish(changed);
      }

      function scheduleNextPoll(): void {
        if (closed || runtime.schedule === undefined || workingDir.length === 0 || runtime.listActiveAgents === undefined) {
          return;
        }
        cancelTimer?.();
        cancelTimer = runtime.schedule(pollIntervalMs, () => {
          cancelTimer = null;
          void enqueue(() => pollAgents(false)).finally(() => {
            if (!closed) {
              scheduleNextPoll();
            }
          });
        });
      }

      await ctx.registerTopic("state", buildSnapshot());

      const unregisterToggle = await ctx.registerCommand(
        "toggle",
        "Toggle manual sleep inhibition on or off",
        async ({ args, payload }): Promise<CommandInvokeResult> => {
          const snapshot = await enqueue(async () => {
            const parsed = parseToggleCommand(args, payload, manualActive);
            manualActive = parsed.enabled;
            if (!manualActive) {
              clearManualExpiry();
            } else if (parsed.durationSeconds !== undefined) {
              if (parsed.durationSeconds === null) clearManualExpiry();
              else armManualExpiry(parsed.durationSeconds);
            }
            return reconcileAndPublish(true);
          });
          return {
            message: snapshot.manualActive
              ? "nosleep manual inhibition enabled"
              : "nosleep manual inhibition disabled",
            data: snapshot,
          };
        },
      );

      const unregisterStatus = await ctx.registerCommand(
        "status",
        "Return current NoSleep state and refresh active agent markers",
        async (): Promise<CommandInvokeResult> => {
          const snapshot = await enqueue(() => pollAgents(false));
          return {
            message: snapshot.active ? "nosleep active" : "nosleep inactive",
            data: snapshot,
          };
        },
      );

      await enqueue(() => pollAgents(false));
      scheduleNextPoll();

      return async () => {
        closed = true;
        cancelTimer?.();
        cancelTimer = null;
        clearManualExpiry();
        await queue;
        if (heldCookie !== null) {
          const cookie = heldCookie;
          heldCookie = null;
          try {
            await ctx.releaseInhibitor(cookie);
          } catch {
            // Connection may already be closing; daemon also revokes leases on disconnect.
          }
        }
        await unregisterToggle().catch(() => undefined);
        await unregisterStatus().catch(() => undefined);
        await ctx.unregisterTopic("state").catch(() => undefined);
      };
    },
  });
}

export default createNoSleepPlugin();
