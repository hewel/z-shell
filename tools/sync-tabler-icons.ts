import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type TablerNode = readonly [tag: string, attrs: Readonly<Record<string, string>>];
type TablerNodesMap = Readonly<Record<string, readonly TablerNode[]>>;

export interface GeneratedTablerIcon {
  readonly viewBox: "0 0 24 24";
  readonly d: string;
}

const OUTLINE_BBOX_PATH = "M0 0h24v24H0z";

/**
 * 1:1 mapping from z-shell Tier 1 system UI icon keys to upstream `@tabler/icons` names.
 * `wifiLock` is synthesized below from upstream `wifi` + Tabler's corner padlock.
 */
export const TABLER_ICON_MAP = {
  apps: "grid-dots",
  gridView: "layout-grid",
  overview: "layout-dashboard",
  dashboard: "layout-board-split",
  terminal: "terminal-2",
  search: "search",
  menu: "menu-2",
  tune: "adjustments-horizontal",
  settings: "settings",
  close: "x",
  openInNew: "external-link",

  chevronRight: "chevron-right",
  chevronLeft: "chevron-left",
  expandMore: "chevron-down",
  expandLess: "chevron-up",
  arrowLeft: "arrow-left",
  add: "plus",

  wifi: "wifi",
  wifiOff: "wifi-off",
  ethernet: "network",
  bluetooth: "bluetooth",
  bluetoothOff: "bluetooth-off",

  volumeHigh: "volume",
  volumeLow: "volume-2",
  volumeMute: "volume-off",
  mic: "microphone",
  headphones: "headphones",
  musicNote: "music",
  mediaEq: "waveform",
  play: "player-play",
  pause: "player-pause",
  skipPrev: "player-skip-back",
  skipNext: "player-skip-forward",
  fastRewind: "player-track-prev",
  fastForward: "player-track-next",
  shuffle: "arrows-shuffle",
  repeat: "repeat",

  bell: "bell",
  bellOff: "bell-off",
  battery: "battery-vertical-4",
  batteryCharging: "battery-vertical-charging",
  brightness: "sun",
  coffee: "coffee",
  timer: "stopwatch",
  power: "power",
  lock: "lock",
  logout: "logout",
  sleep: "moon",
  reboot: "reload",
  person: "user",
  shield: "shield",
  verified: "shield-check",

  pulse: "activity",
  cpu: "cpu",
  gpu: "gpu",
  memory: "memory",
  storage: "database",
  thermometer: "temperature",

  check: "check",
  visibility: "eye",
  visibilityOff: "eye-off",
  pin: "pin",
  trash: "trash",
  refresh: "refresh",
  download: "download",
  copy: "copy",
  fileText: "file-text",
  folder: "folder",
  image: "photo",
  wallpaper: "wallpaper",
  link: "link",
  linkOff: "link-off",
  palette: "palette",
  layers: "stack-2",
  extension: "puzzle",
  autoAwesome: "sparkles",
  smartToy: "robot",
  warning: "alert-triangle",
} as const satisfies Readonly<Record<string, string>>;

function extractPaths(nodes: readonly TablerNode[] | undefined, iconName: string): string[] {
  if (!nodes || nodes.length === 0) {
    throw new Error(`Missing @tabler/icons outline icon "${iconName}".`);
  }
  const paths: string[] = [];
  for (const [tag, attrs] of nodes) {
    if (tag !== "path") {
      throw new Error(`Unexpected <${tag}> node in @tabler/icons outline "${iconName}".`);
    }
    const { d, ...rest } = attrs;
    const extraKeys = Object.keys(rest);
    if (extraKeys.length > 0) {
      throw new Error(`Unexpected attributes [${extraKeys.join(", ")}] on @tabler/icons outline "${iconName}".`);
    }
    if (!d) {
      throw new Error(`Missing path "d" on @tabler/icons outline "${iconName}".`);
    }
    if (d === OUTLINE_BBOX_PATH) continue;
    paths.push(d);
  }
  if (paths.length === 0) {
    throw new Error(`No drawable path extracted for @tabler/icons outline "${iconName}".`);
  }
  return paths;
}

