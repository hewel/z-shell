import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { M3_EASINGS, M3_SPRINGS } from "@z-shell/sdk/zgui";
import { buildTablerIconsModule } from "../../../tools/sync-tabler-icons.ts";
import {
  LOCK_MORPH_SHAPES,
  MEDIA_EQ_REST_PATH,
  SHELL_ROSETTE_PATH,
  buildMediaEqWavePath,
  resolveIconStrokeWidthPx,
} from "../src/shapes.ts";
import { TABLER_ICON_PATHS } from "../src/tabler-icons.generated.ts";
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
  return lintSnippetWithCss(filename, code, null, rule);
}

function lintSnippetWithCss(
  filename: string,
  code: string,
  css: { filename?: string; content: string } | string | null,
  rule: string,
): { status: number | null; output: string } {
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
    if (css !== null) {
      const cssSpec = typeof css === "string"
        ? { filename: filename.replace(/\.tsx?$/, ".module.css"), content: css }
        : { filename: css.filename ?? filename.replace(/\.tsx?$/, ".module.css"), content: css.content };
      const cssPath = join(dirname(targetPath), cssSpec.filename);
      mkdirSync(dirname(cssPath), { recursive: true });
      writeFileSync(cssPath, cssSpec.content);
    }
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

  test("CSS Module L1 rules inspect imported *.module.css and class={styles.*} without losing coverage or false-positiving", () => {
    // no-raw-colors
    expect(
      lintSnippetWithCss(
        "Card.tsx",
        `import styles from "./Card.module.css"; export const X = () => <box class={styles.card} />;`,
        `.card { background-color: #254777; }`,
        "zshell/no-raw-colors",
      ).status,
    ).not.toBe(0);
    const goodColors = lintSnippetWithCss(
      "Card.tsx",
      `import styles from "./Card.module.css"; export const X = () => <box class={styles.card} />;`,
      `.card { background-color: var(--color-surface-container); border: 1px solid color-mix(in srgb, var(--color-primary) 30%, transparent); box-shadow: 0 14px 36px rgba(0, 0, 0, 0.50); }`,
      "zshell/no-raw-colors",
    );
    expect(goodColors.status, goodColors.output).toBe(0);

    // valid-color-roles (CSS rule pairing + ShellIcon ancestor class + conditional data-active / color-mix)
    expect(
      lintSnippetWithCss(
        "Alert.tsx",
        `import styles from "./Alert.module.css"; export const X = () => <box class={styles.alert} />;`,
        `.alert { &[data-active="true"] { background-color: var(--color-error-container); color: var(--color-error); } }`,
        "zshell/valid-color-roles",
      ).status,
    ).not.toBe(0);
    expect(
      lintSnippetWithCss(
        "Tile.tsx",
        `import styles from "./Tile.module.css"; export const X = () => <row class={styles.tile}><ShellIcon name="wifi" color="var(--color-primary)" /></row>;`,
        `.tile { background-color: var(--color-primary-container); }`,
        "zshell/valid-color-roles",
      ).status,
    ).not.toBe(0);
    const goodIconWell = lintSnippetWithCss(
      "Tile.tsx",
      `import styles from "./Tile.module.css"; export const X = (p: { active: boolean }) => (
        <row class={styles.well} data-active={p.active ? "true" : null}>
          <ShellIcon name="wifi" color={p.active ? "var(--color-primary)" : "var(--color-on-surface-variant)"} />
        </row>
      );`,
      `.well { background-color: var(--color-surface-container-highest); &[data-active="true"] { background-color: color-mix(in srgb, var(--color-primary) 18%, transparent); } }`,
      "zshell/valid-color-roles",
    );
    expect(goodIconWell.status, goodIconWell.output).toBe(0);
    const goodMenuItem = lintSnippetWithCss(
      "BarPopups.tsx",
      `import styles from "./BarPopups.module.css"; export const X = (p: { active: boolean }) => (
        <Button class={styles.item} data-active={p.active ? "true" : null}>
          <ShellIcon name="check" color={p.active ? "var(--color-on-primary-container)" : "var(--color-on-surface-variant)"} />
        </Button>
      );`,
      `.item { &[data-active="true"] { background-color: var(--color-primary-container); } }`,
      "zshell/valid-color-roles",
    );
    expect(goodMenuItem.status, goodMenuItem.output).toBe(0);

    // calm-active-surface
    expect(
      lintSnippetWithCss(
        "Card.tsx",
        `import styles from "./Card.module.css"; export const X = () => <row class={styles.card} />;`,
        `.card { flex-grow: 1; height: 52px; &[data-active="true"] { background-color: var(--color-primary); } }`,
        "zshell/calm-active-surface",
      ).status,
    ).not.toBe(0);
    const goodCalm = lintSnippetWithCss(
      "Card.tsx",
      `import styles from "./Card.module.css"; export const X = () => <Button class={styles.fab} />;`,
      `.fab { width: 52px; height: 52px; border-radius: 999px; background-color: var(--color-primary); }`,
      "zshell/calm-active-surface",
    );
    expect(goodCalm.status, goodCalm.output).toBe(0);

    // no-system-ui-font & valid-radius-scale & no-outline-none
    expect(
      lintSnippetWithCss(
        "Font.tsx",
        `import styles from "./Font.module.css"; export const X = () => <text class={styles.t}>A</text>;`,
        `.t { font-family: system-ui; }`,
        "zshell/no-system-ui-font",
      ).status,
    ).not.toBe(0);
    expect(
      lintSnippetWithCss(
        "Radius.tsx",
        `import styles from "./Radius.module.css"; export const X = () => <box class={styles.r} />;`,
        `.r { border-radius: 0 0 18px 18px; }`,
        "zshell/valid-radius-scale",
      ).status,
    ).not.toBe(0);
    const goodMultiRadius = lintSnippetWithCss(
      "Radius.tsx",
      `import styles from "./Radius.module.css"; export const X = () => <box class={styles.r} />;`,
      `.r { border-radius: 0 0 16px 16px; }`,
      "zshell/valid-radius-scale",
    );
    expect(goodMultiRadius.status, goodMultiRadius.output).toBe(0);
    expect(
      lintSnippetWithCss(
        "Focus.tsx",
        `import styles from "./Focus.module.css"; export const X = () => <Button class={styles.b} />;`,
        `.b { outline: none; }`,
        "zshell/no-outline-none",
      ).status,
    ).not.toBe(0);

    // tabular-readout
    expect(
      lintSnippetWithCss(
        "Readout.tsx",
        `import styles from "./Readout.module.css"; export const X = () => <text data-tabular="true" class={styles.num}>68%</text>;`,
        `.num { font-family: var(--font-mono); }`,
        "zshell/tabular-readout",
      ).status,
    ).not.toBe(0);
    const goodReadoutCss = lintSnippetWithCss(
      "Readout.tsx",
      `import styles from "./Readout.module.css"; export const X = () => <text data-tabular="true" class={styles.num}>68%</text>;`,
      `.num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }`,
      "zshell/tabular-readout",
    );
    expect(goodReadoutCss.status, goodReadoutCss.output).toBe(0);

    // composite-input-focus with cx() and template literal
    const goodCompositeCx = lintSnippetWithCss(
      "LauncherOverlay.tsx",
      `import styles from "./LauncherOverlay.module.css"; export const X = () => <row data-composite-input="true"><ShellIcon name="search" /><TextField class={cx(styles.field, "shell-composite-field")} onFocus={() => {}} onBlur={() => {}} value="" /></row>;`,
      `.field { flex-grow: 1; }`,
      "zshell/composite-input-focus",
    );
    expect(goodCompositeCx.status, goodCompositeCx.output).toBe(0);
    const goodCompositeTpl = lintSnippetWithCss(
      "LauncherOverlay.tsx",
      `import styles from "./LauncherOverlay.module.css"; export const X = () => <row data-composite-input="true"><ShellIcon name="search" /><TextField class={\`\${styles.field} shell-composite-field\`} onFocus={() => {}} onBlur={() => {}} value="" /></row>;`,
      `.field { flex-grow: 1; }`,
      "zshell/composite-input-focus",
    );
    expect(goodCompositeTpl.status, goodCompositeTpl.output).toBe(0);

    // no-hover-hit-target-shift (nested &:hover transform, [data-dock-visual] pointer-events, enabled Button cursor)
    expect(
      lintSnippetWithCss(
        "DockSurface.tsx",
        `import styles from "./DockSurface.module.css"; export const X = () => <Button class={styles.tile} />;`,
        `.tile { &:hover { transform: translateY(-4px); } }`,
        "zshell/no-hover-hit-target-shift",
      ).status,
    ).not.toBe(0);
    expect(
      lintSnippetWithCss(
        "DockSurface.tsx",
        `import styles from "./DockSurface.module.css"; export const X = () => <box data-dock-visual="true" class={styles.vis} />;`,
        `.vis { width: 38px; }`,
        "zshell/no-hover-hit-target-shift",
      ).status,
    ).not.toBe(0);
    expect(
      lintSnippetWithCss(
        "StatusBar.tsx",
        `import styles from "./StatusBar.module.css"; export const X = () => <Button class={styles.btn}>Go</Button>;`,
        `.btn { cursor: default; }`,
        "zshell/no-hover-hit-target-shift",
      ).status,
    ).not.toBe(0);
    const goodHoverCss = lintSnippetWithCss(
      "DockSurface.tsx",
      `import styles from "./DockSurface.module.css"; export const X = () => <Button class={styles.tile}><box data-dock-visual="true" class={styles.vis} /></Button>;`,
      `.tile { cursor: pointer; &:disabled { cursor: default; } &:not(:disabled):active > .vis { transform: scale(0.96); } } .vis { pointer-events: none; }`,
      "zshell/no-hover-hit-target-shift",
    );
    expect(goodHoverCss.status, goodHoverCss.output).toBe(0);

    // no-flush-surface-shadow & semantic-elevation-tokens & m3-motion-tokens & no-unblurred-translucent-surface
    expect(
      lintSnippetWithCss(
        "SettingsWindow.tsx",
        `import styles from "./SettingsWindow.module.css"; export const X = () => <WindowSurface class={styles.win} />;`,
        `.win { box-shadow: var(--shadow-level-3); }`,
        "zshell/no-flush-surface-shadow",
      ).status,
    ).not.toBe(0);
    expect(
      lintSnippetWithCss(
        "ShellPanels.tsx",
        `import styles from "./ShellPanels.module.css"; export const X = () => <PopupSurface><box class={styles.frame} /></PopupSurface>;`,
        `.frame { box-shadow: var(--shadow-level-2); }`,
        "zshell/no-flush-surface-shadow",
      ).status,
    ).not.toBe(0);
    const goodInsetCss = lintSnippetWithCss(
      "BarPopups.tsx",
      `import styles from "./BarPopups.module.css"; export const X = () => <PopupSurface geometryInsets={{ top: 20, right: 28, bottom: 38, left: 28 }}><box class={styles.frame} /></PopupSurface>;`,
      `.frame { box-shadow: var(--shadow-level-2); }`,
      "zshell/no-flush-surface-shadow",
    );
    expect(goodInsetCss.status, goodInsetCss.output).toBe(0);
    expect(
      lintSnippetWithCss(
        "Card.tsx",
        `import styles from "./Card.module.css"; export const X = () => <box class={styles.c} />;`,
        `.c { box-shadow: 0 20px 56px rgba(0, 0, 0, 0.6); }`,
        "zshell/semantic-elevation-tokens",
      ).status,
    ).not.toBe(0);
    expect(
      lintSnippetWithCss(
        "Anim.tsx",
        `import styles from "./Anim.module.css"; export const X = () => <box class={styles.c} />;`,
        `.c { transition-timing-function: ease-out; }`,
        "zshell/m3-motion-tokens",
      ).status,
    ).not.toBe(0);
    expect(
      lintSnippetWithCss(
        "SettingsWindow.tsx",
        `import styles from "./SettingsWindow.module.css"; export const X = () => <box class={styles.c} />;`,
        `.c { backdrop-filter: blur(20px); }`,
        "zshell/no-unblurred-translucent-surface",
      ).status,
    ).not.toBe(0);
    expect(
      lintSnippetWithCss(
        "DockSurface.tsx",
        `import styles from "./DockSurface.module.css"; export const X = () => <box class={styles.c} />;`,
        `.c { background-color: color-mix(in srgb, var(--color-surface-container) 42%, transparent); }`,
        "zshell/no-unblurred-translucent-surface",
      ).status,
    ).not.toBe(0);

    // min-hit-target-size & no-pill-action-button & interactive-hover-radius & no-partial-card-hover
    expect(
      lintSnippetWithCss(
        "Settings.tsx",
        `import styles from "./Settings.module.css"; export const X = () => <Button class={styles.tiny} />;`,
        `.tiny { width: 32px; height: 22px; }`,
        "zshell/min-hit-target-size",
      ).status,
    ).not.toBe(0);
    expect(
      lintSnippetWithCss(
        "PowerDialog.tsx",
        `import styles from "./PowerDialog.module.css"; export const X = () => <Button class={styles.pill}>Cancel</Button>;`,
        `.pill { height: 34px; padding: 0 16px; border-radius: 999px; }`,
        "zshell/no-pill-action-button",
      ).status,
    ).not.toBe(0);
    const goodCircleCss = lintSnippetWithCss(
      "PowerDialog.tsx",
      `import styles from "./PowerDialog.module.css"; export const X = () => <Button class={styles.circle}><text>X</text></Button>;`,
      `.circle { width: 36px; height: 36px; border-radius: 999px; }`,
      "zshell/no-pill-action-button",
    );
    expect(goodCircleCss.status, goodCircleCss.output).toBe(0);
    expect(
      lintSnippetWithCss(
        "IdlePane.tsx",
        `import styles from "./IdlePane.module.css"; export const X = () => <Button class={styles.sharp}>Rule</Button>;`,
        `.sharp { min-height: 32px; }`,
        "zshell/interactive-hover-radius",
      ).status,
    ).not.toBe(0);
    const goodHoverRadiusCss = lintSnippetWithCss(
      "IdlePane.tsx",
      `import styles from "./IdlePane.module.css"; export const X = () => <Button class={styles.rounded} data-size="md">Rule</Button>;`,
      `.rounded { &[data-size="md"] { border-radius: var(--radius-md); } }`,
      "zshell/interactive-hover-radius",
    );
    expect(goodHoverRadiusCss.status, goodHoverRadiusCss.output).toBe(0);
    expect(
      lintSnippetWithCss(
        "ClipboardPanel.tsx",
        `import styles from "./ClipboardPanel.module.css"; export const X = () => <Button class={styles.neg}>Row</Button>;`,
        `.neg { border-radius: 10px; margin: -4px -6px; }`,
        "zshell/no-partial-card-hover",
      ).status,
    ).not.toBe(0);

    // centered-text-badge
    expect(
      lintSnippetWithCss(
        "ClipboardPanel.tsx",
        `import styles from "./ClipboardPanel.module.css"; export const X = () => <box class={styles.badge}><text class={styles.lbl}>Esc</text></box>;`,
        `.badge { border-radius: 6px; background-color: var(--color-surface-container-highest); } .lbl { font-size: 10px; }`,
        "zshell/centered-text-badge",
      ).status,
    ).not.toBe(0);
    const goodBadgeCss = lintSnippetWithCss(
      "ClipboardPanel.tsx",
      `import styles from "./ClipboardPanel.module.css"; export const X = () => <box class={styles.badge}><text class={styles.lbl}>Esc</text></box>;`,
      `.badge { display: flex; align-items: center; justify-content: center; border-radius: 6px; background-color: var(--color-surface-container-highest); } .lbl { font-size: 10px; line-height: 12px; }`,
      "zshell/centered-text-badge",
    );
    expect(goodBadgeCss.status, goodBadgeCss.output).toBe(0);

    // concentric-geometry
    expect(
      lintSnippetWithCss(
        "DockSurface.tsx",
        `import styles from "./DockSurface.module.css"; export const X = () => <row class={styles.capsule}><Button testId="dock-launcher" class={styles.tile} /></row>;`,
        `.capsule { border-radius: 999px; } .tile { border-radius: 14px; }`,
        "zshell/concentric-geometry",
      ).status,
    ).not.toBe(0);
    expect(
      lintSnippetWithCss(
        "QuickSettingsPanel.tsx",
        `import styles from "./QuickSettingsPanel.module.css"; export const X = () => <box data-qs-tile-icon="true" class={styles.well} />;`,
        `.well { border-radius: 10px; }`,
        "zshell/concentric-geometry",
      ).status,
    ).not.toBe(0);
    const goodStatusBadgeCss = lintSnippetWithCss(
      "StatusBar.tsx",
      `import styles from "./StatusBar.module.css"; export const X = (p: { vertical: boolean; activeContainer: boolean }) => (
        <box testId="bar-notifications-badge" data-vertical={p.vertical ? "true" : null} data-active-container={p.activeContainer ? "true" : null} class={styles.badge} />
      );`,
      `.badge { height: 24px; background-color: var(--color-primary-container); &[data-vertical="true"] { max-width: 28px; } &[data-active-container="true"] { background-color: color-mix(in srgb, var(--color-on-primary-container) 14%, transparent); } }`,
      "zshell/concentric-geometry",
    );
    expect(goodStatusBadgeCss.status, goodStatusBadgeCss.output).toBe(0);

    // consistent-active-hover-shape & no-child-control-overflow
    expect(
      lintSnippetWithCss(
        "PluginHost.tsx",
        `import styles from "./PluginHost.module.css"; declare function registerPluginBarWidget(s: unknown): void;
         export function mount() { registerPluginBarWidget({ render: () => <box class={styles.wrap}><Widget /></box> }); }`,
        `.wrap { padding: 4px; border-radius: 8px; }`,
        "zshell/consistent-active-hover-shape",
      ).status,
    ).not.toBe(0);
    const goodPluginWrapCss = lintSnippetWithCss(
      "PluginHost.tsx",
      `import styles from "./PluginHost.module.css"; declare function registerPluginBarWidget(s: unknown): void;
       export function mount() { registerPluginBarWidget({ render: () => <box class={styles.wrap}><Widget /></box> }); }`,
      `.wrap { padding: 0px; border-radius: inherit; }`,
      "zshell/consistent-active-hover-shape",
    );
    expect(goodPluginWrapCss.status, goodPluginWrapCss.output).toBe(0);
    expect(
      lintSnippetWithCss(
        "plugins/ai-usage/src/widget.tsx",
        `import styles from "./widget.module.css"; export default function Widget() { return <Button class={styles.root} />; }`,
        `.root { border-radius: 999px; }`,
        "zshell/consistent-active-hover-shape",
      ).status,
    ).not.toBe(0);
    const goodIndicatorCss = lintSnippetWithCss(
      "StatusBar.tsx",
      `import styles from "./StatusBar.module.css";
       function WsBtn(p: { docked: boolean }) { return <Button data-docked={p.docked ? "true" : null} class={styles.wsBtn} />; }
       export function Track(p: { docked: boolean }) { return <box><box data-active-indicator="true" data-docked={p.docked ? "true" : null} class={styles.ind} /><WsBtn docked={p.docked} /></box>; }`,
      `.ind { left: 0px; top: 0px; border-radius: 999px; &[data-docked="true"] { border-radius: 6px; } }
       .wsBtn { border-radius: 999px; &[data-docked="true"] { border-radius: 6px; } }`,
      "zshell/consistent-active-hover-shape",
    );
    expect(goodIndicatorCss.status, goodIndicatorCss.output).toBe(0);
    expect(
      lintSnippetWithCss(
        "StatusBar.tsx",
        `import styles from "./StatusBar.module.css"; export const X = (p: { vertical: boolean }) => (
          <box data-vertical={p.vertical ? "true" : null} class={styles.capsule}><Button class={styles.btn}>O</Button></box>
        );`,
        `.capsule { height: 32px; &[data-vertical="true"] { width: 30px; height: auto; } } .btn { width: 32px; height: 24px; }`,
        "zshell/no-child-control-overflow",
      ).status,
    ).not.toBe(0);
    const goodOverflowCss = lintSnippetWithCss(
      "StatusBar.tsx",
      `import styles from "./StatusBar.module.css"; export const X = (p: { vertical: boolean }) => (
        <box data-vertical={p.vertical ? "true" : null} class={styles.capsule}><Button class={styles.btn}>O</Button></box>
      );`,
      `.capsule { height: 32px; &[data-vertical="true"] { width: 32px; height: auto; } } .btn { width: 24px; height: 24px; }`,
      "zshell/no-child-control-overflow",
    );
    expect(goodOverflowCss.status, goodOverflowCss.output).toBe(0);
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

  test("all Tier 1 system UI icons in SHELL_ICON_PATHS use pure 24x24 Tabler Outline (Col B) and proportional CSS stroke scaling", () => {
    const iconsSource = readFileSync(join(shellDir, "src/icons.tsx"), "utf8");
    expect(iconsSource).toContain("shellEmblem:");
    expect(iconsSource).toContain(`viewBox: "0 0 64 64"`);
    expect(iconsSource).toContain("d: SHELL_ROSETTE_PATH");
    expect(iconsSource).toContain("...TABLER_ICON_PATHS");
    expect(iconsSource).toContain("resolveIconStrokeWidthPx(");
    expect(iconsSource).not.toContain("filledD");

    expect(resolveIconStrokeWidthPx(12)).toBe("1px");
    expect(resolveIconStrokeWidthPx(15)).toBe("1.25px");
    expect(resolveIconStrokeWidthPx(16)).toBe("1.333px");
    expect(resolveIconStrokeWidthPx(18)).toBe("1.5px");
    expect(resolveIconStrokeWidthPx(24)).toBe("2px");

    const entries = Object.entries(TABLER_ICON_PATHS) as [string, Record<string, unknown> & { readonly viewBox: string; readonly d: string }][];
    expect(entries.length).toBe(80);
    const names = new Set(entries.map(([name]) => name));
    for (const required of ["apps", "overview", "ethernet", "mediaEq", "gpu", "memory", "wifiLock", "keyboardCapslock"]) {
      expect(names.has(required), `missing TABLER_ICON_PATHS.${required}`).toBe(true);
    }
    for (const [name, def] of entries) {
      expect(def.viewBox, `TABLER_ICON_PATHS.${name}`).toBe("0 0 24 24");
      expect(def.d.trim().length, `TABLER_ICON_PATHS.${name}.d`).toBeGreaterThan(0);
      expect("filledD" in def, `TABLER_ICON_PATHS.${name} must remain pure outline (Col B)`).toBe(false);
    }
    expect(TABLER_ICON_PATHS.wifiLock.d).toContain("M17 19a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-2");
    const generated = readFileSync(join(shellDir, "src/tabler-icons.generated.ts"), "utf8");
    expect(generated).toBe(buildTablerIconsModule(repoRoot));
  });

  test("analytical mediaEq wave paths match resting Tabler geometry and preserve vertical symmetry", () => {
    expect(MEDIA_EQ_REST_PATH).toBe(TABLER_ICON_PATHS.mediaEq.d);
    expect(buildMediaEqWavePath(0, 1.25)).toBe(MEDIA_EQ_REST_PATH);

    const frameA = buildMediaEqWavePath(1, 0);
    const frameB = buildMediaEqWavePath(1, 0.18);
    expect(frameA).not.toBe(frameB);

    const expectedXs = [4, 8, 12, 16, 20];
    for (let step = 0; step <= 20; step++) {
      const path = buildMediaEqWavePath(1, step * 0.1);
      const lines = path.split("\n");
      expect(lines.length).toBe(5);
      lines.forEach((line, index) => {
        const match = /^M(\d+(?:\.\d+)?) (\d+(?:\.\d+)?)v(\d+(?:\.\d+)?)$/.exec(line);
        expect(match, `segment ${index} format: ${line}`).not.toBeNull();
        const x = Number(match![1]);
        const y0 = Number(match![2]);
        const h = Number(match![3]);
        expect(x).toBe(expectedXs[index]);
        expect(Math.abs((y0 + h / 2) - 12)).toBeLessThan(1e-2);
        expect(h).toBeGreaterThanOrEqual(2);
        expect(h).toBeLessThanOrEqual(17.5);
      });
    }
  });
});

const VALID_COLOR_ROLES = new Set([
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

const SURFACE_FOREGROUND_ROLES = new Set([
  "on-surface",
  "on-surface-variant",
  "primary",
  "secondary",
  "tertiary",
  "error",
  "outline",
]);

const ROLE_PAIRS = new Map<string, ReadonlySet<string>>([
  ["primary", new Set(["on-primary"])],
  ["primary-container", new Set(["on-primary-container"])],
  ["secondary", new Set(["on-secondary"])],
  ["secondary-container", new Set(["on-secondary-container"])],
  ["tertiary", new Set(["on-tertiary"])],
  ["tertiary-container", new Set(["on-tertiary-container"])],
  ["error", new Set(["on-error"])],
  ["error-container", new Set(["on-error-container"])],
  ["inverse-surface", new Set(["inverse-on-surface"])],
  ["surface", SURFACE_FOREGROUND_ROLES],
  ["surface-dim", SURFACE_FOREGROUND_ROLES],
  ["surface-bright", SURFACE_FOREGROUND_ROLES],
  ["surface-container-lowest", SURFACE_FOREGROUND_ROLES],
  ["surface-container-low", SURFACE_FOREGROUND_ROLES],
  ["surface-container", SURFACE_FOREGROUND_ROLES],
  ["surface-container-high", SURFACE_FOREGROUND_ROLES],
  ["surface-container-highest", SURFACE_FOREGROUND_ROLES],
]);

const ALLOWED_RADIUS_PX = new Set([0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 22, 999]);
const ALLOWED_CUBIC_BEZIERS = new Set<string>(Object.values(M3_EASINGS));
const SKIPPED_SCAN_DIRS = new Set(["node_modules", "dist", ".zgui-generations", ".git"]);

function walkCssModules(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_SCAN_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCssModules(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".module.css")) {
      out.push(full);
    }
  }
}

function discoverCssModuleFiles(): string[] {
  const found: string[] = [];
  walkCssModules(join(repoRoot, "packages/sdk/src"), found);
  walkCssModules(join(shellDir, "src"), found);
  const pluginsDir = join(repoRoot, "plugins");
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walkCssModules(join(pluginsDir, entry.name, "src"), found);
      }
    }
  }
  return [...new Set(found)].sort();
}

