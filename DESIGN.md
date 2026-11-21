---
name: z-shell
description: Modular Linux Wayland desktop shell combining Material 3 HCT dynamic color tokens with high-density keyboard-first desktop ergonomics.
colors:
  surface: "#111318"
  surface-container: "#1D2024"
  surface-container-high: "#272A2F"
  surface-container-highest: "#32353A"
  on-surface: "#E2E2E9"
  on-surface-variant: "#C3C6CF"
  outline: "#8D9199"
  outline-variant: "#43474E"
  primary: "#A6C8FF"
  on-primary: "#08305F"
  primary-container: "#254777"
  on-primary-container: "#D4E3FF"
  secondary-container: "#3C4759"
  on-secondary-container: "#D6E3F8"
  error: "#FFB4AB"
  error-container: "#93000A"
  on-error-container: "#FFDAD6"
typography:
  display:
    fontFamily: "\"Roboto Flex\", sans-serif"
    fontSize: "44px"
    fontWeight: 400
    lineHeight: "52px"
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "\"Roboto Flex\", sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: "28px"
    letterSpacing: "-0.015em"
  title:
    fontFamily: "\"Roboto Flex\", sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "22px"
    letterSpacing: "0em"
  body:
    fontFamily: "\"Roboto Flex\", sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: "20px"
    letterSpacing: "0em"
  label:
    fontFamily: "\"Roboto Flex\", sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
    letterSpacing: "0em"
  mono:
    fontFamily: "\"JetBrains Mono\", monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: "16px"
    letterSpacing: "0em"
rounded:
  xs: "6px"
  sm: "8px"
  md: "10px"
  tile: "14px"
  card: "16px"
  panel: "22px"
  pill: "999px"
spacing:
  2xs: "4px"
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "14px"
  2xl: "16px"
components:
  bar-island:
    backgroundColor: "{colors.surface-container}"
    textColor: "{colors.on-surface}"
    typography: "{typography.label}"
    rounded: "{rounded.card}"
    padding: "0 12px"
    height: "32px"
  quick-tile-active:
    backgroundColor: "{colors.primary-container}"
    textColor: "{colors.on-primary-container}"
    typography: "{typography.body}"
    rounded: "{rounded.tile}"
    padding: "0 10px"
    height: "50px"
  quick-tile-inactive:
    backgroundColor: "{colors.surface-container-high}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body}"
    rounded: "{rounded.tile}"
    padding: "0 10px"
    height: "50px"
  popover-standard:
    backgroundColor: "{colors.surface-container}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.panel}"
    padding: "14px"
    width: "396px"
  settings-window:
    backgroundColor: "{colors.surface-container}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.panel}"
    width: "820px"
    height: "600px"
  button-destructive:
    backgroundColor: "{colors.error-container}"
    textColor: "{colors.on-error-container}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
---

# Design System: z-shell

