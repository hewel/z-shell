import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { parsePluginManifest } from "@z-shell/composer";
import { createPluginContext } from "@z-shell/plugin-api";
import { FixtureTransport, METHODS, PROTOCOL_VERSION, ZShellClient } from "@z-shell/sdk";
import {
  computeOverviewLayouts, createNiriOverviewPlugin, createNiriSocketTransport,
  type NiriEvent, type NiriOverviewConfig, type NiriOverviewSnapshot, type NiriSocketTransport,
} from "../src/service.ts";

const topic = "plugin.z-shell.niri-overview.state";
const prefix = "plugin.z-shell.niri-overview.";
const initial = {
  outputs: [{ name: "eDP-1", width: 800, height: 600 }, { name: "DP-1", width: 1000, height: 800 }],
  workspaces: [
    { id: 2, index: 2, output: "DP-1", active: false, focused: false },
    { id: 3, index: 1, output: "eDP-1", active: true, focused: false },
    { id: 1, index: 1, output: "DP-1", active: true, focused: true },
  ],
  windows: [
    { id: 20, workspaceId: 1, floating: true, focused: true, geometry: { x: -100, y: 200, width: 400, height: 400 } },
    { id: 10, workspaceId: 1, floating: false, focused: false, geometry: { x: 200, y: 0, width: 500, height: 800 } },
  ],
};

type Session = { readonly event: (event: NiriEvent) => void; readonly disconnect: () => void; closed: boolean };

function compositor(snapshot: NiriSocketTransport["requestSnapshot"] = async () => initial) {
  const sessions: Session[] = [];
  let available = true;
  let snapshots = 0;
  const transport: NiriSocketTransport = {
    isAvailable: () => available,
    requestSnapshot() { snapshots++; return snapshot(); },
    subscribeEvents(event, disconnect) {
      const session = { event, disconnect, closed: false };
      sessions.push(session);
      return () => { session.closed = true; };
    },
  };
  return { transport, sessions, get snapshots() { return snapshots; }, setAvailable(value: boolean) { available = value; } };
}

async function mount(transport: NiriSocketTransport, overrides?: Partial<NiriOverviewConfig>) {
  const states: NiriOverviewSnapshot[] = [];
  const replies = new Map<number, { result?: { data: NiriOverviewSnapshot }; error?: string }>();
  const retries = new Set<() => void>();
  const fixture = new FixtureTransport((frame) => {
    switch (frame.method) {
      case METHODS.BUS_HELLO:
        return { result: { protocol_version: PROTOCOL_VERSION, daemon_version: "0.1.0",
          daemon_instance_id: "daemon", client_id: 1, role: "public", media_dir: "/tmp/media" } };
      case METHODS.TOPIC_SUBSCRIBE:
        return { result: { daemon_instance_id: "daemon", topic_instance_id: 1, revision: 1,
          topic: "wayland.outputs", data: { capability: "readable", outputs: [] } } };
      case METHODS.TOPIC_REGISTER: {
        const params = frame.params as { topic: string; initial: NiriOverviewSnapshot };
        if (params.topic === topic) states.push(params.initial);
        return { result: { topic_instance_id: 2, revision: states.length } };
      }
      case METHODS.TOPIC_PUBLISH: {
        const params = frame.params as { topic: string; data: NiriOverviewSnapshot };
        if (params.topic === topic) states.push(params.data);
        return { result: { revision: states.length } };
      }
      case METHODS.COMMAND_REPLY: {
        const params = frame.params as { call_id: number; result?: { data: NiriOverviewSnapshot }; error?: string };
        replies.set(params.call_id, params);
        break;
      }
    }
    return { result: {} };
  });
  const client = await ZShellClient.connect(fixture, "niri-overview-test");
  const plugin = createNiriOverviewPlugin(transport, (_, cb) => {
    const callback = () => { retries.delete(callback); cb(); };
    retries.add(callback);
    return () => { retries.delete(callback); };
  });
  const stop = await plugin.setup(createPluginContext(plugin.manifest.id, client, plugin.manifest.defaults, overrides));
  if (!stop) throw new Error("Niri Overview did not return cleanup");
  return {
    fixture, states, replies, retries, stop,
    get snapshot() { return states.at(-1); },
    dispatch(kind: "refresh" | "toggle", call_id: number, payload?: unknown) {
      fixture.emitCommandDispatch({ name: prefix + kind, call_id, args: [], payload });
    },
    retry() {
      const pending = retries.values().next().value;
      if (!pending) throw new Error("no Niri retry scheduled");
      pending();
    },
    async cleanup() { await stop(); client.close(); },
  };
}

