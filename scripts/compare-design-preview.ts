#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

interface ManifestSurface {
  readonly id: string;
  readonly name: string;
  readonly theme: "dark" | "light";
  readonly pageId: string;
  readonly nodeId: string;
  readonly refFile: string;
  readonly previewRelPath: string | null;
}

interface PaperManifest {
  readonly paperFileId: string;
  readonly surfaces: readonly ManifestSurface[];
}

interface ResolvedSurface extends ManifestSurface {
  readonly refPath: string | null;
  readonly previewPath: string | null;
  readonly refAsset: string | null;
  readonly previewAsset: string | null;
  readonly status: "paired" | "preview-only" | "paper-only" | "missing";
}

interface StateCaptureSpec {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly previewRelPath: string;
}

interface ResolvedStateCapture extends StateCaptureSpec {
  readonly previewPath: string | null;
  readonly previewAsset: string | null;
}

interface HoverAtlasSpec {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly restRelPath: string;
  readonly hoverRelPath: string;
  readonly cropTestIds: readonly string[];
  readonly cursorTestId: string;
  readonly padPx?: number;
  readonly expectZeroDiff?: boolean;
}

interface ResolvedHoverPair extends HoverAtlasSpec {
  readonly restPath: string;
  readonly hoverPath: string;
  readonly treePath: string;
}

interface RenderedHoverCard {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly pairAsset: string;
  readonly diffPx: number;
  readonly expectZeroDiff: boolean;
}

const HOVER_ATLAS_ROOT = "z-shell-preview-design-hover-atlas/out/captures/surfaces";

const HOVER_ATLAS_SPECS: readonly HoverAtlasSpec[] = [
  {
    id: "cal-card-body",
    title: "Calendar · Card Body",
    subtitle: "Full R=14px card highlight (zero box-in-box before ×)",
    restRelPath: `${HOVER_ATLAS_ROOT}/panel-calendar/cal-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/panel-calendar/cal-card-hover.png`,
    cropTestIds: ["cal-notif-1"],
    cursorTestId: "cal-notif-default-1",
    padPx: 14,
  },
  {
    id: "cal-dismiss",
    title: "Calendar · Dismiss ×",
    subtitle: "Isolated × hover with zero double-highlight on card body",
    restRelPath: `${HOVER_ATLAS_ROOT}/panel-calendar/cal-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/panel-calendar/cal-dismiss-hover.png`,
    cropTestIds: ["cal-notif-1"],
    cursorTestId: "cal-notif-dismiss-1",
    padPx: 14,
  },
  {
    id: "clip-body",
    title: "Clipboard · Entry Body",
    subtitle: "Full R=14px entry row highlight behind thumbnail & text",
    restRelPath: `${HOVER_ATLAS_ROOT}/clipboard-overlay/clip-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/clipboard-overlay/clip-body-hover.png`,
    cropTestIds: ["clip-entry-101"],
    cursorTestId: "clip-copy-101",
    padPx: 12,
  },
  {
    id: "clip-pin",
    title: "Clipboard · Pin Button",
    subtitle: "Isolated Pin hover with card body unchanged",
    restRelPath: `${HOVER_ATLAS_ROOT}/clipboard-overlay/clip-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/clipboard-overlay/clip-pin-hover.png`,
    cropTestIds: ["clip-entry-101"],
    cursorTestId: "clip-pin-101",
    padPx: 12,
  },
  {
    id: "clip-forget",
    title: "Clipboard · Forget Button",
    subtitle: "Isolated Forget hover with card body unchanged",
    restRelPath: `${HOVER_ATLAS_ROOT}/clipboard-overlay/clip-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/clipboard-overlay/clip-forget-hover.png`,
    cropTestIds: ["clip-entry-101"],
    cursorTestId: "clip-forget-101",
    padPx: 12,
  },
  {
    id: "idle-rule-body",
    title: "IdlePane · Rule Row Body",
    subtitle: "Full R=14px rule card highlight spanning to right edge",
    restRelPath: `${HOVER_ATLAS_ROOT}/settings-window/idle-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/settings-window/idle-rule-hover.png`,
    cropTestIds: ["settings-idle-rule-card-dpms"],
    cursorTestId: "settings-idle-rule-dpms",
    padPx: 12,
  },
  {
    id: "idle-rule-switch",
    title: "IdlePane · Right M3Switch",
    subtitle: "Isolated switch hover with zero double-highlight on row",
    restRelPath: `${HOVER_ATLAS_ROOT}/settings-window/idle-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/settings-window/idle-switch-hover.png`,
    cropTestIds: ["settings-idle-rule-card-dpms"],
    cursorTestId: "settings-idle-switch-dpms",
    padPx: 12,
  },
  {
    id: "qs-split-left",
    title: "QuickSettings · SplitTile Left",
    subtitle: "Left toggle half hover isolated from right > button",
    restRelPath: `${HOVER_ATLAS_ROOT}/panel-quick-settings/qs-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/panel-quick-settings/qs-split-left-hover.png`,
    cropTestIds: ["qs-tile-card-wifi"],
    cursorTestId: "qs-tile-wifi",
    padPx: 14,
  },
  {
    id: "qs-split-right",
    title: "QuickSettings · SplitTile >",
    subtitle: "Right chevron hover isolated from left toggle half",
    restRelPath: `${HOVER_ATLAS_ROOT}/panel-quick-settings/qs-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/panel-quick-settings/qs-split-right-hover.png`,
    cropTestIds: ["qs-tile-card-wifi"],
    cursorTestId: "qs-open-wifi",
    padPx: 14,
  },
  {
    id: "media-sink",
    title: "Media · Output Sink Chip",
    subtitle: "Concentric rounded state layer on sink selector chip",
    restRelPath: `${HOVER_ATLAS_ROOT}/panel-media/media-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/panel-media/media-sink-hover.png`,
    cropTestIds: ["media-sink-toggle"],
    cursorTestId: "media-sink-toggle",
    padPx: 16,
  },
  {
    id: "media-play",
    title: "Media · Play/Pause",
    subtitle: "Primary transport button hover feedback",
    restRelPath: `${HOVER_ATLAS_ROOT}/panel-media/media-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/panel-media/media-play-hover.png`,
    cropTestIds: ["media-play-pause"],
    cursorTestId: "media-play-pause",
    padPx: 18,
  },
  {
    id: "media-unseekable",
    title: "Media · Unseekable Bar",
    subtitle: "progressIndicator hover must produce 0 changed pixels",
    restRelPath: `${HOVER_ATLAS_ROOT}/panel-media/media-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/panel-media/media-progress-hover.png`,
    cropTestIds: ["media-progress"],
    cursorTestId: "media-progress",
    padPx: 18,
    expectZeroDiff: true,
  },
  {
    id: "settings-nav",
    title: "Settings · Sidebar Nav",
    subtitle: "Sidebar nav pill hover clipped to rounded pill",
    restRelPath: `${HOVER_ATLAS_ROOT}/settings-window/settings-app-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/settings-window/settings-nav-hover.png`,
    cropTestIds: ["settings-nav-bar"],
    cursorTestId: "settings-nav-bar",
    padPx: 14,
  },
  {
    id: "settings-segmented",
    title: "Settings · M3SegmentedControl",
    subtitle: "Unselected segment hover inside shared rail",
    restRelPath: `${HOVER_ATLAS_ROOT}/settings-window/settings-app-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/settings-window/settings-seg-hover.png`,
    cropTestIds: ["settings-motion-standard", "settings-motion-reduced"],
    cursorTestId: "settings-motion-expressive",
    padPx: 14,
  },
  {
    id: "settings-wallpaper",
    title: "Settings · Wallpaper Thumb",
    subtitle: "16:9 wallpaper tile hover clipped to rounded card",
    restRelPath: `${HOVER_ATLAS_ROOT}/settings-window/settings-app-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/settings-window/settings-wp-hover.png`,
    cropTestIds: ["settings-wp-wp-2"],
    cursorTestId: "settings-wp-wp-2",
    padPx: 14,
  },
  {
    id: "bar-island",
    title: "StatusBar · Floating Island",
    subtitle: "Floating bar clock pill hover lift/state layer",
    restRelPath: `${HOVER_ATLAS_ROOT}/bar-dp-1/bar-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/bar-dp-1/bar-clock-hover.png`,
    cropTestIds: ["bar-clock"],
    cursorTestId: "bar-clock",
    padPx: 12,
  },
  {
    id: "dock-icon",
    title: "Dock · App Icon",
    subtitle: "Dock pinned app icon hover response",
    restRelPath: `${HOVER_ATLAS_ROOT}/dock-dp-1/dock-rest.png`,
    hoverRelPath: `${HOVER_ATLAS_ROOT}/dock-dp-1/dock-app-hover.png`,
    cropTestIds: ["dock-app-org.example.browser"],
    cursorTestId: "dock-app-org.example.browser",
    padPx: 18,
  },
];