interface ComponentSources {
  readonly tsx: string;
  readonly css: string;
}

function readComponentSources(relTsxPath: string): ComponentSources {
  const fullTsxPath = join(repoRoot, relTsxPath);
  const tsx = readFileSync(fullTsxPath, "utf8");
  const cssPaths = new Set<string>();
  for (const match of tsx.matchAll(/from\s+["'](\.[^"']+\.module\.css)["']/g)) {
    cssPaths.add(resolve(dirname(fullTsxPath), match[1]!));
  }
  const siblingModule = fullTsxPath.replace(/\.tsx?$/, ".module.css");
  if (existsSync(siblingModule)) {
    cssPaths.add(siblingModule);
  }
  const css = [...cssPaths]
    .filter(p => existsSync(p))
    .sort()
    .map(p => readFileSync(p, "utf8"))
    .join("\n");
  return { tsx, css };
}

function hasWidthPx(unit: ComponentSources, px: number): boolean {
  return unit.tsx.includes(`width: "${px}px"`) || new RegExp(`\\bwidth\\s*:\\s*${px}px\\b`).test(unit.css);
}

function hasRoundCornerBlock(unit: ComponentSources): boolean {
  return (
    unit.tsx.includes(`"--zgui-corner-shape": "none"`) ||
    unit.tsx.includes(`data-corner-shape="round"`) ||
    /--zgui-corner-shape\s*:\s*none\b/.test(unit.css)
  );
}

