import { beforeAll, describe, expect } from "bun:test";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildShellApplication } from "@z-shell/composer";
import type { PublishedApplication } from "@hewel/zgui-build";
import { buildShellPreviewFixture, makeSamplePluginsTopicSnapshot, makeTinyPngBytes } from "./fixture-builder.ts";
import {
  buildPublishedShell,
  createPreviewWorkspace,
  createVirtualTimeline,
  expectCleanPreview,
  zguiHost,
  pixel,
  previewAvailable,
  previewSessionLock,
  previewSurfaces,
  previewTest,
  readCapture,
  repoRoot,
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
            target: { surface: "bar-dp-1", testId: "bar-quick-settings" },
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
              actions: id === 1 ? [{ key: "default", label: "" }, { key: "open", label: "Open" }] : [],
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
      expect(treeNode(calendar.tree, "cal-notif-default-1").boundsDevice).toBeDefined();
      expect(treeNode(calendar.tree, "cal-notif-action-1-open").boundsDevice).toBeDefined();
      expect(calendar.tree.nodes.some(node => node.testId === "cal-notif-default-2")).toBe(false);
      expect(calendar.tree.nodes.some(node => node.testId?.startsWith("cal-notif-action-2-"))).toBe(false);
      expect(treeNode(calendar.tree, "cal-notif-dismiss-2").boundsDevice).toBeDefined();
      expect(treeNode(calendar.tree, "cal-clear-all").boundsDevice).toBeDefined();
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
          {
            id: 27,
            name: "notifications.dismiss-popups",
            payload: { items: [{ id: 1, revision: 1 }, { id: 2, revision: 1 }] },
            atMs: 40,
          },
          { id: 28, name: "notifications.set-paused", payload: { paused: true }, atMs: 50 },
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
      expect(treeNode(toasts.tree, "toast-group-toggle-1").boundsDevice).toBeDefined();
      expect(treeNode(toasts.tree, "toast-deck-peek-1").boundsDevice).toBeDefined();
      expect(toasts.tree.nodes.some(node => node.text === "+1")).toBe(true);
      expect(toasts.tree.nodes.some(node => node.testId === "toast-more-footer")).toBe(false);
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
          { id: 26, name: "apps.launch", payload: { id: "zen.desktop" }, atMs: 35 },
          { id: 27, name: "wayland.window.activate", payload: { window_id: 41 }, atMs: 40 },
          {
            id: 28,
            name: "launcher.query",
            payload: { query: "", query_id: 1, limit: 18 },
            atMs: 40,
            result: { data: { query_id: 1, items: [zen, alacritty] } },
          },
          {
            id: 29,
            name: "launcher.query",
            payload: { query: "ala", query_id: 2, limit: 18 },
            atMs: 50,
            result: { data: { query_id: 2, items: [alacritty] } },
          },
          {
            id: 30,
            name: "launcher.activate",
            payload: { query_id: 2, provider_id: "desktop", item_id: "alacritty.desktop" },
            atMs: 60,
          },
          { id: 31, name: "apps.launch", payload: { id: "zen.desktop" }, atMs: 300 },
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
            id: "launch-cold-boot-pinned-app",
            op: "pointer.click",
            target: { surface: "dock-dp-1", testId: "dock-app-zen.desktop" },
            button: "primary",
          },
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
            id: "launch-pinned-app-after-filtered-query",
            op: "pointer.click",
            target: { surface: "dock-dp-1", testId: "dock-app-zen.desktop" },
            button: "primary",
          },
          { id: "post-filter-launch-reply", op: "clock.advance", byMs: 15 },
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

      // Unsettled username with display_name containing spaces must omit `username` on the wire
      // (never sending `display_name` or `"user"` fallback) while still displaying `display_name`.
      const unsettledOut = join(workspace, "unsettled-out");
      const unsettledFixture = join(workspace, "unsettled-fixture.json");
      const unsettledScenario = join(workspace, "unsettled-scenario.json");
      const unsettledTimeline = createVirtualTimeline();
      unsettledTimeline.step({ id: "outputs", op: "monitors.set", monitors: [monitors[0]] });
      unsettledTimeline.advance("daemon-events", 30);
      unsettledTimeline.step({ id: "ready", op: "settle" });
      const unsettledEngageAtMs = unsettledTimeline.after(10);
      const unsettledLockedAtMs = unsettledTimeline.after(15);
      unsettledTimeline.advance("engage-lock", 10);
      unsettledTimeline.advance("lock-ack-reply", 10);
      unsettledTimeline.step({
        id: "display-name-shown", op: "assert",
        target: { surface: "lock-dp-1", testId: "lock-user-dp-1" },
        check: { property: "text", equals: "Ada Lovelace" },
      });
      unsettledTimeline.step({
        id: "focus-password", op: "pointer.click",
        target: { surface: "lock-dp-1", testId: "lock-password" }, button: "primary",
      });
      unsettledTimeline.step({ id: "enter-password", op: "text.commit", surface: "lock-dp-1", text: "correct" });
      unsettledTimeline.advance("password-committed", 1);
      unsettledTimeline.step({
        id: "submit-password", op: "pointer.click",
        target: { surface: "lock-dp-1", testId: "lock-submit" }, button: "primary",
      });
      const unsettledAuthAtMs = unsettledTimeline.after(9);
      const unsettledUnlockedAtMs = unsettledTimeline.after(14);
      const unsettledConsumeAtMs = unsettledTimeline.after(19);
      unsettledTimeline.advance("auth-reply", 10);
      unsettledTimeline.advance("daemon-unlocked", 5);
      unsettledTimeline.advance("consume-unlock-reply", 5);
      unsettledTimeline.step({ id: "unlock-settled", op: "settle" });
      unsettledTimeline.step({ id: "after-unlock", op: "monitors.set", monitors: [monitors[0]] });

      writeFileSync(unsettledFixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-phase-4-lock-unsettled-user",
        sessionLock: { outcome: "locked" },
        initialTopics: {
          "system.user": {
            uid: 1000,
            username: null,
            display_name: "Ada Lovelace",
            avatar: null,
          },
        },
        topicUpdates: [
          {
            topic: "session.lock",
            atMs: unsettledEngageAtMs,
            revision: 2,
            data: {
              phase: "engaging", lock_id: 8, sleep_hold: false, host_connected: true,
              ui_session_generation: 1, last_error: null,
            },
          },
          {
            topic: "session.lock",
            atMs: unsettledLockedAtMs,
            revision: 3,
            data: {
              phase: "locked", lock_id: 8, sleep_hold: false, host_connected: true,
              ui_session_generation: 1, last_error: null,
            },
          },
          {
            topic: "session.lock",
            atMs: unsettledUnlockedAtMs,
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
            payload: { lock_id: 8, ui_session_generation: 1 }, atMs: unsettledLockedAtMs,
          },
          {
            socket: "host", id: 4, name: "host.lock-authenticate",
            payload: { password: "correct", lock_id: 8, ui_session_generation: 1 },
            atMs: unsettledAuthAtMs,
            result: {
              data: {
                token: "unlock-8", daemon_instance_id: "preview-daemon",
                ui_session_generation: 1, lock_id: 8, auth_attempt_id: 1,
              },
            },
          },
          {
            socket: "host", id: 5, name: "host.lock-consume-unlock",
            payload: { token: "unlock-8", lock_id: 8, ui_session_generation: 1 }, atMs: unsettledConsumeAtMs,
          },
        ],
      }), null, 2));
      writeFileSync(unsettledScenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-phase-4-lock-unsettled-user",
        requiredCapabilities: ["session-lock", "surface.multiple", "virtual-time"],
        steps: unsettledTimeline.steps,
      }, null, 2));

      const unsettledResult = runPreview(unsettledFixture, unsettledScenario, unsettledOut);
      expectCleanPreview(unsettledResult, 0, 1);
      expect(previewSessionLock(unsettledOut, "after-unlock").state).toBe("unlocked");
      expect(sessionLockTrace(unsettledOut)).toMatchObject({ state: "unlocked", unlockCount: 1 });
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

  previewTest("toasts, OSD and Polkit stay on their initial output until the next session", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-pinned-overlays-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const monitors = [
        { id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900, scale: 1, refreshRateMilliHz: 60000 },
        { id: "hdmi-1", name: "HDMI-A-1", x: 1440, y: 0, width: 2560, height: 1440, scale: 2, refreshRateMilliHz: 60000 },
      ];
      const outputs = monitors.map((monitor, index) => ({
        output_instance_id: index + 1, name: monitor.name, x: monitor.x, y: monitor.y,
        width: monitor.width / monitor.scale, height: monitor.height / monitor.scale,
        mode_width: monitor.width, mode_height: monitor.height, scale: monitor.scale,
      }));
      const windows = (activeId: number) => ({
        capability: "controllable",
        windows: [1, 2].map(id => ({
          window_id: id, title: `Window ${id}`, app_id: "terminal", output_instance_ids: [id],
          activated: id === activeId, minimized: false, maximized: false, fullscreen: false,
        })),
      });
      const notifications = (...ids: number[]) => ({
        available: true, dnd: false, history: [],
        popups: ids.map(id => ({
          id, revision: 1, app_name: "Preview", summary: `Notification ${id}`, body: "Output pinning",
          icon: null, attachment: null, actions: [], urgency: 1,
        })),
      });
      const audio = (volume: number) => ({
        availability: "available", default_sink: "sink", default_source: null,
        sinks: [{ index: 7, name: "sink", description: "Speakers", channels: 2, volume, muted: false }],
        sources: [], sink_inputs: [], source_outputs: [],
      });
      const polkit = (requestId: number | null) => ({
        enabled: true, registered: true, locked_suppressed: false, last_error: null,
        active: requestId === null ? null : {
          request_id: requestId, action_id: "org.zshell.preview.authorize",
          message: "Authentication is required to change system settings.", icon_name: "system-lock-screen",
          details: {}, identities: [{ uid: 1000, username: "preview" }], selected_uid: 1000,
          prompt: "Password:", echo_on: false, info_message: null, error_message: null, authenticating: false,
        },
      });
      const response = "preview-secret";
      const toast = "notification-toasts";
      const osd = "osd-overlay";
      const dialog = "polkit-dialog";
      const timeline = createVirtualTimeline();
      const capture = (surface: string, stage: string) => {
        const id = `${surface}-${stage}`;
        timeline.step({ id, op: "capture", surface, captureId: id });
      };
      const click = (id: string, surface: string, testId: string) => {
        timeline.step({ id, op: "pointer.click", target: { surface, testId }, button: "primary" });
      };

      timeline.step({ id: "outputs", op: "monitors.set", monitors });
      timeline.advance("daemon-ready", 30);
      const firstSessionAtMs = timeline.after(10);
      timeline.advance("open-overlays", 450);
      const pauseAtMs = timeline.after(20);
      click("expand-toasts", toast, "toast-group-toggle-2");
      timeline.advance("expanded", 250);
      capture(toast, "initial");
      capture(osd, "initial");
      capture(dialog, "initial");
      click("focus-auth-input", dialog, "polkit-input");
      timeline.step({ id: "type-response", op: "text.commit", surface: dialog, text: response });

      const focusAtMs = timeline.after(10);
      timeline.advance("focus-hdmi", 30);
      const mergeAtMs = timeline.after(10);
      timeline.advance("merge-toast-and-volume-update", 450);
      capture(toast, "pinned");
      capture(osd, "pinned");
      capture(dialog, "pinned");
      const respondAtMs = timeline.after(10);
      click("submit-response", dialog, "polkit-submit");
      timeline.advance("response-reply", 20);

      const clearAtMs = timeline.after(10);
      const resumeAtMs = timeline.after(20);
      timeline.advance("clear-toasts-and-polkit-and-let-osd-expire", 1800);
      timeline.step({ id: "between-sessions", op: "monitors.set", monitors });
      const nextSessionAtMs = timeline.after(10);
      timeline.advance("open-new-overlays", 450);
      capture(toast, "next");
      capture(osd, "next");
      capture(dialog, "next");

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-pinned-overlays",
        initialTopics: {
          "wayland.outputs": { capability: "controllable", outputs },
          "wayland.windows": windows(1),
          "system.audio": audio(0.5),
        },
        topicUpdates: [
          { topic: "desktop.notifications", atMs: firstSessionAtMs, revision: 2, data: notifications(2, 1) },
          { topic: "system.audio", atMs: firstSessionAtMs, revision: 2, data: audio(0.6) },
          { topic: "session.polkit", atMs: firstSessionAtMs, revision: 2, data: polkit(41) },
          { topic: "wayland.windows", atMs: focusAtMs, revision: 2, data: windows(2) },
          { topic: "desktop.notifications", atMs: mergeAtMs, revision: 3, data: notifications(3, 2, 1) },
          { topic: "system.audio", atMs: mergeAtMs, revision: 3, data: audio(0.7) },
          { topic: "desktop.notifications", atMs: clearAtMs, revision: 4, data: notifications() },
          { topic: "session.polkit", atMs: clearAtMs, revision: 3, data: polkit(null) },
          { topic: "desktop.notifications", atMs: nextSessionAtMs, revision: 5, data: notifications(4) },
          { topic: "system.audio", atMs: nextSessionAtMs, revision: 4, data: audio(0.8) },
          { topic: "session.polkit", atMs: nextSessionAtMs, revision: 4, data: polkit(42) },
        ],
        commands: [
          { id: 26, name: "notifications.set-paused", payload: { paused: true }, atMs: pauseAtMs },
          { id: 27, name: "notifications.set-paused", payload: { paused: false }, atMs: resumeAtMs },
          {
            socket: "host", name: "host.polkit-respond", payload: { request_id: 41, response },
            atMs: respondAtMs,
          },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-pinned-overlays",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      expectCleanPreview(runPreview(fixture, scenario, out), 9, 0);
      const between = previewSurfaces(out, "between-sessions");
      for (const surface of [toast, osd, dialog]) expect(between).not.toContain(surface);

      const checkCapture = (surface: string, stage: string, width: number, height: number) => {
        const frame = readCapture(out, surface, `${surface}-${stage}`);
        expect([frame.image.width, frame.image.height], `${surface} ${stage}`).toEqual([width, height]);
        return frame.tree;
      };
      const initialToasts = checkCapture(toast, "initial", 396, 760);
      expect(treeNode(initialToasts, "toast-expanded-scroll").boundsDevice).toBeDefined();
      const pinnedToasts = checkCapture(toast, "pinned", 396, 760);
      for (const id of ["toast-expanded-scroll", "toast-card-1", "toast-card-3"]) {
        expect(treeNode(pinnedToasts, id).boundsDevice).toBeDefined();
      }
      const nextToasts = checkCapture(toast, "next", 792, 912);
      expect(treeNode(nextToasts, "toast-card-4").boundsDevice).toBeDefined();

      expect(treeNode(checkCapture(osd, "initial", 344, 108), "osd-value").text).toBe("60%");
      expect(treeNode(checkCapture(osd, "pinned", 344, 108), "osd-value").text).toBe("70%");
      expect(treeNode(checkCapture(osd, "next", 688, 216), "osd-value").text).toBe("80%");
      checkCapture(dialog, "initial", 1440, 900);
      checkCapture(dialog, "pinned", 1440, 900);
      checkCapture(dialog, "next", 2560, 1440);
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

  previewTest("Bar popup trigger handoffs retire previous popups cleanly and suppress compositor same-trigger reopen", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-popup-handoff-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const monitor = {
        id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
        scale: 1, refreshRateMilliHz: 60000,
      };
      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });

      // 1. Open panel-calendar, then immediately switch across popup hosts to ime-menu.
      timeline.step({ id: "open-calendar", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("calendar-open-settle", 250);
      timeline.step({ id: "after-open-cal", op: "monitors.set", monitors: [monitor] });

      timeline.step({ id: "switch-to-ime", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-ime" }, button: "secondary" });
      timeline.advance("ime-switch-15ms", 15);
      timeline.step({ id: "after-switch-to-ime-15ms", op: "monitors.set", monitors: [monitor] });
      timeline.advance("ime-switch-250ms", 250);
      timeline.step({ id: "after-switch-to-ime-250ms", op: "monitors.set", monitors: [monitor] });

      // Ungrabbed handoff activates the transparent top-layer backdrop so outside clicks dismiss.
      timeline.step({ id: "click-backdrop-dismiss-ime", op: "pointer.click", target: { surface: "bar-backdrop-dp-1", testId: "bar-popover-backdrop-dp-1" }, button: "primary" });
      timeline.advance("backdrop-dismiss-settle", 250);
      timeline.step({ id: "after-backdrop-dismiss-ime", op: "monitors.set", monitors: [monitor] });

      // 2. Simulate compositor PopupDone arriving on pointer press when switching to another panel,
      // then switch a second time and verify native grab is restored on the 3rd trigger.
      timeline.step({ id: "reopen-calendar", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("reopen-cal-settle", 250);
      timeline.step({ id: "after-reopen-cal", op: "monitors.set", monitors: [monitor] });
      timeline.step({ id: "compositor-dismiss-cal", op: "popupDone", surface: "panel-calendar" });
      timeline.advance("compositor-dismiss-cal-gap", 10);
      timeline.step({ id: "switch-to-qs", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-quick-settings" }, button: "primary" });
      timeline.advance("qs-switch-250ms", 250);
      timeline.step({ id: "after-compositor-switch-qs", op: "monitors.set", monitors: [monitor] });

      timeline.step({ id: "switch-qs-to-sysmon", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-sysmon" }, button: "primary" });
      timeline.advance("sysmon-switch-15ms", 15);
      timeline.step({ id: "after-switch-qs-to-sysmon-15ms", op: "monitors.set", monitors: [monitor] });
      timeline.advance("sysmon-switch-250ms", 250);
      timeline.step({ id: "after-switch-qs-to-sysmon-250ms", op: "monitors.set", monitors: [monitor] });

      // 3. Compositor PopupDone followed immediately by the same trigger must close rather than reopen.
      timeline.step({ id: "compositor-dismiss-sysmon", op: "popupDone", surface: "panel-system-monitor" });
      timeline.advance("compositor-dismiss-sysmon-gap", 10);
      timeline.step({ id: "click-same-sysmon", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-sysmon" }, button: "primary" });
      timeline.advance("same-trigger-close-settle", 250);
      timeline.step({ id: "after-same-trigger-close", op: "monitors.set", monitors: [monitor] });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-popup-handoff",
        initialTopics: {
          "desktop.ime": {
            mode: "indicator_only",
            candidate_layout: "auto",
            switch_osd: false,
            available: true,
            enabled: true,
            active_im: { unique_name: "keyboard-us", label: "English", short_label: "EN" },
            properties: [],
            group_ims: [
              { unique_name: "keyboard-us", label: "English", short_label: "EN" },
              { unique_name: "rime", label: "Rime", short_label: "中" },
            ],
            exec_menu: null,
          },
        },
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-popup-handoff",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(fixture, scenario, out);
      expectCleanPreview(result, 0, 0);

      expect(previewSurfaces(out, "after-open-cal")).toContain("panel-calendar");
      expect(previewSurfaces(out, "after-switch-to-ime-15ms")).not.toContain("panel-calendar");
      expect(previewSurfaces(out, "after-switch-to-ime-15ms")).toContain("ime-menu");
      expect(previewSurfaces(out, "after-switch-to-ime-250ms")).toContain("ime-menu");
      expect(previewSurfaces(out, "after-backdrop-dismiss-ime")).not.toContain("ime-menu");

      expect(previewSurfaces(out, "after-reopen-cal")).toContain("panel-calendar");
      expect(previewSurfaces(out, "after-compositor-switch-qs")).toContain("panel-quick-settings");
      expect(previewSurfaces(out, "after-compositor-switch-qs")).not.toContain("panel-calendar");

      expect(previewSurfaces(out, "after-switch-qs-to-sysmon-15ms")).not.toContain("panel-quick-settings");
      expect(previewSurfaces(out, "after-switch-qs-to-sysmon-15ms")).toContain("panel-system-monitor");
      expect(previewSurfaces(out, "after-switch-qs-to-sysmon-250ms")).toContain("panel-system-monitor");

      expect(previewSurfaces(out, "after-same-trigger-close")).not.toContain("panel-system-monitor");
    } finally {
      cleanup();
    }
  });

  previewTest("Notification toasts and Calendar popover dismiss immediately (instantExit) and stay suppressed across sleep_hold, engaging, and locked", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-lock-notif-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const monitor = {
        id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
        scale: 1, refreshRateMilliHz: 60000,
      };
      const makeToast = (id: number) => ({
        id,
        revision: 1,
        app_name: "Chat",
        summary: `Message ${id}`,
        body: "Sensitive preview",
        icon: null,
        attachment: null,
        actions: [{ key: "open", label: "Open" }],
        urgency: 1,
      });

      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });

      timeline.step({ id: "open-calendar", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("calendar-present", 60);
      timeline.step({ id: "before-lock", op: "monitors.set", monitors: [monitor] });

      const sleepHoldAtMs = timeline.after(2);
      timeline.advance("sleep-hold-instant-exit", 5);
      timeline.step({ id: "during-sleep-hold", op: "monitors.set", monitors: [monitor] });

      timeline.step({ id: "try-open-calendar-during-hold", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("suppressed-hold-check", 20);
      timeline.step({ id: "suppressed-while-held", op: "monitors.set", monitors: [monitor] });

      const wakeUnlockedAtMs = timeline.after(2);
      timeline.advance("wake-unlocked", 10);
      timeline.step({ id: "reopen-calendar", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("reopen-present", 60);
      timeline.step({ id: "reopened-unlocked", op: "monitors.set", monitors: [monitor] });

      const engagingAtMs = timeline.after(2);
      const lockFailedReplyAtMs = timeline.after(15);
      timeline.advance("engaging-instant-exit", 5);
      timeline.step({ id: "during-engaging", op: "monitors.set", monitors: [monitor] });
      timeline.advance("lock-failed-drain", 20);

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-lock-notif-suppression",
        sessionLock: { outcome: "finished" },
        initialTopics: {
          "desktop.notifications": {
            available: true,
            dnd: false,
            popups: [makeToast(1)],
            history: [makeToast(1)],
          },
        },
        topicUpdates: [
          {
            topic: "session.lock",
            atMs: sleepHoldAtMs,
            revision: 2,
            data: {
              phase: "unlocked", lock_id: null, sleep_hold: true, host_connected: true,
              ui_session_generation: 1, last_error: null,
            },
          },
          {
            topic: "session.lock",
            atMs: wakeUnlockedAtMs,
            revision: 3,
            data: {
              phase: "unlocked", lock_id: null, sleep_hold: false, host_connected: true,
              ui_session_generation: 1, last_error: null,
            },
          },
          {
            topic: "desktop.notifications",
            atMs: wakeUnlockedAtMs,
            revision: 2,
            data: {
              available: true,
              dnd: false,
              popups: [makeToast(2)],
              history: [makeToast(2), makeToast(1)],
            },
          },
          {
            topic: "session.lock",
            atMs: engagingAtMs,
            revision: 4,
            data: {
              phase: "engaging", lock_id: 15, sleep_hold: false, host_connected: true,
              ui_session_generation: 1, last_error: null,
            },
          },
        ],
        commands: [
          {
            socket: "host", id: 3, name: "host.lock-failed",
            payload: { lock_id: 15, reason: "compositor lock refused" }, atMs: lockFailedReplyAtMs,
          },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-lock-notif-suppression",
        requiredCapabilities: ["session-lock", "pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(fixture, scenario, out);
      expectCleanPreview(result, 0, 0);

      expect(previewSurfaces(out, "before-lock")).toContain("notification-toasts");
      expect(previewSurfaces(out, "before-lock")).toContain("panel-calendar");

      expect(previewSurfaces(out, "during-sleep-hold")).not.toContain("notification-toasts");
      expect(previewSurfaces(out, "during-sleep-hold")).not.toContain("panel-calendar");

      expect(previewSurfaces(out, "suppressed-while-held")).not.toContain("notification-toasts");
      expect(previewSurfaces(out, "suppressed-while-held")).not.toContain("panel-calendar");

      expect(previewSurfaces(out, "reopened-unlocked")).toContain("notification-toasts");
      expect(previewSurfaces(out, "reopened-unlocked")).toContain("panel-calendar");

      expect(previewSurfaces(out, "during-engaging")).not.toContain("notification-toasts");
      expect(previewSurfaces(out, "during-engaging")).not.toContain("panel-calendar");
    } finally {
      cleanup();
    }
  });

  previewTest("multi-output ungrabbed bar popover dismisses on secondary monitor click without stealing keyboard focus or swallowing subsequent clicks", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-multi-backdrop-");
    const dp1 = {
      id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
      scale: 1, refreshRateMilliHz: 60000,
    };
    const hdmi1 = {
      id: "hdmi-1", name: "HDMI-A-1", x: 1440, y: 0, width: 1280, height: 720,
      scale: 1, refreshRateMilliHz: 60000,
    };
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [dp1, hdmi1] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });

      // Open Calendar on Monitor A (dp-1), then switch directly to Quick Settings on Monitor A so
      // Quick Settings enters ungrabbed bar-popup mode (`ungrabbedBarPopupMonitorId() === "dp-1"`).
      timeline.step({ id: "open-cal-dp1", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("cal-open-settle", 250);
      timeline.step({ id: "switch-qs-dp1", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-quick-settings" }, button: "primary" });
      timeline.advance("qs-switch-settle", 250);
      timeline.step({ id: "while-ungrabbed", op: "monitors.set", monitors: [dp1, hdmi1] });
      timeline.step({ id: "capture-backdrop-dp1", op: "capture", surface: "bar-backdrop-dp-1", captureId: "dp1-ungrabbed" });
      timeline.step({ id: "capture-backdrop-hdmi1", op: "capture", surface: "bar-backdrop-hdmi-1", captureId: "hdmi1-ungrabbed" });

      // Clicking Monitor B (hdmi-1)'s desktop backdrop must immediately dismiss Monitor A's ungrabbed popup.
      timeline.step({
        id: "click-secondary-backdrop",
        op: "pointer.click",
        target: { surface: "bar-backdrop-hdmi-1", testId: "bar-popover-backdrop-hdmi-1" },
        button: "primary",
      });
      timeline.advance("secondary-dismiss-settle", 250);
      timeline.step({ id: "after-secondary-dismiss", op: "monitors.set", monitors: [dp1, hdmi1] });

      // Subsequent clicks on Monitor B must never be swallowed by a lingering backdrop.
      timeline.step({ id: "open-cal-hdmi1", op: "pointer.click", target: { surface: "bar-hdmi-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("cal-hdmi1-settle", 250);
      timeline.step({ id: "after-hdmi1-open", op: "monitors.set", monitors: [dp1, hdmi1] });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-multi-output-backdrop",
        outputs: [
          { name: "DP-1", x: 0, y: 0, width: 1440, height: 900, scale: 1, enabled: true },
          { name: "HDMI-A-1", x: 1440, y: 0, width: 1280, height: 720, scale: 1, enabled: true },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-multi-output-backdrop",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(fixture, scenario, out);
      expectCleanPreview(result, 2, 0);

      expect(previewSurfaces(out, "while-ungrabbed")).toContain("panel-quick-settings");
      const dp1Backdrop = readCapture(out, "bar-backdrop-dp-1", "dp1-ungrabbed");
      const hdmi1Backdrop = readCapture(out, "bar-backdrop-hdmi-1", "hdmi1-ungrabbed");
      const dp1Node = treeNode(dp1Backdrop.tree, "bar-popover-backdrop-dp-1") as { readonly state?: { readonly focused?: boolean } };
      const hdmi1Node = treeNode(hdmi1Backdrop.tree, "bar-popover-backdrop-hdmi-1") as { readonly state?: { readonly focused?: boolean } };
      expect(dp1Node.state?.focused).toBe(true);
      expect(hdmi1Node.state?.focused ?? false).toBe(false);

      expect(previewSurfaces(out, "after-secondary-dismiss")).not.toContain("panel-quick-settings");
      expect(previewSurfaces(out, "after-hdmi1-open")).toContain("panel-calendar");
    } finally {
      cleanup();
    }
  });

  previewTest("PluginHost isolates throwing widget, panel, settings_page, layer, and service entries via Errored and surfaces runtime errors in PluginsPane", async () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-plugin-errored-");
    const monitor = {
      id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
      scale: 1, refreshRateMilliHz: 60000,
    };
    try {
      const stagedShellDir = join(workspace, "shell");
      mkdirSync(stagedShellDir, { recursive: true });
      for (const entry of ["package.json", "tsconfig.json", "assets", "src", "preview"]) {
        cpSync(join(shellDir, entry), join(stagedShellDir, entry), { recursive: true });
      }
      symlinkSync(join(repoRoot, "node_modules"), join(stagedShellDir, "node_modules"), "dir");

      writeFileSync(
        join(stagedShellDir, "src", "plugins", "synthetic-plugins.tsx"),
        `import { Button, type NativeChild } from "@hewel/zgui";
import { definePlugin, PLUGIN_API_LEVEL } from "@z-shell/plugin-api";

export const brokenService = definePlugin({
  manifest: {
    id: "acme/broken",
    version: "0.1.0",
    pluginApi: PLUGIN_API_LEVEL,
    title: "Broken Plugin",
    entries: [{ name: "service", kind: "service", title: "Broken Service" }],
    defaults: {},
  },
  setup() {
    throw new Error("broken service boom");
  },
});

export function BrokenLayer(): NativeChild {
  throw new Error("broken layer boom");
}

export function BrokenWidget(): NativeChild {
  throw new Error("broken widget boom");
}

export function HealthyWidget(props: { readonly onOpenPanel: (entryId?: string) => void }): NativeChild {
  return (
    <Button testId="healthy-plugin-btn" onClick={() => props.onOpenPanel("bad-panel")}>
      <text>Healthy 99%</text>
    </Button>
  );
}

export function BrokenPanel(): NativeChild {
  throw new Error("broken panel boom");
}

export function HealthySettings(): NativeChild {
  return (
    <box testId="healthy-settings-card">
      <text>Healthy Settings Ready</text>
    </box>
  );
}
`,
      );
      writeFileSync(
        join(stagedShellDir, "src", "plugins", "composed.ts"),
        `import type { PluginEntryKind } from "@z-shell/plugin-api";
import {
  BrokenLayer,
  BrokenPanel,
  BrokenWidget,
  HealthySettings,
  HealthyWidget,
  brokenService,
} from "./synthetic-plugins.tsx";
export type { ComposedPluginBundle } from "./PluginHost.tsx";

export interface ComposedServiceDescriptor {
  readonly pluginId: string;
  readonly id: string;
  readonly entryId: string;
  readonly kind: Extract<PluginEntryKind, "service">;
  readonly entry: string;
  readonly title?: string;
  readonly description?: string;
  readonly widthTier?: "compact" | "standard";
  readonly settings: Readonly<Record<string, unknown>>;
  readonly pluginSettings: Readonly<Record<string, unknown>>;
  readonly importKey: string;
}

export interface ComposedEntryInstanceDescriptor {
  readonly pluginId: string;
  readonly id: string;
  readonly entryId: string;
  readonly kind: Exclude<PluginEntryKind, "service">;
  readonly entry: string;
  readonly title?: string;
  readonly description?: string;
  readonly widthTier?: "compact" | "standard";
  readonly settings: Readonly<Record<string, unknown>>;
  readonly pluginSettings: Readonly<Record<string, unknown>>;
  readonly instanceId: string;
  readonly instanceSlug?: string;
  readonly outputId?: string;
  readonly importKey: string;
}

export const entryImports: Readonly<Record<string, Record<string, unknown>>> = {
  "acme/broken:service": { default: brokenService },
  "acme/broken:layer": { default: BrokenLayer },
  "acme/broken:widget": { default: BrokenWidget },
  "acme/broken:settings": { default: null },
  "acme/healthy:widget": { default: HealthyWidget },
  "acme/healthy:bad-panel": { default: BrokenPanel },
  "acme/healthy:settings": { default: HealthySettings },
};

export const services: readonly ComposedServiceDescriptor[] = [
  {
    pluginId: "acme/broken",
    id: "service",
    entryId: "acme/broken:service",
    kind: "service",
    entry: "src/service.ts",
    settings: {},
    pluginSettings: {},
    importKey: "acme/broken:service",
  },
];

export const entryInstances: readonly ComposedEntryInstanceDescriptor[] = [
  {
    pluginId: "acme/broken",
    id: "layer",
    entryId: "acme/broken:layer",
    kind: "layer",
    entry: "src/layer.tsx",
    settings: {},
    pluginSettings: {},
    instanceId: "broken-layer",
    importKey: "acme/broken:layer",
  },
  {
    pluginId: "acme/broken",
    id: "widget",
    entryId: "acme/broken:widget",
    kind: "widget",
    entry: "src/widget.tsx",
    settings: {},
    pluginSettings: {},
    instanceId: "broken-widget",
    importKey: "acme/broken:widget",
  },
  {
    pluginId: "acme/broken",
    id: "settings",
    entryId: "acme/broken:settings",
    kind: "settings_page",
    entry: "src/settings.tsx",
    settings: {},
    pluginSettings: {},
    instanceId: "broken-settings",
    importKey: "acme/broken:settings",
  },
  {
    pluginId: "acme/healthy",
    id: "widget",
    entryId: "acme/healthy:widget",
    kind: "widget",
    entry: "src/widget.tsx",
    settings: {},
    pluginSettings: {},
    instanceId: "healthy-widget",
    importKey: "acme/healthy:widget",
  },
  {
    pluginId: "acme/healthy",
    id: "bad-panel",
    entryId: "acme/healthy:bad-panel",
    kind: "panel",
    entry: "src/panel.tsx",
    settings: {},
    pluginSettings: {},
    instanceId: "healthy-bad-panel",
    importKey: "acme/healthy:bad-panel",
  },
  {
    pluginId: "acme/healthy",
    id: "settings",
    entryId: "acme/healthy:settings",
    kind: "settings_page",
    entry: "src/settings.tsx",
    settings: {},
    pluginSettings: {},
    instanceId: "healthy-settings",
    importKey: "acme/healthy:settings",
  },
];

export const composedPlugins = { entryImports, services, entryInstances } as const;
export default composedPlugins;
`,
      );

      const stagedPublished = await buildShellApplication({
        app: "shell",
        appDirectory: stagedShellDir,
      });

      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });
      timeline.step({ id: "capture-bar", op: "capture", surface: "bar-dp-1", captureId: "bar-isolated" });

      // Clicking the healthy bar widget opens its throwing panel inside a popup fallback card.
      timeline.step({
        id: "open-broken-panel",
        op: "pointer.click",
        target: { surface: "bar-dp-1", testId: "healthy-plugin-btn" },
        button: "primary",
      });
      timeline.advance("panel-open-settle", 250);
      timeline.step({
        id: "capture-broken-panel",
        op: "capture",
        surface: "plugin-panel-healthy-bad-panel",
        captureId: "panel-isolated",
      });

      // Open Settings > Plugins to verify runtime errors are surfaced visibly.
      const subscribePluginsAtMs = timeline.after(5);
      const catalogList1AtMs = timeline.after(5);
      const catalogList2AtMs = timeline.after(15);
      timeline.step({
        id: "open-settings-plugins",
        op: "service.emit",
        channel: "control.message",
        value: {
          args: ["settings", "plugins"],
          reply: { text: "{\"settingsWindowOpen\":true,\"settingsWindowTab\":\"plugins\"}" },
        },
      });
      timeline.advance("settings-plugins-settle", 250);
      timeline.step({ id: "capture-settings-plugins", op: "capture", surface: "settings-window", captureId: "settings-plugins" });

      // Switch to broken settings page (missing default export) and then healthy settings page.
      const unsubPluginsAtMs = timeline.after(5);
      timeline.step({
        id: "nav-broken-settings",
        op: "pointer.click",
        target: { surface: "settings-window", testId: "settings-nav-plugin-broken-settings" },
        button: "primary",
      });
      timeline.advance("broken-settings-settle", 200);
      timeline.step({ id: "capture-broken-settings", op: "capture", surface: "settings-window", captureId: "broken-settings" });

      timeline.step({
        id: "nav-healthy-settings",
        op: "pointer.click",
        target: { surface: "settings-window", testId: "settings-nav-plugin-healthy-settings" },
        button: "primary",
      });
      timeline.advance("healthy-settings-settle", 200);
      timeline.step({ id: "capture-healthy-settings", op: "capture", surface: "settings-window", captureId: "healthy-settings" });

      const basePlugins = makeSamplePluginsTopicSnapshot();
      const brokenInstalled = {
        ...(basePlugins.plugins[0] as Record<string, unknown>),
        id: "acme/broken",
        name: "Broken Plugin",
        version: "0.1.0",
        enabled: true,
        approved: true,
        revoked: false,
        migration_reapproval_required: false,
      };
      const pluginsSnapshot = makeSamplePluginsTopicSnapshot({
        plugins: [brokenInstalled],
      });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-plugin-errored-isolation",
        publicTopicSubscriptions: [
          {
            topic: "plugins",
            id: 26,
            atMs: subscribePluginsAtMs,
            data: pluginsSnapshot,
          },
        ],
        extraPublicSends: [
          JSON.stringify({ jsonrpc: "2.0", id: 29, method: "topic.unsubscribe", params: { topic: "plugins" } }),
        ],
        extraPublicEvents: [
          {
            kind: "message",
            atMs: unsubPluginsAtMs,
            text: JSON.stringify({ jsonrpc: "2.0", id: 29, result: {} }),
          },
        ],
        commands: [
          {
            id: 27,
            name: "plugins.catalog.list",
            payload: { query: "", offset: 0, limit: 30 },
            atMs: catalogList1AtMs,
            result: { data: { total: 0, offset: 0, limit: 30, items: [] } },
          },
          {
            id: 28,
            name: "plugins.catalog.list",
            payload: { query: "", offset: 0, limit: 30 },
            atMs: catalogList2AtMs,
            result: { data: { total: 0, offset: 0, limit: 30, items: [] } },
          },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-plugin-errored-isolation",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreviewBundle(stagedPublished.dist, fixture, scenario, out);
      expectCleanPreview(result, 5, 0);

      const bar = readCapture(out, "bar-dp-1", "bar-isolated");
      expect(treeNode(bar.tree, "plugin-error-broken-widget").boundsDevice).toBeDefined();
      expect(treeNode(bar.tree, "healthy-plugin-btn").text).toContain("Healthy 99%");
      expect(treeNode(bar.tree, "bar-clock").boundsDevice).toBeDefined();

      const badPanel = readCapture(out, "plugin-panel-healthy-bad-panel", "panel-isolated");
      expect(treeNode(badPanel.tree, "plugin-error-healthy-bad-panel").boundsDevice).toBeDefined();
      expect(badPanel.tree.nodes.some(node => node.text?.includes("broken panel boom"))).toBe(true);

      const settingsPlugins = readCapture(out, "settings-window", "settings-plugins");
      expect(treeNode(settingsPlugins.tree, "plugins-runtime-errors").boundsDevice).toBeDefined();
      expect(settingsPlugins.tree.nodes.some(node => node.text?.includes("acme/broken:service"))).toBe(true);
      expect(settingsPlugins.tree.nodes.some(node => node.text?.includes("acme/broken:layer"))).toBe(true);
      expect(settingsPlugins.tree.nodes.some(node => node.text?.includes("acme/broken:widget"))).toBe(true);
      expect(settingsPlugins.tree.nodes.some(node => node.text?.includes("acme/healthy:bad-panel"))).toBe(true);
      expect(settingsPlugins.tree.nodes.some(node => node.text === "Runtime error")).toBe(true);

      const brokenSettings = readCapture(out, "settings-window", "broken-settings");
      expect(treeNode(brokenSettings.tree, "plugin-error-broken-settings").boundsDevice).toBeDefined();

      const healthySettings = readCapture(out, "settings-window", "healthy-settings");
      expect(treeNode(healthySettings.tree, "healthy-settings-card").text).toContain("Healthy Settings Ready");
    } finally {
      cleanup();
    }
  });

  previewTest("SNI lazy tray menus (has_menu with null initial menu), lazy submenu expansion, close-menu, and Activate fallback_menu in bar and overflow", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-sni-lazy-");
    const monitor = {
      id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
      scale: 1, refreshRateMilliHz: 60000,
    };
    const makeMenuNode = (
      id: number,
      label: string,
      opts: { is_submenu?: boolean; children_display?: "submenu"; children?: unknown[] } = {},
    ) => ({
      id,
      label,
      enabled: true,
      visible: true,
      separator: false,
      toggle_type: null,
      toggle_state: null,
      is_submenu: opts.is_submenu ?? false,
      ...(opts.children_display ? { children_display: opts.children_display } : {}),
      children: opts.children ?? [],
    });
    const baseItems = (overrides: {
      telegramMenu?: unknown;
      wineMenu?: unknown;
      overflowMenu?: unknown;
    } = {}) => [
      {
        id: "telegram",
        app_id: "org.telegram.desktop",
        title: "Telegram",
        category: "Communications",
        status: "Active",
        icon_name: "telegram",
        item_is_menu: true,
        has_menu: true,
        tooltip: null,
        icon: null,
        menu: overrides.telegramMenu ?? null,
      },
      {
        id: "wine-app",
        app_id: "wine-tray",
        title: "Wine App",
        category: "ApplicationStatus",
        status: "Active",
        icon_name: "wine",
        item_is_menu: false,
        has_menu: true,
        tooltip: null,
        icon: null,
        menu: overrides.wineMenu ?? null,
      },
      {
        id: "legacy-overflow",
        app_id: "legacy-indicator",
        title: "Legacy Indicator",
        category: "ApplicationStatus",
        status: "Active",
        icon_name: "legacy-indicator",
        item_is_menu: false,
        has_menu: true,
        tooltip: null,
        icon: null,
        menu: overrides.overflowMenu ?? null,
      },
      {
        id: "empty-lazy",
        app_id: "empty-lazy-app",
        title: "Empty Lazy",
        category: "ApplicationStatus",
        status: "Active",
        icon_name: "empty-lazy",
        item_is_menu: true,
        has_menu: true,
        tooltip: null,
        icon: null,
        menu: null,
      },
    ];

    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });

      // 1. Click `telegram` (item_is_menu: true, has_menu: true, menu: null) -> prepares root menu asynchronously.
      //    `z-shelld` publishes `desktop.tray` before returning the `tray.prepare-menu` RPC response.
      const telegramRootTopicAtMs = timeline.after(6);
      const prepareTelegramRootAtMs = timeline.after(8);
      timeline.step({
        id: "open-telegram",
        op: "pointer.click",
        target: { surface: "bar-dp-1", testId: "tray-item-telegram" },
        button: "primary",
      });
      timeline.advance("telegram-root-settle", 250);
      timeline.step({ id: "capture-telegram-root", op: "capture", surface: "tray-menu", captureId: "telegram-root" });

      // 2. Click lazy submenu `Accounts` (id 20, is_submenu: true, children: []) -> prepares submenu without closing.
      const telegramSubmenuTopicAtMs = timeline.after(6);
      const prepareTelegramSubmenuAtMs = timeline.after(8);
      timeline.step({
        id: "expand-telegram-submenu",
        op: "pointer.click",
        target: { surface: "tray-menu", testId: "tray-menu-item-20" },
        button: "primary",
      });
      timeline.advance("telegram-submenu-settle", 120);
      timeline.step({ id: "capture-telegram-submenu", op: "capture", surface: "tray-menu", captureId: "telegram-submenu" });

      // 3. Click leaf item `Personal (@ada)` (id 21) -> invokes tray.menu-item + tray.close-menu and closes popup.
      const clickTelegramLeafAtMs = timeline.after(5);
      const closeTelegramAtMs = timeline.after(8);
      timeline.step({
        id: "click-telegram-leaf",
        op: "pointer.click",
        target: { surface: "tray-menu", testId: "tray-menu-item-21" },
        button: "primary",
      });
      timeline.advance("telegram-close-settle", 250);

      // 4. Primary-click `wine-app` (item_is_menu: false) -> tray.activate returns { fallback_menu: true } -> prepares & opens menu!
      const activateWineAtMs = timeline.after(5);
      const wineMenuTopicAtMs = timeline.after(8);
      const prepareWineAtMs = timeline.after(10);
      timeline.step({
        id: "activate-wine-fallback",
        op: "pointer.click",
        target: { surface: "bar-dp-1", testId: "tray-item-wine-app" },
        button: "primary",
      });
      timeline.advance("wine-fallback-settle", 250);
      timeline.step({ id: "capture-wine-fallback", op: "capture", surface: "tray-menu", captureId: "wine-fallback" });

      const closeWineAtMs = timeline.after(5);
      timeline.step({ id: "escape-wine-menu", op: "key.press", surface: "tray-menu", key: "Escape" });
      timeline.advance("wine-close-settle", 250);

      // 5. Open tray-overflow and primary-click `legacy-overflow` -> tray.activate returns { fallback_menu: true } -> prepares & opens bar-anchored tray-menu!
      timeline.step({
        id: "open-overflow",
        op: "pointer.click",
        target: { surface: "bar-dp-1", testId: "bar-tray-overflow-toggle" },
        button: "primary",
      });
      timeline.advance("overflow-open-settle", 250);

      const activateOverflowAtMs = timeline.after(5);
      const overflowMenuTopicAtMs = timeline.after(8);
      const prepareOverflowAtMs = timeline.after(10);
      timeline.step({
        id: "activate-overflow-fallback",
        op: "pointer.click",
        target: { surface: "tray-overflow", testId: "tray-overflow-item-legacy-overflow" },
        button: "primary",
      });
      timeline.advance("overflow-fallback-settle", 250);
      timeline.step({ id: "capture-overflow-fallback", op: "capture", surface: "tray-menu", captureId: "overflow-fallback" });
      timeline.step({ id: "after-overflow-handoff", op: "monitors.set", monitors: [monitor] });

      const closeOverflowMenuAtMs = timeline.after(5);
      timeline.step({ id: "escape-overflow-menu", op: "key.press", surface: "tray-menu", key: "Escape" });
      timeline.advance("overflow-menu-close-settle", 250);

      // 6. Clicking an item whose `tray.prepare-menu` settles with 0 visible rows must close `activeTrayMenu`
      //    cleanly (never stranding `overlay()` in `"tray"` or locking `BarPopoverBackdrop`).
      const prepareEmptyLazyAtMs = timeline.after(5);
      const closeEmptyLazyAtMs = timeline.after(10);
      timeline.step({
        id: "open-empty-lazy",
        op: "pointer.click",
        target: { surface: "bar-dp-1", testId: "tray-item-empty-lazy" },
        button: "primary",
      });
      timeline.advance("empty-lazy-settle", 120);
      timeline.step({ id: "after-empty-lazy", op: "monitors.set", monitors: [monitor] });
      timeline.step({ id: "open-cal-after-empty-lazy", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("cal-after-empty-settle", 250);
      timeline.step({ id: "after-cal-open", op: "monitors.set", monitors: [monitor] });

      const telegramRootMenu = {
        revision: 1,
        root: makeMenuNode(0, "", {
          children: [
            makeMenuNode(10, "Open Telegram"),
            makeMenuNode(20, "Accounts", { is_submenu: true, children_display: "submenu", children: [] }),
          ],
        }),
      };
      const telegramExpandedMenu = {
        revision: 2,
        root: makeMenuNode(0, "", {
          children: [
            makeMenuNode(10, "Open Telegram"),
            makeMenuNode(20, "Accounts", {
              is_submenu: true,
              children_display: "submenu",
              children: [makeMenuNode(21, "Personal (@ada)")],
            }),
          ],
        }),
      };
      const wineMenu = {
        revision: 1,
        root: makeMenuNode(0, "", {
          children: [makeMenuNode(30, "Restore Wine Window")],
        }),
      };
      const overflowMenu = {
        revision: 1,
        root: makeMenuNode(0, "", {
          children: [makeMenuNode(40, "Overflow Settings")],
        }),
      };

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-sni-lazy-menus",
        initialTopics: {
          settings: {
            general: { offline_mode: false, log_level: "info" },
            bar: {
              position: "top",
              style: "floating",
              gaps: 14,
              edge_overrides: { top: null, right: null, bottom: null, left: null },
              launcher_enabled: true,
              dock_enabled: true,
              clock_24h: true,
              clock_seconds: false,
              tray: {
                default_action: "show",
                rules: { "legacy-indicator": "collapse" },
              },
            },
            theme: { mode: "dark", variant: "tonal", seed_color: null, backend: "builtin", gtk_linking: false },
            ime: { mode: "indicator_only", candidate_layout: "auto", switch_osd: true },
            polkit: { enabled: true },
            wallpaper: { directories: [], fit: "cover", sync_theme: true, slideshow_seconds: 300 },
            pre_action_fade_seconds: 0,
            configured_plugins: [],
          },
          "desktop.tray": {
            available: true,
            items: baseItems(),
          },
        },
        topicUpdates: [
          {
            topic: "desktop.tray",
            atMs: telegramRootTopicAtMs,
            revision: 2,
            data: { available: true, items: baseItems({ telegramMenu: telegramRootMenu }) },
          },
          {
            topic: "desktop.tray",
            atMs: telegramSubmenuTopicAtMs,
            revision: 3,
            data: { available: true, items: baseItems({ telegramMenu: telegramExpandedMenu }) },
          },
          {
            topic: "desktop.tray",
            atMs: wineMenuTopicAtMs,
            revision: 4,
            data: { available: true, items: baseItems({ telegramMenu: telegramExpandedMenu, wineMenu }) },
          },
          {
            topic: "desktop.tray",
            atMs: overflowMenuTopicAtMs,
            revision: 5,
            data: { available: true, items: baseItems({ telegramMenu: telegramExpandedMenu, wineMenu, overflowMenu }) },
          },
        ],
        commands: [
          { id: 26, name: "tray.prepare-menu", payload: { id: "telegram" }, atMs: prepareTelegramRootAtMs },
          { id: 27, name: "tray.prepare-menu", payload: { id: "telegram", menu_id: 20 }, atMs: prepareTelegramSubmenuAtMs },
          { id: 28, name: "tray.menu-item", payload: { id: "telegram", menu_id: 21 }, atMs: clickTelegramLeafAtMs },
          { id: 29, name: "tray.close-menu", payload: { id: "telegram" }, atMs: closeTelegramAtMs },
          {
            id: 30,
            name: "tray.activate",
            payload: { id: "wine-app" },
            atMs: activateWineAtMs,
            result: { data: { fallback_menu: true } },
          },
          { id: 31, name: "tray.prepare-menu", payload: { id: "wine-app" }, atMs: prepareWineAtMs },
          { id: 32, name: "tray.close-menu", payload: { id: "wine-app" }, atMs: closeWineAtMs },
          {
            id: 33,
            name: "tray.activate",
            payload: { id: "legacy-overflow" },
            atMs: activateOverflowAtMs,
            result: { data: { fallback_menu: true } },
          },
          { id: 34, name: "tray.prepare-menu", payload: { id: "legacy-overflow" }, atMs: prepareOverflowAtMs },
          { id: 35, name: "tray.close-menu", payload: { id: "legacy-overflow" }, atMs: closeOverflowMenuAtMs },
          { id: 36, name: "tray.prepare-menu", payload: { id: "empty-lazy" }, atMs: prepareEmptyLazyAtMs },
          { id: 37, name: "tray.close-menu", payload: { id: "empty-lazy" }, atMs: closeEmptyLazyAtMs },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-sni-lazy-menus",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(fixture, scenario, out);
      expectCleanPreview(result, 4, 0);

      const telegramRoot = readCapture(out, "tray-menu", "telegram-root");
      expect(treeNode(telegramRoot.tree, "tray-menu-item-10").text).toContain("Open Telegram");
      expect(treeNode(telegramRoot.tree, "tray-menu-item-20").text).toContain("Accounts");
      expect(telegramRoot.tree.nodes.some(node => node.testId === "tray-menu-item-21")).toBe(false);

      const telegramSubmenu = readCapture(out, "tray-menu", "telegram-submenu");
      expect(treeNode(telegramSubmenu.tree, "tray-menu-item-21").text).toContain("Personal (@ada)");

      const wineFallback = readCapture(out, "tray-menu", "wine-fallback");
      expect(treeNode(wineFallback.tree, "tray-menu-item-30").text).toContain("Restore Wine Window");

      const overflowFallback = readCapture(out, "tray-menu", "overflow-fallback");
      expect(treeNode(overflowFallback.tree, "tray-menu-item-40").text).toContain("Overflow Settings");
      expect(previewSurfaces(out, "after-overflow-handoff")).toContain("tray-menu");
      expect(previewSurfaces(out, "after-overflow-handoff")).not.toContain("tray-overflow");

      expect(previewSurfaces(out, "after-empty-lazy")).not.toContain("tray-menu");
      expect(previewSurfaces(out, "after-cal-open")).toContain("panel-calendar");
    } finally {
      cleanup();
    }
  });

  previewTest("gesture-bound xdg_activation_v1 tokens forward across Dock, Launcher, Notifications, and Tray, and SessionLockOverlay renders reactive Caps Lock indicator without layout shift", async () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-activation-caps-");
    const monitor = {
      id: "dp-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900,
      scale: 1, refreshRateMilliHz: 60000,
    };
    try {
      const stagedShellDir = join(workspace, "shell");
      mkdirSync(stagedShellDir, { recursive: true });
      for (const entry of ["package.json", "tsconfig.json", "assets", "src", "preview"]) {
        cpSync(join(shellDir, entry), join(stagedShellDir, entry), { recursive: true });
      }
      symlinkSync(join(repoRoot, "node_modules"), join(stagedShellDir, "node_modules"), "dir");

      writeFileSync(
        join(stagedShellDir, "src", "test-activation-shim.ts"),
        `const host = globalThis as unknown as {
  __zguiShell?: {
    requestActivationToken: (options?: { readonly appId?: string }) => Promise<string | null>;
    openLock: (
      name: string,
      output: string,
      attach: (root: unknown, bridge: Record<string, unknown>) => () => void,
    ) => number;
  };
};

let installed = false;
let tokenSeq = 0;
let capsLockActive = true;
const capsSubscribers = new Map<number, (next: boolean) => void>();
let nextSubId = 1;

export function installTestActivationShim(): void {
  if (installed) return;
  const shell = host.__zguiShell;
  if (!shell) return;
  installed = true;

  shell.requestActivationToken = (options?: { readonly appId?: string }) => {
    tokenSeq += 1;
    const tag = options?.appId ?? "<none>";
    return Promise.resolve(\`tok-\${tokenSeq}:\${tag}\`);
  };

  const origOpenLock = shell.openLock.bind(shell);
  shell.openLock = (name, output, attach) =>
    origOpenLock(name, output, (root, bridge) => {
      bridge.getCapsLock = () => capsLockActive;
      bridge.subscribeCapsLock = (cb: (next: boolean) => void) => {
        const id = nextSubId++;
        capsSubscribers.set(id, cb);
        return () => {
          capsSubscribers.delete(id);
        };
      };
      const origSetProperty = (
        bridge.setProperty as (node: unknown, prop: string, value: unknown, prev?: unknown) => void
      ).bind(bridge);
      const nodeTestIds = new WeakMap<object, unknown>();
      bridge.setProperty = (node: unknown, prop: string, value: unknown, prev?: unknown) => {
        if (typeof node === "object" && node !== null && prop === "testId") {
          nodeTestIds.set(node, value);
        }
        if (
          typeof node === "object" &&
          node !== null &&
          prop === "onKeyDown" &&
          typeof value === "function" &&
          nodeTestIds.get(node) === "lock-password"
        ) {
          const origHandler = value as (ev: { readonly key?: string }) => void;
          origSetProperty(
            node,
            prop,
            (ev: { readonly key?: string }) => {
              if (ev.key === "PageDown") {
                capsLockActive = !capsLockActive;
                for (const notify of [...capsSubscribers.values()]) notify(capsLockActive);
                return;
              }
              origHandler(ev);
            },
            prev,
          );
          return;
        }
        origSetProperty(node, prop, value, prev);
      };
      return attach(root, bridge);
    });
}
`,
      );

      const baseMainSource = readFileSync(join(shellDir, "src", "main.tsx"), "utf8");
      expect(baseMainSource).toContain("export function mount(): () => void {\n");
      writeFileSync(
        join(stagedShellDir, "src", "main.tsx"),
        `import { installTestActivationShim } from "./test-activation-shim.ts";\n` +
          baseMainSource.replace(
            "export function mount(): () => void {\n",
            "export function mount(): () => void {\n  installTestActivationShim();\n",
          ),
      );

      const stagedPublished = await buildShellApplication({
        app: "shell",
        appDirectory: stagedShellDir,
      });

      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });

      // 1. Dock inactive pinned app click -> apps.launch with tok-1:org.gnome.TextEditor
      const dockLaunchAtMs = timeline.after(5);
      timeline.step({
        id: "click-dock-pinned",
        op: "pointer.click",
        target: { surface: "dock-dp-1", testId: "dock-app-org.gnome.TextEditor.desktop" },
        button: "primary",
      });
      timeline.advance("dock-launch-settle", 20);

      // 2. Launcher open + Enter keydown -> launcher.activate with tok-2:Alacritty and immediate overlay dismiss
      const launcherQueryAtMs = timeline.after(5);
      timeline.step({
        id: "open-launcher",
        op: "pointer.click",
        target: { surface: "bar-dp-1", testId: "bar-launcher" },
        button: "primary",
      });
      timeline.advance("launcher-open-settle", 250);
      const launcherActivateAtMs = timeline.after(5);
      timeline.step({ id: "enter-launcher-item", op: "key.press", surface: "launcher-overlay", key: "Enter" });
      timeline.advance("launcher-dismiss-settle", 250);
      timeline.step({ id: "after-launcher-dismiss", op: "monitors.set", monitors: [monitor] });

      // 3. Notification toast action click -> notifications.invoke-action with tok-3:org.signal.Signal (uses desktop_entry, NOT app_name!)
      const notifActionAtMs = timeline.after(5);
      const notifPausedAtMs = timeline.after(8);
      timeline.step({
        id: "click-toast-reply",
        op: "pointer.click",
        target: { surface: "notification-toasts", testId: "toast-action-1-reply" },
        button: "primary",
      });
      timeline.advance("notif-action-settle", 20);

      // 4. Tray icon click -> tray.activate with tok-4:<none>, and DBusMenu leaf click -> tray.menu-item (tok-5:<none>) strictly before tray.close-menu!
      const trayActivateAtMs = timeline.after(5);
      timeline.step({
        id: "click-tray-discord",
        op: "pointer.click",
        target: { surface: "bar-dp-1", testId: "tray-item-discord" },
        button: "primary",
      });
      timeline.advance("tray-activate-settle", 20);

      const prepareTelegramAtMs = timeline.after(5);
      timeline.step({
        id: "open-telegram-menu",
        op: "pointer.click",
        target: { surface: "bar-dp-1", testId: "tray-item-telegram" },
        button: "primary",
      });
      timeline.advance("telegram-menu-open", 250);

      const trayMenuItemAtMs = timeline.after(5);
      const trayCloseMenuAtMs = timeline.after(8);
      timeline.step({
        id: "click-telegram-menu-item",
        op: "pointer.click",
        target: { surface: "tray-menu", testId: "tray-menu-item-101" },
        button: "primary",
      });
      timeline.advance("telegram-menu-close", 250);

      // 5. Engage SessionLockOverlay with Caps Lock pre-engaged (`true`), toggle off -> 0px shift, toggle on + error -> no overlap, then unlock!
      const engageLockAtMs = timeline.after(5);
      const notifUnpauseOnLockAtMs = timeline.after(8);
      const lockedAckAtMs = timeline.after(10);
      timeline.advance("engage-lock", 30);
      timeline.step({
        id: "assert-caps-initial",
        op: "assert",
        target: { surface: "lock-dp-1", testId: "lock-caps-lock" },
        check: { property: "text", equals: "Caps Lock is on" },
      });
      timeline.step({ id: "capture-lock-caps-on", op: "capture", surface: "lock-dp-1", captureId: "caps-on" });

      timeline.step({ id: "toggle-caps-off", op: "key.press", surface: "lock-dp-1", key: "PageDown" });
      timeline.advance("caps-off-settle", 10);
      timeline.step({ id: "capture-lock-caps-off", op: "capture", surface: "lock-dp-1", captureId: "caps-off" });

      timeline.step({ id: "toggle-caps-back-on", op: "key.press", surface: "lock-dp-1", key: "PageDown" });
      timeline.step({ id: "enter-wrong-pw", op: "text.commit", surface: "lock-dp-1", text: "WRONG" });
      timeline.advance("wrong-pw-committed", 2);
      const wrongAuthAtMs = timeline.after(5);
      timeline.step({
        id: "submit-wrong-pw",
        op: "pointer.click",
        target: { surface: "lock-dp-1", testId: "lock-submit" },
        button: "primary",
      });
      timeline.advance("wrong-auth-settle", 200);
      timeline.step({ id: "capture-lock-caps-and-error", op: "capture", surface: "lock-dp-1", captureId: "caps-and-error" });

      timeline.step({
        id: "focus-pw-again",
        op: "pointer.click",
        target: { surface: "lock-dp-1", testId: "lock-password" },
        button: "primary",
      });
      timeline.step({ id: "enter-right-pw", op: "text.commit", surface: "lock-dp-1", text: "correct" });
      timeline.advance("right-pw-committed", 2);
      const rightAuthAtMs = timeline.after(5);
      const unlockedTopicAtMs = timeline.after(10);
      const consumeUnlockAtMs = timeline.after(15);
      timeline.step({
        id: "submit-right-pw",
        op: "pointer.click",
        target: { surface: "lock-dp-1", testId: "lock-submit" },
        button: "primary",
      });
      timeline.advance("unlock-complete", 30);

      const fixtureValue = buildShellPreviewFixture({
        id: "z-shell-activation-and-capslock",
        sessionLock: { outcome: "locked" },
        initialTopics: {
          "desktop.apps": {
            available: true,
            count: 2,
            pinned_apps: ["org.gnome.TextEditor.desktop"],
            apps: [
              { id: "org.gnome.TextEditor.desktop", title: "Text Editor" },
              { id: "Alacritty.desktop", title: "Alacritty" },
            ],
          },
          "desktop.notifications": {
            available: true,
            dnd: false,
            popups: [{
              id: 1,
              revision: 1,
              app_name: "Signal Messenger",
              desktop_entry: "org.signal.Signal.desktop",
              app_key: "desktop:org.signal.signal",
              summary: "Ada Lovelace",
              body: "Ping from Wayland",
              icon: null,
              attachment: null,
              actions: [{ key: "reply", label: "Reply" }],
              urgency: 1,
            }],
            history: [],
          },
          "desktop.tray": {
            available: true,
            items: [
              {
                id: "discord",
                app_id: "com.discordapp.Discord",
                title: "Discord",
                category: "Communications",
                status: "Active",
                icon_name: "discord",
                item_is_menu: false,
                has_menu: false,
                tooltip: null,
                icon: null,
                menu: null,
              },
              {
                id: "telegram",
                app_id: "org.telegram.desktop",
                title: "Telegram",
                category: "Communications",
                status: "Active",
                icon_name: "telegram",
                item_is_menu: true,
                has_menu: true,
                tooltip: null,
                icon: null,
                menu: {
                  revision: 1,
                  root: {
                    id: 0,
                    label: "",
                    enabled: true,
                    visible: true,
                    separator: false,
                    toggle_type: null,
                    toggle_state: null,
                    children: [{
                      id: 101,
                      label: "Show Telegram",
                      enabled: true,
                      visible: true,
                      separator: false,
                      toggle_type: null,
                      toggle_state: null,
                      children: [],
                    }],
                  },
                },
              },
            ],
          },
        },
        topicUpdates: [
          {
            topic: "session.lock",
            atMs: engageLockAtMs,
            revision: 2,
            data: {
              phase: "engaging", lock_id: 21, sleep_hold: false, host_connected: true,
              ui_session_generation: 1, last_error: null,
            },
          },
          {
            topic: "session.lock",
            atMs: lockedAckAtMs,
            revision: 3,
            data: {
              phase: "locked", lock_id: 21, sleep_hold: false, host_connected: true,
              ui_session_generation: 1, last_error: null,
            },
          },
          {
            topic: "session.lock",
            atMs: unlockedTopicAtMs,
            revision: 4,
            data: {
              phase: "unlocked", lock_id: null, sleep_hold: false, host_connected: true,
              ui_session_generation: 1, last_error: null,
            },
          },
        ],
        commands: [
          {
            id: 26,
            name: "apps.launch",
            payload: { id: "org.gnome.TextEditor.desktop", activation_token: "tok-1:org.gnome.TextEditor" },
            atMs: dockLaunchAtMs,
          },
          {
            id: 27,
            name: "launcher.query",
            payload: { query: "", query_id: 1, limit: 18 },
            atMs: launcherQueryAtMs,
            result: {
              data: {
                query_id: 1,
                items: [{
                  provider_id: "desktop",
                  item_id: "Alacritty.desktop",
                  title: "Alacritty",
                  actions: [],
                  score: 100,
                }],
              },
            },
          },
          {
            id: 28,
            name: "launcher.activate",
            payload: {
              query_id: 1,
              provider_id: "desktop",
              item_id: "Alacritty.desktop",
              activation_token: "tok-2:Alacritty",
            },
            atMs: launcherActivateAtMs,
          },
          {
            id: 29,
            name: "notifications.invoke-action",
            payload: {
              id: 1,
              action_key: "reply",
              activation_token: "tok-3:org.signal.Signal",
            },
            atMs: notifActionAtMs,
          },
          {
            id: 30,
            name: "notifications.set-paused",
            payload: { paused: true },
            atMs: notifPausedAtMs,
          },
          {
            id: 31,
            name: "tray.activate",
            payload: { id: "discord", activation_token: "tok-4:<none>" },
            atMs: trayActivateAtMs,
          },
          {
            id: 32,
            name: "tray.prepare-menu",
            payload: { id: "telegram" },
            atMs: prepareTelegramAtMs,
          },
          {
            id: 33,
            name: "tray.menu-item",
            payload: { id: "telegram", menu_id: 101, activation_token: "tok-5:<none>" },
            atMs: trayMenuItemAtMs,
          },
          {
            id: 34,
            name: "tray.close-menu",
            payload: { id: "telegram" },
            atMs: trayCloseMenuAtMs,
          },
          {
            id: 35,
            name: "notifications.set-paused",
            payload: { paused: false },
            atMs: notifUnpauseOnLockAtMs,
          },
          {
            socket: "host",
            id: 3,
            name: "host.lock-ack",
            payload: { lock_id: 21, ui_session_generation: 1 },
            atMs: lockedAckAtMs,
          },
          {
            socket: "host",
            id: 4,
            name: "host.lock-authenticate",
            payload: { username: "hewel", password: "WRONG", lock_id: 21, ui_session_generation: 1 },
            atMs: wrongAuthAtMs,
          },
          {
            socket: "host",
            id: 5,
            name: "host.lock-authenticate",
            payload: { username: "hewel", password: "correct", lock_id: 21, ui_session_generation: 1 },
            atMs: rightAuthAtMs,
            result: {
              data: {
                token: "unlock-21",
                daemon_instance_id: "preview-daemon",
                ui_session_generation: 1,
                lock_id: 21,
                auth_attempt_id: 2,
              },
            },
          },
          {
            socket: "host",
            id: 6,
            name: "host.lock-consume-unlock",
            payload: { token: "unlock-21", lock_id: 21, ui_session_generation: 1 },
            atMs: consumeUnlockAtMs,
          },
        ],
      });
      const hostSocket = fixtureValue.services.sockets[1]!;
      const failedAuth = hostSocket.events.find(
        event => event.kind === "message" && JSON.parse(event.text).id === 4,
      );
      expect(failedAuth).toBeDefined();
      failedAuth!.text = JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        error: { code: "permission_denied", message: "Authentication failed" },
      });

      writeFileSync(fixture, JSON.stringify(fixtureValue, null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-activation-and-capslock",
        requiredCapabilities: ["session-lock", "pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreviewBundle(stagedPublished.dist, fixture, scenario, out);
      expectCleanPreview(result, 3, 1);

      expect(previewSurfaces(out, "after-launcher-dismiss")).not.toContain("launcher-overlay");

      const capsOn = readCapture(out, "lock-dp-1", "caps-on");
      const capsOff = readCapture(out, "lock-dp-1", "caps-off");
      const capsAndError = readCapture(out, "lock-dp-1", "caps-and-error");

      const capsPillBounds = treeNode(capsOn.tree, "lock-caps-lock").boundsDevice!;
      expect(capsPillBounds.width).toBeGreaterThan(80);
      expect(capsPillBounds.height).toBe(28);
      expect(capsOff.tree.nodes.some(node => node.testId === "lock-caps-lock")).toBe(false);

      // Toggling Caps Lock on/off must cause 0px vertical shift on the password capsule and avatar.
      const capsuleWhenOn = treeNode(capsOn.tree, "lock-password-capsule").boundsDevice!;
      const capsuleWhenOff = treeNode(capsOff.tree, "lock-password-capsule").boundsDevice!;
      expect(capsuleWhenOn).toEqual(capsuleWhenOff);

      // Simultaneous Caps Lock warning and PAM error stack cleanly with zero vertical overlap.
      const capsBothBounds = treeNode(capsAndError.tree, "lock-caps-lock").boundsDevice!;
      const errorBounds = treeNode(capsAndError.tree, "lock-error").boundsDevice!;
      expect(capsBothBounds.y + capsBothBounds.height).toBeLessThanOrEqual(errorBounds.y);
    } finally {
      cleanup();
    }
  });
});
