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

> **Conformance Policy**: `z-shell` follows **"100% Material 3 Color & Surface Roles + Desktop Productivity Density & Keyboard Ergonomics"**. Color role pairing, tonal elevation, contrast, component tokens, and motion physics follow Material Design 3 [[M3-Color]](#references) [[M3-Components]](#references) [[M3-Web]](#references) [[M3-Motion]](#references) and WCAG 2.2 [[WCAG-2.2]](#references); touch-first sizes, oversized radii, and deep mobile sheets are deliberately adapted for Linux Wayland tiling desktops. Mechanical invariants are enforced by the 4-layer design lint suite—see [Lint-Enforced Contracts](#lint-enforced-contracts).

---

## Overview

**Creative North Star: "Quiet Precision on Tiled Glass"**

`z-shell` is a modular Linux Wayland desktop shell rendered via `zgui-js` (Solid 2.0 TSX + Lightning CSS Modules on QuickJS) and backed by `z-shelld` [[z-shell-SCOPE]](#references). Users spend 8–12 hours a day in terminals, editors, and tiling compositors (Niri, ShojiWM). Chrome operates in **Operate** mode: it recedes quietly during focused work, reads in under 200ms, opens without vertical scrolling on `1440×900`, and supports full keyboard-and-pointer velocity.

- **Dynamic Color First**: All 31 semantic roles are generated on the fly by `crates/z-shell-theme` (pure-Rust Material 3 HCT) from the active wallpaper or a user seed color [[z-shell-ADR-0003]](#references).
- **Single-Owner IA**: Notifications & DND live in `13 · Calendar`; quick hardware toggles live in `01 · Control Center`; configuration & plugin `settings_page` entries live in the `820×600` Settings Window.
- **Restrained M3 Expressive**: Expressive silhouettes and wavy tracks are strictly budgeted to focal hero moments rather than everyday utility chrome [[M3-Shape]](#references).

---

## Colors

The palette is a **31-role semantic color scheme** computed dynamically in Material 3 HCT across 6 variants (`tonal`, `vibrant`, `expressive`, `fidelity`, `neutral`, `mono`) and 3 modes (`dark`, `light`, `auto`) [[M3-Color]](#references) [[z-shell-ADR-0003]](#references). Frontmatter hex values are the default dark `tonal` reference extracted from Paper [[z-shell-Paper]](#references).

- **Primary**: `primary` (Glacier Accent, Tone 80 dark / 40 light) for ≤10% focal indicators (active workspace numeral, today cell, slider fills, progress rings); `on-primary` strictly on `primary`; `primary-container` + `on-primary-container` (Calm Slate Blue / Ice Mist, Tone 30 dark / 90 light) for large active desktop controls (quick tiles, active sidebar items, connected device rows)—a deliberate desktop deviation from glaring mobile solid-`primary` tiles.
- **Secondary & Error**: `secondary-container` / `on-secondary-container` for neutral tonal actions (`Today`, notification actions); `error` / `error-container` / `on-error-container` strictly for destructive or error states (`Power off`, `17 · Power Dialog`, `Clear unpinned`, auth errors).
- **Neutral**: `surface` (Tone 6 dark / Tone 98 light `#F9F9FF`, lowest plane & Settings sidebar) → `surface-container` (Tone 12 dark / Tone 94 light `#EDEDF4`, bar islands & popovers) → `surface-container-high` (Tone 17 dark / Tone 92 light `#E7E8EE`, grouped cards & inactive tiles) → `surface-container-highest` (Tone 22 dark / Tone 90 light `#E1E2E9`, icon wells, unfilled tracks, compact buttons); foregrounds `on-surface` (`#E2E2E9` dark / `#191C20` light) & `on-surface-variant` (`#C3C6CF` dark / `#43474E` light) and hairlines `outline` (`#8D9199` / `#74777F`) & `outline-variant` (`#43474E` / `#C3C6CF`).
- **Light Mode Reference (`#1976D2`, `tonal`, `dark = false`)**: Generated directly by `crates/z-shell-theme`—`primary: #3C6090`, `on-primary: #FFFFFF`, `primary-container: #D4E3FF`, `on-primary-container: #224876`, `secondary-container: #D8E3F8`, `on-secondary-container: #3D4758`, `error: #BA1A1A`, `error-container: #FFDAD6`, `on-error-container: #93000A`. Light Mode uses softer ambient shadows (Level 1 `0 2px 10px rgba(25,28,32,0.08)`, Level 2 `0 10px 28px rgba(25,28,32,0.12)`, Level 3 `0 18px 48px rgba(25,28,32,0.16)` + `24%`–`28%` light scrim) paired with `1px solid outline-variant` hairlines. See the Paper **M3 Components — Light Mode** and **z-shell — Light Mode Showcase** pages [[z-shell-Paper]](#references).

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
Material 3 tonal layering paired with `1px` `outline-variant` hairlines prevents dark `#1D2024` popovers from blending into `#111318` terminals [[M3-Elevation]](#references). Floating peripheral chrome (`10 · Dock`, `09`/`09B` Floating Bars) uses a 3-tier **Frosted Glass vs. Solid Material Hierarchy** (see `10B · Dock Material Study` in Paper [[z-shell-Paper]](#references)); flush Wayland `PopupSurface` / `WindowSurface` chrome constraints live in [docs/agents/ui-runtime.md](docs/agents/ui-runtime.md).

- **Level 0 — Recessed / Sidebar**: `surface`, no shadow (desktop canvas, Settings sidebar).
- **Level 1A — Floating Dock (`10 · Dock`, High-Translucency Glass)**: Dark `surface-container @ 42%` + `blur(26px) saturate(165%)` + `1px` specular rim (`rgba(255,255,255,0.22)`) + `0 12px 28px rgba(0,0,0,0.44)`; Light `surface @ 40%` + `blur(26px) saturate(165%)` + `1px` white rim (`rgba(255,255,255,0.85)`) + subtle outer contrast hairline (`rgba(25,28,32,0.08)`) + `0 10px 26px rgba(25,28,32,0.12)`. To keep indicators legible across wallpaper/window seams, running dots step up to `on-surface @ 85%` (dark, with subtle shadow) / `82%` (light) and the focused pill uses `primary` (with soft `primary` glow in dark).
- **Level 1B — Floating Bar Islands (`09` / `09B`, Legibility Glass)**: Dark `surface-container @ 60%` + `blur(22px) saturate(150%)` + `1px` specular rim (`rgba(255,255,255,0.16)`) + `0 6px 18px rgba(0,0,0,0.36)`; Light `surface-container-low @ 62%` + `blur(22px) saturate(155%)` + `1px` white rim (`rgba(255,255,255,0.82)`) + subtle outer hairline + `0 4px 14px rgba(25,28,32,0.09)`—slightly higher opacity than Dock to keep `12px` bar typography crisp. Active islands step to `surface-container-high @ 72%` (dark) / `primary-container @ 85%` (light) + `primary @ 60%` border.
- **Wayland Graceful Solid Fallback**: Never render `40%–62%` unblurred transparency over live windows. Until `zgui-platform-wayland` binds `ext_background_effect_v1` (or the user enables compositor-side `layer-rule` blur), Floating Dock and Floating Bar automatically fall back to `100%` solid `surface-container` + `1px solid outline-variant @ 48%–55%`.
- **Level 1C — Docked Bars (`09C` / `09D`, Solid)**: `100%` opaque `surface-container` + `1px` inner `outline-variant` hairline (zero backdrop blur; guarantees stable small-text legibility at exclusive screen edges).
- **Level 2 — Popover Surfaces (Solid)**: `100%` opaque `surface-container`, `1px solid outline-variant @ 55%`, `box-shadow: 0 14px 36px rgba(0,0,0,0.50)` dark / `0 10px 28px rgba(25,28,32,0.12)` light (zero backdrop blur so underlying code/terminals never bleed through dense UI text).
- **Level 3 — Centered Modals & Settings (Solid)**: `100%` opaque `surface-container`, `1px solid outline-variant @ 55%`, `box-shadow: 0 20px 56px rgba(0,0,0,0.60)` dark / `0 18px 48px rgba(25,28,32,0.16)` light + dimmed scrim.

### Concentric Shape Scale
Tightened from mobile `28px`–`30px` sheets for desktop precision [[M3-Shape]](#references):
- `--radius-panel`: `22px` (outer popovers & modals) · `--radius-card`: `16px` (inner section cards & `32px` bar islands) · `--radius-tile`: `14px` (quick tiles & active rows) · `--radius-sm`/`md`: `8px`–`10px` (buttons, nav items, icon wells, today badge) · `--radius-pill`: `999px` (capsules, filter chips).

### Interaction State Layers & Motion System
`z-shell` implements the full **Material Design 3 Motion System**—analytical unit-mass **Spring Physics** (`standard` default, `expressive`, `reduced` via `[theme].motion_scheme`) paired with M3 **Easing & Duration** tokens [[M3-Motion]](#references). Full spring equations, token tables, and per-surface choreography live in [docs/design/motion.md](docs/design/motion.md).

- **State Layers**: Translucent foreground overlays—`Hover 8%`, `Focus 12%`, `Pressed 12%`, `Dragged 16%`, `Disabled 38%` ink / `12%` container (`fast.effects` / `100ms`, matching `material-web` `_md-sys-state.scss`) [[M3-States]](#references) [[M3-Web]](#references).
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

### Desktop M3 Component Primitives
All reusable interactive controls (**Buttons**, **Icon Buttons**, **Switches**, **M3 Expressive Sliders**, **Linear Progress**, **Tonal Track Segmented Controls**, **Filter Chips**, **Dialog Shells**) are implemented once in `@z-shell/sdk/primitives` (`packages/sdk/src/zgui-primitives.tsx` + `zgui-primitives.module.css`) and paired with `@hewel/zgui/primitives` (`MenuRootPrimitive`, `MenuListPrimitive`, `MenuItemPrimitive`). Exact token, state-layer, and deviation contracts live in [docs/design/components.md](docs/design/components.md) and Paper **M3 Components — Desktop Spec** [[M3-Components]](#references) [[M3-Web]](#references) [[z-shell-Paper]](#references).

### Surface Anatomy
- **Bar Modes (`09`/`09B` Floating vs `09C`/`09D` Docked)**: Floating uses `32px`/`40px` islands with `14px` margin; Docked uses a flush `100%` solid `38px`/`44px` strip with `1px` inner hairline and `28px` `primary-container` (`8px` radius) active triggers. Active workspace always renders its number in a solid `primary` capsule (`on-primary` bold); Clock omits seconds by default and pairs with a `primary-container` unread pill; Tray renders real icons (`18px`–`20px`).
- **Floating Dock (`10 · Dock`)**: Auto-hiding `60px` pill capsule (`exclusiveZone = 0`, `10px–14px` bottom margin) hosting a Launcher well (`apps`), pinned apps, a `1px × 30px` hairline divider, running-only apps, contrast-boosted running dots, and a `primary` focused pill.
- **Quick Control Tiles (`01 · Main`)**: 2-column grid, `50px` tall (`14px` radius), `primary-container` active / `surface-container-high` inactive; split tiles (`Wi-Fi`, `Bluetooth`, `Nosleep`) separate toggle from `>` chevron with a `1px × 22px` vertical hairline.
- **Power Menu & Device Lists (`01` / `02` / `03` / `04` / `17`)**: Power menu separates safe actions (`Lock`, `Suspend`) from session-ending actions (`Log out`, `Reboot`, `Power off`) with a `1px × 28px` divider and confirms via `17 · Power Dialog` (`360px`). Connected device rows (`52px` min-height, `16px` radius) offer safe `Disconnect` rather than destructive `Remove`.
- **Keyboard-First Modals (`18` / `19` / `20`) & Settings Window (`22`–`22H`)**: Centered modals pair a top composite search bar (with `Esc` hint) + `M3FilterChip` / list / grid + compact bottom keyboard hint bar; `820×600px` Settings Window hosts a `216px` `surface` left rail (`SHELL` & `PLUGINS`) and `604px` right pane.

---

## Lint-Enforced Contracts

Mechanical rules are enforced automatically across 4 layers (do not duplicate them in review docs):
- **L1 (`oxlint`)**: `tools/oxlint-design-plugin.mjs` (`zshell/*`) + `@hewel/zgui/oxlint` (`zgui/*`) via `bun run lint`
- **L2 (Contract & CSS Module Sync)**: `apps/shell/tests/design-lint.test.ts` (`bun test`)
- **L3 (Rust WCAG & Light Mode Reference)**: `crates/z-shell-theme/tests/hct_palette.rs` (`cargo test`)
- **L4 (Preview Pixel/Geometry & Light Mode Showcase)**: `apps/shell/tests/design-preview.test.ts`

| Domain | Mechanical Invariant | Layer & Enforcer | Status |
|---|---|---|---|
| **Color** | No raw `#hex`/`rgb`/`rgba`/`hsl` in TSX or `*.module.css` (shadow black excepted in `no-raw-colors`) | L1 `zshell/no-raw-colors` + L2 CSS Module lint | Active |
| **Color** | Valid 31 M3 roles & strict `on-*` foreground/container pairing (incl. `<ShellIcon>` and CSS Modules) | L1 `zshell/valid-color-roles` + L2 CSS Module lint | Active |
| **Color** | Calm Active Surface: no solid `primary` fill on large containers/tiles | L1 `zshell/calm-active-surface` | Active |
| **Color** | WCAG 2.2 SC 1.4.3 (≥4.5:1 text) & SC 1.4.11 (≥3:1 UI) across 10 seeds × 6 variants × dark/light + Light Mode `#1976D2` luminance ladder | L3 `hct_palette.rs` | Active |
| **Tokens** | Frontmatter ↔ `app.css` ↔ `theme.ts` (Dark & Light `--shadow-level-1/2/3`, `--state-*`, `--disabled-*`) ↔ `topics.ts` ↔ bundled fonts sync | L2 `design-lint.test.ts` | Active |
| **Elevation** | Semantic `var(--shadow-level-1/2/3)` only (no dark-only `rgba()` `boxShadow`); no unblurred translucent `surface-container*` (Graceful Solid Fallback); no flush root `boxShadow` | L1 `zshell/semantic-elevation-tokens`, `no-unblurred-translucent-surface`, `no-flush-surface-shadow` | Active |
| **Components** | Shared `@z-shell/sdk/primitives` only (no hand-rolled switches/sliders); desktop action buttons use `10px`/`8px` (never `999px` pill); Expressive Slider `4px` gaps + `4px` stop dot, `44×24px` Switch, `34px` Dialog actions verified in pixels | L1 `zshell/no-duplicate-primitives`, `no-pill-action-button` + L4 | Active |
| **Typography** | Semantic font tokens only (`var(--font-sans)` / `var(--font-mono)`); tabular readouts require `tabular-nums`; persistent bars omit 1Hz seconds by default | L1 `zshell/no-system-ui-font`, `tabular-readout` + L2 | Active |
| **Shapes & Icons** | Desktop radius scale (`6/8/10/14/16/22/999px`); Expressive-Budget (wavy only in `MediaPanel.tsx`; rosette only in brand mark & avatars); exact $D_n$ symmetry; Material `24×24` icon grid | L1 `zshell/valid-radius-scale`, `expressive-budget`, `no-hand-authored-expressive-paths`, `material-icon-grid` + L2 | Active |
| **IA & Safety** | Single-Owner IA; Split-Action `1px` divider on split QuickTiles; no unguarded `Remove` on connected BT rows | L1 `zshell/single-owner-ia`, `split-action-divider`, `bluetooth-safe-action` | Active |
| **Copy & A11y** | Desktop copy (`Click`, never `Tap to`/`Long press`); never `outline: none/0`; composite input focus delegation; ≥24×24px hit targets | L1 `zshell/no-mobile-copy`, `no-outline-none`, `composite-input-focus`, `min-hit-target-size` + L2 + L4 | Active |
| **Layout & Light Mode** | Width tiers (`360/396/560/652/684/820×600`), bar struts (`32/40/38/44`), zero-scroll (`overflowY: false`), 1280px anti-collision, slider lane alignment, shadow bleed α≤8, transparent popup corners, opaque toplevel edges, hover hit-target stability, full **Light Mode (`dark: false`)** preview suite | L1 `zshell/no-hover-hit-target-shift` + L2 + L4 | Active |
| **Runtime & Governance** | No core hardcoded plugin IDs (ADR-0005); no inline `oxlint-disable`; Solid 2 `<Show keyed>` callback param; no direct `__zgui` bridge, ref cleanups, top-level service calls, or `solid-js/web` imports | L1 `zshell/no-core-plugin-id-branching`, `no-lint-suppression`, `solid-show-keyed-callback` + `zgui/no-direct-bridge`, `no-cleanup-in-ref`, `no-top-level-service-call`, `no-solid-web-imports` | Active |
| **Motion** | M3 spring/easing tokens only; no `outline-width` transitions; single shared frame loop (`motion.ts`); `.impeccable/design.json` ↔ `motion.ts` ↔ `app.css` sync; `k=3800` stability & zero-overshoot effects; `reduced` scheme zero displacement & static media wave | L1 `zshell/m3-motion-tokens`, `no-direct-raf-loop` + L2 `motion.test.ts` / `design-lint.test.ts` + L4 | Active |

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
8. **[M3-Components]** Google Material Design 3 — *Components Overview & Expressive Specs*: https://m3.material.io/components · [docs/design/components.md](docs/design/components.md)
9. **[M3-Web]** Google `material-components/material-web` — *Official M3 Component & State Tokens (`tokens/versions/v0_192/`)*: https://github.com/material-components/material-web/tree/main/tokens/versions/v0_192
10. **[XDG-Icon]** freedesktop.org — *XDG Icon Theme Specification* (runtime Linux desktop application icon lookup): https://specifications.freedesktop.org/icon-theme-spec/latest/
11. **[WCAG-2.2]** W3C — *Web Content Accessibility Guidelines (WCAG) 2.2* (SC 1.4.3 Contrast Minimum, SC 1.4.11 Non-text Contrast, SC 2.3.3 Animation from Interactions, SC 2.4.7 Focus Visible, SC 2.4.11 Focus Not Obscured, SC 2.4.13 Focus Appearance, SC 2.5.8 Target Size Minimum): https://www.w3.org/TR/WCAG22/
12. **[Wayland-Layer]** Wayland Protocols — *Session Lock (`ext-session-lock-v1`) & Layer Shell Surfaces*: https://wayland.app/protocols/ext-session-lock-v1
13. **[z-shell-Paper]** `z-shell` Paper Design Canvas (*M3 Components — Desktop Spec* (Dark & Light), *All Surfaces & Panels*, *Light Mode Showcase*, & *Desktop Placement*): https://app.paper.design/file/01M7J3P8QM6GW1HSHNW0M8TQSV/p-4-0
14. **[z-shell-ADR-0003]** Internal Architecture Decision Record — [docs/adr/0003-pure-rust-audio-and-theme-engines.md](docs/adr/0003-pure-rust-audio-and-theme-engines.md) & [crates/z-shell-theme/src/palette.rs](crates/z-shell-theme/src/palette.rs)
15. **[z-shell-SCOPE]** Internal Product Scope & Domain Glossary — [SCOPE.md](SCOPE.md) & [GLOSSARY.md](GLOSSARY.md)
