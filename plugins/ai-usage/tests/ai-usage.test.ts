import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { computeContentDigest, parsePluginManifest } from "@z-shell/composer";
import { createPluginContext } from "@z-shell/plugin-api";
import { FixtureTransport, METHODS, PROTOCOL_VERSION, ZShellClient } from "@z-shell/sdk";
import { createAiUsagePlugin, type AiUsageConfig, type AiUsageRuntime, type AiUsageSnapshot } from "../src/service.ts";

const pluginDir = `${import.meta.dir}/..`;
const command = "plugin.z-shell.ai-usage.refresh";
const topic = "plugin.z-shell.ai-usage.quotas";
const feedUrl = "https://codex-resets.example/api/v1/status";
const resetTime = "2030-01-06T00:00:00Z";
const feed = {
  meta: { api_version: "v1", generated_at: "2030-01-01T00:00:00Z" },
  data: { scheduled_reset: { reset_type: "regular", scheduled_for: resetTime }, active_watch: { reset_chance_percent: 42 } },
};

function usage(percent = 24): string {
  return JSON.stringify({ schema_version: 1, entries: [{
    id: "openai@work", display_name: "Work", status: "ready",
    metrics: [{ label: "Session", percent }, { label: "Weekly", percent: 143, reset_at: resetTime },
      { label: "Credits", value: "Unknown" }],
  }] });
}

async function mount(options: { offline?: boolean; config?: Partial<AiUsageConfig>; runtime?: Partial<AiUsageRuntime> } = {}) {
  let statusRevision = 1;
  const calls: { cmd: string; args: readonly string[]; timeout: number }[] = [];
  const fetches: { url: string; timeout: number }[] = [];
  const timers = new Map<() => void, number>();
  const states: AiUsageSnapshot[] = [];
  const replies = new Map<number, { result?: { data: AiUsageSnapshot }; error?: string }>();
  const fixture = new FixtureTransport((frame) => {
    switch (frame.method) {
      case METHODS.BUS_HELLO:
        return { result: { protocol_version: PROTOCOL_VERSION, daemon_version: "0.1.0",
          daemon_instance_id: "daemon", client_id: 1, role: "public", media_dir: "/tmp/media" } };
      case METHODS.TOPIC_SUBSCRIBE:
        return { result: { daemon_instance_id: "daemon", topic_instance_id: 1, revision: statusRevision,
          topic: "daemon.status", data: { offline_mode: options.offline ?? false } } };
      case METHODS.TOPIC_REGISTER: {
        const params = frame.params as { topic: string; initial: AiUsageSnapshot };
        if (params.topic === topic) states.push(params.initial);
        return { result: { topic_instance_id: 2, revision: states.length } };
      }
      case METHODS.TOPIC_PUBLISH: {
        const params = frame.params as { topic: string; data: AiUsageSnapshot };
        if (params.topic === topic) states.push(params.data);
        return { result: { revision: states.length } };
      }
      case METHODS.COMMAND_REPLY: {
        const params = frame.params as { call_id: number; result?: { data: AiUsageSnapshot }; error?: string };
        replies.set(params.call_id, params);
        break;
      }
    }
    return { result: {} };
  });
  const client = await ZShellClient.connect(fixture, "ai-usage-test");
  const plugin = createAiUsagePlugin({
    execCommand(cmd, args, timeout) {
      calls.push({ cmd, args, timeout });
      return options.runtime?.execCommand?.(cmd, args, timeout) ?? Promise.resolve(usage());
    },
    fetchJson(url, timeout) {
      fetches.push({ url, timeout });
      return options.runtime?.fetchJson?.(url, timeout) ?? Promise.resolve(feed);
    },
    now: options.runtime?.now ?? (() => 1234),
    schedule(delay, action) {
      const callback = () => { timers.delete(callback); action(); };
      timers.set(callback, delay);
      return () => { timers.delete(callback); };
    },
  });
  const cleanup = await plugin.setup(createPluginContext(plugin.manifest.id, client, plugin.manifest.defaults, options.config));
  if (!cleanup) throw new Error("AI Usage did not return cleanup");
  return {
    calls, fetches, fixture, states, replies, timers,
    get snapshot() { return states.at(-1); },
    offline(offline_mode: boolean) {
      fixture.emitTopicUpdate({ topic: "daemon.status", daemon_instance_id: "daemon", topic_instance_id: 1,
        revision: ++statusRevision, source_baseline: false, data: { offline_mode } });
    },
    refresh(call_id: number) { fixture.emitCommandDispatch({ name: command, call_id, args: [] }); },
    fire(delay: number) {
      const timer = [...timers].find(([, ms]) => ms === delay)?.[0];
      if (!timer) throw new Error(`no pending ${delay} ms timer`);
      timer();
    },
    async cleanup() { await cleanup(); client.close(); },
    stop: cleanup,
  };
}