const INTERACTIVE_STATE_SPECS: readonly StateCaptureSpec[] = [
  {
    id: "idle-rule-hover",
    name: "Idle Rule Hover (Anti-Sharp-Box)",
    description: "Unselected rule row hover clipped to R=10px",
    previewRelPath: "z-shell-preview-design-interactive/out/captures/surfaces/settings-window/idle-rule-hover.png",
  },
  {
    id: "media-unseekable-hover",
    name: "Unseekable Media Hover (Zero-Diff)",
    description: "progressIndicator hover paints zero gray box",
    previewRelPath: "z-shell-preview-design-interactive/out/captures/surfaces/panel-media/media-unseekable-hover.png",
  },
  {
    id: "toast-16x9",
    name: "16:9 Screenshot Toast Icon",
    description: "object-fit: cover fills rounded 36×36 tile",
    previewRelPath: "z-shell-preview-design-interactive/out/captures/surfaces/notification-toasts/toast-16x9.png",
  },
  {
    id: "bar-ws-t60",
    name: "Workspace Spring Mid-Flight (t=60ms)",
    description: "Shared primary pill gliding ws-1 -> ws-3",
    previewRelPath: "z-shell-preview-design-interactive/out/captures/surfaces/bar-dp-1/bar-ws-t60.png",
  },
  {
    id: "cal-chaos",
    name: "Calendar 17+ Notifications",
    description: "Isolated list scroll + Ghostty empty default hidden",
    previewRelPath: "z-shell-preview-design-chaos/out/captures/surfaces/panel-calendar/cal-chaos.png",
  },
  {
    id: "bar-chaos",
    name: "Vertical Bar (17 Badge + 中 IME)",
    description: "28×28 & 30×30 concentric circular pills",
    previewRelPath: "z-shell-preview-design-chaos/out/captures/surfaces/bar-dp-1/bar-chaos.png",
  },
  {
    id: "qs-chaos",
    name: "QS Ethernet + Wi-Fi Disconnected",
    description: "Neutral Wi-Fi tile + visible avatar fallback",
    previewRelPath: "z-shell-preview-design-chaos/out/captures/surfaces/panel-quick-settings/qs-chaos.png",
  },
  {
    id: "media-idle",
    name: "14B · Media Idle State",
    description: "Nothing playing card with accessible output sink chip",
    previewRelPath: "z-shell-preview-design-new-states/out/captures/surfaces/panel-media/media-idle.png",
  },
  {
    id: "ime-menu-09e",
    name: "09E · IME Switcher Popup",
    description: "INPUT METHOD header + active primary-container IM row",
    previewRelPath: "z-shell-preview-design-new-states/out/captures/surfaces/ime-menu/ime-menu-09e.png",
  },
  {
    id: "cal-empty",
    name: "13B · Calendar Empty Notifications",
    description: "Centered All caught up card",
    previewRelPath: "z-shell-preview-design-new-states/out/captures/surfaces/panel-calendar/cal-empty.png",
  },
  {
    id: "launcher-empty",
    name: "18B · Launcher Empty Search",
    description: "Centered No matching apps card",
    previewRelPath: "z-shell-preview-design-new-states/out/captures/surfaces/launcher-overlay/launcher-empty.png",
  },
  {
    id: "toast-notif-media-12b",
    name: "12B · Toast Avatar + App Badge",
    description: "40×40 square avatar with 18×18 circular XDG badge cutout",
    previewRelPath: "z-shell-preview-design-new-states/out/captures/surfaces/notification-toasts/toast-notif-media-12b.png",
  },
  {
    id: "toast-stack-collapsed-12c",
    name: "12C · Toast Stack Collapsed (Layered Deck)",
    description: "Main card + 2 tucked deck edges + M3InteractiveCard +3 more footer",
    previewRelPath: "z-shell-preview-design-toast-stack/out/captures/surfaces/notification-toasts/toast-stack-collapsed.png",
  },
];

