import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

import { buildShellApplication } from "@z-shell/composer";
import type { PublishedApplication } from "@hewel/zgui-build";
import { buildShellPreviewFixture } from "./fixture-builder.ts";

const shellDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(shellDir, "../..");
const zguiRoot = resolve(repoRoot, "../zgui-js");
const nativeHost = join(zguiRoot, "target/debug/native-host");
const previewAvailable = Bun.which("nix-shell") !== null && existsSync(nativeHost);
const previewTest = previewAvailable ? test : test.skip;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

function pngRgba(file: string): DecodedPng {
  const bytes = readFileSync(file);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`Invalid PNG signature: ${file}`);
  }
  let width = 0;
  let height = 0;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      if (chunk[8] !== 8 || chunk[9] !== 6 || chunk[12] !== 0) {
        throw new Error("Expected non-interlaced 8-bit RGBA PNG");
      }
    } else if (type === "IDAT") chunks.push(chunk);
    offset += length + 12;
    if (type === "IEND") break;
  }
  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(chunks));
  if (!width || !height || raw.length !== (stride + 1) * height) {
    throw new Error(`Invalid PNG data: ${file}`);
  }
  const data = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const a = x >= 4 ? data[index - 4]! : 0;
      const b = y ? data[index - stride]! : 0;
      const c = y && x >= 4 ? data[index - stride - 4]! : 0;
      const prediction = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b
        : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c);
      data[index] = (raw[y * (stride + 1) + 1 + x]! + prediction) & 255;
    }
  }
  return { width, height, data };
}

interface PreviewResult {
  readonly exitCode: number;
  readonly status: string;
  readonly captureCount: number;
  readonly assertions: { readonly passed: number; readonly failed: number };
  readonly teardown: {
    readonly clean: boolean;
    readonly resources: Record<string, number | boolean | undefined>;
  };
}

interface DeviceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface PreviewTreeNode {
  readonly testId?: string;
  readonly text?: string;
  readonly boundsDevice?: DeviceBounds;
}

function runPreview(fixture: string, scenario: string, out: string): PreviewResult {
  const args = [
    nativeHost, "preview", "run",
    "--bundle", published.dist,
    "--profile", join(shellDir, "preview/profile.json"),
    "--fixture", fixture,
    "--scenario", scenario,
    "--out", out,
  ];
  const preview = spawnSync("nix-shell", ["--run", args.map(shellQuote).join(" ")], {
    cwd: zguiRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(preview.error).toBeUndefined();
  expect(preview.status, `${preview.stderr}\n${preview.stdout}`).toBe(0);
  return JSON.parse(preview.stdout) as PreviewResult;
}

function expectCleanPreview(result: PreviewResult, captureCount: number, assertionCount: number) {
  expect(result.exitCode).toBe(0);
  expect(result.status).toBe("passed");
  expect(result.captureCount).toBe(captureCount);
  expect(result.assertions.passed).toBe(assertionCount);
  expect(result.assertions.failed).toBe(0);
  expect(result.teardown.clean).toBe(true);
  for (const resource of ["timers", "imageHandles", "unixSockets", "shellSurfaces"] as const) {
    expect(result.teardown.resources[resource] ?? 0, resource).toBe(0);
  }
  expect(result.teardown.resources.engineAlive).toBe(false);
  for (const [resource, count] of Object.entries(result.teardown.resources)) {
    if (typeof count === "number") expect(count, resource).toBe(0);
  }
}

function readCapture(out: string, surface: string, captureId: string) {
  const capture = join(out, "captures/surfaces", surface, captureId);
  return {
    frame: JSON.parse(readFileSync(`${capture}.frame.json`, "utf8")) as {
      readonly renderer: { readonly alphaMode: string };
    },
    tree: JSON.parse(readFileSync(`${capture}.tree.json`, "utf8")) as {
      readonly nodes: readonly PreviewTreeNode[];
    },
    image: pngRgba(`${capture}.png`),
  };
}

function treeNode(tree: { readonly nodes: readonly PreviewTreeNode[] }, testId: string): PreviewTreeNode {
  const node = tree.nodes.find(candidate => candidate.testId === testId);
  expect(node, testId).toBeDefined();
  return node!;
}

function pixel(image: DecodedPng, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(offset, offset + 4));
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
    published = await buildShellApplication({ app: "shell", appDirectory: shellDir });
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
    expect(Bun.which("nix-shell")).not.toBeNull();
    expect(existsSync(nativeHost)).toBe(true);

    const workspace = mkdtempSync(join(tmpdir(), "z-shell-preview-top-"));
    const out = join(workspace, "out");
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

      expect([dpBar.image.width, dpBar.image.height]).toEqual([1412, 48]);
      expect([hdmiBar.image.width, hdmiBar.image.height]).toEqual([1252, 48]);
      expect(pixel(dpBar.image, 0, 0)).toEqual([0, 0, 0, 0]);
      expect(pixel(hdmiBar.image, 0, 0)).toEqual([0, 0, 0, 0]);
      expect(centerPixel(dpBar.image, treeNode(dpBar.tree, "ws-2").boundsDevice))
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
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  previewTest("Vertical Bar (position: \"left\") renders 52px layout with transparent corners and clean teardown", () => {
    const workspace = mkdtempSync(join(tmpdir(), "z-shell-preview-left-"));
    const out = join(workspace, "out");
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
      expect([bar.image.width, bar.image.height]).toEqual([52, 872]);
      expect(treeNode(bar.tree, "bar-root-dp-1").boundsDevice?.width).toBe(52);
      expect(treeNode(bar.tree, "ws-2").text).toBe("2");
      expect(pixel(bar.image, 0, 0)).toEqual([0, 0, 0, 0]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
