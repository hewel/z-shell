import { deflateSync } from "node:zlib";

import { DEFAULT_BAR_SETTINGS } from "../src/topics.ts";
import { SHOJI_DEFAULT_SCHEME, type ThemeTopicSnapshot } from "../src/theme.ts";

export const SHELL_TOPIC_ORDER = [
  "theme",
  "settings",
  "wallpaper",
  "wayland.outputs",
  "wayland.workspaces",
  "wayland.windows",
  "desktop.media",
  "desktop.tray",
  "desktop.notifications",
  "desktop.ime",
  "system.audio",
  "system.privacy",
  "system.network",
  "system.bluetooth",
  "system.power",
] as const;

type ShellTopic = (typeof SHELL_TOPIC_ORDER)[number];

export interface FixtureCommandExpectation {
  readonly socket?: "public" | "host";
  readonly id?: number;
  readonly name: string;
  readonly payload?: unknown;
  readonly args?: readonly string[];
  readonly atMs: number;
  readonly result?: unknown;
}

export interface FixtureTopicUpdate {
  readonly topic: ShellTopic;
  readonly atMs: number;
  readonly revision: number;
  readonly sourceBaseline?: boolean;
  readonly data: unknown;
}

export interface ShellPreviewFixtureOptions {
  readonly id?: string;
  readonly waylandDisplay?: string;
  readonly xdgRuntimeDir?: string;
  readonly initialTopics?: Partial<Record<ShellTopic, unknown>>;
  readonly topicUpdates?: readonly FixtureTopicUpdate[];
  readonly commands?: readonly FixtureCommandExpectation[];
  readonly images?: {
    readonly files?: Readonly<Record<string, string>>;
    readonly blobs?: Readonly<Record<string, string>>;
  };
  readonly extraHostSends?: readonly string[];
  readonly extraHostEvents?: readonly Record<string, unknown>[];
}

const DAEMON_INSTANCE_ID = "preview-daemon";

export function makeSampleThemeSnapshot(primaryHex = "#7CD4FF"): ThemeTopicSnapshot {
  return {
    scheme: { ...SHOJI_DEFAULT_SCHEME, primary: primaryHex },
    dark: true,
    variant: "tonal",
    backend: "builtin",
    last_error: null,
  };
}

function defaultTopicSnapshots(): Record<ShellTopic, unknown> {
  return {
    theme: makeSampleThemeSnapshot(),
    settings: {
      general: { offline_mode: false, log_level: "info" },
      bar: DEFAULT_BAR_SETTINGS,
      theme: {
        mode: "dark",
        variant: "tonal",
        seed_color: null,
        backend: "builtin",
        gtk_linking: false,
      },
      ime: { mode: "indicator_only", candidate_layout: "auto", switch_osd: true },
      polkit: { enabled: true },
      wallpaper: { directories: [], fit: "cover", sync_theme: true, slideshow_seconds: 300 },
      pre_action_fade_seconds: 0,
      configured_plugins: [],
    },
    wallpaper: {
      available: false,
      fit: "cover",
      sync_theme: true,
      slideshow_seconds: 300,
      catalog_count: 0,
      current: null,
      per_output: {},
      last_error: null,
    },
    "wayland.outputs": { capability: "disconnected", outputs: [] },
    "wayland.workspaces": { capability: "disconnected", groups: [], workspaces: [] },
    "wayland.windows": { capability: "disconnected", windows: [] },
    "desktop.media": {
      available: false,
      players: [],
      selected_player_id: null,
      any_playing: false,
      cover: null,
    },
    "desktop.tray": { available: false, items: [] },
    "desktop.notifications": { available: false, dnd: false, popups: [], history: [] },
    "desktop.ime": {
      mode: "disabled",
      candidate_layout: "auto",
      switch_osd: false,
      available: false,
      enabled: false,
      active_im: null,
      properties: [],
      group_ims: [],
      exec_menu: null,
    },
    "system.audio": {
      availability: "unavailable",
      default_sink: null,
      default_source: null,
      sinks: [],
      sources: [],
      sink_inputs: [],
      source_outputs: [],
    },
    "system.privacy": {
      audio_capture: { state: "unknown" },
      camera: { state: "unknown" },
      screencast: { state: "unknown" },
    },
    "system.network": {
      available: false,
      connectivity: "unknown",
      wifi: {
        enabled: false,
        hardware_enabled: false,
        scanning: false,
        devices: [],
        profiles: [],
      },
      ethernet: [],
      vpn: [],
    },
    "system.bluetooth": { available: false, adapters: [], devices: [] },
    "system.power": {
      available: false,
      on_ac: null,
      battery: null,
      profiles: { available: false, active_profile: null, profiles: [] },
    },
  };
}

function message(atMs: number, value: unknown) {
  return { kind: "message", atMs, text: JSON.stringify(value) };
}

function commandRequest(command: FixtureCommandExpectation, id: number) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "command.invoke",
    params: {
      name: command.name,
      args: command.args ?? [],
      ...(command.payload === undefined ? {} : { payload: command.payload }),
    },
  });
}

