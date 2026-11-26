import { join } from "node:path";

import {
  buildApplication,
  type BuildApplicationOptions,
  type Capabilities,
  type PublishedApplication,
} from "@hewel/zgui-build";
import type { HostCapabilities } from "@z-shell/plugin-api";

import { normalizeHostCapabilities } from "./capabilities.ts";
import { composePlugins, type ComposePluginsOptions, type ComposeReport } from "./compose.ts";

export interface BuildShellOptions {
  readonly app?: string;
  readonly appDirectory: string;
  readonly root?: string;
  readonly capabilitiesFile?: string;
  readonly extraCapabilities?: HostCapabilities;
  readonly cssModuleInclude?: readonly string[];
  readonly development?: boolean;
}

export async function buildShellApplication(options: BuildShellOptions): Promise<PublishedApplication> {
  const extra = options.extraCapabilities;
  if (extra !== undefined && ("sessionLock" in extra || "session_lock" in extra)) {
    throw new Error("sessionLock is never grantable through plugin composition");
  }
  const buildOptions: BuildApplicationOptions = {
    appDirectory: options.appDirectory,
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.capabilitiesFile === undefined ? {} : { capabilitiesFile: options.capabilitiesFile }),
    ...(extra === undefined ? {} : {
      // Normalization returns fresh arrays; expose the mutable view required by zgui-build.
      extraCapabilities: normalizeHostCapabilities(extra) as Capabilities,
    }),
    ...(options.cssModuleInclude === undefined ? {} : { cssModuleInclude: options.cssModuleInclude }),
    ...(options.development === undefined ? {} : { development: options.development }),
  };
  return buildApplication(options.app ?? "shell", buildOptions);
}

export interface ComposeAndBuildOptions extends ComposePluginsOptions {
  readonly app?: string;
  readonly appDirectory: string;
  readonly root?: string;
  readonly development?: boolean;
  readonly cssModuleInclude?: readonly string[];
}

export interface ComposeAndBuildResult {
  readonly compose: ComposeReport;
  readonly published: PublishedApplication;
}

export async function composeAndBuildShell(options: ComposeAndBuildOptions): Promise<ComposeAndBuildResult> {
  const compose = composePlugins(options);
  const published = await buildShellApplication({
    ...(options.app === undefined ? {} : { app: options.app }),
    appDirectory: options.appDirectory,
    ...(options.root === undefined ? {} : { root: options.root }),
    capabilitiesFile: join(options.outDir, "manifest-capabilities.json"),
    ...(options.cssModuleInclude === undefined ? {} : { cssModuleInclude: options.cssModuleInclude }),
    ...(options.development === undefined ? {} : { development: options.development }),
  });
  return { compose, published };
}