interface CssDeclaration {
  readonly prop: string;
  readonly value: string;
}

interface CssRuleBlock {
  readonly selectors: string[];
  readonly declarations: CssDeclaration[];
}

function splitTopLevel(input: string, isDelimiter: (ch: string) => boolean): string[] {
  const parts: string[] = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === "\\" && i + 1 < input.length) {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === `"` || ch === `'`) {
      quote = ch;
    } else if (ch === "(") {
      parenDepth++;
    } else if (ch === ")") {
      if (parenDepth > 0) parenDepth--;
    } else if (ch === "[") {
      bracketDepth++;
    } else if (ch === "]") {
      if (bracketDepth > 0) bracketDepth--;
    } else if (parenDepth === 0 && bracketDepth === 0 && isDelimiter(ch)) {
      const slice = input.slice(start, i).trim();
      if (slice.length > 0) parts.push(slice);
      start = i + 1;
    }
  }
  const tail = input.slice(start).trim();
  if (tail.length > 0) parts.push(tail);
  return parts;
}

function extractDeclarations(text: string): CssDeclaration[] {
  const decls: CssDeclaration[] = [];
  for (const stmt of splitTopLevel(text, ch => ch === ";")) {
    const colon = stmt.indexOf(":");
    if (colon <= 0) continue;
    const prop = stmt.slice(0, colon).trim().toLowerCase();
    const value = stmt.slice(colon + 1).trim();
    if (prop.length > 0) decls.push({ prop, value });
  }
  return decls;
}