function commandReply(command: FixtureCommandExpectation, id: number) {
  return message(command.atMs, {
    jsonrpc: "2.0",
    id,
    result: command.result === undefined ? {} : command.result,
  });
}

function sortEvents<T extends Record<string, unknown>>(events: readonly T[]): T[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => Number(a.event.atMs) - Number(b.event.atMs) || a.index - b.index)
    .map(({ event }) => event);
}

export function buildShellPreviewFixture(options: ShellPreviewFixtureOptions = {}) {
  const waylandDisplay = options.waylandDisplay ?? "wayland-1";
  const xdgRuntimeDir = options.xdgRuntimeDir ?? "/zgui-preview-only/runtime";
  const homeDir = "/zgui-preview-only/home";
  const initialTopics = defaultTopicSnapshots();
  const commands = options.commands ?? [];
  const publicCommands = commands.filter(command => (command.socket ?? "public") === "public");
  const hostCommands = commands.filter(command => command.socket === "host");

  const publicCommandIds = publicCommands.map((command, index) => command.id ?? 17 + index);
  const hostCommandIds = hostCommands.map((command, index) => command.id ?? 2 + index);

  const snapshotEvents = SHELL_TOPIC_ORDER.map((topic, index) => {
    const data = options.initialTopics && Object.hasOwn(options.initialTopics, topic)
      ? options.initialTopics[topic]
      : initialTopics[topic];
    return message(4, {
      jsonrpc: "2.0",
      id: index + 2,
      result: {
        daemon_instance_id: DAEMON_INSTANCE_ID,
        topic_instance_id: index + 1,
        topic,
        revision: 1,
        data,
      },
    });
  });

  const updateEvents = (options.topicUpdates ?? []).map(update => {
    const topicIndex = SHELL_TOPIC_ORDER.indexOf(update.topic);
    return message(update.atMs, {
      jsonrpc: "2.0",
      method: "topic.update",
      params: {
        daemon_instance_id: DAEMON_INSTANCE_ID,
        topic_instance_id: topicIndex + 1,
        topic: update.topic,
        revision: update.revision,
        source_baseline: update.sourceBaseline ?? false,
        data: update.data,
      },
    });
  });

  const publicCommandEvents = publicCommands.map((command, index) =>
    commandReply(command, publicCommandIds[index]!));
  const hostCommandEvents = hostCommands.map((command, index) =>
    commandReply(command, hostCommandIds[index]!));

  const publicSocket = {
    path: `${xdgRuntimeDir}/z-shell/bus-${waylandDisplay}.sock`,
    framing: "line",
    send: [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "bus.hello",
        params: { protocol_version: 1, client_name: "z-shell-ui" },
      }),
      ...SHELL_TOPIC_ORDER.map((topic, index) => JSON.stringify({
        jsonrpc: "2.0",
        id: index + 2,
        method: "topic.subscribe",
        params: { topic },
      })),
      ...publicCommands.map((command, index) => commandRequest(command, publicCommandIds[index]!)),
    ],
    events: [
      message(1, {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocol_version: 1,
          daemon_version: "0.1.0-preview",
          daemon_instance_id: DAEMON_INSTANCE_ID,
          client_id: 1,
          role: "public",
          media_dir: `${xdgRuntimeDir}/z-shell/media`,
        },
      }),
      ...snapshotEvents,
      ...sortEvents([...updateEvents, ...publicCommandEvents]),
    ],
  };

  const hostSocket = {
    path: `${xdgRuntimeDir}/z-shell/host-${waylandDisplay}.sock`,
    framing: "line",
    send: [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "bus.hello",
        params: { protocol_version: 1, client_name: "z-shell-host" },
      }),
      ...hostCommands.map((command, index) => commandRequest(command, hostCommandIds[index]!)),
      ...(options.extraHostSends ?? []),
    ],
    events: [
      message(1, {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocol_version: 1,
          daemon_version: "0.1.0-preview",
          daemon_instance_id: DAEMON_INSTANCE_ID,
          client_id: 2,
          role: "privileged_host",
          media_dir: `${xdgRuntimeDir}/z-shell/media`,
        },
      }),
      ...sortEvents([...hostCommandEvents, ...(options.extraHostEvents ?? [])]),
    ],
  };

  return {
    schemaVersion: 1,
    id: options.id ?? "z-shell-daemon",
    runtimeEnvironment: {
      xdgRuntimeDir,
      homeDir,
      xdgDataHome: `${homeDir}/.local/share`,
      waylandDisplay,
      namedSockets: { niri: "/zgui-preview-only/niri.sock" },
    },
    services: {
      sockets: [publicSocket, hostSocket],
      control: {},
      ...(options.images === undefined ? {} : { images: options.images }),
    },
    events: [],
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

export function makeTinyPngBytes(r: number, g: number, b: number): number[] {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.from([0, r, g, b, 255]);
  return Array.from(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}
