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

      // Overview card width (684px) and interactive workspaces + windows.
      expect(Math.round(treeNode(overview.tree, "overview-card").boundsLogical!.width)).toBe(684);
      expect(treeNode(overview.tree, "overview-ws-2").boundsLogical).toBeDefined();

      // Slider fill-to-thumb alignment on wide Settings slider (Tiling gap = 14px -> 22% on 448px track):
      // fill must end at thumb center without poking past the thumb's right edge.
      {
        const gapSlider = settingsBar.tree.nodes.find(node => node.role === "slider" && node.name === "Tiling gap");
        expect(gapSlider?.boundsDevice, "settings-bar Tiling gap slider").toBeDefined();
        const bounds = gapSlider!.boundsDevice!;
        const midY = Math.round(bounds.y + bounds.height / 2);
        const pct = Math.round((14 / 64) * 100) / 100;
        const thumbCenterX = bounds.x + 7 + pct * (bounds.width - 14);
        const filledSample = pixel(settingsBar.image, Math.round(bounds.x + 20), midY);
        const unfilledSample = pixel(settingsBar.image, Math.round(bounds.x + bounds.width - 20), midY);
        expect(filledSample).not.toEqual(unfilledSample);
        // Center of thumb is filled primary; 10px past thumb center (3px outside thumb right edge) is unfilled track.
        expect(pixel(settingsBar.image, Math.round(thumbCenterX), midY), "thumb center filled").toEqual(filledSample);
        expect(pixel(settingsBar.image, Math.round(thumbCenterX + 10), midY), "no fill overhang past thumb").toEqual(unfilledSample);
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
      ] as const) {
        const node = treeNode(capture.tree, testId);
        if (node.scrollMetrics) {
          expect(node.scrollMetrics.overflowY, `${label} overflowY`).toBe(false);
        }
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

      // Docked top bar is flush 38px without floating shadow bleed.
      expect([barDocked.image.width, barDocked.image.height]).toEqual([1440, 38]);

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

      // Polkit 23 card width (360px) and >= 24px interactive hit targets.
      expect(Math.round(treeNode(polkit.tree, "polkit-card").boundsLogical!.width)).toBe(360);
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
      timeline.advance("daemon-events", 30);
      timeline.step({ id: "ready", op: "settle" });
      timeline.step({ id: "capture-left-bar", op: "capture", surface: "bar-dp-1", captureId: "bar-left" });
      timeline.step({ id: "open-left-qs", op: "pointer.click", target: { surface: "bar-dp-1", testId: "bar-audio" }, button: "primary" });
      timeline.advance("left-qs-settle", 450);
      timeline.step({ id: "capture-left-qs", op: "capture", surface: "panel-quick-settings", captureId: "qs-left" });

      writeFileSync(fixture, JSON.stringify(buildShellPreviewFixture({
        id: "z-shell-design-vertical-left-bar",
        initialTopics: {
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
      }), null, 2));
      writeFileSync(scenario, JSON.stringify({
        schemaVersion: 1,
        id: "z-shell-design-vertical-left-bar",
        requiredCapabilities: ["pixels", "capture.transparent", "surface.multiple", "virtual-time"],
        steps: timeline.steps,
      }, null, 2));

      const result = runPreview(published.dist, fixture, scenario, out);
      expectCleanPreview(result, 2, 0);
      const barLeft = readCapture(out, "bar-dp-1", "bar-left");
      const qsLeft = readCapture(out, "panel-quick-settings", "qs-left");

      // Floating left bar is 76px wide (40px pill + shadow bleed) with transparent corner.
      expect([barLeft.image.width, barLeft.image.height]).toEqual([76, 896]);
      expect(pixel(barLeft.image, 0, 0)).toEqual([0, 0, 0, 0]);
      // Control Center opens cleanly at 396px width anchored from the bottom-left status island.
      expect(Math.round(treeNode(qsLeft.tree, "panel-root-quick-settings").boundsLogical!.width)).toBe(396);
      expect(pixel(qsLeft.image, 0, 0)).toEqual([0, 0, 0, 0]);
    } finally {
      cleanup();
    }
  }, 30_000);
});
