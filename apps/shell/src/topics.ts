import type { LayerAnchor, Monitor } from "@hewel/zgui";
import type { MediaRef } from "@z-shell/sdk";

export type WallpaperFit = "cover" | "contain" | "fill" | "center";

export interface ActiveWallpaper {
  readonly source_path: string;
  readonly media: MediaRef;
  readonly width: number;
  readonly height: number;
  readonly fit: WallpaperFit;
}

export interface WallpaperSnapshot {
  readonly available: boolean;
  readonly fit: WallpaperFit;
  readonly sync_theme: boolean;
  readonly slideshow_seconds: number;
  readonly catalog_count: number;
  readonly current: ActiveWallpaper | null;
  readonly per_output: Readonly<Record<string, ActiveWallpaper>>;
  readonly last_error: string | null;
}

export type BarPosition = "top" | "left" | "right";

export interface EdgeOverrides {
  readonly top: number | null;
  readonly right: number | null;
  readonly bottom: number | null;
  readonly left: number | null;
}

export interface BarSettings {
  readonly position: BarPosition;
  readonly gaps: number;
  readonly edge_overrides: EdgeOverrides;
  readonly launcher_enabled: boolean;
  readonly dock_enabled: boolean;
  readonly clock_24h: boolean;
  readonly clock_seconds: boolean;
}

export interface PublicSettingsSummary {
  readonly general: {
    readonly offline_mode: boolean;
    readonly log_level: string;
  };
  readonly bar: BarSettings;
  readonly theme: {
    readonly mode: "dark" | "light" | "auto";
    readonly variant: string;
    readonly seed_color: string | null;
    readonly backend: string;
    readonly gtk_linking: boolean;
  };
  readonly ime: {
    readonly mode: "indicator_only" | "kimpanel" | "disabled";
    readonly candidate_layout: "auto" | "horizontal" | "vertical";
    readonly switch_osd: boolean;
  };
  readonly polkit: {
    readonly enabled: boolean;
  };
  readonly wallpaper: {
    readonly directories: readonly string[];
    readonly fit: WallpaperFit;
    readonly sync_theme: boolean;
    readonly slideshow_seconds: number;
  };
  readonly pre_action_fade_seconds: number;
  readonly configured_plugins: readonly string[];
}

export const DEFAULT_BAR_SETTINGS: BarSettings = {
  position: "top",
  gaps: 14,
  edge_overrides: { top: null, right: null, bottom: null, left: null },
  launcher_enabled: true,
  dock_enabled: true,
  clock_24h: true,
  clock_seconds: false,
};

export type CapabilityState = "readable" | "controllable" | "unsupported" | "disconnected";

export interface WaylandOutput {
  readonly output_instance_id: number;
  readonly name: string | null;
  readonly description: string | null;
  readonly make: string | null;
  readonly model: string | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly mode_width: number | null;
  readonly mode_height: number | null;
  readonly refresh_mhz: number | null;
  readonly scale: number;
  readonly physical_width_mm: number | null;
  readonly physical_height_mm: number | null;
}

export interface WaylandOutputsSnapshot {
  readonly capability: CapabilityState;
  readonly outputs: readonly WaylandOutput[];
}

export interface WorkspaceGroup {
  readonly group_id: number;
  readonly output_instance_ids: readonly number[];
}

export type WorkspaceCapability = "activate" | "deactivate" | "remove" | "assign";

export interface WaylandWorkspace {
  readonly workspace_id: number;
  readonly group_id: number | null;
  readonly name: string | null;
  readonly id_str: string | null;
  readonly coordinates: readonly number[];
  readonly active: boolean;
  readonly urgent: boolean;
  readonly hidden: boolean;
  readonly capabilities: readonly WorkspaceCapability[];
}

export interface WaylandWorkspacesSnapshot {
  readonly capability: CapabilityState;
  readonly groups: readonly WorkspaceGroup[];
  readonly workspaces: readonly WaylandWorkspace[];
}

export interface WaylandWindow {
  readonly window_id: number;
  readonly title: string | null;
  readonly app_id: string | null;
  readonly activated: boolean;
  readonly minimized: boolean;
  readonly maximized: boolean;
  readonly fullscreen: boolean;
  readonly output_instance_ids: readonly number[];
}

