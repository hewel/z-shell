import { describe, expect, test } from "bun:test";

import { activeMotionTickerCount } from "@z-shell/sdk/zgui";
import {
  THROUGHPUT_SCALE_FLOOR_BPS,
  buildSparklinePaths,
  buildSplitDualArcPaths,
  classifyHistoryTransition,
  createChartScrollController,
  formatThroughputAxisLabel,
  niceThroughputCeiling,
  resolveThroughputScale,
} from "../src/charts.ts";
import {
  DEFAULT_BAR_SETTINGS,
  DOCKED_TOP_BAR_HEIGHT,
  DOCKED_VERTICAL_BAR_WIDTH,
  PANEL_MAX_HEIGHTS,
  TOP_BAR_HEIGHT,
  VERTICAL_BAR_WIDTH,
  buildDockItems,
  buildMonthCalendarGrid,
  clampOverlayPosition,
  computeMemoryBreakdown,
  filterWorkspacesForMonitor,
  findActiveWindowForMonitor,
  formatBarClock,
  formatBytesDecimalGB,
  formatBytesGiB,
  formatBytesShort,
  formatDurationSeconds,
  formatFrequencyMhz,
  formatFullDate,
  formatKeepAwakeRemaining,
  formatMonthYear,
  formatNotificationBody,
  formatPollInterval,
  formatRateBytesPerSec,
  formatSurfaceName,
  formatTrackTimeUs,
  formatUptimeCompact,
  groupNotificationPopups,
  hasWindowsOnMonitor,
  isImeTrayItem,
  isMediaPlayerAudible,
  maxThermalCelsius,
  notificationGroupKey,
  partitionPluginBarWidgets,
  partitionTrayItems,
  resolveActiveMonitor,
  resolveBarLayout,
  resolveBarPopupAnchor,
  resolveClipboardSelection,
  resolveDesktopApp,
  resolveMonitorLogicalSize,
  resolveMonitorWallpaper,
  resolveNotificationMediaLayout,
  resolvePinnedOutput,
  resolveWorkspaceLabel,
  selectActiveMediaPlayer,
  selectHeadlineTempCelsius,
  selectNetworkDisplay,
  selectPrimaryGpu,
  selectTelemetryHistoryWindow,
  splitNotificationActions,
  supportsOsSleepBlock,
  supportsTimedKeepAwake,
  trayRuleKey,
  type ActiveWallpaper,
  type BarPosition,
  type NotificationItem,
  type TrayItem,
  type BarSettings,
  type DesktopAppSummary,
  type DesktopMediaSnapshot,
  type EdgeOverrides,
  type MediaPlayer,
  type SystemAudioSnapshot,
  type SystemTelemetrySnapshot,
  type TelemetryHistoryWindow,
  type TelemetryNetwork,
  type WallpaperSnapshot,
  type WaylandOutput,
  type WaylandOutputsSnapshot,
  type WaylandWindow,
  type WaylandWindowsSnapshot,
  type WaylandWorkspace,
  type WaylandWorkspacesSnapshot,
} from "../src/topics.ts";

function makeBarSettings(
  position: BarPosition,
  gaps = 14,
  edges: Partial<EdgeOverrides> = {},
): BarSettings {
  return {
    ...DEFAULT_BAR_SETTINGS,
    position,
    gaps,
    edge_overrides: { top: null, right: null, bottom: null, left: null, ...edges },
  };
}

function makeWallpaper(sourcePath: string): ActiveWallpaper {
  return {
    source_path: sourcePath,
    media: { kind: "runtime_path", path: sourcePath, mime: "image/png", revision: 1 },
    width: 1920,
    height: 1080,
    fit: "cover",
  };
}

function makeWallpaperSnapshot(
  current: ActiveWallpaper | null,
  perOutput: Readonly<Record<string, ActiveWallpaper>> = {},
): WallpaperSnapshot {
  return {
    available: current !== null || Object.keys(perOutput).length > 0,
    fit: "cover",
    sync_theme: true,
    slideshow_seconds: 300,
    catalog_count: 2,
    current,
    per_output: perOutput,
    last_error: null,
  };
}

function makeOutput(outputInstanceId: number, name: string): WaylandOutput {
  return {
    output_instance_id: outputInstanceId,
    name,
    description: name,
    make: "Test",
    model: name,
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
    mode_width: 1920,
    mode_height: 1080,
    refresh_mhz: 60_000,
    scale: 1,
    physical_width_mm: 600,
    physical_height_mm: 340,
  };
}

function makeOutputs(...outputs: readonly WaylandOutput[]): WaylandOutputsSnapshot {
  return { capability: "controllable", outputs };
}

function makeWorkspace(
  workspaceId: number,
  groupId: number | null,
  coordinates: readonly number[],
  hidden = false,
): WaylandWorkspace {
  return {
    workspace_id: workspaceId,
    group_id: groupId,
    name: `Workspace ${workspaceId}`,
    id_str: String(workspaceId),
    coordinates,
    active: false,
    urgent: false,
    hidden,
    capabilities: ["activate"],
  };
}

function makeWorkspaces(
  workspaces: readonly WaylandWorkspace[],
  groups: WaylandWorkspacesSnapshot["groups"] = [],
): WaylandWorkspacesSnapshot {
  return { capability: "controllable", groups, workspaces };
}

function makeWindow(
  windowId: number,
  activated: boolean,
  outputInstanceIds: readonly number[],
): WaylandWindow {
  return {
    window_id: windowId,
    title: `Window ${windowId}`,
    app_id: `app-${windowId}`,
    activated,
    minimized: false,
    maximized: false,
    fullscreen: false,
    output_instance_ids: outputInstanceIds,
  };
}

function makeWindows(...windows: readonly WaylandWindow[]): WaylandWindowsSnapshot {
  return { capability: "controllable", windows };
}

function makePlayer(id: string, playbackStatus: MediaPlayer["playback_status"]): MediaPlayer {
  return {
    id,
    identity: id,
    playback_status: playbackStatus,
    position_us: null,
    metadata: {
      track_id: null,
      title: id,
      album: null,
      artists: [],
      length_us: null,
    },
    capabilities: {
      can_control: true,
      can_play: true,
      can_pause: true,
      can_go_next: true,
      can_go_previous: true,
      can_seek: true,
    },
  };
}

function makeMedia(
  players: readonly MediaPlayer[],
  selectedPlayerId: string | null = null,
): DesktopMediaSnapshot {
  return {
    available: players.length > 0,
    players,
    selected_player_id: selectedPlayerId,
    any_playing: players.some(player => player.playback_status === "playing"),
    cover: null,
  };
}

describe("resolveBarLayout", () => {
  test("resolves a floating top bar with shadow bleed while preserving exact 42px strut at gap 10", () => {
    expect(resolveBarLayout(makeBarSettings("top", 10), { width: 1280, height: 720 })).toEqual({
      position: "top",
      style: "floating",
      isVertical: false,
      anchor: ["top", "left", "right"],
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      shadowBleed: { top: 10, right: 10, bottom: 22, left: 10 },
      width: 1280,
      height: TOP_BAR_HEIGHT + 32,
      exclusiveZone: 42,
      inputRegion: [{ x: 10, y: 10, width: 1260, height: TOP_BAR_HEIGHT }],
    });
  });

  test("resolves a floating left vertical bar with shadow bleed and 52px strut at gap 12", () => {
    expect(resolveBarLayout(makeBarSettings("left", 12), { width: 1920, height: 1080 })).toEqual({
      position: "left",
      style: "floating",
      isVertical: true,
      anchor: ["left", "top", "bottom"],
      margin: { top: 2, right: 0, bottom: 0, left: 0 },
      shadowBleed: { top: 10, right: 22, bottom: 12, left: 12 },
      width: VERTICAL_BAR_WIDTH + 34,
      height: 1078,
      exclusiveZone: 52,
      inputRegion: [{ x: 12, y: 10, width: VERTICAL_BAR_WIDTH, height: 1056 }],
    });
  });

  test("resolves a floating right vertical bar", () => {
    expect(resolveBarLayout(makeBarSettings("right", 12), { width: 1920, height: 1080 })).toEqual({
      position: "right",
      style: "floating",
      isVertical: true,
      anchor: ["right", "top", "bottom"],
      margin: { top: 2, right: 0, bottom: 0, left: 0 },
      shadowBleed: { top: 10, right: 12, bottom: 12, left: 22 },
      width: VERTICAL_BAR_WIDTH + 34,
      height: 1078,
      exclusiveZone: 52,
      inputRegion: [{ x: 22, y: 10, width: VERTICAL_BAR_WIDTH, height: 1056 }],
    });
  });

  test("resolves docked top (38px flush) and docked left (44px flush) bars with zero outer margin and zero shadow bleed", () => {
    expect(resolveBarLayout({ ...makeBarSettings("top", 14), style: "docked" }, { width: 1440, height: 900 })).toEqual({
      position: "top",
      style: "docked",
      isVertical: false,
      anchor: ["top", "left", "right"],
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      shadowBleed: { top: 0, right: 0, bottom: 0, left: 0 },
      width: 1440,
      height: DOCKED_TOP_BAR_HEIGHT,
      exclusiveZone: 38,
    });
    expect(resolveBarLayout({ ...makeBarSettings("left", 14), style: "docked" }, { width: 1440, height: 900 })).toEqual({
      position: "left",
      style: "docked",
      isVertical: true,
      anchor: ["left", "top", "bottom"],
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      shadowBleed: { top: 0, right: 0, bottom: 0, left: 0 },
      width: DOCKED_VERTICAL_BAR_WIDTH,
      height: 900,
      exclusiveZone: 44,
    });
  });

  test("applies non-null edge overrides and falls back to gaps for null edges", () => {
    const layout = resolveBarLayout(
      makeBarSettings("top", 14, { top: 3, bottom: 9 }),
      { width: 1280, height: 720 },
    );

    expect(layout.margin).toEqual({ top: 0, right: 0, bottom: 9, left: 0 });
    expect(layout.shadowBleed).toEqual({ top: 3, right: 14, bottom: 22, left: 14 });
    expect(layout.width).toBe(1280);
    expect(layout.inputRegion).toEqual([{ x: 14, y: 3, width: 1252, height: TOP_BAR_HEIGHT }]);
    expect(layout.exclusiveZone).toBe(35);
  });

  test("uses default settings and enforces the minimum bar extent", () => {
    const layout = resolveBarLayout(undefined, { width: 200, height: 200 });

    expect(layout.position).toBe("top");
    expect(layout.style).toBe("floating");
    expect(layout.margin).toEqual({ top: 4, right: 0, bottom: 0, left: 0 });
    expect(layout.shadowBleed).toEqual({ top: 10, right: 14, bottom: 22, left: 14 });
    expect(layout.width).toBe(240);
    expect(layout.height).toBe(TOP_BAR_HEIGHT + 32);
    expect(layout.exclusiveZone).toBe(46);
  });
});

