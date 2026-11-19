import { definePlugin, type PluginDefinition } from "@z-shell/plugin-api";

export type AiUsageConfig = {
  refresh_seconds: number;
  codex_resets_url: string;
  timeout_ms: number;
};

export interface QuotaEntry {
  readonly provider: string;
  readonly label: string;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly resetsAt: string | null;
  readonly status: string;
}

interface CodexReset {
  readonly kind: string | null;
  readonly announcedAt: string | null;
  readonly scheduledFor: string | null;
}

interface CodexResets {
  readonly latest: CodexReset | null;
  readonly scheduled: CodexReset | null;
  readonly forecastChancePercent: number | null;
  readonly generatedAt: string | null;
}

type PollSource = "command" | "network";
type ErrorCode = "timeout" | "failed" | "invalid_response";

export interface AiUsageSnapshot {
  readonly quotas: readonly QuotaEntry[];
  readonly codexResets: CodexResets | null;
  readonly updatedAt: number | null;
  readonly lastError: { readonly source: PollSource; readonly code: ErrorCode; readonly message: string } | null;
  readonly stale: boolean;
  readonly offlineBlocked: boolean;
  readonly backoffMs: number;
}

type Cancel = () => void;
type Operation<T> = Promise<T> | { readonly promise: Promise<T>; readonly cancel: Cancel };
type CommandResult = { readonly stdout: string; readonly status: number | null };

export interface AiUsageRuntime {
  execCommand(cmd: string, args: readonly string[], timeoutMs: number): Operation<CommandResult | string>;
  fetchJson(url: string, timeoutMs: number): Operation<unknown>;
  now(): number;
  /** Schedule a future turn. Cancellation must be idempotent. */
  schedule(delayMs: number, cb: () => void): Cancel;
}

interface ZguiHost {
  readonly __zguiServices?: {
    spawnCommand(cmd: string, args: readonly string[]): Operation<CommandResult>;
  };
  setTimeout?(cb: () => void, delayMs: number): unknown;
  clearTimeout?(timer: unknown): void;
}

const host = globalThis as ZguiHost;
const defaultRuntime: AiUsageRuntime = {
  execCommand(cmd, args) {
    if (!host.__zguiServices) throw new Error("zgui-js command service unavailable");
    return host.__zguiServices.spawnCommand(cmd, args);
  },
  fetchJson() {
    // zgui-js has no HTTP host service. A composition enabling the feed supplies an HTTP adapter.
    throw new Error("HTTP adapter unavailable");
  },
  now: Date.now,
  schedule(delayMs, cb) {
    if (!host.setTimeout || !host.clearTimeout) throw new Error("zgui-js timer service unavailable");
    const timer = host.setTimeout(cb, delayMs);
    return () => host.clearTimeout?.(timer);
  },
};

const BACKOFF_CAP_MS = 3_600_000;
const OFFLINE = Symbol("offline");
const STOPPED = Symbol("stopped");
const TIMEOUT = Symbol("timeout");
const INVALID_RESPONSE = Symbol("invalid response");

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function percent(value: unknown): number | null {
  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric)
    ? Math.max(0, Math.min(100, numeric))
    : null;
}

function parseQuotas(result: CommandResult | string): QuotaEntry[] {
  if (typeof result !== "string" && result.status !== 0) throw new Error("nonzero command status");
  let report: Record<string, unknown> | undefined;
  try {
    report = record(JSON.parse(typeof result === "string" ? result : result.stdout));
  } catch {
    throw INVALID_RESPONSE;
  }
  if (report?.schema_version !== 1 || !Array.isArray(report.entries)) throw INVALID_RESPONSE;
  const quotas: QuotaEntry[] = [];
  for (const item of report.entries as unknown[]) {
    const entry = record(item);
    const provider = text(entry?.id);
    if (!entry || !provider) throw INVALID_RESPONSE;
    const status = text(entry.status) ?? "unknown";
    if (entry.metrics !== undefined && !Array.isArray(entry.metrics)) throw INVALID_RESPONSE;
    const metrics: readonly unknown[] = entry.metrics ?? [];
    if (metrics.length === 0) {
      quotas.push({ provider, label: text(entry.display_name) ?? provider, usedPercent: null,
        remainingPercent: null, resetsAt: null, status });
    }
    for (const item of metrics) {
      const metric = record(item);
      if (!metric) throw INVALID_RESPONSE;
      const usedPercent = percent(metric.percent);
      quotas.push({ provider, label: text(metric.label) ?? text(entry.display_name) ?? provider,
        usedPercent, remainingPercent: usedPercent === null ? null : 100 - usedPercent,
        resetsAt: text(metric.reset_at), status });
    }
  }
  return quotas;
}