export interface WaylandWindowsSnapshot {
  readonly capability: CapabilityState;
  readonly windows: readonly WaylandWindow[];
}

export type PlaybackStatus = "playing" | "paused" | "stopped" | "unknown";

export interface MediaPlayer {
  readonly id: string;
  readonly identity: string;
  readonly playback_status: PlaybackStatus;
  readonly position_us: number | null;
  readonly metadata: {
    readonly track_id: string | null;
    readonly title: string | null;
    readonly album: string | null;
    readonly artists: readonly string[];
    readonly length_us: number | null;
  };
  readonly capabilities: {
    readonly can_control: boolean;
    readonly can_play: boolean;
    readonly can_pause: boolean;
    readonly can_go_next: boolean;
    readonly can_go_previous: boolean;
    readonly can_seek: boolean;
  };
}

export interface DesktopMediaSnapshot {
  readonly available: boolean;
  readonly players: readonly MediaPlayer[];
  readonly selected_player_id: string | null;
  readonly any_playing: boolean;
  readonly cover: MediaRef | null;
}

export interface TrayMenuNode {
  readonly id: number;
  readonly label: string | null;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly separator: boolean;
  readonly toggle_type: "checkmark" | "radio" | null;
  readonly toggle_state: number | null;
  readonly children: readonly TrayMenuNode[];
}

export interface TrayItem {
  readonly id: string;
  readonly title: string | null;
  readonly category: string | null;
  readonly status: string | null;
  readonly icon_name: string | null;
  readonly item_is_menu: boolean;
  readonly tooltip: {
    readonly title: string | null;
    readonly description: string | null;
  } | null;
  readonly icon: MediaRef | null;
  readonly menu: {
    readonly revision: number;
    readonly root: TrayMenuNode;
  } | null;
}

export interface DesktopTraySnapshot {
  readonly available: boolean;
  readonly items: readonly TrayItem[];
}

export interface NotificationItem {
  readonly id: number;
  readonly revision: number;
  readonly app_name: string;
  readonly summary: string;
  readonly body: string;
  readonly icon: string | MediaRef | null;
  readonly attachment: MediaRef | null;
  readonly actions: readonly {
    readonly key: string;
    readonly label: string;
  }[];
  readonly urgency: number;
}

export interface DesktopNotificationsSnapshot {
  readonly available: boolean;
  readonly dnd: boolean;
  readonly popups: readonly NotificationItem[];
  readonly history: readonly NotificationItem[];
}

export interface ImeProperty {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly text: string;
  readonly hints: readonly string[];
}

export interface ImeGroupItem {
  readonly unique_name: string;
  readonly label: string;
  readonly layout: string;
}

export interface DesktopImeSnapshot {
  readonly mode: "indicator_only" | "kimpanel" | "disabled";
  readonly candidate_layout: "auto" | "horizontal" | "vertical";
  readonly switch_osd: boolean;
  readonly available: boolean;
  readonly enabled: boolean;
  readonly active_im: {
    readonly unique_name: string | null;
    readonly label: string;
    readonly short_label: string;
    readonly icon: string | null;
    readonly text: string;
  } | null;
  readonly properties: readonly ImeProperty[];
  readonly group_ims: readonly ImeGroupItem[];
  readonly exec_menu: {
    readonly revision: number;
    readonly items: readonly ImeProperty[];
  } | null;
}

export interface AudioDevice {
  readonly index: number;
  readonly name: string;
  readonly description: string | null;
  readonly channels: number;
  readonly volume: number;
  readonly muted: boolean;
  readonly monitor_of_sink?: number;
}

export interface AudioStream {
  readonly index: number;
  readonly name: string | null;
  readonly application: string | null;
  readonly device_index: number;
  readonly channels: number;
  readonly volume: number | null;
  readonly muted: boolean;
  readonly corked: boolean;
  readonly volume_writable: boolean;
}

export interface SystemAudioSnapshot {
  readonly availability: "available" | "unavailable";
  readonly default_sink: string | null;
  readonly default_source: string | null;
  readonly sinks: readonly AudioDevice[];
  readonly sources: readonly AudioDevice[];
  readonly sink_inputs: readonly AudioStream[];
  readonly source_outputs: readonly AudioStream[];
}

export type AudioCaptureState =
  | { readonly state: "active"; readonly apps: readonly string[] }
  | { readonly state: "inactive" }
  | { readonly state: "unknown" };