describe("resolveMonitorWallpaper", () => {
  const globalWallpaper = makeWallpaper("/wallpapers/global.png");
  const outputWallpaper = makeWallpaper("/wallpapers/dp-1.png");

  test("prefers a per-output wallpaper", () => {
    const snapshot = makeWallpaperSnapshot(globalWallpaper, { "DP-1": outputWallpaper });

    expect(resolveMonitorWallpaper(snapshot, "DP-1")).toBe(outputWallpaper);
  });

  test("falls back to the global wallpaper for an unassigned output", () => {
    const snapshot = makeWallpaperSnapshot(globalWallpaper, { "DP-1": outputWallpaper });

    expect(resolveMonitorWallpaper(snapshot, "HDMI-A-1")).toBe(globalWallpaper);
  });

  test("returns null without a snapshot or any assigned wallpaper", () => {
    expect(resolveMonitorWallpaper(undefined, "DP-1")).toBeNull();
    expect(resolveMonitorWallpaper(makeWallpaperSnapshot(null), "DP-1")).toBeNull();
  });
});

describe("filterWorkspacesForMonitor", () => {
  const outputs = makeOutputs(makeOutput(11, "DP-1"), makeOutput(22, "HDMI-A-1"));

  test("selects visible workspaces from every group assigned to the output", () => {
    const dpOnly = makeWorkspace(1, 1, [0]);
    const shared = makeWorkspace(2, 3, [1]);
    const workspaces = makeWorkspaces([
      makeWorkspace(3, 2, [0]),
      shared,
      makeWorkspace(4, 1, [2], true),
      makeWorkspace(5, null, [0]),
      dpOnly,
    ], [
      { group_id: 1, output_instance_ids: [11] },
      { group_id: 2, output_instance_ids: [22] },
      { group_id: 3, output_instance_ids: [11, 22] },
    ]);

    expect(filterWorkspacesForMonitor(workspaces, outputs, "DP-1")).toEqual([dpOnly, shared]);
  });

  test("sorts coordinates lexicographically with prefix and id tie-breaks", () => {
    const workspaces = makeWorkspaces([
      makeWorkspace(9, null, [1]),
      makeWorkspace(8, null, [0, 2, 1]),
      makeWorkspace(7, null, [0, 10]),
      makeWorkspace(6, null, [0, 2]),
      makeWorkspace(5, null, [0, 2]),
      makeWorkspace(4, null, [0]),
    ]);

    expect(
      filterWorkspacesForMonitor(workspaces, outputs, "unknown").map(workspace => workspace.workspace_id),
    ).toEqual([4, 5, 6, 8, 7, 9]);
  });

  test("falls back to all visible workspaces when the output is unmatched", () => {
    const workspaces = makeWorkspaces([
      makeWorkspace(1, 1, [1]),
      makeWorkspace(2, null, [0]),
      makeWorkspace(3, 2, [2], true),
    ], [{ group_id: 1, output_instance_ids: [11] }]);

    expect(
      filterWorkspacesForMonitor(workspaces, outputs, "DP-9").map(workspace => workspace.workspace_id),
    ).toEqual([2, 1]);
  });

  test("returns an empty list without workspace state", () => {
    expect(filterWorkspacesForMonitor(undefined, outputs, "DP-1")).toEqual([]);
  });
});

describe("findActiveWindowForMonitor", () => {
  const outputs = makeOutputs(makeOutput(11, "DP-1"), makeOutput(22, "HDMI-A-1"));

  test("prefers the activated window on the requested output", () => {
    const elsewhere = makeWindow(1, true, [22]);
    const onMonitor = makeWindow(2, true, [11]);
    const inactive = makeWindow(3, false, [11]);

    expect(findActiveWindowForMonitor(makeWindows(elsewhere, inactive, onMonitor), outputs, "DP-1"))
      .toBe(onMonitor);
  });

  test("falls back to the first globally activated window", () => {
    const first = makeWindow(1, true, [22]);
    const second = makeWindow(2, true, [22]);

    expect(findActiveWindowForMonitor(makeWindows(first, second), outputs, "DP-1")).toBe(first);
  });

  test("returns null when no window is active", () => {
    expect(findActiveWindowForMonitor(makeWindows(makeWindow(1, false, [11])), outputs, "DP-1"))
      .toBeNull();
    expect(findActiveWindowForMonitor(undefined, outputs, "DP-1")).toBeNull();
  });
});

describe("selectActiveMediaPlayer", () => {
  test("prefers the explicitly selected player over a playing player", () => {
    const playing = makePlayer("playing", "playing");
    const selected = makePlayer("selected", "paused");

    expect(selectActiveMediaPlayer(makeMedia([playing, selected], "selected"))).toBe(selected);
  });

  test("selects the first playing player when there is no valid selection", () => {
    const paused = makePlayer("paused", "paused");
    const firstPlaying = makePlayer("first-playing", "playing");
    const secondPlaying = makePlayer("second-playing", "playing");

    expect(selectActiveMediaPlayer(makeMedia([paused, firstPlaying, secondPlaying], "missing")))
      .toBe(firstPlaying);
  });

  test("falls back to the first player, then null", () => {
    const first = makePlayer("first", "stopped");
    const second = makePlayer("second", "paused");

    expect(selectActiveMediaPlayer(makeMedia([first, second]))).toBe(first);
    expect(selectActiveMediaPlayer(makeMedia([]))).toBeNull();
    expect(selectActiveMediaPlayer(undefined)).toBeNull();
  });
});

describe("isMediaPlayerAudible", () => {
  function makeAudio(
    overrides: Partial<SystemAudioSnapshot> = {},
  ): SystemAudioSnapshot {
    return {
      availability: "available",
      default_sink: "speakers",
      default_source: null,
      sinks: [
        { index: 1, name: "speakers", description: "Speakers", channels: 2, volume: 0.65, muted: false },
        { index: 2, name: "headphones", description: "Headphones", channels: 2, volume: 0, muted: true },
      ],
      sources: [],
      sink_inputs: [],
      source_outputs: [],
      ...overrides,
    };
  }

  test("returns true when playing and the default sink is unmuted with positive volume", () => {
    const playing = makePlayer("spotify", "playing");
    expect(isMediaPlayerAudible(playing, makeAudio())).toBe(true);
  });

  test("returns false for non-playing or missing players", () => {
    const audio = makeAudio();
    expect(isMediaPlayerAudible(makePlayer("spotify", "paused"), audio)).toBe(false);
    expect(isMediaPlayerAudible(makePlayer("spotify", "stopped"), audio)).toBe(false);
    expect(isMediaPlayerAudible(makePlayer("spotify", "unknown"), audio)).toBe(false);
    expect(isMediaPlayerAudible(null, audio)).toBe(false);
    expect(isMediaPlayerAudible(undefined, audio)).toBe(false);
  });

  test("returns false when the default sink is muted or at zero volume", () => {
    const playing = makePlayer("spotify", "playing");
    expect(isMediaPlayerAudible(playing, makeAudio({
      sinks: [{ index: 1, name: "speakers", description: "Speakers", channels: 2, volume: 0.5, muted: true }],
    }))).toBe(false);
    expect(isMediaPlayerAudible(playing, makeAudio({
      sinks: [{ index: 1, name: "speakers", description: "Speakers", channels: 2, volume: 0, muted: false }],
    }))).toBe(false);
  });

  test("does not suppress playback motion when audio telemetry is missing or unavailable", () => {
    const playing = makePlayer("spotify", "playing");
    expect(isMediaPlayerAudible(playing, undefined)).toBe(true);
    expect(isMediaPlayerAudible(playing, makeAudio({
      availability: "unavailable",
      sinks: [{ index: 1, name: "speakers", description: "Speakers", channels: 2, volume: 0, muted: true }],
    }))).toBe(true);
    expect(isMediaPlayerAudible(playing, makeAudio({ default_sink: null }))).toBe(true);
    expect(isMediaPlayerAudible(playing, makeAudio({ default_sink: "missing" }))).toBe(true);
  });
});

describe("buildDockItems", () => {
  test("matches pinned apps case-insensitively and strips the desktop suffix", () => {
    const window = { ...makeWindow(1, false, []), app_id: "firefox" };

    expect(buildDockItems(["FIREFOX.DESKTOP"], [window])).toEqual({
      pinned: [{
        appId: "FIREFOX.DESKTOP",
        title: "FIREFOX.DESKTOP",
        pinned: true,
        windows: [window],
        focused: false,
      }],
      runningOnly: [],
    });
  });

  test("groups multiple windows per app and marks any activated window as focused", () => {
    const first = { ...makeWindow(1, false, []), app_id: "Firefox" };
    const second = { ...makeWindow(2, true, []), app_id: "firefox.desktop" };

    expect(buildDockItems(["firefox"], [first, second])).toEqual({
      pinned: [{
        appId: "firefox",
        title: "firefox",
        pinned: true,
        windows: [first, second],
        focused: true,
      }],
      runningOnly: [],
    });
  });

  test("preserves pinned order and separates running-only apps in first-seen order", () => {
    const gamma = { ...makeWindow(1, true, []), app_id: "Gamma.desktop", title: "Gamma window" };
    const firefox = { ...makeWindow(2, false, []), app_id: "firefox" };
    const alpha = { ...makeWindow(3, false, []), app_id: "ALPHA" };
    const zed = { ...makeWindow(4, false, []), app_id: "Zed" };

    const result = buildDockItems(["Zed", "Firefox"], [gamma, firefox, alpha, zed]);

    expect(result.pinned.map(item => item.appId)).toEqual(["Zed", "Firefox"]);
    expect(result.runningOnly).toEqual([
      {
        appId: "Gamma.desktop",
        title: "Gamma window",
        pinned: false,
        windows: [gamma],
        focused: true,
      },
      {
        appId: "ALPHA",
        title: "Window 3",
        pinned: false,
        windows: [alpha],
        focused: false,
      },
    ]);
  });
});

