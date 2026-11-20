import { createPluginContext, type PluginCleanup, type PluginDefinition } from "@z-shell/plugin-api";
import type { ZShellClient } from "@z-shell/sdk";
import type { ComposedServiceDescriptor } from "./composed.ts";

export interface ComposedServiceBundle {
  readonly entryImports: Readonly<Record<string, Record<string, unknown>>>;
  readonly services: readonly ComposedServiceDescriptor[];
}

export type PluginServiceErrorHandler = (
  service: ComposedServiceDescriptor,
  error: unknown,
) => void;

/**
 * Starts all composed plugin service entries against the active public bus client and returns a
 * synchronous teardown callback. Each service runs in isolation so a bad plugin never blocks
 * peer services or shell surfaces, and cleanups that resolve after disposal are retired immediately.
 */
export function startComposedPluginServices(
  bundle: ComposedServiceBundle,
  client: ZShellClient,
  onError?: PluginServiceErrorHandler,
): () => void {
  let disposed = false;
  const activeCleanups: Array<{
    readonly service: ComposedServiceDescriptor;
    readonly cleanup: PluginCleanup;
  }> = [];

  function invokeCleanup(service: ComposedServiceDescriptor, cleanup: PluginCleanup): void {
    try {
      const pending = cleanup();
      if (pending && typeof (pending as PromiseLike<void>).then === "function") {
        void Promise.resolve(pending).catch(() => undefined);
      }
    } catch (error) {
      onError?.(service, error);
    }
  }

  for (const service of bundle.services) {
    try {
      const definition = bundle.entryImports[service.importKey]?.default as PluginDefinition | undefined;
      if (!definition || typeof definition.setup !== "function") {
        throw new Error(`Plugin service entry ${service.entryId} must default-export a PluginDefinition`);
      }
      const defaults = definition.manifest?.defaults ?? {};
      const overrides = { ...service.pluginSettings, ...service.settings };
      const ctx = createPluginContext(service.pluginId, client, defaults, overrides);
      const result = definition.setup(ctx);
      if (typeof result === "function") {
        if (disposed) {
          invokeCleanup(service, result);
        } else {
          activeCleanups.push({ service, cleanup: result });
        }
      } else if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).then(
          cleanup => {
            if (typeof cleanup !== "function") return;
            if (disposed) {
              invokeCleanup(service, cleanup);
            } else {
              activeCleanups.push({ service, cleanup });
            }
          },
          error => {
            if (!disposed) onError?.(service, error);
          },
        );
      }
    } catch (error) {
      onError?.(service, error);
    }
  }

  return () => {
    if (disposed) return;
    disposed = true;
    for (let index = activeCleanups.length - 1; index >= 0; index -= 1) {
      const entry = activeCleanups[index]!;
      invokeCleanup(entry.service, entry.cleanup);
    }
    activeCleanups.length = 0;
  };
}
