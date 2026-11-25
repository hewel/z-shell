import { beforeAll, describe, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PublishedApplication } from "@hewel/zgui-build";
import { buildShellPreviewFixture, makeTinyPngBytes } from "./fixture-builder.ts";
import {
  buildPublishedShell,
  createPreviewWorkspace,
  expectCleanPreview,
  zguiHost,
  pixel,
  previewAvailable,
  previewSessionLock,
  previewSurfaces,
  previewTest,
  readCapture,
  runPreview as runPreviewBundle,
  sessionLockTrace,
  shellDir,
  treeNode,
  type DecodedPng,
  type DeviceBounds,
} from "./preview-harness.ts";

function runPreview(fixture: string, scenario: string, out: string) {
  return runPreviewBundle(published.dist, fixture, scenario, out);
}

function centerPixel(image: DecodedPng, bounds: DeviceBounds | undefined): number[] {
  expect(bounds).toBeDefined();
  return pixel(image,
    Math.floor(bounds!.x + bounds!.width / 2),
    Math.floor(bounds!.y + bounds!.height / 2));
}

let published!: PublishedApplication;

describe("apps/shell preview", () => {
  beforeAll(async () => {
    if (!previewAvailable) return;
    published = await buildPublishedShell();
    expect(published.manifest.id).toBe("dev.zshell.shell");
    expect(published.manifest.capabilities?.sessionLock).toBe(true);
    expect(published.manifest.capabilities?.namedSockets).toContain("niri");
    expect(published.manifest.capabilities?.unixSockets).toContain(
      "$XDG_RUNTIME_DIR/z-shell/bus-${WAYLAND_DISPLAY}.sock",
    );
    expect(published.manifest.capabilities?.unixSockets).toContain(
      "$XDG_RUNTIME_DIR/z-shell/host-${WAYLAND_DISPLAY}.sock",
    );
  });

  previewTest("multi-output Top Bar, per-output Wallpapers, live theme, SNI tray blob + DBusMenu popup, and interactions", () => {
    expect(zguiHost && Bun.which(zguiHost)).not.toBeNull();

    const { out, cleanup } = createPreviewWorkspace("z-shell-preview-top-");
    try {
      const result = runPreview(
        join(shellDir, "preview/fixture.json"),
        join(shellDir, "preview/scenario.json"),
        out,
      );
      expectCleanPreview(result, 5, 6);

      const dpBar = readCapture(out, "bar-dp-1", "bar-dp-1");
      const hdmiBar = readCapture(out, "bar-hdmi-1", "bar-hdmi-1");
      const dpWallpaper = readCapture(out, "wallpaper-dp-1", "wallpaper-dp-1");
      const hdmiWallpaper = readCapture(out, "wallpaper-hdmi-1", "wallpaper-hdmi-1");
      const trayMenu = readCapture(out, "tray-menu", "tray-menu");
      for (const capture of [dpBar, hdmiBar, dpWallpaper, hdmiWallpaper, trayMenu]) {
        expect(capture.frame.renderer.alphaMode).toBe("PreMultiplied");
      }

      // Floating top bar includes transparent shadowBleed (10px top, 22px bottom, 14px sides).
      expect([dpBar.image.width, dpBar.image.height]).toEqual([1440, 64]);
      expect([hdmiBar.image.width, hdmiBar.image.height]).toEqual([1280, 64]);
      expect(pixel(dpBar.image, 0, 0)).toEqual([0, 0, 0, 0]);
      expect(pixel(hdmiBar.image, 0, 0)).toEqual([0, 0, 0, 0]);
      const ws2Bounds = treeNode(dpBar.tree, "ws-2").boundsDevice!;
      // Sample the active pill fill inside its left padding (avoiding the centered glyph "2").
      expect(pixel(dpBar.image, Math.floor(ws2Bounds.x + 6), Math.floor(ws2Bounds.y + ws2Bounds.height / 2)))
        .toEqual([0x7d, 0xd3, 0xfc, 255]);
      expect(centerPixel(dpBar.image, treeNode(dpBar.tree, "tray-item-discord").boundsDevice))
        .toEqual([0x58, 0x65, 0xf2, 255]);

      expect([dpWallpaper.image.width, dpWallpaper.image.height]).toEqual([1440, 900]);
      expect([hdmiWallpaper.image.width, hdmiWallpaper.image.height]).toEqual([1280, 720]);
      expect(pixel(dpWallpaper.image, 720, 450)).toEqual([0x14, 0x7a, 0x82, 255]);
      expect(pixel(hdmiWallpaper.image, 640, 360)).toEqual([0x32, 0x2c, 0x78, 255]);

      expect(treeNode(trayMenu.tree, "tray-menu-item-101").text).toBe("Mute");
      expect(trayMenu.image.width).toBeGreaterThan(0);
      expect(trayMenu.image.height).toBeGreaterThan(0);
      expect(trayMenu.image.data.some((value, index) => index % 4 === 3 && value !== 0)).toBe(true);
    } finally {
      cleanup();
    }
  });

  previewTest("Vertical Bar (position: \"left\") renders 52px layout with transparent corners and clean teardown", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-left-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-vertical-bar",
        initialTopics: {
          settings: {
            general: { offline_mode: false, log_level: "info" },
            bar: {
              position: "left",
              gaps: 14,
              edge_overrides: { top: null, right: null, bottom: null, left: null },
              launcher_enabled: true,
              dock_enabled: true,
              clock_24h: true,
              clock_seconds: true,
            },
            theme: { mode: "dark", variant: "tonal", seed_color: null, backend: "builtin", gtk_linking: false },
            ime: { mode: "indicator_only", candidate_layout: "auto", switch_osd: true },
            polkit: { enabled: true },
            wallpaper: { directories: [], fit: "cover", sync_theme: true, slideshow_seconds: 300 },
            pre_action_fade_seconds: 0,
            configured_plugins: [],
          },
          "wayland.workspaces": {
            capability: "controllable",
            groups: [],
            workspaces: [1, 2, 3, 4].map(workspaceId => ({
              workspace_id: workspaceId,
              group_id: null,
              name: String(workspaceId),
              id_str: String(workspaceId),
              coordinates: [workspaceId - 1],
              active: workspaceId === 2,
              urgent: false,
              hidden: false,
              capabilities: ["activate"],
            })),
          },
        },
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-vertical-bar",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: [
          {
            id: "outputs",
            op: "monitors.set",
            monitors: [{
              id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
              scale: 1, refreshRateMilliHz: 60000,
            }],
          },
          { id: "daemon-events", op: "clock.advance", byMs: 30 },
          { id: "ready", op: "settle" },
          {
            id: "active-workspace",
            op: "assert",
            target: { surface: "bar-dp-1", testId: "ws-2" },
            check: { property: "text", equals: "2" },
          },
          { id: "bar-capture", op: "capture", surface: "bar-dp-1", captureId: "bar-dp-1" },
        ],
      }, null, 2));

      const result = runPreview(fixture, scenario, out);
      expectCleanPreview(result, 1, 1);
      const bar = readCapture(out, "bar-dp-1", "bar-dp-1");
      expect(bar.frame.renderer.alphaMode).toBe("PreMultiplied");
      // Floating left bar (40px island + 14px left/22px right bleed, 10px top/14px bottom bleed).
      expect([bar.image.width, bar.image.height]).toEqual([76, 896]);
      expect(treeNode(bar.tree, "bar-root-dp-1").boundsDevice?.width).toBe(76);
      expect(treeNode(bar.tree, "bar-workspaces").boundsDevice?.width).toBe(40);
      expect(treeNode(bar.tree, "ws-2").text).toBe("2");
      expect(pixel(bar.image, 0, 0)).toEqual([0, 0, 0, 0]);
    } finally {
      cleanup();
    }
  });

  previewTest("Quick Settings popup + Wi-Fi password, Sound, Wallpaper Picker subpages, and popupDone dismiss", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-quick-settings-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-quick-settings-panels",
        initialTopics: {
          "system.network": {
            available: true,
            connectivity: "full",
            wifi: {
              enabled: true,
              hardware_enabled: true,
              scanning: false,
              devices: [{
                id: "wlan0",
                interface: "wlan0",
                active_ap_id: null,
                active_connection: null,
                access_points: [{
                  id: "ap-shoji-lab",
                  ssid: "Shoji-Lab",
                  ssid_bytes: [],
                  bssid: "00:11:22:33:44:55",
                  strength: 91,
                  security: "wpa_sae",
                }],
              }],
              profiles: [],
            },
            ethernet: [],
            vpn: [],
          },
          "system.audio": {
            availability: "available",
            default_sink: "sink-1",
            default_source: "source-1",
            sinks: [{ index: 7, name: "sink-1", description: "Speakers", channels: 2, volume: 0.65, muted: false }],
            sources: [{ index: 8, name: "source-1", description: "Microphone", channels: 1, volume: 0.5, muted: false }],
            sink_inputs: [],
            source_outputs: [],
          },
          "system.power": {
            available: true,
            on_ac: true,
            battery: {
              percentage: 84,
              state: "charging",
              time_to_empty_seconds: null,
              time_to_full_seconds: 3600,
              energy_rate_watts: 12,
              capacity_percent: 100,
              charge_cycles: 42,
            },
            profiles: { available: true, active_profile: "balanced", profiles: ["power-saver", "balanced", "performance"] },
          },
          wallpaper: {
            available: true,
            fit: "cover",
            sync_theme: true,
            slideshow_seconds: 300,
            catalog_count: 1,
            current: null,
            per_output: {},
            last_error: null,
          },
        },
        commands: [
          {
            socket: "host",
            id: 3,
            name: "network.wifi.connect",
            payload: { device_id: "wlan0", ap_id: "ap-shoji-lab", password: "shoji-secret" },
            atMs: 295,
          },
          {
            id: 26,
            name: "wallpaper.list",
            payload: { offset: 0, limit: 16 },
            atMs: 300,
            result: {
              data: {
                items: [{
                  id: "aurora",
                  name: "Aurora",
                  source_path: "/wallpapers/aurora.png",
                  width: 1,
                  height: 1,
                  thumbnail: { kind: "blob_handle", token: "wallpaper-aurora-thumb", mime: "image/png", byte_len: 70 },
                }],
                total: 1,
              },
            },
          },
          {
            socket: "host",
            id: 4,
            name: "wallpaper.fetch-blob",
            payload: { token: "wallpaper-aurora-thumb" },
            atMs: 305,
            result: { data: { bytes: makeTinyPngBytes(0x7c, 0xd4, 0xff) } },
          },
          {
            id: 27,
            name: "wallpaper.set",
            payload: { path: "/wallpapers/aurora.png", output: null, fit: "cover" },
            atMs: 315,
          },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-quick-settings-panels",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: [
          {
            id: "outputs",
            op: "monitors.set",
            monitors: [{
              id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
              scale: 1, refreshRateMilliHz: 60000,
            }],
          },
          { id: "daemon-events", op: "clock.advance", byMs: 30 },
          { id: "ready", op: "settle" },
          {
            id: "open-quick-settings",
            op: "pointer.click",
            target: { surface: "bar-dp-1", testId: "bar-audio" },
            button: "primary",
          },
          { id: "present-quick-settings", op: "clock.advance", byMs: 10 },
          { id: "capture-quick-settings", op: "capture", surface: "panel-quick-settings", captureId: "panel-quick-settings" },
          {
            id: "open-wifi",
            op: "pointer.click",
            target: { surface: "panel-quick-settings", testId: "qs-open-wifi" },
            button: "primary",
          },
          {
            id: "select-secured-ap",
            op: "pointer.click",
            target: { surface: "panel-quick-settings", testId: "wifi-ap-Shoji-Lab" },
            button: "primary",
          },
          { id: "expand-wifi-password", op: "clock.advance", byMs: 250 },
          {
            id: "focus-wifi-password",
            op: "pointer.click",
            target: { surface: "panel-quick-settings", testId: "wifi-password-input" },
            button: "primary",
          },
          { id: "enter-wifi-password", op: "text.commit", surface: "panel-quick-settings", text: "shoji-secret" },
          {
            id: "connect-wifi",
            op: "pointer.click",
            target: { surface: "panel-quick-settings", testId: "wifi-password-connect" },
            button: "primary",
          },
          { id: "wifi-connect-reply", op: "clock.advance", byMs: 5 },
          {
            id: "wifi-back",
            op: "pointer.click",
            target: { surface: "panel-quick-settings", testId: "qs-back" },
            button: "primary",
          },
          {
            id: "open-sound",
            op: "pointer.click",
            target: { surface: "panel-quick-settings", testId: "qs-open-sound" },
            button: "primary",
          },
          {
            id: "sound-visible",
            op: "assert",
            target: { surface: "panel-quick-settings", testId: "qs-page-sound" },
            check: { property: "exists", equals: true },
          },
          {
            id: "sound-back",
            op: "pointer.click",
            target: { surface: "panel-quick-settings", testId: "qs-back" },
            button: "primary",
          },
          {
            id: "open-wallpaper",
            op: "pointer.click",
            target: { surface: "panel-quick-settings", testId: "qs-tile-wallpaper" },
            button: "primary",
          },
          { id: "wallpaper-list-reply", op: "clock.advance", byMs: 5 },
          { id: "wallpaper-thumbnail-reply", op: "clock.advance", byMs: 5 },
          { id: "wallpaper-thumbnail-ready", op: "clock.advance", byMs: 5 },
          { id: "capture-settings", op: "capture", surface: "settings-window", captureId: "settings-window" },
          {
            id: "select-wallpaper",
            op: "pointer.click",
            target: { surface: "settings-window", testId: "settings-wp-aurora" },
            button: "primary",
          },
          { id: "wallpaper-set-reply", op: "clock.advance", byMs: 5 },
          {
            id: "close-settings-window",
            op: "pointer.click",
            target: { surface: "settings-window", testId: "settings-window-close" },
            button: "primary",
          },
          { id: "dismiss-settled", op: "settle" },
          {
            id: "bar-healthy-after-dismiss",
            op: "assert",
            target: { surface: "bar-dp-1", testId: "bar-audio" },
            check: { property: "exists", equals: true },
          },
        ],
      }, null, 2));

      const result = runPreview(fixture, scenario, out);
      expectCleanPreview(result, 2, 2);
      const settingsCapture = readCapture(out, "settings-window", "settings-window");
      expect(centerPixel(settingsCapture.image, treeNode(settingsCapture.tree, "settings-wp-aurora").boundsDevice))
        .toEqual([0x7c, 0xd4, 0xff, 255]);
      const quickSettings = readCapture(out, "panel-quick-settings", "panel-quick-settings");
      expect(quickSettings.frame.renderer.alphaMode).toBe("PreMultiplied");
      expect(quickSettings.frame.windowGeometry?.width).toBe(396);
      expect(quickSettings.image.width).toBe(396 + 56);
      expect(quickSettings.frame.windowGeometry?.height).toBeGreaterThan(200);
      expect(quickSettings.frame.windowGeometry?.height).toBeLessThanOrEqual(760);
      expect(pixel(quickSettings.image, 0, 0)).toEqual([0, 0, 0, 0]);
      expect(treeNode(quickSettings.tree, "qs-main").boundsDevice).toBeDefined();
      expect(treeNode(quickSettings.tree, "qs-tile-wifi").boundsDevice).toBeDefined();
      expect(treeNode(quickSettings.tree, "qs-tile-wallpaper").boundsDevice).toBeDefined();
      expect(quickSettings.tree.nodes.some(node => node.text === "hewel")).toBe(true);
      expect(quickSettings.tree.nodes.some(node => node.text === "84%")).toBe(true);
    } finally {
      cleanup();
    }
  });

  previewTest("Calendar/Notifications, Media Player, Battery, and Clipboard panels with clipboard.fetch-blob PNG decoding", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-panels-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-calendar-media-battery-clipboard",
        initialTopics: {
          "desktop.notifications": {
            available: true,
            dnd: false,
            popups: [],
            history: [1, 2].map(id => ({
              id,
              revision: 1,
              app_name: "Shoji",
              summary: `Notification ${id}`,
              body: "Phase 2 preview",
              icon: null,
              attachment: null,
              actions: [],
              urgency: 1,
            })),
          },
          "desktop.media": {
            available: true,
            players: [{
              id: "nujabes",
              identity: "Nujabes",
              playback_status: "playing",
              position_us: 42_000_000,
              metadata: {
                track_id: "feather",
                title: "Feather",
                album: "Modal Soul",
                artists: ["Nujabes"],
                length_us: 174_000_000,
              },
              capabilities: {
                can_control: true,
                can_play: true,
                can_pause: true,
                can_go_next: true,
                can_go_previous: true,
                can_seek: true,
              },
            }],
            selected_player_id: "nujabes",
            any_playing: true,
            cover: null,
          },
          "system.power": {
            available: true,
            on_ac: true,
            battery: {
              percentage: 84,
              state: "charging",
              time_to_empty_seconds: null,
              time_to_full_seconds: 3600,
              energy_rate_watts: 12,
              capacity_percent: 100,
              charge_cycles: 42,
            },
            profiles: { available: true, active_profile: "balanced", profiles: ["power-saver", "balanced", "performance"] },
          },
          clipboard: {
            persistence: { mode: "encrypted" },
            transport: { status: "ready" },
            locked: "unlocked",
            entry_count: 2,
            entries: [
              {
                id: 11,
                kind: "text",
                mime: "text/plain",
                preview: "Pinned launch note",
                pinned: true,
                byte_len: 17,
              },
              {
                id: 12,
                kind: "image",
                mime: "image/png",
                preview: "green.png",
                pinned: false,
                byte_len: 70,
                dimensions: { width: 1, height: 1 },
                media: { kind: "blob_handle", token: "clipboard-green", mime: "image/png", byte_len: 70 },
              },
            ],
          },
        },
        commands: [
          { id: 26, name: "notifications.set-dnd", payload: { dnd: true }, atMs: 40 },
          { id: 27, name: "media.play-pause", payload: { player_id: "nujabes" }, atMs: 50 },
          { id: 28, name: "power.set-profile", payload: { profile: "performance" }, atMs: 60 },
          {
            socket: "host",
            id: 3,
            name: "clipboard.fetch-blob",
            payload: { token: "clipboard-green" },
            atMs: 70,
            result: { data: { bytes: makeTinyPngBytes(0x22, 0xc5, 0x5e) } },
          },
          { id: 29, name: "clipboard.copy", payload: { id: 11 }, atMs: 390 },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-calendar-media-battery-clipboard",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: [
          {
            id: "outputs",
            op: "monitors.set",
            monitors: [{
              id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
              scale: 1, refreshRateMilliHz: 60000,
            }],
          },
          { id: "daemon-events", op: "clock.advance", byMs: 30 },
          { id: "ready", op: "settle" },
          {
            id: "open-calendar",
            op: "pointer.click",
            target: { surface: "bar-dp-1", testId: "bar-clock" },
            button: "primary",
          },
          {
            id: "toggle-dnd",
            op: "pointer.click",
            target: { surface: "panel-calendar", testId: "cal-dnd-toggle" },
            button: "primary",
          },
          { id: "dnd-reply", op: "clock.advance", byMs: 10 },
          { id: "capture-calendar", op: "capture", surface: "panel-calendar", captureId: "panel-calendar" },
          {
            id: "open-media",
            op: "pointer.click",
            target: { surface: "bar-dp-1", testId: "bar-media" },
            button: "primary",
          },
          {
            id: "toggle-media-playback",
            op: "pointer.click",
            target: { surface: "panel-media", testId: "media-play-pause" },
            button: "primary",
          },
          { id: "media-reply", op: "clock.advance", byMs: 10 },
          { id: "capture-media", op: "capture", surface: "panel-media", captureId: "panel-media" },
          {
            id: "open-battery",
            op: "pointer.click",
            target: { surface: "bar-dp-1", testId: "bar-battery" },
            button: "primary",
          },
          {
            id: "select-power-profile",
            op: "pointer.click",
            target: { surface: "panel-battery", testId: "battery-profile-performance" },
            button: "primary",
          },
          { id: "power-profile-reply", op: "clock.advance", byMs: 10 },
          { id: "capture-battery", op: "capture", surface: "panel-battery", captureId: "panel-battery" },
          {
            id: "open-clipboard",
            op: "service.emit",
            channel: "control.message",
            value: { args: ["panel", "clipboard"], reply: { text: "{\"activePanel\":\"clipboard\"}" } },
          },
          { id: "clipboard-blob-reply", op: "clock.advance", byMs: 10 },
          { id: "clipboard-image-ready", op: "clock.advance", byMs: 300 },
          { id: "capture-clipboard", op: "capture", surface: "clipboard-overlay", captureId: "clipboard-overlay" },
          { id: "type-clipboard-search", op: "text.commit", surface: "clipboard-overlay", text: "Pinned" },
          { id: "clipboard-search-settled", op: "clock.advance", byMs: 5 },
          {
            id: "clipboard-search-keeps-match",
            op: "assert",
            target: { surface: "clipboard-overlay", testId: "clip-entry-11" },
            check: { property: "exists", equals: true },
          },
          {
            id: "clipboard-search-hides-nonmatch",
            op: "assert",
            target: { surface: "clipboard-overlay", testId: "clip-entry-12" },
            check: { property: "exists", equals: false },
          },
          {
            id: "filter-clipboard-text",
            op: "pointer.click",
            target: { surface: "clipboard-overlay", testId: "clipboard-filter-text" },
            button: "primary",
          },
          { id: "clipboard-filter-settled", op: "clock.advance", byMs: 5 },
          {
            id: "copy-text-entry",
            op: "pointer.click",
            target: { surface: "clipboard-overlay", testId: "clip-copy-11" },
            button: "primary",
          },
          { id: "clipboard-copy-reply", op: "clock.advance", byMs: 10 },
          { id: "clipboard-exit-settle", op: "clock.advance", byMs: 300 },
          { id: "clipboard-close-settled", op: "settle" },
          {
            id: "bar-healthy-after-clipboard-close",
            op: "assert",
            target: { surface: "bar-dp-1", testId: "bar-clock" },
            check: { property: "exists", equals: true },
          },
        ],
      }, null, 2));

      const result = runPreview(fixture, scenario, out);
      expectCleanPreview(result, 4, 3);
      const calendar = readCapture(out, "panel-calendar", "panel-calendar");
      const media = readCapture(out, "panel-media", "panel-media");
      const battery = readCapture(out, "panel-battery", "panel-battery");
      const clipboard = readCapture(out, "clipboard-overlay", "clipboard-overlay");
      for (const capture of [calendar, media, battery]) {
        expect(capture.frame.renderer.alphaMode).toBe("PreMultiplied");
        expect(capture.image.width).toBeGreaterThan(0);
        expect(capture.image.height).toBeGreaterThan(0);
        expect(pixel(capture.image, 0, 0)).toEqual([0, 0, 0, 0]);
      }
      expect(clipboard.frame.renderer.alphaMode).toBe("PreMultiplied");
      expect([clipboard.image.width, clipboard.image.height]).toEqual([1440, 900]);
      expect(pixel(clipboard.image, 0, 0)[3]).toBeGreaterThan(0);
      expect(Math.round(treeNode(clipboard.tree, "clipboard-card").boundsLogical!.width)).toBe(560);

      expect(treeNode(calendar.tree, "cal-month-title").text).toBe("November 2023");
      expect(treeNode(calendar.tree, "cal-today-cell").text).toBe("14");
      expect(treeNode(calendar.tree, "cal-notif-count").text).toBe("2");
      expect(calendar.tree.nodes.some(node => node.text === "Notification 1")).toBe(true);
      // Single-owner IA (DESIGN.md): system telemetry lives in Settings > Power, not Calendar.
      expect(calendar.tree.nodes.some(node => node.text === "46°C")).toBe(false);
      expect(treeNode(media.tree, "media-title").text).toBe("Feather");
      expect(treeNode(battery.tree, "battery-percent").text).toBe("84%");
      expect(treeNode(clipboard.tree, "clip-entry-11").boundsDevice).toBeDefined();
      expect(treeNode(clipboard.tree, "clipboard-count").text).toBe("2 kept");
      expect(clipboard.tree.nodes.some(node => node.text === "Pinned launch note")).toBe(true);
      expect(centerPixel(clipboard.image, treeNode(clipboard.tree, "clip-image-12").boundsDevice))
        .toEqual([0x22, 0xc5, 0x5e, 255]);
      // Esc keycap badge and its text must be vertically centered inside clipboard-search-bar.
      const clipSearchBar = treeNode(clipboard.tree, "clipboard-search-bar").boundsLogical!;
      const clipEscBadge = treeNode(clipboard.tree, "clipboard-esc-badge").boundsLogical!;
      const clipEscText = treeNode(clipboard.tree, "clipboard-esc-text").boundsLogical!;
      const midY = (b: { readonly y: number; readonly height: number }) => b.y + b.height / 2;
      expect(Math.abs(midY(clipEscBadge) - midY(clipSearchBar)), "clipboard Esc badge centered in search bar").toBeLessThanOrEqual(1);
      expect(Math.abs(midY(clipEscText) - midY(clipEscBadge)), "clipboard Esc text centered in badge").toBeLessThanOrEqual(1);
    } finally {
      cleanup();
    }
  });

  previewTest("Notification toasts (click-through inputRegion), live-only Volume/IME OSD + auto-dismiss, Idle fade overlay, and Fcitx5 Kimpanel candidate popup", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-overlays-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const audio = (volume: number) => ({
        availability: "available",
        default_sink: "sink-1",
        default_source: "source-1",
        sinks: [{ index: 7, name: "sink-1", description: "Speakers", channels: 2, volume, muted: false }],
        sources: [{ index: 8, name: "source-1", description: "Microphone", channels: 1, volume: 0.5, muted: false }],
        sink_inputs: [],
        source_outputs: [],
      });
      const ime = (activeIm: { unique_name: string; label: string; short_label: string; text: string }) => ({
        mode: "kimpanel",
        candidate_layout: "auto",
        switch_osd: true,
        available: true,
        enabled: true,
        active_im: { ...activeIm, icon: null },
        properties: [],
        group_ims: [
          { unique_name: "pinyin", label: "Pinyin", layout: "us" },
          { unique_name: "rime", label: "Rime", layout: "us" },
        ],
        exec_menu: null,
      });
      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-phase-3-overlays",
        initialTopics: {
          "desktop.notifications": {
            available: true,
            dnd: false,
            popups: [1, 2].map(id => ({
              id,
              revision: 1,
              app_name: "Shoji",
              summary: `Notification ${id}`,
              body: "Phase 3 preview",
              icon: null,
              attachment: null,
              actions: [{ key: "open", label: "Open" }],
              urgency: 1,
            })),
            history: [],
          },
          "desktop.ime": ime({ unique_name: "pinyin", label: "Pinyin", short_label: "拼", text: "拼" }),
          "desktop.ime.panel": {
            visible: true,
            aux: "",
            preedit: "nihao",
            caret: 0,
            lookup_table: {
              labels: ["1", "2", "3"],
              texts: ["你好", "拟好", "泥蒿"],
              attrs: ["", "", ""],
              has_prev: false,
              has_next: true,
              cursor: 0,
              layout: "horizontal",
            },
            spot_rect: { x: 120, y: 200, w: 0, h: 24, relative: false, scale: 1 },
          },
          "system.audio": audio(0.65),
        },
        topicUpdates: [
          { topic: "system.audio", atMs: 40, revision: 2, sourceBaseline: false, data: audio(0.80) },
          {
            topic: "desktop.ime",
            atMs: 1950,
            revision: 2,
            sourceBaseline: false,
            data: ime({ unique_name: "rime", label: "Rime", short_label: "R", text: "R" }),
          },
          {
            topic: "session.idle",
            atMs: 1960,
            revision: 2,
            sourceBaseline: false,
            data: {
              caffeine: false,
              media_playing: false,
              active_inhibitors: [],
              warning: { token: 1, fade_seconds: 5, rules: ["lock"] },
              rules: [],
              service_status: { status: "running" },
            },
          },
        ],
        commands: [
          {
            id: 26,
            name: "notifications.invoke-action",
            payload: { id: 1, action_key: "open" },
            atMs: 40,
          },
          { id: 27, name: "notifications.set-paused", payload: { paused: true }, atMs: 40 },
          { id: 28, name: "notifications.dismiss", payload: { id: 1 }, atMs: 40 },
          { id: 29, name: "ime.select-candidate", payload: { index: 1 }, atMs: 2070 },
          { id: 30, name: "ime.page-down", payload: {}, atMs: 2070 },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-phase-3-overlays",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: [
          {
            id: "outputs",
            op: "monitors.set",
            monitors: [{
              id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
              scale: 1, refreshRateMilliHz: 60000,
            }],
          },
          { id: "daemon-events", op: "clock.advance", byMs: 30 },
          { id: "ready", op: "settle" },
          {
            id: "baseline-surfaces",
            op: "monitors.set",
            monitors: [{
              id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
              scale: 1, refreshRateMilliHz: 60000,
            }],
          },
          { id: "capture-toasts", op: "capture", surface: "notification-toasts", captureId: "notification-toasts" },
          {
            id: "invoke-notification-action",
            op: "pointer.click",
            target: { surface: "notification-toasts", testId: "toast-action-1-open" },
            button: "primary",
          },
          {
            id: "dismiss-notification",
            op: "pointer.click",
            target: { surface: "notification-toasts", testId: "toast-dismiss-1" },
            button: "primary",
          },
          { id: "live-volume-update", op: "clock.advance", byMs: 10 },
          {
            id: "volume-osd-value",
            op: "assert",
            target: { surface: "osd-overlay", testId: "osd-value" },
            check: { property: "text", equals: "80%" },
          },
          { id: "capture-volume-osd", op: "capture", surface: "osd-overlay", captureId: "osd-overlay" },
          { id: "volume-osd-auto-dismiss", op: "clock.advance", byMs: 1900 },
          {
            id: "osd-dismissed-surfaces",
            op: "monitors.set",
            monitors: [{
              id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
              scale: 1, refreshRateMilliHz: 60000,
            }],
          },
          { id: "live-ime-update", op: "clock.advance", byMs: 10 },
          {
            id: "ime-osd-visible",
            op: "assert",
            target: { surface: "osd-overlay", testId: "osd-label" },
            check: { property: "text", equals: "Rime" },
          },
          { id: "idle-warning-and-reveal", op: "clock.advance", byMs: 100 },
          { id: "capture-idle-fade", op: "capture", surface: "idle-fade-dp-1", captureId: "idle-fade-dp-1" },
          { id: "capture-kimpanel", op: "capture", surface: "kimpanel-popup", captureId: "kimpanel-popup" },
          {
            id: "select-second-candidate",
            op: "pointer.click",
            target: { surface: "kimpanel-popup", testId: "kimpanel-cand-1" },
            button: "primary",
          },
          {
            id: "page-candidates",
            op: "wheel",
            target: { surface: "kimpanel-popup", testId: "kimpanel-root" },
            delta: { x: 0, y: 1, unit: "pixels" },
          },
          { id: "command-replies", op: "clock.advance", byMs: 20 },
        ],
      }, null, 2));

      const result = runPreview(fixture, scenario, out);
      expectCleanPreview(result, 4, 2);
      expect(previewSurfaces(out, "baseline-surfaces")).not.toContain("osd-overlay");
      expect(previewSurfaces(out, "osd-dismissed-surfaces")).not.toContain("osd-overlay");
      const toasts = readCapture(out, "notification-toasts", "notification-toasts");
      const osd = readCapture(out, "osd-overlay", "osd-overlay");
      const idle = readCapture(out, "idle-fade-dp-1", "idle-fade-dp-1");
      const kimpanel = readCapture(out, "kimpanel-popup", "kimpanel-popup");
      for (const capture of [toasts, osd, idle, kimpanel]) {
        expect(capture.frame.renderer.alphaMode).toBe("PreMultiplied");
      }

      expect(pixel(toasts.image, 0, 0)).toEqual([0, 0, 0, 0]);
      expect(treeNode(toasts.tree, "toast-card-1").boundsDevice).toBeDefined();
      expect(treeNode(toasts.tree, "toast-action-1-open").boundsDevice).toBeDefined();
      expect(treeNode(toasts.tree, "toast-more-footer").boundsDevice).toBeDefined();
      expect(toasts.tree.nodes.some(node => node.text === "+1 more")).toBe(true);
      expect(treeNode(osd.tree, "osd-value").text).toBe("80%");

      const idleScrim = pixel(idle.image, 0, 0);
      expect(idleScrim[3]).toBeGreaterThan(0);
      expect(idleScrim[3]).toBeLessThan(255);
      expect(treeNode(idle.tree, "idle-warning-dp-1").boundsDevice).toBeDefined();
      expect(idle.tree.nodes.some(node => node.text === "lock")).toBe(true);

      expect(kimpanel.tree.nodes.some(node => node.text === "nihao")).toBe(true);
      for (const candidate of ["你好", "拟好", "泥蒿"]) {
        expect(kimpanel.tree.nodes.some(node => node.text === candidate)).toBe(true);
      }
      const firstCandidate = treeNode(kimpanel.tree, "kimpanel-cand-0").boundsDevice;
      const secondCandidate = treeNode(kimpanel.tree, "kimpanel-cand-1").boundsDevice;
      expect(firstCandidate).toBeDefined();
      expect(secondCandidate).toBeDefined();
      expect(secondCandidate!.x).toBeGreaterThan(firstCandidate!.x);
    } finally {
      cleanup();
    }
  });

  previewTest("Dock surface (pinned + running apps) and App Launcher overlay (exclusive keyboard, query_id correlation, keyboard activation)", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-dock-launcher-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const alacritty = {
        provider_id: "desktop",
        item_id: "alacritty.desktop",
        title: "Alacritty",
        actions: [],
        score: 100,
      };
      const zen = {
        provider_id: "desktop",
        item_id: "zen.desktop",
        title: "Zen Browser",
        actions: [],
        score: 90,
      };
      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-phase-3-dock-launcher",
        initialTopics: {
          "desktop.apps": {
            available: true,
            count: 2,
            pinned_apps: ["alacritty.desktop", "zen.desktop"],
          },
          "wayland.windows": {
            capability: "controllable",
            windows: [
              {
                window_id: 41,
                title: "Terminal — Alacritty",
                app_id: "Alacritty",
                activated: true,
                minimized: false,
                maximized: false,
                fullscreen: false,
                output_instance_ids: [1],
              },
              {
                window_id: 42,
                title: "Firefox",
                app_id: "firefox",
                activated: false,
                minimized: false,
                maximized: false,
                fullscreen: false,
                output_instance_ids: [1],
              },
            ],
          },
        },
        commands: [
          { id: 26, name: "wayland.window.activate", payload: { window_id: 41 }, atMs: 40 },
          {
            id: 27,
            name: "launcher.query",
            payload: { query: "", query_id: 1, limit: 18 },
            atMs: 40,
            result: { data: { query_id: 1, items: [zen, alacritty] } },
          },
          {
            id: 28,
            name: "launcher.query",
            payload: { query: "ala", query_id: 2, limit: 18 },
            atMs: 50,
            result: { data: { query_id: 2, items: [alacritty] } },
          },
          {
            id: 29,
            name: "launcher.activate",
            payload: { query_id: 2, provider_id: "desktop", item_id: "alacritty.desktop" },
            atMs: 60,
          },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-phase-3-dock-launcher",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: [
          {
            id: "outputs",
            op: "monitors.set",
            monitors: [{
              id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
              scale: 1, refreshRateMilliHz: 60000,
            }],
          },
          { id: "daemon-events", op: "clock.advance", byMs: 30 },
          { id: "ready", op: "settle" },
          { id: "capture-dock", op: "capture", surface: "dock-dp-1", captureId: "dock-dp-1" },
          {
            id: "activate-running-pinned-app",
            op: "pointer.click",
            target: { surface: "dock-dp-1", testId: "dock-app-alacritty.desktop" },
            button: "primary",
          },
          {
            id: "open-launcher",
            op: "pointer.click",
            target: { surface: "dock-dp-1", testId: "dock-launcher" },
            button: "primary",
          },
          { id: "initial-query-reply", op: "clock.advance", byMs: 10 },
          { id: "capture-launcher", op: "capture", surface: "launcher-overlay", captureId: "launcher-overlay" },
          {
            id: "focus-launcher-search",
            op: "pointer.click",
            target: { surface: "launcher-overlay", testId: "launcher-search" },
            button: "primary",
          },
          { id: "filter-launcher", op: "text.commit", surface: "launcher-overlay", text: "ala" },
          { id: "filtered-query-reply", op: "clock.advance", byMs: 10 },
          { id: "activate-filtered-result", op: "key.press", surface: "launcher-overlay", key: "Enter" },
          { id: "activation-reply", op: "clock.advance", byMs: 10 },
          { id: "launcher-exit-motion", op: "clock.advance", byMs: 220 },
          { id: "launcher-closed-settled", op: "settle" },
          {
            id: "launcher-closed-surfaces",
            op: "monitors.set",
            monitors: [{
              id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
              scale: 1, refreshRateMilliHz: 60000,
            }],
          },
        ],
      }, null, 2));

      const result = runPreview(fixture, scenario, out);
      expectCleanPreview(result, 2, 0);
      expect(previewSurfaces(out, "launcher-closed-surfaces")).not.toContain("launcher-overlay");
      const dock = readCapture(out, "dock-dp-1", "dock-dp-1");
      const launcher = readCapture(out, "launcher-overlay", "launcher-overlay");
      expect(dock.frame.renderer.alphaMode).toBe("PreMultiplied");
      expect(launcher.frame.renderer.alphaMode).toBe("PreMultiplied");
      expect(pixel(dock.image, 0, 0)).toEqual([0, 0, 0, 0]);
      expect(treeNode(dock.tree, "dock-app-alacritty.desktop").boundsDevice).toBeDefined();
      expect(treeNode(dock.tree, "dock-app-zen.desktop").boundsDevice).toBeDefined();
      expect(treeNode(dock.tree, "dock-running-firefox").boundsDevice).toBeDefined();
      expect(treeNode(launcher.tree, "launcher-search").boundsDevice).toBeDefined();
      expect(treeNode(launcher.tree, "launcher-item-desktop-zen.desktop").boundsDevice).toBeDefined();
      expect(treeNode(launcher.tree, "launcher-item-desktop-alacritty.desktop").boundsDevice).toBeDefined();
      expect(launcher.tree.nodes.some(node => node.text === "Zen Browser")).toBe(true);
      expect(launcher.tree.nodes.some(node => node.text === "Alacritty")).toBe(true);
    } finally {
      cleanup();
    }
  });

  previewTest("ADR-0004 Session Lock: multi-output opaque SessionLockSurface, PAM failure -> retry -> scoped unlock, plus compositor refusal", () => {
    const { workspace, cleanup } = createPreviewWorkspace("z-shell-preview-session-lock-");
    const lockedOut = join(workspace, "locked-out");
    const refusedOut = join(workspace, "refused-out");
    const monitors = [
      {
        id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
        scale: 1, refreshRateMilliHz: 60000,
      },
      {
        id: "hdmi-1", name: "HDMI-A-1", x: 1440, y: 0, width: 1280, height: 720,
        scale: 1, refreshRateMilliHz: 60000,
      },
    ];
    try {
      const lockedFixture = join(workspace, "locked-fixture.json");
      const lockedScenario = join(workspace, "locked-scenario.json");
      const fixtureValue = buildShellPreviewFixture({
        id: "z-shell-phase-4-session-lock",
        sessionLock: { outcome: "locked" },
        topicUpdates: [
          {
            topic: "session.lock",
            atMs: 40,
            revision: 2,
            data: {
              phase: "engaging", lock_id: 7, sleep_hold: false, host_connected: true,
              ui_session_generation: 1, last_error: null,
            },
          },
          {
            topic: "session.lock",
            atMs: 45,
            revision: 3,
            data: {
              phase: "locked", lock_id: 7, sleep_hold: false, host_connected: true,
              ui_session_generation: 1, last_error: null,
            },
          },
          {
            topic: "session.lock",
            atMs: 75,
            revision: 4,
            data: {
              phase: "unlocked", lock_id: null, sleep_hold: false, host_connected: true,
              ui_session_generation: 1, last_error: null,
            },
          },
        ],
        commands: [
          {
            socket: "host", id: 3, name: "host.lock-ack",
            payload: { lock_id: 7, ui_session_generation: 1 }, atMs: 45,
          },
          {
            socket: "host", id: 4, name: "host.lock-authenticate",
            payload: { username: "hewel", password: "wrong", lock_id: 7, ui_session_generation: 1 },
            atMs: 60,
          },
          {
            socket: "host", id: 5, name: "host.lock-authenticate",
            payload: { username: "hewel", password: "correct", lock_id: 7, ui_session_generation: 1 },
            atMs: 70,
            result: {
              data: {
                token: "unlock-7", daemon_instance_id: "preview-daemon",
                ui_session_generation: 1, lock_id: 7, auth_attempt_id: 2,
              },
            },
          },
          {
            socket: "host", id: 6, name: "host.lock-consume-unlock",
            payload: { token: "unlock-7", lock_id: 7, ui_session_generation: 1 }, atMs: 80,
          },
        ],
      });
      const hostSocket = fixtureValue.services.sockets[1]!;
      const failedAuthentication = hostSocket.events.find(event =>
        event.kind === "message" && JSON.parse(event.text).id === 4);
      expect(failedAuthentication).toBeDefined();
      failedAuthentication!.text = JSON.stringify({
        jsonrpc: "2.0", id: 4,
        error: { code: "permission_denied", message: "Authentication failed" },
      });
      writeFileSync(lockedFixture, JSON.stringify(fixtureValue, null, 2));
      writeFileSync(lockedScenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-phase-4-session-lock",
        requiredCapabilities: ["session-lock", "pixels", "surface.multiple", "virtual-time"],
        steps: [
          { id: "outputs", op: "monitors.set", monitors },
          { id: "daemon-events", op: "clock.advance", byMs: 30 },
          { id: "ready", op: "settle" },
          { id: "engage-lock", op: "clock.advance", byMs: 10 },
          { id: "lock-ack-reply", op: "clock.advance", byMs: 10 },
          { id: "capture-lock-dp", op: "capture", surface: "lock-dp-1", captureId: "lock-dp-1" },
          { id: "capture-lock-hdmi", op: "capture", surface: "lock-hdmi-1", captureId: "lock-hdmi-1" },
          {
            id: "focus-wrong-password", op: "pointer.click",
            target: { surface: "lock-dp-1", testId: "lock-password" }, button: "primary",
          },
          { id: "enter-wrong-password", op: "text.commit", surface: "lock-dp-1", text: "wrong" },
          { id: "wrong-password-committed", op: "clock.advance", byMs: 1 },
          {
            id: "submit-wrong-password", op: "pointer.click",
            target: { surface: "lock-dp-1", testId: "lock-submit" }, button: "primary",
          },
          { id: "wrong-auth-reply", op: "clock.advance", byMs: 10 },
          { id: "wrong-auth-settled", op: "settle" },
          {
            id: "pam-error-visible", op: "assert",
            target: { surface: "lock-dp-1", testId: "lock-error" },
            check: { property: "text", equals: "permission_denied: Authentication failed" },
          },
          { id: "locked-after-wrong-auth", op: "monitors.set", monitors },
          {
            id: "focus-correct-password", op: "pointer.click",
            target: { surface: "lock-dp-1", testId: "lock-password" }, button: "primary",
          },
          { id: "enter-correct-password", op: "text.commit", surface: "lock-dp-1", text: "correct" },
          { id: "correct-password-committed", op: "clock.advance", byMs: 1 },
          {
            id: "submit-correct-password", op: "pointer.click",
            target: { surface: "lock-dp-1", testId: "lock-submit" }, button: "primary",
          },
          { id: "correct-auth-reply", op: "clock.advance", byMs: 10 },
          { id: "daemon-unlocked", op: "clock.advance", byMs: 5 },
          { id: "consume-unlock-reply", op: "clock.advance", byMs: 5 },
          { id: "unlock-settled", op: "settle" },
          { id: "after-unlock", op: "monitors.set", monitors },
        ],
      }, null, 2));

      const lockedResult = runPreview(lockedFixture, lockedScenario, lockedOut);
      expectCleanPreview(lockedResult, 2, 1);
      expect(previewSessionLock(lockedOut, "locked-after-wrong-auth").state).toBe("locked");
      expect(previewSessionLock(lockedOut, "after-unlock").state).toBe("unlocked");
      expect(sessionLockTrace(lockedOut)).toMatchObject({ state: "unlocked", unlockCount: 1 });
      expect(previewSurfaces(lockedOut, "after-unlock")).not.toContain("lock-dp-1");
      expect(previewSurfaces(lockedOut, "after-unlock")).not.toContain("lock-hdmi-1");
      for (const [surface, width, height] of [["lock-dp-1", 1440, 900], ["lock-hdmi-1", 1280, 720]] as const) {
        const capture = readCapture(lockedOut, surface, surface);
        expect([capture.image.width, capture.image.height]).toEqual([width, height]);
        expect(pixel(capture.image, 4, 4)[3]).toBe(255);
        expect(pixel(capture.image, Math.floor(width / 2), Math.floor(height / 2))[3]).toBe(255);
      }

      const refusedFixture = join(workspace, "refused-fixture.json");
      const refusedScenario = join(workspace, "refused-scenario.json");
      writeFileSync(refusedFixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-phase-4-lock-refusal",
        sessionLock: { outcome: "finished" },
        topicUpdates: [{
          topic: "session.lock",
          atMs: 40,
          revision: 2,
          data: {
            phase: "engaging", lock_id: 9, sleep_hold: false, host_connected: true,
            ui_session_generation: 1, last_error: null,
          },
        }],
        commands: [{
          socket: "host", id: 3, name: "host.lock-failed",
          payload: { lock_id: 9, reason: "compositor lock refused" }, atMs: 50,
        }],
      }), null, 2));
      writeFileSync(refusedScenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-phase-4-lock-refusal",
        requiredCapabilities: ["session-lock", "surface.multiple", "virtual-time"],
        steps: [
          { id: "outputs", op: "monitors.set", monitors: [monitors[0]] },
          { id: "daemon-events", op: "clock.advance", byMs: 30 },
          { id: "ready", op: "settle" },
          { id: "engage-refused-lock", op: "clock.advance", byMs: 10 },
          { id: "lock-failed-reply", op: "clock.advance", byMs: 10 },
          { id: "refused", op: "monitors.set", monitors: [monitors[0]] },
        ],
      }, null, 2));

      const refusedResult = runPreview(refusedFixture, refusedScenario, refusedOut);
      expectCleanPreview(refusedResult, 0, 0);
      expect(sessionLockTrace(refusedOut).unlockCount).toBe(0);
      expect(previewSurfaces(refusedOut, "refused")).not.toContain("lock-dp-1");
    } finally {
      cleanup();
    }
  });

  previewTest("Polkit authorization dialog (identity select, respond, cancel, lock suppression) and Power confirmation dialog", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-polkit-power-");
    const monitor = {
      id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
      scale: 1, refreshRateMilliHz: 60000,
    };
    const polkitPrompt = {
      request_id: 41,
      action_id: "org.zshell.preview.authorize",
      message: "Authentication is required to change system settings.",
      icon_name: "system-lock-screen",
      details: { Vendor: "Shoji" },
      identities: [{ uid: 1000, username: "hewel" }, { uid: 0, username: "root" }],
      selected_uid: 1000,
      prompt: "Password:",
      echo_on: false,
      info_message: null,
      error_message: null,
      authenticating: false,
    };
    const polkitSnapshot = {
      enabled: true,
      registered: true,
      locked_suppressed: false,
      last_error: null,
      active: null,
    };
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-phase-4-polkit-power",
        sessionLock: { outcome: "finished" },
        topicUpdates: [
          {
            topic: "session.polkit", atMs: 40, revision: 2,
            data: { ...polkitSnapshot, active: polkitPrompt },
          },
          {
            topic: "session.polkit", atMs: 70, revision: 3,
            data: polkitSnapshot,
          },
          {
            topic: "session.polkit", atMs: 80, revision: 4,
            data: { ...polkitSnapshot, active: { ...polkitPrompt, request_id: 42 } },
          },
          {
            topic: "session.polkit", atMs: 100, revision: 5,
            data: polkitSnapshot,
          },
          {
            topic: "session.polkit", atMs: 110, revision: 6,
            data: { ...polkitSnapshot, active: { ...polkitPrompt, request_id: 43 } },
          },
          {
            topic: "session.lock", atMs: 120, revision: 2,
            data: {
              phase: "engaging", lock_id: 11, sleep_hold: false, host_connected: true,
              ui_session_generation: 1, last_error: null,
            },
          },
          {
            topic: "session.polkit", atMs: 140, revision: 7,
            data: polkitSnapshot,
          },
          {
            topic: "session.lock", atMs: 140, revision: 3,
            data: {
              phase: "unlocked", lock_id: null, sleep_hold: false, host_connected: true,
              ui_session_generation: 1, last_error: null,
            },
          },
        ],
        commands: [
          {
            socket: "host", id: 3, name: "host.polkit-select-identity",
            payload: { request_id: 41, uid: 0 }, atMs: 50,
          },
          {
            socket: "host", id: 4, name: "host.polkit-respond",
            payload: { request_id: 41, response: "shoji-secret" }, atMs: 60,
          },
          {
            socket: "host", id: 5, name: "host.polkit-cancel",
            payload: { request_id: 42 }, atMs: 90,
          },
          {
            socket: "host", id: 6, name: "host.lock-failed",
            payload: { lock_id: 11, reason: "compositor lock refused" }, atMs: 130,
          },
          { socket: "host", id: 7, name: "power.poweroff", atMs: 160 },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-phase-4-polkit-power",
        requiredCapabilities: ["session-lock", "pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: [
          { id: "outputs", op: "monitors.set", monitors: [monitor] },
          { id: "daemon-events", op: "clock.advance", byMs: 30 },
          { id: "ready", op: "settle" },
          { id: "polkit-prompt", op: "clock.advance", byMs: 10 },
          { id: "capture-polkit", op: "capture", surface: "polkit-dialog", captureId: "polkit-dialog" },
          {
            id: "select-root", op: "pointer.click",
            target: { surface: "polkit-dialog", testId: "polkit-identity-0" }, button: "primary",
          },
          { id: "identity-reply", op: "clock.advance", byMs: 10 },
          {
            id: "focus-polkit-input", op: "pointer.click",
            target: { surface: "polkit-dialog", testId: "polkit-input" }, button: "primary",
          },
          { id: "enter-polkit-secret", op: "text.commit", surface: "polkit-dialog", text: "shoji-secret" },
          {
            id: "submit-polkit-response", op: "pointer.click",
            target: { surface: "polkit-dialog", testId: "polkit-submit" }, button: "primary",
          },
          { id: "polkit-response-reply", op: "clock.advance", byMs: 10 },
          { id: "polkit-response-cleared", op: "clock.advance", byMs: 10 },
          { id: "second-polkit-prompt", op: "clock.advance", byMs: 10 },
          {
            id: "cancel-polkit", op: "pointer.click",
            target: { surface: "polkit-dialog", testId: "polkit-cancel" }, button: "primary",
          },
          { id: "polkit-cancel-reply", op: "clock.advance", byMs: 10 },
          { id: "polkit-cancel-cleared", op: "clock.advance", byMs: 10 },
          { id: "third-polkit-prompt", op: "clock.advance", byMs: 10 },
          { id: "lock-suppresses-polkit", op: "clock.advance", byMs: 10 },
          { id: "polkit-hidden-while-locked", op: "monitors.set", monitors: [monitor] },
          { id: "lock-failed-reply", op: "clock.advance", byMs: 10 },
          { id: "unlock-and-clear-polkit", op: "clock.advance", byMs: 10 },
          {
            id: "open-power-dialog", op: "service.emit", channel: "control.message",
            value: { args: ["power", "poweroff"], reply: { text: "{\"pendingPowerAction\":\"poweroff\"}" } },
          },
          { id: "capture-power", op: "capture", surface: "power-dialog", captureId: "power-dialog" },
          {
            id: "power-title", op: "assert",
            target: { surface: "power-dialog", testId: "power-dialog-title" },
            check: { property: "text", equals: "Shut down?" },
          },
          {
            id: "confirm-poweroff", op: "pointer.click",
            target: { surface: "power-dialog", testId: "power-dialog-confirm" }, button: "primary",
          },
          { id: "poweroff-reply", op: "clock.advance", byMs: 20 },
          { id: "power-dialog-exit-settle", op: "clock.advance", byMs: 240 },
          { id: "power-dialog-closed", op: "monitors.set", monitors: [monitor] },
        ],
      }, null, 2));

      const result = runPreview(fixture, scenario, out);
      expectCleanPreview(result, 2, 1);
      const polkit = readCapture(out, "polkit-dialog", "polkit-dialog");
      const power = readCapture(out, "power-dialog", "power-dialog");
      expect(treeNode(polkit.tree, "polkit-identity-1000").text).toBe("hewel");
      expect(treeNode(polkit.tree, "polkit-identity-0").text).toBe("root");
      expect(treeNode(polkit.tree, "polkit-action-id").text).toBe("org.zshell.preview.authorize");
      expect(treeNode(power.tree, "power-dialog-title").text).toBe("Shut down?");
      expect(previewSurfaces(out, "polkit-hidden-while-locked")).not.toContain("polkit-dialog");
      expect(previewSurfaces(out, "polkit-hidden-while-locked")).not.toContain("lock-dp-1");
      expect(previewSurfaces(out, "power-dialog-closed")).not.toContain("power-dialog");
      expect(sessionLockTrace(out).unlockCount).toBe(0);
    } finally {
      cleanup();
    }
  });

  previewTest("multi-output hotplug: removing first output retargets live overlay LayerSurfaces cleanly (zgui-js#37)", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-hotplug-");
    const dp1 = {
      id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
      scale: 1, refreshRateMilliHz: 60000,
    };
    const hdmi1 = {
      id: "hdmi-1", name: "HDMI-A-1", x: 1440, y: 0, width: 1280, height: 720,
      scale: 1, refreshRateMilliHz: 60000,
    };
    const audio = (volume: number) => ({
      availability: "available",
      default_sink: "sink-1",
      default_source: "source-1",
      sinks: [{ index: 7, name: "sink-1", description: "Speakers", channels: 2, volume, muted: false }],
      sources: [{ index: 8, name: "source-1", description: "Microphone", channels: 1, volume: 0.5, muted: false }],
      sink_inputs: [],
      source_outputs: [],
    });
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-hotplug-retarget",
        initialTopics: {
          "desktop.notifications": {
            available: true,
            dnd: false,
            popups: [{
              id: 1,
              revision: 1,
              app_name: "Shoji",
              summary: "Hotplug toast",
              body: "Retargets when primary output disconnects",
              icon: null,
              attachment: null,
              actions: [],
              urgency: 1,
            }],
            history: [],
          },
          "system.audio": audio(0.65),
        },
        topicUpdates: [
          { topic: "system.audio", atMs: 40, revision: 2, sourceBaseline: false, data: audio(0.80) },
        ],
        commands: [
          {
            id: 26,
            name: "launcher.query",
            payload: { query: "", query_id: 1, limit: 18 },
            atMs: 50,
            result: {
              data: {
                query_id: 1,
                items: [{
                  provider_id: "desktop",
                  item_id: "alacritty.desktop",
                  title: "Alacritty",
                  actions: [],
                  score: 100,
                }],
              },
            },
          },
          {
            id: 27,
            name: "launcher.query",
            payload: { query: "", query_id: 2, limit: 18 },
            atMs: 600,
            result: {
              data: {
                query_id: 2,
                items: [{
                  provider_id: "desktop",
                  item_id: "alacritty.desktop",
                  title: "Alacritty",
                  actions: [],
                  score: 100,
                }],
              },
            },
          },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-hotplug-retarget",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: [
          { id: "two-outputs", op: "monitors.set", monitors: [dp1, hdmi1] },
          { id: "daemon-events", op: "clock.advance", byMs: 30 },
          { id: "ready", op: "settle" },
          { id: "live-volume-osd", op: "clock.advance", byMs: 10 },
          {
            id: "open-launcher",
            op: "pointer.click",
            target: { surface: "bar-dp-1", testId: "bar-launcher" },
            button: "primary",
          },
          { id: "launcher-ready", op: "clock.advance", byMs: 550 },
          {
            id: "toast-before-hotplug",
            op: "assert",
            target: { surface: "notification-toasts", testId: "toast-card-1" },
            check: { property: "exists", equals: true },
          },
          {
            id: "osd-before-hotplug",
            op: "assert",
            target: { surface: "osd-overlay", testId: "osd-value" },
            check: { property: "text", equals: "80%" },
          },
          { id: "remove-primary-output", op: "monitors.set", monitors: [hdmi1] },
          { id: "retargeted-launcher-reply", op: "clock.advance", byMs: 550 },
          { id: "hotplug-settled", op: "settle" },
          {
            id: "toast-after-hotplug",
            op: "assert",
            target: { surface: "notification-toasts", testId: "toast-card-1" },
            check: { property: "exists", equals: true },
          },
          {
            id: "osd-after-hotplug",
            op: "assert",
            target: { surface: "osd-overlay", testId: "osd-value" },
            check: { property: "text", equals: "80%" },
          },
          {
            id: "hdmi-bar-healthy",
            op: "assert",
            target: { surface: "bar-hdmi-1", testId: "bar-launcher" },
            check: { property: "exists", equals: true },
          },
          { id: "capture-retargeted-launcher", op: "capture", surface: "launcher-overlay", captureId: "launcher-overlay" },
          { id: "capture-retargeted-osd", op: "capture", surface: "osd-overlay", captureId: "osd-overlay" },
          { id: "capture-retargeted-toasts", op: "capture", surface: "notification-toasts", captureId: "notification-toasts" },
        ],
      }, null, 2));

      const result = runPreview(fixture, scenario, out);
      expectCleanPreview(result, 3, 5);
      const surfacesAfterHotplug = previewSurfaces(out, "remove-primary-output");
      expect(surfacesAfterHotplug).not.toContain("bar-dp-1");
      expect(surfacesAfterHotplug).not.toContain("wallpaper-dp-1");
      expect(surfacesAfterHotplug).not.toContain("dock-dp-1");
      expect(surfacesAfterHotplug).toContain("bar-hdmi-1");
      expect(surfacesAfterHotplug).toContain("notification-toasts");
      expect(surfacesAfterHotplug).toContain("osd-overlay");
      expect(surfacesAfterHotplug).toContain("launcher-overlay");

      const launcher = readCapture(out, "launcher-overlay", "launcher-overlay");
      const osd = readCapture(out, "osd-overlay", "osd-overlay");
      const toasts = readCapture(out, "notification-toasts", "notification-toasts");
      expect([launcher.image.width, launcher.image.height]).toEqual([1280, 720]);
      expect(treeNode(osd.tree, "osd-value").text).toBe("80%");
      expect(treeNode(toasts.tree, "toast-card-1").boundsDevice).toBeDefined();
    } finally {
      cleanup();
    }
  });
});