export interface SystemPrivacySnapshot {
  readonly audio_capture: AudioCaptureState;
  readonly camera: { readonly state: "unknown" };
  readonly screencast: { readonly state: "unknown" };
}

export interface ActiveConnection {
  readonly id: string;
  readonly profile_id: string;
  readonly name: string;
  readonly state: "unknown" | "activating" | "activated" | "deactivating" | "deactivated";
}

export interface AccessPoint {
  readonly id: string;
  readonly ssid: string;
  readonly ssid_bytes: readonly number[];
  readonly bssid: string;
  readonly strength: number;
  readonly security: "open" | "owe" | "wpa_psk" | "wpa_sae" | "enterprise" | "unsupported";
}

export interface WifiDevice {
  readonly id: string;
  readonly interface: string;
  readonly active_ap_id: string | null;
  readonly active_connection: ActiveConnection | null;
  readonly access_points: readonly AccessPoint[];
}

export interface WifiProfile {
  readonly id: string;
  readonly name: string;
  readonly ssid: string;
  readonly ssid_bytes: readonly number[];
}

export interface SystemNetworkSnapshot {
  readonly available: boolean;
  readonly connectivity: "unknown" | "none" | "portal" | "limited" | "full";
  readonly wifi: {
    readonly enabled: boolean;
    readonly hardware_enabled: boolean;
    readonly scanning: boolean;
    readonly devices: readonly WifiDevice[];
    readonly profiles: readonly WifiProfile[];
  };
  readonly ethernet: readonly {
    readonly id: string;
    readonly interface: string;
    readonly carrier: boolean;
    readonly active_connection: ActiveConnection | null;
  }[];
  readonly vpn: readonly ActiveConnection[];
}

export interface BluetoothAdapter {
  readonly path: string;
  readonly powered: boolean;
  readonly discovering: boolean;
}

export interface BluetoothDevice {
  readonly path: string;
  readonly adapter: string;
  readonly address: string;
  readonly name: string | null;
  readonly icon: string | null;
  readonly paired: boolean;
  readonly trusted: boolean;
  readonly connected: boolean;
  readonly battery: number | null;
}

export interface SystemBluetoothSnapshot {
  readonly available: boolean;
  readonly adapters: readonly BluetoothAdapter[];
  readonly devices: readonly BluetoothDevice[];
}

export type BatteryState =
  | "unknown"
  | "charging"
  | "discharging"
  | "full"
  | "pending_charge"
  | "pending_discharge";

export interface SystemPowerSnapshot {
  readonly available: boolean;
  readonly on_ac: boolean | null;
  readonly battery: {
    readonly percentage: number | null;
    readonly state: BatteryState;
    readonly time_to_empty_seconds: number | null;
    readonly time_to_full_seconds: number | null;
    readonly energy_rate_watts: number | null;
    readonly capacity_percent: number | null;
    readonly charge_cycles: number | null;
  } | null;
  readonly profiles: {
    readonly available: boolean;
    readonly active_profile: string | null;
    readonly profiles: readonly string[];
  };
}

export const TOP_BAR_HEIGHT = 48;
export const VERTICAL_BAR_WIDTH = 52;

export interface ResolvedBarLayout {
  readonly position: BarPosition;
  readonly isVertical: boolean;
  readonly anchor: readonly LayerAnchor[];
  readonly margin: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
  readonly width: number;
  readonly height: number;
  readonly exclusiveZone: number;
}