> **Conformance Policy**: `z-shell` follows **"100% Material 3 Color & Surface Roles + Desktop Productivity Density & Keyboard Ergonomics"**. Color role pairing, tonal elevation, contrast, and motion physics follow Material Design 3 [[M3-Color]](#references) [[M3-Motion]](#references) and WCAG 2.2 [[WCAG-2.2]](#references); touch-first sizes, oversized radii, and deep mobile sheets are deliberately adapted for Linux Wayland tiling desktops. Mechanical invariants are enforced by the 4-layer design lint suite—see [Lint-Enforced Contracts](#lint-enforced-contracts).

---

## Overview

**Creative North Star: "Quiet Precision on Tiled Glass"**

`z-shell` is a modular Linux Wayland desktop shell rendered via `zgui-js` (Solid 2.0 TSX + StyleX on QuickJS) and backed by `z-shelld` [[z-shell-SCOPE]](#references). Users spend 8–12 hours a day in terminals, editors, and tiling compositors (Niri, ShojiWM). Chrome operates in **Operate** mode: it recedes quietly during focused work, reads in under 200ms, opens without vertical scrolling on `1440×900`, and supports full keyboard-and-pointer velocity.

- **Dynamic Color First**: All 31 semantic roles are generated on the fly by `crates/z-shell-theme` (pure-Rust Material 3 HCT) from the active wallpaper or a user seed color [[z-shell-ADR-0003]](#references).
- **Single-Owner IA**: Notifications & DND live in `13 · Calendar`; quick hardware toggles live in `01 · Control Center`; configuration & plugin `settings_page` entries live in the `820×600` Settings Window.
- **Restrained M3 Expressive**: Expressive silhouettes and wavy tracks are strictly budgeted to focal hero moments rather than everyday utility chrome [[M3-Shape]](#references).

---

## Colors

The palette is a **31-role semantic color scheme** computed dynamically in Material 3 HCT across 6 variants (`tonal`, `vibrant`, `expressive`, `fidelity`, `neutral`, `mono`) and 3 modes (`dark`, `light`, `auto`) [[M3-Color]](#references) [[z-shell-ADR-0003]](#references). Frontmatter hex values are the default dark `tonal` reference extracted from Paper [[z-shell-Paper]](#references).

- **Primary**: `primary` (Glacier Accent, Tone 80 dark / 40 light) for ≤10% focal indicators (active workspace numeral, today cell, slider fills, progress rings); `on-primary` strictly on `primary`; `primary-container` + `on-primary-container` (Calm Slate Blue / Ice Mist, Tone 30 dark / 90 light) for large active desktop controls (quick tiles, active sidebar items, connected device rows)—a deliberate desktop deviation from glaring mobile solid-`primary` tiles.
- **Secondary & Error**: `secondary-container` / `on-secondary-container` for neutral tonal actions (`Today`, notification actions); `error` / `error-container` / `on-error-container` strictly for destructive or error states (`Power off`, `17 · Power Dialog`, `Clear unpinned`, auth errors).
- **Neutral**: `surface` (Tone 6 dark, lowest plane & Settings sidebar) → `surface-container` (Tone 12, bar islands & popovers) → `surface-container-high` (Tone 17, grouped cards & inactive tiles) → `surface-container-highest` (Tone 22, icon wells, unfilled tracks, compact buttons); foregrounds `on-surface` / `on-surface-variant` and hairlines `outline` / `outline-variant`.

---

## Typography

**UI Font**: `Roboto Flex` (`wght 100–1000`, fallback `sans-serif`) [[M3-Typography]](#references) · **Data Font**: `JetBrains Mono` (`wght 400–700`, fallback `monospace`, reserved strictly for live readouts, paths, config IDs, and CLI/agent metadata).

| Role | Spec | Usage |
|---|---|---|
| **Display** | `Roboto Flex` 400 · `44px` / `52px` · `-0.02em` | Calendar header clock (`64px`–`112px` light on Lock Screen) |
| **Headline** | `Roboto Flex` 600 · `22px` / `28px` · `-0.015em` | Sub-panel titles & Settings pane headers (`18px`–`22px`) |
| **Title** | `Roboto Flex` 600 · `15px`–`16px` / `20px`–`22px` | User identity, month heading, section titles |
| **Body** | `Roboto Flex` 500 · `13px`–`14px` / `18px`–`20px` | Device names, quick tile titles, notifications, sidebar links |
| **Label** | `Roboto Flex` 400–600 · `11px`–`12px` / `14px`–`16px` | Subtitles, bar islands, buttons, uppercase sidebar headers (`+0.04em`) |
| **Mono** | `JetBrains Mono` 500 · `10px`–`12px` / `14px`–`16px` | Live percentages, file paths, config badges, active agent names |

---

## Layout

Desktop placement follows a **`14px` global tiling rhythm** (`[bar].gaps = 14` in `settings.toml`) [[z-shell-Paper]](#references).

### Surface Size Tiers

| Tier | Standard Dimensions | Height Behavior (`1440×900`) | Surfaces |
|---|---|---|---|
| **Bar Strut (Floating)** | Top `100% × 46px` (`32px` islands + `14px` margin); Vertical `54px × 100%` (`40px` islands + `14px` margin) | Exclusive `wlr-layer-shell` edge strut | `09 · Top Bar`, `09B · Vertical Bar` |
| **Bar Strut (Docked)** | Top `100% × 38px` (`0px` margin, `1px` bottom hairline); Vertical `44px × 100%` (`0px` margin, `1px` inner hairline) | Exclusive flush `wlr-layer-shell` strut | `09C · Docked Top Bar`, `09D · Docked Vertical Bar` |
| **Compact Popover** | `360px` wide | Fit-content, zero scroll | `12 · Notification Popup`, `15 · Nosleep`, `17 · Power Dialog`, `23 · Polkit Auth Prompt` |
| **Standard Popover** | `396px` wide | Zero scroll (target ≤ `760px`) | `01 · Main`, `02 · Wi-Fi`, `03 · Bluetooth`, `04 · Sound`, `04B · Battery & Power`, `13 · Calendar`, `14 · Media Player`, `16 · AI Usage` |
| **Centered Modal** | `560px`–`684px` wide | Centered over dimmed scrim | `18 · Launcher` (`652px`), `19 · Clipboard` (`560px`), `20 · Workspace Overview` (`684px`) |
| **Settings Window** | `820px × 600px` | `216px` left nav + `604px` content pane | `22 · Appearance`, `22B · Bar & Layout`, `22C · Idle & Sleep`, `22D · Power & Battery`, `22E · AI Usage`, `22F · Nosleep`, `22G · Theme Bridges`, `22H · Niri Overview` |
| **Exclusive Fullscreen** | `100% × 100%` | Exclusive `ext-session-lock-v1` [[Wayland-Layer]](#references) | `21 · Lock Screen` |

### Anchoring & Pointer Ergonomics
- **Top Bar**: Popovers anchor `12px` below floating bar (`y = 58px`) or `10px` below docked bar (`y = 48px`), aligned to the triggering island (Calendar centered under Clock, Control Center right-aligned at `right = 14px`).
- **Vertical Left Bar**: Popovers triggered from the bottom-left `Status Island` **bottom-align** (`left = 66px` floating / `54px` docked, `bottom = 14px`) to minimize pointer travel and keep the upper tiled workspace unobstructed.
- **Top Bar Collision Guard**: `Active Window Island` and `Media Island` truncate via `text-overflow: ellipsis` so `1280px` / `1366px` widths never collide with centered `Clock Island`.

---

## Elevation, Shapes & Motion

### Elevation Vocabulary
Material 3 tonal layering paired with `1px` `outline-variant` hairlines prevents dark `#1D2024` popovers from blending into `#111318` terminals [[M3-Elevation]](#references). *(Note: flush Wayland `PopupSurface` / `WindowSurface` chrome constraints live in [docs/agents/ui-runtime.md](docs/agents/ui-runtime.md).)*

- **Level 0 — Recessed / Sidebar**: `surface`, no shadow (desktop canvas, Settings sidebar).
- **Level 1 — Bar Islands**: `surface-container`, `1px solid outline-variant @ 48%`, `box-shadow: 0 4px 14px rgba(0,0,0,0.36)`; active steps to `surface-container-high` + `primary @ 60%` border.
- **Level 2 — Popover Surfaces**: `surface-container`, `1px solid outline-variant @ 55%`, `box-shadow: 0 14px 36px rgba(0,0,0,0.50)` (layered toasts/overlays).
- **Level 3 — Centered Modals & Settings**: `surface-container`, `1px solid outline-variant @ 55%`, `box-shadow: 0 20px 56px rgba(0,0,0,0.60)` + dimmed scrim.

### Concentric Shape Scale
Tightened from mobile `28px`–`30px` sheets for desktop precision [[M3-Shape]](#references):
- `--radius-panel`: `22px` (outer popovers & modals) · `--radius-card`: `16px` (inner section cards & `32px` bar islands) · `--radius-tile`: `14px` (quick tiles & active rows) · `--radius-sm`/`md`: `8px`–`10px` (buttons, nav items, icon wells, today badge) · `--radius-pill`: `999px` (capsules, filter chips).

### Interaction State Layers & Motion System
`z-shell` implements the full **Material Design 3 Motion System**—analytical unit-mass **Spring Physics** (`standard` default, `expressive`, `reduced` via `[theme].motion_scheme`) paired with M3 **Easing & Duration** tokens [[M3-Motion]](#references). Full spring equations, token tables, and per-surface choreography live in [docs/design/motion.md](docs/design/motion.md).

- **State Layers**: Translucent foreground overlays—`Hover 8%`, `Focus 10%`, `Pressed 12%`, `Disabled 38%` content opacity (`fast.effects` / `100ms`) [[M3-States]](#references).
- **Focus Ring**: `outline: 2px solid var(--color-primary); outline-offset: 2px` (WCAG 2.2 SC 2.4.7 / 2.4.13) [[WCAG-2.2]](#references).
- **Patterns**: Control Center sub-panels use GPU-friendly **Shared Axis X** (`height="auto"` on `PopupSurface`); Settings tabs (`22`–`22H`) use **Fade Through** + sliding sidebar pill; Lock Screen password shapes & Media Player waveform are scoped **Expressive** hero moments; `motion_scheme = "reduced"` degrades spatial motion to `≤120ms` opacity fades (WCAG 2.2 SC 2.3.3).

---

## Components

### Iconography (3-Tier Policy)

| Tier | Source & Grid | Scope |
|---|---|---|
| **1. System UI (Primary)** | **Material Icons / Material Symbols** (`24×24`, Filled/Rounded) [[M3-Icons]](#references) | All bars, popovers, toggles, headers, nav rails, dialogs, Launcher (`apps`), Overview (`grid_view`), and system utilities (`12px`–`22px` optical sizes, semantic `fill` tokens). |
| **2. M3 Expressive Shapes** | Analytically symmetric SVG (`0 0 64 64` or `0 0 24 24`) [[M3-Shape]](#references) | Strictly limited to the $D_8$ scalloped `z-shell` brand mark, user avatar badges, and Lock Screen morphing password shapes (`Cookie4`, `Clover4`, `Sunny`, `Circle`, `Cookie6`, `Flower5`). |
| **3. Third-Party Apps** | Runtime XDG Icon Theme (`.desktop` `Icon=`) [[XDG-Icon]](#references); canonical brand SVG on canvas | `18 · Launcher`, `10 · Dock`, `Tray Island`, active window indicator—one consistent icon & backing color per app. |

### Surface Anatomy
- **Bar Modes (`09`/`09B` Floating vs `09C`/`09D` Docked)**: Floating uses `32px`/`40px` islands with `14px` margin; Docked uses a flush `38px`/`44px` strip with `1px` inner hairline, `1px × 14px` segment dividers, and `28px` `primary-container` (`8px` radius) active triggers. Active workspace always renders its number in a solid `primary` capsule (`on-primary` bold); Clock omits seconds by default and pairs with a `primary-container` unread pill (`🔔 N`); Tray renders real icons (`18px`–`20px`), never blank placeholders.
- **Quick Control Tiles (`01 · Main`)**: 2-column grid, `50px` tall, `14px` radius. Active: `primary-container` + `primary @ 30%` border + `30×30px` icon well (`primary @ 18%`). Inactive: `surface-container-high` + `surface-container-highest` well. Split tiles (`Wi-Fi`, `Bluetooth`, `Nosleep`) separate toggle from `>` chevron with a `1px × 22px` vertical hairline.
- **Precision Sliders (`01` / `04` / `11`)**: Straight `5px`–`6px` tracks (`surface-container-highest` trough, `primary` fill) with `12px`–`14px` thumb (`2px` container-matched ring). Repeated rows align via `flex-shrink: 0` fixed slots (`30px` icon, `32px`–`36px` right-aligned tabular readout, `26px` trailing action/spacer).
- **Power Menu & Dialog (`01` / `17`)**: Separates safe actions (`Lock`, `Suspend`) from session-ending actions (`Log out`, `Reboot`, `Power off`) with a `1px × 28px` divider; `Power off` uses `error-container @ 38%` + `error @ 35%` border and confirms via `17 · Power Dialog` (`360px`).
- **Device Lists (`02` / `03` / `04`)**: Connected rows use `primary-container` (`16px` radius, `52px` min-height) with a safe `Disconnect` action (never destructive `Remove/Forget` on a connected row).
- **Keyboard-First Modals (`18` / `19` / `20`)**: Top composite search bar + counted filter chips + structured list/grid + compact bottom keyboard hint bar (`↑↓ Move · Enter Copy · Del Forget · Esc Close`).
- **Settings Window (`22`–`22H`)**: `820×600px` compositor-framed window (`216px` `surface` left rail with `SHELL` & `PLUGINS` groups + `settings.toml · Live` footer; `604px` right pane for multi-column controls and plugin `settings_page` entries).

---

## Lint-Enforced Contracts

Mechanical rules are enforced automatically across 4 layers (do not duplicate them in review docs):
- **L1 (`oxlint`)**: `tools/oxlint-design-plugin.mjs` (`bun run lint`)
- **L2 (Contract Sync)**: `apps/shell/tests/design-lint.test.ts` (`bun test`)
- **L3 (Rust WCAG)**: `crates/z-shell-theme/tests/hct_palette.rs` (`cargo test`)
- **L4 (Preview Pixel/Geometry)**: `apps/shell/tests/design-preview.test.ts`

| Domain | Mechanical Invariant | Layer & Enforcer | Status |
|---|---|---|---|
| **Color** | No raw `#hex`/`rgb`/`rgba`/`hsl` in UI code (shadow black excepted) | L1 `zshell/no-raw-colors` | Active |
| **Color** | Valid 31 M3 roles & strict `on-*` foreground/container pairing (incl. `<ShellIcon>`) | L1 `zshell/valid-color-roles` | Active |
| **Color** | Calm Active Surface: no solid `primary` fill on large containers/tiles | L1 `zshell/calm-active-surface` | Active |
| **Color** | WCAG 2.2 SC 1.4.3 (≥4.5:1 text) & SC 1.4.11 (≥3:1 UI) across 10 seeds × 6 variants × dark/light | L3 `hct_palette.rs` | Active |
| **Color / Tokens** | Frontmatter ↔ `app.css` ↔ `theme.ts` ↔ `topics.ts` ↔ bundled fonts sync | L2 `design-lint.test.ts` | Active |
| **Typography** | Semantic font tokens only (`var(--font-sans)` / `var(--font-mono)`) | L1 `zshell/no-system-ui-font` | Active |
| **Typography** | Live monospace numeric slots require `fontVariantNumeric: "tabular-nums"` | L1 `zshell/tabular-readout` | Active |
| **Typography** | Persistent bars omit 1Hz seconds by default (`clock_seconds === false`) | L2 `design-lint.test.ts` | Active |
| **Shapes** | Desktop corner radius scale (`6/8/10/14/16/22/999px` or `--radius-*`) | L1 `zshell/valid-radius-scale` | Active |
| **Shapes** | Expressive-Budget: wavy only in `MediaPanel.tsx`; rosette only in brand mark & avatars | L1 `zshell/expressive-budget` | Active |
| **Shapes** | Exact-Geometry: no hand-authored Bezier expressive literals; $D_n$ symmetry verified | L1 `zshell/no-hand-authored-expressive-paths` + L2 | Active |
| **Icons** | Material 24×24 grid (`viewBox="0 0 24 24"`), no inline ad-hoc `<vector d>` in shell UI | L1 `zshell/material-icon-grid` + L2 | Active |
| **IA & Safety** | Single-Owner IA (no Notifications/DND in QuickSettings; no Telemetry in Calendar) | L1 `zshell/single-owner-ia` | Active |
| **IA & Safety** | Split-Action `1px` divider on split QuickTiles; no unguarded `Remove` on connected BT rows | L1 `zshell/split-action-divider`, `bluetooth-safe-action` | Active |
| **Copy & A11y** | Desktop copy (`Click`, never `Tap to`/`Long press`); never `outline: none/0`; composite input focus delegation; ≥24×24px hit targets | L1 `zshell/no-mobile-copy`, `no-outline-none`, `composite-input-focus` + L4 | Active |
| **Layout & Chrome** | Width tiers (`360/396/560/652/684/820×600`), bar struts (`32/40/38/44`), zero-scroll (`overflowY: false`), 1280px anti-collision, slider lane alignment, shadow bleed α≤8, transparent popup corners, opaque toplevel edges, no flush root `boxShadow`, hover hit-target stability | L1 `zshell/no-flush-surface-shadow`, `no-hover-hit-target-shift` + L2 + L4 | Active |
| **Governance** | No core hardcoded plugin IDs (ADR-0005); no inline `oxlint-disable` directives | L1 `zshell/no-core-plugin-id-branching`, `no-lint-suppression` | Active |
| **Motion** | M3 spring/easing tokens only (no ad-hoc `{ stiffness, damping }` outside `motion.ts`, no non-M3 CSS curves, never transition `outline-width`) | L1 `zshell/m3-motion-tokens` | Active |
| **Motion** | Single shared frame loop (no direct `requestAnimationFrame` outside `packages/sdk/src/motion.ts`) | L1 `zshell/no-direct-raf-loop` | Active |
| **Motion** | `.impeccable/design.json` ↔ `motion.ts` ↔ `app.css` token sync; analytical `k=3800` 60Hz stability; effects `ζ=1.0` zero overshoot; velocity retargeting; zero-idle-CPU settle; `reduced` scheme zero spatial displacement & static media wave | L2 `motion.test.ts` / `design-lint.test.ts` + L4 | Active |

---

## Design Judgement Guidelines

Non-mechanical rules requiring human/agent judgement during design and code review (see also [CODING_STANDARDS.md](CODING_STANDARDS.md)):

- **Quiet Desktop Restraint**: Reserve solid `primary` to ≤10% focal points and keep expressive motion/shapes scoped to Lock Screen & Media Player—never let utility chrome compete with terminal/editor content.
- **Truthful Control Semantics**: Never style read-only telemetry (e.g., AI usage quota) as an active ON/OFF toggle, and ensure every Material Icon accurately matches its wired action.
- **Right-Sized Surface Placement**: Keep transient popovers scannable and zero-scroll at `1440×900`; route multi-field forms, rule editors, wallpaper grids, and plugin settings to the `820×600` Settings Window.
- **Pointer-Travel Anchoring**: Anchor popovers to minimize cursor travel (especially bottom-aligning vertical left-bar status popovers) and use Shared Axis X strictly for parent-child drill-down vs. Fade Through for sibling tabs.
- **Canonical App Identity**: Maintain one consistent icon and backing color per third-party app across Launcher, Dock, Tray, and Bars.

---

## References

1. **[M3-Color]** Google Material Design 3 — *Color Roles & Dynamic Color (HCT)*: https://m3.material.io/styles/color/roles · https://m3.material.io/styles/color/system/how-the-system-works
2. **[M3-Elevation]** Google Material Design 3 — *Elevation & Tonal Surface Layering*: https://m3.material.io/styles/elevation/overview
3. **[M3-States]** Google Material Design 3 — *Interaction States & State Layers*: https://m3.material.io/foundations/interaction/states/overview
4. **[M3-Shape]** Google Material Design 3 — *Shape Scale & Expressive Shapes*: https://m3.material.io/styles/shape/overview
5. **[M3-Typography]** Google Material Design 3 — *Typography Scale*: https://m3.material.io/styles/typography/overview
6. **[M3-Motion]** Google Material Design 3 — *Motion Physics System, Spring Tokens, Easing & Transitions*: https://m3.material.io/styles/motion/overview · https://m3.material.io/styles/motion/overview/specs · https://m3.material.io/styles/motion/easing-and-duration/tokens-specs · [docs/design/motion.md](docs/design/motion.md)
7. **[M3-Icons]** Google Material Design 3 — *Icons Overview & Material Symbols / Icons*: https://m3.material.io/styles/icons/overview · https://fonts.google.com/icons
8. **[XDG-Icon]** freedesktop.org — *XDG Icon Theme Specification* (runtime Linux desktop application icon lookup): https://specifications.freedesktop.org/icon-theme-spec/latest/
9. **[WCAG-2.2]** W3C — *Web Content Accessibility Guidelines (WCAG) 2.2* (SC 1.4.3 Contrast Minimum, SC 1.4.11 Non-text Contrast, SC 2.3.3 Animation from Interactions, SC 2.4.7 Focus Visible, SC 2.4.11 Focus Not Obscured, SC 2.4.13 Focus Appearance, SC 2.5.8 Target Size Minimum): https://www.w3.org/TR/WCAG22/
10. **[Wayland-Layer]** Wayland Protocols — *Session Lock (`ext-session-lock-v1`) & Layer Shell Surfaces*: https://wayland.app/protocols/ext-session-lock-v1
11. **[z-shell-Paper]** `z-shell` Paper Design Canvas (*z-shell — All Surfaces & Panels* & *Desktop Placement*): https://app.paper.design/file/01M7J3P8QM6GW1HSHNW0M8TQSV/p-2-0
12. **[z-shell-ADR-0003]** Internal Architecture Decision Record — [docs/adr/0003-pure-rust-audio-and-theme-engines.md](docs/adr/0003-pure-rust-audio-and-theme-engines.md) & [crates/z-shell-theme/src/palette.rs](crates/z-shell-theme/src/palette.rs)
13. **[z-shell-SCOPE]** Internal Product Scope & Domain Glossary — [SCOPE.md](SCOPE.md) & [GLOSSARY.md](GLOSSARY.md)
