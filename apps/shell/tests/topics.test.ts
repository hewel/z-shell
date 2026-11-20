import { describe, expect, test } from "bun:test";

import {
  DEFAULT_BAR_SETTINGS,
  TOP_BAR_HEIGHT,
  VERTICAL_BAR_WIDTH,
  filterWorkspacesForMonitor,
  findActiveWindowForMonitor,
  formatBarClock,
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
