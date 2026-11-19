import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FixtureTransport, METHODS, PROTOCOL_VERSION, ZShellClient } from "@z-shell/sdk";
import {
  PLUGIN_API_LEVEL,
  createPluginContext,
  definePlugin,
  formatPluginEntryId,
  isValidPluginId,
  isValidTopicName,
  pluginCommandName,
  pluginTopicName,
} from "../src/index.ts";

describe("@z-shell/plugin-api", () => {
  test("matches Rust shared identifier vectors in schemas/protocol-vectors.json", () => {
    const vectorPath = resolve(import.meta.dir, "../../../schemas/protocol-vectors.json");
    const vectors = JSON.parse(readFileSync(vectorPath, "utf8")) as {
      valid_topics: string[];
      invalid_topics: string[];
      valid_plugin_ids: string[];
      invalid_plugin_ids: string[];
    };

    for (const topic of vectors.valid_topics) {
      expect(isValidTopicName(topic)).toBe(true);
    }
    for (const topic of vectors.invalid_topics) {
      expect(isValidTopicName(topic)).toBe(false);
    }
    for (const pid of vectors.valid_plugin_ids) {
      expect(isValidPluginId(pid)).toBe(true);
    }
    for (const pid of vectors.invalid_plugin_ids) {
      expect(isValidPluginId(pid)).toBe(false);
    }

    expect(formatPluginEntryId("z-shell/ai-usage", "bar-ring")).toBe("z-shell/ai-usage:bar-ring");
    expect(pluginTopicName("z-shell/ai-usage", "quotas")).toBe("plugin.z-shell.ai-usage.quotas");
    expect(pluginCommandName("z-shell/ai-usage", "refresh")).toBe("plugin.z-shell.ai-usage.refresh");
  });

  test("freezes returned PluginDefinition and rejects duplicate entries or bad pluginApi", () => {
    expect(() =>
      definePlugin({
        manifest: {
          id: "z-shell/demo",
          version: "0.1.0",
          pluginApi: PLUGIN_API_LEVEL,
          title: "Demo",
          entries: [
            { name: "dup", kind: "widget", title: "A" },
            { name: "dup", kind: "panel", title: "B" },
          ],
          defaults: {},
        },
        setup() {},
      }),
    ).toThrow(/duplicate entry name/);

    const valid = definePlugin({
      manifest: {
        id: "z-shell/demo",
        version: "0.1.0",
        pluginApi: PLUGIN_API_LEVEL,
        title: "Demo",
        entries: [{ name: "island", kind: "widget", title: "Island" }],
        defaults: { enabled: true },
        hostCapabilities: {
          commands: ["ai-usagebar"],
          imagePrefixes: ["/run/user/1000/z-shell/media"],
        },
        busPermissions: {
          topicsPublish: ["plugin.z-shell.demo.state"],
        },
      },
      setup() {},
    });
    expect(Object.isFrozen(valid)).toBe(true);
    expect(Object.isFrozen(valid.manifest)).toBe(true);
    expect(Object.isFrozen(valid.manifest.entries)).toBe(true);
  });

  test("scopes PluginContext without exposing raw ZShellClient", async () => {
    const fixture = new FixtureTransport((req) => {
      if (req.method === METHODS.BUS_HELLO) {
        return {
          result: {
            protocol_version: PROTOCOL_VERSION,
            daemon_version: "0.1.0",
            daemon_instance_id: "d1",
            client_id: 1,
            role: "public",
            media_dir: "/tmp/media",
          },
        };
      }
      if (req.method === METHODS.TOPIC_REGISTER) {
        return { result: { topic_instance_id: 5, revision: 1 } };
      }
      return { result: { registered: true } };
    });
    const client = await ZShellClient.connect(fixture, "plugin-test");

    const ctx = createPluginContext(
      "z-shell/ai-usage",
      client,
      { refreshSeconds: 300, showCodexResets: true },
      { refreshSeconds: 60 },
      { entryId: "z-shell/ai-usage:island", instanceId: "dp-1-top", outputId: "DP-1" },
    );

    expect("client" in ctx).toBe(false);
    expect(ctx.config).toEqual({ refreshSeconds: 60, showCodexResets: true });
    expect(ctx.instance?.outputId).toBe("DP-1");

    await ctx.registerTopic("quotas", { refreshSeconds: ctx.config.refreshSeconds });
    const regFrame = fixture.sentFrames.find((f) => f.method === METHODS.TOPIC_REGISTER);
    expect(regFrame?.params).toEqual({
      topic: "plugin.z-shell.ai-usage.quotas",
      plugin_id: "z-shell/ai-usage",
      initial: { refreshSeconds: 60 },
    });

    await ctx.registerCommand("refresh", "Refresh quotas", () => ({ message: "ok" }));
    const cmdFrame = fixture.sentFrames.find((f) => f.method === METHODS.COMMAND_REGISTER);
    expect(cmdFrame?.params).toEqual({
      name: "plugin.z-shell.ai-usage.refresh",
      description: "Refresh quotas",
      plugin_id: "z-shell/ai-usage",
    });

    client.close();
  });
});
