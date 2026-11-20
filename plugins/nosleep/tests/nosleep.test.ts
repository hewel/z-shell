import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { computeContentDigest, parsePluginManifest } from "@z-shell/composer";
import { createPluginContext } from "@z-shell/plugin-api";
import { FixtureTransport, ZShellClient, type CommandInvokeResult } from "@z-shell/sdk";

import {
  NOSLEEP_DEFAULTS,
  createNoSleepPlugin,
  type AgentMarker,
  type NoSleepSnapshot,
} from "../src/service.ts";

const PLUGIN_ROOT = resolve(import.meta.dir, "..");

function createBusHarness() {
  const topics = new Map<string, { revision: number; data: unknown }>();
  const commands = new Set<string>();
  const inhibitors = new Map<number, { scope: string; reason: string; owner?: string }>();
  const pendingReplies = new Map<
    number,
    { resolve: (result: CommandInvokeResult) => void; reject: (err: Error) => void }
  >();
  let nextCookie = 1;
  let nextTopicInstance = 1;
  let nextCallId = 1;
  let acquireCount = 0;
  let releaseCount = 0;

  const transport = new FixtureTransport((frame) => {
    switch (frame.method) {
      case "bus.hello":
        return {
          result: {
            protocol_version: 1,
            daemon_version: "0.1.0-test",
            daemon_instance_id: "daemon-test",
            role: "public",
            client_id: 1,
          },
        };
      case "topic.register": {
        const params = frame.params as { topic: string; initial: unknown };
        topics.set(params.topic, { revision: 1, data: params.initial });
        return { result: { topic_instance_id: nextTopicInstance++, revision: 1 } };
      }
      case "topic.publish": {
        const params = frame.params as { topic: string; data: unknown };
        const prev = topics.get(params.topic)?.revision ?? 0;
        const revision = prev + 1;
        topics.set(params.topic, { revision, data: params.data });
        return { result: { revision } };
      }
      case "topic.unregister": {
        const params = frame.params as { topic: string };
        topics.delete(params.topic);
        return { result: {} };
      }
      case "command.register": {
        const params = frame.params as { name: string };
        commands.add(params.name);
        return { result: {} };
      }
      case "command.unregister": {
        const params = frame.params as { name: string };
        commands.delete(params.name);
        return { result: {} };
      }
      case "command.reply": {
        const params = frame.params as {
          call_id: number;
          result?: CommandInvokeResult;
          error?: string;
        };
        const pending = pendingReplies.get(params.call_id);
        if (pending) {
          pendingReplies.delete(params.call_id);
          if (params.error !== undefined) {
            pending.reject(new Error(params.error));
          } else {
            pending.resolve(params.result ?? {});
          }
        }
        return { result: {} };
      }
      case "inhibitor.acquire": {
        const params = frame.params as { scope: string; reason: string; owner?: string };
        const cookie = nextCookie++;
        acquireCount += 1;
        inhibitors.set(cookie, params);
        return { result: { cookie } };
      }
      case "inhibitor.release": {
        const params = frame.params as { cookie: number };
        releaseCount += 1;
        inhibitors.delete(params.cookie);
        return { result: {} };
      }
      default:
        return { error: { code: "method_not_found", message: `unexpected method: ${frame.method}` } };
    }
  });

  function dispatchCommand(
    name: string,
    args: string[] = [],
    payload?: unknown,
  ): Promise<CommandInvokeResult> {
    const call_id = nextCallId++;
    const promise = new Promise<CommandInvokeResult>((resolveReply, rejectReply) => {
      pendingReplies.set(call_id, { resolve: resolveReply, reject: rejectReply });
    });
    transport.emitCommandDispatch({
      call_id,
      name,
      args,
      ...(payload !== undefined ? { payload } : {}),
    });
    return promise;
  }

  return {
    transport,
    topics,
    commands,
    inhibitors,
    dispatchCommand,
    counts: () => ({ acquireCount, releaseCount }),
  };
}