test("manifest resolves an approved command, service and UI entries, and digest", () => {
  const manifest = parsePluginManifest(pluginDir);
  expect(manifest.id).toBe("z-shell/ai-usage");
  expect(manifest.hostCapabilities).toEqual({ commands: ["ai-usagebar"], controlChannel: true });
  expect(manifest.busPermissions).toEqual({ topicsRead: ["daemon.status"], topicsPublish: [topic],
    commandsRegister: [command], inhibitors: false });
  expect(manifest.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "service", kind: "service", entry: "src/zgui-adapter.ts", title: "AI Usage Poller" }),
    expect.objectContaining({ id: "bar-quota", kind: "widget", entry: "src/widget.tsx", title: "AI Usage Bar Quota" }),
    expect.objectContaining({ id: "panel", kind: "panel", entry: "src/panel.tsx", title: "AI Usage Panel" }),
  ]));
  expect(computeContentDigest(pluginDir)).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("polls the CLI and the public feed, publishing normalized quota windows", async () => {
  const app = await mount({ config: { codex_resets_url: feedUrl } });
  try {
    await setImmediate();
    expect(app.calls).toEqual([{ cmd: "ai-usagebar", args: ["usage", "--json"], timeout: 5000 }]);
    expect(app.fetches).toEqual([{ url: feedUrl, timeout: 5000 }]);
    expect(app.snapshot).toEqual({
      quotas: [
        { provider: "openai@work", label: "Session", usedPercent: 24, remainingPercent: 76, resetsAt: null, status: "ready" },
        { provider: "openai@work", label: "Weekly", usedPercent: 100, remainingPercent: 0, resetsAt: resetTime, status: "ready" },
        { provider: "openai@work", label: "Credits", usedPercent: null, remainingPercent: null, resetsAt: null, status: "ready" },
      ],
      codexResets: { latest: null, scheduled: { kind: "regular", announcedAt: null, scheduledFor: resetTime },
        forecastChancePercent: 42, generatedAt: "2030-01-01T00:00:00Z" },
      updatedAt: 1234, stale: false, offlineBlocked: false, lastError: null, backoffMs: 0,
    });
    expect([...app.timers.values()]).toEqual([300_000]);
  } finally { await app.cleanup(); }
});

test("honors offline mode from the initial snapshot and live updates", async () => {
  let cancelled = false;
  let deliver: (value: unknown) => void = () => { throw new Error("fetch did not start"); };
  const app = await mount({ offline: true, config: { codex_resets_url: feedUrl }, runtime: {
    fetchJson() {
      return { promise: new Promise((resolve) => { deliver = resolve; }), cancel() { cancelled = true; } };
    },
  } });
  try {
    await setImmediate();
    expect(app.fetches).toEqual([]);
    expect(app.snapshot).toMatchObject({ offlineBlocked: true, stale: false, codexResets: null,
      quotas: expect.arrayContaining([expect.objectContaining({ remainingPercent: 76 })]) });

    app.offline(false);
    app.refresh(1);
    await setImmediate();
    expect(app.fetches).toHaveLength(1);
    app.offline(true);
    deliver(feed);
    await setImmediate();
    expect(cancelled).toBe(true);
    expect(app.replies.get(1)?.result?.data).toMatchObject({ offlineBlocked: true, stale: false, codexResets: null });
    expect(app.snapshot?.quotas[0]?.remainingPercent).toBe(76);
    app.fire(300_000);
    await setImmediate();
    expect(app.fetches).toHaveLength(1);
  } finally { await app.cleanup(); }
});

