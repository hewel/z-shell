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

export interface ComposedServiceController {
  /** Cleanly restarts every service owned by `pluginId` with updated `[plugin_settings]` overrides. */
  restartPlugin(pluginId: string, pluginSettingsOverrides: Readonly<Record<string, unknown>>): void;
  /** Disposes all running plugin services synchronously. */
  dispose(): void;
}

interface RunningService {
  readonly service: ComposedServiceDescriptor;
  readonly token: number;
  cleanup?: PluginCleanup;
}

/**
 * Starts all composed plugin service entries against the active public bus client and returns a
 * controller capable of restarting an individual plugin's services when its settings change.
 */
export function createComposedServiceController(
  bundle: ComposedServiceBundle,
  client: ZShellClient,
  onError?: PluginServiceErrorHandler,
): ComposedServiceController {
  let disposed = false;
  let nextToken = 1;
  const running = new Map<string, RunningService>();

  function reportServiceError(service: ComposedServiceDescriptor, error: unknown): void {
    try {
      onError?.(service, error);
    } catch {
      // Never allow an error observer to break sibling plugin lifecycle hooks.
    }
  }

  function invokeCleanup(service: ComposedServiceDescriptor, cleanup: PluginCleanup): void {
    try {
      const pending = cleanup();
      if (pending && typeof (pending as PromiseLike<void>).then === "function") {
        void Promise.resolve(pending).catch(error => {
          reportServiceError(service, error);
        });
      }
    } catch (error) {
      reportServiceError(service, error);
    }
  }

  function stopEntry(entryId: string): void {
    const active = running.get(entryId);
    if (!active) return;
    running.delete(entryId);
    if (active.cleanup) {
      invokeCleanup(active.service, active.cleanup);
    }
  }

  function startEntry(
    service: ComposedServiceDescriptor,
    pluginSettingsOverride?: Readonly<Record<string, unknown>>,
  ): void {
    if (disposed) return;
    stopEntry(service.entryId);
    const token = nextToken++;
    const record: RunningService = { service, token };
    running.set(service.entryId, record);

    try {
      const definition = bundle.entryImports[service.importKey]?.default as PluginDefinition | undefined;
      if (!definition || typeof definition.setup !== "function") {
        throw new Error(`Plugin service entry ${service.entryId} must default-export a PluginDefinition`);
      }
      const defaults = definition.manifest?.defaults ?? {};
      const overrides = {
        ...service.pluginSettings,
        ...(pluginSettingsOverride ?? {}),
        ...service.settings,
      };
      const ctx = createPluginContext(service.pluginId, client, defaults, overrides);
      const result = definition.setup(ctx);
      if (typeof result === "function") {
        if (disposed || running.get(service.entryId)?.token !== token) {
          invokeCleanup(service, result);
        } else {
          record.cleanup = result;
        }
      } else if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).then(
          cleanup => {
            if (typeof cleanup !== "function") return;
            if (disposed || running.get(service.entryId)?.token !== token) {
              invokeCleanup(service, cleanup);
            } else {
              record.cleanup = cleanup;
            }
          },
          error => {
            if (running.get(service.entryId)?.token === token) {
              running.delete(service.entryId);
            }
            reportServiceError(service, error);
          },
        );
      }
    } catch (error) {
      running.delete(service.entryId);
      reportServiceError(service, error);
    }
  }

  for (const service of bundle.services) {
    startEntry(service);
  }

  return {
    restartPlugin(pluginId, pluginSettingsOverrides) {
      if (disposed) return;
      for (const service of bundle.services) {
        if (service.pluginId === pluginId) {
          startEntry(service, pluginSettingsOverrides);
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const entries = [...running.values()].reverse();
      running.clear();
      for (const entry of entries) {
        if (entry.cleanup) {
          invokeCleanup(entry.service, entry.cleanup);
        }
      }
    },
  };
}

/**
 * Starts all composed plugin service entries against the active public bus client and returns a
 * synchronous teardown callback.
 */
export function startComposedPluginServices(
  bundle: ComposedServiceBundle,
  client: ZShellClient,
  onError?: PluginServiceErrorHandler,
): () => void {
  const controller = createComposedServiceController(bundle, client, onError);
  return () => controller.dispose();
}
