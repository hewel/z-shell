import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

import { buildShellApplication } from "@z-shell/composer";

const shellDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(shellDir, "../..");
const zguiRoot = resolve(repoRoot, "../zgui-js");
const nativeHost = join(zguiRoot, "target/debug/native-host");
const previewAvailable = Bun.which("nix-shell") !== null && existsSync(nativeHost);
const previewTest = previewAvailable ? test : test.skip;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function pngRgba(file: string) {
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

describe("apps/shell preview", () => {
  previewTest("builds apps/shell via @z-shell/composer and passes transparent headless zgui-preview with live theme & clean teardown", async () => {
    expect(Bun.which("nix-shell")).not.toBeNull();
    expect(existsSync(nativeHost)).toBe(true);

    const published = await buildShellApplication({ app: "shell", appDirectory: shellDir });
    expect(published.manifest.id).toBe("dev.zshell.shell");
    expect(published.manifest.capabilities?.sessionLock).toBe(true);
    expect(published.manifest.capabilities?.namedSockets).toContain("niri");
    expect(published.manifest.capabilities?.unixSockets).toContain(
      "$XDG_RUNTIME_DIR/z-shell/bus-${WAYLAND_DISPLAY}.sock",
    );
    expect(published.manifest.capabilities?.unixSockets).toContain(
      "$XDG_RUNTIME_DIR/z-shell/host-${WAYLAND_DISPLAY}.sock",
    );

    const out = mkdtempSync(join(tmpdir(), "z-shell-preview-"));
    try {
      const args = [
        nativeHost, "preview", "run",
        "--bundle", published.dist,
        "--profile", join(shellDir, "preview/profile.json"),
        "--fixture", join(shellDir, "preview/fixture.json"),
        "--scenario", join(shellDir, "preview/scenario.json"),
        "--out", out,
      ];
      const preview = spawnSync("nix-shell", ["--run", args.map(shellQuote).join(" ")], {
        cwd: zguiRoot,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(preview.error).toBeUndefined();
      expect(preview.status, preview.stderr).toBe(0);
      const result = JSON.parse(preview.stdout);
      expect(result.exitCode).toBe(0);
      expect(result.status).toBe("passed");
      expect(result.captureCount).toBe(1);
      expect(result.assertions.passed).toBe(1);
      expect(result.assertions.failed).toBe(0);
      expect(result.teardown.clean).toBe(true);
      for (const count of Object.values(result.teardown.resources)) {
        if (typeof count === "number") expect(count).toBe(0);
      }
      expect(result.teardown.resources.engineAlive).toBe(false);

      const capture = join(out, "captures/surfaces/bar-dp-1/bar-initial");
      const frame = JSON.parse(readFileSync(`${capture}.frame.json`, "utf8"));
      const tree = JSON.parse(readFileSync(`${capture}.tree.json`, "utf8"));
      const image = pngRgba(`${capture}.png`);
      expect(frame.renderer.alphaMode).toBe("PreMultiplied");
      expect([image.width, image.height]).toEqual([1440, 48]);

      const pixel = (x: number, y: number) => {
        const offset = (y * image.width + x) * 4;
        return Array.from(image.data.subarray(offset, offset + 4));
      };
      expect(pixel(4, 4)).toEqual([0, 0, 0, 0]);
      expect(pixel(1435, 44)).toEqual([0, 0, 0, 0]);

      const status = tree.nodes.find((node: { testId?: string }) => node.testId === "daemon-status");
      expect(status?.text).toBe("ready");
      const swatch = tree.nodes.find((node: { testId?: string }) => node.testId === "theme-accent");
      expect(swatch?.boundsDevice).toBeDefined();
      const bounds = swatch.boundsDevice;
      expect(pixel(
        Math.floor(bounds.x + bounds.width / 2),
        Math.floor(bounds.y + bounds.height / 2),
      )).toEqual([0x7d, 0xd3, 0xfc, 255]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
