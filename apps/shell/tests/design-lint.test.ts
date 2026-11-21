import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { M3_EASINGS, M3_SPRINGS } from "@z-shell/sdk/zgui";
import { LOCK_MORPH_SHAPES, SHELL_ROSETTE_PATH } from "../src/shapes.ts";
import { SHELL_DEFAULT_SCHEME, buildThemeStylesheet } from "../src/theme.ts";
import {
  DEFAULT_BAR_SETTINGS,
  DOCKED_TOP_BAR_HEIGHT,
  DOCKED_VERTICAL_BAR_WIDTH,
  TOP_BAR_HEIGHT,
  VERTICAL_BAR_WIDTH,
} from "../src/topics.ts";

const shellDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(shellDir, "../..");
const oxlintBin = join(repoRoot, "node_modules/.bin/oxlint");
const pluginPath = join(repoRoot, "tools/oxlint-design-plugin.mjs");

function lintSnippet(filename: string, code: string, rule: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "z-shell-design-lint-"));
  try {
    const configPath = join(dir, ".oxlintrc.json");
    const targetPath = join(dir, filename);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      plugins: ["eslint", "typescript", "oxc"],
      jsPlugins: [pluginPath],
      rules: { [rule]: "error" },
    }));
    writeFileSync(targetPath, code);
    const result = spawnSync(oxlintBin, ["--config", configPath, "--deny-warnings", targetPath], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseDesignFrontmatter(): Record<string, Record<string, string>> {
  const markdown = readFileSync(join(repoRoot, "DESIGN.md"), "utf8");
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!match) throw new Error("DESIGN.md is missing YAML frontmatter");
  const sections: Record<string, Record<string, string>> = {};
  let section: string | null = null;
  for (const line of match[1]!.split("\n")) {
    const top = /^([a-zA-Z0-9_-]+):\s*$/.exec(line);
    if (top) {
      section = top[1]!;
      sections[section] = {};
      continue;
    }
    const entry = /^  ([a-zA-Z0-9_-]+):\s*"([^"]+)"\s*$/.exec(line);
    if (entry && section) {
      sections[section]![entry[1]!] = entry[2]!;
    }
  }
  return sections;
}