describe("clampOverlayPosition", () => {
  const monitor = { width: 1200, height: 800 };

  test("centers horizontally and uses the bottom margin when the spot is null", () => {
    expect(clampOverlayPosition(null, 300, 200, monitor)).toEqual({ x: 450, y: 592 });
  });

  test("places the popup below the spot when it fits", () => {
    const spot = { x: 140, y: 220, w: 10, h: 24, relative: true, scale: 1 };

    expect(clampOverlayPosition(spot, 300, 150, monitor)).toEqual({ x: 140, y: 250 });
  });

  test("flips the popup above the spot at the bottom edge", () => {
    const spot = { x: 140, y: 650, w: 10, h: 30, relative: true, scale: 1 };

    expect(clampOverlayPosition(spot, 300, 150, monitor)).toEqual({ x: 140, y: 494 });
  });

  test("clamps horizontal overflow to the 8px left and right margins", () => {
    const leftSpot = { x: -50, y: 200, w: 10, h: 20, relative: true, scale: 1 };
    const rightSpot = { ...leftSpot, x: 1100 };

    expect(clampOverlayPosition(leftSpot, 300, 150, monitor)).toEqual({ x: 8, y: 226 });
    expect(clampOverlayPosition(rightSpot, 300, 150, monitor)).toEqual({ x: 892, y: 226 });
  });

  test("clamps a flipped popup to the 8px top margin", () => {
    const spot = { x: 140, y: 60, w: 10, h: 20, relative: true, scale: 1 };

    expect(clampOverlayPosition(spot, 300, 720, monitor)).toEqual({ x: 140, y: 8 });
  });
});

describe("formatBarClock", () => {
  const morning = new Date(2024, 0, 7, 9, 8, 6).getTime();

  test("formats a 24-hour clock without seconds", () => {
    expect(formatBarClock(morning, { clock24h: true, clockSeconds: false })).toEqual({
      horizontal: "Sun 7 Jan · 09:08",
      hours: "09",
      minutes: "08",
      seconds: "06",
      dateShort: "Sun 7 Jan",
    });
  });

  test("formats a 24-hour clock with seconds", () => {
    expect(formatBarClock(morning, { clock24h: true, clockSeconds: true }).horizontal)
      .toBe("Sun 7 Jan · 09:08:06");
  });

  test("formats 12-hour AM and PM clocks", () => {
    const afternoon = new Date(2024, 0, 7, 15, 8, 6).getTime();

    expect(formatBarClock(morning, { clock24h: false, clockSeconds: false }).horizontal)
      .toBe("Sun 7 Jan · 9:08 AM");
    expect(formatBarClock(afternoon, { clock24h: false, clockSeconds: true }).horizontal)
      .toBe("Sun 7 Jan · 3:08:06 PM");
  });

  test("uses 12 for midnight and noon in 12-hour mode", () => {
    const midnight = new Date(2024, 0, 7, 0, 8, 6).getTime();
    const noon = new Date(2024, 0, 7, 12, 8, 6).getTime();

    expect(formatBarClock(midnight, { clock24h: false, clockSeconds: false }).horizontal)
      .toBe("Sun 7 Jan · 12:08 AM");
    expect(formatBarClock(noon, { clock24h: false, clockSeconds: false }).horizontal)
      .toBe("Sun 7 Jan · 12:08 PM");
  });

  test("keeps padded numeric parts for vertical clock layouts", () => {
    const afternoon = new Date(2024, 0, 7, 15, 8, 6).getTime();
    const clock = formatBarClock(afternoon, { clock24h: false, clockSeconds: true });

    expect(clock.hours).toBe("15");
    expect(clock.minutes).toBe("08");
    expect(clock.seconds).toBe("06");
    expect(clock.dateShort).toBe("Sun 7 Jan");
  });
});

describe("buildMonthCalendarGrid", () => {
  test("builds 42 cells in Monday-first order with adjacent-month dates", () => {
    const grid = buildMonthCalendarGrid(2024, 8, { year: 2024, month: 9, day: 15 });

    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual({ year: 2024, month: 8, day: 26, inMonth: false, isToday: false });
    expect(grid.slice(0, 7).map(cell => cell.day)).toEqual([26, 27, 28, 29, 30, 31, 1]);
    expect(grid[6]).toEqual({ year: 2024, month: 9, day: 1, inMonth: true, isToday: false });
    expect(grid.filter(cell => cell.inMonth)).toHaveLength(30);
    expect(grid[41]).toEqual({ year: 2024, month: 10, day: 6, inMonth: false, isToday: false });
  });

  test("includes all 29 days of February in a leap year", () => {
    const grid = buildMonthCalendarGrid(2024, 1, { year: 2024, month: 1, day: 1 });
    const februaryDays = grid.filter(cell => cell.inMonth).map(cell => cell.day);

    expect(grid[0]).toMatchObject({ year: 2024, month: 1, day: 29, inMonth: false });
    expect(februaryDays).toEqual(Array.from({ length: 29 }, (_, index) => index + 1));
    expect(grid[31]).toMatchObject({ year: 2024, month: 2, day: 29, inMonth: true });
    expect(grid[32]).toMatchObject({ year: 2024, month: 3, day: 1, inMonth: false });
  });

  test("marks only today's cell, including when it belongs to an adjacent month", () => {
    const grid = buildMonthCalendarGrid(2024, 2, { year: 2024, month: 2, day: 29 });

    expect(grid.filter(cell => cell.isToday)).toEqual([
      { year: 2024, month: 2, day: 29, inMonth: false, isToday: true },
    ]);
  });
});

describe("formatMonthYear", () => {
  test("formats the full month name and year", () => {
    expect(formatMonthYear(2024, 1)).toBe("February 2024");
    expect(formatMonthYear(2025, 11)).toBe("December 2025");
  });
});

describe("formatFullDate", () => {
  test("formats the weekday, unpadded day, full month, and year", () => {
    expect(formatFullDate(new Date(2024, 1, 29).getTime())).toBe("Thursday, 29 February 2024");
    expect(formatFullDate(new Date(2024, 0, 7).getTime())).toBe("Sunday, 7 January 2024");
  });
});

describe("formatDurationSeconds", () => {
  test("returns an empty string for missing values and clamps negative durations", () => {
    expect(formatDurationSeconds(null)).toBe("");
    expect(formatDurationSeconds(undefined)).toBe("");
    expect(formatDurationSeconds(-1)).toBe("0m");
  });

  test("formats whole minutes and omits zero hour or minute components", () => {
    expect(formatDurationSeconds(0)).toBe("0m");
    expect(formatDurationSeconds(59)).toBe("0m");
    expect(formatDurationSeconds(60)).toBe("1m");
    expect(formatDurationSeconds(3599)).toBe("59m");
    expect(formatDurationSeconds(3600)).toBe("1h");
    expect(formatDurationSeconds(3660)).toBe("1h 1m");
    expect(formatDurationSeconds(7325)).toBe("2h 2m");
  });
});

describe("formatTrackTimeUs", () => {
  test("returns an empty string for missing values and clamps negative times", () => {
    expect(formatTrackTimeUs(null)).toBe("");
    expect(formatTrackTimeUs(undefined)).toBe("");
    expect(formatTrackTimeUs(-1)).toBe("0:00");
  });

  test("formats microseconds as minutes and zero-padded seconds", () => {
    expect(formatTrackTimeUs(0)).toBe("0:00");
    expect(formatTrackTimeUs(999_999)).toBe("0:00");
    expect(formatTrackTimeUs(1_000_000)).toBe("0:01");
    expect(formatTrackTimeUs(61_000_000)).toBe("1:01");
    expect(formatTrackTimeUs(3_599_999_999)).toBe("59:59");
  });

  test("includes hours and pads minutes for tracks at least one hour long", () => {
    expect(formatTrackTimeUs(3_600_000_000)).toBe("1:00:00");
    expect(formatTrackTimeUs(3_661_000_000)).toBe("1:01:01");
    expect(formatTrackTimeUs(36_000_000_000)).toBe("10:00:00");
  });
});

describe("formatBytesGiB", () => {
  test("converts bytes to binary GiB with one decimal place", () => {
    expect(formatBytesGiB(0)).toBe("0.0 GiB");
    expect(formatBytesGiB(1024 ** 3)).toBe("1.0 GiB");
    expect(formatBytesGiB(32 * 1024 ** 3)).toBe("32.0 GiB");
    expect(formatBytesGiB(1.25 * 1024 ** 3)).toBe("1.3 GiB");
  });
});

describe("maxThermalCelsius", () => {
  test("returns null without thermal zones", () => {
    expect(maxThermalCelsius([])).toBeNull();
  });

  test("returns the rounded maximum temperature in Celsius", () => {
    expect(maxThermalCelsius([
      { zone: 0, kind: "x86_pkg_temp", temperature_millicelsius: 46_000 },
      { zone: 1, kind: "nvme", temperature_millicelsius: 72_500 },
      { zone: 2, kind: "gpu", temperature_millicelsius: 71_000 },
    ])).toBe(73);
  });
});

