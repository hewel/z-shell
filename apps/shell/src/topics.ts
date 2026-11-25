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
export type BarStyle = "floating" | "docked";
export type MotionScheme = "standard" | "expressive" | "reduced";

export interface EdgeOverrides {
  readonly top: number | null;
  readonly right: number | null;
  readonly bottom: number | null;
  readonly left: number | null;
}

export interface BarSettings {
  readonly position: BarPosition;
  readonly style?: BarStyle;
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
    readonly motion_scheme?: MotionScheme;
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
  style: "floating",
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

export interface DesktopAppSummary {
  readonly id: string;
  readonly title: string;
  readonly startup_wm_class?: string;
  readonly icon?: MediaRef;
}

export interface DesktopAppsSnapshot {
  readonly available: boolean;
  readonly count: number;
  readonly pinned_apps: readonly string[];
  readonly apps?: readonly DesktopAppSummary[];
}

export interface LauncherAction {
  readonly action_id: string;
  readonly title: string;
}

export interface LauncherItem {
  readonly provider_id: string;
  readonly item_id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly icon?: MediaRef;
  readonly actions: readonly LauncherAction[];
  readonly score: number;
  readonly pinned?: boolean;
}

export interface LauncherQueryResponse {
  readonly query_id: number;
  readonly items: readonly LauncherItem[];
}

export interface DockEntry {
  readonly appId: string;
  readonly title: string;
  readonly icon?: MediaRef;
  readonly pinned: boolean;
  readonly windows: readonly WaylandWindow[];
  readonly focused: boolean;
}

export interface ImeLookupTable {
  readonly labels: readonly string[];
  readonly texts: readonly string[];
  readonly attrs: readonly string[];
  readonly has_prev: boolean;
  readonly has_next: boolean;
  readonly cursor: number;
  readonly layout: "auto" | "horizontal" | "vertical";
}

export interface ImeSpotRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly relative: boolean;
  readonly scale: number;
}

export interface DesktopImePanelSnapshot {
  readonly visible: boolean;
  readonly aux: string;
  readonly preedit: string;
  readonly caret: number;
  readonly lookup_table: ImeLookupTable;
  readonly spot_rect: ImeSpotRect | null;
}

export type OsdKind = "volume" | "mute" | "brightness" | "ime";

