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

    const goodTelemetryChart = lintSnippet("TelemetryCharts.tsx", `export const x = <vector d={path} viewBox="0 0 30 30" />;`, "zshell/material-icon-grid");
    expect(goodTelemetryChart.status, goodTelemetryChart.output).toBe(0);

    const badTelemetryChartOutside = lintSnippet("Widget.tsx", `export const x = <vector d={path} viewBox="0 0 30 30" />;`, "zshell/material-icon-grid");
    expect(badTelemetryChartOutside.status).not.toBe(0);

    const badTelemetryChartViewBox = lintSnippet("TelemetryCharts.tsx", `export const x = <vector d={path} viewBox="0 0 123 45" />;`, "zshell/material-icon-grid");
    expect(badTelemetryChartViewBox.status).not.toBe(0);
  });

  test("SystemMonitorWindow is guarded as a flush solid Level 3 toplevel window (no boxShadow, no backdropFilter, no translucency)", () => {
    const badShadow = lintSnippet("SystemMonitorWindow.tsx", `export const s = { boxShadow: "var(--shadow-level-2)" };`, "zshell/no-flush-surface-shadow");
    expect(badShadow.status).not.toBe(0);

    const badBlur = lintSnippet("SystemMonitorWindow.tsx", `export const s = { backdropFilter: "blur(20px)" };`, "zshell/no-unblurred-translucent-surface");
    expect(badBlur.status).not.toBe(0);

    const badTranslucent = lintSnippet(
      "SystemMonitorWindow.tsx",
      `export const s = { backgroundColor: "color-mix(in srgb, var(--color-surface-container) 78%, transparent)" };`,
      "zshell/no-unblurred-translucent-surface",
    );
    expect(badTranslucent.status).not.toBe(0);

    const goodSolid = lintSnippet(
      "SystemMonitorWindow.tsx",
      `export const s = { backgroundColor: "var(--color-surface-container)" };`,
      "zshell/no-unblurred-translucent-surface",
    );
    expect(goodSolid.status, goodSolid.output).toBe(0);
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

  test("zshell/no-flush-surface-shadow forbids CSS boxShadow on WindowSurface and flush PopupSurface roots without geometryInsets", () => {
    const badPopupShadow = lintSnippet(
      "ShellPanels.tsx",
      `export const s = { borderRadius: "22px", boxShadow: "var(--shadow-level-2)" };`,
      "zshell/no-flush-surface-shadow",
    );
    expect(badPopupShadow.status).not.toBe(0);

    const badWindowShadow = lintSnippet(
      "SettingsWindow.tsx",
      `export const s = { width: "820px", boxShadow: "var(--shadow-level-3)" };`,
      "zshell/no-flush-surface-shadow",
    );
    expect(badWindowShadow.status).not.toBe(0);

    const badBarPopupShadow = lintSnippet(
      "BarPopups.tsx",
      `export const s = { borderRadius: "16px", boxShadow: "var(--shadow-level-2)" };`,
      "zshell/no-flush-surface-shadow",
    );
    expect(badBarPopupShadow.status).not.toBe(0);

    const goodInsetPopup = lintSnippet(
      "BarPopups.tsx",
      `export const card = { borderRadius: "16px", boxShadow: "var(--shadow-level-2)" };
       export const view = () => <PopupSurface name="tray-menu" parent="bar" anchorRect={{ x: 0, y: 0, width: 10, height: 10 }} width={220} geometryInsets={{ top: 20, right: 28, bottom: 38, left: 28 }}><box style={card} /></PopupSurface>;`,
      "zshell/no-flush-surface-shadow",
    );
    expect(goodInsetPopup.status, goodInsetPopup.output).toBe(0);

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
      `export const w = (id: string) => id.includes("ai-usage") ? 360 : 396;`,
      "zshell/no-core-plugin-id-branching",
    );
    expect(badCoreBranch.status).not.toBe(0);

    const allowedInPlugin = lintSnippet(
      "plugins/ai-usage/src/panel.tsx",
      `export const id = "z-shell/ai-usage";`,
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

  test("zshell/solid-show-keyed-callback requires a parameter on <Show keyed> render callbacks", () => {
    const bad = lintSnippet(
      "ShellPanels.tsx",
      `export const View = (k: () => string | null) => <Show when={k()} keyed>{() => <box />}</Show>;`,
      "zshell/solid-show-keyed-callback",
    );
    expect(bad.status).not.toBe(0);

    const good = lintSnippet(
      "ShellPanels.tsx",
      `export const View = (k: () => string | null) => <Show when={k()} keyed>{_key => <box />}</Show>;`,
      "zshell/solid-show-keyed-callback",
    );
    expect(good.status, good.output).toBe(0);
  });

  test("zshell/min-hit-target-size flags Button/control literal dimensions below 24px", () => {
    const bad = lintSnippet(
      "Settings.tsx",
      `export const Switch = () => <Button style={{ width: "38px", height: "22px" }} />;`,
      "zshell/min-hit-target-size",
    );
    expect(bad.status).not.toBe(0);

    const good = lintSnippet(
      "Settings.tsx",
      `export const Switch = () => <Button style={{ width: "42px", height: "24px" }} />;`,
      "zshell/min-hit-target-size",
    );
    expect(good.status, good.output).toBe(0);
  });

  test("zshell/no-pill-action-button bans 999px pill radius on rectangular text Buttons and allows switches/square icons", () => {
    const bad = lintSnippet(
      "PowerDialog.tsx",
      `export const Btn = () => <Button style={{ height: "34px", padding: "0 16px", borderRadius: "999px" }}>Cancel</Button>;`,
      "zshell/no-pill-action-button",
    );
    expect(bad.status).not.toBe(0);

    const good = lintSnippet(
      "PowerDialog.tsx",
      `export const Ok = () => (
        <>
          <Button style={{ height: "34px", padding: "0 16px", borderRadius: "10px" }}>Cancel</Button>
          <Button data-switch-root="true" style={{ width: "44px", height: "24px", borderRadius: "999px" }} />
          <Button style={{ width: "36px", height: "36px", borderRadius: "999px" }}><text>X</text></Button>
        </>
      );`,
      "zshell/no-pill-action-button",
    );
    expect(good.status, good.output).toBe(0);
  });

  test("zshell/semantic-elevation-tokens bans raw rgba() boxShadow and requires var(--shadow-level-*)", () => {
    const bad = lintSnippet(
      "Card.tsx",
      `export const s = { boxShadow: "0 20px 56px rgba(0, 0, 0, 0.60)" };`,
      "zshell/semantic-elevation-tokens",
    );
    expect(bad.status).not.toBe(0);

    const good = lintSnippet(
      "Card.tsx",
      `export const a = { boxShadow: "var(--shadow-level-3)" }; export const b = { boxShadow: "none" };`,
      "zshell/semantic-elevation-tokens",
    );
    expect(good.status, good.output).toBe(0);
  });

  test("zshell/no-unblurred-translucent-surface enforces Wayland Graceful Solid Fallback and always-solid Settings Window", () => {
    const bad = lintSnippet(
      "DockSurface.tsx",
      `export const dock = { backgroundColor: "color-mix(in srgb, var(--color-surface-container) 42%, transparent)" };`,
      "zshell/no-unblurred-translucent-surface",
    );
    expect(bad.status).not.toBe(0);

    const badPopover = lintSnippet(
      "ShellPanels.tsx",
      `export const pop = { backgroundColor: "color-mix(in srgb, var(--color-surface-container-low) 78%, transparent)" };`,
      "zshell/no-unblurred-translucent-surface",
    );
    expect(badPopover.status).not.toBe(0);

    const badSettingsBlur = lintSnippet(
      "SettingsWindow.tsx",
      `export const win = { backdropFilter: "blur(24px)", backgroundColor: "var(--color-surface-container)" };`,
      "zshell/no-unblurred-translucent-surface",
    );
    expect(badSettingsBlur.status).not.toBe(0);

    const good = lintSnippet(
      "DockSurface.tsx",
      `export const dock = { backgroundColor: "var(--color-surface-container)" };`,
      "zshell/no-unblurred-translucent-surface",
    );
    expect(good.status, good.output).toBe(0);
  });

  test("zshell/concentric-geometry enforces Dock R=22px / 10-12px inner tiles and circular/concentric QuickTile icon wells", () => {
    const badDockOuter = lintSnippet(
      "DockSurface.tsx",
      `const capsule = { borderRadius: "999px" }; export { capsule };`,
      "zshell/concentric-geometry",
    );
    expect(badDockOuter.status).not.toBe(0);

    const badDockTile = lintSnippet(
      "DockSurface.tsx",
      `export const x = <Button testId="dock-launcher" style={{ borderRadius: "14px" }} />;`,
      "zshell/concentric-geometry",
    );
    expect(badDockTile.status).not.toBe(0);

    const goodDock = lintSnippet(
      "DockSurface.tsx",
      `const capsule = { borderRadius: "22px" }; export const x = <Button testId="dock-launcher" style={{ borderRadius: "12px" }} />; export { capsule };`,
      "zshell/concentric-geometry",
    );
    expect(goodDock.status, goodDock.output).toBe(0);

    const badQuickTileIcon = lintSnippet(
      "QuickSettingsPanel.tsx",
      `export const x = <box data-qs-tile-icon="true" style={{ borderRadius: "10px" }} />;`,
      "zshell/concentric-geometry",
    );
    expect(badQuickTileIcon.status).not.toBe(0);

    const goodQuickTileIcon = lintSnippet(
      "QuickSettingsPanel.tsx",
      `export const x = <box data-qs-tile-icon="true" style={{ borderRadius: "999px" }} />;`,
      "zshell/concentric-geometry",
    );
    expect(goodQuickTileIcon.status, goodQuickTileIcon.output).toBe(0);

    const badBarBadge = lintSnippet(
      "StatusBar.tsx",
      `const primaryContainer = "var(--color-primary-container)";
       export const x = <box testId="bar-notifications-badge" style={{ height: "24px", padding: "0 7px", backgroundColor: primaryContainer }} />;`,
      "zshell/concentric-geometry",
    );
    expect(badBarBadge.status).not.toBe(0);

    const goodBarBadge = lintSnippet(
      "StatusBar.tsx",
      `export const x = (props: { vertical: boolean; onActiveContainer: boolean }) => (
        <box testId="bar-notifications-badge" style={{
          ...(props.vertical ? { height: "20px", maxWidth: "28px", padding: "0 4px" } : { height: "24px", padding: "0 7px" }),
          ...(props.onActiveContainer ? { backgroundColor: "color-mix(in srgb, var(--color-on-primary-container) 14%, transparent)" } : {}),
        }} />
      );`,
      "zshell/concentric-geometry",
    );
    expect(goodBarBadge.status, goodBarBadge.output).toBe(0);
  });

  test("zshell/scoped-dismiss-instant restricts dismissInstant() strictly to PopupSurface onDismiss handlers", () => {
    const badEsc = lintSnippet(
      "BarPopups.tsx",
      `export const x = (p: { dismissInstant: () => void }) => <PopupContent onDismiss={() => p.dismissInstant()} />;`,
      "zshell/scoped-dismiss-instant",
    );
    expect(badEsc.status).not.toBe(0);

    const badSharedHelper = lintSnippet(
      "PluginHost.tsx",
      `export const x = (p: { dismissInstant: () => void }) => {
        const drop = () => { p.dismissInstant(); };
        return <PopupSurface onDismiss={drop}><Button onClick={drop} /></PopupSurface>;
      };`,
      "zshell/scoped-dismiss-instant",
    );
    expect(badSharedHelper.status).not.toBe(0);

    const goodInline = lintSnippet(
      "BarPopups.tsx",
      `export const x = (p: { dismissInstant: () => void }) => <PopupSurface onDismiss={() => p.dismissInstant()} />;`,
      "zshell/scoped-dismiss-instant",
    );
    expect(goodInline.status, goodInline.output).toBe(0);

    const goodDedicatedHelper = lintSnippet(
      "ShellPanels.tsx",
      `export const x = (p: { dismissInstant: () => void }) => {
        const handleDismiss = () => { p.dismissInstant(); };
        return <PopupSurface onDismiss={handleDismiss} />;
      };`,
      "zshell/scoped-dismiss-instant",
    );
    expect(goodDedicatedHelper.status, goodDedicatedHelper.output).toBe(0);
  });

  test("zshell/no-duplicate-primitives bans hand-rolled switches and slider thumbs outside zgui-primitives.tsx", () => {
    const badSwitch = lintSnippet(
      "CustomPanel.tsx",
      `export const Sw = () => <Button data-switch-root="true" />;`,
      "zshell/no-duplicate-primitives",
    );
    expect(badSwitch.status).not.toBe(0);

    const badSlider = lintSnippet(
      "CustomPanel.tsx",
      `export const Sl = () => <box data-slider-thumb="true" />;`,
      "zshell/no-duplicate-primitives",
    );
    expect(badSlider.status).not.toBe(0);

    const goodMedia = lintSnippet(
      "MediaPanel.tsx",
      `export const Scrubber = () => <box data-slider-thumb="true" />;`,
      "zshell/no-duplicate-primitives",
    );
    expect(goodMedia.status, goodMedia.output).toBe(0);
  });

  test("zshell/centered-text-badge requires flex vertical centering and explicit small-text lineHeight on badge containers", () => {
    const badBlockKeycap = lintSnippet(
      "ClipboardPanel.tsx",
      `export const Esc = () => (
        <box ariaHidden style={{ padding: "2px 6px", borderRadius: "6px", backgroundColor: "var(--color-surface-container-highest)" }}>
          <text style={{ fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "12px" }}>Esc</text>
        </box>
      );`,
      "zshell/centered-text-badge",
    );
    expect(badBlockKeycap.status).not.toBe(0);

    const badMissingLineHeight = lintSnippet(
      "ClipboardPanel.tsx",
      `export const Esc = () => (
        <box ariaHidden style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "22px", padding: "0 7px", borderRadius: "6px", backgroundColor: "var(--color-surface-container-highest)" }}>
          <text style={{ fontFamily: "var(--font-mono)", fontSize: "10px" }}>Esc</text>
        </box>
      );`,
      "zshell/centered-text-badge",
    );
    expect(badMissingLineHeight.status).not.toBe(0);

    const badRowMissingAlign = lintSnippet(
      "IdlePane.tsx",
      `export const Row = () => (
        <row style={{ borderRadius: "10px", backgroundColor: "var(--color-surface-container-highest)", padding: "8px 10px" }}>
          <text style={{ fontSize: "12px", lineHeight: "16px" }}>Rule</text>
        </row>
      );`,
      "zshell/centered-text-badge",
    );
    expect(badRowMissingAlign.status).not.toBe(0);

    const goodKeycap = lintSnippet(
      "ClipboardPanel.tsx",
      `export const Esc = () => (
        <box ariaHidden style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "22px", padding: "0 7px", borderRadius: "6px", backgroundColor: "var(--color-surface-container-highest)" }}>
          <text style={{ fontFamily: "var(--font-mono)", fontSize: "10px", lineHeight: "12px" }}>Esc</text>
        </box>
      );`,
      "zshell/centered-text-badge",
    );
    expect(goodKeycap.status, goodKeycap.output).toBe(0);

    const goodPlainHeader = lintSnippet(
      "SettingsWindow.tsx",
      `export const Header = () => <box style={{ padding: "0 8px 4px 8px" }}><text style={{ fontSize: "11px" }}>SHELL</text></box>;`,
      "zshell/centered-text-badge",
    );
    expect(goodPlainHeader.status, goodPlainHeader.output).toBe(0);
  });

  test("zshell/no-partial-card-hover forbids negative margins on <Button>/<control>", () => {
    const badShorthand = lintSnippet(
      "CalendarPanel.tsx",
      `export const Card = () => (
        <Button style={{ borderRadius: "10px", padding: "2px", margin: "-2px" }}>
          <text>Ghostty</text>
        </Button>
      );`,
      "zshell/no-partial-card-hover",
    );
    expect(badShorthand.status).not.toBe(0);

    const badTwoAxis = lintSnippet(
      "ClipboardPanel.tsx",
      `export const Row = () => (
        <Button style={{ borderRadius: "10px", padding: "4px 6px", margin: "-4px -6px" }}>
          <text>Entry</text>
        </Button>
      );`,
      "zshell/no-partial-card-hover",
    );
    expect(badTwoAxis.status).not.toBe(0);

    const badSideControl = lintSnippet(
      "IdlePane.tsx",
      `const hitStyle = { borderRadius: "10px", marginLeft: "-8px" } as const;
      export const Rule = () => <control style={{ ...hitStyle }} />;`,
      "zshell/no-partial-card-hover",
    );
    expect(badSideControl.status).not.toBe(0);

    const goodInteractiveCard = lintSnippet(
      "CalendarPanel.tsx",
      `export const Card = () => (
        <M3InteractiveCard layout="column" onClick={() => {}} style={{ borderRadius: "14px", padding: "10px" }}>
          <text>Ghostty</text>
        </M3InteractiveCard>
      );`,
      "zshell/no-partial-card-hover",
    );
    expect(goodInteractiveCard.status, goodInteractiveCard.output).toBe(0);

    const goodPositiveMargin = lintSnippet(
      "SettingsWindow.tsx",
      `export const Btn = () => (
        <Button style={{ borderRadius: "10px", marginTop: "4px", padding: "6px 10px" }}>
          <text>Save</text>
        </Button>
      );`,
      "zshell/no-partial-card-hover",
    );
    expect(goodPositiveMargin.status, goodPositiveMargin.output).toBe(0);
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
    const sysmonWin = readFileSync(join(shellDir, "src/surfaces/SystemMonitorWindow.tsx"), "utf8");
    expect(shellPanels).toContain(`height="auto"`);
    expect(pluginHost).toContain(`height="auto"`);
    expect(settingsWin).toContain("width={820}");
    expect(settingsWin).toContain("height={600}");
    expect(settingsWin).toContain(`width: "216px"`);
    expect(sysmonWin).toContain("width={820}");
    expect(sysmonWin).toContain("height={600}");
    expect(sysmonWin).toContain(`width: "216px"`);

    // QuickSettings Wi-Fi tile decouples visual active fill (wifiConnected) from toggle a11y checked (wifi.enabled).
    const qsPanel = readFileSync(join(shellDir, "src/panels/QuickSettingsPanel.tsx"), "utf8");
    expect(qsPanel).toContain("active={wifiConnected()} checked={Boolean(wifi()?.enabled)} toggle");
  });

  test("surface width tiers match DESIGN.md (Compact 360, Standard 396, Clipboard 560, Launcher 652, Overview 684)", () => {
    const shellPanels = readFileSync(join(shellDir, "src/panels/ShellPanels.tsx"), "utf8");
    const clipboardOverlay = readFileSync(join(shellDir, "src/surfaces/ClipboardOverlay.tsx"), "utf8");
    const powerDialog = readFileSync(join(shellDir, "src/surfaces/PowerDialog.tsx"), "utf8");
    const polkitDialog = readFileSync(join(shellDir, "src/surfaces/PolkitDialog.tsx"), "utf8");
    const primitivesCss = readFileSync(join(repoRoot, "packages/sdk/src/zgui-primitives.module.css"), "utf8");
    const launcher = readFileSync(join(shellDir, "src/surfaces/LauncherOverlay.tsx"), "utf8");
    const overview = readFileSync(join(repoRoot, "plugins/niri-overview/src/layer.tsx"), "utf8");
    const builtinOverview = readFileSync(join(shellDir, "src/surfaces/OverviewOverlay.tsx"), "utf8");

    expect(shellPanels).toMatch(/"quick-settings":\s*\{\s*width:\s*396\b/);
    expect(shellPanels).toMatch(/calendar:\s*\{\s*width:\s*396\b/);
    expect(shellPanels).toMatch(/media:\s*\{\s*width:\s*396\b/);
    expect(shellPanels).toMatch(/battery:\s*\{\s*width:\s*396\b/);
    expect(shellPanels).toMatch(/"system-monitor":\s*\{\s*width:\s*396\b/);
    expect(shellPanels).not.toMatch(/\bclipboard:/);
    expect(clipboardOverlay).toContain(`width: "560px"`);
    expect(clipboardOverlay).toContain(`keyboard="exclusive"`);
    expect(powerDialog).toContain("<M3DialogShell");
    expect(polkitDialog).toContain("<M3DialogShell");
    expect(primitivesCss).toMatch(/\.dialogCard\s*\{[^}]*width:\s*360px;/s);
    expect(launcher).toContain(`width: "652px"`);
    expect(overview).toContain(`width: "684px"`);
    expect(builtinOverview).toContain(`width: "684px"`);
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

  test("Dark & Light elevation shadow, 4-tier glass material, and material-web state-layer tokens stay synced across app.css and theme.ts", () => {
    const appCss = readFileSync(join(shellDir, "src/app.css"), "utf8");
    const darkSolid = buildThemeStylesheet(SHELL_DEFAULT_SCHEME, true, false);
    const lightSolid = buildThemeStylesheet(SHELL_DEFAULT_SCHEME, false, false);
    const darkGlass = buildThemeStylesheet(SHELL_DEFAULT_SCHEME, true, true);
    const lightGlass = buildThemeStylesheet(SHELL_DEFAULT_SCHEME, false, true);

    for (const token of [
      "--shadow-level-1:",
      "--shadow-level-2:",
      "--shadow-level-3:",
      "--surface-dock:",
      "--border-dock:",
      "--surface-bar-floating:",
      "--surface-bar-floating-active:",
      "--border-bar-floating:",
      "--surface-popover:",
      "--border-popover:",
      "--state-hover: 8%;",
      "--state-focus: 12%;",
      "--state-pressed: 12%;",
      "--state-dragged: 16%;",
      "--disabled-ink: 38%;",
      "--disabled-container: 12%;",
    ]) {
      expect(appCss, `app.css ${token}`).toContain(token);
      expect(darkSolid, `dark solid theme sheet ${token}`).toContain(token);
      expect(lightSolid, `light solid theme sheet ${token}`).toContain(token);
      expect(darkGlass, `dark glass theme sheet ${token}`).toContain(token);
      expect(lightGlass, `light glass theme sheet ${token}`).toContain(token);
    }

    // Wayland Graceful Solid Fallback: blurSupported === false paints 100% solid surface-container across all tiers.
    for (const sheet of [appCss, darkSolid, lightSolid]) {
      expect(sheet).toContain("--surface-dock: var(--color-surface-container);");
      expect(sheet).toContain("--surface-bar-floating: var(--color-surface-container);");
      expect(sheet).toContain("--surface-popover: var(--color-surface-container);");
    }

    // 4-Tier Frosted Glass Ladder when ext_background_effect_v1 blur is supported:
    // Dock (42%/40%) < Floating Bar (56%/58%) < Transient Popover (78%).
    expect(darkGlass).toContain("--surface-dock: color-mix(in srgb, var(--color-surface-container) 42%, transparent);");
    expect(darkGlass).toContain("--surface-bar-floating: color-mix(in srgb, var(--color-surface-container) 56%, transparent);");
    expect(darkGlass).toContain("--surface-popover: color-mix(in srgb, var(--color-surface-container) 78%, transparent);");
    expect(lightGlass).toContain("--surface-dock: color-mix(in srgb, var(--color-surface) 40%, transparent);");
    expect(lightGlass).toContain("--surface-bar-floating: color-mix(in srgb, var(--color-surface-container-low) 58%, transparent);");
    expect(lightGlass).toContain("--surface-popover: color-mix(in srgb, var(--color-surface-container-low) 78%, transparent);");

    expect(darkSolid).toContain("--shadow-level-3: 0 20px 56px rgba(0, 0, 0, 0.60);");
    expect(lightSolid).toContain("--shadow-level-3: 0 18px 48px rgba(25, 28, 32, 0.16);");
  });

  test("CSS Modules and stylesheets enforce DESIGN.md color, outline, font, and hover-stability invariants", () => {
    const validColorRoles = new Set([
      "surface", "surface-dim", "surface-bright",
      "surface-container-lowest", "surface-container-low", "surface-container",
      "surface-container-high", "surface-container-highest",
      "on-surface", "on-surface-variant", "inverse-surface", "inverse-on-surface",
      "outline", "outline-variant", "scrim",
      "primary", "on-primary", "primary-container", "on-primary-container",
      "secondary", "on-secondary", "secondary-container", "on-secondary-container",
      "tertiary", "on-tertiary", "tertiary-container", "on-tertiary-container",
      "error", "on-error", "error-container", "on-error-container",
    ]);

    const cssFiles = [
      join(repoRoot, "packages/sdk/src/zgui-primitives.module.css"),
      join(shellDir, "src/app.css"),
    ];

    for (const filePath of cssFiles) {
      const css = readFileSync(filePath, "utf8");
      const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

      expect(stripped, `${filePath} outline: none`).not.toMatch(/\boutline\s*:\s*(?:none|0(?:px)?)\s*;/i);
      expect(stripped, `${filePath} outline-width transition`).not.toMatch(/\btransition[^;]*\boutline-width\b/i);
      expect(stripped, `${filePath} system-ui font`).not.toMatch(/\bfamily\s*:\s*[^;]*system-ui/i);

      for (const match of stripped.matchAll(/var\(\s*--color-([a-z0-9-]+)/g)) {
        expect(validColorRoles.has(match[1]!), `${filePath} unknown color role --color-${match[1]}`).toBe(true);
      }

      for (const rule of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = rule[1] ?? "";
        const body = rule[2] ?? "";
        if (!/\btransform\s*:\s*[^;]*(?:translate|scale|rotate|skew|matrix)/i.test(body)) continue;
        for (const rawSel of selectors.split(",")) {
          const subject = rawSel.trim().split(/[\s>+~]+/).pop() ?? "";
          expect(subject, `${filePath} hover hit-target shift on "${rawSel.trim()}"`).not.toMatch(/:(?:hover|active)(?::[a-z-]+)*$/i);
        }
      }

      if (filePath.endsWith(".module.css")) {
        expect(stripped, `${filePath} raw color literal`).not.toMatch(/#(?:[0-9a-fA-F]{3,8})\b|\b(?:rgba?|hsla?)\s*\(/i);
        expect(stripped, `${filePath} unblurred translucent surface`).not.toMatch(
          /background(?:-color)?\s*:\s*color-mix\(\s*in\s+srgb\s*,\s*var\(--color-surface[^)]*\)\s+\d+(?:\.\d+)?%\s*,\s*transparent\s*\)/i,
        );
      }
    }
  });

  test("Universal Pointer Affordance & Tactile Activation contracts hold in app.css, zgui-primitives.module.css, and L1", () => {
    const appCss = readFileSync(join(shellDir, "src/app.css"), "utf8");
    const primitivesCss = readFileSync(join(repoRoot, "packages/sdk/src/zgui-primitives.module.css"), "utf8");

    // Global cursor: pointer for enabled controls + cursor: default for disabled & non-interactive progress indicators.
    expect(appCss).toMatch(/control:not\(:disabled\):not\(\[data-progress="true"\]\)[\s\S]*?cursor:\s*pointer;/);
    expect(appCss).toMatch(/:disabled[\s\S]*?cursor:\s*default;/);
    // Universal control:hover / control:active must explicitly exclude all non-inset & specialized roles (via both data-* for zgui-style and role).
    for (const pseudo of [":hover", ":active"] as const) {
      const ruleRegex = new RegExp(`control([^\\{]*)${pseudo}\\s*\\{[^}]*inset 0 0 0 240px`, "s");
      const match = appCss.match(ruleRegex);
      expect(match, `app.css universal control${pseudo} rule`).not.toBeNull();
      const selectorTail = match?.[1] ?? "";
      for (const excluded of [
        ":not(:disabled)",
        ':not([data-switch-root="true"])',
        ':not([data-dock-item="true"])',
        ':not([data-slider="true"])',
        ':not([data-progress="true"])',
        ':not([role="slider"])',
        ':not([role="progressIndicator"])',
        ':not([role="progressBar"])',
        ":not([data-bar-segment])",
      ]) {
        expect(selectorTail, `app.css control${pseudo} excludes ${excluded}`).toContain(excluded);
      }
    }
    // Universal inset hover/press state layer + bar island segment states + inner-visual press compression.
    expect(appCss).toContain("box-shadow: inset 0 0 0 240px color-mix(in srgb, var(--color-on-surface) var(--state-hover), transparent);");
    expect(appCss).toContain("box-shadow: inset 0 0 0 240px color-mix(in srgb, var(--color-on-surface) var(--state-dragged), transparent);");
    expect(appCss).toContain(`[data-bar-segment="floating"]:not(:disabled):hover`);
    expect(appCss).toContain(`[data-bar-segment="docked"]:not(:disabled):hover`);
    expect(appCss).toMatch(/\[data-press-visual\]\s*\{[^}]*pointer-events:\s*none;/s);
    expect(appCss).toMatch(/control:not\(:disabled\):active\s*>\s*\[data-press-visual="compact"\]/);
    expect(appCss).toMatch(/control:not\(:disabled\):active\s*>\s*\[data-press-visual="card"\]/);

    // Shared M3 primitives enforce pointer cursor, disabled default cursor, and inner press compression.
    expect(primitivesCss).toMatch(/\.pressInner\s*\{[^}]*pointer-events:\s*none;/s);
    expect(primitivesCss.match(/&:not\(:disabled\):active\s*>\s*\.pressInner/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(primitivesCss.match(/cursor:\s*pointer;/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(primitivesCss.match(/cursor:\s*default;/g)?.length ?? 0).toBeGreaterThanOrEqual(6);

    // L1 rejects stripping cursor: pointer on enabled <Button> or breaking [data-press-visual] pointer-events.
    const badCursor = lintSnippet(
      "StatusBar.tsx",
      `export const x = <Button style={{ cursor: "default" }}>Click</Button>;`,
      "zshell/no-hover-hit-target-shift",
    );
    expect(badCursor.status).not.toBe(0);

    const goodDisabledCursor = lintSnippet(
      "StatusBar.tsx",
      `export const x = <Button disabled={true} style={{ cursor: "default" }}>Click</Button>;`,
      "zshell/no-hover-hit-target-shift",
    );
    expect(goodDisabledCursor.status, goodDisabledCursor.output).toBe(0);

    const badPressVisual = lintSnippet(
      "QuickSettingsPanel.tsx",
      `export const x = <row data-press-visual="card" style={{ pointerEvents: "auto" }} />;`,
      "zshell/no-hover-hit-target-shift",
    );
    expect(badPressVisual.status).not.toBe(0);

    // zshell/interactive-hover-radius rejects inline-styled Buttons/controls without borderRadius
    // while allowing rounded buttons, rounded style spreads, and exempt slider/progress/switch controls.
    const badSharpBtn = lintSnippet(
      "IdlePane.tsx",
      `export const x = <Button style={{ backgroundColor: "transparent", minHeight: "32px" }}>Rule</Button>;`,
      "zshell/interactive-hover-radius",
    );
    expect(badSharpBtn.status).not.toBe(0);

    const goodRoundedBtn = lintSnippet(
      "IdlePane.tsx",
      `export const x = <Button style={{ backgroundColor: "transparent", borderRadius: "10px", minHeight: "32px" }}>Rule</Button>;`,
      "zshell/interactive-hover-radius",
    );
    expect(goodRoundedBtn.status, goodRoundedBtn.output).toBe(0);

    const goodSpreadBtn = lintSnippet(
      "CalendarPanel.tsx",
      `const pill = { borderRadius: "10px" } as const; export const x = <Button style={{ ...pill, padding: "4px" }}>Today</Button>;`,
      "zshell/interactive-hover-radius",
    );
    expect(goodSpreadBtn.status, goodSpreadBtn.output).toBe(0);

    const goodSliderControl = lintSnippet(
      "MediaPanel.tsx",
      `export const x = <control role={canScrub ? "slider" : "progressIndicator"} style={{ height: "28px" }} />;`,
      "zshell/interactive-hover-radius",
    );
    expect(goodSliderControl.status, goodSliderControl.output).toBe(0);

    // zshell/consistent-active-hover-shape catches mismatched active wrapper vs child hover radius,
    // plugin widget hardcoded pill radius, and offset/mismatched [data-active-indicator].
    const badSlotPad = lintSnippet(
      "StatusBar.tsx",
      `export const x = <box data-active="true" style={{ padding: "2px 0", borderRadius: "8px" }}><Button style={{ borderRadius: "999px" }}>W</Button></box>;`,
      "zshell/consistent-active-hover-shape",
    );
    expect(badSlotPad.status).not.toBe(0);

    const goodSlotInherit = lintSnippet(
      "StatusBar.tsx",
      `export const x = <box data-active="true" style={{ padding: "0px", borderRadius: "8px" }}><Button style={{ borderRadius: "inherit" }}>W</Button></box>;`,
      "zshell/consistent-active-hover-shape",
    );
    expect(goodSlotInherit.status, goodSlotInherit.output).toBe(0);

    const badIndicatorInset = lintSnippet(
      "StatusBar.tsx",
      `function WsBtn() { return <Button style={{ width: "24px", height: "24px", borderRadius: "6px" }} />; }
export function Track() { return <box><box data-active-indicator="true" style={{ left: "2px", top: "3px", borderRadius: "999px" }} /><WsBtn /></box>; }`,
      "zshell/consistent-active-hover-shape",
    );
    expect(badIndicatorInset.status).not.toBe(0);

    const goodIndicatorFlush = lintSnippet(
      "StatusBar.tsx",
      `function WsBtn() { return <Button style={{ width: "24px", height: "24px", borderRadius: "6px" }} />; }
export function Track() { return <box><box data-active-indicator="true" style={{ left: "0px", top: "0px", borderRadius: "6px" }} /><WsBtn /></box>; }`,
      "zshell/consistent-active-hover-shape",
    );
    expect(goodIndicatorFlush.status, goodIndicatorFlush.output).toBe(0);

    // zshell/no-child-control-overflow catches child <Button> wider/taller than its enclosing capsule.
    const badOverflow = lintSnippet(
      "StatusBar.tsx",
      `export const x = <box style={{ width: "30px", padding: "0px" }}><Button style={{ width: "32px", height: "24px", borderRadius: "6px" }}>O</Button></box>;`,
      "zshell/no-child-control-overflow",
    );
    expect(badOverflow.status).not.toBe(0);

    const goodContained = lintSnippet(
      "StatusBar.tsx",
      `export const x = <box style={{ width: "32px", padding: "0px" }}><Button style={{ width: "24px", height: "24px", borderRadius: "6px" }}>O</Button></box>;`,
      "zshell/no-child-control-overflow",
    );
    expect(goodContained.status, goodContained.output).toBe(0);
  });

  test("Smooth Corner Shape Contract: superellipse(2.83) on rounded-rect containers and round inheritance blocks on pills/circles", () => {
    const appCss = readFileSync(join(shellDir, "src/app.css"), "utf8");
    const primitivesCss = readFileSync(join(repoRoot, "packages/sdk/src/zgui-primitives.module.css"), "utf8");

    expect(appCss, "app.css declares superellipse(2.83) on :root").toMatch(
      /:root\s*\{[^}]*--zgui-corner-shape:\s*superellipse\(2\.83\);/s,
    );
    expect(appCss, "app.css resets floating bar capsules to round (--zgui-corner-shape: none)").toMatch(
      /\[data-bar-segment="floating"\]\s*\{[^}]*--zgui-corner-shape:\s*none;/s,
    );
    expect(appCss, "app.css provides [data-corner-shape=\"round\"] escape hatch").toMatch(
      /\[data-corner-shape="round"\]\s*\{[^}]*--zgui-corner-shape:\s*none;/s,
    );

    // Pill/circular primitives in zgui-primitives.module.css must block superellipse inheritance.
    for (const selector of [
      "switchTrack",
      "switchThumb",
      "sliderActiveTrack",
      "sliderInactiveTrack",
      "sliderStopDot",
      "linearProgressActive",
      "linearProgressInactive",
    ]) {
      expect(primitivesCss, `.${selector} blocks --zgui-corner-shape inheritance`).toMatch(
        new RegExp(`\\.${selector}\\s*\\{[^}]*--zgui-corner-shape:\\s*none;`, "s"),
      );
    }

    // Core shell circular/pill elements must explicitly block superellipse inheritance.
    for (const [relPath, label] of [
      ["apps/shell/src/surfaces/StatusBar.tsx", "StatusBar floating capsules & badges"],
      ["apps/shell/src/surfaces/DockSurface.tsx", "Dock running dots & focus pill"],
      ["apps/shell/src/surfaces/OsdOverlay.tsx", "OSD capsule"],
      ["apps/shell/src/surfaces/BarPopups.tsx", "Menu radio dot"],
      ["apps/shell/src/surfaces/NotificationToasts.tsx", "Toast circular dismiss button"],
      ["apps/shell/src/panels/QuickSettingsPanel.tsx", "QuickTile circular icon well"],
      ["apps/shell/src/panels/MediaPanel.tsx", "Media Play/Pause pill & circular transport buttons"],
      ["apps/shell/src/panels/CalendarPanel.tsx", "Calendar unread count pill"],
      ["apps/shell/src/panels/SystemMonitorPanel.tsx", "SystemMonitor popover cadence pill & memory bar"],
      ["apps/shell/src/surfaces/SystemMonitorWindow.tsx", "SystemMonitor window status dot & progress bars"],
      ["apps/shell/src/surfaces/settings/AppearancePane.tsx", "Settings circular color seed swatches"],
    ] as const) {
      const source = readFileSync(join(repoRoot, relPath), "utf8");
      expect(source, `${label} declares "--zgui-corner-shape": "none"`).toContain(`"--zgui-corner-shape": "none"`);
    }
  });
});
