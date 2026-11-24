import { deflateSync } from "node:zlib";

const DEFAULT_FIXTURE_SCHEME = Object.freeze({
  surface: "#111318",
  surface_dim: "#111318",
  surface_bright: "#37393E",
  surface_container_lowest: "#0C0E13",
  surface_container_low: "#191C20",
  surface_container: "#1D2024",
  surface_container_high: "#272A2F",
  surface_container_highest: "#32353A",
  on_surface: "#E2E2E9",
  on_surface_variant: "#C3C6CF",
  inverse_surface: "#E2E2E9",
  inverse_on_surface: "#2E3036",
  outline: "#8D9199",
  outline_variant: "#43474E",
  scrim: "#000000",
  primary: "#A6C8FF",
  on_primary: "#08305F",
  primary_container: "#254777",
  on_primary_container: "#D4E3FF",
  secondary: "#BCC7DC",
  on_secondary: "#263141",
  secondary_container: "#3C4759",
  on_secondary_container: "#D6E3F8",
  tertiary: "#D8BDE4",
  on_tertiary: "#3C2947",
  tertiary_container: "#533F5F",
  on_tertiary_container: "#F5D9FF",
  error: "#FFB4AB",
  on_error: "#690005",
  error_container: "#93000A",
  on_error_container: "#FFDAD6",
});

const DEFAULT_FIXTURE_BAR_SETTINGS = {
  position: "top",
  gaps: 14,
  edge_overrides: { top: null, right: null, bottom: null, left: null },
  launcher_enabled: true,
  dock_enabled: true,
  clock_24h: true,
  clock_seconds: false,
} as const;

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
  "clipboard",
  "system.brightness",
  "system.telemetry",
  "system.user",
  "session.idle",
  "desktop.apps",
  "desktop.ime.panel",
  "session.lock",
  "session.polkit",
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
  readonly sessionLock?: { readonly outcome: "locked" | "finished" };
  readonly expectHostRegister?: boolean;
}

const DAEMON_INSTANCE_ID = "preview-daemon";

export function makeSampleThemeSnapshot(primaryHex = "#7CD4FF") {
  return {
    scheme: { ...DEFAULT_FIXTURE_SCHEME, primary: primaryHex },
    dark: true,
    variant: "tonal",
    backend: "builtin",
    last_error: null,
  };
}

/**
 * Rich hardware telemetry fixture matching Paper `04C` & `22J` with distinctly shaped
 * `60s`, `5m`, and `15m` history curves (including an explicit `null` gap in `15m`)
 * so L4 tests can verify both visual parity and pixel-level time-range curve switching.
 */
