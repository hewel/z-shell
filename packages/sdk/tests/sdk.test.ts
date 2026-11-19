import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BusRpcError,
  FixtureTransport,
  METHODS,
  PROTOCOL_VERSION,
  ZShellClient,
  parseServerFrame,
  type TopicRemovedNotification,
  type TopicResetNotification,
  type TopicUpdate,
} from "../src/index.ts";
import { connectUnixSocket } from "../src/bun-transport.ts";

describe("@z-shell/sdk (protocol vectors & FixtureTransport)", () => {
  test("validates shared cross-language server frame vectors identically to Rust", () => {
    const vectorPath = resolve(import.meta.dir, "../../../schemas/protocol-vectors.json");
    const vectors = JSON.parse(readFileSync(vectorPath, "utf8")) as {
      valid_server_frames: string[];
      invalid_server_frames: string[];
    };

    for (const line of vectors.valid_server_frames) {
      expect(parseServerFrame(line)).not.toBeNull();
    }
    for (const line of vectors.invalid_server_frames) {
      expect(parseServerFrame(line)).toBeNull();
    }
  });

  test("isolates listener errors, guards monotonic revisions, prevents duplicate command clobber, and handles reset/removed", async () => {
    const reportedErrors: unknown[] = [];
    const fixture = new FixtureTransport(
      (req) => {
        switch (req.method) {
          case METHODS.BUS_HELLO:
            return {
              result: {
                protocol_version: PROTOCOL_VERSION,
                daemon_version: "0.1.0-fixture",
                daemon_instance_id: "d-fixture-1",
                client_id: 42,
                role: "public",
                media_dir: "/tmp/z-shell-media",
              },
            };
          case METHODS.TOPIC_SUBSCRIBE:
            return {
              result: {
                daemon_instance_id: "d-fixture-1",
                topic_instance_id: 10,
                topic: "settings",
                revision: 2,
                data: { general: { offline_mode: false } },
              },
            };
          case METHODS.TOPIC_UNSUBSCRIBE:
            return { result: { unsubscribed: "settings" } };
          case METHODS.COMMAND_REGISTER:
            return { result: { registered: true } };
          case METHODS.COMMAND_REPLY:
            return { result: { accepted: true } };
          case METHODS.COMMAND_UNREGISTER:
            return { result: { unregistered: "plugin.demo.ping" } };
          default:
            return { error: { code: "method_not_found", message: `unknown ${req.method}` } };
        }
      },
      { asyncDispatch: true },
    );

    const client = await ZShellClient.connect(fixture, "fixture-test", {
      onError: (err) => reportedErrors.push(err),
    });
    expect(client.helloInfo?.daemon_instance_id).toBe("d-fixture-1");
    expect(client.helloInfo?.role).toBe("public");

    const received: TopicUpdate[] = [];
    const resets: TopicResetNotification[] = [];
    const removed: TopicRemovedNotification[] = [];

    // First listener throws; sibling listener must still receive every valid monotonic update.
    await client.subscribe("settings", {
      onUpdate: () => {
        throw new Error("boom in listener 1");
      },
    });
    await client.subscribe("settings", {
      onUpdate: (u) => received.push(u),
      onReset: (r) => resets.push(r),
      onRemoved: (rm) => removed.push(rm),
    });

    // Stale revision <= 2 must be ignored defensively.
    fixture.emitTopicUpdate({
      daemon_instance_id: "d-fixture-1",
      topic_instance_id: 10,
      topic: "settings",
      revision: 2,
      source_baseline: false,
      data: { stale: true },
    });
    expect(received).toHaveLength(0);

    // Valid revision 3 delivers to sibling listener even though listener 1 threw.
    fixture.emitTopicUpdate({
      daemon_instance_id: "d-fixture-1",
      topic_instance_id: 10,
      topic: "settings",
      revision: 3,
      source_baseline: false,
      data: { general: { offline_mode: true } },
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.revision).toBe(3);
    expect(reportedErrors).toHaveLength(1);

    // Duplicate local command registration rejects locally without overwriting active handler.
    const unregister = await client.registerCommand(
      "plugin.demo.ping",
      "Ping test",
      ({ args }) => ({ message: `pong:${args.join(",")}` }),
    );
    await expect(
      client.registerCommand("plugin.demo.ping", "Duplicate", () => ({ message: "clobbered" })),
    ).rejects.toThrow(/already registered/);

    fixture.emitCommandDispatch({
      call_id: 99,
      name: "plugin.demo.ping",
      args: ["a", "b"],
    });
    await Bun.sleep(10);

    const replyFrame = fixture.sentFrames.find((f) => f.method === METHODS.COMMAND_REPLY);
    expect(replyFrame?.params).toEqual({
      call_id: 99,
      result: { message: "pong:a,b" },
    });

    // Topic reset notifies subscriber cleanly.
    fixture.emitTopicReset({
      daemon_instance_id: "d-fixture-1",
      reason: "slow consumer",
      topics: ["settings"],
    });
    expect(resets).toHaveLength(1);
    expect(removed).toHaveLength(0);

    await unregister();
    await expect(client.request("nonexistent.method")).rejects.toBeInstanceOf(BusRpcError);

    // Abrupt disconnect rejects pending requests cleanly.
    const pendingBeforeDrop = client.request("slow.call");
    fixture.simulateDisconnect();
    await expect(pendingBeforeDrop).rejects.toThrow(/closed/);
  });
});

describe("@z-shell/sdk (Live z-shelld dual-socket UDS + z-shell CLI)", () => {
  test("interoperates end-to-end with Rust z-shelld public/host sockets and hardened z-shell CLI", async () => {
    const repoRoot = resolve(import.meta.dir, "../../..");
    const tempDir = mkdtempSync(join(tmpdir(), "z-shell-e2e-"));
    const publicSocket = join(tempDir, "runtime", "bus.sock");
    const hostSocket = join(tempDir, "runtime", "host.sock");

    const build = Bun.spawnSync(["cargo", "build", "--bins"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(build.exitCode).toBe(0);

    const meta = Bun.spawnSync(["cargo", "metadata", "--format-version", "1", "--no-deps"], {
      cwd: repoRoot,
      stdout: "pipe",
    });
    const targetDir = (JSON.parse(meta.stdout.toString()) as { target_directory: string })
      .target_directory;
    const daemonBin = join(targetDir, "debug", "z-shelld");
    const cliBin = join(targetDir, "debug", "z-shell");

    // Verify CLI parses usage errors BEFORE connecting (exit code 2 even with non-existent socket).
    const badUsage = Bun.spawn([cliBin, "--socket", "/nonexistent.sock", "msg"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await badUsage.exited).toBe(2);

    const daemon = Bun.spawn(
      [
        daemonBin,
        "--config-dir",
        join(tempDir, "config"),
        "--state-dir",
        join(tempDir, "state"),
        "--runtime-dir",
        join(tempDir, "runtime"),
        "--socket",
        publicSocket,
        "--host-socket",
        hostSocket,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await Bun.file(publicSocket).exists()) && (await Bun.file(hostSocket).exists())) break;
        await Bun.sleep(20);
      }

      const publicTransport = await connectUnixSocket(publicSocket);
      const publicClient = await ZShellClient.connect(publicTransport, "ts-e2e-public");
      expect(publicClient.helloInfo?.role).toBe("public");

      // Register plugin command under `plugin.*` namespace and invoke via Rust `z-shell msg`.
      await publicClient.registerCommand(
        "plugin.ts-smoke.echo",
        "Echo args from TS SDK",
        ({ args }) => ({
          message: `ts-echo:${args.join(" ")}`,
          data: { count: args.length },
        }),
        "z-shell/ts-smoke",
      );

      const cli = Bun.spawn(
        [
          cliBin,
          "--socket",
          publicSocket,
          "msg",
          "plugin.ts-smoke.echo",
          "--",
          "hello",
          "--wayland",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await cli.exited).toBe(0);
      expect((await new Response(cli.stdout).text()).trim()).toBe("ts-echo:hello --wayland");

      // Public client cannot call `quit` (permission_denied).
      await expect(publicClient.invokeCommand("quit")).rejects.toMatchObject({
        code: "permission_denied",
      });

      // Privileged host channel CAN shut down cleanly via CLI --socket <hostSocket>.
      const quitCli = Bun.spawn([cliBin, "--socket", hostSocket, "msg", "quit"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await quitCli.exited).toBe(0);
      expect((await new Response(quitCli.stdout).text()).trim()).toBe("shutting down");

      publicClient.close();
      expect(await daemon.exited).toBe(0);
    } finally {
      daemon.kill();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