describe("formatSurfaceName", () => {
  test("lowercases real Wayland connector names and sanitizes invalid characters", () => {
    expect(formatSurfaceName("bar", "DP-1")).toBe("bar-dp-1");
    expect(formatSurfaceName("bar", "HDMI-A-2")).toBe("bar-hdmi-a-2");
    expect(formatSurfaceName("wallpaper", "dp-1")).toBe("wallpaper-dp-1");
    expect(formatSurfaceName("plugin-panel", "AI Quota/Panel")).toBe("plugin-panel-ai-quota-panel");
    expect(formatSurfaceName("bar", "   ")).toBe("bar-default");
  });

  test("enforces the 128-byte limit and valid character set", () => {
    const formatted = formatSurfaceName("bar", "DP-".repeat(60));
    expect(formatted.length).toBeLessThanOrEqual(128);
    expect(formatted).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  });
});

describe("resolveMonitorLogicalSize", () => {
  test("prefers xdg_output logical dimensions from wayland.outputs under fractional scaling", () => {
    const outputs = makeOutputs({
      ...makeOutput(11, "DP-2"),
      width: 2194,
      height: 1234,
      mode_width: 3840,
      mode_height: 2160,
      scale: 2,
    });
    const monitor = { id: "DP-2", name: "DP-2", width: 3840, height: 2160 };

    expect(resolveMonitorLogicalSize(monitor, outputs)).toEqual({ width: 2194, height: 1234 });
    const barLayout = resolveBarLayout(makeBarSettings("top", 14), monitor, outputs);
    expect(barLayout.width).toBe(2194);
    expect(barLayout.inputRegion?.[0]?.width).toBe(2166);
  });

  test("falls back to host monitor logicalWidth/logicalHeight, then raw width/height", () => {
    const scaled = { id: "DP-1", name: "DP-1", width: 3840, height: 2160, logicalWidth: 2194, logicalHeight: 1234 };
    expect(resolveMonitorLogicalSize(scaled, undefined)).toEqual({ width: 2194, height: 1234 });

    const monitor = { id: "DP-1", name: "DP-1", width: 1440, height: 900 };
    expect(resolveMonitorLogicalSize(monitor, undefined)).toEqual({ width: 1440, height: 900 });
    expect(resolveMonitorLogicalSize(monitor, makeOutputs(makeOutput(22, "HDMI-A-2")))).toEqual({
      width: 1440,
      height: 900,
    });
  });
});

describe("resolveActiveMonitor", () => {
  const monitors = [
    { id: "DP-1", name: "DP-1", x: 0, y: 0, width: 3840, height: 2160, logicalWidth: 2194, logicalHeight: 1234, scale: 2, refreshRateMilliHz: 60000 },
    { id: "DP-2", name: "DP-2", x: 0, y: 1235, width: 3840, height: 2160, logicalWidth: 2194, logicalHeight: 1234, scale: 2, refreshRateMilliHz: 60000 },
    { id: "HDMI-A-2", name: "HDMI-A-2", x: 2195, y: 1235, width: 1440, height: 2160, logicalWidth: 823, logicalHeight: 1234, scale: 2, refreshRateMilliHz: 60000 },
  ] as const;
  const outputs = makeOutputs(makeOutput(11, "DP-1"), makeOutput(22, "DP-2"), makeOutput(33, "HDMI-A-2"));

  test("prefers explicit monitor, then focused window output, then last interaction, then first output", () => {
    const focusedOnDp2 = makeWindows(makeWindow(1, false, [11]), makeWindow(2, true, [22]));

    expect(resolveActiveMonitor(monitors, {
      preferredMonitorId: "HDMI-A-2",
      windows: focusedOnDp2,
      outputs,
      lastMonitorId: "DP-1",
    })?.id).toBe("HDMI-A-2");

    expect(resolveActiveMonitor(monitors, {
      windows: focusedOnDp2,
      outputs,
      lastMonitorId: "DP-1",
    })?.id).toBe("DP-2");

    expect(resolveActiveMonitor(monitors, {
      windows: makeWindows(makeWindow(1, false, [11])),
      outputs,
      lastMonitorId: "HDMI-A-2",
    })?.id).toBe("HDMI-A-2");

    expect(resolveActiveMonitor(monitors)?.id).toBe("DP-1");
  });
});

describe("resolvePinnedOutput", () => {
  const dp = { id: "dp-1" };
  const hdmi = { id: "hdmi-1" };
  const monitors = [dp, hdmi];

  test("acquires the active output and holds it across focus changes", () => {
    const pinned = resolvePinnedOutput(undefined, true, monitors, () => dp.id);
    expect(pinned.outputId).toBe(dp.id);
    expect(resolvePinnedOutput(pinned, true, monitors, () => hdmi.id).outputId).toBe(dp.id);
  });

  test("re-pins on disconnect and stays there when the first output reconnects", () => {
    const pinned = resolvePinnedOutput(undefined, true, monitors, () => dp.id);
    const moved = resolvePinnedOutput(pinned, true, [hdmi], () => hdmi.id);
    expect(moved.outputId).toBe(hdmi.id);
    expect(resolvePinnedOutput(moved, true, monitors, () => dp.id).outputId).toBe(hdmi.id);
  });

  test("rejects an absent fallback and acquires when monitors arrive", () => {
    const pending = resolvePinnedOutput(undefined, true, [], () => dp.id);
    expect(pending.outputId).toBeNull();
    expect(resolvePinnedOutput(pending, true, monitors, () => dp.id).outputId).toBe(dp.id);
  });

  test("clears the pin on session end and acquires again for the next session", () => {
    const pinned = resolvePinnedOutput(undefined, true, monitors, () => dp.id);
    const cleared = resolvePinnedOutput(pinned, null, monitors, () => dp.id);
    expect(cleared).toEqual({ sessionKey: null, outputId: null });
    expect(resolvePinnedOutput(cleared, true, monitors, () => hdmi.id).outputId).toBe(hdmi.id);
  });

  test("re-pins when a new request replaces an active session", () => {
    const pinned = resolvePinnedOutput(undefined, 41, monitors, () => dp.id);
    expect(resolvePinnedOutput(pinned, 42, monitors, () => hdmi.id).outputId).toBe(hdmi.id);
  });
});

describe("resolveBarPopupAnchor", () => {
  test("spans full top-bar height and aligns end/center/target cleanly", () => {
    const layout = { isVertical: false, width: 1412, height: TOP_BAR_HEIGHT };
    expect(resolveBarPopupAnchor(layout, {
      align: "end",
      targetRect: { x: 1288, y: 15, width: 16, height: 18 },
    })).toEqual({ x: 1411, y: 0, width: 1, height: TOP_BAR_HEIGHT });

    expect(resolveBarPopupAnchor(layout, {
      align: "center",
      targetRect: { x: 616, y: 8, width: 178, height: 32 },
    })).toEqual({ x: 616, y: 0, width: 178, height: TOP_BAR_HEIGHT });

    expect(resolveBarPopupAnchor(layout, {
      align: "target",
      targetRect: { x: 1020, y: 8, width: 156, height: 32 },
    })).toEqual({ x: 1020, y: 0, width: 156, height: TOP_BAR_HEIGHT });
  });

  test("spans full vertical-bar width along cross axis", () => {
    const layout = { isVertical: true, width: VERTICAL_BAR_WIDTH, height: 900 };
    expect(resolveBarPopupAnchor(layout, {
      align: "end",
      targetRect: { x: 8, y: 780, width: 36, height: 26 },
    })).toEqual({ x: 0, y: 780, width: VERTICAL_BAR_WIDTH, height: 26 });
  });

  test("anchors popups to visual island bounds rather than transparent shadow bleed", () => {
    const floatingTop = resolveBarLayout(makeBarSettings("top", 14), { width: 1280, height: 720 });
    expect(resolveBarPopupAnchor(floatingTop, { align: "end" })).toEqual({
      x: 1280 - 14 - 1,
      y: 10,
      width: 1,
      height: TOP_BAR_HEIGHT,
    });
  });
});

describe("resolveDesktopApp and buildDockItems with catalog", () => {
  const catalog: readonly DesktopAppSummary[] = [
    {
      id: "Alacritty.desktop",
      title: "Alacritty",
      startup_wm_class: "Alacritty",
      icon: { kind: "runtime_path", path: "/run/user/1000/z-shell/media/alacritty.svg", mime: "image/svg+xml", revision: 1 },
    },
    {
      id: "app.zen_browser.zen.desktop",
      title: "Zen Browser",
      startup_wm_class: "zen",
      icon: { kind: "runtime_path", path: "/run/user/1000/z-shell/media/zen.png", mime: "image/png", revision: 2 },
    },
  ];

  test("resolves desktop apps by exact ID, case-insensitive ID, StartupWMClass, and reverse-DNS tail", () => {
    expect(resolveDesktopApp(catalog, "Alacritty.desktop")?.title).toBe("Alacritty");
    expect(resolveDesktopApp(catalog, "alacritty")?.title).toBe("Alacritty");
    expect(resolveDesktopApp(catalog, "zen")?.id).toBe("app.zen_browser.zen.desktop");
    expect(resolveDesktopApp(catalog, "unknown-app")).toBeUndefined();
  });

  test("attaches icons and deduplicates pinned and running windows via StartupWMClass", () => {
    const result = buildDockItems(
      ["app.zen_browser.zen.desktop"],
      [
        { ...makeWindow(1, true, [11]), app_id: "zen", title: "Home — Zen Browser" },
        { ...makeWindow(2, false, [11]), app_id: "Alacritty", title: "Shell" },
      ],
      catalog,
    );
    expect(result.pinned).toHaveLength(1);
    expect(result.pinned[0]?.title).toBe("Zen Browser");
    expect(result.pinned[0]?.icon?.kind).toBe("runtime_path");
    expect(result.pinned[0]?.focused).toBe(true);
    expect(result.runningOnly).toHaveLength(1);
    expect(result.runningOnly[0]?.title).toBe("Alacritty");
    expect(result.runningOnly[0]?.icon?.kind).toBe("runtime_path");
  });
});

