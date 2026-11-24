import { beforeAll, describe, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { PublishedApplication } from "@hewel/zgui-build";
import { buildShellPreviewFixture, makeSampleTelemetrySnapshot, makeSolidPngBytes } from "./fixture-builder.ts";
import {
  assertRoundedBlurStrips,
  assertSameBounds,
  buildPublishedShell,
  createPreviewWorkspace,
  createVirtualTimeline,
  diffRegionPixels,
  expectCleanPreview,
  maxColAlpha,
  maxRowAlpha,
  pixel,
  pixelChannelDiff,
  previewAvailable,
  previewTest,
  readCapture,
  runPreview,
  shellDir,
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
      timeline.advance("qs-settle", 450);
      timeline.step({ id: "capture-qs", op: "capture", surface: "panel-quick-settings", captureId: "qs" });

      timeline.step({ id: "open-qs-battery", op: "pointer.click", target: { surface: "panel-quick-settings", testId: "qs-battery-row" }, button: "primary" });
      timeline.advance("qs-battery-settle", 400);
      timeline.step({ id: "capture-qs-battery", op: "capture", surface: "panel-quick-settings", captureId: "qs-battery" });

      timeline.step({ id: "open-calendar", op: "pointer.click", target: { surface: "bar-hdmi-a-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("cal-settle", 450);
      timeline.step({ id: "capture-cal", op: "capture", surface: "panel-calendar", captureId: "cal" });

      timeline.step({ id: "open-media", op: "pointer.click", target: { surface: "bar-hdmi-a-1", testId: "bar-media" }, button: "primary" });
      timeline.advance("media-settle", 250);
      timeline.step({ id: "capture-media", op: "capture", surface: "panel-media", captureId: "media" });

      const wallpaperListAtMs = timeline.after(20);
      timeline.step({
        id: "open-settings", op: "service.emit", channel: "control.message",
        value: { args: ["settings", "appearance"], reply: { text: "{\"settingsWindowOpen\":true,\"settingsWindowTab\":\"appearance\"}" } },
      });
      timeline.advance("settings-settle", 250);
      timeline.step({ id: "capture-settings", op: "capture", surface: "settings-window", captureId: "settings" });

      timeline.step({ id: "open-settings-bar", op: "pointer.click", target: { surface: "settings-window", testId: "settings-nav-bar" }, button: "primary" });
      timeline.advance("settings-bar-settle", 250);
      timeline.step({ id: "capture-settings-bar", op: "capture", surface: "settings-window", captureId: "settings-bar" });

      timeline.step({ id: "open-settings-idle", op: "pointer.click", target: { surface: "settings-window", testId: "settings-nav-idle" }, button: "primary" });
      timeline.advance("settings-idle-settle", 250);
      timeline.step({ id: "capture-settings-idle", op: "capture", surface: "settings-window", captureId: "settings-idle" });

      timeline.step({ id: "open-settings-power", op: "pointer.click", target: { surface: "settings-window", testId: "settings-nav-power" }, button: "primary" });
      timeline.advance("settings-power-settle", 250);
      timeline.step({ id: "capture-settings-power", op: "capture", surface: "settings-window", captureId: "settings-power" });
      timeline.step({
        id: "close-settings", op: "service.emit", channel: "control.message",
        value: { args: ["settings", "close"], reply: { text: "{\"settingsWindowOpen\":false}" } },
      });
      timeline.advance("settings-close-settle", 100);

      timeline.step({
        id: "open-power-dialog", op: "service.emit", channel: "control.message",
        value: { args: ["power", "poweroff"], reply: { text: "{\"pendingPowerAction\":\"poweroff\"}" } },
      });
      timeline.advance("power-settle", 450);
      timeline.step({ id: "capture-power", op: "capture", surface: "power-dialog", captureId: "power" });

      const launcherQueryAtMs = timeline.after(20);
      timeline.step({
        id: "open-launcher", op: "service.emit", channel: "control.message",
        value: { args: ["panel", "launcher"], reply: { text: "{\"activePanel\":\"launcher\"}" } },
      });
      timeline.advance("launcher-settle", 350);
      timeline.step({ id: "capture-launcher", op: "capture", surface: "launcher-overlay", captureId: "launcher" });

      timeline.step({ id: "open-overview", op: "pointer.click", target: { surface: "bar-hdmi-a-1", testId: "bar-overview" }, button: "primary" });
      timeline.advance("overview-settle", 450);
      timeline.step({ id: "capture-overview", op: "capture", surface: "overview-overlay", captureId: "overview" });

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
              { workspace_id: 1, group_id: 1, name: "design", id_str: "1", coordinates: [1], active: false, urgent: false, hidden: false, capabilities: ["activate"] },
              { workspace_id: 2, group_id: 1, name: "main", id_str: "2", coordinates: [2], active: true, urgent: false, hidden: false, capabilities: ["activate"] },
              { workspace_id: 3, group_id: 1, name: "chat", id_str: "3", coordinates: [3], active: false, urgent: true, hidden: false, capabilities: ["activate"] },
              { workspace_id: 4, group_id: 1, name: "4", id_str: "4", coordinates: [4], active: false, urgent: false, hidden: false, capabilities: ["activate"] },
            ],
          },
          "wayland.windows": {
            capability: "connected",
            windows: [
              {
                window_id: 10, app_id: "org.example.editor",
                title: "VeryLongProjectName — crates/z-shell-theme/src/palette.rs — Extremely Verbose Editor Window Title That Must Truncate",
                activated: true, minimized: false, maximized: false, fullscreen: false, output_instance_ids: [1],
              },
              {
                window_id: 11, app_id: "org.example.browser",
                title: "Paper — z-shell",
                activated: false, minimized: false, maximized: false, fullscreen: false, output_instance_ids: [1],
              },
            ],
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
          "desktop.notifications": {
            available: true,
            dnd: false,
            active: [],
            history: [{
              id: 1,
              app_name: "System",
              summary: "Update ready",
              body: "Concentric badge cap check",
              app_icon: "",
              icon: null,
              attachment: null,
              actions: [],
              urgency: 1,
            }],
          },
          "desktop.ime": {
            available: true,
            mode: "indicator_only",
            active_im: { unique_name: "keyboard-us", label: "English", short_label: "EN" },
            group_ims: [{ unique_name: "keyboard-us", label: "English", short_label: "EN" }],
            properties: [],
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
          "system.power": {
            available: true,
            on_ac: false,
            battery: {
              percentage: 82,
              state: "discharging",
              time_to_empty_seconds: 19320,
              time_to_full_seconds: null,
              energy_rate_watts: 11.4,
              capacity_percent: 96,
              charge_cycles: 142,
            },
            profiles: { available: true, active_profile: "balanced", profiles: ["performance", "balanced", "power-saver"] },
          },
          "session.idle": {
            service_status: { status: "running" },
            caffeine: false,
            inhibited: false,
            active_inhibitors: [],
            rules: [
              { name: "lock", timeout_seconds: 300, locked_timeout_seconds: null, action: "lock", resume_command: null, pre_action_fade_seconds: 2, enabled: true },
              { name: "dpms", timeout_seconds: 600, locked_timeout_seconds: 30, action: "screen_off", resume_command: null, pre_action_fade_seconds: 2, enabled: true },
            ],
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
      expectCleanPreview(result, 14, 0);
      const bar = readCapture(out, "bar-hdmi-a-1", "bar");
      const dock = readCapture(out, "dock-hdmi-a-1", "dock");
      const dockHover = readCapture(out, "dock-hdmi-a-1", "dock-hover");
      const qs = readCapture(out, "panel-quick-settings", "qs");
      const qsBattery = readCapture(out, "panel-quick-settings", "qs-battery");
      const cal = readCapture(out, "panel-calendar", "cal");
      const media = readCapture(out, "panel-media", "media");
      const settings = readCapture(out, "settings-window", "settings");
      const settingsBar = readCapture(out, "settings-window", "settings-bar");
      const settingsIdle = readCapture(out, "settings-window", "settings-idle");
      const settingsPower = readCapture(out, "settings-window", "settings-power");
      const power = readCapture(out, "power-dialog", "power");
      const launcher = readCapture(out, "launcher-overlay", "launcher");
      const overview = readCapture(out, "overview-overlay", "overview");

      // WCAG 2.2 SC 2.5.8: every visible interactive control must meet >= 24x24px hit area.
      for (const [label, tree] of [
        ["bar", bar.tree],
        ["dock", dock.tree],
        ["quick-settings", qs.tree],
        ["quick-settings-battery", qsBattery.tree],
        ["calendar", cal.tree],
        ["media", media.tree],
        ["settings", settings.tree],
        ["settings-bar", settingsBar.tree],
        ["settings-idle", settingsIdle.tree],
        ["settings-power", settingsPower.tree],
        ["power-dialog", power.tree],
        ["launcher", launcher.tree],
        ["overview", overview.tree],
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

      // Rounded Surface Corner & geometryInsets Outer Shadow Guard:
      // PopupSurface reserves POPOVER_SHADOW_INSETS (20/28/38/28) around visual windowGeometry G,
      // renders --shadow-level-2 cleanly in the bleed gutter fading to alpha <= 8 at all 4 buffer edges,
      // and keeps blurRegion strictly inside G.
      for (const [label, capture, rootTestId] of [
        ["quick-settings", qs, "panel-root-quick-settings"],
        ["quick-settings-battery", qsBattery, "panel-root-quick-settings"],
        ["calendar", cal, "panel-root-calendar"],
        ["media", media, "panel-root-media"],
      ] as const) {
        const w = capture.image.width - 1;
        const h = capture.image.height - 1;
        expect(pixel(capture.image, 0, 0), `${label} top-left corner transparent`).toEqual([0, 0, 0, 0]);
        expect(pixel(capture.image, w, 0), `${label} top-right corner transparent`).toEqual([0, 0, 0, 0]);
        expect(pixel(capture.image, 0, h), `${label} bottom-left corner transparent`).toEqual([0, 0, 0, 0]);
        expect(pixel(capture.image, w, h), `${label} bottom-right corner transparent`).toEqual([0, 0, 0, 0]);
        expect(maxRowAlpha(capture.image, 0), `${label} top shadow edge <= 8`).toBeLessThanOrEqual(8);
        expect(maxRowAlpha(capture.image, h), `${label} bottom shadow edge <= 8`).toBeLessThanOrEqual(8);
        expect(maxColAlpha(capture.image, 0), `${label} left shadow edge <= 8`).toBeLessThanOrEqual(8);
        expect(maxColAlpha(capture.image, w), `${label} right shadow edge <= 8`).toBeLessThanOrEqual(8);

        const geom = capture.frame.windowGeometry;
        expect(geom, `${label} records xdg windowGeometry`).toBeDefined();
        expect(geom!.x, `${label} windowGeometry.x = left inset 28`).toBe(28);
        expect(geom!.y, `${label} windowGeometry.y = top inset 20`).toBe(20);
        expect(geom!.width, `${label} windowGeometry.width = 396`).toBe(396);
        expect(capture.image.width, `${label} surface buffer width = 396 + 56`).toBe(396 + 56);
        expect(capture.image.height, `${label} surface buffer height = visual height + 58`).toBe(geom!.height + 58);

        const cardBounds = treeNode(capture.tree, rootTestId).boundsLogical!;
        expect(Math.round(cardBounds.x), `${label} visual card x`).toBe(28);
        expect(Math.round(cardBounds.y), `${label} visual card y`).toBe(20);
        // Bottom bleed gutter right below visual card renders visible drop shadow alpha.
        const shadowSample = pixel(
          capture.image,
          Math.round(geom!.x + geom!.width / 2),
          Math.round(geom!.y + geom!.height + 6),
        );
        expect(shadowSample[3], `${label} outer shadow visible in bottom bleed gutter`).toBeGreaterThan(15);

        // Declarative ext_background_effect_v1 blurRegion: <=45 strictly interior strips inside visual card G.
        assertRoundedBlurStrips(
          capture.frame.blurRegion,
          geom!,
          22,
          `${label} blurRegion`,
        );
      }

      // Floating Bar, Floating Dock, and always-solid Settings blurRegion contracts (#86).
      expect(Array.isArray(bar.frame.blurRegion), "floating bar publishes rounded blurRegion strips").toBe(true);
      expect((bar.frame.blurRegion as readonly unknown[]).length, "floating bar blurRegion <= 256").toBeLessThanOrEqual(256);
      assertRoundedBlurStrips(
        dock.frame.blurRegion,
        treeNode(dock.tree, "dock-root-HDMI-A-1").boundsLogical!,
        22,
        "floating dock blurRegion",
      );
      expect(settings.frame.blurRegion, "Settings Window (Level 3) remains always-solid blurRegion='none'").toBe("none");

      // Opaque Toplevel Edge Guard: Settings WindowSurface delegates outer corners/borders to the compositor.
      {
        const w = settings.image.width - 1;
        const h = settings.image.height - 1;
        expect(pixel(settings.image, 0, 0)[3], "settings-window top-left opaque").toBe(255);
        expect(pixel(settings.image, w, 0)[3], "settings-window top-right opaque").toBe(255);
        expect(pixel(settings.image, 0, h)[3], "settings-window bottom-left opaque").toBe(255);
        expect(pixel(settings.image, w, h)[3], "settings-window bottom-right opaque").toBe(255);
      }

      // Dock Vertical Alignment & Concentric R=22px Corner Arc:
      // launcher tile and every app tile share vertical center; pixel (8, 8) inside the 60px capsule
      // is opaque inside R=22px (distance 19.8px <= 22px) whereas a 999px semicircle (R=30px) would leave (8, 8) transparent.
      const centerY = (bounds: DeviceBounds) => bounds.y + bounds.height / 2;
      const dockCapsule = treeNode(dock.tree, "dock-root-HDMI-A-1").boundsLogical!;
      const dockCapsuleDev = treeNode(dock.tree, "dock-root-HDMI-A-1").boundsDevice!;
      const dockLauncher = treeNode(dock.tree, "dock-launcher").boundsLogical!;
      expect(Math.abs(centerY(dockLauncher) - centerY(dockCapsule)), "dock-launcher centered in capsule").toBeLessThanOrEqual(1);
      expect(
        pixel(dock.image, Math.round(dockCapsuleDev.x + 8), Math.round(dockCapsuleDev.y + 8))[3],
        "dock concentric R=22px corner filled at (8,8)",
      ).toBeGreaterThanOrEqual(200);
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

      // Launcher card width (652px), composite search bar framing, and centered Esc keycap.
      expect(Math.round(treeNode(launcher.tree, "launcher-card").boundsLogical!.width)).toBe(652);
      const launcherSearchBar = treeNode(launcher.tree, "launcher-search-bar").boundsLogical!;
      const launcherSearchField = treeNode(launcher.tree, "launcher-search").boundsLogical!;
      const launcherEscBadge = treeNode(launcher.tree, "launcher-esc-badge").boundsLogical!;
      const launcherEscText = treeNode(launcher.tree, "launcher-esc-text").boundsLogical!;
      expect(launcherSearchField.x).toBeGreaterThan(launcherSearchBar.x + 20);
      expect(Math.abs(centerY(launcherEscBadge) - centerY(launcherSearchBar)), "launcher Esc badge centered in search bar").toBeLessThanOrEqual(1);
      expect(Math.abs(centerY(launcherEscText) - centerY(launcherEscBadge)), "launcher Esc text centered in badge").toBeLessThanOrEqual(1);

      // Overview card width (684px) and interactive workspaces + windows.
      expect(Math.round(treeNode(overview.tree, "overview-card").boundsLogical!.width)).toBe(684);
      expect(treeNode(overview.tree, "overview-ws-2").boundsLogical).toBeDefined();

      // M3 Expressive Slider pixel anatomy on wide Settings slider (Tiling gap = 14px -> 22%):
      // active fill + 4px transparent gap + 4px vertical handle + 4px transparent gap + inactive track + 4x4px stop dot.
      {
        const gapSlider = settingsBar.tree.nodes.find(node => node.role === "slider" && node.name === "Tiling gap");
        expect(gapSlider?.boundsDevice, "settings-bar Tiling gap slider").toBeDefined();
        const bounds = gapSlider!.boundsDevice!;
        const midY = Math.round(bounds.y + bounds.height / 2);
        const bgSample = pixel(settingsBar.image, Math.round(bounds.x + 20), Math.round(bounds.y + 1));
        const filledSample = pixel(settingsBar.image, Math.round(bounds.x + 20), midY);
        const unfilledSample = pixel(settingsBar.image, Math.round(bounds.x + bounds.width - 24), midY);
        expect(filledSample).not.toEqual(unfilledSample);
        expect(filledSample).not.toEqual(bgSample);

        // Scan the horizontal centerline across the slider for the active -> gap -> vertical handle -> gap -> inactive transition.
        const sameColor = (a: readonly number[], b: readonly number[]) =>
          Math.abs(a[0]! - b[0]!) <= 6 && Math.abs(a[1]! - b[1]!) <= 6 && Math.abs(a[2]! - b[2]!) <= 6;
        let leftGapStart = -1;
        let handleStart = -1;
        let handleEnd = -1;
        let rightGapEnd = -1;
        for (let x = Math.round(bounds.x + 20); x < Math.round(bounds.x + bounds.width - 20); x++) {
          const px = pixel(settingsBar.image, x, midY);
          if (leftGapStart < 0 && sameColor(px, bgSample)) {
            leftGapStart = x;
          } else if (leftGapStart >= 0 && handleStart < 0 && sameColor(px, filledSample)) {
            handleStart = x;
          } else if (handleStart >= 0 && handleEnd < 0 && sameColor(px, bgSample)) {
            handleEnd = x;
          } else if (handleEnd >= 0 && rightGapEnd < 0 && sameColor(px, unfilledSample)) {
            rightGapEnd = x;
            break;
          }
        }
        expect(leftGapStart, "expressive slider left 4px gap detected").toBeGreaterThan(bounds.x + 20);
        expect(handleStart - leftGapStart, "expressive slider left gap width ~4px").toBeGreaterThanOrEqual(3);
        expect(handleEnd - handleStart, "expressive slider vertical handle width ~4px").toBeGreaterThanOrEqual(3);
        expect(handleEnd - handleStart, "expressive slider vertical handle not wide circle").toBeLessThanOrEqual(6);
        expect(rightGapEnd - handleEnd, "expressive slider right gap width ~4px").toBeGreaterThanOrEqual(3);
        // Trailing 4x4px primary stop dot sits inset ~3px from the right edge of the track.
        const stopDotPixels = [3, 4, 5, 6].some(inset =>
          sameColor(pixel(settingsBar.image, Math.round(bounds.x + bounds.width - inset), midY), filledSample),
        );
        expect(stopDotPixels, "expressive slider trailing 4px primary stop dot").toBe(true);
      }

      // M3Switch desktop geometry (44x24px) in Bar & layout settings, and 34px desktop M3Button height in Power Dialog.
      {
        const switchNodes = settingsBar.tree.nodes.filter(
          node => node.role === "switch" && node.boundsLogical && Math.round(node.boundsLogical.width) === 44 && Math.round(node.boundsLogical.height) === 24,
        );
        expect(switchNodes.length, "settings-bar 44x24px M3Switch controls").toBeGreaterThanOrEqual(4);
        const cancelBounds = treeNode(power.tree, "power-dialog-cancel").boundsLogical!;
        const confirmBounds = treeNode(power.tree, "power-dialog-confirm").boundsLogical!;
        expect(Math.round(cancelBounds.height), "power-dialog Cancel M3Button height").toBe(34);
        expect(Math.round(confirmBounds.height), "power-dialog Confirm M3Button height").toBe(34);
      }
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

      // Settled surface width tiers and Zero-Scroll auto-height match DESIGN.md (visual windowGeometry excluding shadow bleed).
      expect(Math.round(treeNode(qs.tree, "panel-root-quick-settings").boundsLogical!.width)).toBe(396);
      expect(qs.frame.windowGeometry!.height).toBeLessThanOrEqual(760);
      expect(Math.round(treeNode(qsBattery.tree, "panel-root-quick-settings").boundsLogical!.width)).toBe(396);
      expect(treeNode(qsBattery.tree, "qs-page-battery").boundsLogical).toBeDefined();
      expect(qsBattery.frame.windowGeometry!.height).toBeLessThanOrEqual(760);
      expect(Math.round(treeNode(cal.tree, "panel-root-calendar").boundsLogical!.width)).toBe(396);
      expect(cal.frame.windowGeometry!.height).toBeLessThanOrEqual(760);
      expect(Math.round(treeNode(media.tree, "panel-root-media").boundsLogical!.width)).toBe(396);
      expect(media.frame.windowGeometry!.height).toBeLessThanOrEqual(420);
      expect(Math.round(treeNode(power.tree, "power-dialog-card").boundsLogical!.width)).toBe(360);

      // Settings WindowSurface (820x600 flush toplevel -> 216px left sidebar + 604px content pane).
      for (const [label, cap] of [
        ["appearance", settings],
        ["bar", settingsBar],
        ["idle", settingsIdle],
        ["power", settingsPower],
      ] as const) {
        expect([cap.image.width, cap.image.height], label).toEqual([820, 600]);
      }
      expect(Math.round(treeNode(settings.tree, "settings-sidebar").boundsLogical!.width)).toBe(216);
      expect(Math.round(treeNode(settings.tree, "settings-content-pane").boundsLogical!.width)).toBe(604);
      expect(treeNode(settingsBar.tree, "settings-bar-pane").boundsLogical).toBeDefined();
      expect(treeNode(settingsIdle.tree, "settings-idle-pane").boundsLogical).toBeDefined();
      expect(treeNode(settingsPower.tree, "settings-power-pane").boundsLogical).toBeDefined();

      // Zero-Scroll Popover Rule verified via upstream zgui-js scrollMetrics (commit 33c0fab+).
      for (const [label, capture, testId] of [
        ["quick-settings", qs, "qs-main"],
        ["calendar", cal, "panel-calendar"],
        ["calendar-list", cal, "cal-notif-scroll"],
      ] as const) {
        const node = treeNode(capture.tree, testId);
        if (node.scrollMetrics) {
          expect(node.scrollMetrics.overflowY, `${label} overflowY`).toBe(false);
        }
      }

      // Media Player Single Hero CTA Guard: active source chip uses calm primary-container (not solid primary),
      // leaving the Play/Pause pill as the sole solid primary fill.
      {
        const chip = treeNode(media.tree, "media-player-spotify").boundsDevice!;
        const playBtn = treeNode(media.tree, "media-play-pause").boundsDevice!;
        const chipEdge = pixel(media.image, Math.round(chip.x + 5), Math.round(chip.y + chip.height / 2));
        const playEdge = pixel(media.image, Math.round(playBtn.x + 12), Math.round(playBtn.y + playBtn.height / 2));
        expect(playEdge, "media play/pause uses solid primary fill").toEqual([0x7c, 0xd4, 0xff, 255]);
        expect(chipEdge, "media active source chip must not compete with solid primary play/pause").not.toEqual(playEdge);
      }

      // Control Center Avatar Fallback Visibility Guard: when avatar is null, fallback person glyph paints above rosette vector.
      {
        const fallback = treeNode(qs.tree, "qs-avatar-fallback").boundsDevice!;
        const bgSample = pixel(qs.image, Math.round(fallback.x - 4), Math.round(fallback.y - 4));
        let nonBgPixels = 0;
        for (let y = Math.round(fallback.y); y < Math.round(fallback.y + fallback.height); y += 2) {
          for (let x = Math.round(fallback.x); x < Math.round(fallback.x + fallback.width); x += 2) {
            const px = pixel(qs.image, x, y);
            if (px[0] !== bgSample[0] || px[1] !== bgSample[1] || px[2] !== bgSample[2]) nonBgPixels++;
          }
        }
        expect(nonBgPixels, "qs avatar fallback person icon must be visibly painted above rosette backdrop").toBeGreaterThan(6);
      }
    } finally {
      cleanup();
    }
  }, 30_000);

  previewTest("Docked Top Bar (38px), Polkit 23 Auth Prompt (360px), and Reduced Motion surface checks", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-design-docked-");
    const interactiveRoles = new Set(["button", "switch", "slider", "menuItem", "menuItemCheckBox", "menuItemRadio", "tab"]);
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const monitor = { id: "DP-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900, scale: 1 };

      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });
      timeline.step({ id: "capture-bar-docked", op: "capture", surface: "bar-dp-1", captureId: "bar-docked" });

      timeline.step({ id: "open-media", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-media" }, button: "primary" });
      timeline.advance("media-reduced-settle", 120);
      timeline.step({ id: "capture-media-reduced", op: "capture", surface: "panel-media", captureId: "media-reduced" });

      const polkitAtMs = timeline.after(15);
      timeline.advance("polkit-prompt", 30);
      timeline.advance("polkit-settle", 120);
      timeline.step({ id: "capture-polkit", op: "capture", surface: "polkit-dialog", captureId: "polkit-23" });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-docked-polkit-reduced",
        initialTopics: {
          settings: {
            general: { offline_mode: false, log_level: "info" },
            bar: {
              position: "top",
              style: "docked",
              gaps: 0,
              edge_overrides: { top: null, right: null, bottom: null, left: null },
              launcher_enabled: true,
              dock_enabled: false,
              clock_24h: true,
              clock_seconds: false,
            },
            theme: {
              mode: "dark",
              variant: "tonal",
              seed_color: null,
              motion_scheme: "reduced",
              backend: "builtin",
              gtk_linking: false,
            },
            ime: { mode: "indicator_only", candidate_layout: "auto", switch_osd: true },
            polkit: { enabled: true },
            wallpaper: { directories: [], fit: "cover", sync_theme: true, slideshow_seconds: 300 },
            pre_action_fade_seconds: 0,
            configured_plugins: [],
          },
          "desktop.notifications": {
            available: true,
            dnd: false,
            active: [],
            history: [{
              id: 1,
              app_name: "System",
              summary: "Update ready",
              body: "Concentric badge cap check",
              app_icon: "",
              icon: null,
              attachment: null,
              actions: [],
              urgency: 1,
            }],
          },
          "desktop.ime": {
            available: true,
            mode: "indicator_only",
            active_im: { unique_name: "keyboard-us", label: "English", short_label: "EN" },
            group_ims: [{ unique_name: "keyboard-us", label: "English", short_label: "EN" }],
            properties: [],
          },
          "desktop.media": {
            available: true,
            selected_player_id: "spotify",
            any_playing: true,
            cover: null,
            players: [{
              id: "spotify", identity: "Spotify", playback_status: "playing", position_us: 90_000_000,
              capabilities: { can_play: true, can_pause: true, can_go_next: true, can_go_previous: true, can_seek: true },
              metadata: {
                title: "Reduced Motion Track",
                artists: ["z-shell"],
                album: "Calm",
                length_us: 180_000_000,
              },
            }],
          },
        },
        topicUpdates: [
          {
            atMs: polkitAtMs,
            topic: "session.polkit",
            revision: 2,
            data: {
              enabled: true,
              registered: true,
              locked_suppressed: false,
              last_error: null,
              active: {
                request_id: 7,
                action_id: "org.freedesktop.systemd1.manage-units",
                message: "Authentication is required to restart system services.",
                icon_name: "system-lock-screen",
                prompt: "Password",
                echo_on: false,
                selected_uid: 1000,
                identities: [{ uid: 1000, username: "hewel" }],
                details: { unit: "NetworkManager.service" },
                info_message: null,
                error_message: null,
                authenticating: false,
              },
            },
          },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-docked-polkit-reduced",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(published.dist, fixture, scenario, out);
      expectCleanPreview(result, 3, 0);
      const barDocked = readCapture(out, "bar-dp-1", "bar-docked");
      const mediaReduced = readCapture(out, "panel-media", "media-reduced");
      const polkit = readCapture(out, "polkit-dialog", "polkit-23");

      // Docked top bar is flush 38px without floating shadow bleed and always solid (blurRegion="none").
      expect([barDocked.image.width, barDocked.image.height]).toEqual([1440, 38]);
      expect(barDocked.frame.blurRegion, "Docked Top Bar (Level 1C) stays solid blurRegion='none'").toBe("none");

      // Reduced motion Media panel settles immediately at 396px width with transparent rounded corners
      // and renders a flat horizontal progress track (no vertical sine wave deflection above/below centerline).
      expect(Math.round(treeNode(mediaReduced.tree, "panel-root-media").boundsLogical!.width)).toBe(396);
      expect(pixel(mediaReduced.image, 0, 0)).toEqual([0, 0, 0, 0]);
      {
        const track = treeNode(mediaReduced.tree, "media-progress").boundsDevice!;
        const centerY = Math.round(track.y + track.height / 2);
        const bgSample = pixel(mediaReduced.image, Math.round(track.x + 8), Math.round(track.y + 2));
        // Across the played half (15%..40% of track), y-5 and y+5 must match background (flat line, zero wave).
        for (const frac of [0.18, 0.24, 0.30, 0.36]) {
          const sx = Math.round(track.x + track.width * frac);
          expect(pixel(mediaReduced.image, sx, centerY - 6), `reduced media flat above at ${frac}`).toEqual(bgSample);
          expect(pixel(mediaReduced.image, sx, centerY + 6), `reduced media flat below at ${frac}`).toEqual(bgSample);
        }
      }

      // Polkit 23 card width (360px), 34px M3Button actions, and >= 24px interactive hit targets.
      expect(Math.round(treeNode(polkit.tree, "polkit-card").boundsLogical!.width)).toBe(360);
      expect(Math.round(treeNode(polkit.tree, "polkit-cancel").boundsLogical!.height)).toBe(34);
      expect(Math.round(treeNode(polkit.tree, "polkit-submit").boundsLogical!.height)).toBe(34);
      expect(treeNode(polkit.tree, "polkit-input").boundsLogical).toBeDefined();
      expect(treeNode(polkit.tree, "polkit-action-id").text).toBe("org.freedesktop.systemd1.manage-units");

      for (const [label, tree] of [
        ["bar-docked", barDocked.tree],
        ["media-reduced", mediaReduced.tree],
        ["polkit-23", polkit.tree],
      ] as const) {
        const controls = tree.nodes.filter(node => node.role && interactiveRoles.has(node.role) && node.boundsLogical);
        expect(controls.length, label).toBeGreaterThan(0);
        for (const node of controls) {
          const bounds = node.boundsLogical!;
          expect(bounds.width, `${label} ${node.testId ?? node.role} width`).toBeGreaterThanOrEqual(24);
          expect(bounds.height, `${label} ${node.testId ?? node.role} height`).toBeGreaterThanOrEqual(24);
        }
      }
    } finally {
      cleanup();
    }
  }, 30_000);

  previewTest("Vertical Left Bar (09B) geometry and bottom-left Control Center anchoring", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-design-vertical-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const monitor = { id: "DP-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900, scale: 1 };

      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 250);
      timeline.step({ id: "ready", op: "settle" });
      timeline.step({ id: "capture-left-bar", op: "capture", surface: "bar-dp-1", captureId: "bar-left" });
      timeline.step({ id: "open-left-qs", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-audio" }, button: "primary" });
      timeline.advance("left-qs-settle", 450);
      timeline.step({ id: "capture-left-qs", op: "capture", surface: "panel-quick-settings", captureId: "qs-left" });
      const dockedAtMs = timeline.after(10);
      timeline.advance("docked-apply", 80);
      timeline.step({ id: "open-left-cal", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("left-cal-settle", 450);
      timeline.step({ id: "capture-left-bar-docked-active", op: "capture", surface: "bar-dp-1", captureId: "bar-left-docked-active" });
      timeline.step({ id: "open-left-tray-menu", op: "pointer.click", target: { surface: "bar-dp-1", testId: "tray-item-razer" }, button: "secondary" });
      timeline.advance("tray-menu-settle", 450);
      timeline.step({ id: "capture-tray-menu", op: "capture", surface: "tray-menu", captureId: "tray-menu-long" });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-vertical-left-bar",
        initialTopics: {
          "desktop.tray": {
            available: true,
            items: [{
              id: "razer",
              title: "Polychromatic",
              status: "Active",
              category: "Hardware",
              item_is_menu: false,
              icon: null,
              menu: {
                revision: 1,
                root: {
                  id: 0,
                  label: null,
                  visible: true,
                  enabled: true,
                  separator: false,
                  toggle_type: null,
                  toggle_state: null,
                  children: [
                    {
                      id: 1,
                      label: "Razer Viper V3 Pro (Wireless)",
                      visible: true,
                      enabled: true,
                      separator: false,
                      toggle_type: null,
                      toggle_state: null,
                      children: [
                        {
                          id: 2,
                          label: "Poll Rate",
                          visible: true,
                          enabled: true,
                          separator: false,
                          toggle_type: null,
                          toggle_state: null,
                          children: [
                            { id: 3, label: "125 Hz (8 msec latency)", visible: true, enabled: true, separator: false, toggle_type: "radio", toggle_state: 0, children: [] },
                            { id: 4, label: "500 Hz (2 msec latency)", visible: true, enabled: true, separator: false, toggle_type: "radio", toggle_state: 0, children: [] },
                            { id: 5, label: "1000 Hz (1 msec latency)", visible: true, enabled: true, separator: false, toggle_type: "radio", toggle_state: 1, children: [] },
                            { id: 6, label: "2000 Hz (0.5 msec latency)", visible: true, enabled: true, separator: false, toggle_type: "radio", toggle_state: 0, children: [] },
                            { id: 7, label: "4000 Hz (0.25 msec latency)", visible: true, enabled: true, separator: false, toggle_type: "radio", toggle_state: 0, children: [] },
                            { id: 8, label: "8000 Hz (0.125 msec latency)", visible: true, enabled: true, separator: false, toggle_type: "radio", toggle_state: 0, children: [] },
                          ],
                        },
                        { id: 9, label: "Sleep mode after", visible: true, enabled: true, separator: false, toggle_type: null, toggle_state: null, children: [] },
                        { id: 10, label: "Battery saver threshold", visible: true, enabled: true, separator: false, toggle_type: null, toggle_state: null, children: [] },
                      ],
                    },
                  ],
                },
              },
            }],
          },
          "desktop.notifications": {
            available: true,
            dnd: false,
            active: [],
            history: [
              { id: 1, app_name: "System", summary: "One", body: "Msg 1", app_icon: "", icon: null, attachment: null, actions: [], urgency: 1 },
              { id: 2, app_name: "System", summary: "Two", body: "Msg 2", app_icon: "", icon: null, attachment: null, actions: [], urgency: 1 },
            ],
          },
          "desktop.ime": {
            available: true,
            mode: "indicator_only",
            active_im: { unique_name: "keyboard-us", label: "English", short_label: "EN" },
            group_ims: [{ unique_name: "keyboard-us", label: "English", short_label: "EN" }],
            properties: [],
          },
          settings: {
            general: { offline_mode: false, log_level: "info" },
            bar: {
              position: "left",
              style: "floating",
              gaps: 14,
              edge_overrides: { top: null, right: null, bottom: null, left: null },
              launcher_enabled: true,
              dock_enabled: true,
              clock_24h: true,
              clock_seconds: false,
            },
            theme: {
              mode: "dark",
              variant: "tonal",
              seed_color: null,
              motion_scheme: "standard",
              backend: "builtin",
              gtk_linking: false,
            },
            ime: { mode: "indicator_only", candidate_layout: "auto", switch_osd: true },
            polkit: { enabled: true },
            wallpaper: { directories: [], fit: "cover", sync_theme: true, slideshow_seconds: 300 },
            pre_action_fade_seconds: 0,
            configured_plugins: [],
          },
        },
        topicUpdates: [
          {
            atMs: dockedAtMs,
            topic: "settings",
            revision: 2,
            data: {
              general: { offline_mode: false, log_level: "info" },
              bar: {
                position: "left",
                style: "docked",
                gaps: 0,
                edge_overrides: { top: null, right: null, bottom: null, left: null },
                launcher_enabled: true,
                dock_enabled: false,
                clock_24h: true,
                clock_seconds: false,
              },
              theme: {
                mode: "dark",
                variant: "tonal",
                seed_color: null,
                motion_scheme: "standard",
                backend: "builtin",
                gtk_linking: false,
              },
              ime: { mode: "indicator_only", candidate_layout: "auto", switch_osd: true },
              polkit: { enabled: true },
              wallpaper: { directories: [], fit: "cover", sync_theme: true, slideshow_seconds: 300 },
              pre_action_fade_seconds: 0,
              configured_plugins: [],
            },
          },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-vertical-left-bar",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(published.dist, fixture, scenario, out);
      expectCleanPreview(result, 4, 0);
      const barLeft = readCapture(out, "bar-dp-1", "bar-left");
      const qsLeft = readCapture(out, "panel-quick-settings", "qs-left");
      const barLeftDockedActive = readCapture(out, "bar-dp-1", "bar-left-docked-active");
      const trayMenuLong = readCapture(out, "tray-menu", "tray-menu-long");

      // Long nested tray menu auto-sizes width (beyond old 220px cap) and height (beyond old 340px cap)
      // with geometryInsets outer shadow bleed, all 4 corners transparent, and bottom row inside visual windowGeometry.
      const trayGeom = trayMenuLong.frame.windowGeometry!;
      expect(trayGeom, "tray-menu records windowGeometry").toBeDefined();
      expect(trayGeom.width, "tray-menu widens for long nested labels").toBeGreaterThanOrEqual(270);
      expect(trayGeom.width, "tray-menu bounded within compact 360px tier").toBeLessThanOrEqual(360);
      expect(trayGeom.height, "tray-menu expands past old 340px clip").toBeGreaterThan(360);
      {
        const w = trayMenuLong.image.width - 1;
        const h = trayMenuLong.image.height - 1;
        expect(pixel(trayMenuLong.image, 0, 0), "tray-menu top-left transparent").toEqual([0, 0, 0, 0]);
        expect(pixel(trayMenuLong.image, w, 0), "tray-menu top-right transparent").toEqual([0, 0, 0, 0]);
        expect(pixel(trayMenuLong.image, 0, h), "tray-menu bottom-left transparent").toEqual([0, 0, 0, 0]);
        expect(pixel(trayMenuLong.image, w, h), "tray-menu bottom-right transparent").toEqual([0, 0, 0, 0]);
        expect(maxRowAlpha(trayMenuLong.image, 0), "tray-menu top shadow edge <= 8").toBeLessThanOrEqual(8);
        expect(maxRowAlpha(trayMenuLong.image, h), "tray-menu bottom shadow edge <= 8").toBeLessThanOrEqual(8);
        expect(maxColAlpha(trayMenuLong.image, 0), "tray-menu left shadow edge <= 8").toBeLessThanOrEqual(8);
        expect(maxColAlpha(trayMenuLong.image, w), "tray-menu right shadow edge <= 8").toBeLessThanOrEqual(8);
        const lastItem = treeNode(trayMenuLong.tree, "tray-menu-item-10").boundsLogical!;
        expect(lastItem.y + lastItem.height, "last tray menu item fully inside visual card").toBeLessThanOrEqual(trayGeom.y + trayGeom.height - 6);
        assertRoundedBlurStrips(
          trayMenuLong.frame.blurRegion,
          trayGeom,
          16,
          "tray-menu blurRegion",
        );
      }

      // Floating left bar is 76px wide (40px pill + shadow bleed) with transparent corner and rounded blurRegion.
      expect([barLeft.image.width, barLeft.image.height]).toEqual([76, 896]);
      expect(pixel(barLeft.image, 0, 0)).toEqual([0, 0, 0, 0]);
      expect(Array.isArray(barLeft.frame.blurRegion), "floating vertical bar publishes rounded blurRegion strips").toBe(true);
      expect((barLeft.frame.blurRegion as readonly unknown[]).length, "vertical bar blurRegion <= 256").toBeLessThanOrEqual(256);
      expect(barLeftDockedActive.frame.blurRegion, "docked vertical bar stays solid blurRegion='none'").toBe("none");
      // Control Center opens cleanly at 396px width anchored from the bottom-left status island.
      expect(Math.round(treeNode(qsLeft.tree, "panel-root-quick-settings").boundsLogical!.width)).toBe(396);
      expect(pixel(qsLeft.image, 0, 0)).toEqual([0, 0, 0, 0]);

      // Nested Pill Inner Containment Guard (Vertical Floating & Vertical Docked Active):
      // Nested notification badge and IME pills must stay strictly inset >=2.5px from all 4 edges
      // of their parent capsule (never overlapping or clipping the active highlight border).
      for (const [label, cap] of [
        ["bar-left", barLeft],
        ["bar-left-docked-active", barLeftDockedActive],
      ] as const) {
        const clock = treeNode(cap.tree, "bar-clock").boundsLogical!;
        const badge = treeNode(cap.tree, "bar-notifications-badge").boundsLogical!;
        expect(badge.x - clock.x, `${label} badge left clearance`).toBeGreaterThanOrEqual(2.5);
        expect((clock.x + clock.width) - (badge.x + badge.width), `${label} badge right clearance`).toBeGreaterThanOrEqual(2.5);
        expect(badge.y - clock.y, `${label} badge top clearance`).toBeGreaterThanOrEqual(2.5);
        expect((clock.y + clock.height) - (badge.y + badge.height), `${label} badge bottom clearance`).toBeGreaterThanOrEqual(2.5);

        const sys = treeNode(cap.tree, "bar-system").boundsLogical!;
        const ime = treeNode(cap.tree, "bar-ime").boundsLogical!;
        expect(ime.x - sys.x, `${label} ime left clearance`).toBeGreaterThanOrEqual(2.5);
        expect((sys.x + sys.width) - (ime.x + ime.width), `${label} ime right clearance`).toBeGreaterThanOrEqual(2.5);
      }

      // Active Docked Clock Pill tonal separation: inner badge fill differs from active clock fill.
      {
        const clockDev = treeNode(barLeftDockedActive.tree, "bar-clock").boundsDevice!;
        const badgeDev = treeNode(barLeftDockedActive.tree, "bar-notifications-badge").boundsDevice!;
        const clockFill = pixel(barLeftDockedActive.image, Math.round(clockDev.x + 4), Math.round(clockDev.y + 4));
        const badgeFill = pixel(barLeftDockedActive.image, Math.round(badgeDev.x + 2), Math.round(badgeDev.y + badgeDev.height / 2));
        expect(badgeFill, "active docked clock badge tonally separated from parent primary-container").not.toEqual(clockFill);
      }
    } finally {
      cleanup();
    }
  }, 30_000);

  previewTest("Light Mode Showcase (dark: false): light HCT palette, soft elevation shadows, light scrim, and geometry parity", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-design-light-");
    const interactiveRoles = new Set(["button", "switch", "slider", "menuItem", "menuItemCheckBox", "menuItemRadio", "tab"]);
    const lightScheme = {
      surface: "#F9F9FF",
      surface_dim: "#D9DAE0",
      surface_bright: "#F9F9FF",
      surface_container_lowest: "#FFFFFF",
      surface_container_low: "#F3F3FA",
      surface_container: "#EDEDF4",
      surface_container_high: "#E7E8EE",
      surface_container_highest: "#E1E2E9",
      on_surface: "#191C20",
      on_surface_variant: "#43474E",
      inverse_surface: "#2E3036",
      inverse_on_surface: "#F0F0F7",
      outline: "#74777F",
      outline_variant: "#C3C6CF",
      scrim: "#000000",
      primary: "#3C6090",
      on_primary: "#FFFFFF",
      primary_container: "#D4E3FF",
      on_primary_container: "#224876",
      secondary: "#545F71",
      on_secondary: "#FFFFFF",
      secondary_container: "#D8E3F8",
      on_secondary_container: "#3D4758",
      tertiary: "#6D5677",
      on_tertiary: "#FFFFFF",
      tertiary_container: "#F6D9FF",
      on_tertiary_container: "#543F5E",
      error: "#BA1A1A",
      on_error: "#FFFFFF",
      error_container: "#FFDAD6",
      on_error_container: "#93000A",
    } as const;
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const monitor = { id: "HDMI-A-1", name: "HDMI-A-1", x: 0, y: 0, width: 1280, height: 720, scale: 1 };

      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 250);
      timeline.step({ id: "ready", op: "settle" });
      timeline.step({ id: "capture-bar-light", op: "capture", surface: "bar-hdmi-a-1", captureId: "bar-light" });
      timeline.step({ id: "capture-dock-light", op: "capture", surface: "dock-hdmi-a-1", captureId: "dock-light" });

      timeline.step({ id: "open-qs", op: "pointer.click", target: { surface: "bar-hdmi-a-1", testId: "bar-audio" }, button: "primary" });
      timeline.advance("qs-settle", 450);
      timeline.step({ id: "capture-qs-light", op: "capture", surface: "panel-quick-settings", captureId: "qs-light" });

      timeline.step({ id: "open-media", op: "pointer.click", target: { surface: "bar-hdmi-a-1", testId: "bar-media" }, button: "primary" });
      timeline.advance("media-settle", 250);
      timeline.step({ id: "capture-media-light", op: "capture", surface: "panel-media", captureId: "media-light" });

      const wallpaperListAtMs = timeline.after(20);
      timeline.step({
        id: "open-settings", op: "service.emit", channel: "control.message",
        value: { args: ["settings", "appearance"], reply: { text: "{\"settingsWindowOpen\":true,\"settingsWindowTab\":\"appearance\"}" } },
      });
      timeline.advance("settings-settle", 250);
      timeline.step({ id: "capture-settings-light", op: "capture", surface: "settings-window", captureId: "settings-light" });

      timeline.step({
        id: "open-power", op: "service.emit", channel: "control.message",
        value: { args: ["power", "poweroff"], reply: { text: "{\"pendingPowerAction\":\"poweroff\"}" } },
      });
      timeline.advance("power-settle", 450);
      timeline.step({ id: "capture-power-light", op: "capture", surface: "power-dialog", captureId: "power-light" });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-light-mode-showcase",
        initialTopics: {
          theme: {
            mode: "light",
            variant: "tonal",
            dark: false,
            seed: "#1976D2",
            scheme: lightScheme,
          },
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
            },
            theme: {
              mode: "light",
              variant: "tonal",
              seed_color: "#1976D2",
              motion_scheme: "standard",
              backend: "builtin",
              gtk_linking: false,
            },
            ime: { mode: "indicator_only", candidate_layout: "auto", switch_osd: true },
            polkit: { enabled: true },
            wallpaper: { directories: [], fit: "cover", sync_theme: true, slideshow_seconds: 300 },
            pre_action_fade_seconds: 0,
            configured_plugins: [],
          },
          "wayland.outputs": {
            capability: "connected",
            outputs: [{
              output_instance_id: 1, name: "HDMI-A-1", description: "Light Showcase Display", make: "Test", model: "1280x720",
              x: 0, y: 0, width: 1280, height: 720, mode_width: 1280, mode_height: 720, refresh_mhz: 60000, scale: 1,
              physical_width_mm: null, physical_height_mm: null,
            }],
          },
          "wayland.workspaces": {
            capability: "connected",
            groups: [{ group_id: 1, output_instance_ids: [1] }],
            workspaces: [
              { workspace_id: 1, group_id: 1, name: "design", id_str: "1", coordinates: [1], active: false, urgent: false, hidden: false, capabilities: ["activate"] },
              { workspace_id: 2, group_id: 1, name: "main", id_str: "2", coordinates: [2], active: true, urgent: false, hidden: false, capabilities: ["activate"] },
              { workspace_id: 3, group_id: 1, name: "chat", id_str: "3", coordinates: [3], active: false, urgent: false, hidden: false, capabilities: ["activate"] },
            ],
          },
          "wayland.windows": {
            capability: "connected",
            windows: [
              {
                window_id: 10, app_id: "org.example.editor", title: "z-shell — Light Mode Showcase",
                activated: true, minimized: false, maximized: false, fullscreen: false, output_instance_ids: [1],
              },
              {
                window_id: 11, app_id: "org.example.browser", title: "Paper — M3 Light Components",
                activated: false, minimized: false, maximized: false, fullscreen: false, output_instance_ids: [1],
              },
            ],
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
          "desktop.notifications": {
            available: true,
            dnd: false,
            active: [],
            history: [{
              id: 1,
              app_name: "System",
              summary: "Update ready",
              body: "Concentric badge cap check",
              app_icon: "",
              icon: null,
              attachment: null,
              actions: [],
              urgency: 1,
            }],
          },
          "desktop.ime": {
            available: true,
            mode: "indicator_only",
            active_im: { unique_name: "keyboard-us", label: "English", short_label: "EN" },
            group_ims: [{ unique_name: "keyboard-us", label: "English", short_label: "EN" }],
            properties: [],
          },
          "desktop.media": {
            available: true,
            selected_player_id: "spotify",
            any_playing: true,
            cover: null,
            players: [{
              id: "spotify",
              identity: "Spotify",
              playback_status: "playing",
              position_us: 60_000_000,
              capabilities: { can_play: true, can_pause: true, can_go_next: true, can_go_previous: true, can_seek: true },
              metadata: {
                title: "Daylight Study",
                artists: ["z-shell"],
                album: "Light Mode Showcase",
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
          "system.power": {
            available: true,
            on_ac: false,
            battery: {
              percentage: 82,
              state: "discharging",
              time_to_empty_seconds: 19320,
              time_to_full_seconds: null,
              energy_rate_watts: 11.4,
              capacity_percent: 96,
              charge_cycles: 142,
            },
            profiles: { available: true, active_profile: "balanced", profiles: ["performance", "balanced", "power-saver"] },
          },
          "system.brightness": {
            available: true,
            devices: [{ id: "intel_backlight", name: "intel_backlight", current: 76, max: 100, percentage: 76 }],
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
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-light-mode-showcase",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(published.dist, fixture, scenario, out);
      expectCleanPreview(result, 6, 0);
      const barLight = readCapture(out, "bar-hdmi-a-1", "bar-light");
      const dockLight = readCapture(out, "dock-hdmi-a-1", "dock-light");
      const qsLight = readCapture(out, "panel-quick-settings", "qs-light");
      const mediaLight = readCapture(out, "panel-media", "media-light");
      const settingsLight = readCapture(out, "settings-window", "settings-light");
      const powerLight = readCapture(out, "power-dialog", "power-light");

      // Light Mode surface pixels must be genuinely high-luminance (matching #EDEDF4 / #F9F9FF).
      const qsLightCard = treeNode(qsLight.tree, "panel-root-quick-settings").boundsDevice!;
      const qsBg = pixel(qsLight.image, Math.round(qsLightCard.x + 12), Math.round(qsLightCard.y + 12));
      expect(qsBg[0]! + qsBg[1]! + qsBg[2]!, "qs-light surface-container bright RGB").toBeGreaterThan(680);
      const settingsCorner = pixel(settingsLight.image, 0, 0);
      expect(settingsCorner[3], "settings-light opaque toplevel").toBe(255);
      expect(settingsCorner[0]! + settingsCorner[1]! + settingsCorner[2]!, "settings-light sidebar bright RGB").toBeGreaterThan(700);

      // Light Mode scrim stays airy (<= 28% alpha, ~71/255) rather than heavy dark 55% (~140/255).
      const lightScrim = pixel(powerLight.image, 4, 4);
      expect(lightScrim[3], "power-light airy scrim alpha <= 76").toBeLessThanOrEqual(76);
      expect(lightScrim[3], "power-light scrim visible > 40").toBeGreaterThan(40);

      // Soft light shadows still bleed cleanly to zero at LayerSurface edges; popovers keep transparent corners.
      expect(maxRowAlpha(barLight.image, 0), "bar-light top edge shadow clipping").toBeLessThanOrEqual(8);
      expect(maxRowAlpha(dockLight.image, 0), "dock-light top edge shadow clipping").toBeLessThanOrEqual(8);
      expect(pixel(qsLight.image, 0, 0), "qs-light corner transparent").toEqual([0, 0, 0, 0]);
      expect(pixel(mediaLight.image, 0, 0), "media-light corner transparent").toEqual([0, 0, 0, 0]);

      // Concentric Dock (R=22px) in Light Mode + Asymmetric Optical Cap Padding on Floating Bar capsules:
      // Clock right cap holds 24px (R=12px) notification badge -> p_right == p_vertical == 4px while left text keeps >=10px.
      // System left cap holds 24px (R=12px) IME pill -> p_left == p_vertical == 4px.
      {
        const dockLightCapsule = treeNode(dockLight.tree, "dock-root-HDMI-A-1").boundsDevice!;
        expect(
          pixel(dockLight.image, Math.round(dockLightCapsule.x + 8), Math.round(dockLightCapsule.y + 8))[3],
          "dock-light concentric R=22px corner filled at (8,8)",
        ).toBeGreaterThanOrEqual(200);

        const clockBounds = treeNode(barLight.tree, "bar-clock").boundsLogical!;
        const clockText = treeNode(barLight.tree, "bar-clock-text").boundsLogical!;
        const badgeBounds = treeNode(barLight.tree, "bar-notifications-badge").boundsLogical!;
        const badgeVerticalInset = badgeBounds.y - clockBounds.y;
        const badgeRightInset = (clockBounds.x + clockBounds.width) - (badgeBounds.x + badgeBounds.width);
        const clockLeftInset = clockText.x - clockBounds.x;
        expect(Math.abs(badgeRightInset - badgeVerticalInset), "bar-clock asymmetric right cap inset == vertical inset").toBeLessThanOrEqual(1.5);
        expect(clockLeftInset, "bar-clock text left padding >= 10px").toBeGreaterThanOrEqual(10);

        const systemBounds = treeNode(barLight.tree, "bar-system").boundsLogical!;
        const imeBounds = treeNode(barLight.tree, "bar-ime").boundsLogical!;
        const imeVerticalInset = imeBounds.y - systemBounds.y;
        const imeLeftInset = imeBounds.x - systemBounds.x;
        expect(Math.abs(imeLeftInset - imeVerticalInset), "bar-system asymmetric left IME cap inset == vertical inset").toBeLessThanOrEqual(1.5);
      }

      for (const [label, tree] of [
        ["bar-light", barLight.tree],
        ["dock-light", dockLight.tree],
        ["qs-light", qsLight.tree],
        ["media-light", mediaLight.tree],
        ["settings-light", settingsLight.tree],
        ["power-light", powerLight.tree],
      ] as const) {
        const controls = tree.nodes.filter(node => node.role && interactiveRoles.has(node.role) && node.boundsLogical);
        expect(controls.length, label).toBeGreaterThan(0);
        for (const node of controls) {
          expect(node.boundsLogical!.width, `${label} ${node.testId ?? node.role} width`).toBeGreaterThanOrEqual(24);
          expect(node.boundsLogical!.height, `${label} ${node.testId ?? node.role} height`).toBeGreaterThanOrEqual(24);
        }
      }
    } finally {
      cleanup();
    }
  }, 30_000);

  previewTest("L4 Chaos & Edge Fixtures: 17+ notifications scroll isolation, empty-label default action, vertical concentric circles (17 + 中), and Ethernet+Wi-Fi neutral state", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-design-chaos-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const monitor = { id: "DP-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900, scale: 1 };

      const history = Array.from({ length: 17 }, (_, index) => ({
        id: index + 1,
        app_name: index === 0 ? "Ghostty" : index % 2 === 0 ? "Screenshot" : "System",
        summary: index === 0 ? "Antigravity CLI is ready" : `Notification item #${index + 1}`,
        body: index === 0 ? "Click card to focus terminal" : `Body text for chaos item ${index + 1}`,
        app_icon: "",
        icon: null,
        attachment: null,
        actions: index === 0
          ? [{ key: "default", label: "" }]
          : index === 1
            ? [{ key: "open", label: "Open" }, { key: "copy", label: "Copy" }]
            : [],
        urgency: 1,
      }));

      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 250);
      timeline.step({ id: "ready", op: "settle" });
      timeline.step({ id: "capture-bar-chaos", op: "capture", surface: "bar-dp-1", captureId: "bar-chaos" });
      timeline.step({ id: "open-cal-chaos", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("cal-chaos-settle", 450);
      timeline.step({ id: "capture-cal-chaos", op: "capture", surface: "panel-calendar", captureId: "cal-chaos" });
      timeline.step({ id: "open-qs-chaos", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-network" }, button: "primary" });
      timeline.advance("qs-chaos-settle", 450);
      timeline.step({ id: "capture-qs-chaos", op: "capture", surface: "panel-quick-settings", captureId: "qs-chaos" });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-chaos-edge-fixtures",
        initialTopics: {
          "desktop.notifications": {
            available: true,
            dnd: false,
            active: [],
            history,
          },
          "desktop.ime": {
            available: true,
            mode: "indicator_only",
            active_im: { unique_name: "rime", label: "Rime", short_label: "中" },
            group_ims: [{ unique_name: "rime", label: "Rime", short_label: "中" }],
            properties: [],
          },
          "system.network": {
            available: true,
            connectivity: "full",
            ethernet: [{ id: "eth0", interface: "enp4s0", state: "activated", carrier: true, active_connection: "Wired" }],
            wifi: {
              enabled: true,
              hardware_enabled: true,
              scanning: false,
              devices: [{ id: "wlan0", interface: "wlan0", active_ap_id: null, active_connection: null, access_points: [] }],
              profiles: [],
            },
          },
          settings: {
            general: { offline_mode: false, log_level: "info" },
            bar: {
              position: "left",
              style: "floating",
              gaps: 14,
              edge_overrides: { top: null, right: null, bottom: null, left: null },
              launcher_enabled: true,
              dock_enabled: false,
              clock_24h: true,
              clock_seconds: false,
            },
            theme: {
              mode: "dark",
              variant: "tonal",
              seed_color: null,
              motion_scheme: "standard",
              backend: "builtin",
              gtk_linking: false,
            },
            ime: { mode: "indicator_only", candidate_layout: "auto", switch_osd: true },
            polkit: { enabled: true },
            wallpaper: { directories: [], fit: "cover", sync_theme: true, slideshow_seconds: 300 },
            pre_action_fade_seconds: 0,
            configured_plugins: [],
          },
        },
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-chaos-edge-fixtures",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(published.dist, fixture, scenario, out);
      expectCleanPreview(result, 3, 0);
      const barChaos = readCapture(out, "bar-dp-1", "bar-chaos");
      const calChaos = readCapture(out, "panel-calendar", "cal-chaos");
      const qsChaos = readCapture(out, "panel-quick-settings", "qs-chaos");

      // 1. Vertical Bar 2-digit badge ("17") is a 28x28 concentric circle and Chinese IME ("中") is a 30x30 concentric circle.
      const badge = treeNode(barChaos.tree, "bar-notifications-badge").boundsLogical!;
      expect(Math.round(badge.width), "vertical 2-digit badge width == 28").toBe(28);
      expect(Math.round(badge.height), "vertical 2-digit badge height == 28").toBe(28);
      const ime = treeNode(barChaos.tree, "bar-ime").boundsLogical!;
      expect(Math.round(ime.width), "vertical CJK IME width == 30").toBe(30);
      expect(Math.round(ime.height), "vertical CJK IME height == 30").toBe(30);

      // 2. Calendar 17+ notifications: Clock & Calendar header stay fixed outside <scroll>, list scrolls independently inside panel padding.
      const calRoot = treeNode(calChaos.tree, "panel-calendar").boundsLogical!;
      const calClock = treeNode(calChaos.tree, "cal-clock-hm").boundsLogical!;
      const calMonth = treeNode(calChaos.tree, "cal-month-title").boundsLogical!;
      const calList = treeNode(calChaos.tree, "cal-notif-scroll");
      const calListBounds = calList.boundsLogical!;
      expect(calListBounds.y, "notifications scroll starts below fixed clock+calendar header").toBeGreaterThan(calMonth.y + calMonth.height);
      expect(calClock.y, "clock remains anchored at top above scroll list").toBeLessThan(calListBounds.y);
      expect(calListBounds.x - calRoot.x, "scroll container inset from left rounded edge").toBeGreaterThanOrEqual(12);
      expect((calRoot.x + calRoot.width) - (calListBounds.x + calListBounds.width), "scroll container inset from right rounded edge").toBeGreaterThanOrEqual(12);
      if (calList.scrollMetrics) {
        expect(calList.scrollMetrics.overflowY, "17 notifications overflow inside isolated list scroll").toBe(true);
      }

      // 3. Empty-label "default" action (Ghostty) renders NO blank pill button, while binding default card click button.
      expect(calChaos.tree.nodes.some(node => node.testId === "cal-notif-action-1-default"), "no blank default pill button").toBe(false);
      expect(treeNode(calChaos.tree, "cal-notif-default-1").boundsLogical, "default action bound to card body").toBeDefined();
      expect(treeNode(calChaos.tree, "cal-notif-action-2-open").boundsLogical, "labelled action buttons preserved").toBeDefined();

      // 4. Control Center opened via vertical bar-network: Wi-Fi enabled+disconnected while Ethernet online stays neutral
      //    visually (surface-container-high, never active primary-container), while keeping enabled standby copy.
      const wifiTile = treeNode(qsChaos.tree, "qs-tile-wifi");
      expect(wifiTile.state?.enabled, "enabled-but-disconnected Wi-Fi remains interactive").toBe(true);
      expect(wifiTile.text, "Wi-Fi standby copy reflects enabled radio while Ethernet is active").toContain("Ethernet · Standby");
      const wifiFill = pixel(qsChaos.image, Math.round(wifiTile.boundsDevice!.x + 6), Math.round(wifiTile.boundsDevice!.y + 6));
      expect(wifiFill, "disconnected Wi-Fi tile stays neutral surface-container-high (not active primary-container)").toEqual([0x27, 0x2a, 0x2f, 255]);
      expect(treeNode(qsChaos.tree, "qs-avatar-fallback").boundsLogical).toBeDefined();
    } finally {
      cleanup();
    }
  }, 30_000);

  previewTest("L4 Interactive Invariants, In-Flight Motion Keyframes & 16:9 Screenshot Toast Icon", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-design-interactive-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const monitor = { id: "DP-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900, scale: 1 };
      const screenshot16x9 = makeSolidPngBytes(64, 36, 0x22, 0xd3, 0xee);

      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });

      // --- 1. In-flight workspace sliding capsule (ws-1 -> ws-3) ---
      timeline.step({ id: "capture-bar-ws-t0", op: "capture", surface: "bar-dp-1", captureId: "bar-ws-t0" });
      const wsSwitchAtMs = timeline.after(10);
      timeline.advance("ws-switch-deliver", 10);
      timeline.advance("ws-mid-flight", 60);
      timeline.step({ id: "capture-bar-ws-t60", op: "capture", surface: "bar-dp-1", captureId: "bar-ws-t60" });
      timeline.advance("ws-settle", 400);
      timeline.step({ id: "capture-bar-ws-t450", op: "capture", surface: "bar-dp-1", captureId: "bar-ws-t450" });

      // --- 2. Unseekable MediaPanel (progressIndicator zero-diff + disabled zero-diff + Play/Pause hover feedback) ---
      timeline.step({ id: "open-media", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-media" }, button: "primary" });
      timeline.advance("media-settle", 350);
      timeline.step({ id: "capture-media-rest", op: "capture", surface: "panel-media", captureId: "media-unseekable-rest" });
      timeline.step({ id: "hover-unseekable-progress", op: "pointer.move", target: { surface: "panel-media", testId: "media-progress" } });
      timeline.advance("media-progress-hover-settle", 150);
      timeline.step({ id: "capture-media-progress-hover", op: "capture", surface: "panel-media", captureId: "media-unseekable-hover" });
      timeline.step({ id: "hover-disabled-seek", op: "pointer.move", surface: "panel-media", position: { x: 55, y: 244 } });
      timeline.advance("media-disabled-hover-settle", 150);
      timeline.step({ id: "capture-media-disabled-hover", op: "capture", surface: "panel-media", captureId: "media-disabled-hover" });
      timeline.step({ id: "hover-play-pause", op: "pointer.move", target: { surface: "panel-media", testId: "media-play-pause" } });
      timeline.advance("media-play-hover-settle", 150);
      timeline.step({ id: "capture-media-play-hover", op: "capture", surface: "panel-media", captureId: "media-play-hover" });

      // --- 3. QuickSettings tile + seekable slider hover ---
      timeline.step({ id: "open-qs", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-audio" }, button: "primary" });
      timeline.advance("qs-settle", 450);
      timeline.step({ id: "capture-qs-rest", op: "capture", surface: "panel-quick-settings", captureId: "qs-rest" });
      timeline.step({ id: "hover-qs-tile", op: "pointer.move", target: { surface: "panel-quick-settings", testId: "qs-tile-caffeine" } });
      timeline.advance("qs-tile-hover-settle", 150);
      timeline.step({ id: "capture-qs-tile-hover", op: "capture", surface: "panel-quick-settings", captureId: "qs-tile-hover" });
      timeline.step({ id: "hover-qs-slider", op: "pointer.move", target: { surface: "panel-quick-settings", role: "slider", name: "Volume" } });
      timeline.advance("qs-slider-hover-settle", 150);
      timeline.step({ id: "capture-qs-slider-hover", op: "capture", surface: "panel-quick-settings", captureId: "qs-slider-hover" });

      // --- 4. IdlePane rule row hover (anti-sharp-box + zero hit-target shift across rest/hover/pressed) + M3SegmentedControl mid-flight ---
      timeline.step({
        id: "open-settings-idle", op: "service.emit", channel: "control.message",
        value: { args: ["settings", "idle"], reply: { text: "{\"settingsWindowOpen\":true,\"settingsWindowTab\":\"idle\"}" } },
      });
      timeline.advance("idle-open-settle", 350);
      timeline.step({ id: "capture-idle-rest", op: "capture", surface: "settings-window", captureId: "idle-rest" });
      timeline.step({ id: "hover-idle-rule", op: "pointer.move", target: { surface: "settings-window", testId: "settings-idle-rule-dpms" } });
      timeline.advance("idle-hover-settle", 150);
      timeline.step({ id: "capture-idle-hover", op: "capture", surface: "settings-window", captureId: "idle-rule-hover" });
      timeline.step({ id: "press-idle-rule", op: "pointer.down", target: { surface: "settings-window", testId: "settings-idle-rule-dpms" }, button: "primary" });
      timeline.advance("idle-press-settle", 80);
      timeline.step({ id: "capture-idle-pressed", op: "capture", surface: "settings-window", captureId: "idle-rule-pressed" });
      timeline.step({ id: "release-idle-rule", op: "pointer.up", target: { surface: "settings-window", testId: "settings-idle-rule-dpms" }, button: "primary" });
      timeline.advance("idle-select-settle", 250);

      // Segmented control mid-flight spring check: switch lock/screen_off -> suspend.
      timeline.step({ id: "capture-idle-seg-t0", op: "capture", surface: "settings-window", captureId: "idle-seg-t0" });
      timeline.step({ id: "click-idle-action-suspend", op: "pointer.click", target: { surface: "settings-window", testId: "settings-idle-action-suspend" }, button: "primary" });
      timeline.advance("idle-seg-mid", 55);
      timeline.step({ id: "capture-idle-seg-t55", op: "capture", surface: "settings-window", captureId: "idle-seg-t55" });
      timeline.advance("idle-seg-settle", 360);
      timeline.step({ id: "capture-idle-seg-t400", op: "capture", surface: "settings-window", captureId: "idle-seg-t400" });
      timeline.step({ id: "click-idle-action-command", op: "pointer.click", target: { surface: "settings-window", testId: "settings-idle-action-custom_command" }, button: "primary" });
      timeline.advance("idle-command-settle", 250);
      timeline.step({ id: "capture-idle-command-editor", op: "capture", surface: "settings-window", captureId: "idle-command-editor" });
      timeline.step({
        id: "close-settings-idle", op: "service.emit", channel: "control.message",
        value: { args: ["settings", "close"], reply: { text: "{\"settingsWindowOpen\":false}" } },
      });
      timeline.advance("idle-settings-close-settle", 100);

      // --- 5. Launcher search filter layout stability ---
      const launcherInitialAtMs = timeline.after(15);
      timeline.step({
        id: "open-launcher", op: "service.emit", channel: "control.message",
        value: { args: ["panel", "launcher"], reply: { text: "{\"activePanel\":\"launcher\"}" } },
      });
      timeline.advance("launcher-open-settle", 350);
      timeline.step({ id: "capture-launcher-before", op: "capture", surface: "launcher-overlay", captureId: "launcher-before-filter" });
      const launcherFilterAtMs = timeline.after(15);
      timeline.step({ id: "filter-launcher-text", op: "text.commit", surface: "launcher-overlay", text: "bro" });
      timeline.advance("launcher-filter-settle", 200);
      timeline.step({ id: "capture-launcher-after", op: "capture", surface: "launcher-overlay", captureId: "launcher-after-filter" });
      timeline.step({ id: "close-launcher", op: "key.press", surface: "launcher-overlay", key: "Escape" });
      timeline.advance("launcher-close-settle", 250);

      // --- 6. 16:9 Screenshot Notification Toast Icon (object-fit: cover + rounded corner clip) ---
      const toastPushAtMs = timeline.after(10);
      const toastBlobAtMs = timeline.after(30);
      timeline.advance("toast-deliver-and-settle", 380);
      timeline.step({ id: "capture-toast-16x9", op: "capture", surface: "notification-toasts", captureId: "toast-16x9" });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-interactive-invariants",
        initialTopics: {
          "wayland.outputs": {
            capability: "connected",
            outputs: [{
              output_instance_id: 1, name: "DP-1", description: "Interactive Test Monitor", make: "Test", model: "1440x900",
              x: 0, y: 0, width: 1440, height: 900, mode_width: 1440, mode_height: 900, refresh_mhz: 60000, scale: 1,
              physical_width_mm: null, physical_height_mm: null,
            }],
          },
          "wayland.workspaces": {
            capability: "connected",
            groups: [{ group_id: 1, output_instance_ids: [1] }],
            workspaces: [
              { workspace_id: 1, group_id: 1, name: "1", id_str: "1", coordinates: [1], active: true, urgent: false, hidden: false, capabilities: ["activate"] },
              { workspace_id: 2, group_id: 1, name: "2", id_str: "2", coordinates: [2], active: false, urgent: false, hidden: false, capabilities: ["activate"] },
              { workspace_id: 3, group_id: 1, name: "3", id_str: "3", coordinates: [3], active: false, urgent: false, hidden: false, capabilities: ["activate"] },
            ],
          },
          "desktop.media": {
            available: true,
            selected_player_id: "jellypilot",
            any_playing: false,
            cover: null,
            players: [{
              id: "jellypilot", identity: "JellyPilot", playback_status: "paused", position_us: 60_000_000,
              capabilities: { can_play: true, can_pause: true, can_go_next: true, can_go_previous: true, can_seek: false },
              metadata: {
                title: "Unseekable Stream",
                artists: ["Live Radio"],
                album: "Broadcast",
                length_us: 180_000_000,
              },
            }],
          },
          "system.audio": {
            available: true,
            default_sink: "speakers",
            default_source: null,
            sinks: [{ index: 1, name: "speakers", description: "Speakers", volume: 0.65, muted: false, channels: 2 }],
            sources: [],
            sink_inputs: [],
          },
          "session.idle": {
            available: true,
            caffeine: false,
            service_status: { status: "running" },
            rules: [
              { name: "lock", enabled: true, timeout_seconds: 300, locked_timeout_seconds: null, action: "lock", resume_command: null, pre_action_fade_seconds: 2 },
              { name: "dpms", enabled: true, timeout_seconds: 600, locked_timeout_seconds: 30, action: "screen_off", resume_command: null, pre_action_fade_seconds: 0 },
            ],
            active_inhibitors: [],
          },
          settings: {
            general: { offline_mode: false, log_level: "info" },
            bar: {
              position: "top",
              style: "floating",
              gaps: 12,
              edge_overrides: { top: null, right: null, bottom: null, left: null },
              launcher_enabled: true,
              dock_enabled: false,
              clock_24h: true,
              clock_seconds: false,
            },
            theme: {
              mode: "dark",
              variant: "tonal",
              seed_color: null,
              motion_scheme: "standard",
              backend: "builtin",
              gtk_linking: false,
            },
            ime: { mode: "indicator_only", candidate_layout: "auto", switch_osd: true },
            polkit: { enabled: true },
            wallpaper: { directories: [], fit: "cover", sync_theme: true, slideshow_seconds: 300 },
            pre_action_fade_seconds: 0,
            configured_plugins: [],
          },
        },
        topicUpdates: [
          {
            atMs: wsSwitchAtMs,
            topic: "wayland.workspaces",
            revision: 2,
            data: {
              capability: "connected",
              groups: [{ group_id: 1, output_instance_ids: [1] }],
              workspaces: [
                { workspace_id: 1, group_id: 1, name: "1", id_str: "1", coordinates: [1], active: false, urgent: false, hidden: false, capabilities: ["activate"] },
                { workspace_id: 2, group_id: 1, name: "2", id_str: "2", coordinates: [2], active: false, urgent: false, hidden: false, capabilities: ["activate"] },
                { workspace_id: 3, group_id: 1, name: "3", id_str: "3", coordinates: [3], active: true, urgent: false, hidden: false, capabilities: ["activate"] },
              ],
            },
          },
          {
            atMs: toastPushAtMs,
            topic: "desktop.notifications",
            revision: 2,
            data: {
              available: true,
              dnd: false,
              popups: [{
                id: 101,
                revision: 1,
                app_name: "Screenshot",
                summary: "16:9 area captured",
                body: "Saved to ~/Pictures/shot.png",
                icon: { kind: "blob_handle", token: "toast-screenshot-16x9", mime: "image/png", byte_len: screenshot16x9.length },
                attachment: null,
                actions: [{ key: "open", label: "Open" }],
                urgency: 1,
              }],
              history: [{
                id: 101,
                revision: 1,
                app_name: "Screenshot",
                summary: "16:9 area captured",
                body: "Saved to ~/Pictures/shot.png",
                icon: { kind: "blob_handle", token: "toast-screenshot-16x9", mime: "image/png", byte_len: screenshot16x9.length },
                attachment: null,
                actions: [{ key: "open", label: "Open" }],
                urgency: 1,
              }],
            },
          },
        ],
        commands: [
          {
            id: 26,
            name: "launcher.query",
            payload: { query: "", query_id: 1, limit: 18 },
            atMs: launcherInitialAtMs,
            result: {
              data: {
                query_id: 1,
                items: [
                  { provider_id: "desktop", item_id: "editor", title: "Editor", subtitle: "Code", icon: null },
                  { provider_id: "desktop", item_id: "browser", title: "Browser", subtitle: "Web", icon: null },
                ],
              },
            },
          },
          {
            id: 27,
            name: "launcher.query",
            payload: { query: "bro", query_id: 2, limit: 18 },
            atMs: launcherFilterAtMs,
            result: {
              data: {
                query_id: 2,
                items: [
                  { provider_id: "desktop", item_id: "browser", title: "Browser", subtitle: "Web", icon: null },
                ],
              },
            },
          },
          {
            socket: "host",
            id: 3,
            name: "notifications.fetch-blob",
            payload: { token: "toast-screenshot-16x9" },
            atMs: toastBlobAtMs,
            result: { data: { bytes: screenshot16x9 } },
          },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-interactive-invariants",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(published.dist, fixture, scenario, out);
      expectCleanPreview(result, 20, 0);

      const assertAntiSharpBoxCorners = (
        beforeImg: ReturnType<typeof readCapture>["image"],
        afterImg: ReturnType<typeof readCapture>["image"],
        bounds: DeviceBounds,
        label: string,
      ) => {
        const x0 = Math.floor(bounds.x);
        const y0 = Math.floor(bounds.y);
        const x1 = Math.ceil(bounds.x + bounds.width) - 1;
        const y1 = Math.ceil(bounds.y + bounds.height) - 1;
        for (const [cornerName, cx, cy] of [
          ["top-left", x0, y0],
          ["top-right", x1, y0],
          ["bottom-left", x0, y1],
          ["bottom-right", x1, y1],
        ] as const) {
          expect(
            pixelChannelDiff(pixel(beforeImg, cx, cy), pixel(afterImg, cx, cy)),
            `${label} anti-sharp-box ${cornerName} (${cx},${cy})`,
          ).toBe(0);
        }
      };

      // --- Verify 1: Workspace sliding capsule mid-flight keyframe ---
      const barWsT0 = readCapture(out, "bar-dp-1", "bar-ws-t0");
      const barWsT60 = readCapture(out, "bar-dp-1", "bar-ws-t60");
      const barWsT450 = readCapture(out, "bar-dp-1", "bar-ws-t450");
      const wsTrackBounds = treeNode(barWsT0.tree, "bar-workspaces").boundsDevice!;
      expect(diffRegionPixels(barWsT0.image, barWsT60.image, wsTrackBounds), "workspace spring moved by t=60ms").toBeGreaterThan(20);
      expect(diffRegionPixels(barWsT60.image, barWsT450.image, wsTrackBounds), "workspace spring still moving between t=60ms and t=450ms").toBeGreaterThan(20);
      const ws3Settled = treeNode(barWsT450.tree, "ws-3").boundsDevice!;
      expect(
        pixel(barWsT450.image, Math.round(ws3Settled.x + 4), Math.round(ws3Settled.y + ws3Settled.height / 2)),
        "ws-3 settled under primary sliding capsule",
      ).toEqual([0x7c, 0xd4, 0xff, 255]);

      // --- Verify 2: Invariant A (Non-interactive progressIndicator & disabled button -> zero pixel diff) ---
      const mediaRest = readCapture(out, "panel-media", "media-unseekable-rest");
      const mediaProgressHover = readCapture(out, "panel-media", "media-unseekable-hover");
      const mediaDisabledHover = readCapture(out, "panel-media", "media-disabled-hover");
      const mediaPlayHover = readCapture(out, "panel-media", "media-play-hover");
      const progressBounds = treeNode(mediaRest.tree, "media-progress").boundsDevice!;
      expect(
        diffRegionPixels(mediaRest.image, mediaProgressHover.image, progressBounds),
        "Invariant A: non-scrubbable progressIndicator hover produces 0 changed pixels",
      ).toBe(0);
      const disabledSeekBounds = treeNode(mediaRest.tree, "media-seek-back").boundsDevice!;
      expect(
        diffRegionPixels(mediaProgressHover.image, mediaDisabledHover.image, disabledSeekBounds),
        "Invariant A: :disabled button hover produces 0 changed pixels",
      ).toBe(0);

      // Invariants B, C, D on Media Play/Pause button.
      const playRestNode = treeNode(mediaRest.tree, "media-play-pause");
      const playHoverNode = treeNode(mediaPlayHover.tree, "media-play-pause");
      expect(diffRegionPixels(mediaDisabledHover.image, mediaPlayHover.image, playRestNode.boundsDevice!), "Invariant B: media-play-pause hover feedback").toBeGreaterThan(20);
      assertAntiSharpBoxCorners(mediaDisabledHover.image, mediaPlayHover.image, playRestNode.boundsDevice!, "media-play-pause");
      assertSameBounds(playRestNode.boundsLogical!, playHoverNode.boundsLogical!, "media-play-pause rest vs hover");

      // --- Verify 3: QuickSettings tile + slider hover invariants ---
      const qsRest = readCapture(out, "panel-quick-settings", "qs-rest");
      const qsTileHover = readCapture(out, "panel-quick-settings", "qs-tile-hover");
      const qsSliderHover = readCapture(out, "panel-quick-settings", "qs-slider-hover");
      const qsTileRestNode = treeNode(qsRest.tree, "qs-tile-caffeine");
      const qsTileHoverNode = treeNode(qsTileHover.tree, "qs-tile-caffeine");
      expect(diffRegionPixels(qsRest.image, qsTileHover.image, qsTileRestNode.boundsDevice!), "Invariant B: qs-tile-caffeine hover feedback").toBeGreaterThan(20);
      assertAntiSharpBoxCorners(qsRest.image, qsTileHover.image, qsTileRestNode.boundsDevice!, "qs-tile-caffeine");
      assertSameBounds(qsTileRestNode.boundsLogical!, qsTileHoverNode.boundsLogical!, "qs-tile-caffeine rest vs hover");
      const volSliderRest = qsRest.tree.nodes.find(node => node.role === "slider" && node.boundsDevice);
      const volSliderHover = qsSliderHover.tree.nodes.find(node => node.role === "slider" && node.boundsDevice);
      expect(volSliderRest, "Volume slider present").toBeDefined();
      expect(diffRegionPixels(qsTileHover.image, qsSliderHover.image, volSliderRest!.boundsDevice!), "Invariant B: seekable slider thumb hover feedback").toBeGreaterThan(0);
      assertSameBounds(volSliderRest!.boundsLogical!, volSliderHover!.boundsLogical!, "Volume slider rest vs hover");

      // --- Verify 4: IdlePane rule row hover (B: diff > 0, C: anti-sharp-box corners == 0, D: rest/hover/pressed zero shift) ---
      const idleRest = readCapture(out, "settings-window", "idle-rest");
      const idleHover = readCapture(out, "settings-window", "idle-rule-hover");
      const idlePressed = readCapture(out, "settings-window", "idle-rule-pressed");
      const ruleRestNode = treeNode(idleRest.tree, "settings-idle-rule-dpms");
      const ruleHoverNode = treeNode(idleHover.tree, "settings-idle-rule-dpms");
      const rulePressedNode = treeNode(idlePressed.tree, "settings-idle-rule-dpms");
      expect(diffRegionPixels(idleRest.image, idleHover.image, ruleRestNode.boundsDevice!), "Invariant B: Idle rule row hover feedback").toBeGreaterThan(50);
      assertAntiSharpBoxCorners(idleRest.image, idleHover.image, ruleRestNode.boundsDevice!, "settings-idle-rule-dpms");
      assertSameBounds(ruleRestNode.boundsLogical!, ruleHoverNode.boundsLogical!, "settings-idle-rule-dpms rest vs hover");
      assertSameBounds(ruleRestNode.boundsLogical!, rulePressedNode.boundsLogical!, "settings-idle-rule-dpms rest vs pressed");

      // --- Verify 5: IdlePane M3SegmentedControl mid-flight spring keyframe ---
      const idleSegT0 = readCapture(out, "settings-window", "idle-seg-t0");
      const idleSegT55 = readCapture(out, "settings-window", "idle-seg-t55");
      const idleSegT400 = readCapture(out, "settings-window", "idle-seg-t400");
      const segLeft = treeNode(idleSegT0.tree, "settings-idle-action-lock").boundsDevice!;
      const segRight = treeNode(idleSegT0.tree, "settings-idle-action-custom_command").boundsDevice!;
      const segTrackBounds: DeviceBounds = {
        x: segLeft.x,
        y: segLeft.y,
        width: (segRight.x + segRight.width) - segLeft.x,
        height: segLeft.height,
      };
      expect(diffRegionPixels(idleSegT0.image, idleSegT55.image, segTrackBounds), "M3SegmentedControl spring moved by t=55ms").toBeGreaterThan(20);
      expect(diffRegionPixels(idleSegT55.image, idleSegT400.image, segTrackBounds), "M3SegmentedControl spring still moving between t=55ms and t=400ms").toBeGreaterThan(20);
      const idleCommandEditor = readCapture(out, "settings-window", "idle-command-editor");
      expect(
        treeNode(idleCommandEditor.tree, "settings-idle-custom-command").boundsLogical,
        "24 · Idle Command mode mounts Action command TextField",
      ).toBeDefined();

      // --- Verify 6: Launcher search filter stability ---
      const launcherBefore = readCapture(out, "launcher-overlay", "launcher-before-filter");
      const launcherAfter = readCapture(out, "launcher-overlay", "launcher-after-filter");
      assertSameBounds(
        treeNode(launcherBefore.tree, "launcher-card").boundsLogical!,
        treeNode(launcherAfter.tree, "launcher-card").boundsLogical!,
        "launcher-card geometry stable across search filter",
      );

      // --- Verify 7: 16:9 Screenshot Toast Icon (object-fit: cover + rounded corner clipping) ---
      const toast16x9 = readCapture(out, "notification-toasts", "toast-16x9");
      const iconBox = treeNode(toast16x9.tree, "toast-icon-101").boundsDevice!;
      const midX = Math.round(iconBox.x + iconBox.width / 2);
      const topMid = pixel(toast16x9.image, midX, Math.round(iconBox.y + 3));
      const bottomMid = pixel(toast16x9.image, midX, Math.round(iconBox.y + iconBox.height - 4));
      expect(topMid[2], "16:9 toast icon top-mid filled by cover image (no letterbox bar)").toBeGreaterThan(180);
      expect(bottomMid[2], "16:9 toast icon bottom-mid filled by cover image (no letterbox bar)").toBeGreaterThan(180);
      for (const [cornerName, cx, cy] of [
        ["top-left", Math.floor(iconBox.x), Math.floor(iconBox.y)],
        ["top-right", Math.ceil(iconBox.x + iconBox.width) - 1, Math.floor(iconBox.y)],
        ["bottom-left", Math.floor(iconBox.x), Math.ceil(iconBox.y + iconBox.height) - 1],
        ["bottom-right", Math.ceil(iconBox.x + iconBox.width) - 1, Math.ceil(iconBox.y + iconBox.height) - 1],
      ] as const) {
        const cornerPx = pixel(toast16x9.image, cx, cy);
        expect(cornerPx[2], `16:9 toast icon ${cornerName} rounded-clipped (not pure cyan)`).toBeLessThan(150);
      }
      assertRoundedBlurStrips(
        toast16x9.frame.blurRegion,
        treeNode(toast16x9.tree, "toast-card-101").boundsLogical!,
        22,
        "notification toast blurRegion",
      );
    } finally {
      cleanup();
    }
  }, 30_000);

  previewTest("L4 New Interactive States: 22A Wallpaper Library, 14B Media Sink & Idle, 09E Bar Popups, 13B/18B Empty States", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-design-new-states-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const monitor = { id: "DP-1", name: "DP-1", x: 0, y: 0, width: 1280, height: 720, scale: 1 };
      const catalogNames = [
        "glacier-studio.png", "alpine-fog.png", "desert-noon.png", "pine-moon.png",
        "dusk-horizon.png", "canyon-sun.png", "fjord-wave.png", "minimal-tower.jpg",
        "slate-ridge.png", "aurora-north.png", "terracotta.jpg", "indigo-mist.png",
      ];
      const catalogItems = catalogNames.map((file, idx) => ({
        id: `wp-${idx + 1}`,
        name: file,
        source_path: `/home/hewel/Pictures/Wallpapers/${file}`,
        width: 2560,
        height: 1440,
        thumbnail: null,
      }));
      const discordAvatarBytes = makeSolidPngBytes(128, 128, 0x3b, 0x6b, 0x63);
      const discordIconBytes = makeSolidPngBytes(48, 48, 0x58, 0x65, 0xf2);
      const niriShotBytes = makeSolidPngBytes(320, 180, 0x74, 0xc0, 0xfc);
      const ghosttyIconBytes = makeSolidPngBytes(48, 48, 0x2b, 0x36, 0x54);
      const discordIconRef = {
        kind: "blob_handle",
        token: "notif-12b-discord-icon",
        mime: "image/png",
        byte_len: discordIconBytes.length,
      };
      const discordAvatarRef = {
        kind: "blob_handle",
        token: "notif-12b-discord-avatar",
        mime: "image/png",
        byte_len: discordAvatarBytes.length,
        dimensions: { width: 128, height: 128 },
      };
      const niriShotRef = {
        kind: "blob_handle",
        token: "notif-12b-niri-shot",
        mime: "image/png",
        byte_len: niriShotBytes.length,
        dimensions: { width: 320, height: 180 },
      };
      const ghosttyIconRef = {
        kind: "blob_handle",
        token: "notif-12b-ghostty-icon",
        mime: "image/png",
        byte_len: ghosttyIconBytes.length,
      };
      const discordNotif12b = {
        id: 201,
        revision: 1,
        app_name: "Discord",
        summary: "QuickFlash (#mobile, Text Channels)",
        body: "I guess for me, I am really not a fan of how iOS looks and would much rather have one unified look across both platforms.",
        icon: discordIconRef,
        attachment: discordAvatarRef,
        actions: [{ key: "default", label: "" }],
        urgency: 1,
      };
      const history12b = [
        discordNotif12b,
        {
          id: 202,
          revision: 1,
          app_name: "niri",
          summary: "Screenshot captured",
          body: "You can paste the image from the clipboard.",
          icon: niriShotRef,
          attachment: null,
          actions: [
            { key: "open", label: "Open" },
            { key: "copy", label: "Copy path" },
          ],
          urgency: 1,
        },
        {
          id: 203,
          revision: 1,
          app_name: "Ghostty",
          summary: "Approval requested",
          body: "Antigravity CLI is ready for input",
          icon: ghosttyIconRef,
          attachment: null,
          actions: [],
          urgency: 1,
        },
        {
          id: 204,
          revision: 1,
          app_name: "System",
          summary: "Update ready",
          body: "Fallback bell only when no XDG icon or image",
          icon: null,
          attachment: null,
          actions: [],
          urgency: 1,
        },
      ];

      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });

      // 1. 22A · Settings — Wallpaper Library drill-down + filename filter
      const appearanceListAtMs = timeline.after(20);
      timeline.step({
        id: "open-settings", op: "service.emit", channel: "control.message",
        value: { args: ["settings", "appearance"], reply: { text: "{\"settingsWindowOpen\":true,\"settingsWindowTab\":\"appearance\"}" } },
      });
      timeline.advance("settings-open-settle", 250);
      const libraryListAtMs = timeline.after(20);
      timeline.step({ id: "open-wp-library", op: "pointer.click", target: { surface: "settings-window", testId: "settings-wp-browse" }, button: "primary" });
      timeline.advance("wp-library-settle", 400);
      timeline.step({ id: "capture-wp-library", op: "capture", surface: "settings-window", captureId: "wallpaper-library" });
      timeline.step({ id: "focus-wp-filter", op: "pointer.click", target: { surface: "settings-window", testId: "wp-library-filter" }, button: "primary" });
      timeline.step({ id: "type-wp-filter", op: "text.commit", surface: "settings-window", text: "glacier" });
      timeline.advance("wp-filter-settle", 100);
      timeline.step({ id: "capture-wp-filtered", op: "capture", surface: "settings-window", captureId: "wallpaper-library-filtered" });
      timeline.step({
        id: "close-settings", op: "service.emit", channel: "control.message",
        value: { args: ["settings", "close"], reply: { text: "{\"settingsWindowOpen\":false}" } },
      });
      timeline.advance("settings-close-settle", 100);

      // 2. 14B · Media Player — Output Sink Picker Expanded & Idle State
      timeline.step({ id: "open-media", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-media" }, button: "primary" });
      timeline.advance("media-open-settle", 400);
      timeline.step({ id: "expand-media-sinks", op: "pointer.click", target: { surface: "panel-media", testId: "media-sink-toggle" }, button: "primary" });
      timeline.advance("media-sinks-settle", 400);
      timeline.step({ id: "capture-media-sink", op: "capture", surface: "panel-media", captureId: "media-sink-expanded" });
      timeline.step({ id: "collapse-media-sinks", op: "pointer.click", target: { surface: "panel-media", testId: "media-sink-toggle" }, button: "primary" });
      const mediaIdleAtMs = timeline.after(20);
      timeline.advance("media-idle-settle", 400);
      timeline.step({ id: "capture-media-idle", op: "capture", surface: "panel-media", captureId: "media-idle" });

      // 3. 13B · Calendar Empty Notifications & 12B · Notification Media & Avatar Layouts (Toast + History)
      timeline.step({ id: "open-cal-empty", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("cal-empty-settle", 400);
      timeline.step({ id: "capture-cal-empty", op: "capture", surface: "panel-calendar", captureId: "cal-empty" });
      const notifMedia12bAtMs = timeline.after(20);
      const notifMedia12bBlob1AtMs = timeline.after(30);
      const notifMedia12bBlob2AtMs = timeline.after(35);
      const notifMedia12bBlob3AtMs = timeline.after(40);
      const notifMedia12bBlob4AtMs = timeline.after(45);
      timeline.advance("notif-media-12b-settle", 450);
      timeline.step({ id: "capture-cal-notif-media-12b", op: "capture", surface: "panel-calendar", captureId: "cal-notif-media-12b" });
      const notifToast12bAtMs = timeline.after(20);
      const notifToast12bBlob1AtMs = timeline.after(30);
      const notifToast12bBlob2AtMs = timeline.after(35);
      timeline.advance("notif-toast-12b-settle", 450);
      timeline.step({ id: "capture-toast-notif-media-12b", op: "capture", surface: "notification-toasts", captureId: "toast-notif-media-12b" });
      const notifClear12bAtMs = timeline.after(10);
      timeline.advance("notif-clear-12b-settle", 120);

      // 4. 09E · Bar Popups (IME Switcher & Kimpanel)
      timeline.step({ id: "open-ime-menu", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-ime" }, button: "secondary" });
      timeline.advance("ime-menu-settle", 400);
      timeline.step({ id: "capture-ime-menu", op: "capture", surface: "ime-menu", captureId: "ime-menu-09e" });
      timeline.step({ id: "dismiss-ime-menu", op: "key.press", surface: "ime-menu", key: "Escape" });
      const kimpanelShowAtMs = timeline.after(20);
      timeline.advance("kimpanel-settle", 250);
      timeline.step({ id: "capture-kimpanel", op: "capture", surface: "kimpanel-popup", captureId: "kimpanel-09e" });
      const kimpanelHideAtMs = timeline.after(10);
      timeline.advance("kimpanel-hide-settle", 100);

      // 5. 18B · Launcher Empty Search State
      const launcherInitialAtMs = timeline.after(20);
      timeline.step({
        id: "open-launcher", op: "service.emit", channel: "control.message",
        value: { args: ["panel", "launcher"], reply: { text: "{\"activePanel\":\"launcher\"}" } },
      });
      timeline.advance("launcher-open-settle", 350);
      const launcherEmptyAtMs = timeline.after(15);
      timeline.step({ id: "type-launcher-miss", op: "text.commit", surface: "launcher-overlay", text: "photoshp" });
      timeline.advance("launcher-empty-settle", 200);
      timeline.step({ id: "capture-launcher-empty", op: "capture", surface: "launcher-overlay", captureId: "launcher-empty" });
      // 6. Clipboard keyboard single-step ArrowDown + Delete safe in search + Enter copies active entry
      timeline.step({
        id: "open-clipboard-kbd", op: "service.emit", channel: "control.message",
        value: { args: ["panel", "clipboard"], reply: { text: "{\"activePanel\":\"clipboard\"}" } },
      });
      timeline.advance("clipboard-kbd-open", 300);
      timeline.step({ id: "focus-clip-search", op: "pointer.click", target: { surface: "panel-clipboard", testId: "clipboard-search" }, button: "primary" });
      timeline.step({ id: "clip-arrow-down-once", op: "key.press", surface: "panel-clipboard", key: "ArrowDown" });
      timeline.step({ id: "clip-delete-in-search", op: "key.press", surface: "panel-clipboard", key: "Delete" });
      const clipCopyAtMs = timeline.after(20);
      timeline.step({ id: "clip-enter-copy", op: "key.press", surface: "panel-clipboard", key: "Enter" });
      timeline.advance("clipboard-kbd-settle", 100);
      timeline.step({ id: "finish", op: "settle" });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-new-states",
        initialTopics: {
          "wayland.outputs": {
            capability: "connected",
            outputs: [{
              output_instance_id: 1, name: "DP-1", description: "DisplayPort 1", make: "LG", model: "27GN950",
              x: 0, y: 0, width: 1280, height: 720, mode_width: 1280, mode_height: 720, refresh_mhz: 60000, scale: 1,
              physical_width_mm: 597, physical_height_mm: 336,
            }],
          },
          "desktop.notifications": { available: true, dnd: false, popups: [], history: [] },
          clipboard: {
            persistence: { mode: "encrypted" },
            transport: { status: "ready" },
            locked: "unlocked",
            entry_count: 3,
            entries: [
              { id: 101, kind: "text", mime: "text/plain", preview: "First entry", pinned: false, byte_len: 11, dimensions: null, media: null },
              { id: 102, kind: "text", mime: "text/plain", preview: "Second entry", pinned: false, byte_len: 12, dimensions: null, media: null },
              { id: 103, kind: "text", mime: "text/plain", preview: "Third entry", pinned: false, byte_len: 11, dimensions: null, media: null },
            ],
          },
          "desktop.media": {
            available: true,
            selected_player_id: "spotify",
            any_playing: true,
            cover: null,
            players: [
              {
                id: "spotify",
                identity: "Spotify",
                playback_status: "playing",
                position_us: 112_000_000,
                metadata: { title: "Feather", album: "Modal Soul", artists: ["Nujabes", "Cise Starr & Akin"], track_id: "t1", length_us: 175_000_000 },
                capabilities: { can_control: true, can_play: true, can_pause: true, can_go_next: true, can_go_previous: true, can_seek: true },
              },
              {
                id: "zen",
                identity: "Zen",
                playback_status: "paused",
                position_us: 0,
                metadata: { title: "Ambient", album: null, artists: ["Stream"], track_id: "t2", length_us: 0 },
                capabilities: { can_control: true, can_play: true, can_pause: true, can_go_next: false, can_go_previous: false, can_seek: false },
              },
            ],
          },
          "system.audio": {
            available: true,
            default_sink: "bluez.wh1000xm5",
            default_source: null,
            sinks: [
              { index: 10, name: "bluez.wh1000xm5", description: "WH-1000XM5 (LDAC)", volume: 0.68, muted: false, channels: 2 },
              { index: 11, name: "alsa.speakers", description: "Ryzen HD Audio Speakers", volume: 0.42, muted: false, channels: 2 },
              { index: 12, name: "alsa.hdmi", description: "HDMI / DisplayPort Audio", volume: 1.0, muted: false, channels: 2 },
            ],
            sources: [],
            sink_inputs: [],
          },
          "desktop.ime": {
            available: true,
            mode: "kimpanel",
            candidate_layout: "horizontal",
            switch_osd: false,
            active_im: { unique_name: "pinyin", label: "Pinyin · 拼音", short_label: "拼", icon_name: null },
            group_ims: [
              { unique_name: "pinyin", label: "Pinyin · 拼音", short_label: "拼", icon_name: null },
              { unique_name: "keyboard-us", label: "Keyboard - English (US)", short_label: "EN", icon_name: null },
            ],
            properties: [
              { key: "chttrans", label: "Simplified Chinese", icon_name: null, tip: null },
              { key: "fullwidth", label: "Full-width punctuation", icon_name: null, tip: null },
            ],
          },
          "desktop.ime.panel": {
            visible: false,
            aux: "",
            preedit: "",
            caret: 0,
            lookup_table: { labels: [], texts: [], attrs: [], has_prev: false, has_next: false, cursor: 0, layout: "horizontal" },
            spot_rect: null,
          },
          wallpaper: {
            available: true,
            fit: "cover",
            sync_theme: true,
            slideshow_seconds: 0,
            catalog_count: catalogItems.length,
            current: {
              source_path: catalogItems[0]!.source_path,
              media: null,
              width: 2560,
              height: 1440,
              fit: "cover",
            },
            per_output: {
              "DP-1": {
                source_path: catalogItems[0]!.source_path,
                media: null,
                width: 2560,
                height: 1440,
                fit: "cover",
              },
            },
            last_error: null,
          },
          settings: {
            general: { offline_mode: false, log_level: "info" },
            bar: {
              position: "top",
              style: "floating",
              gaps: 14,
              edge_overrides: { top: null, right: null, bottom: null, left: null },
              launcher_enabled: true,
              dock_enabled: false,
              clock_24h: true,
              clock_seconds: false,
            },
            theme: {
              mode: "dark",
              variant: "tonal",
              seed_color: null,
              motion_scheme: "standard",
              backend: "builtin",
              gtk_linking: false,
            },
            ime: { mode: "kimpanel", candidate_layout: "horizontal", switch_osd: false },
            polkit: { enabled: true },
            wallpaper: {
              directories: ["~/Pictures/Wallpapers", "~/Sync/Walls"],
              fit: "cover",
              sync_theme: true,
              slideshow_seconds: 0,
            },
            pre_action_fade_seconds: 0,
            configured_plugins: [],
          },
        },
        topicUpdates: [
          {
            atMs: mediaIdleAtMs,
            topic: "desktop.media",
            revision: 2,
            data: { available: true, selected_player_id: null, any_playing: false, cover: null, players: [] },
          },
          {
            atMs: notifMedia12bAtMs,
            topic: "desktop.notifications",
            revision: 2,
            data: { available: true, dnd: false, popups: [], history: history12b },
          },
          {
            atMs: notifToast12bAtMs,
            topic: "desktop.notifications",
            revision: 3,
            data: { available: true, dnd: false, popups: [discordNotif12b], history: history12b },
          },
          {
            atMs: notifClear12bAtMs,
            topic: "desktop.notifications",
            revision: 4,
            data: { available: true, dnd: false, popups: [], history: [] },
          },
          {
            atMs: kimpanelShowAtMs,
            topic: "desktop.ime.panel",
            revision: 2,
            data: {
              visible: true,
              aux: "",
              preedit: "zhong'wen",
              caret: 9,
              lookup_table: {
                labels: ["1", "2", "3", "4"],
                texts: ["中文", "钟文", "重文", "众文"],
                attrs: ["", "", "", ""],
                has_prev: false,
                has_next: true,
                cursor: 0,
                layout: "horizontal",
              },
              spot_rect: { x: 240, y: 180, w: 12, h: 20, relative: false, scale: 1 },
            },
          },
          {
            atMs: kimpanelHideAtMs,
            topic: "desktop.ime.panel",
            revision: 3,
            data: {
              visible: false,
              aux: "",
              preedit: "",
              caret: 0,
              lookup_table: { labels: [], texts: [], attrs: [], has_prev: false, has_next: false, cursor: 0, layout: "horizontal" },
              spot_rect: null,
            },
          },
        ],
        commands: [
          {
            id: 26,
            name: "wallpaper.list",
            payload: { offset: 0, limit: 16 },
            atMs: appearanceListAtMs,
            result: { data: { total: catalogItems.length, items: catalogItems } },
          },
          {
            id: 27,
            name: "wallpaper.list",
            payload: {},
            atMs: libraryListAtMs,
            result: { data: { total: catalogItems.length, items: catalogItems } },
          },
          {
            id: 28,
            name: "launcher.query",
            payload: { query: "", query_id: 1, limit: 18 },
            atMs: launcherInitialAtMs,
            result: {
              data: {
                query_id: 1,
                items: [{ provider_id: "desktop", item_id: "editor", title: "Editor", subtitle: "Code", icon: null }],
              },
            },
          },
          {
            id: 29,
            name: "launcher.query",
            payload: { query: "photoshp", query_id: 2, limit: 18 },
            atMs: launcherEmptyAtMs,
            result: { data: { query_id: 2, items: [] } },
          },
          {
            id: 30,
            name: "clipboard.copy",
            payload: { id: 102 },
            atMs: clipCopyAtMs,
            result: { data: { copied: 102 } },
          },
          {
            socket: "host",
            id: 3,
            name: "notifications.fetch-blob",
            payload: { token: "notif-12b-discord-avatar" },
            atMs: notifMedia12bBlob1AtMs,
            result: { data: { bytes: discordAvatarBytes } },
          },
          {
            socket: "host",
            id: 4,
            name: "notifications.fetch-blob",
            payload: { token: "notif-12b-discord-icon" },
            atMs: notifMedia12bBlob2AtMs,
            result: { data: { bytes: discordIconBytes } },
          },
          {
            socket: "host",
            id: 5,
            name: "notifications.fetch-blob",
            payload: { token: "notif-12b-niri-shot" },
            atMs: notifMedia12bBlob3AtMs,
            result: { data: { bytes: niriShotBytes } },
          },
          {
            socket: "host",
            id: 6,
            name: "notifications.fetch-blob",
            payload: { token: "notif-12b-ghostty-icon" },
            atMs: notifMedia12bBlob4AtMs,
            result: { data: { bytes: ghosttyIconBytes } },
          },
          {
            socket: "host",
            id: 7,
            name: "notifications.fetch-blob",
            payload: { token: "notif-12b-discord-avatar" },
            atMs: notifToast12bBlob1AtMs,
            result: { data: { bytes: discordAvatarBytes } },
          },
          {
            socket: "host",
            id: 8,
            name: "notifications.fetch-blob",
            payload: { token: "notif-12b-discord-icon" },
            atMs: notifToast12bBlob2AtMs,
            result: { data: { bytes: discordIconBytes } },
          },
        ],
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-new-states",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(published.dist, fixture, scenario, out);
      expectCleanPreview(result, 10, 0);

      // Verify 22A · Wallpaper Library
      const wpLib = readCapture(out, "settings-window", "wallpaper-library");
      expect(treeNode(wpLib.tree, "settings-wallpaper-library").boundsLogical).toBeDefined();
      expect(treeNode(wpLib.tree, "wp-lib-item-wp-1").boundsLogical).toBeDefined();
      expect(treeNode(wpLib.tree, "wp-lib-item-wp-12").boundsLogical).toBeDefined();
      expect(treeNode(wpLib.tree, "wp-library-clear").boundsLogical).toBeDefined();
      expect(wpLib.tree.nodes.some(node => node.text === "DP-1")).toBe(true);
      const wpFiltered = readCapture(out, "settings-window", "wallpaper-library-filtered");
      expect(treeNode(wpFiltered.tree, "wp-lib-item-wp-1").boundsLogical).toBeDefined();
      expect(wpFiltered.tree.nodes.some(node => node.testId === "wp-lib-item-wp-2")).toBe(false);

      // Verify 14B · Media Sink Picker & Idle State
      const mediaSink = readCapture(out, "panel-media", "media-sink-expanded");
      expect(treeNode(mediaSink.tree, "media-sink-drawer").boundsLogical).toBeDefined();
      expect(treeNode(mediaSink.tree, "media-sink-10").boundsLogical).toBeDefined();
      expect(treeNode(mediaSink.tree, "media-sink-11").boundsLogical).toBeDefined();
      expect(treeNode(mediaSink.tree, "media-sound-settings").boundsLogical).toBeDefined();
      const mediaIdle = readCapture(out, "panel-media", "media-idle");
      expect(treeNode(mediaIdle.tree, "media-idle-empty").boundsLogical).toBeDefined();
      expect(treeNode(mediaIdle.tree, "media-sink-toggle").boundsLogical).toBeDefined();

      // Verify 13B · Calendar Empty Notifications & 12B · Notification Media & Avatar Layouts
      const calEmpty = readCapture(out, "panel-calendar", "cal-empty");
      expect(treeNode(calEmpty.tree, "cal-notif-empty").boundsLogical).toBeDefined();
      expect(calEmpty.tree.nodes.some(node => node.text === "All caught up")).toBe(true);

      const calMedia12b = readCapture(out, "panel-calendar", "cal-notif-media-12b");
      // Form A (Discord 128x128 square avatar + XDG app icon): avatar in leading 36x36 slot + 16x16 circular badge, no bottom preview.
      const discordAvatar = treeNode(calMedia12b.tree, "cal-notif-avatar-201").boundsLogical!;
      expect([Math.round(discordAvatar.width), Math.round(discordAvatar.height)]).toEqual([36, 36]);
      const discordBadge = treeNode(calMedia12b.tree, "cal-notif-badge-201").boundsLogical!;
      expect([Math.round(discordBadge.width), Math.round(discordBadge.height)]).toEqual([16, 16]);
      expect(calMedia12b.tree.nodes.some(node => node.testId === "cal-notif-preview-201"), "Form A renders no bottom attachment block").toBe(false);
      // Form B (niri 320x180 16:9 screenshot in app_icon): full-width 104px cover banner below body + image icon fallback.
      expect(treeNode(calMedia12b.tree, "cal-notif-fallback-202").boundsLogical).toBeDefined();
      const niriPreview = treeNode(calMedia12b.tree, "cal-notif-preview-202").boundsDevice!;
      expect(niriPreview.width, "Form B wide screenshot spans full card width").toBeGreaterThan(300);
      expect(Math.round(niriPreview.height), "Form B history cover height == 104").toBe(104);
      const previewSample = pixel(calMedia12b.image, Math.round(niriPreview.x + niriPreview.width / 2), Math.round(niriPreview.y + 8));
      expect(previewSample[2], "Form B preview filled edge-to-edge by cover image").toBeGreaterThan(180);
      // XDG app icon only (Ghostty) & fallback bell (System).
      expect(treeNode(calMedia12b.tree, "cal-notif-avatar-203").boundsLogical).toBeDefined();
      expect(calMedia12b.tree.nodes.some(node => node.testId === "cal-notif-badge-203")).toBe(false);
      expect(treeNode(calMedia12b.tree, "cal-notif-fallback-204").boundsLogical).toBeDefined();

      // Toast Form A (Discord 40x40 avatar + 18x18 circular app badge, no bottom attachment).
      const toastMedia12b = readCapture(out, "notification-toasts", "toast-notif-media-12b");
      const toastAvatar = treeNode(toastMedia12b.tree, "toast-icon-201").boundsLogical!;
      expect([Math.round(toastAvatar.width), Math.round(toastAvatar.height)]).toEqual([40, 40]);
      const toastBadge = treeNode(toastMedia12b.tree, "toast-badge-201").boundsLogical!;
      expect([Math.round(toastBadge.width), Math.round(toastBadge.height)]).toEqual([18, 18]);
      expect(toastMedia12b.tree.nodes.some(node => node.testId === "toast-attachment-201"), "Toast Form A omits bottom attachment").toBe(false);

      // Verify 09E · IME Switcher & Kimpanel
      const imeMenu = readCapture(out, "ime-menu", "ime-menu-09e");
      expect(imeMenu.tree.nodes.some(node => node.text === "INPUT METHOD")).toBe(true);
      expect(treeNode(imeMenu.tree, "ime-im-pinyin").boundsLogical).toBeDefined();
      const kimpanel09e = readCapture(out, "kimpanel-popup", "kimpanel-09e");
      expect(treeNode(kimpanel09e.tree, "kimpanel-root").boundsLogical).toBeDefined();
      expect(treeNode(kimpanel09e.tree, "kimpanel-cand-0").boundsLogical).toBeDefined();

      // Verify 18B · Launcher Empty Search
      const launcherEmpty = readCapture(out, "launcher-overlay", "launcher-empty");
      expect(treeNode(launcherEmpty.tree, "launcher-empty").boundsLogical).toBeDefined();
      expect(launcherEmpty.tree.nodes.some(node => node.text === "No matching apps")).toBe(true);
    } finally {
      cleanup();
    }
  }, 30_000);

  previewTest("L4 Background Blur Capability (#91): 4-tier frosted glass vs Wayland Graceful Solid Fallback (profile.backgroundBlur + live setBackgroundBlurSupported)", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-design-blur-cap-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenarioLive = join(workspace, "scenario-live.json");
      const scenarioBoot = join(workspace, "scenario-boot.json");
      const outLive = join(out, "live");
      const outBoot = join(out, "boot");
      const monitor = { id: "DP-1", name: "DP-1", x: 0, y: 0, width: 1280, height: 720, scale: 1 };

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-blur-cap",
        initialTopics: {
          "wayland.outputs": {
            capability: "connected",
            outputs: [{
              output_instance_id: 1, name: "DP-1", description: "Main", make: "Test", model: "1280x720",
              x: 0, y: 0, width: 1280, height: 720, mode_width: 1280, mode_height: 720, refresh_mhz: 60000, scale: 1,
              physical_width_mm: null, physical_height_mm: null,
            }],
          },
          "wayland.workspaces": {
            capability: "connected",
            groups: [{ group_id: 1, output_instance_ids: [1] }],
            workspaces: [
              { workspace_id: 1, group_id: 1, name: "1", id_str: "1", coordinates: [1], active: true, urgent: false, hidden: false, capabilities: ["activate"] },
              { workspace_id: 2, group_id: 1, name: "2", id_str: "2", coordinates: [2], active: false, urgent: false, hidden: false, capabilities: ["activate"] },
            ],
          },
          "wayland.windows": {
            capability: "connected",
            windows: [{
              window_id: 10, app_id: "org.example.editor", title: "Glass Material Ladder",
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
            },
            theme: {
              mode: "dark",
              variant: "tonal",
              seed_color: null,
              motion_scheme: "standard",
              backend: "builtin",
              gtk_linking: false,
            },
            ime: { mode: "indicator_only", candidate_layout: "auto", switch_osd: true },
            polkit: { enabled: true },
            wallpaper: { directories: [], fit: "cover", sync_theme: true, slideshow_seconds: 300 },
            pre_action_fade_seconds: 0,
            configured_plugins: [],
          },
        },
      }), null, 2));

      const sampleSurfaceAlpha = (
        barCap: ReturnType<typeof readCapture>,
        dockCap: ReturnType<typeof readCapture>,
        qsCap: ReturnType<typeof readCapture>,
        settingsCap: ReturnType<typeof readCapture>,
      ) => {
        // Sample unobstructed background padding pixels on each tier:
        // - Dock (Tier C, 42%): top interior padding of dock capsule
        // - Floating Bar (Mid, 56%): interior fill of bar-workspaces island
        // - Quick Settings Popover (Tier B, 78%): top padding of panel-root-quick-settings inside border
        // - Settings Window (Level 3, 100%): top-left toplevel corner
        const dockBox = treeNode(dockCap.tree, "dock-root-DP-1").boundsDevice!;
        const barBox = treeNode(barCap.tree, "bar-clock").boundsDevice!;
        const qsBox = treeNode(qsCap.tree, "panel-root-quick-settings").boundsDevice!;
        return {
          dockAlpha: pixel(dockCap.image, Math.round(dockBox.x + dockBox.width / 2), Math.round(dockBox.y + 4))[3]!,
          barAlpha: pixel(barCap.image, Math.round(barBox.x + barBox.width / 2), Math.round(barBox.y + 3))[3]!,
          qsAlpha: pixel(qsCap.image, Math.round(qsBox.x + qsBox.width / 2), Math.round(qsBox.y + 5))[3]!,
          settingsAlpha: pixel(settingsCap.image, 10, 10)[3]!,
        };
      };

      // 1. Default profile (backgroundBlur omitted -> false): solid -> live glass -> solid fallback.
      const liveTimeline = createVirtualTimeline();
      liveTimeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      liveTimeline.advance("daemon-events", 30);
      liveTimeline.step({ id: "ready", op: "settle" });
      liveTimeline.step({ id: "keep-dock-revealed", op: "pointer.move", target: { surface: "dock-dp-1", testId: "dock-root-DP-1" } });
      liveTimeline.step({
        id: "open-settings", op: "service.emit", channel: "control.message",
        value: { args: ["settings", "bar"], reply: { text: "{\"settingsWindowOpen\":true,\"settingsWindowTab\":\"bar\"}" } },
      });
      liveTimeline.advance("settings-open-settle", 50);
      liveTimeline.step({ id: "open-qs", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-network" }, button: "primary" });
      liveTimeline.advance("open-settle", 420);
      liveTimeline.step({ id: "capture-bar-solid", op: "capture", surface: "bar-dp-1", captureId: "bar-solid" });
      liveTimeline.step({ id: "capture-dock-solid", op: "capture", surface: "dock-dp-1", captureId: "dock-solid" });
      liveTimeline.step({ id: "capture-qs-solid", op: "capture", surface: "panel-quick-settings", captureId: "qs-solid" });
      liveTimeline.step({ id: "capture-settings-solid", op: "capture", surface: "settings-window", captureId: "settings-solid" });

      liveTimeline.step({ id: "enable-blur", op: "setBackgroundBlurSupported", supported: true });
      liveTimeline.advance("glass-settle", 150);
      liveTimeline.step({ id: "capture-bar-glass", op: "capture", surface: "bar-dp-1", captureId: "bar-glass" });
      liveTimeline.step({ id: "capture-dock-glass", op: "capture", surface: "dock-dp-1", captureId: "dock-glass" });
      liveTimeline.step({ id: "capture-qs-glass", op: "capture", surface: "panel-quick-settings", captureId: "qs-glass" });
      liveTimeline.step({ id: "capture-settings-glass", op: "capture", surface: "settings-window", captureId: "settings-glass" });

      liveTimeline.step({ id: "disable-blur", op: "setBackgroundBlurSupported", supported: false });
      liveTimeline.advance("fallback-settle", 150);
      liveTimeline.step({ id: "capture-bar-fallback", op: "capture", surface: "bar-dp-1", captureId: "bar-fallback" });
      liveTimeline.step({ id: "capture-dock-fallback", op: "capture", surface: "dock-dp-1", captureId: "dock-fallback" });
      liveTimeline.step({ id: "capture-qs-fallback", op: "capture", surface: "panel-quick-settings", captureId: "qs-fallback" });

      writeFileSync(scenarioLive, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-blur-cap-live",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: liveTimeline.steps,
      }, null, 2));

      const liveResult = runPreview(published.dist, fixture, scenarioLive, outLive);
      expectCleanPreview(liveResult, 11, 0);

      const solid = sampleSurfaceAlpha(
        readCapture(outLive, "bar-dp-1", "bar-solid"),
        readCapture(outLive, "dock-dp-1", "dock-solid"),
        readCapture(outLive, "panel-quick-settings", "qs-solid"),
        readCapture(outLive, "settings-window", "settings-solid"),
      );
      expect(solid.dockAlpha, "solid fallback Dock must be 100% opaque").toBe(255);
      expect(solid.barAlpha, "solid fallback Floating Bar must be 100% opaque").toBe(255);
      expect(solid.qsAlpha, "solid fallback Popover must be 100% opaque").toBe(255);
      expect(solid.settingsAlpha, "Settings Window must be 100% opaque").toBe(255);

      const glass = sampleSurfaceAlpha(
        readCapture(outLive, "bar-dp-1", "bar-glass"),
        readCapture(outLive, "dock-dp-1", "dock-glass"),
        readCapture(outLive, "panel-quick-settings", "qs-glass"),
        readCapture(outLive, "settings-window", "settings-glass"),
      );
      expect(glass.dockAlpha, "glass Dock Tier C (42%) translucent").toBeGreaterThanOrEqual(85);
      expect(glass.dockAlpha, "glass Dock Tier C (42%) translucent").toBeLessThanOrEqual(145);
      expect(glass.barAlpha, "glass Floating Bar (56%) translucent").toBeGreaterThanOrEqual(125);
      expect(glass.barAlpha, "glass Floating Bar (56%) translucent").toBeLessThanOrEqual(185);
      expect(glass.qsAlpha, "glass Popover Tier B (78%) translucent").toBeGreaterThanOrEqual(180);
      expect(glass.qsAlpha, "glass Popover Tier B (78%) translucent").toBeLessThanOrEqual(235);
      expect(glass.dockAlpha, "4-tier ladder: Dock glassier than Floating Bar").toBeLessThan(glass.barAlpha);
      expect(glass.barAlpha, "4-tier ladder: Floating Bar glassier than Popover").toBeLessThan(glass.qsAlpha);
      expect(glass.qsAlpha, "4-tier ladder: Popover glassier than Settings").toBeLessThan(glass.settingsAlpha);
      expect(glass.settingsAlpha, "Level 3 Settings Window remains 100% solid in glass mode").toBe(255);

      const fallback = sampleSurfaceAlpha(
        readCapture(outLive, "bar-dp-1", "bar-fallback"),
        readCapture(outLive, "dock-dp-1", "dock-fallback"),
        readCapture(outLive, "panel-quick-settings", "qs-fallback"),
        readCapture(outLive, "settings-window", "settings-glass"),
      );
      expect(fallback.dockAlpha, "withdrawn blur Dock returns to 100% solid").toBe(255);
      expect(fallback.barAlpha, "withdrawn blur Floating Bar returns to 100% solid").toBe(255);
      expect(fallback.qsAlpha, "withdrawn blur Popover returns to 100% solid").toBe(255);

      // 2. Profile with backgroundBlur: true starts directly in 4-tier frosted glass mode.
      const baseProfilePath = join(shellDir, "preview/profile.json");
      const baseProfile = JSON.parse(readFileSync(baseProfilePath, "utf8")) as {
        readonly fonts: { readonly manifest: string; readonly [k: string]: unknown };
        readonly [k: string]: unknown;
      };
      const manifestAbs = resolve(dirname(baseProfilePath), baseProfile.fonts.manifest);
      const blurProfilePath = join(workspace, "profile-blur.json");
      writeFileSync(blurProfilePath, JSON.stringify({
        ...baseProfile,
        backgroundBlur: true,
        fonts: { ...baseProfile.fonts, manifest: relative(workspace, manifestAbs) },
      }, null, 2));

      const bootTimeline = createVirtualTimeline();
      bootTimeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      bootTimeline.advance("daemon-events", 30);
      bootTimeline.step({ id: "ready", op: "settle" });
      bootTimeline.step({ id: "keep-dock-revealed", op: "pointer.move", target: { surface: "dock-dp-1", testId: "dock-root-DP-1" } });
      bootTimeline.step({
        id: "open-settings", op: "service.emit", channel: "control.message",
        value: { args: ["settings", "bar"], reply: { text: "{\"settingsWindowOpen\":true,\"settingsWindowTab\":\"bar\"}" } },
      });
      bootTimeline.advance("settings-open-settle", 50);
      bootTimeline.step({ id: "open-qs", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-network" }, button: "primary" });
      bootTimeline.advance("open-settle", 420);
      bootTimeline.step({ id: "capture-bar-boot", op: "capture", surface: "bar-dp-1", captureId: "bar-boot" });
      bootTimeline.step({ id: "capture-dock-boot", op: "capture", surface: "dock-dp-1", captureId: "dock-boot" });
      bootTimeline.step({ id: "capture-qs-boot", op: "capture", surface: "panel-quick-settings", captureId: "qs-boot" });
      bootTimeline.step({ id: "capture-settings-boot", op: "capture", surface: "settings-window", captureId: "settings-boot" });

      writeFileSync(scenarioBoot, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-blur-cap-boot",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: bootTimeline.steps,
      }, null, 2));

      const bootResult = runPreview(published.dist, fixture, scenarioBoot, outBoot, { profile: blurProfilePath });
      expectCleanPreview(bootResult, 4, 0);

      const bootGlass = sampleSurfaceAlpha(
        readCapture(outBoot, "bar-dp-1", "bar-boot"),
        readCapture(outBoot, "dock-dp-1", "dock-boot"),
        readCapture(outBoot, "panel-quick-settings", "qs-boot"),
        readCapture(outBoot, "settings-window", "settings-boot"),
      );
      expect(bootGlass.dockAlpha, "profile backgroundBlur=true boots Dock into glass").toBeLessThan(bootGlass.barAlpha);
      expect(bootGlass.barAlpha, "profile backgroundBlur=true boots Bar glassier than Popover").toBeLessThan(bootGlass.qsAlpha);
      expect(bootGlass.qsAlpha, "profile backgroundBlur=true boots Popover glassier than Settings").toBeLessThan(bootGlass.settingsAlpha);
      expect(bootGlass.settingsAlpha, "profile backgroundBlur=true keeps Settings 100% solid").toBe(255);
    } finally {
      cleanup();
    }
  }, 30_000);

  previewTest("L4 Hover Atlas: M3InteractiveCard Full-Card Hover vs Isolated Secondary Controls & Representative Hover States", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-design-hover-atlas-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const monitor = { id: "DP-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900, scale: 1 };
      const catalogItems = [
        { id: "wp-1", name: "glacier-studio.png", source_path: "/home/hewel/Pictures/Wallpapers/glacier-studio.png", width: 2560, height: 1440, thumbnail: null },
        { id: "wp-2", name: "alpine-fog.png", source_path: "/home/hewel/Pictures/Wallpapers/alpine-fog.png", width: 2560, height: 1440, thumbnail: null },
        { id: "wp-3", name: "pine-moon.png", source_path: "/home/hewel/Pictures/Wallpapers/pine-moon.png", width: 2560, height: 1440, thumbnail: null },
      ];

      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });

      // 1. StatusBar floating island hover & Dock icon hover
      timeline.step({ id: "capture-bar-rest", op: "capture", surface: "bar-dp-1", captureId: "bar-rest" });
      timeline.step({ id: "hover-bar-clock", op: "pointer.move", target: { surface: "bar-dp-1", testId: "bar-clock" } });
      timeline.advance("bar-clock-hover-settle", 150);
      timeline.step({ id: "capture-bar-clock-hover", op: "capture", surface: "bar-dp-1", captureId: "bar-clock-hover" });

      // Reveal dock via far-left launcher button so browser icon on the right is strictly at rest.
      timeline.step({ id: "reveal-dock-rest", op: "pointer.move", target: { surface: "dock-dp-1", testId: "dock-launcher" } });
      timeline.advance("dock-reveal-settle", 420);
      timeline.step({ id: "capture-dock-rest", op: "capture", surface: "dock-dp-1", captureId: "dock-rest" });
      timeline.step({ id: "hover-dock-app", op: "pointer.move", target: { surface: "dock-dp-1", testId: "dock-app-org.example.browser" } });
      timeline.advance("dock-app-hover-settle", 180);
      timeline.step({ id: "capture-dock-app-hover", op: "capture", surface: "dock-dp-1", captureId: "dock-app-hover" });

      // 2. CalendarPanel: full-card body hover vs right × dismiss button hover
      timeline.step({ id: "open-cal", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("cal-open-settle", 400);
      timeline.step({ id: "capture-cal-rest", op: "capture", surface: "panel-calendar", captureId: "cal-rest" });
      timeline.step({ id: "hover-cal-card-body", op: "pointer.move", target: { surface: "panel-calendar", testId: "cal-notif-default-1" } });
      timeline.advance("cal-body-hover-settle", 150);
      timeline.step({ id: "capture-cal-card-hover", op: "capture", surface: "panel-calendar", captureId: "cal-card-hover" });
      timeline.step({ id: "hover-cal-dismiss", op: "pointer.move", target: { surface: "panel-calendar", testId: "cal-notif-dismiss-1" } });
      timeline.advance("cal-dismiss-hover-settle", 150);
      timeline.step({ id: "capture-cal-dismiss-hover", op: "capture", surface: "panel-calendar", captureId: "cal-dismiss-hover" });

      // 3. ClipboardPanel: entry body hover vs Pin / Forget hover
      timeline.step({
        id: "open-clipboard", op: "service.emit", channel: "control.message",
        value: { args: ["panel", "clipboard"], reply: { text: "{\"activePanel\":\"clipboard\"}" } },
      });
      timeline.advance("clip-open-settle", 400);
      timeline.step({ id: "capture-clip-rest", op: "capture", surface: "panel-clipboard", captureId: "clip-rest" });
      timeline.step({ id: "hover-clip-body", op: "pointer.move", target: { surface: "panel-clipboard", testId: "clip-copy-101" } });
      timeline.advance("clip-body-hover-settle", 150);
      timeline.step({ id: "capture-clip-body-hover", op: "capture", surface: "panel-clipboard", captureId: "clip-body-hover" });
      timeline.step({ id: "hover-clip-pin", op: "pointer.move", target: { surface: "panel-clipboard", testId: "clip-pin-101" } });
      timeline.advance("clip-pin-hover-settle", 150);
      timeline.step({ id: "capture-clip-pin-hover", op: "capture", surface: "panel-clipboard", captureId: "clip-pin-hover" });
      timeline.step({ id: "hover-clip-forget", op: "pointer.move", target: { surface: "panel-clipboard", testId: "clip-forget-101" } });
      timeline.advance("clip-forget-hover-settle", 150);
      timeline.step({ id: "capture-clip-forget-hover", op: "capture", surface: "panel-clipboard", captureId: "clip-forget-hover" });

      // 4. QuickSettings: SplitTile left half hover vs right > arrow hover
      timeline.step({ id: "open-qs", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-network" }, button: "primary" });
      timeline.advance("qs-open-settle", 450);
      timeline.step({ id: "capture-qs-rest", op: "capture", surface: "panel-quick-settings", captureId: "qs-rest" });
      timeline.step({ id: "hover-qs-split-left", op: "pointer.move", target: { surface: "panel-quick-settings", testId: "qs-tile-wifi" } });
      timeline.advance("qs-left-hover-settle", 150);
      timeline.step({ id: "capture-qs-split-left", op: "capture", surface: "panel-quick-settings", captureId: "qs-split-left-hover" });
      timeline.step({ id: "hover-qs-split-right", op: "pointer.move", target: { surface: "panel-quick-settings", testId: "qs-open-wifi" } });
      timeline.advance("qs-right-hover-settle", 150);
      timeline.step({ id: "capture-qs-split-right", op: "capture", surface: "panel-quick-settings", captureId: "qs-split-right-hover" });

      // 5. MediaPanel: output sink chip hover, Play/Pause hover, unseekable progress bar hover (0 diff)
      timeline.step({ id: "open-media", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-media" }, button: "primary" });
      timeline.advance("media-open-settle", 400);
      timeline.step({ id: "capture-media-rest", op: "capture", surface: "panel-media", captureId: "media-rest" });
      timeline.step({ id: "hover-media-sink", op: "pointer.move", target: { surface: "panel-media", testId: "media-sink-toggle" } });
      timeline.advance("media-sink-hover-settle", 150);
      timeline.step({ id: "capture-media-sink-hover", op: "capture", surface: "panel-media", captureId: "media-sink-hover" });
      timeline.step({ id: "hover-media-play", op: "pointer.move", target: { surface: "panel-media", testId: "media-play-pause" } });
      timeline.advance("media-play-hover-settle", 150);
      timeline.step({ id: "capture-media-play-hover", op: "capture", surface: "panel-media", captureId: "media-play-hover" });
      timeline.step({ id: "hover-media-progress", op: "pointer.move", target: { surface: "panel-media", testId: "media-progress" } });
      timeline.advance("media-progress-hover-settle", 150);
      timeline.step({ id: "capture-media-progress-hover", op: "capture", surface: "panel-media", captureId: "media-progress-hover" });

      // 6. Settings — IdlePane: rule row body hover vs right M3Switch hover
      timeline.step({
        id: "open-settings-idle", op: "service.emit", channel: "control.message",
        value: { args: ["settings", "idle"], reply: { text: "{\"settingsWindowOpen\":true,\"settingsWindowTab\":\"idle\"}" } },
      });
      timeline.advance("idle-open-settle", 400);
      timeline.step({ id: "capture-idle-rest", op: "capture", surface: "settings-window", captureId: "idle-rest" });
      timeline.step({ id: "hover-idle-rule", op: "pointer.move", target: { surface: "settings-window", testId: "settings-idle-rule-dpms" } });
      timeline.advance("idle-rule-hover-settle", 150);
      timeline.step({ id: "capture-idle-rule-hover", op: "capture", surface: "settings-window", captureId: "idle-rule-hover" });
      timeline.step({ id: "hover-idle-switch", op: "pointer.move", target: { surface: "settings-window", testId: "settings-idle-switch-dpms" } });
      timeline.advance("idle-switch-hover-settle", 150);
      timeline.step({ id: "capture-idle-switch-hover", op: "capture", surface: "settings-window", captureId: "idle-switch-hover" });

      // 7. Settings — AppearancePane: sidebar nav item, M3SegmentedControl item, wallpaper thumbnail
      const wpListAtMs = timeline.after(20);
      timeline.step({
        id: "open-settings-appearance", op: "service.emit", channel: "control.message",
        value: { args: ["settings", "appearance"], reply: { text: "{\"settingsWindowOpen\":true,\"settingsWindowTab\":\"appearance\"}" } },
      });
      timeline.advance("appearance-open-settle", 400);
      timeline.step({ id: "capture-settings-app-rest", op: "capture", surface: "settings-window", captureId: "settings-app-rest" });
      timeline.step({ id: "hover-settings-nav", op: "pointer.move", target: { surface: "settings-window", testId: "settings-nav-bar" } });
      timeline.advance("settings-nav-hover-settle", 150);
      timeline.step({ id: "capture-settings-nav-hover", op: "capture", surface: "settings-window", captureId: "settings-nav-hover" });
      timeline.step({ id: "hover-settings-seg", op: "pointer.move", target: { surface: "settings-window", testId: "settings-motion-expressive" } });
      timeline.advance("settings-seg-hover-settle", 150);
      timeline.step({ id: "capture-settings-seg-hover", op: "capture", surface: "settings-window", captureId: "settings-seg-hover" });
      timeline.step({ id: "hover-settings-wp", op: "pointer.move", target: { surface: "settings-window", testId: "settings-wp-wp-2" } });
      timeline.advance("settings-wp-hover-settle", 150);
      timeline.step({ id: "capture-settings-wp-hover", op: "capture", surface: "settings-window", captureId: "settings-wp-hover" });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-hover-atlas",
        initialTopics: {
          "wayland.outputs": {
            capability: "connected",
            outputs: [{
              output_instance_id: 1, name: "DP-1", description: "Hover Atlas Display", make: "Test", model: "1440x900",
              x: 0, y: 0, width: 1440, height: 900, mode_width: 1440, mode_height: 900, refresh_mhz: 60000, scale: 1,
              physical_width_mm: null, physical_height_mm: null,
            }],
          },
          "wayland.workspaces": {
            capability: "connected",
            groups: [{ group_id: 1, output_instance_ids: [1] }],
            workspaces: [
              { workspace_id: 1, group_id: 1, name: "1", id_str: "1", coordinates: [1], active: true, urgent: false, hidden: false, capabilities: ["activate"] },
              { workspace_id: 2, group_id: 1, name: "2", id_str: "2", coordinates: [2], active: false, urgent: false, hidden: false, capabilities: ["activate"] },
            ],
          },
          "wayland.windows": {
            capability: "connected",
            windows: [{
              window_id: 10, app_id: "org.example.editor", title: "z-shell — Editor",
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
          "desktop.notifications": {
            available: true,
            dnd: false,
            popups: [],
            history: [
              {
                id: 1,
                revision: 1,
                app_name: "Ghostty",
                summary: "Build completed",
                body: "z-shell-ui compiled cleanly in 4.2s",
                icon: null,
                attachment: null,
                actions: [
                  { key: "default", label: "" },
                  { key: "open", label: "Open" },
                ],
                urgency: 1,
              },
              {
                id: 2,
                revision: 1,
                app_name: "System",
                summary: "Snapshot synced",
                body: "No default action card",
                icon: null,
                attachment: null,
                actions: [],
                urgency: 1,
              },
            ],
          },
          clipboard: {
            persistence: { mode: "encrypted" },
            transport: { status: "ready" },
            locked: "unlocked",
            entry_count: 2,
            entries: [
              { id: 101, kind: "text", mime: "text/plain", preview: "https://github.com/ariakit/ariakit", pinned: false, byte_len: 34, dimensions: null, media: null },
              { id: 102, kind: "text", mime: "text/plain", preview: "Wallpaper", pinned: true, byte_len: 9, dimensions: null, media: null },
            ],
          },
          "desktop.media": {
            available: true,
            selected_player_id: "jellypilot",
            any_playing: false,
            cover: null,
            players: [{
              id: "jellypilot",
              identity: "JellyPilot",
              playback_status: "paused",
              position_us: 60_000_000,
              capabilities: { can_play: true, can_pause: true, can_go_next: true, can_go_previous: true, can_seek: false },
              metadata: { title: "Unseekable Stream", artists: ["Live Radio"], album: "Broadcast", length_us: 180_000_000 },
            }],
          },
          "system.audio": {
            available: true,
            default_sink: "speakers",
            default_source: null,
            sinks: [
              { index: 1, name: "speakers", description: "Studio Speakers", volume: 0.65, muted: false, channels: 2 },
              { index: 2, name: "headphones", description: "WH-1000XM5", volume: 0.45, muted: false, channels: 2 },
            ],
            sources: [],
            sink_inputs: [],
          },
          "system.network": {
            available: true,
            connectivity: "full",
            ethernet: [],
            wifi: {
              enabled: true,
              hardware_enabled: true,
              scanning: false,
              devices: [{
                id: "wlan0",
                interface: "wlan0",
                active_ap_id: "ap-studio",
                active_connection: "Studio-5G",
                access_points: [{ id: "ap-studio", ssid: "Studio-5G", strength: 82, secured: true, active: true }],
              }],
              profiles: [],
            },
          },
          "session.idle": {
            available: true,
            caffeine: false,
            service_status: { status: "running" },
            rules: [
              { name: "lock", enabled: true, timeout_seconds: 300, locked_timeout_seconds: null, action: "lock", resume_command: null, pre_action_fade_seconds: 2 },
              { name: "dpms", enabled: true, timeout_seconds: 600, locked_timeout_seconds: 30, action: "screen_off", resume_command: null, pre_action_fade_seconds: 0 },
            ],
            active_inhibitors: [],
          },
          wallpaper: {
            available: true,
            fit: "cover",
            sync_theme: true,
            slideshow_seconds: 0,
            catalog_count: catalogItems.length,
            current: { source_path: catalogItems[0]!.source_path, media: null, width: 2560, height: 1440, fit: "cover" },
            per_output: { "DP-1": { source_path: catalogItems[0]!.source_path, media: null, width: 2560, height: 1440, fit: "cover" } },
            last_error: null,
          },
          settings: {
            general: { offline_mode: false, log_level: "info" },
            bar: {
              position: "top",
              style: "floating",
              gaps: 12,
              edge_overrides: { top: null, right: null, bottom: null, left: null },
              launcher_enabled: true,
              dock_enabled: true,
              clock_24h: true,
              clock_seconds: false,
            },
            theme: {
              mode: "dark",
              variant: "tonal",
              seed_color: null,
              motion_scheme: "standard",
              backend: "builtin",
              gtk_linking: false,
            },
            ime: { mode: "indicator_only", candidate_layout: "auto", switch_osd: true },
            polkit: { enabled: true },
            wallpaper: { directories: ["~/Pictures/Wallpapers"], fit: "cover", sync_theme: true, slideshow_seconds: 0 },
            pre_action_fade_seconds: 0,
            configured_plugins: [],
          },
        },
        commands: [
          {
            id: 26,
            name: "wallpaper.list",
            payload: { offset: 0, limit: 16 },
            atMs: wpListAtMs,
            result: { data: { total: catalogItems.length, items: catalogItems } },
          },
        ],
      }), null, 2));

      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-hover-atlas",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(published.dist, fixture, scenario, out);
      expectCleanPreview(result, 25, 0);

      const assertRoundedHoverCorners = (
        beforeImg: ReturnType<typeof readCapture>["image"],
        afterImg: ReturnType<typeof readCapture>["image"],
        bounds: DeviceBounds,
        label: string,
      ) => {
        const x0 = Math.floor(bounds.x);
        const y0 = Math.floor(bounds.y);
        const x1 = Math.ceil(bounds.x + bounds.width) - 1;
        const y1 = Math.ceil(bounds.y + bounds.height) - 1;
        for (const [cornerName, cx, cy] of [
          ["top-left", x0, y0],
          ["top-right", x1, y0],
          ["bottom-left", x0, y1],
          ["bottom-right", x1, y1],
        ] as const) {
          expect(
            pixelChannelDiff(pixel(beforeImg, cx, cy), pixel(afterImg, cx, cy)),
            `${label} rounded outer corner ${cornerName} (${cx},${cy})`,
          ).toBe(0);
        }
      };

      // 1. CalendarPanel: full-card highlight spans right edge beyond × vs isolated × with zero card double-highlight
      const calRest = readCapture(out, "panel-calendar", "cal-rest");
      const calBodyHover = readCapture(out, "panel-calendar", "cal-card-hover");
      const calDismissHover = readCapture(out, "panel-calendar", "cal-dismiss-hover");
      const calCard = treeNode(calRest.tree, "cal-notif-1").boundsDevice!;
      const calDismiss = treeNode(calRest.tree, "cal-notif-dismiss-1").boundsDevice!;
      expect(
        diffRegionPixels(calRest.image, calBodyHover.image, { x: calCard.x + 4, y: calCard.y + 18, width: 20, height: 24 }),
        "Calendar card body hover reaches left card edge",
      ).toBeGreaterThan(20);
      expect(
        diffRegionPixels(calRest.image, calBodyHover.image, { x: calCard.x + calCard.width - 28, y: calCard.y + calCard.height - 28, width: 22, height: 18 }),
        "Calendar card body hover reaches right-bottom edge (no clipped box-in-box before ×)",
      ).toBeGreaterThan(20);
      assertRoundedHoverCorners(calRest.image, calBodyHover.image, calCard, "cal-notif-1");
      expect(
        diffRegionPixels(calRest.image, calDismissHover.image, calDismiss),
        "Calendar × hover highlights × button",
      ).toBeGreaterThan(20);
      expect(
        diffRegionPixels(calRest.image, calDismissHover.image, { x: calCard.x + 6, y: calCard.y + 10, width: 120, height: 32 }),
        "Calendar × hover produces zero double-highlight on card body",
      ).toBe(0);

      // 2. ClipboardPanel: full-card body hover vs isolated Pin & Forget buttons
      const clipRest = readCapture(out, "panel-clipboard", "clip-rest");
      const clipBodyHover = readCapture(out, "panel-clipboard", "clip-body-hover");
      const clipPinHover = readCapture(out, "panel-clipboard", "clip-pin-hover");
      const clipForgetHover = readCapture(out, "panel-clipboard", "clip-forget-hover");
      const clipCard = treeNode(clipRest.tree, "clip-entry-101").boundsDevice!;
      const clipPin = treeNode(clipRest.tree, "clip-pin-101").boundsDevice!;
      const clipForget = treeNode(clipRest.tree, "clip-forget-101").boundsDevice!;
      expect(
        diffRegionPixels(clipRest.image, clipBodyHover.image, { x: clipCard.x + 4, y: clipCard.y + 12, width: 16, height: 24 }),
        "Clipboard card body hover reaches left edge behind thumbnail",
      ).toBeGreaterThan(10);
      expect(
        diffRegionPixels(clipRest.image, clipBodyHover.image, { x: clipCard.x + clipCard.width - 14, y: clipCard.y + 12, width: 10, height: 24 }),
        "Clipboard card body hover reaches right card edge",
      ).toBeGreaterThan(10);
      assertRoundedHoverCorners(clipRest.image, clipBodyHover.image, clipCard, "clip-entry-101");
      expect(diffRegionPixels(clipRest.image, clipPinHover.image, clipPin), "Clipboard Pin hover highlights Pin").toBeGreaterThan(15);
      expect(
        diffRegionPixels(clipRest.image, clipPinHover.image, { x: clipCard.x + 6, y: clipCard.y + 10, width: 160, height: 28 }),
        "Clipboard Pin hover leaves card body unhighlighted",
      ).toBe(0);
      expect(diffRegionPixels(clipRest.image, clipForgetHover.image, clipForget), "Clipboard Forget hover highlights Forget").toBeGreaterThan(15);
      expect(
        diffRegionPixels(clipRest.image, clipForgetHover.image, { x: clipCard.x + 6, y: clipCard.y + 10, width: 160, height: 28 }),
        "Clipboard Forget hover leaves card body unhighlighted",
      ).toBe(0);

      // 3. IdlePane: full-card rule row hover vs isolated right M3Switch hover
      const idleRest = readCapture(out, "settings-window", "idle-rest");
      const idleBodyHover = readCapture(out, "settings-window", "idle-rule-hover");
      const idleSwitchHover = readCapture(out, "settings-window", "idle-switch-hover");
      const idleCard = treeNode(idleRest.tree, "settings-idle-rule-card-dpms").boundsDevice!;
      const idleSwitch = treeNode(idleRest.tree, "settings-idle-switch-dpms").boundsDevice!;
      expect(
        diffRegionPixels(idleRest.image, idleBodyHover.image, { x: idleCard.x + 4, y: idleCard.y + 12, width: 20, height: 24 }),
        "Idle rule body hover reaches left edge",
      ).toBeGreaterThan(15);
      expect(
        diffRegionPixels(idleRest.image, idleBodyHover.image, { x: idleCard.x + idleCard.width - 14, y: idleCard.y + 12, width: 10, height: 24 }),
        "Idle rule body hover reaches right edge beyond switch",
      ).toBeGreaterThan(10);
      assertRoundedHoverCorners(idleRest.image, idleBodyHover.image, idleCard, "settings-idle-rule-card-dpms");
      expect(diffRegionPixels(idleRest.image, idleSwitchHover.image, idleSwitch), "Idle switch hover highlights switch").toBeGreaterThan(10);
      expect(
        diffRegionPixels(idleRest.image, idleSwitchHover.image, { x: idleCard.x + 6, y: idleCard.y + 10, width: 180, height: 24 }),
        "Idle switch hover leaves rule row body unhighlighted",
      ).toBe(0);

      // 4. QuickSettings SplitTile left half vs right > arrow
      const qsRest = readCapture(out, "panel-quick-settings", "qs-rest");
      const qsLeftHover = readCapture(out, "panel-quick-settings", "qs-split-left-hover");
      const qsRightHover = readCapture(out, "panel-quick-settings", "qs-split-right-hover");
      const qsLeft = treeNode(qsRest.tree, "qs-tile-wifi").boundsDevice!;
      const qsRight = treeNode(qsRest.tree, "qs-open-wifi").boundsDevice!;
      expect(diffRegionPixels(qsRest.image, qsLeftHover.image, qsLeft), "SplitTile left hover highlights left half").toBeGreaterThan(20);
      expect(diffRegionPixels(qsRest.image, qsLeftHover.image, qsRight), "SplitTile left hover does not highlight right >").toBe(0);
      expect(diffRegionPixels(qsRest.image, qsRightHover.image, qsRight), "SplitTile right > hover highlights > button").toBeGreaterThan(10);
      expect(diffRegionPixels(qsRest.image, qsRightHover.image, qsLeft), "SplitTile right > hover does not highlight left half").toBe(0);

      // 5. MediaPanel: sink chip, Play/Pause, unseekable progress bar (0 diff)
      const mediaRest = readCapture(out, "panel-media", "media-rest");
      const mediaSinkHover = readCapture(out, "panel-media", "media-sink-hover");
      const mediaPlayHover = readCapture(out, "panel-media", "media-play-hover");
      const mediaProgressHover = readCapture(out, "panel-media", "media-progress-hover");
      expect(diffRegionPixels(mediaRest.image, mediaSinkHover.image, treeNode(mediaRest.tree, "media-sink-toggle").boundsDevice!), "Media sink chip hover").toBeGreaterThan(20);
      expect(diffRegionPixels(mediaRest.image, mediaPlayHover.image, treeNode(mediaRest.tree, "media-play-pause").boundsDevice!), "Media play/pause hover").toBeGreaterThan(20);
      expect(diffRegionPixels(mediaRest.image, mediaProgressHover.image, treeNode(mediaRest.tree, "media-progress").boundsDevice!), "Unseekable media progress bar hover == 0 diff").toBe(0);

      // 6. Settings: sidebar nav, M3SegmentedControl, wallpaper thumbnail
      const appRest = readCapture(out, "settings-window", "settings-app-rest");
      const navHover = readCapture(out, "settings-window", "settings-nav-hover");
      const segHover = readCapture(out, "settings-window", "settings-seg-hover");
      const wpHover = readCapture(out, "settings-window", "settings-wp-hover");
      expect(diffRegionPixels(appRest.image, navHover.image, treeNode(appRest.tree, "settings-nav-bar").boundsDevice!), "Settings sidebar nav hover").toBeGreaterThan(20);
      expect(diffRegionPixels(appRest.image, segHover.image, treeNode(appRest.tree, "settings-motion-expressive").boundsDevice!), "Settings M3SegmentedControl hover").toBeGreaterThan(20);
      expect(diffRegionPixels(appRest.image, wpHover.image, treeNode(appRest.tree, "settings-wp-wp-2").boundsDevice!), "Settings wallpaper thumbnail hover").toBeGreaterThan(20);

      // 7. StatusBar island & Dock icon
      const barRest = readCapture(out, "bar-dp-1", "bar-rest");
      const barClockHover = readCapture(out, "bar-dp-1", "bar-clock-hover");
      expect(diffRegionPixels(barRest.image, barClockHover.image, treeNode(barRest.tree, "bar-clock").boundsDevice!), "StatusBar floating island hover").toBeGreaterThan(20);
      const dockRest = readCapture(out, "dock-dp-1", "dock-rest");
      const dockAppHover = readCapture(out, "dock-dp-1", "dock-app-hover");
      const dockApp = treeNode(dockRest.tree, "dock-app-org.example.browser").boundsDevice!;
      expect(
        diffRegionPixels(dockRest.image, dockAppHover.image, { x: Math.max(0, dockApp.x - 10), y: Math.max(0, dockApp.y - 12), width: dockApp.width + 20, height: dockApp.height + 20 }),
        "Dock icon hover feedback",
      ).toBeGreaterThan(20);
    } finally {
      cleanup();
    }
  }, 30_000);

  previewTest("L4 12C Top-Right Notification Stack: Collapsed Layered Deck -> Expand -> Collapse + Pause Auto-Expiry", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-design-toast-stack-");
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const monitor = { id: "DP-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900, scale: 1 };
      const popups4 = [
        {
          id: 301,
          revision: 1,
          app_name: "Discord",
          summary: "QuickFlash (#mobile)",
          body: "I guess for me, I am really not a fan of how iOS looks and would much rather have one unified look.",
          icon: null,
          attachment: null,
          actions: [{ key: "default", label: "" }],
          urgency: 1,
        },
        {
          id: 302,
          revision: 1,
          app_name: "niri",
          summary: "Screenshot captured",
          body: "You can paste the image from the clipboard.",
          icon: null,
          attachment: null,
          actions: [{ key: "open", label: "Open" }],
          urgency: 1,
        },
        {
          id: 303,
          revision: 1,
          app_name: "Ghostty",
          summary: "Approval requested",
          body: "Antigravity CLI is ready for input",
          icon: null,
          attachment: null,
          actions: [{ key: "terminal", label: "Show terminal" }],
          urgency: 1,
        },
        {
          id: 304,
          revision: 1,
          app_name: "System",
          summary: "Backup finished",
          body: "Encrypted snapshot synced to remote",
          icon: null,
          attachment: null,
          actions: [],
          urgency: 1,
        },
      ];

      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });
      timeline.advance("stack-enter-settle", 450);
      timeline.step({ id: "capture-collapsed", op: "capture", surface: "notification-toasts", captureId: "toast-stack-collapsed" });

      const pauseTrueAtMs = timeline.after(20);
      timeline.step({ id: "expand-toast-stack", op: "pointer.click", target: { surface: "notification-toasts", testId: "toast-expand-toggle" }, button: "primary" });
      timeline.advance("stack-expand-settle", 450);
      timeline.step({ id: "capture-expanded", op: "capture", surface: "notification-toasts", captureId: "toast-stack-expanded" });

      timeline.step({ id: "collapse-toast-stack", op: "pointer.click", target: { surface: "notification-toasts", testId: "toast-collapse-toggle" }, button: "primary" });
      timeline.advance("stack-collapse-settle", 400);
      timeline.step({ id: "capture-recollapsed", op: "capture", surface: "notification-toasts", captureId: "toast-stack-recollapsed" });
      const clearPopupsAtMs = timeline.after(15);
      const pauseFalseAtMs = timeline.after(25);
      timeline.advance("stack-clear-settle", 200);

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-toast-stack",
        initialTopics: {
          "wayland.outputs": {
            capability: "connected",
            outputs: [{
              output_instance_id: 1, name: "DP-1", description: "Toast Stack Monitor", make: "Test", model: "1440x900",
              x: 0, y: 0, width: 1440, height: 900, mode_width: 1440, mode_height: 900, refresh_mhz: 60000, scale: 1,
              physical_width_mm: null, physical_height_mm: null,
            }],
          },
          "desktop.notifications": {
            available: true,
            dnd: false,
            popups: popups4,
            history: popups4,
          },
        },
        topicUpdates: [
          {
            atMs: clearPopupsAtMs,
            topic: "desktop.notifications",
            revision: 2,
            data: { available: true, dnd: false, popups: [], history: popups4 },
          },
        ],
        commands: [
          {
            id: 26,
            name: "notifications.set-paused",
            payload: { paused: true },
            atMs: pauseTrueAtMs,
          },
          {
            id: 27,
            name: "notifications.set-paused",
            payload: { paused: false },
            atMs: pauseFalseAtMs,
          },
        ],
      }), null, 2));

      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-toast-stack",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(published.dist, fixture, scenario, out);
      expectCleanPreview(result, 3, 0);

      // 1. Collapsed state (Form A): main card + 2 tucked deck layers + M3InteractiveCard +3 more footer.
      const collapsed = readCapture(out, "notification-toasts", "toast-stack-collapsed");
      expect(treeNode(collapsed.tree, "toast-card-301").boundsLogical).toBeDefined();
      expect(treeNode(collapsed.tree, "toast-deck-peek").boundsLogical).toBeDefined();
      expect(treeNode(collapsed.tree, "toast-deck-layer-1").boundsLogical).toBeDefined();
      expect(treeNode(collapsed.tree, "toast-deck-layer-2").boundsLogical).toBeDefined();
      expect(treeNode(collapsed.tree, "toast-more-footer").boundsLogical).toBeDefined();
      expect(treeNode(collapsed.tree, "toast-expand-toggle").boundsLogical).toBeDefined();
      expect(collapsed.tree.nodes.some(node => node.text === "+3 more")).toBe(true);
      expect(collapsed.tree.nodes.some(node => node.testId === "toast-card-302")).toBe(false);

      // 2. Expanded state (Form B): top fixed control bar + multiple cards simultaneously visible.
      const expanded = readCapture(out, "notification-toasts", "toast-stack-expanded");
      expect(treeNode(expanded.tree, "toast-expanded-header").boundsLogical).toBeDefined();
      expect(treeNode(expanded.tree, "toast-collapse-toggle").boundsLogical).toBeDefined();
      expect(expanded.tree.nodes.some(node => node.text === "4 active")).toBe(true);
      expect(treeNode(expanded.tree, "toast-card-301").boundsLogical).toBeDefined();
      expect(treeNode(expanded.tree, "toast-card-302").boundsLogical).toBeDefined();
      expect(treeNode(expanded.tree, "toast-card-303").boundsLogical).toBeDefined();
      expect(treeNode(expanded.tree, "toast-card-304").boundsLogical).toBeDefined();
      expect(expanded.image.height, "expanded LayerSurface grows beyond collapsed 456px height").toBeGreaterThan(456);

      // 3. Re-collapsed state: header and secondary cards dismissed, footer restored.
      const recollapsed = readCapture(out, "notification-toasts", "toast-stack-recollapsed");
      expect(treeNode(recollapsed.tree, "toast-card-301").boundsLogical).toBeDefined();
      expect(treeNode(recollapsed.tree, "toast-more-footer").boundsLogical).toBeDefined();
      expect(recollapsed.tree.nodes.some(node => node.testId === "toast-expanded-header")).toBe(false);
      expect(recollapsed.tree.nodes.some(node => node.testId === "toast-card-302")).toBe(false);
    } finally {
      cleanup();
    }
  }, 30_000);

  previewTest("L4 System Monitor (04C & 22J): Horizontal Trigger, Click Flows, Multi-Monitor, Mutual Exclusion, Single-Instance & Time-Range Curve Switching", () => {
    const { workspace, out, cleanup } = createPreviewWorkspace("z-shell-preview-design-sysmon-");
    const interactiveRoles = new Set(["button", "switch", "slider", "menuItem", "menuItemCheckBox", "menuItemRadio", "tab", "radio"]);
    try {
      const fixture = join(workspace, "fixture.json");
      const scenario = join(workspace, "scenario.json");
      const primaryMonitor = { id: "DP-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900, scale: 1 };
      const secondaryMonitor = { id: "HDMI-A-1", name: "HDMI-A-1", x: 1440, y: 0, width: 1280, height: 720, scale: 1 };

      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [primaryMonitor, secondaryMonitor] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });
      timeline.step({ id: "capture-bar-horizontal", op: "capture", surface: "bar-dp-1", captureId: "bar-sysmon-horizontal" });

      // 1. Click bar-sysmon on DP-1 -> opens 04C popover
      timeline.step({ id: "open-sysmon-dp1", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-sysmon" }, button: "primary" });
      timeline.advance("sysmon-open-settle", 450);
      timeline.step({ id: "capture-sysmon-popover", op: "capture", surface: "panel-system-monitor", captureId: "sysmon-popover" });

      // 2. Second click on same monitor closes popover
      timeline.step({ id: "toggle-close-sysmon-dp1", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-sysmon" }, button: "primary" });
      timeline.advance("sysmon-close-settle", 350);
      timeline.step({
        id: "status-after-second-click", op: "service.emit", channel: "control.message",
        value: {
          args: ["status"],
          reply: { text: "{\"publicStatus\":\"ready\",\"hostStatus\":\"ready\",\"themeDark\":true,\"daemonVersion\":\"0.1.0-preview\",\"monitors\":[\"DP-1\",\"HDMI-A-1\"],\"activePanel\":null}" },
        },
      });

      // 3. Re-open on DP-1 then click bar-sysmon on HDMI-A-1 -> cross-monitor anchor switch (stays open)
      timeline.step({ id: "reopen-sysmon-dp1", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-sysmon" }, button: "primary" });
      timeline.advance("sysmon-reopen-settle", 400);
      timeline.step({ id: "switch-sysmon-hdmi", op: "pointer.click", target: { surface: "bar-hdmi-a-1", testId: "bar-sysmon" }, button: "primary" });
      timeline.advance("sysmon-hdmi-settle", 400);
      timeline.step({ id: "capture-sysmon-hdmi", op: "capture", surface: "panel-system-monitor", captureId: "sysmon-popover-hdmi" });

      // 4. Panel mutual exclusion: Calendar -> Media -> QuickSettings -> back to System Monitor
      timeline.step({ id: "mutex-calendar", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-clock" }, button: "primary" });
      timeline.advance("mutex-cal-settle", 350);
      timeline.step({ id: "mutex-media", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-media" }, button: "primary" });
      timeline.advance("mutex-media-settle", 350);
      timeline.step({ id: "mutex-qs", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-audio" }, button: "primary" });
      timeline.advance("mutex-qs-settle", 350);
      timeline.step({ id: "mutex-sysmon", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-sysmon" }, button: "primary" });
      timeline.advance("mutex-sysmon-settle", 400);

      // 5. Open 22J detailed window from 04C primary button (auto-closes popover)
      timeline.step({ id: "open-detailed-win", op: "pointer.click", target: { surface: "panel-system-monitor", testId: "sysmon-open-detailed" }, button: "primary" });
      timeline.advance("win-open-settle", 450);
      timeline.step({ id: "capture-win-overview", op: "capture", surface: "system-monitor-window", captureId: "sysmon-window-overview" });

      // 6. Switch time-range segmented control: 60s -> 5m -> 15m (distinct fixture curves -> pixel diff check)
      timeline.step({ id: "select-5m", op: "pointer.click", target: { surface: "system-monitor-window", testId: "sysmon-range-5m" }, button: "primary" });
      timeline.advance("range-5m-settle", 350);
      timeline.step({ id: "capture-win-5m", op: "capture", surface: "system-monitor-window", captureId: "sysmon-window-5m" });

      timeline.step({ id: "select-15m", op: "pointer.click", target: { surface: "system-monitor-window", testId: "sysmon-range-15m" }, button: "primary" });
      timeline.advance("range-15m-settle", 350);
      timeline.step({ id: "capture-win-15m", op: "capture", surface: "system-monitor-window", captureId: "sysmon-window-15m" });

      // 7. Navigate all 4 dedicated hardware category views
      timeline.step({ id: "nav-cpu", op: "pointer.click", target: { surface: "system-monitor-window", testId: "sysmon-nav-cpu" }, button: "primary" });
      timeline.advance("nav-cpu-settle", 300);
      timeline.step({ id: "capture-win-cpu", op: "capture", surface: "system-monitor-window", captureId: "sysmon-window-cpu" });

      timeline.step({ id: "nav-memory", op: "pointer.click", target: { surface: "system-monitor-window", testId: "sysmon-nav-memory" }, button: "primary" });
      timeline.advance("nav-memory-settle", 300);
      timeline.step({ id: "capture-win-memory", op: "capture", surface: "system-monitor-window", captureId: "sysmon-window-memory" });

      timeline.step({ id: "nav-gpu", op: "pointer.click", target: { surface: "system-monitor-window", testId: "sysmon-nav-gpu" }, button: "primary" });
      timeline.advance("nav-gpu-settle", 300);
      timeline.step({ id: "capture-win-gpu", op: "capture", surface: "system-monitor-window", captureId: "sysmon-window-gpu" });

      timeline.step({ id: "nav-storage", op: "pointer.click", target: { surface: "system-monitor-window", testId: "sysmon-nav-storage" }, button: "primary" });
      timeline.advance("nav-storage-settle", 300);
      timeline.step({ id: "capture-win-storage", op: "capture", surface: "system-monitor-window", captureId: "sysmon-window-storage" });

      // 8. Close 22J window and immediately re-open via pop-out icon button -> single-instance lifecycle check
      timeline.step({ id: "close-win", op: "pointer.click", target: { surface: "system-monitor-window", testId: "sysmon-window-close" }, button: "primary" });
      timeline.advance("close-win-settle", 120);
      timeline.step({ id: "reopen-popover-for-popout", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-sysmon" }, button: "primary" });
      timeline.advance("reopen-popover-settle", 350);
      timeline.step({ id: "click-popout-icon", op: "pointer.click", target: { surface: "panel-system-monitor", testId: "sysmon-popout" }, button: "primary" });
      timeline.advance("reopen-win-settle", 400);
      timeline.step({ id: "capture-win-reopened", op: "capture", surface: "system-monitor-window", captureId: "sysmon-window-reopened" });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-sysmon",
        initialTopics: {
          "wayland.outputs": {
            capability: "connected",
            outputs: [
              {
                output_instance_id: 1, name: "DP-1", description: "Primary", make: "Test", model: "1440x900",
                x: 0, y: 0, width: 1440, height: 900, mode_width: 1440, mode_height: 900, refresh_mhz: 60000, scale: 1,
                physical_width_mm: null, physical_height_mm: null,
              },
              {
                output_instance_id: 2, name: "HDMI-A-1", description: "Secondary", make: "Test", model: "1280x720",
                x: 1440, y: 0, width: 1280, height: 720, mode_width: 1280, mode_height: 720, refresh_mhz: 60000, scale: 1,
                physical_width_mm: null, physical_height_mm: null,
              },
            ],
          },
          "wayland.workspaces": {
            capability: "connected",
            groups: [
              { group_id: 1, output_instance_ids: [1] },
              { group_id: 2, output_instance_ids: [2] },
            ],
            workspaces: [
              { workspace_id: 1, group_id: 1, name: "1", id_str: "1", coordinates: [1], active: true, urgent: false, hidden: false, capabilities: ["activate"] },
              { workspace_id: 2, group_id: 2, name: "2", id_str: "2", coordinates: [1], active: true, urgent: false, hidden: false, capabilities: ["activate"] },
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
              metadata: { title: "Ambient Flow", artists: ["Synth"], album: "Focus", length_us: 240_000_000 },
            }],
          },
          "system.audio": {
            availability: "available",
            default_sink: "speakers",
            default_source: null,
            sinks: [{ index: 1, name: "speakers", description: "Speakers", volume: 0.6, muted: false, channels: 2 }],
            sources: [],
            sink_inputs: [],
            source_outputs: [],
          },
          "system.power": {
            available: true,
            on_ac: false,
            battery: {
              percentage: 84,
              state: "discharging",
              time_to_empty_seconds: 15_000,
              time_to_full_seconds: null,
              energy_rate_watts: 18.4,
              capacity_percent: 96,
              charge_cycles: 95,
            },
            profiles: { available: true, active_profile: "balanced", profiles: ["performance", "balanced", "power-saver"] },
          },
          "system.telemetry": makeSampleTelemetrySnapshot(),
        },
      }), null, 2));

      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-sysmon",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(published.dist, fixture, scenario, out);
      expectCleanPreview(result, 11, 0);

      // 1. Horizontal bar trigger geometry
      const barCap = readCapture(out, "bar-dp-1", "bar-sysmon-horizontal");
      const barTrigger = treeNode(barCap.tree, "bar-sysmon").boundsLogical!;
      expect(barTrigger.height, "horizontal floating bar-sysmon is 32px tall").toBeCloseTo(32, 0);
      expect(treeNode(barCap.tree, "bar-sysmon-cpu").text).toBe("24%");
      expect(treeNode(barCap.tree, "bar-sysmon-ram").text).toBe("36%");

      // 2. 04C Popover geometry, transparency, shadow bleed, zero-scroll, hit targets >= 24px
      const pop = readCapture(out, "panel-system-monitor", "sysmon-popover");
      const popCard = treeNode(pop.tree, "panel-root-system-monitor").boundsLogical!;
      expect(popCard.width, "04C popover matches 396px standard tier").toBeCloseTo(396, 1);
      expect(maxRowAlpha(pop.image, 0), "04C top shadow bleed fades cleanly").toBeLessThanOrEqual(8);
      expect(maxColAlpha(pop.image, 0), "04C left shadow bleed fades cleanly").toBeLessThanOrEqual(8);
      expect(pixel(pop.image, 0, 0)[3], "04C transparent popup outer corner").toBe(0);
      const popScroll = treeNode(pop.tree, "panel-system-monitor");
      if (popScroll.scrollMetrics) {
        expect(popScroll.scrollMetrics.overflowY, "04C popover fits with zero vertical scroll").toBe(false);
      }
      expect(treeNode(pop.tree, "sysmon-poll-pill").boundsLogical).toBeDefined();
      expect(treeNode(pop.tree, "sysmon-popover-battery").text).toBe("Battery 84% · 18.4 W");
      expect(treeNode(pop.tree, "sysmon-tile-gpu").boundsLogical).toBeDefined();
      expect(treeNode(pop.tree, "sysmon-tile-thermal").boundsLogical).toBeDefined();
      expect(treeNode(pop.tree, "sysmon-tile-network").boundsLogical).toBeDefined();
      expect(treeNode(pop.tree, "sysmon-tile-disk").boundsLogical).toBeDefined();

      // Cross-monitor popover rendered cleanly on HDMI-A-1
      const popHdmi = readCapture(out, "panel-system-monitor", "sysmon-popover-hdmi");
      expect(treeNode(popHdmi.tree, "panel-root-system-monitor").boundsLogical?.width).toBeCloseTo(396, 1);

      // 3. 22J Window Overview: 820x600 opaque edge-to-edge, zero-scroll, hit targets >= 24px
      const winOverview = readCapture(out, "system-monitor-window", "sysmon-window-overview");
      expect(winOverview.image.width).toBe(820);
      expect(winOverview.image.height).toBe(600);
      for (const [cx, cy] of [[0, 0], [819, 0], [0, 599], [819, 599]] as const) {
        expect(pixel(winOverview.image, cx, cy)[3], `22J corner (${cx},${cy}) must be opaque`).toBe(255);
      }
      const winScroll = treeNode(winOverview.tree, "sysmon-content-scroll");
      if (winScroll.scrollMetrics) {
        expect(winScroll.scrollMetrics.overflowY, "22J Overview fits 820x600 with zero vertical scroll").toBe(false);
      }
      for (const node of winOverview.tree.nodes) {
        if (!node.role || !interactiveRoles.has(node.role) || !node.boundsLogical) continue;
        expect(node.boundsLogical.width, `22J hit target width ${node.testId ?? node.name}`).toBeGreaterThanOrEqual(24);
        expect(node.boundsLogical.height, `22J hit target height ${node.testId ?? node.name}`).toBeGreaterThanOrEqual(24);
      }

      // 4. Time-range curve switching produces distinct rendered chart pixels (60s vs 5m vs 15m)
      const win5m = readCapture(out, "system-monitor-window", "sysmon-window-5m");
      const win15m = readCapture(out, "system-monitor-window", "sysmon-window-15m");
      const cpuChartBounds = treeNode(winOverview.tree, "sysmon-win-cpu-chart").boundsDevice!;
      expect(
        diffRegionPixels(winOverview.image, win5m.image, cpuChartBounds),
        "switching 60s -> 5m visibly changes rendered CPU history curve pixels",
      ).toBeGreaterThan(40);
      expect(
        diffRegionPixels(win5m.image, win15m.image, cpuChartBounds),
        "switching 5m -> 15m visibly changes rendered CPU history curve pixels",
      ).toBeGreaterThan(40);

      // 5. All 4 hardware subviews & single-instance reopen
      expect(treeNode(readCapture(out, "system-monitor-window", "sysmon-window-cpu").tree, "sysmon-cpu-pane").boundsLogical).toBeDefined();
      expect(treeNode(readCapture(out, "system-monitor-window", "sysmon-window-memory").tree, "sysmon-memory-pane").boundsLogical).toBeDefined();
      expect(treeNode(readCapture(out, "system-monitor-window", "sysmon-window-gpu").tree, "sysmon-gpu-pane").boundsLogical).toBeDefined();
      expect(treeNode(readCapture(out, "system-monitor-window", "sysmon-window-storage").tree, "sysmon-storage-pane").boundsLogical).toBeDefined();
      const winReopened = readCapture(out, "system-monitor-window", "sysmon-window-reopened");
      expect(treeNode(winReopened.tree, "sysmon-overview-pane").boundsLogical).toBeDefined();
    } finally {
      cleanup();
    }
  }, 30_000);

  previewTest("L4 System Monitor Vertical Split Dual-Arc Trigger, Light Mode & Degraded Hardware (No GPU / No Battery / Legacy)", () => {
    const lightScheme = {
      surface: "#F9F9FF",
      surface_dim: "#D9DAE0",
      surface_bright: "#F9F9FF",
      surface_container_lowest: "#FFFFFF",
      surface_container_low: "#F3F3FA",
      surface_container: "#EDEDF4",
      surface_container_high: "#E7E8EE",
      surface_container_highest: "#E1E2E9",
      on_surface: "#191C20",
      on_surface_variant: "#43474E",
      inverse_surface: "#2E3036",
      inverse_on_surface: "#F0F0F7",
      outline: "#74777F",
      outline_variant: "#C3C6CF",
      scrim: "#000000",
      primary: "#3C6090",
      on_primary: "#FFFFFF",
      primary_container: "#D4E3FF",
      on_primary_container: "#224876",
      secondary: "#545F71",
      on_secondary: "#FFFFFF",
      secondary_container: "#D8E3F8",
      on_secondary_container: "#3D4758",
      tertiary: "#6D5677",
      on_tertiary: "#FFFFFF",
      tertiary_container: "#F6D9FF",
      on_tertiary_container: "#543F5E",
      error: "#BA1A1A",
      on_error: "#FFFFFF",
      error_container: "#FFDAD6",
      on_error_container: "#93000A",
    } as const;

    // --- Sub-run 1: Vertical 40x40 Split Dual-Arc + Light Mode 04C & 22J ---
    const vRun = createPreviewWorkspace("z-shell-preview-design-sysmon-variants-");
    try {
      const fixture = join(vRun.workspace, "fixture.json");
      const scenario = join(vRun.workspace, "scenario.json");
      const monitor = { id: "DP-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900, scale: 1 };

      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 250);
      timeline.step({ id: "ready", op: "settle" });
      timeline.step({ id: "capture-bar-left-sysmon", op: "capture", surface: "bar-dp-1", captureId: "bar-left-sysmon" });

      // Click vertical 40x40 split dual-arc trigger -> opens Light Mode 04C popover
      timeline.step({ id: "click-vertical-sysmon", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-sysmon" }, button: "primary" });
      timeline.advance("vertical-popover-settle", 450);
      timeline.step({ id: "capture-popover-light", op: "capture", surface: "panel-system-monitor", captureId: "sysmon-popover-light" });

      // Pop out to Light Mode 22J window
      timeline.step({ id: "open-win-light", op: "pointer.click", target: { surface: "panel-system-monitor", testId: "sysmon-popout" }, button: "primary" });
      timeline.advance("win-light-settle", 450);
      timeline.step({ id: "capture-win-light", op: "capture", surface: "system-monitor-window", captureId: "sysmon-window-light" });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-sysmon-variants",
        initialTopics: {
          theme: { dark: false, variant: "tonal", backend: "builtin", last_error: null, scheme: lightScheme },
          settings: {
            general: { offline_mode: false, log_level: "info" },
            bar: {
              position: "left",
              style: "floating",
              gaps: 14,
              edge_overrides: { top: null, right: null, bottom: null, left: null },
              launcher_enabled: true,
              dock_enabled: false,
              clock_24h: true,
              clock_seconds: false,
            },
            theme: { mode: "light", variant: "tonal", seed_color: null, backend: "builtin", gtk_linking: false },
            ime: { mode: "indicator_only", candidate_layout: "auto", switch_osd: true },
            polkit: { enabled: true },
            wallpaper: { directories: [], fit: "cover", sync_theme: true, slideshow_seconds: 300 },
            pre_action_fade_seconds: 0,
            configured_plugins: [],
          },
          "wayland.outputs": {
            capability: "connected",
            outputs: [{
              output_instance_id: 1, name: "DP-1", description: "Vertical Light Monitor", make: "Test", model: "1440x900",
              x: 0, y: 0, width: 1440, height: 900, mode_width: 1440, mode_height: 900, refresh_mhz: 60000, scale: 1,
              physical_width_mm: null, physical_height_mm: null,
            }],
          },
          "wayland.workspaces": {
            capability: "connected",
            groups: [{ group_id: 1, output_instance_ids: [1] }],
            workspaces: [
              { workspace_id: 1, group_id: 1, name: "1", id_str: "1", coordinates: [1], active: true, urgent: false, hidden: false, capabilities: ["activate"] },
            ],
          },
          "system.power": {
            available: true,
            on_ac: true,
            battery: {
              percentage: 92,
              state: "charging",
              time_to_empty_seconds: null,
              time_to_full_seconds: 1200,
              energy_rate_watts: null,
              capacity_percent: 98,
              charge_cycles: 40,
            },
            profiles: { available: true, active_profile: "balanced", profiles: ["performance", "balanced", "power-saver"] },
          },
          "system.telemetry": makeSampleTelemetrySnapshot(),
        },
      }), null, 2));

      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-sysmon-variants",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(published.dist, fixture, scenario, vRun.out);
      expectCleanPreview(result, 3, 0);

      const vBar = readCapture(vRun.out, "bar-dp-1", "bar-left-sysmon");
      const vTrigger = treeNode(vBar.tree, "bar-sysmon").boundsLogical!;
      expect(vTrigger.width, "vertical floating bar-sysmon is 40px wide").toBeCloseTo(40, 0);
      expect(vTrigger.height, "vertical floating bar-sysmon is 40px tall").toBeCloseTo(40, 0);

      const lightPop = readCapture(vRun.out, "panel-system-monitor", "sysmon-popover-light");
      expect(treeNode(lightPop.tree, "panel-root-system-monitor").boundsLogical?.width).toBeCloseTo(396, 1);
      // Unknown energy_rate_watts must omit watts rather than printing "0 W"
      expect(treeNode(lightPop.tree, "sysmon-popover-battery").text).toBe("Battery 92%");

      const lightWin = readCapture(vRun.out, "system-monitor-window", "sysmon-window-light");
      expect(lightWin.image.width).toBe(820);
      expect(lightWin.image.height).toBe(600);
      expect(pixel(lightWin.image, 0, 0)[3]).toBe(255);
      expect(pixel(lightWin.image, 819, 599)[3]).toBe(255);
    } finally {
      vRun.cleanup();
    }

    // --- Sub-run 2: Degraded Desktop Hardware (No Battery, No GPU, Legacy Snapshot) ---
    const dRun = createPreviewWorkspace("z-shell-preview-design-sysmon-degraded-");
    try {
      const fixture = join(dRun.workspace, "fixture.json");
      const scenario = join(dRun.workspace, "scenario.json");
      const monitor = { id: "DP-1", name: "DP-1", x: 0, y: 0, width: 1440, height: 900, scale: 1 };

      const timeline = createVirtualTimeline();
      timeline.step({ id: "outputs", op: "monitors.set", monitors: [monitor] });
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });
      timeline.step({ id: "open-degraded-popover", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-sysmon" }, button: "primary" });
      timeline.advance("degraded-pop-settle", 450);
      timeline.step({ id: "capture-degraded-popover", op: "capture", surface: "panel-system-monitor", captureId: "sysmon-popover-degraded" });
      timeline.step({ id: "open-degraded-win", op: "pointer.click", target: { surface: "panel-system-monitor", testId: "sysmon-open-detailed" }, button: "primary" });
      timeline.advance("degraded-win-settle", 450);
      timeline.step({ id: "capture-degraded-win", op: "capture", surface: "system-monitor-window", captureId: "sysmon-window-degraded" });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-sysmon-degraded",
        initialTopics: {
          "wayland.outputs": {
            capability: "connected",
            outputs: [{
              output_instance_id: 1, name: "DP-1", description: "Desktop No Battery No GPU", make: "Test", model: "1440x900",
              x: 0, y: 0, width: 1440, height: 900, mode_width: 1440, mode_height: 900, refresh_mhz: 60000, scale: 1,
              physical_width_mm: null, physical_height_mm: null,
            }],
          },
          "system.power": {
            available: true,
            on_ac: true,
            battery: null,
            profiles: { available: false, active_profile: null, profiles: [] },
          },
          "system.telemetry": makeSampleTelemetrySnapshot({ legacy: true, includeGpu: false }),
        },
      }), null, 2));

      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-sysmon-degraded",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(published.dist, fixture, scenario, dRun.out);
      expectCleanPreview(result, 2, 0);

      const degPop = readCapture(dRun.out, "panel-system-monitor", "sysmon-popover-degraded");
      expect(degPop.tree.nodes.some(n => n.testId === "sysmon-popover-battery"), "no battery footer on desktop").toBe(false);
      expect(degPop.tree.nodes.some(n => n.testId === "sysmon-tile-gpu"), "no GPU tile when GPU absent").toBe(false);
      expect(degPop.tree.nodes.some(n => n.testId === "sysmon-poll-pill"), "no unverified cadence pill on legacy snapshot").toBe(false);
      expect(degPop.tree.nodes.some(n => n.testId === "sysmon-popover-cpu-chart"), "no fabricated chart on legacy snapshot").toBe(false);

      const degWin = readCapture(dRun.out, "system-monitor-window", "sysmon-window-degraded");
      expect(degWin.tree.nodes.some(n => n.testId === "sysmon-nav-gpu"), "no GPU nav tab when GPU absent").toBe(false);
      expect(degWin.tree.nodes.some(n => n.testId === "sysmon-range-60s"), "no range segmented control when history absent").toBe(false);
      expect(treeNode(degWin.tree, "sysmon-sidebar-status").text).toBe("Live snapshot");
    } finally {
      dRun.cleanup();
    }
  }, 30_000);
});
