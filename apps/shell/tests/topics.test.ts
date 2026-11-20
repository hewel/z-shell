import { describe, expect, test } from "bun:test";

import {
  DEFAULT_BAR_SETTINGS,
  TOP_BAR_HEIGHT,
  VERTICAL_BAR_WIDTH,
  buildMonthCalendarGrid,
  filterWorkspacesForMonitor,
  findActiveWindowForMonitor,
  formatBarClock,
  formatBytesGiB,
  formatDurationSeconds,
  formatFullDate,
  formatMonthYear,
  formatTrackTimeUs,
  maxThermalCelsius,
  resolveBarLayout,
  resolveMonitorWallpaper,
  selectActiveMediaPlayer,
  type ActiveWallpaper,
  type BarPosition,
  type BarSettings,
  type DesktopMediaSnapshot,
  type EdgeOverrides,
  type MediaPlayer,
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
  test("resolves a top bar with custom gaps", () => {
    expect(resolveBarLayout(makeBarSettings("top", 10), { width: 1280, height: 720 })).toEqual({
      position: "top",
      isVertical: false,
      anchor: ["top", "left", "right"],
      margin: { top: 10, right: 10, bottom: 0, left: 10 },
      width: 1260,
      height: TOP_BAR_HEIGHT,
      exclusiveZone: 58,
    });
  });

  test("resolves a left vertical bar", () => {
    expect(resolveBarLayout(makeBarSettings("left", 12), { width: 1920, height: 1080 })).toEqual({
      position: "left",
      isVertical: true,
      anchor: ["left", "top", "bottom"],
      margin: { top: 12, right: 0, bottom: 12, left: 12 },
      width: VERTICAL_BAR_WIDTH,
      height: 1056,
      exclusiveZone: 64,
    });
  });

  test("resolves a right vertical bar", () => {
    expect(resolveBarLayout(makeBarSettings("right", 12), { width: 1920, height: 1080 })).toEqual({
      position: "right",
      isVertical: true,
      anchor: ["right", "top", "bottom"],
      margin: { top: 12, right: 12, bottom: 12, left: 0 },
      width: VERTICAL_BAR_WIDTH,
      height: 1056,
      exclusiveZone: 64,
    });
  });

  test("applies non-null edge overrides and falls back to gaps for null edges", () => {
    const layout = resolveBarLayout(
      makeBarSettings("top", 14, { top: 3, bottom: 9 }),
      { width: 1280, height: 720 },
    );

    expect(layout.margin).toEqual({ top: 3, right: 14, bottom: 9, left: 14 });
    expect(layout.width).toBe(1252);
    expect(layout.exclusiveZone).toBe(51);
  });

  test("uses default settings and enforces the minimum bar extent", () => {
    const layout = resolveBarLayout(undefined, { width: 200, height: 200 });

    expect(layout.position).toBe("top");
    expect(layout.margin).toEqual({ top: 14, right: 14, bottom: 0, left: 14 });
    expect(layout.width).toBe(240);
    expect(layout.height).toBe(TOP_BAR_HEIGHT);
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