export interface OsdPayload {
  readonly kind: OsdKind;
  readonly label: string;
  readonly value?: number;
  readonly muted?: boolean;
  readonly seq: number;
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
  readonly app_id?: string | null;
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

export interface NotificationAction {
  readonly key: string;
  readonly label: string;
}

export interface NotificationImageDimensions {
  readonly width: number;
  readonly height: number;
}

export type NotificationMediaRef = MediaRef & {
  readonly dimensions?: NotificationImageDimensions | null;
};

export interface NotificationItem {
  readonly id: number;
  readonly revision: number;
  readonly app_name: string;
  readonly summary: string;
  readonly body: string;
  readonly icon: string | NotificationMediaRef | null;
  readonly attachment: NotificationMediaRef | null;
  readonly actions: readonly NotificationAction[];
  readonly urgency: number;
}

export interface NotificationMediaLayout {
  readonly leadingMedia: NotificationMediaRef | null;
  readonly leadingKind: "avatar" | "app-icon" | null;
  readonly appBadge: NotificationMediaRef | null;
  readonly previewBanner: NotificationMediaRef | null;
  readonly fallbackKind: "image" | "bell";
}

function isWideNotificationPreview(media: NotificationMediaRef | null | undefined): boolean {
  const dims = media?.dimensions;
  if (!dims || dims.width <= 0 || dims.height <= 0) return false;
  return dims.width / dims.height > 1.35 && dims.width > 160;
}

function isAvatarOrSquareMedia(media: NotificationMediaRef | null | undefined): boolean {
  const dims = media?.dimensions;
  if (!dims || dims.width <= 0 || dims.height <= 0) return false;
  const ratio = dims.width / dims.height;
  return (ratio >= 0.75 && ratio <= 1.35) || Math.max(dims.width, dims.height) <= 160;
}

/**
 * Aspect-aware media routing shared by NotificationToasts and CalendarPanel (12B):
 * - Form A (square/avatar/small <= 160px attachment): route to leading avatar/cover slot + circular XDG app badge.
 * - Form B (wide screenshot/photo > 1.35 & width > 160px in attachment OR app_icon): promote to full-width cover banner.
 */
export function resolveNotificationMediaLayout(
  item: Pick<NotificationItem, "icon" | "attachment">,
): NotificationMediaLayout {
  const iconMedia = item.icon && typeof item.icon !== "string" ? item.icon : null;
  const attachmentMedia = item.attachment ?? null;

  if (attachmentMedia) {
    if (isAvatarOrSquareMedia(attachmentMedia)) {
      return {
        leadingMedia: attachmentMedia,
        leadingKind: "avatar",
        appBadge: iconMedia && !isWideNotificationPreview(iconMedia) ? iconMedia : null,
        previewBanner: null,
        fallbackKind: "bell",
      };
    }
    const usableAppIcon = iconMedia && !isWideNotificationPreview(iconMedia) ? iconMedia : null;
    return {
      leadingMedia: usableAppIcon,
      leadingKind: usableAppIcon ? "app-icon" : null,
      appBadge: null,
      previewBanner: attachmentMedia,
      fallbackKind: "image",
    };
  }

  if (iconMedia && isWideNotificationPreview(iconMedia)) {
    return {
      leadingMedia: null,
      leadingKind: null,
      appBadge: null,
      previewBanner: iconMedia,
      fallbackKind: "image",
    };
  }

  if (iconMedia) {
    return {
      leadingMedia: iconMedia,
      leadingKind: "app-icon",
      appBadge: null,
      previewBanner: null,
      fallbackKind: "bell",
    };
  }

  return {
    leadingMedia: null,
    leadingKind: null,
    appBadge: null,
    previewBanner: null,
    fallbackKind: "bell",
  };
}

/**
 * Splits FreeDesktop notification actions into the card-click `"default"` action and visible
 * labelled buttons so empty-label `"default"` actions (e.g. Ghostty / Chrome / Electron) never
 * render blank pill buttons while remaining invocable via card click.
 */
/**
 * Identifies SNI tray icons belonging to an input method daemon (Fcitx5 / IBus) so the bar can
 * omit duplicate tray icons while the dedicated `bar-ime` capsule is active.
 */
export function isImeTrayItem(item: TrayItem): boolean {
  const appId = item.app_id?.trim().toLowerCase();
  if (appId === "fcitx" || appId === "fcitx5" || appId === "ibus") return true;
  const icon = item.icon_name?.trim().toLowerCase();
  if (icon && (icon === "fcitx" || icon.startsWith("fcitx-") || icon === "ibus" || icon.startsWith("ibus-"))) {
    return true;
  }
  return item.category === "SystemServices" && (item.title === "Input Method" || item.title === "输入法");
}

export function splitNotificationActions(actions: readonly NotificationAction[]): {
  readonly defaultAction: NotificationAction | undefined;
  readonly buttonActions: readonly NotificationAction[];
} {
  const defaultAction = actions.find(action => action.key === "default");
  const buttonActions = actions.filter(
    action => action.key !== "default" && action.label.trim().length > 0,
  );
  return { defaultAction, buttonActions };
}

/**
 * Normalizes notification body line breaks for compact toast/history display:
 * converts CRLF/CR to LF, collapses consecutive blank lines into a single line break,
 * preserves meaningful single newlines, and trims outer whitespace.
 */
export function formatNotificationBody(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .replace(/\n(?:[ \t]*\n)+/g, "\n")
    .trim();
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

export type LockPhaseName = "unlocked" | "engaging" | "locked" | "fallback_spawned";

export interface LockSnapshot {
  readonly phase: LockPhaseName;
  readonly lock_id: number | null;
  readonly sleep_hold: boolean;
  readonly host_connected: boolean;
  readonly ui_session_generation: number | null;
  readonly last_error: string | null;
}

export interface UnlockApproval {
  readonly token: string;
  readonly daemon_instance_id: string;
  readonly ui_session_generation: number;
  readonly lock_id: number;
  readonly auth_attempt_id: number;
}

export interface PolkitIdentity {
  readonly uid: number;
  readonly username: string;
}

export interface PolkitPromptView {
  readonly request_id: number;
  readonly action_id: string;
  readonly message: string;
  readonly icon_name: string;
  readonly details: Readonly<Record<string, string>>;
  readonly identities: readonly PolkitIdentity[];
  readonly selected_uid: number | null;
  readonly prompt: string | null;
  readonly echo_on: boolean;
  readonly info_message: string | null;
  readonly error_message: string | null;
  readonly authenticating: boolean;
}

export interface PolkitSnapshot {
  readonly enabled: boolean;
  readonly registered: boolean;
  readonly locked_suppressed: boolean;
  readonly last_error: string | null;
  readonly active: PolkitPromptView | null;
}

export type PowerConfirmAction = "lock" | "suspend" | "reboot" | "poweroff" | "logout";

export const POWER_DIALOG_COPY: Readonly<Record<PowerConfirmAction, {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly destructive: boolean;
  readonly icon: "lock" | "sleep" | "reboot" | "power" | "logout";
}>> = {
  lock: {
    title: "Lock screen?",
    description: "Authentication will be required to return to this session.",
    confirmLabel: "Lock",
    destructive: false,
    icon: "lock",
  },
  suspend: {
    title: "Suspend?",
    description: "The computer will sleep and resume where you left off.",
    confirmLabel: "Suspend",
    destructive: false,
    icon: "sleep",
  },
  reboot: {
    title: "Restart?",
    description: "Open apps will be closed and the computer will restart.",
    confirmLabel: "Restart",
    destructive: true,
    icon: "reboot",
  },
  poweroff: {
    title: "Shut down?",
    description: "Open apps will be closed and the computer will turn off.",
    confirmLabel: "Shut down",
    destructive: true,
    icon: "power",
  },
  logout: {
    title: "Log out?",
    description: "Open apps will be closed and you will return to the login screen.",
    confirmLabel: "Log out",
    destructive: true,
    icon: "logout",
  },
};

export interface CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly source_path: string;
  readonly width: number;
  readonly height: number;
  readonly thumbnail: MediaRef;
}

export interface WallpaperListResponse {
  readonly items: readonly CatalogEntry[];
  readonly total: number;
}

export type PersistenceMode =
  | { readonly mode: "encrypted" }
  | { readonly mode: "memory_only"; readonly reason: string };

export type TransportStatus =
  | { readonly status: "ready" }
  | { readonly status: "unavailable"; readonly reason: string };

export interface ClipboardEntrySummary {
  readonly id: number;
  readonly kind: "text" | "image";
  readonly mime: string;
  readonly preview: string;
  readonly pinned: boolean;
  readonly byte_len: number;
  readonly dimensions?: {
    readonly width: number;
    readonly height: number;
  };
  readonly media?: MediaRef;
}

export interface ClipboardSnapshot {
  readonly persistence: PersistenceMode;
  readonly transport: TransportStatus;
  readonly locked: "unlocked" | "locked";
  readonly entry_count: number;
  readonly entries: readonly ClipboardEntrySummary[];
}

export interface Backlight {
  readonly device: string;
  readonly brightness: number;
  readonly max_brightness: number;
  readonly controllable: boolean;
}

export interface SystemBrightnessSnapshot {
  readonly available: boolean;
  readonly devices: readonly Backlight[];
}

export interface TelemetryMemory {
  readonly total_bytes: number;
  readonly available_bytes: number;
  readonly used_bytes: number;
  readonly cached_bytes?: number | null;
  readonly buffers_bytes?: number | null;
  readonly reclaimable_bytes?: number | null;
}

export interface TelemetrySwap {
  readonly total_bytes: number;
  readonly free_bytes: number;
  readonly used_bytes: number;
}

export interface TelemetryCpuInfo {
  readonly core_count: number;
  readonly per_core_usage_percent?: readonly (number | null)[];
  readonly frequency_mhz?: number | null;
  readonly model_name?: string | null;
  readonly load_average?: readonly [number, number, number] | null;
  readonly uptime_seconds?: number | null;
}

export interface TelemetryGpuInfo {
  readonly id: string;
  readonly name?: string | null;
  readonly driver?: string | null;
  readonly pci_slot?: string | null;
  readonly utilization_percent?: number | null;
  readonly vram_used_bytes?: number | null;
  readonly vram_total_bytes?: number | null;
  readonly temperature_millicelsius?: number | null;
  readonly power_milliwatts?: number | null;
  readonly clock_mhz?: number | null;
}

export interface TelemetryNetworkInterface {
  readonly name: string;
  readonly up?: boolean | null;
  readonly rx_bytes_per_sec?: number | null;
  readonly tx_bytes_per_sec?: number | null;
  readonly session_rx_bytes: number;
  readonly session_tx_bytes: number;
}

export interface TelemetryNetworkAggregate {
  readonly active_interface_count: number;
  readonly active_interfaces?: readonly string[];
  readonly rx_bytes_per_sec?: number | null;
  readonly tx_bytes_per_sec?: number | null;
  readonly session_rx_bytes: number;
  readonly session_tx_bytes: number;
}

export interface TelemetryNetwork {
  readonly active_interface?: string | null;
  readonly rx_bytes_per_sec?: number | null;
  readonly tx_bytes_per_sec?: number | null;
  readonly session_rx_bytes: number;
  readonly session_tx_bytes: number;
  readonly aggregate?: TelemetryNetworkAggregate | null;
  readonly interfaces?: readonly TelemetryNetworkInterface[];
}

export interface TelemetryMount {
  readonly mount_point: string;
  readonly device: string;
  readonly fs_type: string;
  readonly total_bytes: number;
  readonly available_bytes: number;
  readonly used_bytes: number;
}

export interface TelemetryStorage {
  readonly read_bytes_per_sec?: number | null;
  readonly write_bytes_per_sec?: number | null;
  readonly mounts?: readonly TelemetryMount[];
}

export interface ThermalZone {
  readonly zone: number;
  readonly kind: string;
  readonly temperature_millicelsius: number;
}

export type TelemetryThermalCategory = "cpu" | "gpu" | "nvme" | "battery" | "other";

export interface TelemetryThermalSensor {
  readonly label: string;
  readonly category: TelemetryThermalCategory;
  readonly source: string;
  readonly temperature_millicelsius: number;
}

export type TelemetryRangeKey = "60s" | "5m" | "15m";

export interface TelemetryHistoryWindow {
  readonly bucket_seconds: number;
  readonly latest_bucket_id?: number | null;
  readonly cpu_percent?: readonly (number | null)[];
  readonly memory_percent?: readonly (number | null)[];
  readonly gpu_percent?: readonly (number | null)[];
  readonly net_rx_bytes_per_sec?: readonly (number | null)[];
  readonly net_tx_bytes_per_sec?: readonly (number | null)[];
  readonly aggregate_net_rx_bytes_per_sec?: readonly (number | null)[];
  readonly aggregate_net_tx_bytes_per_sec?: readonly (number | null)[];
  readonly disk_read_bytes_per_sec?: readonly (number | null)[];
  readonly disk_write_bytes_per_sec?: readonly (number | null)[];
}

export interface TelemetryHistory {
  readonly window_60s: TelemetryHistoryWindow;
  readonly window_5m: TelemetryHistoryWindow;
  readonly window_15m: TelemetryHistoryWindow;
}

export interface SystemTelemetrySnapshot {
  readonly cpu_usage_percent: number | null;
  readonly memory: TelemetryMemory | null;
  readonly temperatures: readonly ThermalZone[];
  readonly poll_interval_ms?: number | null;
  readonly cpu?: TelemetryCpuInfo | null;
  readonly swap?: TelemetrySwap | null;
  readonly gpus?: readonly TelemetryGpuInfo[];
  readonly network?: TelemetryNetwork | null;
  readonly storage?: TelemetryStorage | null;
  readonly sensors?: readonly TelemetryThermalSensor[];
  readonly history?: TelemetryHistory | null;
}

export interface SystemUserSnapshot {
  readonly uid: number;
  readonly username: string | null;
  readonly display_name: string | null;
  readonly avatar: MediaRef | null;
}

export type IdleAction =
  | "lock"
  | "screen_off"
  | "suspend"
  | "lock_and_suspend"
  | { readonly custom_command: readonly string[] };

export interface IdleRule {
  readonly name: string;
  readonly enabled: boolean;
  readonly timeout_seconds: number;
  readonly locked_timeout_seconds: number | null;
  readonly action: IdleAction;
  readonly resume_command: readonly string[] | null;
  readonly pre_action_fade_seconds: number;
}

export interface IdleInhibitor {
  readonly source:
    | { readonly source: "caffeine" }
    | { readonly source: "media_playback" }
    | { readonly source: "screen_saver"; readonly connection: string; readonly cookie: number }
    | { readonly source: "bus_plugin"; readonly cookie: number };
  readonly scope: "idle" | "sleep" | "lock";
  readonly reason: string;
}

export interface WarningFade {
  readonly token: number;
  readonly fade_seconds: number;
  readonly rules: readonly string[];
}

export type IdleServiceStatus =
  | { readonly status: "running" }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "stopped" };