test("manifest requests shell surfaces and only the overview Bus operations", () => {
  const manifest = parsePluginManifest(`${import.meta.dir}/..`);
  expect(manifest.id).toBe("z-shell/niri-overview");
  expect(manifest.hostCapabilities).toEqual({ shellSurfaces: true, controlChannel: true });
  expect(manifest.busPermissions).toEqual({ topicsRead: [],
    topicsPublish: [topic], commandsRegister: [prefix + "toggle", prefix + "refresh"], inhibitors: false });
  expect(manifest.entries[0]).toMatchObject({ kind: "service", entry: "src/service.ts", title: "Niri Overview Coordinator" });
});

test("unsupported environments publish empty state without attempting Niri IPC", async () => {
  const niri = compositor();
  niri.setAvailable(false);
  const app = await mount(niri.transport);
  try {
    await setImmediate();
    expect(app.snapshot).toEqual({ capability: "unsupported", resetting: false, open: false, outputs: [], layouts: [] });
    expect(niri.sessions).toEqual([]);
    expect(niri.snapshots).toBe(0);
    expect(app.retries.size).toBe(0);
  } finally { await app.cleanup(); }
});

test("backfills multi-output layout, applies ordered Niri events and clips floating windows", async () => {
  const { promise, resolve } = Promise.withResolvers<typeof initial>();
  const niri = compositor(() => promise);
  const app = await mount(niri.transport);
  try {
    await setImmediate();
    const session = niri.sessions[0]!;
    session.event({ type: "WindowFocusChanged", id: 10 });
    expect(app.snapshot?.capability).toBe("disconnected");
    resolve(initial);
    await setImmediate();
    expect(app.snapshot).toMatchObject({ capability: "available", resetting: false,
      outputs: [{ name: "DP-1" }, { name: "eDP-1" }] });
    const layouts = app.snapshot?.layouts;
    expect(layouts?.map(({ output, workspaceId, active, x, y, width, height }) => [output, workspaceId, active, x, y, width, height]))
      .toEqual([["DP-1", 1, true, 0.25, 0.125, 0.5, 0.25], ["DP-1", 2, false, 0.25, 0.625, 0.5, 0.25],
        ["eDP-1", 3, true, 0.25, 0.25, 0.5, 0.5]]);
    expect(layouts?.[0]?.windows).toEqual([
      { id: 10, floating: false, focused: true, x: 0.35, y: 0.125, width: 0.24999999999999997, height: 0.25 },
      { id: 20, floating: true, focused: false, x: 0.25, y: 0.1875, width: 0.15, height: 0.125 },
    ]);

    session.event({ type: "WorkspaceActivated", id: 2, focused: true });
    session.event({ type: "WindowClosed", id: 20 });
    session.event({ type: "WindowOpenedOrChanged", window: { id: 11, workspaceId: 2, floating: false, focused: true,
      geometry: { x: 0, y: 0, width: 1000, height: 800 } } });
    session.event({ type: "WindowLayoutsChanged", changes: new Map([[11, { x: 0, y: 400, width: 1000, height: 400 }]]) });
    await setImmediate();
    expect(app.snapshot?.layouts.map(({ active, focused }) => [active, focused])).toEqual([[false, false], [true, true], [true, false]]);
    expect(app.snapshot?.layouts[0]?.windows.map(({ id, focused }) => [id, focused])).toEqual([[10, false]]);
    expect(app.snapshot?.layouts[1]?.windows).toEqual([
      { id: 11, floating: false, focused: true, x: 0.25, y: 0.75, width: 0.5, height: 0.125 },
    ]);
    const zoomed = computeOverviewLayouts(initial.outputs, initial.workspaces, initial.windows, 1);
    expect(zoomed[1]).toMatchObject({ x: 0, y: 0.5, width: 1, height: 0.5 });
  } finally { await app.cleanup(); }
});