describe("zshell oxlint design plugin", () => {
  test("zshell/no-raw-colors rejects hex/rgba in UI styles and allows semantic tokens, color-mix, and elevation shadows", () => {
    const badHex = lintSnippet("Bad.tsx", `export const a = { backgroundColor: "#254777" };`, "zshell/no-raw-colors");
    expect(badHex.status).not.toBe(0);

    const badRgba = lintSnippet("Bad.tsx", `export const a = { backgroundColor: "rgba(255, 255, 255, 0.08)" };`, "zshell/no-raw-colors");
    expect(badRgba.status).not.toBe(0);

    const good = lintSnippet("Good.tsx", `
      export const a = {
        backgroundColor: "var(--color-surface-container)",
        border: "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)",
        boxShadow: "0 14px 36px rgba(0, 0, 0, 0.50)",
      };
    `, "zshell/no-raw-colors");
    expect(good.status, good.output).toBe(0);
  });

  test("zshell/valid-color-roles rejects unknown color tokens and mismatched foreground/container pairs", () => {
    const unknown = lintSnippet("Unknown.tsx", `export const a = { color: "var(--color-brand-blue)" };`, "zshell/valid-color-roles");
    expect(unknown.status).not.toBe(0);

    const badPair = lintSnippet("Pair.tsx", `
      const bg = "var(--color-error-container)";
      const fg = "var(--color-error)";
      export const a = { backgroundColor: bg, color: fg };
    `, "zshell/valid-color-roles");
    expect(badPair.status).not.toBe(0);

    const badTernaryPair = lintSnippet("Ternary.tsx", `
      const onSurface = "var(--color-on-surface)";
      const containerHigh = "var(--color-surface-container-high)";
      export const f = (danger: boolean) => ({
        backgroundColor: danger ? "var(--color-error-container)" : containerHigh,
        color: danger ? "var(--color-error)" : onSurface,
      });
    `, "zshell/valid-color-roles");
    expect(badTernaryPair.status).not.toBe(0);

    const badChildIcon = lintSnippet("ChildIcon.tsx", `
      export const x = (
        <row style={{ backgroundColor: "var(--color-primary-container)" }}>
          <ShellIcon name="wifi" color="var(--color-primary)" />
        </row>
      );
    `, "zshell/valid-color-roles");
    expect(badChildIcon.status).not.toBe(0);

    const goodChildIcon = lintSnippet("GoodChildIcon.tsx", `
      export const x = (
        <row style={{ backgroundColor: "var(--color-primary-container)" }}>
          <ShellIcon name="wifi" color="var(--color-on-primary-container)" />
        </row>
      );
    `, "zshell/valid-color-roles");
    expect(goodChildIcon.status, goodChildIcon.output).toBe(0);

    const goodPair = lintSnippet("Good.tsx", `
      export const f = (danger: boolean) => ({
        backgroundColor: danger ? "var(--color-error-container)" : "var(--color-surface-container-high)",
        color: danger ? "var(--color-on-error-container)" : "var(--color-on-surface)",
      });
    `, "zshell/valid-color-roles");
    expect(goodPair.status, goodPair.output).toBe(0);
  });

  test("zshell/calm-active-surface rejects solid primary fill on large active surfaces and allows small indicators", () => {
    const badTile = lintSnippet("Tile.tsx", `
      const primary = "var(--color-primary)";
      export const x = <row data-qs-tile="true" style={{ height: "50px", backgroundColor: primary }} />;
    `, "zshell/calm-active-surface");
    expect(badTile.status).not.toBe(0);

    const badCard = lintSnippet("Card.tsx", `
      export const s = { flexGrow: 1, height: "52px", backgroundColor: "var(--color-primary)" };
    `, "zshell/calm-active-surface");
    expect(badCard.status).not.toBe(0);

    const goodTile = lintSnippet("Good.tsx", `
      export const x = <row data-qs-tile="true" style={{ height: "50px", backgroundColor: "var(--color-primary-container)" }} />;
      export const badge = { width: "28px", height: "28px", backgroundColor: "var(--color-primary)" };
      export const progress = <box data-percent-fill="true" style={{ width: "68%", height: "100%", backgroundColor: "var(--color-primary)" }} />;
      export const playFab = { width: "52px", height: "52px", borderRadius: "999px", backgroundColor: "var(--color-primary)" };
    `, "zshell/calm-active-surface");
    expect(goodTile.status, goodTile.output).toBe(0);
  });

  test("zshell/no-system-ui-font rejects hardcoded system-ui and allows semantic font variables", () => {
    const bad = lintSnippet("Bad.tsx", `export const s = { fontFamily: "system-ui" };`, "zshell/no-system-ui-font");
    expect(bad.status).not.toBe(0);

    const good = lintSnippet("Good.tsx", `export const a = { fontFamily: "var(--font-sans)" }; export const b = { fontFamily: "var(--font-mono)" };`, "zshell/no-system-ui-font");
    expect(good.status, good.output).toBe(0);
  });

  test("zshell/valid-radius-scale rejects off-scale radii and accepts DESIGN.md shape tokens", () => {
    const bad = lintSnippet("Bad.tsx", `export const s = { borderRadius: "24px" };`, "zshell/valid-radius-scale");
    expect(bad.status).not.toBe(0);

    const good = lintSnippet("Good.tsx", `
      export const a = { borderRadius: "22px" };
      export const b = { borderRadius: "16px" };
      export const c = { borderRadius: "14px" };
      export const d = { borderRadius: "10px" };
      export const e = { borderRadius: "999px" };
      export const f = { borderRadius: "var(--radius-panel)" };
    `, "zshell/valid-radius-scale");
    expect(good.status, good.output).toBe(0);
  });

  test("zshell/no-mobile-copy rejects 'Tap to' phrasing and allows desktop 'Click to'", () => {
    const bad = lintSnippet("Bad.tsx", `export const x = <text>Tap to connect</text>;`, "zshell/no-mobile-copy");
    expect(bad.status).not.toBe(0);

    const good = lintSnippet("Good.tsx", `export const x = <text>Click to connect</text>;`, "zshell/no-mobile-copy");
    expect(good.status, good.output).toBe(0);
  });

  test("zshell/no-outline-none rejects removing focus outlines", () => {
    const bad = lintSnippet("Bad.tsx", `export const s = { outline: "none" };`, "zshell/no-outline-none");
    expect(bad.status).not.toBe(0);

    const good = lintSnippet("Good.tsx", `export const s = { border: "1px solid var(--color-outline-variant)" };`, "zshell/no-outline-none");
    expect(good.status, good.output).toBe(0);
  });

  test("zshell/expressive-budget scopes wavy progress to MediaPanel and scalloped rosettes to brand mark & user avatars (not Launcher triggers)", () => {
    const badWavy = lintSnippet("QuickSettingsPanel.tsx", `export const x = <WavyProgress />;`, "zshell/expressive-budget");
    expect(badWavy.status).not.toBe(0);

    const goodWavy = lintSnippet("MediaPanel.tsx", `export const x = <WavyProgress />;`, "zshell/expressive-budget");
    expect(goodWavy.status, goodWavy.output).toBe(0);

    const badScallop = lintSnippet("CalendarPanel.tsx", `const scallopPath = "M0 0"; export const x = scallopPath;`, "zshell/expressive-budget");
    expect(badScallop.status).not.toBe(0);

    const badLauncherBar = lintSnippet("StatusBar.tsx", `export const x = <ShellIcon name="shellEmblem" size={20} />;`, "zshell/expressive-budget");
    expect(badLauncherBar.status).not.toBe(0);

    const badLauncherDock = lintSnippet("DockSurface.tsx", `export const x = <ShellIcon name="shellEmblem" size={22} />;`, "zshell/expressive-budget");
    expect(badLauncherDock.status).not.toBe(0);

    const badLauncherOverlay = lintSnippet("LauncherOverlay.tsx", `const rosette = "M0 0"; export const x = rosette;`, "zshell/expressive-budget");
    expect(badLauncherOverlay.status).not.toBe(0);

    const goodLauncherBar = lintSnippet("StatusBar.tsx", `export const x = <ShellIcon name="apps" size={20} />;`, "zshell/expressive-budget");
    expect(goodLauncherBar.status, goodLauncherBar.output).toBe(0);

    const goodScallopLock = lintSnippet("SessionLockOverlay.tsx", `const avatarScallop = "M0 0"; export const x = avatarScallop;`, "zshell/expressive-budget");
    expect(goodScallopLock.status, goodScallopLock.output).toBe(0);

    const goodScallopQs = lintSnippet("QuickSettingsPanel.tsx", `const avatarRosette = "M0 0"; export const x = avatarRosette;`, "zshell/expressive-budget");
    expect(goodScallopQs.status, goodScallopQs.output).toBe(0);
  });

  test("zshell/no-lint-suppression rejects inline oxlint/eslint disable comments", () => {
    const bad = lintSnippet("Bad.tsx", `// oxlint-disable-next-line zshell/no-raw-colors\nexport const x = 1;`, "zshell/no-lint-suppression");
    expect(bad.status).not.toBe(0);

    const good = lintSnippet("Good.tsx", `// Regular explanation comment.\nexport const x = 1;`, "zshell/no-lint-suppression");
    expect(good.status, good.output).toBe(0);
  });

  test("zshell/no-hand-authored-expressive-paths rejects hand-coded Bezier expressive shapes outside shapes.ts", () => {
    const badVar = lintSnippet("SessionLockOverlay.tsx", `export const avatarScallop = "M32 2C37-1 43 1 46 6Z";`, "zshell/no-hand-authored-expressive-paths");
    expect(badVar.status).not.toBe(0);

    const badObj = lintSnippet("icons.tsx", `export const ICONS = { shellEmblem: { d: "M32 4C36 4 38 7 41 8Z" } };`, "zshell/no-hand-authored-expressive-paths");
    expect(badObj.status).not.toBe(0);

    const goodRef = lintSnippet("icons.tsx", `import { SHELL_ROSETTE_PATH } from "./shapes.ts"; export const ICONS = { shellEmblem: { d: SHELL_ROSETTE_PATH } };`, "zshell/no-hand-authored-expressive-paths");
    expect(goodRef.status, goodRef.output).toBe(0);
  });

  test("zshell/material-icon-grid enforces 24x24 Material viewBox and bans ad-hoc inline vector paths in shell surfaces", () => {
    const badIconGrid = lintSnippet("icons.tsx", `export const ICONS = { mediaEq: { viewBox: "0 0 16 16", d: "M0 0h16v16H0z" } };`, "zshell/material-icon-grid");
    expect(badIconGrid.status).not.toBe(0);

    const badVectorGrid = lintSnippet("Widget.tsx", `export const x = <vector d={path} viewBox="0 0 16 16" />;`, "zshell/material-icon-grid");
    expect(badVectorGrid.status).not.toBe(0);

    const goodIconGrid = lintSnippet("icons.tsx", `export const ICONS = { mediaEq: { viewBox: "0 0 24 24", d: "M7 18h2V6H7v12z" }, shellEmblem: { viewBox: "0 0 64 64", d: p } };`, "zshell/material-icon-grid");
    expect(goodIconGrid.status, goodIconGrid.output).toBe(0);
  });

  test("zshell/single-owner-ia blocks Notifications/DND in QuickSettingsPanel and SystemTelemetryCards in CalendarPanel", () => {
    const badQsDnd = lintSnippet("QuickSettingsPanel.tsx", `export const x = { cmd: "notifications.set-dnd", label: "Do Not Disturb" };`, "zshell/single-owner-ia");
    expect(badQsDnd.status).not.toBe(0);

    const badCalTelemetry = lintSnippet("CalendarPanel.tsx", `export const x = <SystemTelemetryCards />;`, "zshell/single-owner-ia");
    expect(badCalTelemetry.status).not.toBe(0);

    const goodCal = lintSnippet("CalendarPanel.tsx", `export const x = { cmd: "notifications.set-dnd" };`, "zshell/single-owner-ia");
    expect(goodCal.status, goodCal.output).toBe(0);
  });

  test("zshell/split-action-divider requires a vertical hairline divider on split QuickTiles", () => {
    const badSplit = lintSnippet("QuickSettingsPanel.tsx", `export const x = <row data-qs-tile="true"><Button testId="qs-open-wifi" /></row>;`, "zshell/split-action-divider");
    expect(badSplit.status).not.toBe(0);

    const goodSplit = lintSnippet("QuickSettingsPanel.tsx", `export const x = <row data-qs-tile="true"><box data-split-divider="true" /><Button testId="qs-open-wifi" /></row>;`, "zshell/split-action-divider");
    expect(goodSplit.status, goodSplit.output).toBe(0);
  });

  test("zshell/tabular-readout enforces tabular-nums on monospace numeric readout slots (tagged or untagged)", () => {
    const badReadout = lintSnippet("OsdOverlay.tsx", `export const x = <text data-tabular="true" style={{ fontFamily: "var(--font-mono)" }}>68%</text>;`, "zshell/tabular-readout");
    expect(badReadout.status).not.toBe(0);

    const badUntaggedPercent = lintSnippet("BatteryPanel.tsx", `export const x = <text style={{ fontFamily: "var(--font-mono)" }}>{pct}%</text>;`, "zshell/tabular-readout");
    expect(badUntaggedPercent.status).not.toBe(0);

    const goodReadout = lintSnippet("OsdOverlay.tsx", `export const x = <text style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>68%</text>;`, "zshell/tabular-readout");
    expect(goodReadout.status, goodReadout.output).toBe(0);
  });

  test("zshell/bluetooth-safe-action forbids unguarded Remove button on connected Bluetooth rows", () => {
    const badBt = lintSnippet("QuickSettingsSubpages.tsx", `export function BluetoothPage() { return <Action label="Remove" />; }`, "zshell/bluetooth-safe-action");
    expect(badBt.status).not.toBe(0);

    const goodBt = lintSnippet("QuickSettingsSubpages.tsx", `export function BluetoothPage() { return <Show when={!dev().connected}><Action label="Remove" /></Show>; }`, "zshell/bluetooth-safe-action");
    expect(goodBt.status, goodBt.output).toBe(0);
  });

  test("zshell/composite-input-focus requires composite search/input rows to delegate focus ring to the outer pill", () => {
    const badComposite = lintSnippet(
      "LauncherOverlay.tsx",
      `export const x = <row><ShellIcon name="search" /><TextField value="" /></row>;`,
      "zshell/composite-input-focus",
    );
    expect(badComposite.status).not.toBe(0);

    const goodComposite = lintSnippet(
      "LauncherOverlay.tsx",
      `export const x = <row data-composite-input="true"><ShellIcon name="search" /><TextField class="shell-composite-field" onFocus={() => {}} onBlur={() => {}} value="" /></row>;`,
      "zshell/composite-input-focus",
    );
    expect(goodComposite.status, goodComposite.output).toBe(0);
  });

  test("zshell/no-hover-hit-target-shift blocks direct :hover/:active transforms on hit targets and allows inner visual child transforms", () => {
    const badHover = lintSnippet(
      "motion.ts",
      `export const CSS = \`[data-dock-item]:hover { transform: translateY(-6px) scale(1.1); }\`;`,
      "zshell/no-hover-hit-target-shift",
    );
    expect(badHover.status).not.toBe(0);

    const badActive = lintSnippet(
      "motion.ts",
      `export const CSS = \`[data-qs-tile]:active { transform: scale(0.98); }\`;`,
      "zshell/no-hover-hit-target-shift",
    );
    expect(badActive.status).not.toBe(0);

    const badVisual = lintSnippet(
      "DockSurface.tsx",
      `export const x = <box data-dock-visual="true" style={{ width: "46px" }} />;`,
      "zshell/no-hover-hit-target-shift",
    );
    expect(badVisual.status).not.toBe(0);

    const goodHover = lintSnippet(
      "motion.ts",
      `export const CSS = \`[data-dock-item]:hover > [data-dock-visual] { transform: translateY(-4px) scale(1.08); } [data-qs-tile]:hover { background-color: var(--color-surface-container-high); }\`;`,
      "zshell/no-hover-hit-target-shift",
    );
    expect(goodHover.status, goodHover.output).toBe(0);
  });

  test("zshell/no-flush-surface-shadow forbids CSS boxShadow on flush PopupSurface/WindowSurface roots", () => {
    const badPopupShadow = lintSnippet(
      "ShellPanels.tsx",
      `export const s = { borderRadius: "22px", boxShadow: "0 14px 36px rgba(0, 0, 0, 0.50)" };`,
      "zshell/no-flush-surface-shadow",
    );
    expect(badPopupShadow.status).not.toBe(0);

    const badWindowShadow = lintSnippet(
      "SettingsWindow.tsx",
      `export const s = { width: "820px", boxShadow: "0 20px 56px rgba(0, 0, 0, 0.60)" };`,
      "zshell/no-flush-surface-shadow",
    );
    expect(badWindowShadow.status).not.toBe(0);

    const badBarPopupShadow = lintSnippet(
      "BarPopups.tsx",
      `export const s = { borderRadius: "16px", boxShadow: "0 12px 24px rgba(0, 0, 0, 0.45)" };`,
      "zshell/no-flush-surface-shadow",
    );
    expect(badBarPopupShadow.status).not.toBe(0);

    const goodWindow = lintSnippet(
      "SettingsWindow.tsx",
      `export const s = { width: "820px", height: "600px" };`,
      "zshell/no-flush-surface-shadow",
    );
    expect(goodWindow.status, goodWindow.output).toBe(0);
  });

  test("zshell/no-core-plugin-id-branching forbids hardcoded first-party plugin IDs in core shell", () => {
    const badCoreBranch = lintSnippet(
      "apps/shell/src/plugins/PluginHost.tsx",
      `export const w = (id: string) => id.includes("nosleep") ? 360 : 396;`,
      "zshell/no-core-plugin-id-branching",
    );
    expect(badCoreBranch.status).not.toBe(0);

    const allowedInPlugin = lintSnippet(
      "plugins/nosleep/src/panel.tsx",
      `export const id = "z-shell/nosleep";`,
      "zshell/no-core-plugin-id-branching",
    );
    expect(allowedInPlugin.status, allowedInPlugin.output).toBe(0);

    const goodCore = lintSnippet(
      "apps/shell/src/plugins/PluginHost.tsx",
      `export const w = () => 396;`,
      "zshell/no-core-plugin-id-branching",
    );
    expect(goodCore.status, goodCore.output).toBe(0);
  });

  test("zshell/m3-motion-tokens bans ad-hoc springs, non-M3 CSS curves, and outline-width transitions", () => {
    const badSpring = lintSnippet(
      "OsdOverlay.tsx",
      `export const opts = { stiffness: 260, damping: 33 };`,
      "zshell/m3-motion-tokens",
    );
    expect(badSpring.status).not.toBe(0);

    const badCurve = lintSnippet(
      "Widget.tsx",
      `export const css = \`.x { transition-timing-function: ease-out; }\`;`,
      "zshell/m3-motion-tokens",
    );
    expect(badCurve.status).not.toBe(0);

    const badBezier = lintSnippet(
      "Widget.tsx",
      `export const css = \`.x { transition-timing-function: cubic-bezier(0.2, 0.9, 0.3, 1.15); }\`;`,
      "zshell/m3-motion-tokens",
    );
    expect(badBezier.status).not.toBe(0);

    const badOutlineWidth = lintSnippet(
      "Widget.tsx",
      `export const s = { transitionProperty: "outline-width" };`,
      "zshell/m3-motion-tokens",
    );
    expect(badOutlineWidth.status).not.toBe(0);

    const goodMotion = lintSnippet(
      "Widget.tsx",
      `export const css = \`.x { transition-property: transform, opacity; transition-timing-function: var(--motion-easing-standard); }\`; export const y = { transitionTimingFunction: "cubic-bezier(0.05, 0.7, 0.1, 1.0)" };`,
      "zshell/m3-motion-tokens",
    );
    expect(goodMotion.status, goodMotion.output).toBe(0);
  });

  test("zshell/no-direct-raf-loop bans direct requestAnimationFrame outside packages/sdk/src/motion.ts", () => {
    const badRaf = lintSnippet(
      "MediaPanel.tsx",
      `export const tick = () => requestAnimationFrame(tick);`,
      "zshell/no-direct-raf-loop",
    );
    expect(badRaf.status).not.toBe(0);

    const allowedCore = lintSnippet(
      "packages/sdk/src/motion.ts",
      `export const tick = () => requestAnimationFrame(tick);`,
      "zshell/no-direct-raf-loop",
    );
    expect(allowedCore.status, allowedCore.output).toBe(0);
  });
});

