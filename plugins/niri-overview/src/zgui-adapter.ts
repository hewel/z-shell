import type { PluginDefinition } from "@z-shell/plugin-api";
import { connectUnixSocket, getAuthorizedEndpoint } from "@hewel/zgui-services";
import overview, { createNiriOverviewPlugin, type NiriOverviewConfig, type NiriSocketTransport } from "./service.ts";
import { createNiriSocketTransport } from "./socket.ts";

export function createZguiNiriTransport(): NiriSocketTransport {
  let endpoint: string | null;
  try {
    endpoint = getAuthorizedEndpoint("niri");
  } catch {
    endpoint = null;
  }
  return createNiriSocketTransport(endpoint ?? undefined, { connectUnixSocket });
}

export function createZguiNiriOverviewPlugin() {
  return createNiriOverviewPlugin(createZguiNiriTransport());
}

const plugin: PluginDefinition<NiriOverviewConfig> = {
  ...overview,
  setup(ctx) {
    // Endpoint authorization is a host operation; defer it until service setup.
    return createZguiNiriOverviewPlugin().setup(ctx);
  },
};

export default plugin;
