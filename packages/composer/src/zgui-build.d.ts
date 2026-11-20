declare module "@hewel/zgui-build" {
  export type Capabilities = {
    shellSurfaces?: boolean;
    sessionLock?: boolean;
    imagePrefixes?: string[];
    unixSockets?: string[];
    namedSockets?: string[];
    commands?: string[];
    controlChannel?: boolean;
  };

  export type FontDeclaration = { family: string; path: string };

  export type PublishedApplication = { dist: string; manifest: Manifest };

  export type Manifest = {
    schemaVersion: 2;
    id: string;
    hostApiVersion: 1;
    entry: string;
    sourceMap: string;
    styles: string[];
    assets: string[];
    fonts: FontDeclaration[];
    capabilities?: Capabilities;
    styleSystem: {
      name: "stylex";
      profile: "zgui-stylex-v1";
      nativeProfileDigest: string;
      configDigest: string;
    };
    artifactDigests: Record<string, string>;
    buildId: string;
  };

  export interface BuildApplicationOptions {
    root?: string;
    appDirectory?: string;
    stylexDiagnostics?: boolean;
    development?: boolean;
    extraCapabilities?: Capabilities;
    capabilitiesFile?: string;
  }

  export const buildApplication: (
    app: string,
    options?: BuildApplicationOptions,
  ) => Promise<PublishedApplication>;
}