function resetEvent(value: unknown): CodexReset | null {
  const event = record(value);
  return event ? { kind: text(event.reset_type), announcedAt: text(event.announced_at),
    scheduledFor: text(event.scheduled_for) } : null;
}

function parseResets(value: unknown): CodexResets {
  const report = record(value);
  const meta = record(report?.meta);
  const data = record(report?.data);
  if (meta?.api_version !== "v1" || !data) throw INVALID_RESPONSE;
  return {
    latest: resetEvent(data.latest_reset),
    scheduled: resetEvent(data.scheduled_reset),
    forecastChancePercent: percent(record(data.active_watch)?.reset_chance_percent),
    generatedAt: text(meta.generated_at),
  };
}

function pollError(source: PollSource, error: unknown): NonNullable<AiUsageSnapshot["lastError"]> {
  const code = error === TIMEOUT ? "timeout" : error === INVALID_RESPONSE ? "invalid_response" : "failed";
  const name = source === "command" ? "ai-usagebar" : "Codex Resets";
  const detail = code === "timeout" ? "timed out" : code === "invalid_response" ? "returned invalid JSON data" : "request failed";
  // Command stderr, transport errors and the configured URL can contain credentials.
  return { source, code, message: `${name} ${detail}` };
}

export function createAiUsagePlugin(runtime: AiUsageRuntime = defaultRuntime): PluginDefinition<AiUsageConfig> {
  return definePlugin<AiUsageConfig>({
    manifest: {
      id: "z-shell/ai-usage",
      title: "AI Usage",
      version: "0.1.0",
      pluginApi: 1,
      entries: [{ name: "service", kind: "service", title: "AI Usage Poller" }],
      defaults: { refresh_seconds: 300, codex_resets_url: "", timeout_ms: 5000 },
    },
    async setup(ctx) {
      const { refresh_seconds, timeout_ms, codex_resets_url } = ctx.config;
      const interval = Math.min(3600, Math.max(30, refresh_seconds)) * 1000;
      const timeout = Math.min(30_000, Math.max(500, timeout_ms));
      const url = codex_resets_url.trim();
      let offlineMode = true; // Fail closed until the subscription snapshot says otherwise.
      let stopped = false;
      let topicRegistered = false;
      let snapshot: AiUsageSnapshot = {
        quotas: [], codexResets: null, updatedAt: null, lastError: null,
        stale: true, offlineBlocked: url !== "", backoffMs: 0,
      };
      let refreshInFlight: Promise<AiUsageSnapshot> | undefined;
      let cancelTimer: Cancel | undefined;
      let cancelOperation: ((reason: symbol) => void) | undefined;
      let unsubStatus: (() => Promise<void>) | undefined;
      let unregisterCommand: (() => Promise<void>) | undefined;

      async function run<T>(start: () => Operation<T>): Promise<T> {
        let cancelDeadline: Cancel | undefined;
        let cancelRequest: Cancel | undefined;
        let reason: symbol | undefined;
        try {
          return await new Promise<T>((resolve, reject) => {
            cancelOperation = (why) => {
              if (reason !== undefined) return;
              reason = why;
              reject(why);
              cancelRequest?.();
            };
            cancelDeadline = runtime.schedule(timeout, () => cancelOperation?.(TIMEOUT));
            const operation = start();
            if ("promise" in operation) {
              cancelRequest = () => operation.cancel();
              if (reason !== undefined) cancelRequest();
              void operation.promise.then(resolve, reject);
            } else {
              void operation.then(resolve, reject);
            }
          });
        } finally {
          cancelDeadline?.();
          cancelOperation = undefined;
        }
      }

      let fetchingRemote = false;
      function applyPolicy(data: { readonly offline_mode?: boolean } | undefined): void {
        offlineMode = data?.offline_mode !== false;
        if (offlineMode && fetchingRemote) cancelOperation?.(OFFLINE);
        const offlineBlocked = url !== "" && offlineMode;
        if (snapshot.offlineBlocked === offlineBlocked || stopped) return;
        snapshot = { ...snapshot, offlineBlocked };
        if (topicRegistered) void ctx.publishTopic("quotas", snapshot).catch(() => undefined);
      }

      async function poll(): Promise<AiUsageSnapshot> {
        if (stopped) return snapshot;
        let source: PollSource = "command";
        try {
          const quotas = parseQuotas(await run(() => runtime.execCommand("ai-usagebar", ["usage", "--json"], timeout)));
          if (stopped) return snapshot;
          let codexResets = snapshot.codexResets;
          if (url !== "" && !offlineMode) {
            source = "network";
            fetchingRemote = true;
            try {
              const data = await run(() => runtime.fetchJson(url, timeout));
              if (!offlineMode) codexResets = parseResets(data);
            } catch (error) {
              if (error !== OFFLINE) throw error;
            } finally {
              fetchingRemote = false;
            }
          }
          if (stopped) return snapshot;
          snapshot = { ...snapshot, quotas, codexResets, updatedAt: runtime.now(), lastError: null,
            stale: false, backoffMs: 0 };
        } catch (error) {
          if (stopped) return snapshot;
          snapshot = { ...snapshot, lastError: pollError(source, error), stale: true,
            backoffMs: Math.min(BACKOFF_CAP_MS, (snapshot.backoffMs || interval) * 2) };
        }
        await ctx.publishTopic("quotas", snapshot);
        return snapshot;
      }

      function refresh(): Promise<AiUsageSnapshot> {
        if (stopped) return Promise.resolve(snapshot);
        if (refreshInFlight) return refreshInFlight;
        cancelTimer?.();
        cancelTimer = undefined;
        refreshInFlight = Promise.resolve().then(poll).finally(() => {
          refreshInFlight = undefined;
          if (!stopped) {
            cancelTimer = runtime.schedule(snapshot.backoffMs || interval, () => {
              cancelTimer = undefined;
              void refresh().catch(() => undefined);
            });
          }
        });
        return refreshInFlight;
      }

      async function cleanup(): Promise<void> {
        if (stopped) return;
        stopped = true;
        cancelTimer?.();
        cancelOperation?.(STOPPED);
        await Promise.all([
          unsubStatus?.(), unregisterCommand?.(), topicRegistered ? ctx.unregisterTopic("quotas") : undefined,
        ]);
      }

      try {
        const status = await ctx.subscribe<{ readonly offline_mode?: boolean }>("daemon.status", {
          onUpdate: ({ data }) => applyPolicy(data),
          onRemoved: () => applyPolicy(undefined),
          onReset: () => applyPolicy(undefined),
        });
        unsubStatus = status.unsubscribe;
        applyPolicy(status.snapshot.data);
        const initial = snapshot;
        await ctx.registerTopic("quotas", initial);
        topicRegistered = true;
        if (snapshot !== initial) await ctx.publishTopic("quotas", snapshot);
        unregisterCommand = await ctx.registerCommand("refresh", "Refresh AI quotas", async () => ({ data: await refresh() }));
        void refresh().catch(() => undefined);
        return cleanup;
      } catch (error) {
        await cleanup().catch(() => undefined);
        throw error;
      }
    },
  });
}

export default createAiUsagePlugin();