function resolveNestedSelectors(parents: string[], rawSelector: string): string[] {
  const children = splitTopLevel(rawSelector, ch => ch === ",");
  if (parents.length === 0) return children;
  const resolved: string[] = [];
  for (const parent of parents) {
    for (const child of children) {
      resolved.push(child.includes("&") ? child.replaceAll("&", parent) : `${parent} ${child}`);
    }
  }
  return resolved;
}

function rightmostCompoundSelector(selector: string): string {
  const parts = splitTopLevel(selector, ch => ch === ">" || ch === "+" || ch === "~" || /\s/.test(ch));
  return parts.at(-1) ?? "";
}

function parseCssRuleBlocks(body: string, parentSelectors: string[] = []): CssRuleBlock[] {
  const blocks: CssRuleBlock[] = [];
  let inlineText = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;
  let i = 0;

  while (i < body.length) {
    const ch = body[i]!;
    if (quote) {
      inlineText += ch;
      if (ch === "\\" && i + 1 < body.length) {
        inlineText += body[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === `"` || ch === `'`) {
      quote = ch;
      inlineText += ch;
      i++;
      continue;
    }
    if (ch === "(") parenDepth++;
    else if (ch === ")" && parenDepth > 0) parenDepth--;
    else if (ch === "[") bracketDepth++;
    else if (ch === "]" && bracketDepth > 0) bracketDepth--;

    if (parenDepth === 0 && bracketDepth === 0 && ch === "{") {
      const semiIdx = inlineText.lastIndexOf(";");
      const prelude = (semiIdx >= 0 ? inlineText.slice(semiIdx + 1) : inlineText).trim();
      const beforePrelude = semiIdx >= 0 ? inlineText.slice(0, semiIdx + 1) : "";
      if (parentSelectors.length > 0 && beforePrelude.trim().length > 0) {
        const existing = blocks.find(b => b.selectors === parentSelectors);
        const decls = extractDeclarations(beforePrelude);
        if (existing) existing.declarations.push(...decls);
        else blocks.push({ selectors: parentSelectors, declarations: decls });
      }
      inlineText = "";

      let depth = 1;
      let j = i + 1;
      let innerQuote: string | null = null;
      while (j < body.length && depth > 0) {
        const c = body[j]!;
        if (innerQuote) {
          if (c === "\\" && j + 1 < body.length) {
            j += 2;
            continue;
          }
          if (c === innerQuote) innerQuote = null;
          j++;
          continue;
        }
        if (c === `"` || c === `'`) innerQuote = c;
        else if (c === "{") depth++;
        else if (c === "}") depth--;
        j++;
      }
      const innerBody = body.slice(i + 1, j - 1);
      i = j;

      if (prelude.startsWith("@")) {
        if (!/^@(?:-[a-z]+-)?keyframes\b/i.test(prelude)) {
          blocks.push(...parseCssRuleBlocks(innerBody, parentSelectors));
        }
      } else if (prelude.length > 0) {
        const selectors = resolveNestedSelectors(parentSelectors, prelude);
        const ruleBlock: CssRuleBlock = { selectors, declarations: [] };
        blocks.push(ruleBlock);
        blocks.push(...parseCssRuleBlocks(innerBody, selectors));
      }
      continue;
    }

    inlineText += ch;
    i++;
  }

  if (parentSelectors.length > 0 && inlineText.trim().length > 0) {
    const decls = extractDeclarations(inlineText);
    const existing = blocks.find(b => b.selectors === parentSelectors);
    if (existing) existing.declarations.push(...decls);
    else if (decls.length > 0) blocks.push({ selectors: parentSelectors, declarations: decls });
  }
  return blocks;
}

function isAllowedRadiusValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "inherit") return true;
  const parts = trimmed.split(/\s+/);
  for (const part of parts) {
    if (part === "0" || part === "50%" || /^var\(--radius-[a-z0-9-]+\)$/.test(part)) continue;
    const match = /^(\d+(?:\.\d+)?)px$/i.exec(part);
    if (!match) return false;
    if (!ALLOWED_RADIUS_PX.has(Number(match[1]))) return false;
  }
  return parts.length > 0;
}