function parseCubicPoints(d: string): { x: number; y: number }[] {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  expect(nums.length % 2).toBe(0);
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < nums.length; i += 2) {
    points.push({ x: nums[i]!, y: nums[i + 1]! });
  }
  return points;
}

function assertDihedralSymmetry(label: string, d: string, lobes: number, cx: number, cy: number, size: number) {
  const points = parseCubicPoints(d);
  expect(points.length, `${label} point count`).toBeGreaterThan(0);

  for (const pt of points) {
    expect(pt.x, `${label} x in [0, ${size}]`).toBeGreaterThanOrEqual(0);
    expect(pt.x, `${label} x in [0, ${size}]`).toBeLessThanOrEqual(size);
    expect(pt.y, `${label} y in [0, ${size}]`).toBeGreaterThanOrEqual(0);
    expect(pt.y, `${label} y in [0, ${size}]`).toBeLessThanOrEqual(size);
  }

  const angle = (2 * Math.PI) / lobes;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hasNear = (tx: number, ty: number) =>
    points.some(candidate => Math.hypot(candidate.x - tx, candidate.y - ty) < 0.01);

  for (const pt of points) {
    // Rotational symmetry by 2*pi / lobes around (cx, cy).
    const dx = pt.x - cx;
    const dy = pt.y - cy;
    const rx = cx + dx * cos - dy * sin;
    const ry = cy + dx * sin + dy * cos;
    expect(hasNear(rx, ry), `${label} rotational symmetry for (${pt.x}, ${pt.y}) -> (${rx.toFixed(3)}, ${ry.toFixed(3)})`).toBe(true);

    // Mirror symmetry across vertical axis x = cx.
    const mx = 2 * cx - pt.x;
    expect(hasNear(mx, pt.y), `${label} mirror symmetry for (${pt.x}, ${pt.y}) -> (${mx.toFixed(3)}, ${pt.y})`).toBe(true);
  }
}