function parseArgs(argv: readonly string[]): {
  refsDir: string;
  previewDir: string;
  outDir: string;
  runPreview: boolean;
  sheets: boolean;
} {
  let refsDir = "/tmp/z-shell-paper-refs";
  let previewDir = process.env.PREVIEW_OUT_DIR || "/tmp/z-shell-preview-compare/preview";
  let outDir = "/tmp/z-shell-preview-compare";
  let runPreview = false;
  let sheets = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--refs-dir" && argv[i + 1]) {
      refsDir = argv[++i]!;
    } else if (arg === "--preview-dir" && argv[i + 1]) {
      previewDir = argv[++i]!;
    } else if (arg === "--out-dir" && argv[i + 1]) {
      outDir = argv[++i]!;
    } else if (arg === "--run-preview") {
      runPreview = true;
    } else if (arg === "--no-sheets") {
      sheets = false;
    } else if (arg === "-h" || arg === "--help") {
      console.log(`Usage: bun scripts/compare-design-preview.ts [options]
  --refs-dir <dir>     Directory with exported Paper reference images (default: /tmp/z-shell-paper-refs)
  --preview-dir <dir>  PREVIEW_OUT_DIR from design-preview.test.ts (default: $PREVIEW_OUT_DIR or /tmp/z-shell-preview-compare/preview)
  --out-dir <dir>      Output directory for index.html, manifest.json, and PNG contact sheets (default: /tmp/z-shell-preview-compare)
  --run-preview        Force re-running design-preview.test.ts into --preview-dir
  --no-sheets          Skip generating PNG contact sheets via Pillow`);
      process.exit(0);
    }
  }

  return {
    refsDir: resolve(refsDir),
    previewDir: resolve(previewDir),
    outDir: resolve(outDir),
    runPreview,
    sheets,
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildHtml(
  manifest: PaperManifest,
  items: readonly ResolvedSurface[],
  states: readonly ResolvedStateCapture[],
  hoverCards: readonly RenderedHoverCard[],
  sheetFiles: readonly string[],
): string {
  const counts = {
    paired: items.filter(item => item.status === "paired").length,
    previewOnly: items.filter(item => item.status === "preview-only").length,
    paperOnly: items.filter(item => item.status === "paper-only").length,
    missing: items.filter(item => item.status === "missing").length,
  };

  const cards = items
    .map(item => {
      const refMarkup = item.refAsset
        ? `<img src="${escapeHtml(item.refAsset)}" alt="Paper ${escapeHtml(item.name)}" loading="lazy" />`
        : `<div class="placeholder">Missing Paper ref<br/><code>${escapeHtml(item.refFile)}</code><br/>Paper node <code>${escapeHtml(item.nodeId)}</code></div>`;
      const previewMarkup = item.previewAsset
        ? `<img src="${escapeHtml(item.previewAsset)}" alt="Preview ${escapeHtml(item.name)}" loading="lazy" />`
        : `<div class="placeholder">${
            item.previewRelPath
              ? `Preview not captured<br/><code>${escapeHtml(item.previewRelPath)}</code>`
              : "No L4 preview capture mapped yet"
          }</div>`;

      return `<section class="card" data-theme="${item.theme}" data-status="${item.status}">
  <header class="card-header">
    <div>
      <h2>${escapeHtml(item.name)}</h2>
      <div class="meta">
        <span class="badge theme-${item.theme}">${item.theme.toUpperCase()}</span>
        <span class="badge status-${item.status}">${item.status.toUpperCase()}</span>
        <code>${escapeHtml(item.pageId)} / ${escapeHtml(item.nodeId)}</code>
      </div>
    </div>
    <code class="id-pill">${escapeHtml(item.id)}</code>
  </header>
  <div class="compare-grid">
    <figure class="pane">
      <figcaption>Paper Reference <code>${escapeHtml(item.refFile)}</code></figcaption>
      <div class="stage">${refMarkup}</div>
    </figure>
    <figure class="pane">
      <figcaption>Headless Preview <code>${escapeHtml(item.previewRelPath ?? "—")}</code></figcaption>
      <div class="stage">${previewMarkup}</div>
    </figure>
  </div>
</section>`;
    })
    .join("\n");

  const sheetLinks = sheetFiles.length > 0
    ? `<div class="sheets">Contact sheets: ${sheetFiles.map(file => `<a href="sheets/${escapeHtml(file)}">${escapeHtml(file)}</a>`).join(" · ")}</div>`
    : "";

  const hoverAtlasMarkup = hoverCards.length > 0
    ? `<section class="card states-section" data-theme="dark" data-status="hover-atlas">
  <header class="card-header">
    <div>
      <h2>Hover Atlas — Rest vs Hover (${hoverCards.length})</h2>
      <div class="meta">
        <span class="badge status-paired">HOVER AUDIT</span>
        <code>Red/white target marks virtual pointer · Full-card M3InteractiveCard vs isolated secondary controls</code>
      </div>
    </div>
    <code class="id-pill">sheets/hover-atlas.png</code>
  </header>
  <div class="hover-grid">
    ${hoverCards
      .map(card => {
        const diffBadge = card.expectZeroDiff
          ? `<span class="badge ${card.diffPx === 0 ? "status-paired" : "status-paper-only"}">${card.diffPx} px diff</span>`
          : `<span class="badge status-preview-only">${card.diffPx} px diff</span>`;
        return `<figure class="pane state-card">
      <figcaption><strong>${escapeHtml(card.title)} ${diffBadge}</strong><span>${escapeHtml(card.subtitle)}</span></figcaption>
      <div class="stage"><img src="${escapeHtml(card.pairAsset)}" alt="${escapeHtml(card.title)}" loading="lazy" /></div>
    </figure>`;
      })
      .join("\n")}
  </div>
</section>`
    : "";

  const availableStates = states.filter(state => state.previewAsset);
  const stateStripMarkup = availableStates.length > 0
    ? `<section class="card states-section" data-theme="dark" data-status="states">
  <header class="card-header">
    <div>
      <h2>Interactive &amp; Chaos States (${availableStates.length})</h2>
      <div class="meta">
        <span class="badge status-paired">L4 INVARIANTS</span>
        <code>Hover pixel-diff · Mid-flight keyframes · Dirty-data fixtures</code>
      </div>
    </div>
    <code class="id-pill">sheets/states.png</code>
  </header>
  <div class="state-strip">
    ${availableStates
      .map(
        state => `<figure class="pane state-card">
      <figcaption><strong>${escapeHtml(state.name)}</strong><span>${escapeHtml(state.description)}</span></figcaption>
      <div class="stage"><img src="${escapeHtml(state.previewAsset!)}" alt="${escapeHtml(state.name)}" loading="lazy" /></div>
    </figure>`,
      )
      .join("\n")}
  </div>
</section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>z-shell · Paper vs Headless Preview Comparison</title>
<style>
  :root { color-scheme: dark; --bg: #0f1116; --panel: #171a21; --stage: #111318; --ink: #e5e7eb; --muted: #9ca3af; --border: #2a2f3a; --accent: #93c5fd; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Roboto Flex", system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--ink); padding: 20px 24px 48px; }
  header.top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
  h1 { margin: 0; font-size: 20px; font-weight: 600; }
  .summary { color: var(--muted); font-size: 13px; margin-top: 4px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .controls button { background: var(--panel); color: var(--ink); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
  .controls button.active { background: #254777; border-color: var(--accent); color: #d4e3ff; }
  .sheets { margin-bottom: 16px; font-size: 12px; color: var(--muted); }
  .sheets a { color: var(--accent); text-decoration: none; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 14px 16px; margin-bottom: 16px; }
  .card.hidden { display: none; }
  .card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .card-header h2 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px; color: var(--muted); }
  .badge { padding: 2px 7px; border-radius: 999px; font-weight: 600; font-size: 10px; }
  .theme-dark { background: #262b36; color: #cbd5e1; }
  .theme-light { background: #e2e8f0; color: #0f172a; }
  .status-paired { background: #14532d; color: #bbf7d0; }
  .status-preview-only { background: #1e3a8a; color: #bfdbfe; }
  .status-paper-only { background: #78350f; color: #fde68a; }
  .status-missing { background: #3f3f46; color: #d4d4d8; }
  .id-pill { font-size: 11px; color: var(--muted); background: #0d0f14; padding: 3px 8px; border-radius: 6px; }
  .compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .state-strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
  .hover-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(460px, 1fr)); gap: 14px; }
  .state-card figcaption { flex-direction: column; gap: 2px; }
  .state-card figcaption strong { color: var(--ink); font-size: 12px; }
  @media (max-width: 980px) { .compare-grid { grid-template-columns: 1fr; } }
  figure.pane { margin: 0; display: flex; flex-direction: column; gap: 6px; }
  figcaption { font-size: 12px; color: var(--muted); display: flex; justify-content: space-between; gap: 8px; }
  figcaption code { font-size: 11px; color: #cbd5e1; }
  .stage { min-height: 160px; border-radius: 12px; border: 1px solid var(--border); padding: 14px; display: flex; align-items: center; justify-content: center; overflow: auto; background: var(--stage); }
  body.bg-dark .stage { background: #0d1016; }
  body.bg-light .stage { background: #e8edf5; }
  body.bg-checker .stage {
    background-color: #1f2430;
    background-image: linear-gradient(45deg, #2a3040 25%, transparent 25%), linear-gradient(-45deg, #2a3040 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #2a3040 75%), linear-gradient(-45deg, transparent 75%, #2a3040 75%);
    background-size: 16px 16px;
    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  }
  .stage img { max-width: 100%; max-height: 640px; object-fit: contain; display: block; }
  .placeholder { text-align: center; color: var(--muted); font-size: 12px; line-height: 1.6; }
</style>
</head>
<body class="bg-checker">
<header class="top">
  <div>
    <h1>z-shell · Paper vs Headless Preview</h1>
    <div class="summary">
      Paper file <code>${escapeHtml(manifest.paperFileId)}</code> ·
      ${counts.paired} paired · ${counts.previewOnly} preview-only · ${counts.paperOnly} paper-only · ${counts.missing} unmapped
    </div>
  </div>
  <div class="controls">
    <button data-filter="all" class="active">All (${items.length})</button>
    <button data-filter="paired">Paired (${counts.paired})</button>
    <button data-filter="dark">Dark</button>
    <button data-filter="light">Light</button>
    <span style="width:1px;height:18px;background:var(--border);margin:0 2px;"></span>
    <button data-bg="bg-checker" class="active">Checker</button>
    <button data-bg="bg-dark">Dark Stage</button>
    <button data-bg="bg-light">Light Stage</button>
  </div>
</header>
${sheetLinks}
${hoverAtlasMarkup}
${stateStripMarkup}
${cards}
<script>
  const cards = [...document.querySelectorAll('.card')];
  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.filter;
      cards.forEach(c => {
        const show = mode === 'all' || (mode === 'paired' ? c.dataset.status === 'paired' : c.dataset.theme === mode);
        c.classList.toggle('hidden', !show);
      });
    });
  });
  document.querySelectorAll('[data-bg]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-bg]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.body.className = btn.dataset.bg;
    });
  });
</script>
</body>
</html>`;
}

function generateContactSheets(outDir: string, items: readonly ResolvedSurface[]): string[] {
  const paired = items.filter(item => item.refPath && item.previewPath);
  if (paired.length === 0) return [];
  const sheetsDir = join(outDir, "sheets");
  mkdirSync(sheetsDir, { recursive: true });

  const pyScript = `
import json, math, os, sys
from PIL import Image, ImageDraw

items = json.loads(sys.argv[1])
out_dir = sys.argv[2]
per_sheet = 4
col_w = 560
pad = 16
header_h = 26
created = []

for chunk_idx in range(0, len(items), per_sheet):
    chunk = items[chunk_idx:chunk_idx + per_sheet]
    rows = []
    for item in chunk:
        left = Image.open(item["refPath"]).convert("RGBA")
        right = Image.open(item["previewPath"]).convert("RGBA")
        def fit(im, max_w, max_h):
            scale = min(1.0, max_w / max(1, im.width), max_h / max(1, im.height))
            if scale < 1.0:
                return im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.LANCZOS)
            return im
        left_f = fit(left, col_w - 16, 460)
        right_f = fit(right, col_w - 16, 460)
        row_h = max(left_f.height, right_f.height) + header_h + 24
        rows.append((item, left_f, right_f, row_h))

    total_w = col_w * 2 + pad * 3
    total_h = pad + sum(r[3] + pad for r in rows)
    canvas = Image.new("RGBA", (total_w, total_h), (18, 21, 28, 255))
    draw = ImageDraw.Draw(canvas)
    y = pad
    for item, left_f, right_f, row_h in rows:
        stage_bg = (232, 237, 245, 255) if item["theme"] == "light" else (28, 32, 42, 255)
        draw.rectangle([pad, y, total_w - pad, y + row_h], fill=(24, 28, 36, 255), outline=(58, 65, 80, 255))
        draw.text((pad + 10, y + 6), f'{item["name"]} [{item["id"]}]  |  LEFT: Paper ({item["nodeId"]})  vs  RIGHT: Headless Preview', fill=(226, 232, 240, 255))
        body_y = y + header_h
        body_h = row_h - header_h - 8
        lx = pad + 8
        rx = pad * 2 + col_w
        draw.rectangle([lx, body_y, lx + col_w - 8, body_y + body_h], fill=stage_bg)
        draw.rectangle([rx, body_y, rx + col_w - 8, body_y + body_h], fill=stage_bg)
        canvas.alpha_composite(left_f, (lx + (col_w - 8 - left_f.width) // 2, body_y + (body_h - left_f.height) // 2))
        canvas.alpha_composite(right_f, (rx + (col_w - 8 - right_f.width) // 2, body_y + (body_h - right_f.height) // 2))
        y += row_h + pad

    filename = f"sheet-{(chunk_idx // per_sheet) + 1}.png"
    canvas.convert("RGB").save(os.path.join(out_dir, filename))
    created.append(filename)

print(json.dumps(created))
`;

  const proc = spawnSync("python3", ["-c", pyScript, JSON.stringify(paired), sheetsDir], {
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    console.warn(`[design:compare] Pillow contact sheet skipped (${proc.stderr.trim() || "python3/PIL unavailable"}).`);
    return [];
  }
  try {
    return JSON.parse(proc.stdout.trim()) as string[];
  } catch {
    return [];
  }
}

function generateStateSheet(outDir: string, states: readonly ResolvedStateCapture[]): string | null {
  const present = states.filter(state => state.previewPath);
  if (present.length === 0) return null;
  const sheetsDir = join(outDir, "sheets");
  mkdirSync(sheetsDir, { recursive: true });

  const pyScript = `
import json, math, os, sys
from PIL import Image, ImageDraw

items = json.loads(sys.argv[1])
out_path = sys.argv[2]
cols = 2
cell_w = 560
pad = 16
header_h = 34
rows = []

for i in range(0, len(items), cols):
    row_items = items[i:i + cols]
    fitted = []
    max_h = 160
    for item in row_items:
        im = Image.open(item["previewPath"]).convert("RGBA")
        scale = min(1.0, (cell_w - 20) / max(1, im.width), 420 / max(1, im.height))
        if scale < 1.0:
            im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.LANCZOS)
        max_h = max(max_h, im.height)
        fitted.append((item, im))
    rows.append((fitted, max_h + header_h + 24))

total_w = cell_w * cols + pad * (cols + 1)
total_h = pad + sum(r[1] + pad for r in rows)
canvas = Image.new("RGBA", (total_w, total_h), (18, 21, 28, 255))
draw = ImageDraw.Draw(canvas)
y = pad
for fitted, row_h in rows:
    for col_idx, (item, im) in enumerate(fitted):
        x = pad + col_idx * (cell_w + pad)
        draw.rectangle([x, y, x + cell_w, y + row_h], fill=(24, 28, 36, 255), outline=(58, 65, 80, 255))
        draw.text((x + 10, y + 6), f'{item["name"]} [{item["id"]}]', fill=(226, 232, 240, 255))
        draw.text((x + 10, y + 20), item["description"], fill=(156, 163, 175, 255))
        stage_y = y + header_h + 4
        stage_h = row_h - header_h - 12
        draw.rectangle([x + 8, stage_y, x + cell_w - 8, stage_y + stage_h], fill=(28, 32, 42, 255))
        canvas.alpha_composite(im, (x + 8 + (cell_w - 16 - im.width) // 2, stage_y + (stage_h - im.height) // 2))
    y += row_h + pad

canvas.convert("RGB").save(out_path)
print("states.png")
`;

  const outPath = join(sheetsDir, "states.png");
  const proc = spawnSync("python3", ["-c", pyScript, JSON.stringify(present), outPath], {
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    console.warn(`[design:compare] Pillow states sheet skipped (${proc.stderr.trim() || "python3/PIL unavailable"}).`);
    return null;
  }
  return "states.png";
}

function generateHoverAtlas(
  outDir: string,
  assetsDir: string,
  pairs: readonly ResolvedHoverPair[],
): { sheet: string | null; cards: RenderedHoverCard[] } {
  if (pairs.length === 0) return { sheet: null, cards: [] };
  const sheetsDir = join(outDir, "sheets");
  mkdirSync(sheetsDir, { recursive: true });

  const pyScript = `
import json, os, sys
from PIL import Image, ImageDraw

specs = json.loads(sys.argv[1])
assets_dir = sys.argv[2]
sheet_path = sys.argv[3]

def find_node(tree, test_id):
    for node in tree.get("nodes", []):
        if node.get("testId") == test_id and node.get("boundsDevice"):
            return node["boundsDevice"]
    return None

def count_diff_px(a, b):
    pa, pb = a.load(), b.load()
    w, h = min(a.width, b.width), min(a.height, b.height)
    diff = 0
    for y in range(h):
        for x in range(w):
            r1, g1, b1, a1 = pa[x, y]
            r2, g2, b2, a2 = pb[x, y]
            if max(abs(r1 - r2), abs(g1 - g2), abs(b1 - b2), abs(a1 - a2)) > 2:
                diff += 1
    return diff

def draw_cursor(im, cx, cy):
    overlay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    r = 6
    # Crosshair lines
    d.line([(cx - 10, cy), (cx - 4, cy)], fill=(255, 255, 255, 230), width=1)
    d.line([(cx + 4, cy), (cx + 10, cy)], fill=(255, 255, 255, 230), width=1)
    d.line([(cx, cy - 10), (cx, cy - 4)], fill=(255, 255, 255, 230), width=1)
    d.line([(cx, cy + 4), (cx, cy + 10)], fill=(255, 255, 255, 230), width=1)
    # High-contrast ring + center dot
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 72, 92, 255), width=2)
    d.ellipse([cx - 2, cy - 2, cx + 2, cy + 2], fill=(255, 255, 255, 255), outline=(255, 72, 92, 255), width=1)
    return Image.alpha_composite(im, overlay)

rendered = []
tiles = []

for spec in specs:
    with open(spec["treePath"], "r", encoding="utf-8") as fh:
        tree = json.load(fh)
    rest_im = Image.open(spec["restPath"]).convert("RGBA")
    hover_im = Image.open(spec["hoverPath"]).convert("RGBA")

    boxes = [find_node(tree, tid) for tid in spec["cropTestIds"]]
    boxes = [b for b in boxes if b is not None]
    cursor_box = find_node(tree, spec["cursorTestId"])
    if not boxes or cursor_box is None:
        continue

    x0 = min(b["x"] for b in boxes)
    y0 = min(b["y"] for b in boxes)
    x1 = max(b["x"] + b["width"] for b in boxes)
    y1 = max(b["y"] + b["height"] for b in boxes)
    pad = int(spec.get("padPx", 14))
    cx0 = max(0, int(x0) - pad)
    cy0 = max(0, int(y0) - pad)
    cx1 = min(min(rest_im.width, hover_im.width), int(round(x1)) + pad)
    cy1 = min(min(rest_im.height, hover_im.height), int(round(y1)) + pad)
    if cx1 <= cx0 or cy1 <= cy0:
        continue

    rest_crop = rest_im.crop((cx0, cy0, cx1, cy1))
    hover_crop = hover_im.crop((cx0, cy0, cx1, cy1))
    diff_px = count_diff_px(rest_crop, hover_crop)

    cur_x = int(round(cursor_box["x"] + cursor_box["width"] / 2.0)) - cx0
    cur_y = int(round(cursor_box["y"] + cursor_box["height"] / 2.0)) - cy0
    hover_marked = draw_cursor(hover_crop, cur_x, cur_y)

    # Side-by-side Rest | Hover pair asset for index.html
    gap = 12
    lbl_h = 18
    pair_w = rest_crop.width * 2 + gap + 16
    pair_h = max(rest_crop.height, hover_marked.height) + lbl_h + 14
    pair_canvas = Image.new("RGBA", (pair_w, pair_h), (24, 28, 36, 255))
    pd = ImageDraw.Draw(pair_canvas)
    pd.text((8, 4), "REST", fill=(156, 163, 175, 255))
    pd.text((8 + rest_crop.width + gap, 4), "HOVER", fill=(147, 197, 253, 255))
    pair_canvas.alpha_composite(rest_crop, (8, lbl_h + 4))
    pair_canvas.alpha_composite(hover_marked, (8 + rest_crop.width + gap, lbl_h + 4))
    pair_name = f"hover-{spec['id']}.png"
    pair_canvas.convert("RGB").save(os.path.join(assets_dir, pair_name))

    rendered.append({
        "id": spec["id"],
        "title": spec["title"],
        "subtitle": spec["subtitle"],
        "pairAsset": f"assets/{pair_name}",
        "diffPx": diff_px,
        "expectZeroDiff": bool(spec.get("expectZeroDiff", False)),
    })
    tiles.append((spec, rest_crop, hover_marked, diff_px))

if not tiles:
    print(json.dumps({"sheet": None, "cards": []}))
    sys.exit(0)

# Compose 2-column contact sheet: sheets/hover-atlas.png
cols = 2
cell_w = 640
pad = 16
header_h = 36
pane_gap = 12
pane_max_w = (cell_w - 24 - pane_gap) // 2
pane_max_h = 180

def fit_pair(a, b):
    w = max(1, a.width)
    h = max(1, a.height)
    scale = min(1.0, pane_max_w / w, pane_max_h / h)
    if scale < 1.0:
        nw = max(1, int(round(w * scale)))
        nh = max(1, int(round(h * scale)))
        return a.resize((nw, nh), Image.LANCZOS), b.resize((nw, nh), Image.LANCZOS)
    return a, b

rows = []
for i in range(0, len(tiles), cols):
    row_items = tiles[i:i + cols]
    fitted = []
    max_h = 72
    for spec, rest_c, hover_c, diff_px in row_items:
        rf, hf = fit_pair(rest_c, hover_c)
        max_h = max(max_h, rf.height)
        fitted.append((spec, rf, hf, diff_px))
    rows.append((fitted, max_h + header_h + 34))

total_w = cell_w * cols + pad * (cols + 1)
total_h = pad + sum(r[1] + pad for r in rows)
sheet = Image.new("RGBA", (total_w, total_h), (15, 17, 22, 255))
draw = ImageDraw.Draw(sheet)

y = pad
for fitted, row_h in rows:
    for col_idx, (spec, rf, hf, diff_px) in enumerate(fitted):
        x = pad + col_idx * (cell_w + pad)
        draw.rectangle([x, y, x + cell_w, y + row_h], fill=(24, 28, 36, 255), outline=(58, 65, 80, 255))
        zero_expected = bool(spec.get("expectZeroDiff", False))
        badge_text = f"{diff_px} px diff"
        badge_color = (74, 222, 128, 255) if (zero_expected and diff_px == 0) else ((251, 191, 36, 255) if zero_expected else (147, 197, 253, 255))
        draw.text((x + 10, y + 6), f"{spec['title']}  [{badge_text}]", fill=badge_color)
        draw.text((x + 10, y + 20), spec["subtitle"], fill=(156, 163, 175, 255))

        stage_y = y + header_h + 4
        stage_h = row_h - header_h - 12
        lx = x + 10
        rx = lx + pane_max_w + pane_gap
        draw.rectangle([lx, stage_y, lx + pane_max_w, stage_y + stage_h], fill=(28, 32, 42, 255), outline=(45, 52, 66, 255))
        draw.rectangle([rx, stage_y, rx + pane_max_w, stage_y + stage_h], fill=(28, 32, 42, 255), outline=(45, 52, 66, 255))
        draw.text((lx + 6, stage_y + 3), "REST", fill=(156, 163, 175, 255))
        draw.text((rx + 6, stage_y + 3), "HOVER", fill=(147, 197, 253, 255))
        img_y = stage_y + 18 + max(0, (stage_h - 22 - rf.height) // 2)
        sheet.alpha_composite(rf, (lx + (pane_max_w - rf.width) // 2, img_y))
        sheet.alpha_composite(hf, (rx + (pane_max_w - hf.width) // 2, img_y))
    y += row_h + pad

sheet.convert("RGB").save(sheet_path)
print(json.dumps({"sheet": "hover-atlas.png", "cards": rendered}))
`;

  const sheetPath = join(sheetsDir, "hover-atlas.png");
  const proc = spawnSync("python3", ["-c", pyScript, JSON.stringify(pairs), assetsDir, sheetPath], {
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    console.warn(`[design:compare] Pillow hover-atlas skipped (${proc.stderr.trim() || "python3/PIL unavailable"}).`);
    return { sheet: null, cards: [] };
  }
  try {
    return JSON.parse(proc.stdout.trim()) as { sheet: string | null; cards: RenderedHoverCard[] };
  } catch {
    return { sheet: null, cards: [] };
  }
}

const repoRoot = resolve(import.meta.dir, "..");
const manifestPath = join(repoRoot, "docs/design/paper-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PaperManifest;
const opts = parseArgs(process.argv.slice(2));

if (opts.runPreview || !existsSync(opts.previewDir)) {
  mkdirSync(opts.previewDir, { recursive: true });
  console.log(`[design:compare] Running design-preview.test.ts -> ${opts.previewDir}`);
  const run = spawnSync("bun", ["test", "apps/shell/tests/design-preview.test.ts"], {
    cwd: repoRoot,
    env: { ...process.env, PREVIEW_OUT_DIR: opts.previewDir },
    stdio: "inherit",
  });
  if (run.status !== 0) {
    process.exit(run.status ?? 1);
  }
}

const assetsDir = join(opts.outDir, "assets");
mkdirSync(assetsDir, { recursive: true });

const resolved: ResolvedSurface[] = manifest.surfaces.map(surface => {
  const candidateRef = join(opts.refsDir, surface.refFile);
  const refPath = existsSync(candidateRef) ? candidateRef : null;
  const candidatePreview = surface.previewRelPath ? join(opts.previewDir, surface.previewRelPath) : null;
  const previewPath = candidatePreview && existsSync(candidatePreview) ? candidatePreview : null;

  let refAsset: string | null = null;
  if (refPath) {
    const destName = `ref-${surface.id}${extname(refPath) || ".jpg"}`;
    copyFileSync(refPath, join(assetsDir, destName));
    refAsset = `assets/${destName}`;
  }

  let previewAsset: string | null = null;
  if (previewPath) {
    const destName = `preview-${surface.id}${extname(previewPath) || ".png"}`;
    copyFileSync(previewPath, join(assetsDir, destName));
    previewAsset = `assets/${destName}`;
  }

  const status =
    refPath && previewPath
      ? "paired"
      : previewPath
        ? "preview-only"
        : refPath
          ? "paper-only"
          : "missing";

  return { ...surface, refPath, previewPath, refAsset, previewAsset, status };
});

const resolvedStates: ResolvedStateCapture[] = INTERACTIVE_STATE_SPECS.map(spec => {
  const candidate = join(opts.previewDir, spec.previewRelPath);
  const previewPath = existsSync(candidate) ? candidate : null;
  let previewAsset: string | null = null;
  if (previewPath) {
    const destName = `state-${spec.id}${extname(previewPath) || ".png"}`;
    copyFileSync(previewPath, join(assetsDir, destName));
    previewAsset = `assets/${destName}`;
  }
  return { ...spec, previewPath, previewAsset };
});

const resolvedHoverPairs: ResolvedHoverPair[] = HOVER_ATLAS_SPECS.flatMap(spec => {
  const restPath = join(opts.previewDir, spec.restRelPath);
  const hoverPath = join(opts.previewDir, spec.hoverRelPath);
  const treePath = hoverPath.replace(/\.png$/, ".tree.json");
  if (!existsSync(restPath) || !existsSync(hoverPath) || !existsSync(treePath)) return [];
  return [{ ...spec, restPath, hoverPath, treePath }];
});

const sheetFiles = opts.sheets ? generateContactSheets(opts.outDir, resolved) : [];
const stateSheet = opts.sheets ? generateStateSheet(opts.outDir, resolvedStates) : null;
if (stateSheet) sheetFiles.push(stateSheet);
const hoverAtlas = opts.sheets ? generateHoverAtlas(opts.outDir, assetsDir, resolvedHoverPairs) : { sheet: null, cards: [] };
if (hoverAtlas.sheet) sheetFiles.push(hoverAtlas.sheet);
const htmlPath = join(opts.outDir, "index.html");
const reportJsonPath = join(opts.outDir, "manifest.json");

writeFileSync(htmlPath, buildHtml(manifest, resolved, resolvedStates, hoverAtlas.cards, sheetFiles));
writeFileSync(
  reportJsonPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      paperFileId: manifest.paperFileId,
      refsDir: opts.refsDir,
      previewDir: opts.previewDir,
      sheets: sheetFiles.map(file => join(opts.outDir, "sheets", basename(file))),
      surfaces: resolved,
      states: resolvedStates,
      hoverAtlas: hoverAtlas.cards,
    },
    null,
    2,
  ),
);

const pairedCount = resolved.filter(item => item.status === "paired").length;
const previewOnlyCount = resolved.filter(item => item.status === "preview-only").length;
const paperOnlyCount = resolved.filter(item => item.status === "paper-only").length;
const stateCount = resolvedStates.filter(item => item.previewPath).length;
console.log(
  `[design:compare] Wrote ${htmlPath} (${pairedCount} paired, ${previewOnlyCount} preview-only, ${paperOnlyCount} paper-only, ${stateCount} interactive/chaos states, ${hoverAtlas.cards.length} hover-atlas pairs, ${sheetFiles.length} contact sheets)`,
);