describe("hasWindowsOnMonitor", () => {
  const outputs = makeOutputs(makeOutput(11, "DP-1"), makeOutput(22, "DP-2"));

  test("checks non-minimized window presence per monitor", () => {
    const windows = makeWindows(
      { ...makeWindow(1, true, [11]), minimized: false },
      { ...makeWindow(2, false, [22]), minimized: true },
    );
    expect(hasWindowsOnMonitor(windows, outputs, "DP-1")).toBe(true);
    expect(hasWindowsOnMonitor(windows, outputs, "DP-2")).toBe(false);
    expect(hasWindowsOnMonitor(makeWindows(), outputs, "DP-1")).toBe(false);
  });
});

describe("splitNotificationActions", () => {
  test("extracts FreeDesktop default action for card click and hides empty-label action pills", () => {
    expect(splitNotificationActions([{ key: "default", label: "" }])).toEqual({
      defaultAction: { key: "default", label: "" },
      buttonActions: [],
    });

    expect(
      splitNotificationActions([
        { key: "default", label: "Focus" },
        { key: "open", label: "Open" },
        { key: "blank", label: "   " },
        { key: "copy", label: "Copy" },
      ]),
    ).toEqual({
      defaultAction: { key: "default", label: "Focus" },
      buttonActions: [
        { key: "open", label: "Open" },
        { key: "copy", label: "Copy" },
      ],
    });
  });
});

describe("isImeTrayItem", () => {
  const baseTray = {
    id: ":1.42/StatusNotifierItem",
    title: null,
    category: "ApplicationStatus",
    status: "Active",
    icon_name: null,
    item_is_menu: false,
    tooltip: null,
    icon: null,
    menu: null,
  } as const;

  test("matches Fcitx5/IBus SNI tray items without hiding ordinary apps", () => {
    expect(isImeTrayItem({ ...baseTray, app_id: "Fcitx", icon_name: "input-keyboard" })).toBe(true);
    expect(isImeTrayItem({ ...baseTray, icon_name: "fcitx-rime" })).toBe(true);
    expect(isImeTrayItem({ ...baseTray, category: "SystemServices", title: "Input Method" })).toBe(true);
    expect(isImeTrayItem({ ...baseTray, category: "SystemServices", title: "输入法" })).toBe(true);
    expect(isImeTrayItem({ ...baseTray, app_id: "discord", title: "Discord" })).toBe(false);
    expect(isImeTrayItem({ ...baseTray, title: "Polychromatic" })).toBe(false);
  });
});

describe("resolveClipboardSelection", () => {
  test("preserves selection by stable entry id when new items prepend and falls back to adjacent item on delete", () => {
    const initial = [{ id: 10 }, { id: 20 }, { id: 30 }];
    expect(resolveClipboardSelection(initial, null, 0)).toEqual({ index: 0, entry: { id: 10 } });
    expect(resolveClipboardSelection(initial, 20, 1)).toEqual({ index: 1, entry: { id: 20 } });

    // Prepending a fresh clipboard capture keeps id=20 selected instead of drifting to index 1.
    const prepended = [{ id: 99 }, { id: 10 }, { id: 20 }, { id: 30 }];
    expect(resolveClipboardSelection(prepended, 20, 1)).toEqual({ index: 2, entry: { id: 20 } });

    // Deleting the selected item smoothly falls back to the adjacent index (clamped when deleting the last row).
    const deletedMiddle = [{ id: 10 }, { id: 30 }];
    expect(resolveClipboardSelection(deletedMiddle, 20, 1)).toEqual({ index: 1, entry: { id: 30 } });
    const deletedLast = [{ id: 10 }, { id: 20 }];
    expect(resolveClipboardSelection(deletedLast, 30, 2)).toEqual({ index: 1, entry: { id: 20 } });
    expect(resolveClipboardSelection([], 10, 0)).toEqual({ index: -1, entry: null });
  });
});

describe("resolveNotificationMediaLayout (12B)", () => {
  const discordIcon = { kind: "runtime_path", path: "/media/discord.png", mime: "image/png", revision: 1 } as const;
  const avatar128 = {
    kind: "blob_handle",
    token: "avatar-128",
    mime: "image/png",
    byte_len: 2048,
    dimensions: { width: 128, height: 128 },
  } as const;
  const wideShot = {
    kind: "runtime_path",
    path: "/media/shot.png",
    mime: "image/png",
    revision: 2,
    dimensions: { width: 1920, height: 1080 },
  } as const;

  test("routes Form A square avatar/cover attachments into leading slot with XDG app badge and no bottom banner", () => {
    expect(resolveNotificationMediaLayout({ icon: discordIcon, attachment: avatar128 })).toEqual({
      leadingMedia: avatar128,
      leadingKind: "avatar",
      appBadge: discordIcon,
      previewBanner: null,
      previewFit: "cover",
      fallbackKind: "bell",
    });
  });

  test("routes Form B wide and tall portrait screenshots from either attachment or app_icon to bounded preview", () => {
    expect(resolveNotificationMediaLayout({ icon: discordIcon, attachment: wideShot })).toEqual({
      leadingMedia: discordIcon,
      leadingKind: "app-icon",
      appBadge: null,
      previewBanner: wideShot,
      previewFit: "cover",
      fallbackKind: "image",
    });
    expect(resolveNotificationMediaLayout({ icon: wideShot, attachment: null })).toEqual({
      leadingMedia: null,
      leadingKind: null,
      appBadge: null,
      previewBanner: wideShot,
      previewFit: "cover",
      fallbackKind: "image",
    });
    const tallStripShot = {
      kind: "blob_handle" as const,
      token: "tall-strip",
      mime: "image/png",
      revision: 3,
      dimensions: { width: 82, height: 643 },
    };
    expect(resolveNotificationMediaLayout({ icon: tallStripShot, attachment: null })).toEqual({
      leadingMedia: null,
      leadingKind: null,
      appBadge: null,
      previewBanner: tallStripShot,
      previewFit: "contain",
      fallbackKind: "image",
    });
    expect(resolveNotificationMediaLayout({ icon: discordIcon, attachment: tallStripShot })).toEqual({
      leadingMedia: discordIcon,
      leadingKind: "app-icon",
      appBadge: null,
      previewBanner: tallStripShot,
      previewFit: "contain",
      fallbackKind: "image",
    });
  });

  test("renders resolved XDG app icon directly and falls back to bell only when no icon or image exists", () => {
    expect(resolveNotificationMediaLayout({ icon: discordIcon, attachment: null })).toEqual({
      leadingMedia: discordIcon,
      leadingKind: "app-icon",
      appBadge: null,
      previewBanner: null,
      previewFit: "cover",
      fallbackKind: "bell",
    });
    expect(resolveNotificationMediaLayout({ icon: null, attachment: null })).toEqual({
      leadingMedia: null,
      leadingKind: null,
      appBadge: null,
      previewBanner: null,
      previewFit: "cover",
      fallbackKind: "bell",
    });
  });
});

describe("formatNotificationBody", () => {
  test("normalizes line endings, collapses consecutive blank lines, trims edges, and preserves single newlines", () => {
    expect(formatNotificationBody("chat.example.com\n\nDeploy finished")).toBe("chat.example.com\nDeploy finished");
    expect(formatNotificationBody("  line 1\r\n\r\n  \t \rline 2\nline 3  \n\n")).toBe("line 1\nline 2\nline 3");
    expect(formatNotificationBody("first\nsecond\nthird")).toBe("first\nsecond\nthird");
    expect(formatNotificationBody("   \n\t\n  ")).toBe("");
    expect(formatNotificationBody("https://example.com/very/long/unbroken/path/segment")).toBe(
      "https://example.com/very/long/unbroken/path/segment",
    );
  });
});