describe("Exact-Geometry Shape & Material-First Icon contracts", () => {
  test("all M3 Expressive shapes satisfy exact D_n rotational & mirror symmetry within their viewBox", () => {
    assertDihedralSymmetry("SHELL_ROSETTE_PATH", SHELL_ROSETTE_PATH, 8, 32, 32, 64);
    for (const [name, shape] of Object.entries(LOCK_MORPH_SHAPES)) {
      expect(shape.viewBox).toBe("0 0 24 24");
      assertDihedralSymmetry(name, shape.d, shape.lobes, 12, 12, 24);
    }
  });

  test("all Tier 1 system UI icons in SHELL_ICON_PATHS use the 24x24 Material grid", () => {
    const iconsSource = readFileSync(join(shellDir, "src/icons.tsx"), "utf8");
    const entries = [...iconsSource.matchAll(/^\s{2}([a-zA-Z0-9_]+):\s*\{\s*\n\s*viewBox:\s*"([^"]+)"/gm)];
    expect(entries.length).toBeGreaterThanOrEqual(30);
    const names = new Set(entries.map(([, name]) => name));
    expect(names.has("apps")).toBe(true);
    expect(names.has("overview")).toBe(true);
    for (const [, name, viewBox] of entries) {
      if (name === "shellEmblem") {
        expect(viewBox).toBe("0 0 64 64");
      } else {
        expect(viewBox, `SHELL_ICON_PATHS.${name}`).toBe("0 0 24 24");
      }
    }
    expect(iconsSource).toContain("d: SHELL_ROSETTE_PATH");
  });
});

describe("DESIGN.md token and surface contract sync", () => {
  test("DESIGN.md frontmatter colors match SHELL_DEFAULT_SCHEME and app.css :root", () => {
    const frontmatter = parseDesignFrontmatter();
    const appCss = readFileSync(join(shellDir, "src/app.css"), "utf8");
    const themeCss = buildThemeStylesheet(SHELL_DEFAULT_SCHEME, true);

    for (const [token, expectedHex] of Object.entries(frontmatter.colors ?? {})) {
      const schemeKey = token.replaceAll("-", "_") as keyof typeof SHELL_DEFAULT_SCHEME;
      expect(SHELL_DEFAULT_SCHEME[schemeKey]?.toUpperCase(), `theme.ts ${schemeKey}`).toBe(expectedHex.toUpperCase());
      expect(appCss, `app.css --color-${token}`).toContain(`--color-${token}: ${expectedHex};`);
    }

    // zgui-style UA :focus-visible reads --zgui-ring; both static app.css and dynamic theme sheet must wire it.
    expect(appCss).toContain("--zgui-ring: var(--color-primary);");
    expect(themeCss).toContain("--zgui-ring: var(--color-primary);");
  });

  test("app.css shape, spacing, and typography tokens match DESIGN.md without stale mobile radii", () => {
    const frontmatter = parseDesignFrontmatter();
    const appCss = readFileSync(join(shellDir, "src/app.css"), "utf8");

    for (const [name, value] of Object.entries(frontmatter.rounded ?? {})) {
      expect(appCss, `app.css --radius-${name}`).toContain(`--radius-${name}: ${value};`);
    }
    for (const [name, value] of Object.entries(frontmatter.spacing ?? {})) {
      expect(appCss, `app.css --spacing-${name}`).toContain(`--spacing-${name}: ${value};`);
    }
    expect(appCss).toContain(`--font-sans: "Roboto Flex"`);
    expect(appCss).toContain(`--font-mono: "JetBrains Mono"`);
    expect(appCss).not.toContain("--radius-20:");
    expect(appCss).not.toContain("--radius-30:");

    const pkg = JSON.parse(readFileSync(join(shellDir, "package.json"), "utf8")) as {
      zgui?: { fonts?: { family: string; path: string }[] };
    };
    const fonts = pkg.zgui?.fonts ?? [];
    expect(fonts.map(f => f.family)).toEqual(["Roboto Flex", "JetBrains Mono"]);
    for (const font of fonts) {
      expect(existsSync(join(shellDir, font.path)), `missing bundled font ${font.path}`).toBe(true);
    }
  });

  test("bar strut constants and auto-height popover / SettingsWindow tiers match DESIGN.md", () => {
    expect(DEFAULT_BAR_SETTINGS.clock_seconds).toBe(false);
    expect(DEFAULT_BAR_SETTINGS.style).toBe("floating");
    expect(TOP_BAR_HEIGHT).toBe(32);
    expect(VERTICAL_BAR_WIDTH).toBe(40);
    expect(DOCKED_TOP_BAR_HEIGHT).toBe(38);
    expect(DOCKED_VERTICAL_BAR_WIDTH).toBe(44);

    const shellPanels = readFileSync(join(shellDir, "src/panels/ShellPanels.tsx"), "utf8");
    const pluginHost = readFileSync(join(shellDir, "src/plugins/PluginHost.tsx"), "utf8");
    const settingsWin = readFileSync(join(shellDir, "src/surfaces/SettingsWindow.tsx"), "utf8");
    expect(shellPanels).toContain(`height="auto"`);
    expect(pluginHost).toContain(`height="auto"`);
    expect(settingsWin).toContain("width={820}");
    expect(settingsWin).toContain("height={600}");
    expect(settingsWin).toContain(`width: "216px"`);
  });

  test("surface width tiers match DESIGN.md (Compact 360, Standard 396, Clipboard 560, Launcher 652, Overview 684)", () => {
    const shellPanels = readFileSync(join(shellDir, "src/panels/ShellPanels.tsx"), "utf8");
    const powerDialog = readFileSync(join(shellDir, "src/surfaces/PowerDialog.tsx"), "utf8");
    const polkitDialog = readFileSync(join(shellDir, "src/surfaces/PolkitDialog.tsx"), "utf8");
    const launcher = readFileSync(join(shellDir, "src/surfaces/LauncherOverlay.tsx"), "utf8");
    const overview = readFileSync(join(repoRoot, "plugins/niri-overview/src/layer.tsx"), "utf8");

    expect(shellPanels).toMatch(/"quick-settings":\s*\{\s*width:\s*396\b/);
    expect(shellPanels).toMatch(/calendar:\s*\{\s*width:\s*396\b/);
    expect(shellPanels).toMatch(/media:\s*\{\s*width:\s*396\b/);
    expect(shellPanels).toMatch(/battery:\s*\{\s*width:\s*396\b/);
    expect(shellPanels).toMatch(/clipboard:\s*\{\s*width:\s*560\b/);
    expect(powerDialog).toContain(`width: "360px"`);
    expect(polkitDialog).toContain(`width: "360px"`);
    expect(launcher).toContain(`width: "652px"`);
    expect(overview).toContain(`width: "684px"`);
  });

  test(".impeccable/design.json motion tokens match packages/sdk/src/motion.ts and app.css", () => {
    const designJson = JSON.parse(readFileSync(join(repoRoot, ".impeccable/design.json"), "utf8")) as {
      extensions?: { motion?: { name: string; value: string }[] };
    };
    const appCss = readFileSync(join(shellDir, "src/app.css"), "utf8");
    const motionMap = new Map((designJson.extensions?.motion ?? []).map(item => [item.name, item.value]));

    const expectedSprings = [
      ["spring-standard-fast-spatial", M3_SPRINGS.standard.fastSpatial],
      ["spring-standard-default-spatial", M3_SPRINGS.standard.defaultSpatial],
      ["spring-standard-slow-spatial", M3_SPRINGS.standard.slowSpatial],
      ["spring-expressive-fast-spatial", M3_SPRINGS.expressive.fastSpatial],
      ["spring-expressive-default-spatial", M3_SPRINGS.expressive.defaultSpatial],
      ["spring-expressive-slow-spatial", M3_SPRINGS.expressive.slowSpatial],
      ["spring-fast-effects", M3_SPRINGS.standard.fastEffects],
      ["spring-default-effects", M3_SPRINGS.standard.defaultEffects],
      ["spring-slow-effects", M3_SPRINGS.standard.slowEffects],
    ] as const;

    for (const [name, spec] of expectedSprings) {
      const expected = `spring(stiffness=${spec.stiffness}, dampingRatio=${spec.dampingRatio.toFixed(1)})`;
      expect(motionMap.get(name), name).toBe(expected);
    }

    expect(appCss).toContain(`--motion-easing-emphasized-decelerate: ${M3_EASINGS.emphasizedDecelerate};`);
    expect(appCss).toContain(`--motion-easing-emphasized-accelerate: ${M3_EASINGS.emphasizedAccelerate};`);
    expect(appCss).toContain(`--motion-easing-standard: ${M3_EASINGS.standard};`);
    expect(appCss).toContain(`--motion-duration-short2: 100ms;`);
  });
});