export interface IdleSnapshot {
  readonly caffeine: boolean;
  readonly media_playing: boolean;
  readonly active_inhibitors: readonly IdleInhibitor[];
  readonly warning: WarningFade | null;
  readonly rules: readonly IdleRule[];
  readonly service_status: IdleServiceStatus;
}

export const TOP_BAR_HEIGHT = 32;
export const VERTICAL_BAR_WIDTH = 40;
export const DOCKED_TOP_BAR_HEIGHT = 38;
export const DOCKED_VERTICAL_BAR_WIDTH = 44;

export const PANEL_MAX_HEIGHTS = {
  "quick-settings": 760,
  calendar: 760,
  media: 560,
  battery: 520,
  "system-monitor": 760,
  clipboard: 620,
  plugin: 760,
} as const;

const MAX_SURFACE_NAME_LEN = 128;

/**
 * Formats a shell surface identifier (`LayerSurface`, `PopupSurface`, `SessionLockSurface`)
 * to match zgui-js's lowercase `[a-z0-9][a-z0-9._-]{0,127}` and non-`"main"` contract while
 * keeping raw Wayland output names intact for the `output` prop.
 */
export function formatSurfaceName(prefix: string, id: string): string {
  const cleanPrefix = prefix
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "");
  const cleanId = id
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const combined = `${cleanPrefix || "surface"}-${cleanId || "default"}`.slice(0, MAX_SURFACE_NAME_LEN);
  return combined === "main" ? "surface-main" : combined;
}