export function makeSampleTelemetrySnapshot(options: {
  readonly includeGpu?: boolean;
  readonly legacy?: boolean;
} = {}) {
  const GiB = 1024 ** 3;
  const base = {
    cpu_usage_percent: 24.0,
    memory: {
      total_bytes: 32 * GiB,
      available_bytes: Math.round(20.6 * GiB),
      used_bytes: Math.round(11.4 * GiB),
      ...(options.legacy ? {} : {
        cached_bytes: Math.round(4.1 * GiB),
        buffers_bytes: Math.round(0.4 * GiB),
        reclaimable_bytes: Math.round(0.6 * GiB),
      }),
    },
    temperatures: [
      { zone: 0, kind: "x86_pkg_temp", temperature_millicelsius: 52_000 },
      { zone: 1, kind: "battery", temperature_millicelsius: 31_000 },
    ],
  };
  if (options.legacy) {
    return base;
  }

  // Distinct curves across time windows:
  // 60s: calm low wave (18..34%), 5m: steep high load plateau (68..96%), 15m: dual-phase with explicit null gap.
  const cpu60s = [18, 21, 22, 24, 29, 31, 34, 32, 27, 25, 29, 31, 26, 24];
  const cpu5m = [72, 78, 84, 88, 92, 95, 91, 86, 89, 94, 96, 90, 84, 88];
  const cpu15m = [42, 46, 52, 48, null, null, 18, 22, 35, 60, 74, 68, 45, 24];
  const mem60s = [34, 34, 35, 35, 36, 36, 36, 36, 35, 36, 36, 36, 36, 36];
  const mem5m = [58, 60, 63, 66, 70, 74, 76, 75, 72, 71, 70, 68, 64, 62];
  const mem15m = [30, 32, 35, 38, null, null, 45, 48, 52, 50, 44, 40, 37, 36];
  const netRx60s = [420_000, 950_000, 1_400_000, 2_800_000, 2_100_000, 3_600_000, 4_800_000, 3_900_000, 4_400_000, 3_200_000, 4_200_000];
  const netTx60s = [120_000, 180_000, 220_000, 310_000, 260_000, 400_000, 350_000, 290_000, 330_000, 280_000, 310_000];
  const netRx5m = [8_200_000, 9_100_000, 7_600_000, 8_800_000, 9_500_000, 8_400_000, 7_900_000, 9_200_000, 8_600_000, 8_100_000, 8_900_000];
  const netTx5m = [1_200_000, 1_500_000, 1_800_000, 1_600_000, 1_900_000, 1_700_000, 1_400_000, 1_600_000, 1_500_000, 1_300_000, 1_400_000];

  const includeGpu = options.includeGpu !== false;
  return {
    ...base,
    poll_interval_ms: 1000,
    cpu: {
      core_count: 8,
      per_core_usage_percent: [48, 28, 62, 18, 42, 12, 24, 14],
      frequency_mhz: 3820,
      model_name: "AMD Ryzen 7 7840U w/ Radeon 780M Graphics",
      load_average: [1.42, 1.28, 1.05],
      uptime_seconds: 4 * 3600 + 18 * 60,
    },
    swap: {
      total_bytes: 8 * GiB,
      free_bytes: Math.round(7.6 * GiB),
      used_bytes: Math.round(0.4 * GiB),
    },
    gpus: includeGpu
      ? [{
          id: "card0",
          name: "Radeon 780M",
          driver: "amdgpu",
          pci_slot: "0000:c1:00.0",
          utilization_percent: 18.0,
          vram_used_bytes: Math.round(2.1 * GiB),
          vram_total_bytes: 12 * GiB,
          temperature_millicelsius: 46_000,
          power_milliwatts: 14_200,
          clock_mhz: 1450,
        }]
      : [],
    network: {
      active_interface: "enp4s0",
      rx_bytes_per_sec: Math.round(4.2 * 1024 ** 2),
      tx_bytes_per_sec: 310 * 1024,
      session_rx_bytes: Math.round(1.8 * GiB),
      session_tx_bytes: 240 * 1024 ** 2,
      interfaces: [
        {
          name: "enp4s0",
          up: true,
          rx_bytes_per_sec: Math.round(4.2 * 1024 ** 2),
          tx_bytes_per_sec: 310 * 1024,
          session_rx_bytes: Math.round(1.8 * GiB),
          session_tx_bytes: 240 * 1024 ** 2,
        },
        {
          name: "wlan0",
          up: false,
          rx_bytes_per_sec: 0,
          tx_bytes_per_sec: 0,
          session_rx_bytes: 12 * 1024 ** 2,
          session_tx_bytes: 4 * 1024 ** 2,
        },
      ],
    },
    storage: {
      read_bytes_per_sec: 48 * 1024 ** 2,
      write_bytes_per_sec: 12 * 1024 ** 2,
      mounts: [
        {
          mount_point: "/",
          device: "nvme0n1p2",
          fs_type: "btrfs",
          total_bytes: 866 * GiB,
          available_bytes: 312 * GiB,
          used_bytes: 554 * GiB,
        },
        {
          mount_point: "/home",
          device: "nvme0n1p3",
          fs_type: "ext4",
          total_bytes: 983 * GiB,
          available_bytes: 580 * GiB,
          used_bytes: 403 * GiB,
        },
      ],
    },
    sensors: [
      { label: "CPU", category: "cpu", source: "k10temp", temperature_millicelsius: 52_000 },
      ...(includeGpu ? [{ label: "GPU", category: "gpu", source: "amdgpu", temperature_millicelsius: 46_000 }] : []),
      { label: "NVMe", category: "nvme", source: "nvme", temperature_millicelsius: 38_000 },
      { label: "Battery", category: "battery", source: "BAT0", temperature_millicelsius: 31_000 },
    ],
    history: {
      window_60s: {
        bucket_seconds: 1,
        cpu_percent: cpu60s,
        memory_percent: mem60s,
        ...(includeGpu ? { gpu_percent: [12, 14, 15, 18, 22, 19, 17, 18, 20, 18, 17, 16, 18, 18] } : {}),
        net_rx_bytes_per_sec: netRx60s,
        net_tx_bytes_per_sec: netTx60s,
        disk_read_bytes_per_sec: [22e6, 36e6, 48e6, 32e6, 28e6, 44e6, 52e6, 48e6],
        disk_write_bytes_per_sec: [8e6, 12e6, 10e6, 14e6, 9e6, 11e6, 13e6, 12e6],
      },
      window_5m: {
        bucket_seconds: 5,
        cpu_percent: cpu5m,
        memory_percent: mem5m,
        ...(includeGpu ? { gpu_percent: [68, 72, 76, 80, 82, 78, 74, 79, 85, 81, 77, 74, 72, 70] } : {}),
        net_rx_bytes_per_sec: netRx5m,
        net_tx_bytes_per_sec: netTx5m,
        disk_read_bytes_per_sec: [90e6, 110e6, 105e6, 98e6, 120e6, 115e6, 108e6, 102e6],
        disk_write_bytes_per_sec: [40e6, 48e6, 52e6, 46e6, 55e6, 50e6, 44e6, 42e6],
      },
      window_15m: {
        bucket_seconds: 15,
        cpu_percent: cpu15m,
        memory_percent: mem15m,
        ...(includeGpu ? { gpu_percent: [30, 34, 38, 36, null, null, 14, 16, 22, 28, 25, 20, 18, 18] } : {}),
        net_rx_bytes_per_sec: [2e6, 3e6, null, null, 1e6, 4e6, 5e6, 3e6],
        net_tx_bytes_per_sec: [200e3, 300e3, null, null, 150e3, 320e3, 360e3, 310e3],
        disk_read_bytes_per_sec: [30e6, 40e6, null, null, 20e6, 50e6, 48e6, 44e6],
        disk_write_bytes_per_sec: [10e6, 14e6, null, null, 8e6, 12e6, 11e6, 12e6],
      },
    },
  };
}

