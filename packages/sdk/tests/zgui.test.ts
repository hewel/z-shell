import { afterEach, describe, expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { createEffect, createSignal, flush } from "@hewel/zgui";
import type { HostServiceError, UnixSocketOptions } from "@hewel/zgui-services";
import type { createRoot as SolidCreateRoot } from "solid-js";
import {
  FixtureTransport,
  METHODS,
  PROTOCOL_VERSION,
  ZShellClient,
  type FixtureOptions,
  type FixtureResponder,
  type MediaRef,
  type TopicRemovedNotification,
  type TopicResetNotification,
  type TopicUpdate,
} from "../src/index.ts";
import { createLinearProgress, createM3Spring, createPresence, createZguiSocketTransport, encodeFileUrlPath, useDaemonMedia, useTopic } from "@z-shell/sdk/zgui";

const solidPath = import.meta.resolve("solid-js", import.meta.resolve("@hewel/zgui"));
if (/\/dist\/server(?:\.[^/]+)?\.js$/.test(solidPath)) {
  // Bun's default Solid build is for SSR and skips effect callbacks. Use the same
  // condition as zgui's native bundler, in isolation from the rest of the suite.
  test("zgui bridge under the reactive Solid build", async () => {
    const child = Bun.spawn([process.execPath, "--conditions=browser", "test", import.meta.path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0) throw new Error(`zgui tests exited ${exit}\n${stdout}${stderr}`);
  });
} else {
  // A static import from this workspace would load a second Solid instance.
  const { createRoot }: { createRoot: typeof SolidCreateRoot } = await import(solidPath);
  const roots = new Set<() => void>();
  const originalServices = Object.getOwnPropertyDescriptor(globalThis, "__zguiServices");

  function mount<T>(setup: () => T) {
    return createRoot((dispose) => {
      const stop = () => {
        if (roots.delete(stop)) dispose();
      };
      roots.add(stop);
      return { state: setup(), dispose: stop };
    });
  }

  afterEach(() => {
    for (const stop of roots) stop();
    if (originalServices) Object.defineProperty(globalThis, "__zguiServices", originalServices);
    else Reflect.deleteProperty(globalThis, "__zguiServices");
  });

  async function settle(): Promise<void> {
    // Fixture replies and hooks settle entirely via microtasks.
    await setImmediate();
    flush();
  }

  async function connectFixture(respond: FixtureResponder, options?: FixtureOptions) {
    const fixture = new FixtureTransport((request) => {
      if (request.method !== METHODS.BUS_HELLO) return respond(request);
      return { result: {
        protocol_version: PROTOCOL_VERSION,
        daemon_version: "fixture",
        daemon_instance_id: "daemon-a",
        client_id: 1,
        role: "privileged_host",
        media_dir: "/tmp/z-shell-media",
      } };
    }, options);
    return { fixture, client: await ZShellClient.connect(fixture) };
  }

  function mockSocket() {
    const sent: string[] = [];
    const connections: { path: string; options: UnixSocketOptions }[] = [];
    let closeCalls = 0;
    Object.defineProperty(globalThis, "__zguiServices", {
      configurable: true,
      value: {
        connectUnixSocket(path: string, options: UnixSocketOptions) {
          connections.push({ path, options });
          return {
            send(line: string) { sent.push(line); },
            close() {
              closeCalls++;
              options.onClose?.(null);
            },
          };
        },
      },
    });
    return { connections, sent, get closeCalls() { return closeCalls; } };
  }

  describe("createZguiSocketTransport", () => {
    test("uses host line framing and strips only one line ending", () => {
      const socket = mockSocket();
      const bus = createZguiSocketTransport("/tmp/bus.sock");
      const connection = socket.connections[0];
      expect(connection?.path).toBe("/tmp/bus.sock");
      expect(connection?.options.framing).toBe("line");
      bus.sendLine('{"a":1}');
      bus.sendLine('{"b":2}\n');
      bus.sendLine('{"c":3}\r\n');
      for (const line of ["a\nb", "a\rb", "a\r", "a\n\n", "a\r\r\n"]) {
        expect(() => bus.sendLine(line)).toThrow(/single line/);
      }
      expect(socket.sent).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);

      const received: string[] = [];
      const off = bus.onLine((line) => received.push(line));
      connection?.options.onMessage('{"reply":1}');
      off();
      connection?.options.onMessage('{"reply":2}');
      expect(received).toEqual(['{"reply":1}']);
      bus.close();
    });

    test("isolates peer-close observers and retires the transport", () => {
      const socket = mockSocket();
      const order: unknown[] = [];
      const bus = createZguiSocketTransport("/tmp/bus.sock", {
        onError(error) {
          order.push(error);
          throw new Error("observer failure");
        },
      });
      bus.onLine((line) => order.push(line));
      bus.onClose(() => { throw new Error("close observer failure"); });
      bus.onClose(() => order.push("closed"));
      const removed = bus.onClose(() => order.push("unsubscribed listener"));
      removed();
      const error: HostServiceError = Object.assign(new Error("peer failed"), { code: "E_SOCKET" });
      const host = socket.connections[0]?.options;
      host?.onClose?.(error);
      host?.onClose?.(error);
      host?.onMessage("late");
      expect(order).toEqual([error, "closed"]);
      expect(() => bus.sendLine("late")).toThrow(/closed/);
      bus.close();
      expect(socket.closeCalls).toBe(0);
    });

    test("explicit close and owner disposal together close the socket once", () => {
      const socket = mockSocket();
      const { state: bus, dispose } = mount(() => createZguiSocketTransport("/tmp/bus.sock"));
      const events: string[] = [];
      bus.onClose(() => events.push("closed"));
      bus.onLine((line) => events.push(line));
      bus.close();
      bus.close();
      dispose();
      socket.connections[0]?.options.onMessage("late");
      expect(socket.closeCalls).toBe(1);
      expect(events).toEqual([]);
      expect(() => bus.sendLine("late")).toThrow(/closed/);
    });
  });

  test("file URLs escape reserved bytes, controls, and Unicode without changing separators", () => {
    expect(encodeFileUrlPath("/tmp//a b/%2F?#\r\n\x00\x7f/犬.png"))
      .toBe("file:///tmp//a%20b/%252F%3F%23%0D%0A%00%7F/%E7%8A%AC.png");
    expect(encodeFileUrlPath("/")).toBe("file:///");
  });

  const topicIds = { daemon_instance_id: "daemon-a", topic_instance_id: 10, topic: "settings" };
  const snapshot = { ...topicIds, revision: 2, data: "snapshot" };
  const topicResponder: FixtureResponder = ({ method }) => {
    if (method === METHODS.TOPIC_SUBSCRIBE) return { result: snapshot };
    if (method === METHODS.TOPIC_UNSUBSCRIBE) return { result: {} };
    throw new Error(`unexpected method ${method}`);
  };

  describe("useTopic", () => {
    test("distinguishes the snapshot, live and baseline updates, reset, and removal", async () => {
      let current = snapshot;
      const { fixture, client } = await connectFixture((req) => req.method === METHODS.TOPIC_SUBSCRIBE
        ? { result: current }
        : topicResponder(req));
      const live: TopicUpdate<string>[] = [];
      const baseline: TopicUpdate<string>[] = [];
      const resets: TopicResetNotification[] = [];
      const removals: TopicRemovedNotification[] = [];
      const [topic, setTopic] = createSignal<string | undefined>(undefined);
      const { state } = mount(() => useTopic(client, topic, {
        initialData: "seed",
        onLiveUpdate: (update) => live.push(update),
        onBaselineUpdate: (update) => baseline.push(update),
        onReset: (event) => resets.push(event),
        onRemoved: (event) => removals.push(event),
      }));
      flush();
      expect(state.status()).toBe("idle");
      expect(state.data()).toBe("seed");
      flush(() => setTopic("settings"));
      expect(state.status()).toBe("loading");
      await settle();
      expect([state.status(), state.data(), state.revision(), state.sourceBaseline()])
        .toEqual(["ready", "snapshot", 2, false]);
      expect([live, baseline]).toEqual([[], []]);

      const base = { ...topicIds, revision: 3, source_baseline: true, data: "baseline" };
      const update = { ...topicIds, revision: 4, source_baseline: false, data: "live" };
      flush(() => fixture.emitTopicUpdate(base));
      expect([state.data(), state.revision(), state.sourceBaseline()]).toEqual(["baseline", 3, true]);
      flush(() => fixture.emitTopicUpdate(update));
      expect([state.data(), state.revision(), state.sourceBaseline()]).toEqual(["live", 4, false]);
      expect([live, baseline]).toEqual([[update], [base]]);

      current = { ...topicIds, revision: 6, data: "resubscribed" };
      const reset = { daemon_instance_id: "daemon-a", reason: "slow consumer", topics: ["settings"] };
      flush(() => fixture.emitTopicReset(reset));
      expect(resets).toEqual([reset]);
      await settle();
      expect([state.status(), state.data(), state.revision()]).toEqual(["ready", "resubscribed", 6]);
      const afterReset = { ...update, revision: 7 };
      flush(() => fixture.emitTopicUpdate(afterReset));
      expect(live).toEqual([update, afterReset]);

      flush(() => fixture.emitTopicRemoved(topicIds));
      expect(removals).toEqual([topicIds]);
      expect([state.status(), state.data()]).toEqual(["removed", "seed"]);
    });

    test("retains the snapshot on removal even when the removal arrives as it settles", async () => {
      const { client, fixture } = await connectFixture(topicResponder);
      const { state } = mount(() => useTopic<string>(client, "settings", { resetOnRemoved: false }));
      flush();
      await Promise.resolve();
      fixture.emitTopicRemoved(topicIds);
      await settle();
      expect([state.status(), state.data(), state.revision()]).toEqual(["removed", "snapshot", 2]);
    });

    test("does not overwrite a live update delivered as the snapshot settles", async () => {
      const { client, fixture } = await connectFixture(topicResponder);
      const { state } = mount(() => useTopic<string>(client, "settings"));
      flush();
      await Promise.resolve(); // The client has installed its listeners; the hook has not applied the snapshot.
      fixture.emitTopicUpdate({ ...topicIds, revision: 3, source_baseline: false, data: "newer" });
      await settle();
      expect([state.data(), state.revision()]).toEqual(["newer", 3]);
    });

    test("unsubscribes an in-flight subscription on late completion after disposal", async () => {
      const { client, fixture } = await connectFixture(topicResponder, { asyncDispatch: true });
      const updates: TopicUpdate<string>[] = [];
      const { dispose } = mount(() => useTopic(client, "settings", {
        onLiveUpdate: (update: TopicUpdate<string>) => updates.push(update),
      }));
      flush();
      expect(fixture.sentFrames.map(({ method }) => method)).toEqual([METHODS.BUS_HELLO, METHODS.TOPIC_SUBSCRIBE]);
      dispose();
      await settle();
      expect(fixture.sentFrames.at(-1)).toMatchObject({ method: METHODS.TOPIC_UNSUBSCRIBE, params: { topic: "settings" } });
      fixture.emitTopicUpdate({ ...topicIds, revision: 3, source_baseline: false, data: "late" });
      expect(updates).toEqual([]);
    });

    test("retires the pending subscription before a replacement subscribes to the same topic", async () => {
      const { client, fixture } = await connectFixture(topicResponder, { asyncDispatch: true });
      const [topic, setTopic] = createSignal<string | null>("settings");
      const { state } = mount(() => useTopic<string>(client, topic));
      flush();
      flush(() => setTopic(null));
      expect(state.status()).toBe("idle");
      flush(() => setTopic("settings"));
      await settle();
      expect(fixture.sentFrames.slice(1).map(({ method }) => method))
        .toEqual([METHODS.TOPIC_SUBSCRIBE, METHODS.TOPIC_UNSUBSCRIBE, METHODS.TOPIC_SUBSCRIBE]);
      expect([state.status(), state.data()]).toEqual(["ready", "snapshot"]);
    });

    test("exposes a rejected subscription and clears it on a new topic", async () => {
      const { client } = await connectFixture((req) => {
        const { params } = req;
        if (typeof params === "object" && params !== null && "topic" in params && params.topic === "missing") {
          return { error: { code: "not_found", message: "unknown topic" } };
        }
        return topicResponder(req);
      });
      const errors: unknown[] = [];
      const [topic, setTopic] = createSignal("missing");
      const { state } = mount(() => useTopic(client, topic, { onError: (error) => errors.push(error) }));
      await settle();
      expect(state.status()).toBe("error");
      expect(errors).toEqual([state.error()]);
      expect(state.error()).toMatchObject({ code: "not_found" });
      flush(() => setTopic("settings"));
      await settle();
      expect([state.status(), state.error()]).toEqual(["ready", undefined]);
    });
  });

  const fetchCommand = "notifications.fetch-blob";
  const runtimeFile = { kind: "runtime_path", path: "/tmp/icon #1.png", mime: "image/png", revision: 1 } as const;
  const blob = { kind: "blob_handle", token: "first", mime: "image/png", byte_len: 3 } as const;

  function mockImages() {
    const registered: Uint8Array[] = [];
    const released: string[] = [];
    Object.defineProperty(globalThis, "__zguiServices", {
      configurable: true,
      value: {
        registerImageBytes(bytes: Uint8Array) {
          registered.push(bytes);
          const src = `zgui-blob://${registered.length}`;
          return { src, release() { released.push(src); } };
        },
      },
    });
    return { registered, released };
  }

  describe("useDaemonMedia", () => {
    test("publishes runtime paths without a host client and refreshes the same path on revision change", () => {
      const [path, setPath] = createSignal<string>(runtimeFile.path);
      const [revision, setRevision] = createSignal(1);
      const observed: (string | undefined)[] = [];
      const { state } = mount(() => {
        const state = useDaemonMedia(null, () => ({ ...runtimeFile, path: path(), revision: revision() }), { fetchCommand });
        createEffect(() => ({ src: state.src() }), ({ src }) => { observed.push(src); });
        return state;
      });
      flush();
      expect([state.src(), state.loading()]).toEqual(["file:///tmp/icon%20%231.png", false]);
      const updatesBeforeRevision = observed.length;
      flush(() => setRevision(2));
      expect(observed.slice(updatesBeforeRevision)).toEqual(["file:///tmp/icon%20%231.png"]);
      flush(() => setPath("/tmp/other.png"));
      expect(state.src()).toBe("file:///tmp/other.png");
    });

    test("fetches blob bytes and releases handles on both swap and disposal", async () => {
      const images = mockImages();
      const { client, fixture } = await connectFixture(() => ({ result: { data: { bytes: [0, 27, 255] } } }));
      const [ref, setRef] = createSignal<MediaRef | null>(blob);
      const { state, dispose } = mount(() => useDaemonMedia(client, ref, { fetchCommand }));
      flush();
      expect(state.loading()).toBe(true);
      await settle();
      expect(fixture.sentFrames.at(-1)).toMatchObject({
        method: METHODS.COMMAND_INVOKE,
        params: { name: fetchCommand, args: [], payload: { token: "first" } },
      });
      expect(images.registered).toEqual([new Uint8Array([0, 27, 255])]);
      expect([state.src(), state.loading(), state.error()]).toEqual(["zgui-blob://1", false, undefined]);

      flush(() => setRef(runtimeFile));
      expect(images.released).toEqual(["zgui-blob://1"]);
      expect(state.src()).toBe("file:///tmp/icon%20%231.png");
      flush(() => setRef(null));
      expect([state.src(), state.loading()]).toEqual([undefined, false]);
      flush(() => setRef({ ...blob, token: "second" }));
      await settle();
      expect(state.src()).toBe("zgui-blob://2");
      dispose();
      expect(images.released).toEqual(["zgui-blob://1", "zgui-blob://2"]);
    });

    test("never registers bytes from a fetch superseded before it resolves", async () => {
      const images = mockImages();
      const { client, fixture } = await connectFixture(({ params }) => {
        if (typeof params !== "object" || params === null || !("payload" in params)) {
          throw new Error("missing payload");
        }
        const { payload } = params;
        if (typeof payload !== "object" || payload === null || !("token" in payload)) {
          throw new Error("missing token");
        }
        return { result: { data: { bytes: payload.token === "first" ? [1, 2, 3] : [4, 5, 6] } } };
      }, { asyncDispatch: true });
      const [ref, setRef] = createSignal<MediaRef>(blob);
      const { state } = mount(() => useDaemonMedia(client, ref, { fetchCommand }));
      flush();
      expect(fixture.sentFrames.at(-1)?.params).toMatchObject({ payload: { token: "first" } });
      flush(() => setRef({ ...blob, token: "second" }));
      await settle();
      expect(images.registered).toEqual([new Uint8Array([4, 5, 6])]);
      expect(state.src()).toBe("zgui-blob://1");
    });

    test("never registers bytes when disposed mid-fetch", async () => {
      const images = mockImages();
      const { client, fixture } = await connectFixture(() => ({ result: { data: { bytes: [1] } } }), { asyncDispatch: true });
      const { dispose } = mount(() => useDaemonMedia(client, blob, { fetchCommand }));
      flush();
      expect(fixture.sentFrames.at(-1)?.method).toBe(METHODS.COMMAND_INVOKE);
      dispose();
      await settle();
      expect(images.registered).toEqual([]);
    });

    test.each([undefined, [], ["2"], [256], [1.5], [-1]].map((bytes) => ({ bytes })))(
      "rejects malformed blob bytes: %j",
      async (data) => {
        const images = mockImages();
        const { client } = await connectFixture(() => ({ result: { data } }));
        const errors: unknown[] = [];
        const { state } = mount(() => useDaemonMedia(client, blob, { fetchCommand, onError: (error) => errors.push(error) }));
        await settle();
        expect([state.src(), state.loading()]).toEqual([undefined, false]);
        expect(errors).toEqual([state.error()]);
        expect(state.error()).toBeInstanceOf(TypeError);
        expect(images.registered).toEqual([]);
      },
    );
  });

  describe("createM3Spring, createPresence & createLinearProgress", () => {
    function withMotionTestHost<T>(fn: (controls: {
      stepFrames: (count: number, dtMs?: number) => void;
      setHostReduced: (next: boolean) => void;
    }) => T): T {
      let clock = 0;
      let nextFrameId = 1;
      let hostReduced = false;
      const reducedListeners = new Set<(value: boolean) => void>();
      const frames = new Map<number, (ts: number) => void>();
      const origRaf = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
      const origCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
      const origPerf = Object.getOwnPropertyDescriptor(globalThis, "performance");
      const origZgui = Object.getOwnPropertyDescriptor(globalThis, "__zgui");
      Object.defineProperty(globalThis, "performance", { value: { now: () => clock }, configurable: true });
      Object.defineProperty(globalThis, "__zgui", {
        value: {
          getReducedMotion: () => hostReduced,
          subscribeReducedMotion: (cb: (value: boolean) => void) => {
            reducedListeners.add(cb);
            return () => { reducedListeners.delete(cb); };
          },
        },
        configurable: true,
      });
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        value: (cb: (ts: number) => void) => {
          const id = nextFrameId++;
          frames.set(id, cb);
          return id;
        },
        configurable: true,
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        value: (id: number) => { frames.delete(id); },
        configurable: true,
      });
      const stepFrames = (count: number, dtMs = 16) => {
        for (let i = 0; i < count; i++) {
          clock += dtMs;
          const batch = [...frames.values()];
          frames.clear();
          for (const cb of batch) cb(clock);
          flush();
        }
      };
      const setHostReduced = (next: boolean) => {
        hostReduced = next;
        for (const cb of reducedListeners) cb(next);
      };
      try {
        return fn({ stepFrames, setHostReduced });
      } finally {
        if (origRaf) Object.defineProperty(globalThis, "requestAnimationFrame", origRaf);
        else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
        if (origCancel) Object.defineProperty(globalThis, "cancelAnimationFrame", origCancel);
        else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
        if (origPerf) Object.defineProperty(globalThis, "performance", origPerf);
        else Reflect.deleteProperty(globalThis, "performance");
        if (origZgui) Object.defineProperty(globalThis, "__zgui", origZgui);
        else Reflect.deleteProperty(globalThis, "__zgui");
      }
    }

    test("createM3Spring delegates physics to @hewel/zgui createSpring with initial, settled, impulse, jump, and reduced-motion spatial snap", () => {
      withMotionTestHost(({ stepFrames }) => {
        const [target, setTarget] = createSignal(1);
        const [scheme, setScheme] = createSignal<"standard" | "expressive" | "reduced">("standard");
        const mountedRoot = mount(() => ({
          spatial: createM3Spring(target, "defaultSpatial", { initial: 0, scheme }),
          effects: createM3Spring(target, "fastEffects", { initial: 0, scheme }),
        }));
        try {
          const { spatial, effects } = mountedRoot.state;
          flush();
          expect(spatial()).toBe(0);
          expect(spatial.settled()).toBe(false);

          stepFrames(2);
          expect(spatial()).toBeGreaterThan(0);
          expect(spatial()).toBeLessThan(1);
          expect(effects()).toBeGreaterThan(0);
          expect(effects()).toBeLessThanOrEqual(1);

          stepFrames(40);
          expect(spatial()).toBe(1);
          expect(spatial.settled()).toBe(true);
          expect(effects()).toBe(1);
          expect(effects.settled()).toBe(true);

          // Velocity impulse kicks away from rest then returns smoothly.
          spatial.impulse(20);
          flush();
          expect(spatial.settled()).toBe(false);
          stepFrames(2);
          expect(spatial()).toBeGreaterThan(1.01);
          stepFrames(40);
          expect(spatial()).toBe(1);
          expect(spatial.settled()).toBe(true);

          // User-configured reduced motion snaps spatial roles immediately while effects roles fade.
          flush(() => setScheme("reduced"));
          flush(() => setTarget(0));
          expect(spatial()).toBe(0);
          expect(spatial.settled()).toBe(true);
          stepFrames(1);
          expect(effects()).toBeGreaterThan(0);
          expect(effects()).toBeLessThan(1);
          stepFrames(25);
          expect(effects()).toBe(0);
          expect(effects.settled()).toBe(true);
        } finally {
          mountedRoot.dispose();
        }
      });
    });

    test("createPresence mounts on show, animates fastEffects exit to unmount, and honors dismissInstant/instantExit", () => {
      withMotionTestHost(({ stepFrames }) => {
        const [visible, setVisible] = createSignal(false);
        const [instant, setInstant] = createSignal(false);
        const mountedRoot = mount(() => createPresence(visible, {
          scheme: () => "standard",
          enterRole: "defaultSpatial",
          exitRole: "fastEffects",
          instantExit: instant,
        }));
        try {
          const { state } = mountedRoot;
          flush();
          expect(state.mounted()).toBe(false);

          // Show mounts immediately and enters toward 1.
          flush(() => setVisible(true));
          expect(state.mounted()).toBe(true);
          stepFrames(40);
          expect(state.opacity()).toBe(1);

          // Programmatic close stays mounted while fastEffects exit runs, then unmounts automatically.
          flush(() => setVisible(false));
          expect(state.mounted()).toBe(true);
          stepFrames(2);
          expect(state.opacity()).toBeLessThan(1);
          expect(state.opacity()).toBeGreaterThan(0);
          stepFrames(20);
          expect(state.mounted()).toBe(false);
          expect(state.opacity()).toBe(0);

          // dismissInstant retires synchronously without waiting for frames.
          flush(() => setVisible(true));
          stepFrames(5);
          flush(() => setVisible(false));
          state.dismissInstant();
          flush();
          expect(state.mounted()).toBe(false);

          // instantExit bypasses exit animation (e.g. ADR-0004 session lock suppression).
          flush(() => setVisible(true));
          stepFrames(5);
          flush(() => {
            setInstant(true);
            setVisible(false);
          });
          expect(state.mounted()).toBe(false);

          // Same-tick dismissInstant + reopen (Wayland grab onDismiss -> adjacent bar island click)
          // must keep the surface mounted and visible.
          flush(() => {
            setInstant(false);
            setVisible(true);
          });
          stepFrames(10);
          state.dismissInstant();
          setVisible(false);
          setVisible(true);
          flush();
          expect(state.mounted()).toBe(true);
          expect(state.opacity()).toBeGreaterThan(0.5);
        } finally {
          mountedRoot.dispose();
        }
      });
    });

    test("createLinearProgress jumps to 1 immediately under reduced motion or zero duration", () => {
      const { state: reduced } = mount(() => createLinearProgress(() => 5000, () => "reduced"));
      flush();
      expect(reduced()).toBe(1);

      const { state: zero } = mount(() => createLinearProgress(() => 0, () => "standard"));
      flush();
      expect(zero()).toBe(1);
    });
  });
}
