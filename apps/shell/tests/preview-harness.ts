import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

import { buildShellApplication } from "@z-shell/composer";
import type { PublishedApplication } from "@hewel/zgui-build";

export const shellDir = resolve(import.meta.dir, "..");
export const repoRoot = resolve(shellDir, "../..");
export const zguiRoot = resolve(repoRoot, "../zgui-js");
export const zguiHost = join(zguiRoot, "target/debug/zgui-host");
const hasNixShell = Bun.which("nix-shell") !== null;
export const previewAvailable = existsSync(zguiHost);
export const previewTest = previewAvailable ? test : test.skip;

let cachedBuild: Promise<PublishedApplication> | undefined;

export function buildPublishedShell(): Promise<PublishedApplication> {
  cachedBuild ??= buildShellApplication({ app: "shell", appDirectory: shellDir });
  return cachedBuild;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

export function pngRgba(file: string): DecodedPng {
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

export interface PreviewResult {
  readonly exitCode: number;
  readonly status: string;
  readonly captureCount: number;
  readonly assertions: { readonly passed: number; readonly failed: number };
  readonly teardown: {
    readonly clean: boolean;
    readonly resources: Record<string, number | boolean | undefined>;
  };
}

export interface DeviceBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PreviewScrollMetrics {
  readonly overflowY?: boolean;
  readonly contentHeight?: number;
  readonly viewportHeight?: number;
}

export interface PreviewTreeNode {
  readonly testId?: string;
  readonly role?: string;
  readonly text?: string;
  readonly boundsLogical?: DeviceBounds;
  readonly boundsDevice?: DeviceBounds;
  readonly scrollMetrics?: PreviewScrollMetrics;
}

/**
 * Allocates a workspace directory for preview runs.
 * Set `PREVIEW_OUT_DIR=/path/to/dir` to retain captured PNGs and trees for visual inspection.
 */
export function createPreviewWorkspace(prefix: string): {
  readonly workspace: string;
  readonly out: string;
  readonly cleanup: () => void;
} {
  const keepRoot = process.env.PREVIEW_OUT_DIR?.trim();
  if (keepRoot) {
    const slug = prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "preview";
    const workspace = join(resolve(keepRoot), slug);
    const out = join(workspace, "out");
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    return { workspace, out, cleanup: () => {} };
  }
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  const out = join(workspace, "out");
  return { workspace, out, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

/**
 * Tracks cumulative virtual time across preview scenario steps so fixture command reply
 * timestamps stay aligned automatically when intermediate `clock.advance` steps change.
 */
export function createVirtualTimeline() {
  let elapsedMs = 0;
  const steps: Record<string, unknown>[] = [];
  return {
    get nowMs(): number {
      return elapsedMs;
    },
    get steps(): readonly Record<string, unknown>[] {
      return steps;
    },
    step(entry: Record<string, unknown>): void {
      if (entry.op === "clock.advance" && typeof entry.byMs === "number") {
        elapsedMs += entry.byMs;
      }
      steps.push(entry);
    },
    advance(id: string, byMs: number): void {
      elapsedMs += byMs;
      steps.push({ id, op: "clock.advance", byMs });
    },
    after(offsetMs = 20): number {
      return elapsedMs + offsetMs;
    },
  };
}

export function runPreview(
  bundleDist: string,
  fixture: string,
  scenario: string,
  out: string,
  options?: { readonly profile?: string },
): PreviewResult {
  const args = [
    "preview", "run",
    "--bundle", bundleDist,
    "--profile", options?.profile ?? join(shellDir, "preview/profile.json"),
    "--fixture", fixture,
    "--scenario", scenario,
    "--out", out,
  ];
  const [command, commandArgs] = hasNixShell
    ? ["nix-shell", ["--run", [zguiHost, ...args].map(shellQuote).join(" ")]]
    : [zguiHost, args];
  const preview = spawnSync(command, commandArgs, {
    cwd: zguiRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(preview.error).toBeUndefined();
  expect(preview.status, `${preview.stderr}\n${preview.stdout}`).toBe(0);
  return JSON.parse(preview.stdout) as PreviewResult;
}

export function expectCleanPreview(result: PreviewResult, captureCount: number, assertionCount: number) {
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

export type RecordedBlurRegion = "none" | "full" | readonly DeviceBounds[];

export function readCapture(out: string, surface: string, captureId: string) {
  const capture = join(out, "captures/surfaces", surface, captureId);
  return {
    frame: JSON.parse(readFileSync(`${capture}.frame.json`, "utf8")) as {
      readonly renderer: { readonly alphaMode: string };
      readonly blurRegion?: RecordedBlurRegion;
      readonly windowGeometry?: DeviceBounds;
    },
    tree: JSON.parse(readFileSync(`${capture}.tree.json`, "utf8")) as {
      readonly nodes: readonly PreviewTreeNode[];
    },
    image: pngRgba(`${capture}.png`),
  };
}

export function blurRegionCoversPoint(
  blurRegion: RecordedBlurRegion | undefined,
  x: number,
  y: number,
): boolean {
  if (blurRegion === "full") return true;
  if (!Array.isArray(blurRegion)) return false;
  return blurRegion.some(s => x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height);
}

export function blurRegionIntersectsRect(
  blurRegion: RecordedBlurRegion | undefined,
  rect: DeviceBounds,
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (blurRegion === "full") return true;
  if (!Array.isArray(blurRegion)) return false;
  const rx1 = rect.x + rect.width;
  const ry1 = rect.y + rect.height;
  return blurRegion.some(
    s => s.x < rx1 && s.x + s.width > rect.x && s.y < ry1 && s.y + s.height > rect.y,
  );
}

export interface RoundedBlurStripOptions {
  /** Maximum top-row horizontal inset for superellipse(2.83) tangent coverage (e.g. `14` for R=22px). */
  readonly maxTopInset?: number;
}

/**
 * Verifies that a captured surface publishes integer horizontal blur strips (`<= 256`) strictly
 * contained within `bounds`, covering the full middle span, excluding all four sharp outer corners,
 * and (when `maxTopInset` is given) preserving superellipse tangent interior coverage.
 */
export function assertRoundedBlurStrips(
  blurRegion: RecordedBlurRegion | undefined,
  bounds: DeviceBounds,
  radius: number,
  label: string,
  options?: RoundedBlurStripOptions,
): void {
  expect(Array.isArray(blurRegion), `${label}: blurRegion is rounded strip array`).toBe(true);
  const strips = blurRegion as readonly DeviceBounds[];
  expect(strips.length, `${label}: non-empty blur strips`).toBeGreaterThan(0);
  expect(strips.length, `${label}: blur strips <= 256 protocol cap`).toBeLessThanOrEqual(256);
  const x0 = bounds.x - 1;
  const y0 = bounds.y - 1;
  const x1 = bounds.x + bounds.width + 1;
  const y1 = bounds.y + bounds.height + 1;
  for (const strip of strips) {
    expect(Number.isInteger(strip.x), `${label}: integer strip x`).toBe(true);
    expect(Number.isInteger(strip.y), `${label}: integer strip y`).toBe(true);
    expect(Number.isInteger(strip.width), `${label}: integer strip width`).toBe(true);
    expect(Number.isInteger(strip.height), `${label}: integer strip height`).toBe(true);
    expect(strip.x, `${label}: strip left >= card left`).toBeGreaterThanOrEqual(x0);
    expect(strip.y, `${label}: strip top >= card top`).toBeGreaterThanOrEqual(y0);
    expect(strip.x + strip.width, `${label}: strip right <= card right`).toBeLessThanOrEqual(x1);
    expect(strip.y + strip.height, `${label}: strip bottom <= card bottom`).toBeLessThanOrEqual(y1);
  }
  const midY = Math.floor(bounds.y + bounds.height / 2);
  const midStrips = strips.filter(s => midY >= s.y && midY < s.y + s.height);
  expect(midStrips.length, `${label}: middle band covered at y=${midY}`).toBeGreaterThan(0);
  const midLeft = Math.min(...midStrips.map(s => s.x));
  const midRight = Math.max(...midStrips.map(s => s.x + s.width));
  expect(midLeft, `${label}: middle full-width left aligns with card`).toBeLessThanOrEqual(Math.ceil(bounds.x) + 1);
  expect(midRight, `${label}: middle full-width right aligns with card`).toBeGreaterThanOrEqual(Math.floor(bounds.x + bounds.width) - 1);

  if (radius >= 8) {
    // All four sharp outer bounding-box corners must NOT be covered by any blur strip (zero corner leak).
    const rightCornerX = Math.floor(bounds.x + bounds.width - 0.01);
    const bottomCornerY = Math.floor(bounds.y + bounds.height - 0.01);
    const leftCornerX = Math.floor(bounds.x);
    const topCornerY = Math.floor(bounds.y);
    for (const [corner, cx, cy] of [
      ["top-left", leftCornerX, topCornerY],
      ["top-right", rightCornerX, topCornerY],
      ["bottom-left", leftCornerX, bottomCornerY],
      ["bottom-right", rightCornerX, bottomCornerY],
    ] as const) {
      expect(
        blurRegionCoversPoint(strips, cx, cy),
        `${label}: ${corner} rounded corner (${cx},${cy}) excluded from blurRegion`,
      ).toBe(false);
    }
  }

  if (options?.maxTopInset !== undefined) {
    const minY = Math.min(...strips.map(s => s.y));
    const topStrips = strips.filter(s => s.y === minY);
    const topLeft = Math.min(...topStrips.map(s => s.x));
    const topRight = Math.max(...topStrips.map(s => s.x + s.width));
    const leftInset = topLeft - bounds.x;
    const rightInset = (bounds.x + bounds.width) - topRight;
    expect(minY, `${label}: top strip starts at card top edge`).toBeLessThanOrEqual(Math.ceil(bounds.y) + 1);
    expect(leftInset, `${label}: superellipse top-left tangent inset > 0`).toBeGreaterThan(0);
    expect(leftInset, `${label}: superellipse top-left tangent inset <= ${options.maxTopInset}px`).toBeLessThanOrEqual(options.maxTopInset);
    expect(rightInset, `${label}: superellipse top-right tangent inset > 0`).toBeGreaterThan(0);
    expect(rightInset, `${label}: superellipse top-right tangent inset <= ${options.maxTopInset}px`).toBeLessThanOrEqual(options.maxTopInset);
  }
}

export interface SessionLockSnapshot {
  readonly state: string;
  readonly unlockCount: number;
  readonly coveredOutputs: readonly string[];
  readonly fallbackOutputs: readonly string[];
}

interface PreviewStep {
  readonly id: string;
  readonly result?: {
    readonly surfaces?: readonly string[];
    readonly readiness?: { readonly sessionLock?: SessionLockSnapshot };
  };
}

function previewStep(out: string, stepId: string): PreviewStep {
  const steps = readFileSync(join(out, "steps.jsonl"), "utf8").trim().split("\n")
    .map(line => JSON.parse(line) as PreviewStep);
  const step = steps.find(candidate => candidate.id === stepId);
  expect(step, stepId).toBeDefined();
  return step!;
}

export function previewSurfaces(out: string, stepId: string): readonly string[] {
  return previewStep(out, stepId).result?.surfaces ?? [];
}

export function previewSessionLock(out: string, stepId: string): SessionLockSnapshot {
  const snapshot = previewStep(out, stepId).result?.readiness?.sessionLock;
  expect(snapshot, stepId).toBeDefined();
  return snapshot!;
}

export function sessionLockTrace(out: string): SessionLockSnapshot {
  const trace = JSON.parse(readFileSync(join(out, "services.json"), "utf8")) as {
    readonly records: readonly { readonly kind: string; readonly detail: SessionLockSnapshot }[];
  };
  const record = [...trace.records].reverse().find(candidate => candidate.kind === "sessionLock");
  expect(record).toBeDefined();
  return record!.detail;
}

export function treeNode(tree: { readonly nodes: readonly PreviewTreeNode[] }, testId: string): PreviewTreeNode {
  const node = tree.nodes.find(candidate => candidate.testId === testId);
  expect(node, testId).toBeDefined();
  return node!;
}

export function pixel(image: DecodedPng, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(offset, offset + 4));
}

export function maxRowAlpha(image: DecodedPng, y: number): number {
  let max = 0;
  for (let x = 0; x < image.width; x++) {
    const alpha = image.data[(y * image.width + x) * 4 + 3] ?? 0;
    if (alpha > max) max = alpha;
  }
  return max;
}

export function maxColAlpha(image: DecodedPng, x: number): number {
  let max = 0;
  for (let y = 0; y < image.height; y++) {
    const alpha = image.data[(y * image.width + x) * 4 + 3] ?? 0;
    if (alpha > max) max = alpha;
  }
  return max;
}

export function pixelChannelDiff(a: readonly number[], b: readonly number[]): number {
  return Math.max(
    Math.abs((a[0] ?? 0) - (b[0] ?? 0)),
    Math.abs((a[1] ?? 0) - (b[1] ?? 0)),
    Math.abs((a[2] ?? 0) - (b[2] ?? 0)),
    Math.abs((a[3] ?? 0) - (b[3] ?? 0)),
  );
}

/**
 * Counts RGBA pixels inside `bounds` whose max per-channel difference between `before` and `after`
 * exceeds `threshold`. Used by L4 interaction & in-flight animation invariant checks.
 */
export function diffRegionPixels(
  before: DecodedPng,
  after: DecodedPng,
  bounds: DeviceBounds,
  threshold = 4,
): number {
  const x0 = Math.max(0, Math.floor(bounds.x));
  const y0 = Math.max(0, Math.floor(bounds.y));
  const x1 = Math.min(Math.min(before.width, after.width) - 1, Math.ceil(bounds.x + bounds.width) - 1);
  const y1 = Math.min(Math.min(before.height, after.height) - 1, Math.ceil(bounds.y + bounds.height) - 1);
  let diff = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idxB = (y * before.width + x) * 4;
      const idxA = (y * after.width + x) * 4;
      const delta = Math.max(
        Math.abs((before.data[idxB] ?? 0) - (after.data[idxA] ?? 0)),
        Math.abs((before.data[idxB + 1] ?? 0) - (after.data[idxA + 1] ?? 0)),
        Math.abs((before.data[idxB + 2] ?? 0) - (after.data[idxA + 2] ?? 0)),
        Math.abs((before.data[idxB + 3] ?? 0) - (after.data[idxA + 3] ?? 0)),
      );
      if (delta > threshold) diff++;
    }
  }
  return diff;
}

export function assertSameBounds(a: DeviceBounds, b: DeviceBounds, label: string): void {
  expect(a.x, `${label} x`).toBe(b.x);
  expect(a.y, `${label} y`).toBe(b.y);
  expect(a.width, `${label} width`).toBe(b.width);
  expect(a.height, `${label} height`).toBe(b.height);
}