export interface LogicalSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Resolves a monitor's logical Wayland pixel size for `LayerSurface` geometry.
 * Prefers `wayland.outputs` (`xdg_output` logical size, accurate under fractional scaling)
 * and falls back to the host `Monitor` dimensions when `wayland.outputs` is unavailable.
 */
export function resolveMonitorLogicalSize(
  monitor: Pick<Monitor, "width" | "height"> & {
    readonly name?: string;
    readonly id?: string;
    readonly logicalWidth?: number;
    readonly logicalHeight?: number;
  },
  outputs?: WaylandOutputsSnapshot,
): LogicalSize {
  const matched = outputs?.outputs.find(
    output => output.name !== null
      && (output.name === monitor.name || output.name === monitor.id)
      && output.width !== null && output.width > 0
      && output.height !== null && output.height > 0,
  );
  if (matched && matched.width !== null && matched.height !== null) {
    return { width: matched.width, height: matched.height };
  }
  if (
    monitor.logicalWidth !== undefined && monitor.logicalWidth > 0
    && monitor.logicalHeight !== undefined && monitor.logicalHeight > 0
  ) {
    return { width: monitor.logicalWidth, height: monitor.logicalHeight };
  }
  return { width: monitor.width, height: monitor.height };
}

export function resolveActiveMonitor(
  monitors: readonly Monitor[],
  options: {
    readonly preferredMonitorId?: string | null | undefined;
    readonly windows?: WaylandWindowsSnapshot | undefined;
    readonly outputs?: WaylandOutputsSnapshot | undefined;
    readonly lastMonitorId?: string | null | undefined;
  } = {},
): Monitor | undefined {
  if (monitors.length === 0) return undefined;
  if (options.preferredMonitorId) {
    const preferred = monitors.find(monitor => monitor.id === options.preferredMonitorId);
    if (preferred) return preferred;
  }
  const activated = options.windows?.windows.find(window => window.activated);
  if (activated && options.outputs) {
    for (const outputInstanceId of activated.output_instance_ids) {
      const output = options.outputs.outputs.find(
        candidate => candidate.output_instance_id === outputInstanceId,
      );
      if (!output?.name) continue;
      const matched = monitors.find(
        monitor => monitor.name === output.name || monitor.id === output.name,
      );
      if (matched) return matched;
    }
  }
  if (options.lastMonitorId) {
    const remembered = monitors.find(monitor => monitor.id === options.lastMonitorId);
    if (remembered) return remembered;
  }
  return monitors[0];
}