describe("System Monitor telemetry helpers, chart paths & backwards compatibility", () => {
  test("formats byte sizes, transfer rates, frequencies, uptime, and poll cadence truthfully", () => {
    expect(PANEL_MAX_HEIGHTS["system-monitor"]).toBe(760);
    expect(formatBytesDecimalGB(11.4 * 1024 ** 3, 1)).toBe("11.4 GB");
    expect(formatBytesShort(1.8 * 1024 ** 3, true)).toBe("1.8G");
    expect(formatBytesShort(240 * 1024 ** 2, true)).toBe("240M");
    expect(formatBytesShort(null)).toBe("—");
    expect(formatRateBytesPerSec(4.2 * 1024 ** 2)).toBe("4.2 MB/s");
    expect(formatRateBytesPerSec(310 * 1024)).toBe("310 KB/s");
    expect(formatRateBytesPerSec(null)).toBe("—");
    expect(formatFrequencyMhz(3820, 2)).toBe("3.82 GHz");
    expect(formatFrequencyMhz(800, 1)).toBe("800 MHz");
    expect(formatFrequencyMhz(null)).toBe("");
    expect(formatUptimeCompact(4 * 3600 + 18 * 60)).toBe("4h 18m");
    expect(formatUptimeCompact(2 * 86400 + 3 * 3600)).toBe("2d 3h");
    expect(formatPollInterval(1000)).toBe("1s");
    expect(formatPollInterval(2000)).toBe("2s");
    expect(formatPollInterval(500)).toBe("500ms");
    expect(formatPollInterval(null)).toBeNull();
    expect(formatPollInterval(undefined)).toBeNull();
  });

  test("computeMemoryBreakdown preserves used_bytes = total - available and clamps cache segment to non-overlapping headroom", () => {
    const GiB = 1024 ** 3;
    const normal = computeMemoryBreakdown({
      total_bytes: 32 * GiB,
      available_bytes: 20.6 * GiB,
      used_bytes: 11.4 * GiB,
      cached_bytes: 5.1 * GiB,
    })!;
    expect(normal.usedPercent).toBeCloseTo((11.4 / 32) * 100, 4);
    expect(normal.cachePercent).toBeCloseTo((5.1 / 32) * 100, 4);
    expect(normal.activePercent + normal.cachePercent).toBeLessThanOrEqual(100);

    // Oversized cache reported by kernel must clamp strictly to remaining available headroom (never > 100%).
    const clamped = computeMemoryBreakdown({
      total_bytes: 16 * GiB,
      available_bytes: 2 * GiB,
      used_bytes: 14 * GiB,
      cached_bytes: 6 * GiB,
      buffers_bytes: 1 * GiB,
      reclaimable_bytes: 1 * GiB,
    })!;
    expect(clamped.visualCacheBytes).toBe(2 * GiB);
    expect(clamped.activePercent + clamped.cachePercent).toBeCloseTo(100, 6);
  });

  test("buildSparklinePaths breaks cleanly across null gaps without bridging and builds split dual-arc paths", () => {
    const gapped = buildSparklinePaths([10, 25, null, null, 60, 80, 75], {
      width: 340,
      height: 72,
      maxValue: 100,
    });
    expect(gapped.hasData).toBe(true);
    expect(gapped.segmentCount).toBe(2);
    // Two disjoint M commands prove the line breaks across null gaps rather than bridging them.
    expect(gapped.strokePath.match(/\bM\s/g)?.length).toBe(2);
    expect(gapped.areaPath.match(/\bZ\b/g)?.length).toBe(2);

    const empty = buildSparklinePaths([null, null], { width: 340, height: 72, maxValue: 100 });
    expect(empty.hasData).toBe(false);
    expect(empty.strokePath).toBe("");

    const arcs = buildSplitDualArcPaths(24, 36);
    expect(arcs.leftTrack).toContain("M ");
    expect(arcs.rightTrack).toContain("M ");
    expect(arcs.leftFill).toContain("C ");
    expect(arcs.rightFill).toContain("C ");
    const zeroArcs = buildSplitDualArcPaths(null, 0);
    expect(zeroArcs.leftFill).toBe("");
    expect(zeroArcs.rightFill).toBe("");
  });

  test("backwards compatibility: legacy snapshots drive new selectors without fabricated data, and extended snapshots keep BatteryPanel intact", () => {
    const legacySnapshot: SystemTelemetrySnapshot = {
      cpu_usage_percent: 22,
      memory: {
        total_bytes: 34_359_738_368,
        available_bytes: 22_119_081_984,
        used_bytes: 12_240_656_384,
      },
      temperatures: [{ zone: 0, kind: "x86_pkg_temp", temperature_millicelsius: 46_000 }],
    };
    expect(formatPollInterval(legacySnapshot.poll_interval_ms)).toBeNull();
    expect(selectTelemetryHistoryWindow(legacySnapshot, "60s")).toBeNull();
    expect(selectPrimaryGpu(legacySnapshot.gpus)).toBeNull();
    expect(selectHeadlineTempCelsius(legacySnapshot)).toBe(46);
    expect(computeMemoryBreakdown(legacySnapshot.memory)?.cacheBytes).toBeNull();

    const extendedSnapshot: SystemTelemetrySnapshot = {
      ...legacySnapshot,
      poll_interval_ms: 1000,
      memory: { ...legacySnapshot.memory!, cached_bytes: 4 * 1024 ** 3 },
      sensors: [
        { label: "CPU", category: "cpu", source: "k10temp", temperature_millicelsius: 52_000 },
        { label: "NVMe", category: "nvme", source: "nvme", temperature_millicelsius: 38_000 },
      ],
    };
    // BatteryPanel continues reading legacy fields cleanly from extended snapshots.
    expect(formatBytesGiB(extendedSnapshot.memory!.used_bytes)).toBe("11.4 GiB");
    expect(maxThermalCelsius(extendedSnapshot.temperatures)).toBe(46);
    expect(selectHeadlineTempCelsius(extendedSnapshot)).toBe(52);
  });

  test("right-aligned 60-slot geometry keeps all vertices (including slot -1 overhang) inside [0, width] across all chart viewBoxes", () => {
    const extractPathXs = (d: string): number[] => {
      const xs: number[] = [];
      const tokens = d.match(/[MLC]|-?\d+(?:\.\d+)?/g) ?? [];
      let i = 0;
      while (i < tokens.length) {
        const cmd = tokens[i]!;
        if (cmd === "M" || cmd === "L") {
          xs.push(Number(tokens[i + 1]));
          i += 3;
        } else if (cmd === "C") {
          xs.push(Number(tokens[i + 1]), Number(tokens[i + 3]), Number(tokens[i + 5]));
          i += 7;
        } else {
          i += 1;
        }
      }
      return xs;
    };

    const full60 = Array.from({ length: 60 }, (_, idx) => 20 + ((idx * 17) % 70));
    const variants = [
      { label: "area-popover", width: 340, height: 72, paddingX: 8, smooth: true },
      { label: "area-window", width: 380, height: 88, paddingX: 8, smooth: true },
      { label: "area-window-wide", width: 536, height: 88, paddingX: 10, smooth: true },
      { label: "area-detail", width: 536, height: 112, paddingX: 10, smooth: true },
      { label: "dual-compact", width: 250, height: 64, paddingX: 6, smooth: false },
      { label: "dual-compact-wide", width: 536, height: 64, paddingX: 10, smooth: false },
      { label: "dual-detail", width: 536, height: 96, paddingX: 10, smooth: false },
    ] as const;

    for (const v of variants) {
      const res = buildSparklinePaths(full60, {
        width: v.width,
        height: v.height,
        paddingX: v.paddingX,
        paddingTop: 10,
        paddingBottom: 8,
        maxValue: 100,
        smooth: v.smooth,
        slotCount: 60,
        leadingValue: 65,
      });
      expect(res.hasData, v.label).toBe(true);
      expect(res.slotPitch, `${v.label}: paddingX >= slotPitch`).toBeLessThanOrEqual(v.paddingX);

      const xs = extractPathXs(res.strokePath);
      expect(xs.length, v.label).toBeGreaterThan(60);
      expect(xs[0], `${v.label}: slot -1 overhang sits at paddingX - slotPitch`).toBeCloseTo(
        v.paddingX - res.slotPitch,
        1,
      );
      expect(xs[xs.length - 1], `${v.label}: rightmost slot sits at width - paddingX`).toBeCloseTo(
        v.width - v.paddingX,
        1,
      );
      for (const x of xs) {
        expect(x, `${v.label}: vertex x=${x} >= 0`).toBeGreaterThanOrEqual(0);
        expect(x, `${v.label}: vertex x=${x} <= width`).toBeLessThanOrEqual(v.width);
      }

      // Leading null must break cleanly at slot 0 instead of connecting to slot -1.
      const nullLeading = buildSparklinePaths(full60, {
        width: v.width,
        height: v.height,
        paddingX: v.paddingX,
        paddingTop: 10,
        paddingBottom: 8,
        maxValue: 100,
        smooth: v.smooth,
        slotCount: 60,
        leadingValue: null,
      });
      const nullXs = extractPathXs(nullLeading.strokePath);
      expect(nullXs[0], `${v.label}: leading null starts cleanly at paddingX`).toBeCloseTo(v.paddingX, 1);
    }

    // Partial series right-aligns to the right edge (slot 59 = width - paddingX).
    const partial = buildSparklinePaths([20, 40, 60], {
      width: 340,
      height: 72,
      paddingX: 8,
      maxValue: 100,
      slotCount: 60,
      smooth: false,
    });
    const partialXs = extractPathXs(partial.strokePath);
    expect(partialXs[0]).toBeCloseTo(8 + 57 * partial.slotPitch, 1);
    expect(partialXs[partialXs.length - 1]).toBeCloseTo(332, 1);

    // MiniSparkline right-aligns to the latest 30 slots of a 60-slot buffer.
    const mini = buildSparklinePaths(full60, {
      width: 36,
      height: 16,
      paddingX: 1.5,
      paddingTop: 2.5,
      paddingBottom: 2.5,
      maxValue: 100,
      smooth: false,
      slotCount: 30,
    });
    const miniXs = extractPathXs(mini.strokePath);
    expect(miniXs.length).toBe(30);
    expect(miniXs[0]).toBeCloseTo(1.5, 1);
    expect(miniXs[miniXs.length - 1]).toBeCloseTo(34.5, 1);
  });

  test("niceThroughputCeiling, resolveThroughputScale 0.8x hysteresis (including multi-tier drops), and axis labels", () => {
    const KiB = 1024;
    const MiB = 1024 ** 2;
    const GiB = 1024 ** 3;

    expect(niceThroughputCeiling(0)).toBe(THROUGHPUT_SCALE_FLOOR_BPS);
    expect(niceThroughputCeiling(1024)).toBe(10 * KiB);
    expect(niceThroughputCeiling(10 * KiB)).toBe(10 * KiB);
    expect(niceThroughputCeiling(10 * KiB + 1)).toBe(20 * KiB);
    expect(niceThroughputCeiling(450 * KiB)).toBe(500 * KiB);
    expect(niceThroughputCeiling(501 * KiB)).toBe(1 * MiB);
    expect(niceThroughputCeiling(4.2 * MiB)).toBe(5 * MiB);
    expect(niceThroughputCeiling(52 * MiB)).toBe(100 * MiB);
    expect(niceThroughputCeiling(600 * MiB)).toBe(1 * GiB);

    // Initial scale snaps cleanly.
    expect(resolveThroughputScale(4.2 * MiB, null)).toBe(5 * MiB);
    // Immediate upward jump.
    expect(resolveThroughputScale(10.1 * MiB, 10 * MiB)).toBe(20 * MiB);
    // Downward 0.8x hysteresis prevents oscillation near lower rung boundary.
    expect(resolveThroughputScale(4.5 * MiB, 10 * MiB)).toBe(10 * MiB);
    expect(resolveThroughputScale(4.0 * MiB, 10 * MiB)).toBe(5 * MiB);
    // Multi-tier drop never stalls at 100 MB/s even when peak sits at 90% of 500 KB/s (450 KB/s -> 1 MB/s).
    expect(resolveThroughputScale(450 * KiB, 100 * MiB)).toBe(1 * MiB);
    expect(resolveThroughputScale(380 * KiB, 100 * MiB)).toBe(500 * KiB);
    expect(resolveThroughputScale(0, 100 * MiB)).toBe(10 * KiB);

    expect(formatThroughputAxisLabel(10 * KiB)).toBe("10 KB/s");
    expect(formatThroughputAxisLabel(512 * KiB)).toBe("512 KB/s");
    expect(formatThroughputAxisLabel(2.5 * MiB)).toBe("2.5 MB/s");
    expect(formatThroughputAxisLabel(5 * MiB)).toBe("5 MB/s");
    expect(formatThroughputAxisLabel(1 * GiB)).toBe("1 GB/s");
  });

  test("classifyHistoryTransition animates only on proven deltaBuckets === 1 and preserves in_place on delta === 0", () => {
    const snapA = { latestBucketId: 100, resetKey: "60s", seriesLength: 60, firstValue: 22, secondaryFirstValue: 11 };
    const snapB = { latestBucketId: 101, resetKey: "60s", seriesLength: 60, firstValue: 25, secondaryFirstValue: 13 };

    expect(classifyHistoryTransition({ previous: null, next: snapA, slotCount: 60 })).toEqual({ kind: "snap" });
    expect(classifyHistoryTransition({ previous: snapA, next: snapB, slotCount: 60, revision: 2, previousRevision: 1 }))
      .toEqual({ kind: "advance", exitingValue: 22, secondaryExitingValue: 11 });

    // Partial buffer (< 60) advances without an exiting slot -1 value.
    expect(classifyHistoryTransition({
      previous: { latestBucketId: 10, resetKey: "60s", seriesLength: 11, firstValue: 22, secondaryFirstValue: 11 },
      next: { latestBucketId: 11, resetKey: "60s", seriesLength: 12, firstValue: 22, secondaryFirstValue: 11 },
      slotCount: 60,
    })).toEqual({ kind: "advance", exitingValue: null, secondaryExitingValue: null });

    // delta === 0 (e.g. 5m/15m mid-bucket live tick) preserves any active scroll in place.
    expect(classifyHistoryTransition({ previous: snapB, next: snapB, slotCount: 60, revision: 3, previousRevision: 2 }))
      .toEqual({ kind: "in_place" });

    // Multi-bucket jump, missing metadata (legacy daemon), sourceBaseline, resetKey change, or reconnect revision reset all snap.
    expect(classifyHistoryTransition({
      previous: snapA,
      next: { ...snapB, latestBucketId: 103 },
      slotCount: 60,
    })).toEqual({ kind: "snap" });
    expect(classifyHistoryTransition({
      previous: { ...snapA, latestBucketId: undefined },
      next: { ...snapB, latestBucketId: undefined },
      slotCount: 60,
    })).toEqual({ kind: "snap" });
    expect(classifyHistoryTransition({
      previous: snapA,
      next: snapB,
      slotCount: 60,
      sourceBaseline: true,
    })).toEqual({ kind: "snap" });
    expect(classifyHistoryTransition({
      previous: snapA,
      next: { ...snapB, resetKey: "5m" },
      slotCount: 60,
    })).toEqual({ kind: "snap" });
    expect(classifyHistoryTransition({
      previous: snapA,
      next: snapB,
      slotCount: 60,
      revision: 1,
      previousRevision: 5,
    })).toEqual({ kind: "snap" });
  });

  test("selectNetworkDisplay handles two active NICs truthfully in both mixed-version directions", () => {
    const legacyHistory: TelemetryHistoryWindow = {
      bucket_seconds: 1,
      net_rx_bytes_per_sec: [3_000_000, 3_100_000],
      net_tx_bytes_per_sec: [500_000, 520_000],
    };
    const oldDaemonNet: TelemetryNetwork = {
      active_interface: "enp4s0",
      rx_bytes_per_sec: 3_100_000,
      tx_bytes_per_sec: 520_000,
      session_rx_bytes: 1_200_000_000,
      session_tx_bytes: 180_000_000,
      interfaces: [
        { name: "enp4s0", up: true, rx_bytes_per_sec: 3_100_000, tx_bytes_per_sec: 520_000, session_rx_bytes: 1_200_000_000, session_tx_bytes: 180_000_000 },
        { name: "wlan0", up: true, rx_bytes_per_sec: 2_000_000, tx_bytes_per_sec: 300_000, session_rx_bytes: 800_000_000, session_tx_bytes: 100_000_000 },
      ],
    };
    const legacySel = selectNetworkDisplay(oldDaemonNet, legacyHistory)!;
    expect(legacySel.isAggregate).toBe(false);
    expect(legacySel.label).toBe("enp4s0");
    expect(legacySel.rxBytesPerSec).toBe(3_100_000);
    expect(legacySel.txBytesPerSec).toBe(520_000);
    expect(legacySel.rxHistory).toEqual([3_000_000, 3_100_000]);

    const newHistory: TelemetryHistoryWindow = {
      ...legacyHistory,
      latest_bucket_id: 120,
      aggregate_net_rx_bytes_per_sec: [5_000_000, 5_100_000],
      aggregate_net_tx_bytes_per_sec: [800_000, 820_000],
    };
    const newDaemonNet: TelemetryNetwork = {
      ...oldDaemonNet,
      aggregate: {
        active_interface_count: 2,
        active_interfaces: ["enp4s0", "wlan0"],
        rx_bytes_per_sec: 5_100_000,
        tx_bytes_per_sec: 820_000,
        session_rx_bytes: 2_000_000_000,
        session_tx_bytes: 280_000_000,
      },
    };
    const aggSel = selectNetworkDisplay(newDaemonNet, newHistory)!;
    expect(aggSel.isAggregate).toBe(true);
    expect(aggSel.label).toBe("2 active");
    expect(aggSel.rxBytesPerSec).toBe(5_100_000);
    expect(aggSel.txBytesPerSec).toBe(820_000);
    expect(aggSel.sessionRxBytes).toBe(2_000_000_000);
    expect(aggSel.rxHistory).toEqual([5_000_000, 5_100_000]);

    // Single active NIC and all-down (0 active) labels under aggregate daemon.
    const oneActive = selectNetworkDisplay({
      ...oldDaemonNet,
      aggregate: {
        active_interface_count: 1,
        active_interfaces: ["enp4s0"],
        rx_bytes_per_sec: 3_100_000,
        tx_bytes_per_sec: 520_000,
        session_rx_bytes: 1_200_000_000,
        session_tx_bytes: 180_000_000,
      },
    }, newHistory)!;
    expect(oneActive.label).toBe("enp4s0");

    const zeroActive = selectNetworkDisplay({
      ...oldDaemonNet,
      aggregate: {
        active_interface_count: 0,
        active_interfaces: [],
        rx_bytes_per_sec: 0,
        tx_bytes_per_sec: 0,
        session_rx_bytes: 2_000_000_000,
        session_tx_bytes: 280_000_000,
      },
    }, newHistory)!;
    expect(zeroActive.label).toBeNull();
    expect(zeroActive.rxBytesPerSec).toBe(0);
  });

  test("chart scroll controller lifecycle guarantees activeMotionTickerCount() === 0 after settle, unmount, and reduced motion", () => {
    let clockMs = 1000;
    let nextRafId = 1;
    const pendingFrames = new Map<number, (ts: number) => void>();
    const g = globalThis as unknown as {
      requestAnimationFrame?: (cb: (ts: number) => void) => number;
      cancelAnimationFrame?: (id: number) => void;
    };
    const origRaf = g.requestAnimationFrame;
    const origCaf = g.cancelAnimationFrame;
    g.requestAnimationFrame = cb => {
      const id = nextRafId++;
      pendingFrames.set(id, cb);
      return id;
    };
    g.cancelAnimationFrame = id => {
      pendingFrames.delete(id);
    };

    const tick = (advanceMs: number) => {
      clockMs += advanceMs;
      const batch = [...pendingFrames.entries()];
      pendingFrames.clear();
      for (const [, cb] of batch) cb(clockMs);
    };

    try {
      const s1 = Array.from({ length: 60 }, (_, i) => i + 1);
      const s2 = Array.from({ length: 60 }, (_, i) => i + 2);
      const observedShifts: number[] = [];

      const ctrl = createChartScrollController({
        slotCount: 60,
        nowMs: () => clockMs,
        onChange: frame => observedShifts.push(frame.shiftSlots),
      });

      // Initial render snaps with zero tickers.
      ctrl.update({ primary: s1, latestBucketId: 100, bucketSeconds: 1, resetKey: "60s", revision: 1, reducedMotion: false });
      expect(activeMotionTickerCount()).toBe(0);
      expect(ctrl.state().shiftSlots).toBe(0);

      // Proven delta === 1 starts scroll ticker and captures exitingValue (1).
      ctrl.update({ primary: s2, latestBucketId: 101, bucketSeconds: 1, resetKey: "60s", revision: 2, reducedMotion: false });
      expect(activeMotionTickerCount()).toBe(1);
      expect(ctrl.state().shiftSlots).toBe(1);
      expect(ctrl.state().exitingPrimary).toBe(1);

      tick(400);
      expect(ctrl.state().shiftSlots).toBeCloseTo(0.6, 4);
      expect(activeMotionTickerCount()).toBe(1);

      // delta === 0 in-place update must NOT restart the active scroll back to 1.
      ctrl.update({ primary: s2, latestBucketId: 101, bucketSeconds: 1, resetKey: "60s", revision: 3, reducedMotion: false });
      expect(ctrl.state().shiftSlots).toBeCloseTo(0.6, 4);
      expect(activeMotionTickerCount()).toBe(1);

      // Settle unregisters ticker -> zero idle CPU.
      tick(650);
      expect(ctrl.state().shiftSlots).toBe(0);
      expect(ctrl.state().exitingPrimary).toBeUndefined();
      expect(activeMotionTickerCount()).toBe(0);
      expect(observedShifts.length).toBeGreaterThanOrEqual(3);

      // Unmount (dispose) while mid-flight unregisters cleanly.
      const s3 = Array.from({ length: 60 }, (_, i) => i + 3);
      ctrl.update({ primary: s3, latestBucketId: 102, bucketSeconds: 1, resetKey: "60s", revision: 4, reducedMotion: false });
      expect(activeMotionTickerCount()).toBe(1);
      ctrl.dispose();
      expect(activeMotionTickerCount()).toBe(0);

      // Reduced motion snaps immediately with zero tickers registered.
      const reducedCtrl = createChartScrollController({
        slotCount: 60,
        nowMs: () => clockMs,
        onChange: () => {},
      });
      reducedCtrl.update({ primary: s1, latestBucketId: 100, bucketSeconds: 1, resetKey: "60s", revision: 1, reducedMotion: true });
      reducedCtrl.update({ primary: s2, latestBucketId: 101, bucketSeconds: 1, resetKey: "60s", revision: 2, reducedMotion: true });
      expect(reducedCtrl.state().shiftSlots).toBe(0);
      expect(activeMotionTickerCount()).toBe(0);
      reducedCtrl.dispose();
    } finally {
      g.requestAnimationFrame = origRaf;
      g.cancelAnimationFrame = origCaf;
    }
  });

  test("trayRuleKey excludes transient D-Bus IDs and partitionTrayItems respects rules and legacy fallback", () => {
    const mkTray = (id: string, overrides: Partial<TrayItem> = {}): TrayItem => ({
      id,
      app_id: null,
      title: null,
      category: null,
      status: null,
      icon_name: null,
      item_is_menu: false,
      tooltip: null,
      icon: null,
      menu: null,
      ...overrides,
    });
    const nm = mkTray(":1.42/org/ayatana/NotificationItem/nm_applet", { app_id: "nm-applet", title: "Network" });
    const iconOnly = mkTray(":1.50/StatusNotifierItem", { icon_name: "dropboxstatus-idle" });
    const transient = mkTray(":1.99/StatusNotifierItem", { app_id: "  ", icon_name: "", title: null });

    expect(trayRuleKey(nm)).toBe("nm-applet");
    expect(trayRuleKey(iconOnly)).toBe("dropboxstatus-idle");
    expect(trayRuleKey(transient)).toBeNull();

    const hiddenItem = mkTray(":1.77/Menu", { app_id: "steam" });
    const items = [nm, iconOnly, transient, hiddenItem];

    // Legacy daemon without bar.tray keeps all items visible.
    expect(partitionTrayItems(items, undefined)).toEqual({
      visible: items,
      collapsed: [],
      hidden: [],
    });

    // With default_action=collapse and explicit show/hide rules.
    const partitioned = partitionTrayItems(items, {
      default_action: "collapse",
      rules: {
        "nm-applet": "show",
        steam: "hide",
      },
    });
    expect(partitioned.visible.map(i => i.id)).toEqual([nm.id]);
    expect(partitioned.collapsed.map(i => i.id)).toEqual([iconOnly.id, transient.id]);
    expect(partitioned.hidden.map(i => i.id)).toEqual([hiddenItem.id]);
  });

  test("supportsTimedKeepAwake, supportsOsSleepBlock, and formatKeepAwakeRemaining handle mixed daemon versions", () => {
    expect(supportsTimedKeepAwake(undefined)).toBe(false);
    expect(supportsOsSleepBlock(undefined)).toBe(false);

    // 8376421 legacy daemon snapshot: no timed Keep awake fields and no sleep_block_status.
    const legacy8376421 = {
      caffeine: false,
      media_playing: false,
      active_inhibitors: [],
      warning: null,
      rules: [],
      service_status: { status: "running" as const },
    };
    expect(supportsTimedKeepAwake(legacy8376421)).toBe(false);
    expect(supportsOsSleepBlock(legacy8376421)).toBe(false);

    // 168f8bf daemon snapshot: timed Keep awake present, no OS sleep_block_status yet.
    const baseline168f8bf = {
      ...legacy8376421,
      caffeine: true,
      caffeine_scope: "sleep" as const,
      caffeine_duration_seconds: 3600,
      caffeine_expires_at_ms: 1_000_000,
    };
    expect(supportsTimedKeepAwake(baseline168f8bf)).toBe(true);
    expect(supportsOsSleepBlock(baseline168f8bf)).toBe(false);

    // Current daemon snapshot with OS sleep_block_status.
    expect(supportsOsSleepBlock({
      ...baseline168f8bf,
      sleep_block_status: { status: "held" },
    })).toBe(true);
    expect(supportsOsSleepBlock({
      ...baseline168f8bf,
      sleep_block_status: { status: "unavailable", reason: "logind denied" },
    })).toBe(true);

    expect(formatKeepAwakeRemaining(null, 1_000)).toBe("Always on");
    expect(formatKeepAwakeRemaining(1_000 + 42 * 60_000, 1_000)).toBe("42m left");
    expect(formatKeepAwakeRemaining(1_000 + 3600_000, 1_000)).toBe("1h left");
    expect(formatKeepAwakeRemaining(1_000 + 90 * 60_000, 1_000)).toBe("1h 30m left");
    expect(formatKeepAwakeRemaining(1_000 + 45_000, 1_000)).toBe("45s left");
    expect(formatKeepAwakeRemaining(500, 1_000)).toBe("0m left");
  });

  test("groupNotificationPopups caps at 3 distinct apps and separates identical display names with distinct app_key", () => {
    const mkNotif = (id: number, app_name: string, app_key?: string): NotificationItem => ({
      id,
      revision: id,
      app_name,
      ...(app_key ? { app_key } : {}),
      summary: `Summary ${id}`,
      body: `Body ${id}`,
      icon: null,
      attachment: null,
      actions: [],
      urgency: 1,
    });
    const popups = [
      mkNotif(1, "Slack", "desktop:slack-work"),
      mkNotif(2, "Slack", "desktop:slack-personal"),
      mkNotif(3, "Discord", "desktop:discord"),
      mkNotif(4, "Mail", "desktop:thunderbird"),
      mkNotif(5, "Slack", "desktop:slack-work"),
    ];
    expect(notificationGroupKey(mkNotif(9, "   "))).toBe("unnamed:9");
    const grouped = groupNotificationPopups(popups, 3);
    expect(grouped.groups.length).toBe(3);
    expect(grouped.groups.map(g => g.appKey)).toEqual([
      "desktop:slack-work",
      "desktop:slack-personal",
      "desktop:discord",
    ]);
    expect(grouped.groups[0]!.items.map(i => i.id)).toEqual([1, 5]);
    expect(grouped.overflowCount).toBe(1);
  });

  test("resolveWorkspaceLabel respects workspace_numbers and partitionPluginBarWidgets places left/center/right/hidden zones", () => {
    const wsNamed = {
      workspace_id: 2,
      group_id: 1,
      name: "main",
      id_str: "2",
      coordinates: [2],
      active: true,
      urgent: false,
      hidden: false,
      capabilities: ["activate"] as const,
    };
    expect(resolveWorkspaceLabel(wsNamed, true)).toBe("2");
    expect(resolveWorkspaceLabel(wsNamed, false)).toBe("main");
    expect(resolveWorkspaceLabel({ ...wsNamed, coordinates: [1] }, true)).toBe("2");

    // Niri 0-based single-column coordinates ([0, 0]..[0, 3]) with id_str: null and unnamed numeric names
    const niriUnnamed = [1, 2, 3, 4].map((num, idx) => ({
      workspace_id: 12 + num,
      group_id: 20,
      name: String(num),
      id_str: null,
      coordinates: [0, idx],
      active: num === 1,
      urgent: false,
      hidden: false,
      capabilities: ["activate"] as const,
    }));
    expect(niriUnnamed.map((ws, idx) => resolveWorkspaceLabel(ws, true, idx))).toEqual(["1", "2", "3", "4"]);
    expect(niriUnnamed.map((ws, idx) => resolveWorkspaceLabel(ws, false, idx))).toEqual(["", "", "", ""]);
    expect(resolveWorkspaceLabel({ ...niriUnnamed[2]!, name: "work" }, false, 2)).toBe("work");

    const slots = [
      { id: "ai-default", entryId: "z-shell/ai-usage:bar-quota", instanceSlug: "default", outputId: "DP-1" },
      { id: "ai-primary", entryId: "z-shell/ai-usage:bar-quota", instanceSlug: "primary", outputId: "DP-1" },
      { id: "ai-hdmi", entryId: "z-shell/ai-usage:bar-quota", instanceSlug: "secondary", outputId: "HDMI-A-1" },
      { id: "weather", entryId: "acme/weather:bar-temp", instanceSlug: "default", outputId: "DP-1" },
      { id: "clock-extra", entryId: "acme/extra:widget", instanceSlug: "default", outputId: "DP-1" },
    ] as const;

    // Default (no [bar.plugins]): non-hidden widgets fall back to right zone in registration order.
    const defaultZones = partitionPluginBarWidgets(slots, undefined, { id: "DP-1", name: "DP-1" });
    expect(defaultZones.left).toEqual([]);
    expect(defaultZones.center).toEqual([]);
    expect(defaultZones.right.map(s => s.id)).toEqual(["ai-default", "ai-primary", "weather", "clock-extra"]);

    // Configured [bar.plugins]: explicit left/center/right/hidden + output matching, unassigned falls back to right.
    const configured = partitionPluginBarWidgets(
      slots,
      {
        left: ["z-shell/ai-usage:bar-quota"],
        center: [{ entry: "z-shell/ai-usage:bar-quota", instance: "primary", output: "DP-1" }],
        right: [],
        hidden: ["acme/weather:bar-temp"],
      },
      { id: "dp-1", name: "DP-1" },
    );
    expect(configured.left.map(s => s.id)).toEqual(["ai-default"]);
    expect(configured.center.map(s => s.id)).toEqual(["ai-primary"]);
    expect(configured.right.map(s => s.id)).toEqual(["clock-extra"]);
  });
});