function validateDesignStylesheet(css: string, filePath: string): string[] {
  const violations: string[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const normPath = filePath.replaceAll("\\", "/");
  const isModuleCss = normPath.endsWith(".module.css");
  const isSolidToplevel =
    /(?:^|\/)(?:SettingsWindow|SystemMonitorWindow)\.module\.css$/.test(normPath) ||
    /\/surfaces\/settings\/[^/]+\.module\.css$/.test(normPath);
  const isFlushToplevel = /(?:^|\/)(?:SettingsWindow|SystemMonitorWindow)\.module\.css$/.test(normPath);

  if (/\boutline\s*:\s*(?:none|0(?:px)?)\s*;/i.test(stripped)) {
    violations.push(`${filePath}: outline: none is forbidden`);
  }
  if (/\btransition(?:-property)?\s*:[^;{}]*\boutline-width\b/i.test(stripped)) {
    violations.push(`${filePath}: outline-width transition is forbidden`);
  }
  if (/\bfont-family\s*:[^;{}]*\bsystem-ui\b/i.test(stripped)) {
    violations.push(`${filePath}: system-ui font is forbidden`);
  }
  for (const match of stripped.matchAll(/var\(\s*--color-([a-z0-9-]+)/g)) {
    if (!VALID_COLOR_ROLES.has(match[1]!)) {
      violations.push(`${filePath}: unknown color role --color-${match[1]}`);
    }
  }
  if (isModuleCss) {
    if (/#(?:[0-9a-fA-F]{3,8})\b|\b(?:rgba?|hsla?)\s*\(/i.test(stripped)) {
      violations.push(`${filePath}: raw color literal is forbidden in *.module.css`);
    }
    if (
      /background(?:-color)?\s*:\s*color-mix\(\s*in\s+srgb\s*,\s*var\(--color-surface[^)]*\)\s+\d+(?:\.\d+)?%\s*,\s*transparent\s*\)/i.test(
        stripped,
      )
    ) {
      violations.push(`${filePath}: unblurred translucent surface is forbidden in *.module.css`);
    }
  }
  if (isSolidToplevel && /\bbackdrop-filter\s*:/i.test(stripped)) {
    violations.push(`${filePath}: backdrop-filter is forbidden on solid Settings/SystemMonitor toplevel sheets`);
  }

  for (const block of parseCssRuleBlocks(stripped)) {
    const isRootRule = block.selectors.every(sel => sel.trim() === ":root");
    let bgRole: string | null = null;
    let fgRole: string | null = null;

    for (const { prop, value } of block.declarations) {
      if (prop === "transform" && /\b(?:translate|scale|rotate|skew|matrix)/i.test(value)) {
        for (const sel of block.selectors) {
          const subject = rightmostCompoundSelector(sel);
          if (/:(?:hover|active)(?::[a-z-]+)*$/i.test(subject)) {
            violations.push(`${filePath}: hover/active hit-target shift on "${sel}"`);
          }
        }
      }
      if (
        !prop.startsWith("--") &&
        (prop === "border-radius" || /^border-(?:top|bottom)-(?:left|right)-radius$/.test(prop)) &&
        !isAllowedRadiusValue(value)
      ) {
        violations.push(`${filePath}: off-scale ${prop}: ${value}`);
      }
      if (prop === "background-color" || prop === "background") {
        const m = /^var\(\s*--color-([a-z0-9-]+)\s*\)$/.exec(value);
        if (m) bgRole = m[1]!;
      }
      if (prop === "color") {
        const m = /^var\(\s*--color-([a-z0-9-]+)\s*\)$/.exec(value);
        if (m) fgRole = m[1]!;
      }
      if (!isRootRule && prop === "transition-timing-function") {
        for (const item of splitTopLevel(value, ch => ch === ",")) {
          if (
            item !== "linear" &&
            !/^var\(--motion-easing-[a-z0-9-]+\)$/.test(item) &&
            !ALLOWED_CUBIC_BEZIERS.has(item)
          ) {
            violations.push(`${filePath}: non-M3 transition-timing-function "${item}"`);
          }
        }
      }
      if (!isRootRule && prop === "font-family" && !/^(?:var\(--font-(?:sans|mono)\)|inherit)$/.test(value.trim())) {
        violations.push(`${filePath}: non-semantic font-family "${value}"`);
      }
      if (isFlushToplevel && prop === "box-shadow") {
        const trimmed = value.trim().toLowerCase();
        if (trimmed !== "none" && !/^inset\b/.test(trimmed)) {
          violations.push(`${filePath}: flush prefer-no-csd toplevel window forbids outer box-shadow "${value}"`);
        }
      }
    }

    if (bgRole && fgRole) {
      const allowed = ROLE_PAIRS.get(bgRole);
      if (allowed && !allowed.has(fgRole)) {
        violations.push(`${filePath}: invalid color role pair --color-${fgRole} on --color-${bgRole}`);
      }
    }
  }

  return violations;
}

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
    const settingsWin = readComponentSources("apps/shell/src/surfaces/SettingsWindow.tsx");
    const sysmonWin = readComponentSources("apps/shell/src/surfaces/SystemMonitorWindow.tsx");
    expect(shellPanels).toContain(`height="auto"`);
    expect(pluginHost).toContain(`height="auto"`);
    expect(settingsWin.tsx).toContain("width={820}");
    expect(settingsWin.tsx).toContain("height={600}");
    expect(hasWidthPx(settingsWin, 216), "SettingsWindow 216px sidebar").toBe(true);
    expect(sysmonWin.tsx).toContain("width={820}");
    expect(sysmonWin.tsx).toContain("height={600}");
    expect(hasWidthPx(sysmonWin, 216), "SystemMonitorWindow 216px sidebar").toBe(true);

    // QuickSettings Wi-Fi tile decouples visual active fill (wifiConnected) from toggle a11y checked (wifi.enabled).
    const qsPanel = readFileSync(join(shellDir, "src/panels/QuickSettingsPanel.tsx"), "utf8");
    expect(qsPanel).toContain("active={wifiConnected()} checked={Boolean(wifi()?.enabled)} toggle");
  });

  test("surface width tiers match DESIGN.md (Compact 360, Standard 396, Clipboard 560, Launcher 652, Overview 684)", () => {
    const shellPanels = readFileSync(join(shellDir, "src/panels/ShellPanels.tsx"), "utf8");
    const clipboardOverlay = readComponentSources("apps/shell/src/surfaces/ClipboardOverlay.tsx");
    const powerDialog = readFileSync(join(shellDir, "src/surfaces/PowerDialog.tsx"), "utf8");
    const polkitDialog = readFileSync(join(shellDir, "src/surfaces/PolkitDialog.tsx"), "utf8");
    const primitivesCss = readFileSync(join(repoRoot, "packages/sdk/src/zgui-primitives.module.css"), "utf8");
    const launcher = readComponentSources("apps/shell/src/surfaces/LauncherOverlay.tsx");
    const overview = readComponentSources("plugins/niri-overview/src/layer.tsx");
    const builtinOverview = readComponentSources("apps/shell/src/surfaces/OverviewOverlay.tsx");

    expect(shellPanels).toMatch(/"quick-settings":\s*\{\s*width:\s*396\b/);
    expect(shellPanels).toMatch(/calendar:\s*\{\s*width:\s*396\b/);
    expect(shellPanels).toMatch(/media:\s*\{\s*width:\s*396\b/);
    expect(shellPanels).toMatch(/battery:\s*\{\s*width:\s*396\b/);
    expect(shellPanels).toMatch(/"system-monitor":\s*\{\s*width:\s*396\b/);
    expect(shellPanels).not.toMatch(/\bclipboard:/);
    expect(hasWidthPx(clipboardOverlay, 560), "ClipboardOverlay 560px width tier").toBe(true);
    expect(clipboardOverlay.tsx).toContain(`keyboard="exclusive"`);
    expect(powerDialog).toContain("<M3DialogShell");
    expect(polkitDialog).toContain("<M3DialogShell");
    expect(primitivesCss).toMatch(/\.dialogCard\s*\{[^}]*width:\s*360px;/s);
    expect(hasWidthPx(launcher, 652), "LauncherOverlay 652px width tier").toBe(true);
    expect(hasWidthPx(overview, 684), "niri-overview 684px width tier").toBe(true);
    expect(hasWidthPx(builtinOverview, 684), "OverviewOverlay 684px width tier").toBe(true);
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

  test("CSS Modules and stylesheets enforce DESIGN.md color, outline, font, radius, motion, and hover-stability invariants", () => {
    const moduleCssFiles = discoverCssModuleFiles();
    expect(moduleCssFiles.length).toBeGreaterThanOrEqual(1);
    const cssFiles = [join(shellDir, "src/app.css"), ...moduleCssFiles];

    for (const filePath of cssFiles) {
      const css = readFileSync(filePath, "utf8");
      expect(validateDesignStylesheet(css, filePath), filePath).toEqual([]);
    }

    expect(
      validateDesignStylesheet(`.card { border-radius: 24px; }`, "Card.module.css").length,
      "off-scale border-radius in CSS Module",
    ).toBeGreaterThan(0);
    expect(
      validateDesignStylesheet(
        `.alert { background-color: var(--color-error-container); color: var(--color-error); }`,
        "Alert.module.css",
      ).length,
      "mismatched color-role pair in CSS Module",
    ).toBeGreaterThan(0);
    expect(
      validateDesignStylesheet(`.tile { &:hover { transform: scale(1.02); } }`, "Tile.module.css").length,
      "nested hover hit-target shift",
    ).toBeGreaterThan(0);
    expect(
      validateDesignStylesheet(
        `.tile { &:not(:disabled):active > .pressInner { transform: scale(0.955); } }`,
        "Tile.module.css",
      ),
      "nested inner press visual transform is allowed",
    ).toEqual([]);
    expect(
      validateDesignStylesheet(`.tile { transition-timing-function: ease-in-out; }`, "Tile.module.css").length,
      "non-M3 timing curve in CSS Module",
    ).toBeGreaterThan(0);
    expect(
      validateDesignStylesheet(`.win { backdrop-filter: blur(20px); }`, "apps/shell/src/surfaces/SettingsWindow.module.css")
        .length,
      "backdrop-filter forbidden on solid SettingsWindow sheet",
    ).toBeGreaterThan(0);
    expect(
      validateDesignStylesheet(
        `.win { box-shadow: var(--shadow-level-3); }`,
        "apps/shell/src/surfaces/SettingsWindow.module.css",
      ).length,
      "outer box-shadow forbidden on prefer-no-csd SettingsWindow sheet",
    ).toBeGreaterThan(0);
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

    const badPluginWrapper = lintSnippet(
      "PluginHost.tsx",
      `declare function registerPluginBarWidget(spec: unknown): () => void;
export function mount() {
  return registerPluginBarWidget({ render: () => <box style={{ display: "flex" }}><WidgetComponent /></box> });
}`,
      "zshell/consistent-active-hover-shape",
    );
    expect(badPluginWrapper.status).not.toBe(0);

    const goodPluginWrapper = lintSnippet(
      "PluginHost.tsx",
      `declare function registerPluginBarWidget(spec: unknown): () => void;
export function mount() {
  return registerPluginBarWidget({ render: () => <box style={{ display: "flex", borderRadius: "inherit" }}><WidgetComponent /></box> });
}`,
      "zshell/consistent-active-hover-shape",
    );
    expect(goodPluginWrapper.status, goodPluginWrapper.output).toBe(0);

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
      const unit = readComponentSources(relPath);
      expect(
        hasRoundCornerBlock(unit),
        `${label} blocks superellipse inheritance (--zgui-corner-shape: none or data-corner-shape="round")`,
      ).toBe(true);
    }
  });
});
