import { beforeAll, describe, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PublishedApplication } from "@hewel/zgui-build";
import { buildShellPreviewFixture, makeSolidPngBytes } from "./fixture-builder.ts";
import {
  assertRoundedBlurStrips,
  assertSameBounds,
  buildPublishedShell,
  createPreviewWorkspace,
  createVirtualTimeline,
  diffRegionPixels,
  expectCleanPreview,
  maxRowAlpha,
  pixel,
  pixelChannelDiff,
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

      // Rounded Surface Corner Guard: transparent rounded PopupSurface corners must remain pure transparent.
      for (const [label, capture] of [
        ["quick-settings", qs],
        ["quick-settings-battery", qsBattery],
        ["calendar", cal],
        ["media", media],
      ] as const) {
        const w = capture.image.width - 1;
        const h = capture.image.height - 1;
        expect(pixel(capture.image, 0, 0), `${label} top-left corner transparent`).toEqual([0, 0, 0, 0]);
        expect(pixel(capture.image, w, 0), `${label} top-right corner transparent`).toEqual([0, 0, 0, 0]);
        expect(pixel(capture.image, 0, h), `${label} bottom-left corner transparent`).toEqual([0, 0, 0, 0]);
        expect(pixel(capture.image, w, h), `${label} bottom-right corner transparent`).toEqual([0, 0, 0, 0]);
        // Declarative ext_background_effect_v1 blurRegion: <=45 strictly interior strips, zero corner leak.
        assertRoundedBlurStrips(
          capture.frame.blurRegion,
          { x: 0, y: 0, width: capture.image.width, height: capture.image.height },
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
          node => node.role === "button" && node.boundsLogical && Math.round(node.boundsLogical.width) === 44 && Math.round(node.boundsLogical.height) === 24,
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

      // Settled surface width tiers and Zero-Scroll auto-height match DESIGN.md.
      expect(Math.round(treeNode(qs.tree, "panel-root-quick-settings").boundsLogical!.width)).toBe(396);
      expect(qs.image.height).toBeLessThanOrEqual(760);
      expect(Math.round(treeNode(qsBattery.tree, "panel-root-quick-settings").boundsLogical!.width)).toBe(396);
      expect(treeNode(qsBattery.tree, "qs-page-battery").boundsLogical).toBeDefined();
      expect(qsBattery.image.height).toBeLessThanOrEqual(760);
      expect(Math.round(treeNode(cal.tree, "panel-root-calendar").boundsLogical!.width)).toBe(396);
      expect(cal.image.height).toBeLessThanOrEqual(760);
      expect(Math.round(treeNode(media.tree, "panel-root-media").boundsLogical!.width)).toBe(396);
      expect(media.image.height).toBeLessThanOrEqual(420);
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
      // with all 4 rounded corners intact and bottom row fully inside surface bounds.
      expect(trayMenuLong.image.width, "tray-menu widens for long nested labels").toBeGreaterThanOrEqual(270);
      expect(trayMenuLong.image.width, "tray-menu bounded within compact 360px tier").toBeLessThanOrEqual(360);
      expect(trayMenuLong.image.height, "tray-menu expands past old 340px clip").toBeGreaterThan(360);
      {
        const w = trayMenuLong.image.width - 1;
        const h = trayMenuLong.image.height - 1;
        expect(pixel(trayMenuLong.image, 0, 0), "tray-menu top-left transparent").toEqual([0, 0, 0, 0]);
        expect(pixel(trayMenuLong.image, w, 0), "tray-menu top-right transparent").toEqual([0, 0, 0, 0]);
        expect(pixel(trayMenuLong.image, 0, h), "tray-menu bottom-left transparent").toEqual([0, 0, 0, 0]);
        expect(pixel(trayMenuLong.image, w, h), "tray-menu bottom-right transparent").toEqual([0, 0, 0, 0]);
        const lastItem = treeNode(trayMenuLong.tree, "tray-menu-item-10").boundsLogical!;
        expect(lastItem.y + lastItem.height, "last tray menu item fully inside surface").toBeLessThanOrEqual(trayMenuLong.image.height - 6);
        assertRoundedBlurStrips(
          trayMenuLong.frame.blurRegion,
          { x: 0, y: 0, width: trayMenuLong.image.width, height: trayMenuLong.image.height },
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
      const qsBg = pixel(qsLight.image, 10, 10);
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
      //    (surface-container-high, never active primary-container), and null-avatar rosette renders fallback person visibly.
      const wifiTile = treeNode(qsChaos.tree, "qs-tile-wifi");
      expect(wifiTile.state?.checked, "disconnected Wi-Fi must not report active checked state").not.toBe(true);
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
      expectCleanPreview(result, 19, 0);

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
});