/**
 * Synthesize `wifiLock` on the 24x24 grid from upstream `wifi` and Tabler's standard
 * bottom-right corner padlock (`folder-lock`), trimming the inner/middle right arc tails
 * so the padlock shackle stays cleanly separated at 12-18px UI sizes.
 */
function buildWifiLockOutlineD(outline: TablerNodesMap): string {
  const wifiPaths = extractPaths(outline["wifi"], "wifi");
  const folderLockPaths = extractPaths(outline["folder-lock"], "folder-lock");
  if (wifiPaths.length !== 4) {
    throw new Error(`Expected 4 drawable paths in upstream "wifi", got ${wifiPaths.length}.`);
  }
  if (wifiPaths[1] !== "M9.172 15.172a4 4 0 0 1 5.656 0") {
    throw new Error(`Unexpected upstream "wifi" inner arc path: ${wifiPaths[1]}`);
  }
  if (wifiPaths[2] !== "M6.343 12.343a8 8 0 0 1 11.314 0") {
    throw new Error(`Unexpected upstream "wifi" middle arc path: ${wifiPaths[2]}`);
  }
  const lockPaths = folderLockPaths.slice(-2);
  if (
    lockPaths[0] !== "M17 19a1 1 0 0 1 1 -1h3a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-2" ||
    lockPaths[1] !== "M18 18v-1.5a1.5 1.5 0 1 1 3 0v1.5"
  ) {
    throw new Error(`Unexpected upstream corner padlock geometry in "folder-lock": ${JSON.stringify(lockPaths)}`);
  }

  return [
    wifiPaths[0]!,
    "M9.172 15.172a4 4 0 0 1 5.122 -.449",
    "M6.343 12.343a8 8 0 0 1 10.582 -.647",
    wifiPaths[3]!,
    lockPaths[0]!,
    lockPaths[1]!,
  ].join("\n");
}

function getRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Generate the TypeScript source for `apps/shell/src/tabler-icons.generated.ts`. */
export function buildTablerIconsModule(repoRoot = getRepoRoot()): string {
  const tablerDir = join(repoRoot, "node_modules/@tabler/icons");
  const pkg = JSON.parse(readFileSync(join(tablerDir, "package.json"), "utf8")) as { version: string };
  const outline = JSON.parse(readFileSync(join(tablerDir, "tabler-nodes-outline.json"), "utf8")) as TablerNodesMap;

  const lines: string[] = [
    `// Generated by tools/sync-tabler-icons.ts from @tabler/icons@${pkg.version}. Do not edit manually.`,
    `// Run \`bun run icons:sync\` to regenerate.`,
    "",
    "export const TABLER_ICON_PATHS = {",
  ];

  for (const [shellName, tablerName] of Object.entries(TABLER_ICON_MAP)) {
    const outlineD = extractPaths(outline[tablerName], tablerName).join("\n");

    lines.push(`  ${shellName}: {`);
    lines.push(`    viewBox: "0 0 24 24",`);
    lines.push(`    d: ${JSON.stringify(outlineD)},`);
    lines.push("  },");

    if (shellName === "wifiOff") {
      lines.push("  wifiLock: {");
      lines.push(`    viewBox: "0 0 24 24",`);
      lines.push(`    d: ${JSON.stringify(buildWifiLockOutlineD(outline))},`);
      lines.push("  },");
    }
  }

  lines.push("} as const;");
  lines.push("");
  return lines.join("\n");
}

if (import.meta.main) {
  const repoRoot = getRepoRoot();
  const outPath = join(repoRoot, "apps/shell/src/tabler-icons.generated.ts");
  writeFileSync(outPath, buildTablerIconsModule(repoRoot), "utf8");
  console.log(`Synced Tabler icons to ${outPath}`);
}