test("overflow and socket loss retire the old generation and recover from a new backfill", async () => {
  const oldBaseline = Promise.withResolvers<typeof initial>();
  const fresh = { ...initial, windows: [initial.windows[0]!] };
  let attempts = 0;
  const niri = compositor(() => ++attempts === 1 ? oldBaseline.promise : Promise.resolve(fresh));
  const app = await mount(niri.transport, { max_queue_depth: 8 });
  try {
    await setImmediate();
    const first = niri.sessions[0]!;
    for (let i = 0; i < 8; i++) first.event({ type: "WindowClosed", id: 20 });
    expect(first.closed).toBe(false);
    first.event({ type: "WindowClosed", id: 20 });
    expect(first.closed).toBe(true);
    expect(app.snapshot).toMatchObject({ capability: "disconnected", resetting: true, layouts: [] });
    expect(app.retries.size).toBe(1);
    app.retry();
    await setImmediate();
    expect(app.snapshot?.layouts[0]?.windows.map(({ id }) => id)).toEqual([20]);
    oldBaseline.resolve(initial);
    first.event({ type: "WindowClosed", id: 20 });
    await setImmediate();
    expect(app.snapshot?.layouts[0]?.windows.map(({ id }) => id)).toEqual([20]);

    const second = niri.sessions[1]!;
    niri.setAvailable(false);
    second.disconnect();
    expect(second.closed).toBe(true);
    expect(app.snapshot).toMatchObject({ capability: "disconnected", resetting: true, outputs: [], layouts: [] });
    app.retry();
    await setImmediate();
    expect(app.snapshot?.capability).toBe("disconnected");
    niri.setAvailable(true);
    app.retry();
    await setImmediate();
    expect(niri.snapshots).toBe(3);
    expect(app.snapshot).toMatchObject({ capability: "available", resetting: false });
    expect(app.snapshot?.layouts[0]?.windows.map(({ id }) => id)).toEqual([20]);
  } finally { await app.cleanup(); }
});

test("toggle and refresh answer on the Bus and cleanup retires the stream, commands and topic", async () => {
  let current = initial;
  const niri = compositor(async () => current);
  const app = await mount(niri.transport);
  try {
    await setImmediate();
    app.dispatch("toggle", 1);
    await setImmediate();
    expect(app.replies.get(1)?.result?.data.open).toBe(true);
    app.dispatch("toggle", 2, { open: false });
    await setImmediate();
    expect(app.replies.get(2)?.result?.data.open).toBe(false);
    expect(app.snapshot?.open).toBe(false);

    current = { ...initial, windows: [] };
    app.dispatch("refresh", 3);
    await setImmediate();
    expect(app.replies.get(3)?.result?.data).toEqual(app.snapshot);
    expect(app.snapshot?.layouts[0]?.windows).toEqual([]);
    expect(niri.sessions[0]?.closed).toBe(true);
    const active = niri.sessions[1]!;
    await app.stop();
    expect(active.closed).toBe(true);
    const count = app.states.length;
    active.disconnect();
    active.event({ type: "WindowsChanged", windows: initial.windows });
    await setImmediate();
    expect(app.retries.size).toBe(0);
    expect(app.states).toHaveLength(count);
    expect(app.fixture.sentFrames).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: METHODS.TOPIC_UNSUBSCRIBE, params: { topic: "wayland.outputs" } }),
      expect.objectContaining({ method: METHODS.TOPIC_UNREGISTER, params: { topic } }),
      expect.objectContaining({ method: METHODS.COMMAND_UNREGISTER, params: { name: prefix + "toggle" } }),
      expect.objectContaining({ method: METHODS.COMMAND_UNREGISTER, params: { name: prefix + "refresh" } }),
    ]));
  } finally { await app.cleanup(); }
});

test("native transport backfills on one Niri socket and decodes live IPC frames", async () => {
  const requests: unknown[] = [];
  let closeCount = 0;
  const path = "/run/user/1234/niri-fixture.sock";
  let receive = (_: string) => { throw new Error("socket was not connected"); };
  const socket = createNiriSocketTransport(path, {
    connectUnixSocket(socketPath, options) {
      expect(socketPath).toBe(path);
      expect(options.framing).toBe("line");
      receive = options.onMessage;
      return { send(line) { requests.push(JSON.parse(line)); }, close() { closeCount++; } };
    },
  });
  const app = await mount(socket);
  try {
    await setImmediate();
    expect(requests).toEqual(["Outputs", "Workspaces", "Windows", "EventStream"]);
    for (const frame of [
      { Ok: { Outputs: { "DP-1": { logical: { width: 1000, height: 800 } } } } },
      { Ok: { Workspaces: [{ id: 1, idx: 1, output: "DP-1", is_active: true }] } },
      { Ok: { Windows: [{ id: 2, workspace_id: 1, is_focused: true,
        layout: { tile_pos_in_workspace_view: [0, 0], tile_size: [500, 800] } }] } },
      { Ok: "Handled" },
    ]) receive(JSON.stringify(frame));
    await setImmediate();
    expect(app.snapshot?.layouts[0]?.windows[0]).toMatchObject({ id: 2, focused: true, width: 0.25 });
    receive(JSON.stringify({ WindowClosed: { id: 2 } }));
    await setImmediate();
    expect(app.snapshot?.layouts[0]?.windows).toEqual([]);
  } finally { await app.cleanup(); }
  expect(closeCount).toBe(1);
});