function defaultTopicSnapshots(): Record<ShellTopic, unknown> {
  return {
    theme: makeSampleThemeSnapshot(),
    settings: {
      general: { offline_mode: false, log_level: "info" },
      bar: DEFAULT_FIXTURE_BAR_SETTINGS,
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
    "desktop.apps": { available: true, count: 0, pinned_apps: [] },
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
    "desktop.ime.panel": {
      visible: false,
      aux: "",
      preedit: "",
      caret: 0,
      lookup_table: {
        labels: [],
        texts: [],
        attrs: [],
        has_prev: false,
        has_next: false,
        cursor: -1,
        layout: "auto",
      },
      spot_rect: null,
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
    clipboard: {
      persistence: { mode: "encrypted" },
      transport: { status: "ready" },
      locked: "unlocked",
      entry_count: 0,
      entries: [],
    },
    "system.brightness": {
      available: true,
      devices: [
        {
          device: "intel_backlight",
          brightness: 760,
          max_brightness: 1000,
          controllable: true,
        },
      ],
    },
    "system.telemetry": {
      cpu_usage_percent: 18.0,
      memory: {
        total_bytes: 34359738368,
        available_bytes: 22119081984,
        used_bytes: 12240656384,
      },
      temperatures: [{ zone: 0, kind: "x86_pkg_temp", temperature_millicelsius: 46000 }],
    },
    "system.user": { uid: 1000, username: "hewel", display_name: "hewel", avatar: null },
    "session.idle": {
      caffeine: false,
      media_playing: false,
      active_inhibitors: [],
      warning: null,
      rules: [],
      service_status: { status: "running" },
    },
    "session.lock": {
      phase: "unlocked",
      lock_id: null,
      sleep_hold: false,
      host_connected: true,
      ui_session_generation: 1,
      last_error: null,
    },
    "session.polkit": {
      enabled: true,
      registered: true,
      locked_suppressed: false,
      last_error: null,
      active: null,
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
  const expectHostRegister = options.expectHostRegister !== false;
  const hostRegisterCommand: FixtureCommandExpectation = {
    name: "host.session-register",
    args: [],
    payload: { ui_session_generation: 1 },
    atMs: 2,
  };

  const publicCommandIds = publicCommands.map((command, index) => command.id ?? 17 + index);
  const hostCommandIds = hostCommands.map((command, index) =>
    command.id ?? (expectHostRegister ? 3 : 2) + index);

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
      ...(expectHostRegister ? [commandRequest(hostRegisterCommand, 2)] : []),
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
      ...sortEvents([
        ...(expectHostRegister ? [commandReply(hostRegisterCommand, 2)] : []),
        ...hostCommandEvents,
        ...(options.extraHostEvents ?? []),
      ]),
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
      ...(options.sessionLock === undefined ? {} : { sessionLock: options.sessionLock }),
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

export function makeSolidPngBytes(width: number, height: number, r: number, g: number, b: number): number[] {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rowBytes = 1 + width * 4;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    pixels[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const idx = rowStart + 1 + x * 4;
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = 255;
    }
  }
  return Array.from(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

export function makeTinyPngBytes(r: number, g: number, b: number): number[] {
  return makeSolidPngBytes(1, 1, r, g, b);
}