describe("z-shell/nosleep plugin", () => {
  test("plugin.toml passes static manifest validation and deterministic digest", () => {
    const manifest = parsePluginManifest(PLUGIN_ROOT);
    expect(manifest.id).toBe("z-shell/nosleep");
    expect(manifest.busPermissions.inhibitors).toBe(true);
    expect(manifest.busPermissions.topicsPublish).toEqual(["plugin.z-shell.nosleep.state"]);
    expect(manifest.busPermissions.commandsRegister).toEqual([
      "plugin.z-shell.nosleep.toggle",
      "plugin.z-shell.nosleep.status",
    ]);
    expect(manifest.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "service", kind: "service", entry: "src/zgui-adapter.ts", title: "NoSleep Inhibitor Service" }),
      expect.objectContaining({ id: "bar-indicator", kind: "widget", entry: "src/widget.tsx", title: "NoSleep Bar Indicator" }),
      expect.objectContaining({ id: "panel", kind: "panel", entry: "src/panel.tsx", title: "NoSleep Panel" }),
    ]));
    expect(computeContentDigest(PLUGIN_ROOT)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("manual toggle acquires one bus inhibitor cookie and toggles off cleanly", async () => {
    const harness = createBusHarness();
    const client = await ZShellClient.connect(harness.transport);

    const plugin = createNoSleepPlugin();
    const ctx = createPluginContext("z-shell/nosleep", client, NOSLEEP_DEFAULTS);
    const cleanup = await plugin.setup(ctx);
    expect(typeof cleanup).toBe("function");

    expect(harness.inhibitors.size).toBe(0);
    expect(harness.commands.has("plugin.z-shell.nosleep.toggle")).toBe(true);
    expect(harness.commands.has("plugin.z-shell.nosleep.status")).toBe(true);

    const onReply = await harness.dispatchCommand("plugin.z-shell.nosleep.toggle", ["on"]);
    const onState = onReply.data as NoSleepSnapshot;
    expect(onState.active).toBe(true);
    expect(onState.manualActive).toBe(true);
    expect(onState.cookieHeld).toBe(true);
    expect(harness.inhibitors.size).toBe(1);
    expect(harness.counts().acquireCount).toBe(1);

    // Enabling again is idempotent and never leaks a second inhibitor cookie.
    await harness.dispatchCommand("plugin.z-shell.nosleep.toggle", [], { enabled: true });
    expect(harness.inhibitors.size).toBe(1);
    expect(harness.counts().acquireCount).toBe(1);

    const offReply = await harness.dispatchCommand("plugin.z-shell.nosleep.toggle");
    const offState = offReply.data as NoSleepSnapshot;
    expect(offState.active).toBe(false);
    expect(offState.manualActive).toBe(false);
    expect(offState.cookieHeld).toBe(false);
    expect(harness.inhibitors.size).toBe(0);
    expect(harness.counts().releaseCount).toBe(1);

    await cleanup?.();
    expect(harness.topics.has("plugin.z-shell.nosleep.state")).toBe(false);
    expect(harness.commands.size).toBe(0);
  });

  test("combines agent-working detection with manual toggle and cleans up held cookie on teardown", async () => {
    const harness = createBusHarness();
    const client = await ZShellClient.connect(harness.transport);

    let agents: AgentMarker[] = [{ id: "herdr-1", label: "coding-agent" }];
    let scheduledCb: (() => void) | null = null;
    let cancelled = false;

    const plugin = createNoSleepPlugin({
      listActiveAgents: () => agents,
      now: () => 1_700_000_000_000,
      schedule: (_delay, cb) => {
        scheduledCb = cb;
        return () => {
          cancelled = true;
        };
      },
    });
    const ctx = createPluginContext("z-shell/nosleep", client, NOSLEEP_DEFAULTS, {
      agent_working_dir: "/run/user/1000/nosleep-agents/working",
      inhibit_scope: "idle",
    });
    const cleanup = await plugin.setup(ctx);

    // Initial poll saw herdr-1 -> acquired 1 idle inhibitor.
    expect(harness.inhibitors.size).toBe(1);
    const [held] = [...harness.inhibitors.values()];
    expect(held?.scope).toBe("idle");
    expect(held?.reason).toContain("coding-agent");

    // Turn on manual mode too -> still only 1 cookie.
    await harness.dispatchCommand("plugin.z-shell.nosleep.toggle", ["on"]);
    expect(harness.inhibitors.size).toBe(1);

    // Clear agents and run scheduled poll -> manual still holds inhibitor!
    agents = [];
    scheduledCb?.();
    const midStatus = (await harness.dispatchCommand("plugin.z-shell.nosleep.status"))
      .data as NoSleepSnapshot;
    expect(midStatus.activeAgents).toEqual([]);
    expect(midStatus.active).toBe(true);
    expect(midStatus.cookieHeld).toBe(true);
    expect(harness.inhibitors.size).toBe(1);

    // Teardown while active MUST cancel timer and release inhibitor cookie!
    await cleanup?.();
    expect(cancelled).toBe(true);
    expect(harness.inhibitors.size).toBe(0);
    expect(harness.counts().releaseCount).toBe(1);
  });
});