test("timeouts and failures retain the last good data, back off, and coalesce manual recovery", async () => {
  let attempts = 0;
  let clock = 100;
  let timedOut = false;
  const app = await mount({ config: { refresh_seconds: 30, timeout_ms: 500 }, runtime: {
    now: () => clock,
    execCommand() {
      switch (++attempts) {
        case 1: return Promise.resolve(usage());
        case 2: return { promise: new Promise(() => {}), cancel() { timedOut = true; } };
        case 3: return Promise.resolve({ status: 1, stdout: "private credential" });
        default: return Promise.resolve(usage(-4));
      }
    },
  } });
  try {
    await setImmediate();
    const good = app.snapshot;
    expect(good?.quotas[0]?.usedPercent).toBe(24);
    clock = 200;
    app.fire(30_000);
    await setImmediate();
    app.fire(500);
    await setImmediate();
    expect(timedOut).toBe(true);
    expect(app.snapshot).toMatchObject({ stale: true, updatedAt: 100, quotas: good?.quotas, backoffMs: 60_000,
      lastError: { source: "command", code: "timeout", message: "ai-usagebar timed out" } });

    app.fire(60_000);
    await setImmediate();
    expect(app.snapshot).toMatchObject({ stale: true, updatedAt: 100, quotas: good?.quotas, backoffMs: 120_000,
      lastError: { source: "command", code: "failed", message: "ai-usagebar request failed" } });

    app.refresh(1);
    app.refresh(2);
    await setImmediate();
    expect(attempts).toBe(4);
    expect(app.replies.get(1)?.result?.data).toEqual(app.snapshot);
    expect(app.replies.get(2)?.result?.data).toEqual(app.snapshot);
    expect(app.snapshot?.quotas[0]?.usedPercent).toBe(0);
    expect(app.snapshot).toMatchObject({ stale: false, lastError: null, backoffMs: 0, updatedAt: 200 });
    expect([...app.timers.values()]).toEqual([30_000]);
  } finally { await app.cleanup(); }
});

test("network failure preserves both sources of the previous good snapshot", async () => {
  let failed = false;
  const app = await mount({ config: { codex_resets_url: feedUrl }, runtime: {
    execCommand: async () => usage(failed ? 99 : 24),
    fetchJson() { return failed ? Promise.reject(new Error(feedUrl)) : Promise.resolve(feed); },
  } });
  try {
    await setImmediate();
    const good = app.snapshot;
    expect(good?.codexResets?.scheduled?.scheduledFor).toBe(resetTime);
    failed = true;
    app.refresh(1);
    await setImmediate();
    expect(app.snapshot).toEqual({ ...good, stale: true, backoffMs: 600_000,
      lastError: { source: "network", code: "failed", message: "Codex Resets request failed" } });
  } finally { await app.cleanup(); }
});

test("cleanup leaves no pending poll, Bus subscription, topic, or refresh handler", async () => {
  const app = await mount();
  try {
    await setImmediate();
    expect([...app.timers.values()]).toEqual([300_000]);
    await app.stop();
    expect([...app.timers.values()]).toEqual([]);
    expect(app.fixture.sentFrames).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: METHODS.TOPIC_UNSUBSCRIBE, params: { topic: "daemon.status" } }),
      expect.objectContaining({ method: METHODS.COMMAND_UNREGISTER, params: { name: command } }),
      expect.objectContaining({ method: METHODS.TOPIC_UNREGISTER, params: { topic } }),
    ]));
    const count = app.states.length;
    app.offline(true);
    app.refresh(1);
    await setImmediate();
    expect(app.replies.get(1)?.error).toContain("no local handler");
    expect(app.calls).toHaveLength(1);
    expect(app.states).toHaveLength(count);
  } finally { await app.cleanup(); }
});