export interface BarShadowBleed {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface ResolvedBarLayout {
  readonly position: BarPosition;
  readonly style: BarStyle;
  readonly isVertical: boolean;
  readonly anchor: readonly LayerAnchor[];
  readonly margin: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
  readonly shadowBleed: BarShadowBleed;
  readonly width: number;
  readonly height: number;
  readonly exclusiveZone: number;
  readonly inputRegion?: readonly BarAnchorBox[];
}

const ZERO_SHADOW_BLEED: BarShadowBleed = { top: 0, right: 0, bottom: 0, left: 0 };

export function resolveBarLayout(
  bar: BarSettings | undefined,
  monitor: Pick<Monitor, "width" | "height"> & {
    readonly name?: string;
    readonly id?: string;
    readonly logicalWidth?: number;
    readonly logicalHeight?: number;
  },
  outputs?: WaylandOutputsSnapshot,
): ResolvedBarLayout {
  const settings = bar ?? DEFAULT_BAR_SETTINGS;
  const style: BarStyle = settings.style ?? "floating";
  const docked = style === "docked";
  const { edge_overrides: edges, gaps } = settings;
  const size = resolveMonitorLogicalSize(monitor, outputs);

  if (settings.position === "top") {
    if (docked) {
      return {
        position: "top",
        style,
        isVertical: false,
        anchor: ["top", "left", "right"],
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        shadowBleed: ZERO_SHADOW_BLEED,
        width: Math.max(240, size.width),
        height: DOCKED_TOP_BAR_HEIGHT,
        exclusiveZone: DOCKED_TOP_BAR_HEIGHT,
      };
    }
    const desiredTop = edges.top ?? gaps;
    const desiredRight = edges.right ?? gaps;
    const desiredLeft = edges.left ?? gaps;
    // Expand the transparent LayerSurface around floating islands so drop shadows
    // fade to alpha=0 without clipping, while keeping exclusiveZone and inputRegion
    // strictly on the 32px island band.
    const shadowBleed: BarShadowBleed = {
      top: Math.min(desiredTop, 10),
      right: Math.min(desiredRight, 14),
      bottom: 22,
      left: Math.min(desiredLeft, 14),
    };
    const margin = {
      top: desiredTop - shadowBleed.top,
      right: desiredRight - shadowBleed.right,
      bottom: edges.bottom ?? 0,
      left: desiredLeft - shadowBleed.left,
    };
    const width = Math.max(240, size.width - margin.left - margin.right);
    const height = TOP_BAR_HEIGHT + shadowBleed.top + shadowBleed.bottom;
    return {
      position: "top",
      style,
      isVertical: false,
      anchor: ["top", "left", "right"],
      margin,
      shadowBleed,
      width,
      height,
      exclusiveZone: TOP_BAR_HEIGHT + desiredTop,
      inputRegion: [{
        x: shadowBleed.left,
        y: shadowBleed.top,
        width: Math.max(1, width - shadowBleed.left - shadowBleed.right),
        height: TOP_BAR_HEIGHT,
      }],
    };
  }

  if (settings.position === "left") {
    if (docked) {
      return {
        position: "left",
        style,
        isVertical: true,
        anchor: ["left", "top", "bottom"],
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        shadowBleed: ZERO_SHADOW_BLEED,
        width: DOCKED_VERTICAL_BAR_WIDTH,
        height: Math.max(240, size.height),
        exclusiveZone: DOCKED_VERTICAL_BAR_WIDTH,
      };
    }
    const desiredTop = edges.top ?? gaps;
    const desiredBottom = edges.bottom ?? gaps;
    const desiredLeft = edges.left ?? gaps;
    const shadowBleed: BarShadowBleed = {
      top: Math.min(desiredTop, 10),
      right: 22,
      bottom: Math.min(desiredBottom, 22),
      left: Math.min(desiredLeft, 14),
    };
    const margin = {
      top: desiredTop - shadowBleed.top,
      right: edges.right ?? 0,
      bottom: desiredBottom - shadowBleed.bottom,
      left: desiredLeft - shadowBleed.left,
    };
    const width = VERTICAL_BAR_WIDTH + shadowBleed.left + shadowBleed.right;
    const height = Math.max(240, size.height - margin.top - margin.bottom);
    return {
      position: "left",
      style,
      isVertical: true,
      anchor: ["left", "top", "bottom"],
      margin,
      shadowBleed,
      width,
      height,
      exclusiveZone: VERTICAL_BAR_WIDTH + desiredLeft,
      inputRegion: [{
        x: shadowBleed.left,
        y: shadowBleed.top,
        width: VERTICAL_BAR_WIDTH,
        height: Math.max(1, height - shadowBleed.top - shadowBleed.bottom),
      }],
    };
  }

  if (docked) {
    return {
      position: "right",
      style,
      isVertical: true,
      anchor: ["right", "top", "bottom"],
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      shadowBleed: ZERO_SHADOW_BLEED,
      width: DOCKED_VERTICAL_BAR_WIDTH,
      height: Math.max(240, size.height),
      exclusiveZone: DOCKED_VERTICAL_BAR_WIDTH,
    };
  }
  const desiredTop = edges.top ?? gaps;
  const desiredRight = edges.right ?? gaps;
  const desiredBottom = edges.bottom ?? gaps;
  const shadowBleed: BarShadowBleed = {
    top: Math.min(desiredTop, 10),
    right: Math.min(desiredRight, 14),
    bottom: Math.min(desiredBottom, 22),
    left: 22,
  };
  const margin = {
    top: desiredTop - shadowBleed.top,
    right: desiredRight - shadowBleed.right,
    bottom: desiredBottom - shadowBleed.bottom,
    left: edges.left ?? 0,
  };
  const width = VERTICAL_BAR_WIDTH + shadowBleed.left + shadowBleed.right;
  const height = Math.max(240, size.height - margin.top - margin.bottom);
  return {
    position: "right",
    style,
    isVertical: true,
    anchor: ["right", "top", "bottom"],
    margin,
    shadowBleed,
    width,
    height,
    exclusiveZone: VERTICAL_BAR_WIDTH + desiredRight,
    inputRegion: [{
      x: shadowBleed.left,
      y: shadowBleed.top,
      width: VERTICAL_BAR_WIDTH,
      height: Math.max(1, height - shadowBleed.top - shadowBleed.bottom),
    }],
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
    const difference = (a.coordinates[index] ?? 0) - (b.coordinates[index] ?? 0);
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

export interface BarAnchorBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Aligns a bar popup anchor to the bar's outer cross-axis extent so `PopupSurface`
 * offsets create a clean gap outside the bar instead of overlapping inner pills.
 */
export function resolveBarPopupAnchor(
  layout: Pick<ResolvedBarLayout, "isVertical" | "width" | "height"> & { readonly shadowBleed?: BarShadowBleed },
  options: {
    readonly align: "center" | "end" | "target";
    readonly targetRect?: BarAnchorBox | null;
  },
): BarAnchorBox {
  const { align, targetRect } = options;
  const bleed = layout.shadowBleed ?? ZERO_SHADOW_BLEED;
  const barWidth = Math.max(1, layout.width - bleed.left - bleed.right);
  const barHeight = Math.max(1, layout.height - bleed.top - bleed.bottom);
  if (layout.isVertical) {
    if (align === "center") {
      return {
        x: bleed.left,
        y: targetRect ? targetRect.y : Math.max(bleed.top, bleed.top + Math.round(barHeight / 2) - 16),
        width: barWidth,
        height: targetRect ? Math.max(1, targetRect.height) : 32,
      };
    }
    if (align === "target" && targetRect) {
      return {
        x: bleed.left,
        y: targetRect.y,
        width: barWidth,
        height: Math.max(1, targetRect.height),
      };
    }
    return {
      x: bleed.left,
      y: targetRect ? targetRect.y : Math.max(bleed.top, bleed.top + barHeight - 1),
      width: barWidth,
      height: targetRect ? Math.max(1, targetRect.height) : 1,
    };
  }

  if (align === "end") {
    return {
      x: Math.max(bleed.left, bleed.left + barWidth - 1),
      y: bleed.top,
      width: 1,
      height: barHeight,
    };
  }
  if (align === "center") {
    return {
      x: targetRect ? targetRect.x : Math.max(bleed.left, bleed.left + Math.round(barWidth / 2) - 1),
      y: bleed.top,
      width: targetRect ? Math.max(1, targetRect.width) : 2,
      height: barHeight,
    };
  }
  if (targetRect) {
    return {
      x: targetRect.x,
      y: bleed.top,
      width: Math.max(1, targetRect.width),
      height: barHeight,
    };
  }
  return {
    x: Math.max(bleed.left, bleed.left + barWidth - 1),
    y: bleed.top,
    width: 1,
    height: barHeight,
  };
}

export function hasWindowsOnMonitor(
  windowsSnapshot: WaylandWindowsSnapshot | undefined,
  outputsSnapshot: WaylandOutputsSnapshot | undefined,
  monitorName: string,
): boolean {
  const openWindows = windowsSnapshot?.windows.filter(window => !window.minimized) ?? [];
  if (openWindows.length === 0) {
    return false;
  }
  const output = outputsSnapshot?.outputs.find(candidate => candidate.name === monitorName);
  if (!output) {
    return true;
  }
  return openWindows.some(window =>
    window.output_instance_ids.length === 0
    || window.output_instance_ids.includes(output.output_instance_id),
  );
}

function normalizeDockAppId(appId: string): string {
  const normalized = appId.trim().toLowerCase();
  return normalized.endsWith(".desktop") ? normalized.slice(0, -".desktop".length) : normalized;
}

function tailSegment(id: string): string {
  const dot = id.lastIndexOf(".");
  return dot >= 0 ? id.slice(dot + 1) : id;
}

export function resolveDesktopApp(
  catalog: readonly DesktopAppSummary[] | undefined,
  appId: string | null | undefined,
): DesktopAppSummary | undefined {
  if (!catalog || catalog.length === 0 || !appId) {
    return undefined;
  }
  const trimmed = appId.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const withDesktop = trimmed.toLowerCase().endsWith(".desktop") ? trimmed : `${trimmed}.desktop`;
  const exact = catalog.find(entry => entry.id === trimmed || entry.id === withDesktop);
  if (exact) {
    return exact;
  }

  const normalized = normalizeDockAppId(trimmed);
  const byId = catalog.find(entry => normalizeDockAppId(entry.id) === normalized);
  if (byId) {
    return byId;
  }

  const byWmClass = catalog.find(entry =>
    entry.startup_wm_class !== undefined
    && normalizeDockAppId(entry.startup_wm_class) === normalized,
  );
  if (byWmClass) {
    return byWmClass;
  }

  const targetTail = tailSegment(normalized);
  if (targetTail.length < 2) {
    return undefined;
  }
  return catalog.find(entry => {
    const entryTail = tailSegment(normalizeDockAppId(entry.id));
    if (entryTail === targetTail) {
      return true;
    }
    return entry.startup_wm_class !== undefined
      && tailSegment(normalizeDockAppId(entry.startup_wm_class)) === targetTail;
  });
}

export function buildDockItems(
  pinnedApps: readonly string[],
  windows: readonly WaylandWindow[],
  catalog?: readonly DesktopAppSummary[],
): {
  readonly pinned: readonly DockEntry[];
  readonly runningOnly: readonly DockEntry[];
} {
  const canonicalKey = (appId: string): string => {
    const resolved = resolveDesktopApp(catalog, appId);
    return normalizeDockAppId(resolved?.id ?? appId);
  };

  const groups = new Map<string, { appId: string; app?: DesktopAppSummary | undefined; windows: WaylandWindow[] }>();
  for (const window of windows) {
    if (window.app_id === null) {
      continue;
    }
    const resolved = resolveDesktopApp(catalog, window.app_id);
    const key = normalizeDockAppId(resolved?.id ?? window.app_id);
    const group = groups.get(key);
    if (group) {
      group.windows.push(window);
      if (!group.app && resolved) group.app = resolved;
    } else {
      groups.set(key, { appId: window.app_id, app: resolved, windows: [window] });
    }
  }

  const pinnedKeys = new Set(pinnedApps.map(canonicalKey));
  const pinned = pinnedApps.map(appId => {
    const resolved = resolveDesktopApp(catalog, appId);
    const appWindows = groups.get(canonicalKey(appId))?.windows ?? [];
    return {
      appId,
      title: resolved?.title ?? appId,
      ...(resolved?.icon ? { icon: resolved.icon } : {}),
      pinned: true,
      windows: appWindows,
      focused: appWindows.some(window => window.activated),
    };
  });
  const runningOnly: DockEntry[] = [];
  for (const [key, group] of groups) {
    if (pinnedKeys.has(key)) {
      continue;
    }
    runningOnly.push({
      appId: group.appId,
      title: group.app?.title ?? group.windows[0]?.title ?? group.appId,
      ...(group.app?.icon ? { icon: group.app.icon } : {}),
      pinned: false,
      windows: group.windows,
      focused: group.windows.some(window => window.activated),
    });
  }
  return { pinned, runningOnly };
}

export function clampOverlayPosition(
  spot: ImeSpotRect | null,
  popupWidth: number,
  popupHeight: number,
  monitor: Pick<Monitor, "width" | "height">,
): { readonly x: number; readonly y: number } {
  const maxX = Math.max(8, monitor.width - popupWidth - 8);
  const maxY = Math.max(8, monitor.height - popupHeight - 8);

  if (spot === null) {
    return {
      x: Math.max(8, Math.min((monitor.width - popupWidth) / 2, maxX)),
      y: maxY,
    };
  }

  const belowY = spot.y + spot.h + 6;
  const preferredY = belowY + popupHeight <= monitor.height - 8
    ? belowY
    : spot.y - popupHeight - 6;
  return {
    x: Math.max(8, Math.min(spot.x, maxX)),
    y: Math.max(8, Math.min(preferredY, maxY)),
  };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const FULL_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const FULL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

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

export interface CalendarCell {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly inMonth: boolean;
  readonly isToday: boolean;
}

export function buildMonthCalendarGrid(
  year: number,
  monthIndex0: number,
  today: { readonly year: number; readonly month: number; readonly day: number },
): readonly CalendarCell[] {
  const firstOfMonth = new Date(year, monthIndex0, 1);
  const leadingDays = (firstOfMonth.getDay() + 6) % 7;
  const gridStart = new Date(year, monthIndex0, 1 - leadingDays);
  const gridYear = gridStart.getFullYear();
  const gridMonth = gridStart.getMonth();
  const gridDay = gridStart.getDate();
  const cells: CalendarCell[] = [];

  for (let index = 0; index < 42; index += 1) {
    const date = new Date(gridYear, gridMonth, gridDay + index);
    const cellYear = date.getFullYear();
    const cellMonth = date.getMonth() + 1;
    const cellDay = date.getDate();
    cells.push({
      year: cellYear,
      month: cellMonth,
      day: cellDay,
      inMonth: date.getMonth() === firstOfMonth.getMonth()
        && cellYear === firstOfMonth.getFullYear(),
      isToday: cellYear === today.year && cellMonth === today.month && cellDay === today.day,
    });
  }

  return cells;
}

export function formatMonthYear(year: number, monthIndex0: number): string {
  const date = new Date(year, monthIndex0, 1);
  return `${FULL_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatFullDate(nowMs: number): string {
  const date = new Date(nowMs);
  return `${FULL_WEEKDAYS[date.getDay()]}, ${date.getDate()} ${FULL_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function formatDurationSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) {
    return "";
  }
  const totalMinutes = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

export function formatTrackTimeUs(us: number | null | undefined): string {
  if (us === null || us === undefined) {
    return "";
  }
  const totalSeconds = Math.max(0, Math.floor(us / 1_000_000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${Math.floor(totalSeconds / 60)}:${pad2(seconds)}`;
}

export function formatBytesGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function formatBytesDecimalGB(bytes: number, decimals = 1): string {
  return `${(Math.max(0, bytes) / 1024 ** 3).toFixed(decimals)} GB`;
}

export function formatBytesShort(bytes: number | null | undefined, compactUnit = false): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  const tib = 1024 ** 4;
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  const kib = 1024;
  if (bytes >= tib) {
    const val = bytes / tib;
    return `${val >= 100 ? Math.round(val) : val.toFixed(1)}${compactUnit ? "T" : " TB"}`;
  }
  if (bytes >= gib) {
    const val = bytes / gib;
    return `${val >= 100 ? Math.round(val) : val.toFixed(1)}${compactUnit ? "G" : " GB"}`;
  }
  if (bytes >= mib) {
    const val = bytes / mib;
    return `${val >= 10 ? Math.round(val) : val.toFixed(1)}${compactUnit ? "M" : " MB"}`;
  }
  if (bytes >= kib) {
    return `${Math.round(bytes / kib)}${compactUnit ? "K" : " KB"}`;
  }
  return `${Math.round(bytes)}${compactUnit ? "B" : " B"}`;
}

export function formatRateBytesPerSec(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps) || bps < 0) {
    return "—";
  }
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  const kib = 1024;
  if (bps >= gib) {
    const val = bps / gib;
    return `${val >= 10 ? Math.round(val) : val.toFixed(1)} GB/s`;
  }
  if (bps >= mib) {
    const val = bps / mib;
    return `${val >= 10 ? Math.round(val) : val.toFixed(1)} MB/s`;
  }
  if (bps >= kib) {
    const val = bps / kib;
    return `${val >= 10 ? Math.round(val) : val.toFixed(1)} KB/s`;
  }
  return `${Math.round(bps)} B/s`;
}

export function formatFrequencyMhz(mhz: number | null | undefined, ghzDecimals = 1): string {
  if (mhz === null || mhz === undefined || !Number.isFinite(mhz) || mhz <= 0) {
    return "";
  }
  if (mhz >= 1000) {
    return `${(mhz / 1000).toFixed(ghzDecimals)} GHz`;
  }
  return `${Math.round(mhz)} MHz`;
}

export function formatUptimeCompact(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

export function formatPollInterval(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  if (ms >= 1000 && ms % 1000 === 0) {
    return `${ms / 1000}s`;
  }
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms)}ms`;
}

export interface MemoryBreakdown {
  readonly totalBytes: number;
  readonly availableBytes: number;
  readonly usedBytes: number;
  readonly cacheBytes: number | null;
  readonly visualCacheBytes: number;
  readonly usedPercent: number;
  readonly activePercent: number;
  readonly cachePercent: number;
}

/**
 * Computes non-overlapping Memory bar percentages from `used_bytes = total - available`
 * while clamping optional kernel cache (`cached + buffers + reclaimable`) strictly to the
 * remaining available headroom so `activePercent + cachePercent <= 100`.
 */
export function computeMemoryBreakdown(memory: TelemetryMemory | null | undefined): MemoryBreakdown | null {
  if (!memory || memory.total_bytes <= 0) {
    return null;
  }
  const totalBytes = memory.total_bytes;
  const usedBytes = Math.max(0, Math.min(totalBytes, memory.used_bytes));
  const availableBytes = Math.max(0, Math.min(totalBytes, memory.available_bytes));
  const hasCacheField = memory.cached_bytes != null || memory.buffers_bytes != null || memory.reclaimable_bytes != null;
  const cacheBytes = hasCacheField
    ? Math.max(0, (memory.cached_bytes ?? 0) + (memory.buffers_bytes ?? 0) + (memory.reclaimable_bytes ?? 0))
    : null;
  const remainingHeadroom = Math.max(0, totalBytes - usedBytes);
  const visualCacheBytes = cacheBytes === null ? 0 : Math.min(cacheBytes, remainingHeadroom);
  const activePercent = Math.min(100, Math.max(0, (usedBytes / totalBytes) * 100));
  const cachePercent = Math.min(100 - activePercent, Math.max(0, (visualCacheBytes / totalBytes) * 100));
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    cacheBytes,
    visualCacheBytes,
    usedPercent: activePercent,
    activePercent,
    cachePercent,
  };
}

export function selectPrimaryGpu(gpus: readonly TelemetryGpuInfo[] | null | undefined): TelemetryGpuInfo | null {
  return gpus && gpus.length > 0 ? gpus[0]! : null;
}

export function selectHeadlineTempCelsius(snapshot: SystemTelemetrySnapshot | null | undefined): number | null {
  if (!snapshot) return null;
  const sensors = snapshot.sensors ?? [];
  const cpuSensor = sensors.find(sensor => sensor.category === "cpu");
  if (cpuSensor) return Math.round(cpuSensor.temperature_millicelsius / 1000);
  if (sensors.length > 0) return Math.round(sensors[0]!.temperature_millicelsius / 1000);
  return maxThermalCelsius(snapshot.temperatures ?? []);
}

export interface NetworkDisplaySelection {
  readonly label: string | null;
  readonly rxBytesPerSec: number | null;
  readonly txBytesPerSec: number | null;
  readonly sessionRxBytes: number;
  readonly sessionTxBytes: number;
  readonly rxHistory: readonly (number | null)[] | undefined;
  readonly txHistory: readonly (number | null)[] | undefined;
  readonly isAggregate: boolean;
}

/**
 * Selects truthful network display metrics and chart series across daemon versions:
 * - New daemons emitting `net.aggregate`: reports aggregated active-eligible non-loopback
 *   throughput/totals, formats single active NIC by name, `"N active"` when >1, or `null` when 0,
 *   and reads `aggregate_net_*` history without mixing single-interface series.
 * - Older daemons without `net.aggregate`: falls back cleanly to legacy single-interface
 *   `active_interface`, rates, session totals, and `net_rx/tx_bytes_per_sec` history.
 */
export function selectNetworkDisplay(
  net: TelemetryNetwork | null | undefined,
  history?: TelemetryHistoryWindow | null,
): NetworkDisplaySelection | null {
  if (!net) return null;
  const agg = net.aggregate;
  if (agg) {
    const activeNames = agg.active_interfaces ?? [];
    const activeCount = agg.active_interface_count;
    const label = activeCount > 1
      ? `${activeCount} active`
      : activeCount === 1
        ? (activeNames[0] ?? net.active_interface ?? null)
        : null;
    return {
      label,
      rxBytesPerSec: agg.rx_bytes_per_sec ?? null,
      txBytesPerSec: agg.tx_bytes_per_sec ?? null,
      sessionRxBytes: agg.session_rx_bytes,
      sessionTxBytes: agg.session_tx_bytes,
      rxHistory: history?.aggregate_net_rx_bytes_per_sec,
      txHistory: history?.aggregate_net_tx_bytes_per_sec,
      isAggregate: true,
    };
  }
  return {
    label: net.active_interface ?? null,
    rxBytesPerSec: net.rx_bytes_per_sec ?? null,
    txBytesPerSec: net.tx_bytes_per_sec ?? null,
    sessionRxBytes: net.session_rx_bytes,
    sessionTxBytes: net.session_tx_bytes,
    rxHistory: history?.net_rx_bytes_per_sec,
    txHistory: history?.net_tx_bytes_per_sec,
    isAggregate: false,
  };
}

export function selectTelemetryHistoryWindow(
  snapshot: SystemTelemetrySnapshot | null | undefined,
  range: TelemetryRangeKey,
): TelemetryHistoryWindow | null {
  const history = snapshot?.history;
  if (!history) return null;
  switch (range) {
    case "60s":
      return history.window_60s;
    case "5m":
      return history.window_5m;
    case "15m":
      return history.window_15m;
  }
}

export function maxThermalCelsius(zones: readonly ThermalZone[]): number | null {
  if (zones.length === 0) {
    return null;
  }
  let maximum = -Infinity;
  for (const zone of zones) {
    maximum = Math.max(maximum, zone.temperature_millicelsius);
  }
  return Math.round(maximum / 1000);
}

/**
 * Resolves the active clipboard entry by stable `entry.id` so inserting new entries at the top
 * does not shift selection, while deleting the active entry falls back cleanly to an adjacent row.
 */
export function resolveClipboardSelection<T extends { readonly id: number }>(
  entries: readonly T[],
  selectedId: number | null,
  fallbackIndex: number,
): { readonly index: number; readonly entry: T | null } {
  if (entries.length === 0) return { index: -1, entry: null };
  if (selectedId !== null) {
    const found = entries.findIndex(entry => entry.id === selectedId);
    if (found >= 0) return { index: found, entry: entries[found]! };
  }
  const index = Math.max(0, Math.min(fallbackIndex, entries.length - 1));
  return { index, entry: entries[index]! };
}
