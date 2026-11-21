// Standalone composition. A composed build can replace this file with composed-plugins.ts.
import type { PluginEntryKind } from "@z-shell/plugin-api";
export type { ComposedPluginBundle } from "./PluginHost.tsx";

export interface ComposedServiceDescriptor {
  readonly pluginId: string;
  readonly id: string;
  readonly entryId: string;
  readonly kind: Extract<PluginEntryKind, "service">;
  readonly entry: string;
  readonly title?: string;
  readonly description?: string;
  readonly widthTier?: "compact" | "standard";
  readonly settings: Readonly<Record<string, unknown>>;
  readonly pluginSettings: Readonly<Record<string, unknown>>;
  readonly importKey: string;
}

export interface ComposedEntryInstanceDescriptor {
  readonly pluginId: string;
  readonly id: string;
  readonly entryId: string;
  readonly kind: Exclude<PluginEntryKind, "service">;
  readonly entry: string;
  readonly title?: string;
  readonly description?: string;
  readonly widthTier?: "compact" | "standard";
  readonly settings: Readonly<Record<string, unknown>>;
  readonly pluginSettings: Readonly<Record<string, unknown>>;
  readonly instanceId: string;
  readonly outputId?: string;
  readonly importKey: string;
}

export const entryImports = {} as const;
export const services: readonly ComposedServiceDescriptor[] = [] as const;
export const entryInstances: readonly ComposedEntryInstanceDescriptor[] = [] as const;

export const composedPlugins = { entryImports, services, entryInstances } as const;
export default composedPlugins;
