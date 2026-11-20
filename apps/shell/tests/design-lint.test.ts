import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SHOJI_DEFAULT_SCHEME, buildThemeStylesheet } from "../src/theme.ts";
import { DEFAULT_BAR_SETTINGS } from "../src/topics.ts";

const shellDir = resolve(import.meta.dir, "..");
const repoRoot = resolve(shellDir, "../..");
const oxlintBin = join(repoRoot, "node_modules/.bin/oxlint");
const pluginPath = join(repoRoot, "tools/oxlint-design-plugin.mjs");

function lintSnippet(filename: string, code: string, rule: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "z-shell-design-lint-"));
  try {
    const configPath = join(dir, ".oxlintrc.json");
    const targetPath = join(dir, filename);
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

  test("zshell/expressive-budget scopes wavy progress to MediaPanel and scalloped shapes to brand/Launcher/Lock", () => {
    const badWavy = lintSnippet("QuickSettingsPanel.tsx", `export const x = <WavyProgress />;`, "zshell/expressive-budget");
    expect(badWavy.status).not.toBe(0);

    const goodWavy = lintSnippet("MediaPanel.tsx", `export const x = <WavyProgress />;`, "zshell/expressive-budget");
    expect(goodWavy.status, goodWavy.output).toBe(0);

    const badScallop = lintSnippet("CalendarPanel.tsx", `const scallopPath = "M0 0"; export const x = scallopPath;`, "zshell/expressive-budget");
    expect(badScallop.status).not.toBe(0);

    const goodScallop = lintSnippet("SessionLockOverlay.tsx", `const avatarScallop = "M0 0"; export const x = avatarScallop;`, "zshell/expressive-budget");
    expect(goodScallop.status, goodScallop.output).toBe(0);
  });

  test("zshell/no-lint-suppression rejects inline oxlint/eslint disable comments", () => {
    const bad = lintSnippet("Bad.tsx", `// oxlint-disable-next-line zshell/no-raw-colors\nexport const x = 1;`, "zshell/no-lint-suppression");
    expect(bad.status).not.toBe(0);

    const good = lintSnippet("Good.tsx", `// Regular explanation comment.\nexport const x = 1;`, "zshell/no-lint-suppression");
    expect(good.status, good.output).toBe(0);
  });
});

describe("DESIGN.md token and surface contract sync", () => {
  test("DESIGN.md frontmatter colors match SHOJI_DEFAULT_SCHEME and app.css :root", () => {
    const frontmatter = parseDesignFrontmatter();
    const appCss = readFileSync(join(shellDir, "src/app.css"), "utf8");
    const themeCss = buildThemeStylesheet(SHOJI_DEFAULT_SCHEME, true);

    for (const [token, expectedHex] of Object.entries(frontmatter.colors ?? {})) {
      const schemeKey = token.replaceAll("-", "_") as keyof typeof SHOJI_DEFAULT_SCHEME;
      expect(SHOJI_DEFAULT_SCHEME[schemeKey]?.toUpperCase(), `theme.ts ${schemeKey}`).toBe(expectedHex.toUpperCase());
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
    expect(appCss).toMatch(/--font-sans:\s*[^;]+;/);
    expect(appCss).toMatch(/--font-mono:\s*[^;]+;/);
    expect(appCss).not.toContain("--radius-20:");
    expect(appCss).not.toContain("--radius-30:");
  });

  test("bar default disables 1Hz clock seconds (No-1Hz-Flicker Rule)", () => {
    expect(DEFAULT_BAR_SETTINGS.clock_seconds).toBe(false);
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
    expect(shellPanels).toMatch(/battery:\s*\{\s*width:\s*360\b/);
    expect(shellPanels).toMatch(/clipboard:\s*\{\s*width:\s*560\b/);
    expect(powerDialog).toContain(`width: "360px"`);
    expect(polkitDialog).toContain(`width: "360px"`);
    expect(launcher).toContain(`width: "652px"`);
    expect(overview).toContain(`width: "684px"`);
  });
});
