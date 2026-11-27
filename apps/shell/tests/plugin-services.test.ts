import { describe, expect, test } from "bun:test";
import { definePlugin, PLUGIN_API_LEVEL } from "@z-shell/plugin-api";
import type { ZShellClient } from "@z-shell/sdk";
import type { ComposedServiceDescriptor } from "../src/plugins/composed.ts";
import { createComposedServiceController, startComposedPluginServices } from "../src/plugins/services.ts";

function makeServiceDescriptor(pluginId: string, importKey: string, settings: Record<string, unknown> = {}): ComposedServiceDescriptor {
  return {
    pluginId,
    id: "service",
    entryId: `${pluginId}:service`,
    kind: "service",
    entry: "src/service.ts",
    settings: {},
    pluginSettings: settings,
    importKey,
  };
}

describe("startComposedPluginServices", () => {
  test("starts all composed services, isolates failures, and invokes cleanups synchronously on dispose", async () => {
    const events: string[] = [];
    const errors: Array<{ entryId: string; message: string }> = [];
    let deferredResolve!: (cleanup: () => void) => void;

    const syncPlugin = definePlugin({
      manifest: {
        id: "z-shell/sync",
        version: "0.1.0",
        pluginApi: PLUGIN_API_LEVEL,
        title: "Sync",
        entries: [{ name: "service", kind: "service", title: "Sync" }],
        defaults: { threshold: 10 },
      },
      setup(ctx) {
        events.push(`setup:sync:${ctx.config.threshold}`);
        return () => {
          events.push("cleanup:sync");
        };
      },
    });

    const failingPlugin = definePlugin({
      manifest: {
        id: "z-shell/failing",
        version: "0.1.0",
        pluginApi: PLUGIN_API_LEVEL,
        title: "Failing",
        entries: [{ name: "service", kind: "service", title: "Failing" }],
        defaults: {},
      },
      setup() {
        throw new Error("boom");
      },
    });

    const deferredPlugin = definePlugin({
      manifest: {
        id: "z-shell/deferred",
        version: "0.1.0",
        pluginApi: PLUGIN_API_LEVEL,
        title: "Deferred",
        entries: [{ name: "service", kind: "service", title: "Deferred" }],
        defaults: {},
      },
      setup() {
        events.push("setup:deferred");
        return new Promise<() => void>(resolve => {
          deferredResolve = resolve;
        });
      },
    });

    const dispose = startComposedPluginServices(
      {
        entryImports: {
          "z-shell/sync:service": { default: syncPlugin },
          "z-shell/failing:service": { default: failingPlugin },
          "z-shell/deferred:service": { default: deferredPlugin },
        },
        services: [
          makeServiceDescriptor("z-shell/sync", "z-shell/sync:service", { threshold: 42 }),
          makeServiceDescriptor("z-shell/failing", "z-shell/failing:service"),
          makeServiceDescriptor("z-shell/deferred", "z-shell/deferred:service"),
        ],
      },
      {} as ZShellClient,
      (service, error) => {
        errors.push({
          entryId: service.entryId,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );

    expect(events).toEqual(["setup:sync:42", "setup:deferred"]);
    expect(errors).toEqual([{ entryId: "z-shell/failing:service", message: "boom" }]);

    // Synchronous teardown runs already-registered cleanups immediately.
    dispose();
    expect(events).toEqual(["setup:sync:42", "setup:deferred", "cleanup:sync"]);

    // Cleanups from in-flight setup promises that resolve after disposal are retired immediately.
    deferredResolve(() => {
      events.push("cleanup:deferred");
    });
    await Promise.resolve();
    expect(events).toEqual(["setup:sync:42", "setup:deferred", "cleanup:sync", "cleanup:deferred"]);
  });

  test("restartPlugin tears down and restarts only the targeted plugin with updated settings overrides", () => {
    const events: string[] = [];

    const alphaPlugin = definePlugin({
      manifest: {
        id: "z-shell/alpha",
        version: "0.1.0",
        pluginApi: PLUGIN_API_LEVEL,
        title: "Alpha",
        entries: [{ name: "service", kind: "service", title: "Alpha" }],
        defaults: { poll: 1000 },
      },
      setup(ctx) {
        events.push(`setup:alpha:${ctx.config.poll}`);
        return () => {
          events.push(`cleanup:alpha:${ctx.config.poll}`);
        };
      },
    });

    const betaPlugin = definePlugin({
      manifest: {
        id: "z-shell/beta",
        version: "0.1.0",
        pluginApi: PLUGIN_API_LEVEL,
        title: "Beta",
        entries: [{ name: "service", kind: "service", title: "Beta" }],
        defaults: { enabled: true },
      },
      setup(ctx) {
        events.push(`setup:beta:${ctx.config.enabled}`);
        return () => {
          events.push("cleanup:beta");
        };
      },
    });

    const controller = createComposedServiceController(
      {
        entryImports: {
          "z-shell/alpha:service": { default: alphaPlugin },
          "z-shell/beta:service": { default: betaPlugin },
        },
        services: [
          makeServiceDescriptor("z-shell/alpha", "z-shell/alpha:service", { poll: 2000 }),
          makeServiceDescriptor("z-shell/beta", "z-shell/beta:service", { enabled: true }),
        ],
      },
      {} as ZShellClient,
    );

    expect(events).toEqual(["setup:alpha:2000", "setup:beta:true"]);

    controller.restartPlugin("z-shell/alpha", { poll: 5000 });
    expect(events).toEqual([
      "setup:alpha:2000",
      "setup:beta:true",
      "cleanup:alpha:2000",
      "setup:alpha:5000",
    ]);

    controller.dispose();
    expect(events).toEqual([
      "setup:alpha:2000",
      "setup:beta:true",
      "cleanup:alpha:2000",
      "setup:alpha:5000",
      "cleanup:alpha:5000",
      "cleanup:beta",
    ]);
  });

  test("forwards async setup and async cleanup promise rejections to onError without breaking sibling services", async () => {
    const events: string[] = [];
    const errors: Array<{ entryId: string; message: string }> = [];

    const asyncSetupFail = definePlugin({
      manifest: {
        id: "z-shell/async-setup-fail",
        version: "0.1.0",
        pluginApi: PLUGIN_API_LEVEL,
        title: "AsyncSetupFail",
        entries: [{ name: "service", kind: "service", title: "AsyncSetupFail" }],
        defaults: {},
      },
      setup() {
        return Promise.reject(new Error("async setup failed"));
      },
    });

    const asyncCleanupFail = definePlugin({
      manifest: {
        id: "z-shell/async-cleanup-fail",
        version: "0.1.0",
        pluginApi: PLUGIN_API_LEVEL,
        title: "AsyncCleanupFail",
        entries: [{ name: "service", kind: "service", title: "AsyncCleanupFail" }],
        defaults: { rev: 1 },
      },
      setup(ctx) {
        events.push(`setup:${ctx.config.rev}`);
        return () => Promise.reject(new Error(`async cleanup failed ${ctx.config.rev}`));
      },
    });

    const healthySibling = definePlugin({
      manifest: {
        id: "z-shell/healthy",
        version: "0.1.0",
        pluginApi: PLUGIN_API_LEVEL,
        title: "Healthy",
        entries: [{ name: "service", kind: "service", title: "Healthy" }],
        defaults: {},
      },
      setup() {
        events.push("setup:healthy");
        return () => {
          events.push("cleanup:healthy");
        };
      },
    });

    const controller = createComposedServiceController(
      {
        entryImports: {
          "z-shell/async-setup-fail:service": { default: asyncSetupFail },
          "z-shell/async-cleanup-fail:service": { default: asyncCleanupFail },
          "z-shell/healthy:service": { default: healthySibling },
        },
        services: [
          makeServiceDescriptor("z-shell/async-setup-fail", "z-shell/async-setup-fail:service"),
          makeServiceDescriptor("z-shell/async-cleanup-fail", "z-shell/async-cleanup-fail:service", { rev: 1 }),
          makeServiceDescriptor("z-shell/healthy", "z-shell/healthy:service"),
        ],
      },
      {} as ZShellClient,
      (service, error) => {
        errors.push({
          entryId: service.entryId,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );

    await Promise.resolve();
    expect(errors).toEqual([{ entryId: "z-shell/async-setup-fail:service", message: "async setup failed" }]);

    controller.restartPlugin("z-shell/async-cleanup-fail", { rev: 2 });
    await Promise.resolve();
    expect(errors).toEqual([
      { entryId: "z-shell/async-setup-fail:service", message: "async setup failed" },
      { entryId: "z-shell/async-cleanup-fail:service", message: "async cleanup failed 1" },
    ]);

    controller.dispose();
    await Promise.resolve();
    expect(events).toEqual(["setup:1", "setup:healthy", "setup:2", "cleanup:healthy"]);
    expect(errors).toEqual([
      { entryId: "z-shell/async-setup-fail:service", message: "async setup failed" },
      { entryId: "z-shell/async-cleanup-fail:service", message: "async cleanup failed 1" },
      { entryId: "z-shell/async-cleanup-fail:service", message: "async cleanup failed 2" },
    ]);
  });
});