export function resolveBarLayout(
  bar: BarSettings | undefined,
  monitor: Pick<Monitor, "width" | "height">,
): ResolvedBarLayout {
  const settings = bar ?? DEFAULT_BAR_SETTINGS;
  const { edge_overrides: edges, gaps } = settings;

  if (settings.position === "top") {
    const margin = {
      top: edges.top ?? gaps,
      right: edges.right ?? gaps,
      bottom: edges.bottom ?? 0,
      left: edges.left ?? gaps,
    };
    return {
      position: "top",
      isVertical: false,
      anchor: ["top", "left", "right"],
      margin,
      width: Math.max(240, monitor.width - margin.left - margin.right),
      height: TOP_BAR_HEIGHT,
      exclusiveZone: TOP_BAR_HEIGHT + margin.top,
    };
  }

  if (settings.position === "left") {
    const margin = {
      top: edges.top ?? gaps,
      right: edges.right ?? 0,
      bottom: edges.bottom ?? gaps,
      left: edges.left ?? gaps,
    };
    return {
      position: "left",
      isVertical: true,
      anchor: ["left", "top", "bottom"],
      margin,
      width: VERTICAL_BAR_WIDTH,
      height: Math.max(240, monitor.height - margin.top - margin.bottom),
      exclusiveZone: VERTICAL_BAR_WIDTH + margin.left,
    };
  }

  const margin = {
    top: edges.top ?? gaps,
    right: edges.right ?? gaps,
    bottom: edges.bottom ?? gaps,
    left: edges.left ?? 0,
  };
  return {
    position: "right",
    isVertical: true,
    anchor: ["right", "top", "bottom"],
    margin,
    width: VERTICAL_BAR_WIDTH,
    height: Math.max(240, monitor.height - margin.top - margin.bottom),
    exclusiveZone: VERTICAL_BAR_WIDTH + margin.right,
  };
}

export function resolveMonitorWallpaper(
  snapshot: WallpaperSnapshot | undefined,
  monitorName: string,
): ActiveWallpaper | null {
  if (!snapshot) {
    return null;
  }
  const assigned = Object.hasOwn(snapshot.per_output, monitorName)
    ? snapshot.per_output[monitorName]
    : undefined;
  return assigned ?? snapshot.current ?? null;
}

function compareWorkspaces(a: WaylandWorkspace, b: WaylandWorkspace): number {
  const sharedLength = Math.min(a.coordinates.length, b.coordinates.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = a.coordinates[index] - b.coordinates[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return a.coordinates.length - b.coordinates.length || a.workspace_id - b.workspace_id;
}

export function filterWorkspacesForMonitor(
  workspacesSnapshot: WaylandWorkspacesSnapshot | undefined,
  outputsSnapshot: WaylandOutputsSnapshot | undefined,
  monitorName: string,
): readonly WaylandWorkspace[] {
  const visible = workspacesSnapshot?.workspaces.filter(workspace => !workspace.hidden) ?? [];
  const output = outputsSnapshot?.outputs.find(candidate => candidate.name === monitorName);
  const groupIds = output
    ? new Set(
        workspacesSnapshot?.groups
          .filter(group => group.output_instance_ids.includes(output.output_instance_id))
          .map(group => group.group_id),
      )
    : undefined;
  const filtered = groupIds && groupIds.size > 0
    ? visible.filter(workspace => workspace.group_id !== null && groupIds.has(workspace.group_id))
    : visible;
  return filtered.sort(compareWorkspaces);
}

export function findActiveWindowForMonitor(
  windowsSnapshot: WaylandWindowsSnapshot | undefined,
  outputsSnapshot: WaylandOutputsSnapshot | undefined,
  monitorName: string,
): WaylandWindow | null {
  const activated = windowsSnapshot?.windows.filter(window => window.activated) ?? [];
  const output = outputsSnapshot?.outputs.find(candidate => candidate.name === monitorName);
  const matched = output
    ? activated.find(window => window.output_instance_ids.includes(output.output_instance_id))
    : undefined;
  return matched ?? activated[0] ?? null;
}

export function selectActiveMediaPlayer(media: DesktopMediaSnapshot | undefined): MediaPlayer | null {
  if (!media) {
    return null;
  }
  return media.players.find(player => player.id === media.selected_player_id)
    ?? media.players.find(player => player.playback_status === "playing")
    ?? media.players[0]
    ?? null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatBarClock(
  nowMs: number,
  options: { readonly clock24h: boolean; readonly clockSeconds: boolean },
): {
  readonly horizontal: string;
  readonly hours: string;
  readonly minutes: string;
  readonly seconds: string;
  readonly dateShort: string;
} {
  const date = new Date(nowMs);
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  const dateShort = `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
  const time = options.clock24h
    ? `${hours}:${minutes}${options.clockSeconds ? `:${seconds}` : ""}`
    : `${date.getHours() % 12 || 12}:${minutes}${options.clockSeconds ? `:${seconds}` : ""} ${date.getHours() < 12 ? "AM" : "PM"}`;
  return { horizontal: `${dateShort} · ${time}`, hours, minutes, seconds, dateShort };
}
