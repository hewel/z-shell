import { beforeAll, describe, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PublishedApplication } from "@hewel/zgui-build";
import { buildShellPreviewFixture } from "./fixture-builder.ts";
import {
  buildPublishedShell,
  createPreviewWorkspace,
  createVirtualTimeline,
  expectCleanPreview,
  maxRowAlpha,
  pixel,
  previewAvailable,
  previewTest,
  readCapture,
  runPreview,
  treeNode,
  type DeviceBounds,
} from "./preview-harness.ts";

let published: PublishedApplication;

describe("apps/shell design geometry & pixel lint", () => {
  beforeAll(async () => {
    if (!previewAvailable) return;
    published = await buildPublishedShell();
  });

  previewTest("Design geometry & pixel lint: hit targets, shadow bleed, corner transparency, dock alignment, hover stability, and width tiers", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-design-");
    const interactiveRoles = new Set(["button", "switch", "slider", "menuItem", "menuItemCheckBox", "menuItemRadio", "tab"]);
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const compactMonitor = { id: "HDMI-A-1", name: "HDMI-A-1", x: 0, y: 0, width: 1280, height: 720, scale: 1 };

      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [compactMonitor] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });
      timeline.step({ id: "capture-bar", op: "capture", surface: "bar-hdmi-a-1", captureId: "bar" });
      timeline.step({ id: "capture-dock", op: "capture", surface: "dock-hdmi-a-1", captureId: "dock" });
      timeline.step({ id: "hover-dock-app", op: "pointer.move", target: { surface: "dock-hdmi-a-1", testId: "dock-app-org.example.editor" } });
      timeline.advance("dock-hover-settle", 250);
      timeline.step({ id: "capture-dock-hover", op: "capture", surface: "dock-hdmi-a-1", captureId: "dock-hover" });

      timeline.step({ id: "open-qs", op: "pointer.click", target: { surface: "bar-hdmi-a-1", testId: "bar-audio" }, button: "primary" });
      timeline.advance("qs-settle", 600);
      timeline.step({ id: "capture-qs", op: "capture", surface: "panel-quick-settings", captureId: "qs" });

      timeline.step({ id: "open-calendar", op: "pointer.click", target: { surface: "bar-hdmi-a-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("cal-settle", 600);
      timeline.step({ id: "capture-cal", op: "capture", surface: "panel-calendar", captureId: "cal" });

      timeline.step({ id: "open-media", op: "pointer.click", target: { surface: "bar-hdmi-a-1", testId: "bar-media" }, button: "primary" });
      timeline.advance("media-settle", 600);
      timeline.step({ id: "capture-media", op: "capture", surface: "panel-media", captureId: "media" });

      const wallpaperListAtMs = timeline.after(20);
      timeline.step({
        id: "open-settings", op: "service.emit", channel: "control.message",
        value: { args: ["settings", "appearance"], reply: { text: "{\"settingsWindowOpen\":true,\"settingsWindowTab\":\"appearance\"}" } },
      });
      timeline.advance("settings-settle", 300);
      timeline.step({ id: "capture-settings", op: "capture", surface: "settings-window", captureId: "settings" });

      timeline.step({
        id: "open-power-dialog", op: "service.emit", channel: "control.message",
        value: { args: ["power", "poweroff"], reply: { text: "{\"pendingPowerAction\":\"poweroff\"}" } },
      });
      timeline.advance("power-settle", 600);
      timeline.step({ id: "capture-power", op: "capture", surface: "power-dialog", captureId: "power" });

      const launcherQueryAtMs = timeline.after(20);
      timeline.step({
        id: "open-launcher", op: "service.emit", channel: "control.message",
        value: { args: ["panel", "launcher"], reply: { text: "{\"activePanel\":\"launcher\"}" } },
      });
      timeline.advance("launcher-settle", 400);
      timeline.step({ id: "capture-launcher", op: "capture", surface: "launcher-overlay", captureId: "launcher" });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-geometry-lint",
        initialTopics: {
          "wayland.outputs": {
            capability: "connected",
            outputs: [{
              output_instance_id: 1, name: "HDMI-A-1", description: "Compact Laptop", make: "Test", model: "1280x720",
              x: 0, y: 0, width: 1280, height: 720, mode_width: 1280, mode_height: 720, refresh_mhz: 60000, scale: 1,
              physical_width_mm: null, physical_height_mm: null,
            }],
          },
          "wayland.workspaces": {
            capability: "connected",
            groups: [{ group_id: 1, output_instance_ids: [1] }],
            workspaces: [
              { workspace_id: 1, group_id: 1, name: "1", id_str: "1", coordinates: [1], active: false, urgent: false, hidden: false, capabilities: ["activate"] },
              { workspace_id: 2, group_id: 1, name: "2", id_str: "2", coordinates: [2], active: true, urgent: false, hidden: false, capabilities: ["activate"] },
              { workspace_id: 3, group_id: 1, name: "3", id_str: "3", coordinates: [3], active: false, urgent: false, hidden: false, capabilities: ["activate"] },
            ],
          },
          "wayland.windows": {
            capability: "connected",
            windows: [{
              window_id: 10, app_id: "org.example.editor",
              title: "VeryLongProjectName — crates/z-shell-theme/src/palette.rs — Extremely Verbose Editor Window Title That Must Truncate",
              activated: true, minimized: false, maximized: false, fullscreen: false, output_instance_ids: [1],
            }],
          },
          "desktop.apps": {
            available: true,
            count: 2,
            pinned_apps: ["org.example.editor", "org.example.browser"],
            apps: [
              { id: "org.example.editor", title: "Editor", startup_wm_class: "org.example.editor", icon: null },
              { id: "org.example.browser", title: "Browser", startup_wm_class: "org.example.browser", icon: null },
            ],
          },
          "desktop.media": {
            available: true,
            selected_player_id: "spotify",
            any_playing: true,
            cover: null,
            players: [{
              id: "spotify", identity: "Spotify", playback_status: "playing", position_us: 60_000_000,
              capabilities: { can_play: true, can_pause: true, can_go_next: true, can_go_previous: true, can_seek: true },
              metadata: {
                title: "An Exceptionally Long Ambient Track Title Designed To Test Bar Collision Constraints",
                artists: ["Synthetic Orchestra Featuring Extra Guests"],
                album: "Geometry Verification",
                length_us: 240_000_000,
              },
            }],
          },
          "system.audio": {
            availability: "ready",
            default_sink: "alsa_output.0",
            default_source: null,
            sinks: [{ index: 1, name: "alsa_output.0", description: "Speakers", volume: 0.65, muted: false, channels: 2 }],
            sources: [],
            sink_inputs: [],
            source_outputs: [],
          },
        },
        commands: [
          {
            id: 26,
            name: "wallpaper.list",
            payload: { offset: 0, limit: 16 },
            atMs: wallpaperListAtMs,
            result: { total: 0, items: [] },
          },
          {
            id: 27,
            name: "launcher.query",
            payload: { query: "", query_id: 1, limit: 18 },
            atMs: launcherQueryAtMs,
            result: {
              data: {
                query_id: 1,
                items: [
                  { provider_id: "desktop", item_id: "org.example.editor", title: "Editor", icon: null },
                  { provider_id: "desktop", item_id: "org.example.browser", title: "Browser", icon: null },
                ],
              },
            },
          },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-geometry-lint",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(published.dist, fixture, scenario, out);
      expectCleanPreview(result, 9, 0);
      const bar = readCapture(out, "bar-hdmi-a-1", "bar");
      const dock = readCapture(out, "dock-hdmi-a-1", "dock");
      const dockHover = readCapture(out, "dock-hdmi-a-1", "dock-hover");
      const qs = readCapture(out, "panel-quick-settings", "qs");
      const cal = readCapture(out, "panel-calendar", "cal");
      const media = readCapture(out, "panel-media", "media");
      const settings = readCapture(out, "settings-window", "settings");
      const power = readCapture(out, "power-dialog", "power");
      const launcher = readCapture(out, "launcher-overlay", "launcher");

      // WCAG 2.2 SC 2.5.8: every visible interactive control must meet >= 24x24px hit area.
      for (const [label, tree] of [
        ["bar", bar.tree],
        ["dock", dock.tree],
        ["quick-settings", qs.tree],
        ["calendar", cal.tree],
        ["media", media.tree],
        ["settings", settings.tree],
        ["power-dialog", power.tree],
        ["launcher", launcher.tree],
      ] as const) {
        const controls = tree.nodes.filter(node => node.role && interactiveRoles.has(node.role) && node.boundsLogical);
        expect(controls.length, label).toBeGreaterThan(0);
        for (const node of controls) {
          const bounds = node.boundsLogical!;
          expect(bounds.width, `${label} ${node.testId ?? node.role} width`).toBeGreaterThanOrEqual(24);
          expect(bounds.height, `${label} ${node.testId ?? node.role} height`).toBeGreaterThanOrEqual(24);
        }
      }

      // Shadow-Clipping Guard: transparent LayerSurface bleed edges must fade to near-zero alpha.
      expect(maxRowAlpha(bar.image, 0), "bar top edge shadow clipping").toBeLessThanOrEqual(8);
      expect(maxRowAlpha(bar.image, bar.image.height - 1), "bar bottom edge shadow clipping").toBeLessThanOrEqual(8);
      expect(maxRowAlpha(dock.image, 0), "dock top edge shadow clipping").toBeLessThanOrEqual(8);

      // Rounded Surface Corner Guard: transparent rounded PopupSurface corners must remain pure transparent.
      for (const [label, capture] of [
        ["quick-settings", qs],
        ["calendar", cal],
        ["media", media],
      ] as const) {
        const w = capture.image.width - 1;
        const h = capture.image.height - 1;
        expect(pixel(capture.image, 0, 0), `${label} top-left corner transparent`).toEqual([0, 0, 0, 0]);
        expect(pixel(capture.image, w, 0), `${label} top-right corner transparent`).toEqual([0, 0, 0, 0]);
        expect(pixel(capture.image, 0, h), `${label} bottom-left corner transparent`).toEqual([0, 0, 0, 0]);
        expect(pixel(capture.image, w, h), `${label} bottom-right corner transparent`).toEqual([0, 0, 0, 0]);
      }

      // Opaque Toplevel Edge Guard: Settings WindowSurface delegates outer corners/borders to the compositor.
      {
        const w = settings.image.width - 1;
        const h = settings.image.height - 1;
        expect(pixel(settings.image, 0, 0)[3], "settings-window top-left opaque").toBe(255);
        expect(pixel(settings.image, w, 0)[3], "settings-window top-right opaque").toBe(255);
        expect(pixel(settings.image, 0, h)[3], "settings-window bottom-left opaque").toBe(255);
        expect(pixel(settings.image, w, h)[3], "settings-window bottom-right opaque").toBe(255);
      }

      // Dock Vertical Alignment: launcher tile and every app tile share the capsule's vertical center.
      const centerY = (bounds: DeviceBounds) => bounds.y + bounds.height / 2;
      const dockCapsule = treeNode(dock.tree, "dock-root-HDMI-A-1").boundsLogical!;
      const dockLauncher = treeNode(dock.tree, "dock-launcher").boundsLogical!;
      expect(Math.abs(centerY(dockLauncher) - centerY(dockCapsule)), "dock-launcher centered in capsule").toBeLessThanOrEqual(1);
      for (const appId of ["org.example.editor", "org.example.browser"]) {
        const appBounds = treeNode(dock.tree, `dock-app-${appId}`).boundsLogical!;
        expect(Math.abs(centerY(appBounds) - centerY(dockLauncher)), `dock-app-${appId} aligned with launcher`).toBeLessThanOrEqual(1);
      }

      // Hover Hit-Target Stability: hovering a dock button must never move its own hit box.
      const dockAppBefore = treeNode(dock.tree, "dock-app-org.example.editor").boundsLogical!;
      const dockAppAfterHover = treeNode(dockHover.tree, "dock-app-org.example.editor").boundsLogical!;
      expect(Math.abs(dockAppAfterHover.x - dockAppBefore.x), "hovered dock hit-target x stable").toBeLessThanOrEqual(0.5);
      expect(Math.abs(dockAppAfterHover.y - dockAppBefore.y), "hovered dock hit-target y stable").toBeLessThanOrEqual(0.5);
      expect(Math.abs(dockAppAfterHover.width - dockAppBefore.width), "hovered dock hit-target width stable").toBeLessThanOrEqual(0.5);
      expect(Math.abs(dockAppAfterHover.height - dockAppBefore.height), "hovered dock hit-target height stable").toBeLessThanOrEqual(0.5);

      // Launcher card width (652px) and composite search bar framing.
      expect(Math.round(treeNode(launcher.tree, "launcher-card").boundsLogical!.width)).toBe(652);
      const launcherSearchBar = treeNode(launcher.tree, "launcher-search-bar").boundsLogical!;
      const launcherSearchField = treeNode(launcher.tree, "launcher-search").boundsLogical!;
      expect(launcherSearchField.x).toBeGreaterThan(launcherSearchBar.x + 20);
      expect(launcherSearchField.y).toBeGreaterThanOrEqual(launcherSearchBar.y);
      expect(launcherSearchField.y + launcherSearchField.height).toBeLessThanOrEqual(launcherSearchBar.y + launcherSearchBar.height);

      // Top bar anti-collision at 1280px with long window title and long media label.
      const activeWin = treeNode(bar.tree, "bar-active-window").boundsLogical!;
      const clock = treeNode(bar.tree, "bar-clock").boundsLogical!;
      const mediaBar = treeNode(bar.tree, "bar-media").boundsLogical!;
      expect(activeWin.x + activeWin.width).toBeLessThanOrEqual(clock.x);
      expect(clock.x + clock.width).toBeLessThanOrEqual(mediaBar.x);

      // Precision sliders in Quick Settings share identical horizontal track bounds (Vertical Lane Alignment).
      const sliders = qs.tree.nodes.filter(node => node.role === "slider" && node.boundsLogical);
      expect(sliders.length).toBeGreaterThanOrEqual(2);
      const firstSlider = sliders[0]!.boundsLogical!;
      for (const slider of sliders.slice(1)) {
        expect(slider.boundsLogical!.x).toBe(firstSlider.x);
        expect(slider.boundsLogical!.width).toBe(firstSlider.width);
      }

      // Settled surface width tiers and Zero-Scroll auto-height match DESIGN.md.
      expect(Math.round(treeNode(qs.tree, "panel-root-quick-settings").boundsLogical!.width)).toBe(396);
      expect(qs.image.height).toBeLessThanOrEqual(760);
      expect(Math.round(treeNode(cal.tree, "panel-root-calendar").boundsLogical!.width)).toBe(396);
      expect(cal.image.height).toBeLessThanOrEqual(760);
      expect(Math.round(treeNode(media.tree, "panel-root-media").boundsLogical!.width)).toBe(396);
      expect(media.image.height).toBeLessThanOrEqual(420);
      expect(Math.round(treeNode(power.tree, "power-dialog-card").boundsLogical!.width)).toBe(360);

      // Settings WindowSurface (820x600 flush toplevel -> 216px left sidebar + 604px content pane).
      expect([settings.image.width, settings.image.height]).toEqual([820, 600]);
      expect(Math.round(treeNode(settings.tree, "settings-sidebar").boundsLogical!.width)).toBe(216);
      expect(Math.round(treeNode(settings.tree, "settings-content-pane").boundsLogical!.width)).toBe(604);

      // Zero-Scroll Popover Rule verified via upstream zgui-js scrollMetrics (commit 33c0fab+).
      for (const [label, capture, testId] of [
        ["quick-settings", qs, "qs-main"],
        ["calendar", cal, "panel-calendar"],
      ] as const) {
        const node = treeNode(capture.tree, testId);
        if (node.scrollMetrics) {
          expect(node.scrollMetrics.overflowY, `${label} overflowY`).toBe(false);
        }
      }
    } finally {
      cleanup();
    }
  });
});
