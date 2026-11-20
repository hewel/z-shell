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

> **Conformance Policy**: `z-shell` follows a **"100% Material 3 Color & Surface Roles + Desktop Productivity Density & Keyboard Ergonomics"** strategy. Color role pairing, tonal elevation semantics, and contrast invariants strictly follow Material Design 3 [[M3-Color]](#references) and W3C WCAG 2.2 [[WCAG-2.2]](#references). Touch-first dimensions, oversized corner radii, and narrow mobile sheets are intentionally adapted for Linux Wayland pointer-and-keyboard tiling desktops, with every deliberate deviation documented in place.

---

## Overview

**Creative North Star: "Quiet Precision on Tiled Glass"**

`z-shell` is a modular Linux Wayland desktop shell rendered via `zgui-js` (Solid 2.0 TSX + StyleX on QuickJS) and backed by the Rust `z-shelld` daemon [[z-shell-SCOPE]](#references). Its users spend 8–12 hours a day in terminals, code editors, and tiling compositors (such as Niri and ShojiWM). Every shell surface operates in **Operate** mode: chrome recedes quietly during focused work, reads in under 200ms at a glance, opens without vertical scrolling, and supports full keyboard-and-pointer velocity.

The visual foundation adopts Material Design 3's **HCT dynamic color system and tonal surface layering** [[M3-Color]](#references) [[M3-Elevation]](#references), while restraining mobile M3 Expressive habits (oversized pills, bright saturated quick-toggle blocks, and deep single-column sheets). Expressive touches—such as the audio playback waveform and morphing lock-screen password shapes—are reserved for a strict budget of high-meaning focal moments [[M3-Shape]](#references).

**Key Characteristics:**
- **Dynamic Color First**: Every surface and control consumes semantic role tokens generated on the fly by `crates/z-shell-theme` (pure-Rust Material 3 HCT palette engine) from either the active wallpaper or a user seed color [[z-shell-ADR-0003]](#references).
- **Zero-Scroll Primary Popovers**: On a standard `1440×900` laptop display, every high-frequency bar popover (Control Center, Calendar, Wi-Fi, Bluetooth, Sound, Nosleep, Media Player, AI Usage) fits completely without vertical scrolling.
- **Single-Owner Information Architecture**: Each desktop domain has one authoritative home—Notifications and Do Not Disturb live in Calendar; quick toggles and hardware switches live in Control Center; deep configuration and plugin `settings_page` entries live in the dedicated `820×600` Settings window.
- **Desktop-Native Ergonomics**: Anchoring respects pointer travel (e.g., bottom-left anchoring for Control Center when triggered from the vertical left bar), copy uses desktop terminology (`Click`, never `Tap`), and modals prioritize keyboard navigation and visible shortcut hints.

---

## Colors

The palette is not a static theme; it is a **31-role semantic color scheme** computed dynamically in the Material 3 HCT (Hue, Chroma, Tone) color space across 6 variants (`tonal`, `vibrant`, `expressive`, `fidelity`, `neutral`, `mono`) and 3 modes (`dark`, `light`, `auto`) [[M3-Color]](#references) [[z-shell-ADR-0003]](#references). The hex values in frontmatter represent the default dark `tonal` reference palette extracted from the `z-shell` Paper design file [[z-shell-Paper]](#references).

### Primary
- **Glacier Accent (`primary`)**: High-priority indicators, active workspace pill, slider fills, progress rings, and key focal icons (HCT Tone 80 in dark mode, Tone 40 in light mode) [[z-shell-ADR-0003]](#references).
- **Deep Navy Ink (`on-primary`)**: Foreground text and icons placed strictly on solid `primary` fills (active workspace numeral `2`, calendar today cell `17`, lock-screen focal accents), maintaining ≥ 4.5:1 contrast [[WCAG-2.2]](#references).
- **Calm Slate Blue (`primary-container`)**: Default active fill for large desktop interactive containers—active Control Center tiles, active Settings sidebar items, and connected device rows (Tone 30 dark / Tone 90 light)—replacing glaring solid `primary` mobile blocks.
- **Ice Mist (`on-primary-container`)**: High-legibility foreground labels and trailing chevrons on `primary-container`.

### Secondary & Error
- **Muted Steel (`secondary-container` / `on-secondary-container`)**: Neutral tonal actions and secondary badges (`Today` jump button, notification `Open` / `Copy` actions).
- **Crimson Signal (`error` / `error-container` / `on-error-container`)**: Strictly reserved for destructive or irreversible states (`Power off` tile, `17 · Power Dialog` confirmation action, `Clear unpinned` in Clipboard, and future authentication/validation errors).

### Neutral
- **Obsidian Base (`surface`)**: Lowest structural plane and Settings window navigation sidebar (Tone 6 dark / Tone 98 light).
- **Graphite Shell (`surface-container`)**: Floating bar islands and primary popover/modal containers (Tone 12 dark).
- **Elevated Slate (`surface-container-high`)**: Grouped section cards inside popovers and inactive quick tiles (Tone 17 dark).
- **Control Well (`surface-container-highest`)**: Icon backing wells, unfilled slider tracks, and neutral compact buttons (Tone 22 dark).
- **Foreground & Borders (`on-surface` / `on-surface-variant` / `outline` / `outline-variant`)**: Primary copy, secondary metadata, uppercase section labels, and `1px` structural hairlines.

### Named Rules
- **The Calm Active Surface Rule.** Large active desktop controls (quick tiles, sidebar navigation items, connected device rows) must use `primary-container` + `on-primary-container` (optionally paired with a `primary` 30% border) rather than solid `primary`. Reserve solid `primary` to ≤10% of any surface for small focal indicators (active workspace number, today cell, slider fill, icon glyph). *(Deliberate desktop deviation from mobile Android Quick Settings to prevent glare during long sessions.)*
- **The Strict Role-Pairing Rule.** Every foreground token must pair with its corresponding container role (`on-*` over its matching surface/container). Hardcoded hex colors are forbidden in UI components so all 31 roles automatically satisfy WCAG 2.2 SC 1.4.3 (≥ 4.5:1 body text, ≥ 3:1 large text) and SC 1.4.11 (≥ 3:1 UI component boundaries and icons) across arbitrary user wallpapers [[M3-Color]](#references) [[WCAG-2.2]](#references).

---

## Typography

**Display & UI Font:** `Roboto Flex` (variable weight axis `wght 100–1000`), fallback `sans-serif` [[M3-Typography]](#references)
**Data & Code Font:** `JetBrains Mono` (`wght 400–700`), fallback `monospace`

**Character:** `Roboto Flex` delivers Material 3's crisp geometric clarity at compact desktop sizes (`11px`–`14px`). `JetBrains Mono` is reserved strictly for live numeric readouts, file paths, config identifiers, and CLI/agent metadata (slider percentages, `settings.toml`, clipboard code/path snippets, active `nosleep` agent sessions)—never used as ornamental styling.

### Hierarchy
- **Display** (`Roboto Flex` Regular 400, `44px` / `52px`, `-0.02em`): Calendar header clock; scaled up (`64px` light weight) on the Lock Screen.
- **Headline** (`Roboto Flex` SemiBold 600, `22px` / `28px`, `-0.015em`): Sub-panel titles (`Wi-Fi`, `Bluetooth`, `Sound`, `Nosleep`, `AI usage`) and Settings pane headers (`18px`–`22px`).
- **Title** (`Roboto Flex` SemiBold 600, `15px`–`16px` / `20px`–`22px`): User identity, month heading, and section headings (`Notifications`).
- **Body** (`Roboto Flex` Medium 500, `13px`–`14px` / `18px`–`20px`): Device names, quick tile titles, notification titles, and Settings sidebar links.
- **Label** (`Roboto Flex` Regular–SemiBold 400–600, `11px`–`12px` / `14px`–`16px`): Tile subtitles, bar island labels, button text, and uppercase sidebar group headers (`SHELL`, `PLUGINS` with `+0.04em` tracking).
- **Mono** (`JetBrains Mono` Medium 500, `10px`–`12px` / `14px`–`16px`): Live percentage readouts, file paths, config badges, and running agent names.

### Named Rules
- **The Tabular Readout Rule.** All live numeric values (volume `%`, brightness `%`, battery percentage, quota countdowns) must use `JetBrains Mono` or `tabular-nums` inside a fixed-width right-aligned slot (`32px`–`36px`) so value changes never jitter surrounding layout.
- **The No-1Hz-Flicker Rule.** Persistent desktop bars (Top Bar and Vertical Bar) omit ticking seconds by default so peripheral 1Hz motion does not distract from coding or reading; seconds appear only inside the user-invoked Calendar popover.

---

## Layout

Desktop placement follows a **`14px` global tiling rhythm** (matching `[bar].gaps = 14` in `settings.toml`) across screen margins, tiled window gaps, and bar-to-popover offsets [[z-shell-Paper]](#references).

### Surface Size Tiers
All shell surfaces snap to **four standardized width tiers**:

| Tier | Standard Dimensions | Height Behavior (`1440×900`) | Surfaces |
|---|---|---|---|
| **Bar Strut (Floating)** | Top bar `100% × 46px` (`32px` islands + `14px` top margin); Vertical bar `54px × 100%` (`40px` islands + `14px` side margin) | Exclusive Wayland `wlr-layer-shell` edge strut | `09 · Top Bar`, `09B · Vertical Bar` |
| **Bar Strut (Docked / Flush)** | Top bar `100% × 38px` (`0px` outer margin, `1px` bottom hairline); Vertical bar `44px × 100%` (`0px` outer margin, `1px` inner hairline) | Exclusive Wayland `wlr-layer-shell` flush edge strut (reclaims `8px`–`10px` workspace space) | `09C · Docked Top Bar`, `09D · Docked Vertical Bar` |
| **Compact Popover** | `360px` wide | Fit-content, zero scroll | `12 · Notification Popup`, `15 · Nosleep`, `17 · Power Dialog`, `23 · Polkit Auth Prompt` |
| **Standard Popover** | `396px` wide | **Zero scroll** (target ≤ `760px`) | `01 · Main`, `02 · Wi-Fi`, `03 · Bluetooth`, `04 · Sound`, `04B · Battery & Power`, `13 · Calendar`, `14 · Media Player`, `16 · AI Usage` |
| **Centered Modal** | `560px`–`684px` wide | Centered over dimmed desktop scrim | `18 · Launcher` (`652px`), `19 · Clipboard` (`560px`), `20 · Workspace Overview` (`684px`) |
| **Settings Window** | `820px × 600px` | `216px` left nav + `604px` content pane | `22 · Appearance`, `22B · Bar & Layout`, `22C · Idle & Sleep`, `22D · Power & Battery`, `22E · AI Usage`, `22F · Nosleep`, `22G · Theme Bridges`, `22H · Niri Overview` |
| **Exclusive Fullscreen** | `100% × 100%` | Exclusive `ext-session-lock-v1` lock surface [[Wayland-Layer]](#references) | `21 · Lock Screen` |

### Anchoring & Pointer Ergonomics
- **Top Bar Mode**: Popovers anchor at `y = 58px` (`46px` bar strut + `12px` breathing gap), aligned horizontally to their triggering island (Calendar centered under Clock, Control Center right-aligned at `right = 14px`, plugin popovers anchored directly beneath their trailing island).
- **Vertical Left Bar Mode**: Popovers triggered from the bottom-left `Status Island` (Control Center and its sub-panels) must **bottom-align** (`left = 66px`, `bottom = 14px`) to minimize pointer travel and preserve visibility of the upper tiled terminal/editor workspace.
- **Top Bar Collision Guard**: `Active Window Island` and `Media Island` enforce `max-width` truncation (`text-overflow: ellipsis`) so long titles or `1280px` / `1366px` laptop widths never collide with the centered `Clock Island`.

### Named Rules
- **The Zero-Scroll Popover Rule.** High-frequency transient popovers must fit cleanly within `1440×900` with zero vertical scrolling. Any workflow exceeding ~`760px` or involving multi-field forms or image grids must live in the dedicated `820×600` Settings window, never inside a `396px` dropdown.
- **The Single-Owner IA Rule.** Every domain has exactly one primary surface: Notifications & Do Not Disturb belong to `13 · Calendar`; quick hardware toggles belong to `01 · Control Center`; configuration and plugin settings pages belong to `Settings Window`.

---

## Elevation & Depth

`z-shell` uses **Material 3 tonal surface layering paired with crisp `1px` structural borders and soft ambient shadows** [[M3-Elevation]](#references). On dark tiling desktops, tonal elevation alone can allow `#1D2024` popovers to blend into `#111318` terminals; the subtle `outline-variant` border guarantees clean edge separation against any dark window.

### Elevation Vocabulary
- **Level 0 — Recessed / Sidebar (`surface`, no shadow)**: Desktop canvas and Settings navigation rail.
- **Level 1 — Bar Islands (`surface-container`, `1px solid outline-variant @ 48%`, `box-shadow: 0 4px 14px rgba(0,0,0,0.36)`)**: Floating edge islands; active islands step up to `surface-container-high` with a `primary @ 60%` border.
- **Level 2 — Popover Surfaces (`surface-container`, `1px solid outline-variant @ 55%`, `box-shadow: 0 14px 36px rgba(0,0,0,0.50)`)**: Control Center, Calendar, Media Player, Nosleep, AI Usage, and Notification Toast.
- **Level 3 — Centered Modals & Settings (`surface-container`, `1px solid outline-variant @ 55%`, `box-shadow: 0 20px 56px rgba(0,0,0,0.60)` + dimmed desktop scrim)**: Launcher, Clipboard, Workspace Overview, Settings Window, and Power Dialog.

### Interaction State Layers & Motion
Aligned with Material 3 interaction states [[M3-States]](#references) and motion tokens [[M3-Motion]](#references):
- **State Layers**: Interactive controls indicate state via translucent foreground overlays—`Hover: 8%`, `Focus: 10%`, `Pressed: 12%`, `Disabled: 38%` content opacity.
- **Keyboard Focus Ring**: Per WCAG 2.2 SC 2.4.7 and SC 2.4.13, keyboard focus renders a ≥ `2px` high-contrast perimeter ring (`outline: 2px solid var(--color-primary); outline-offset: 2px`) with ≥ `3:1` contrast against adjacent surfaces [[WCAG-2.2]](#references).
- **Motion Timing**: Popovers and modals enter in `180ms–220ms` using Emphasized Decelerate (`cubic-bezier(0.05, 0.7, 0.1, 1.0)`) and dismiss in `120ms–150ms` using Emphasized Accelerate (`cubic-bezier(0.3, 0.0, 0.8, 0.15)`). Toggles and state layers complete in `100ms–150ms`.

---

## Shapes

Corner radii tighten the Material 3 shape scale [[M3-Shape]](#references) for desktop precision, replacing oversized `28px`–`30px` mobile sheets with a concentric nested hierarchy:

- **Outer Popovers & Settings Window**: `22px` (`--radius-panel`)
- **Inner Section Cards**: `16px` (`--radius-card`, concentric with `22px` outer radius and `14px` padding)
- **Quick Tiles & Active List Rows**: `14px` (`--radius-tile`)
- **Compact Buttons, Nav Items, Icon Wells, Calendar Today Badge**: `8px`–`10px` (`--radius-sm` / `--radius-md`)
- **Bar Islands, Filter Chips & Full Pills**: `16px` (`32px`-tall islands) or `999px` (`--radius-pill`)

### Named Rules
- **The Expressive-Budget Rule.** Expressive M3 shapes and wave tracks are strictly budgeted: the scalloped rosette silhouette is reserved exclusively for the **z-shell brand mark** (e.g., Settings sidebar header) and **user avatar badges** (Control Center and Lock Screen)—never reused on functional Launcher triggers, calendar dates, destructive warnings, or utility buttons. Wavy progress tracks are reserved exclusively for **`14 · Media Player` playback progress**; all hardware and config sliders (volume, microphone, brightness, gaps) use crisp straight tracks. *(Deliberate desktop restraint over mobile M3 Expressive.)*
- **The Exact-Geometry Shape Rule.** All M3 Expressive geometric silhouettes (the 8-lobe $D_8$ scalloped rosette and Lock Screen morphing password dots: `Cookie4`, `Clover4`, `Sunny`, `Circle`, `Cookie6`, `Flower5`) must be generated analytically with exact rotational and mirror symmetry around their `viewBox` center `(cx, cy)`. Hand-estimated Bezier coordinates are strictly prohibited.

---

## Components

### Iconography (Material Icons First)
`z-shell` enforces a three-tier iconography policy with **Google Material Icons / Material Symbols** as the mandatory default for all system UI glyphs [[M3-Icons]](#references):

| Tier | Source & Grid | Usage Scope | Size & Alignment Rules |
|---|---|---|---|
| **1. System UI Icons (Primary)** | **Material Icons / Material Symbols** (`24×24` optical grid, Filled / Rounded style) [[M3-Icons]](#references) | All bars, popovers, toggles, headers, navigation rails, dialogs, Launcher triggers, and system utilities (e.g., `apps` for Launcher, `dashboard` for Workspace Overview, `wifi`, `bluetooth`, `volume_up`, `battery_charging_full`, `local_cafe`, `smart_toy`, `auto_awesome`, `graphic_eq`, `terminal`, `folder`, `tune`, `monitor_heart`, `grid_view`, `settings`, `notifications`) | Render on `viewBox="0 0 24 24"` using semantic `fill` tokens (`on-surface`, `on-surface-variant`, `primary`, `on-primary-container`). Common optical sizes: `12px`–`18px` (bars & inline metadata), `16px`–`18px` (toggles, headers & list rows), `20px`–`22px` (dock, modals & system app tiles). |
| **2. M3 Expressive Shapes** | Analytically symmetric SVG paths (`viewBox="0 0 64 64"` or `0 0 24 24"`) [[M3-Shape]](#references) | Strictly limited to the `z-shell` 8-lobe scalloped brand mark, user avatar badges, and Lock Screen morphing password indicators | Exact dihedral symmetry ($D_4$/$D_6$/$D_8$) centered on `(cx, cy)`; never hand-approximated. |
| **3. Third-Party App & Brand Icons** | Runtime: Linux **XDG Icon Theme Specification** (`.desktop` `Icon=` lookup) [[XDG-Icon]](#references). Design canvas: one canonical brand SVG per app (official mark / Simple Icons) | `18 · Launcher`, `10 · Dock`, `Tray Island`, and active window indicators | Every third-party app (e.g., Zen Browser, Alacritty, Spotify, Paper, Discord) must use **one identical icon and brand backing color** across Launcher, Dock, Tray, and Vertical Bar. Generic system utilities (`Files`, `Pavucontrol`, `Monitor`, `Settings`) default to Tier 1 Material Icons. |

- **The Material-First Icon Rule.** Never invent custom hand-drawn UI glyphs when an official Material Icon exists (for example, use `smart_toy` for Nosleep agent guard, `auto_awesome` for AI usage, `graphic_eq` for live media playback, `monitor_heart` for system monitor, and `grid_view` for workspace overview). Composite telemetry widgets (such as the AI quota circular progress ring) must center any inner Material sparkle cleanly on the exact `viewBox` midpoint `(cx, cy)`.

### Bar Modes (`09` / `09B` Floating Islands vs. `09C` / `09D` Docked Flush Bar)
`z-shell` supports two bar styles sharing identical information density and semantic tokens:
- **Floating Islands (`09 · Top Bar`, `09B · Vertical Bar`)**: `32px`-tall horizontal islands or `40px`-wide vertical islands in `surface-container` with a `48%` `outline-variant` border and `14px` outer screen margin.
- **Docked / Non-Floating Bar (`09C · Docked Top Bar`, `09D · Docked Vertical Bar`)**: Flush edge-to-edge `38px` top strip or `44px` vertical rail in `surface-container` with a single `1px` inner edge hairline (`outline-variant @ 48%`). Segments live directly on the bar surface—separated by `1px × 14px` hairlines instead of nested bordered capsules—and active popover triggers highlight as a `28px`-tall `primary-container` pill (`8px` radius). Popovers anchor `10px` from the flush bar edge (`y = 48px` top; `x = 54px, bottom = 14px` left).
- **Workspaces**: The active workspace always displays its workspace number (e.g., `2`) inside a solid `primary` capsule (`on-primary` bold text) in both horizontal and vertical bars; occupied inactive workspaces use medium-contrast dots and empty workspaces use low-contrast dots.
- **Clock Island**: Top bar pairs `Tue 17 Nov · 21:58` with a `1px` divider and `primary-container` unread notification pill (`🔔 2`); vertical bar stacks `21 / 58` above the same `🔔 2` unread pill (no seconds).
- **Tray Island**: Renders real application icons inside `18×18px` / `20×20px` rounded containers—never blank solid color placeholders.

### Quick Control Tiles (`01 · Main`)
2-column grid, `50px` tall, `14px` radius.
- **Active**: `primary-container` fill, `primary @ 30%` border, `30×30px` icon well (`10px` radius, `primary @ 18%` fill, `primary` icon), `on-primary-container` title and `78%` subtitle.
- **Inactive**: `surface-container-high` fill, `surface-container-highest` icon well, `on-surface` / `on-surface-variant` labels.
- **Split-Action Guardrail**: Any toggle tile that also opens a sub-panel (`Wi-Fi`, `Bluetooth`, `Nosleep`) must separate its primary toggle area from the trailing `>` chevron with a `1px × 22px` vertical hairline so users never accidentally disconnect while trying to inspect networks or devices.

### Precision Sliders (`01 · Main` / `04 · Sound` / `11 · OSD`)
Straight `5px`–`6px` desktop tracks (`surface-container-highest` trough, `primary` active fill) with a `12px`–`14px` circular thumb outlined by a `2px` container-matched ring.
- **Vertical Lane Alignment**: Repeated slider rows must use fixed-width slots (`flex-shrink: 0`) for leading icons (`30×30px`), monospace percentage readouts (`32px`–`36px` right-aligned), and trailing actions (`26×26px`, including an empty spacer when a row has no chevron) so every track starts and ends on the exact same vertical lane.

### Power Menu & Confirmation (`01 · Main` / `17 · Power Dialog`)
- The expanded power bar separates **reversible/safe actions** (`Lock`, `Suspend`) from **session-ending/destructive actions** (`Log out`, `Reboot`, `Power off`) with a `1px × 28px` vertical divider; `Power off` uses `error-container @ 38%` fill and `error @ 35%` border.
- Destructive power actions require confirmation via `17 · Power Dialog` (`360px` centered modal with rounded crimson power badge, plain-language consequence text, and `Cancel` / `Shut down`).

### Device Lists (`02 · Wi-Fi` / `03 · Bluetooth` / `04 · Sound`)
- Connected/active rows use `primary-container` (`16px` radius, `52px` min-height) with a semantically safe trailing action (`Disconnect` broken-link icon on both connected Wi-Fi and connected Bluetooth devices—never a `Delete/Forget` trash icon on the primary connected row).
- All interactive hint copy uses desktop phrasing (`Click to connect` / `Click to pair`), never mobile `"Tap to ..."`.

### Keyboard-First Modals (`19 · Clipboard` / `18 · Launcher` / `20 · Workspace Overview`)
Modeled on `19 · Clipboard` as the canonical desktop modal grammar:
- Dedicated top search field with visible focus indicator and caret, paired with counted filter/provider chips (`All · 28`, `Pinned · 2`, etc.);
- High-density structured list or preview grid with monospace metadata and aligned trailing action slots;
- Compact bottom keyboard hint bar (`↑↓ Move · Enter Copy · Del Forget · Esc Close`) so every primary action completes without touching the mouse.

### Settings Window (`22 · Settings Window`)
`820×600px` centered desktop configuration window with a `216px` left rail (`surface` fill) grouped into `SHELL` (`Appearance`, `Bar & layout`, `Idle & sleep`, `Power & battery`) and `PLUGINS` (`AI usage`, `Nosleep`, `Theme bridges`, `Niri overview`), anchored by a `settings.toml · Live` status footer. The `604px` right pane hosts wide multi-column cards (4×2 wallpaper browser, side-by-side color seed + HCT variant controls, app color bridge strip) and scales natively to first-party and third-party TSX `settings_page` plugin entries [[z-shell-SCOPE]](#references).

---

## Do's and Don'ts

### Do:
- **Do** bind all UI colors exclusively to semantic CSS custom properties generated by `z-shell-theme` so dark/light switching and wallpaper theming stay accessible [[M3-Color]](#references) [[z-shell-ADR-0003]](#references).
- **Do** keep every pointer target ≥ `24×24px` (prefer `28px`–`36px` for frequent controls) and maintain ≥ `4.5:1` contrast for all body text [[WCAG-2.2]](#references).
- **Do** use fixed-width slots (`flex-shrink: 0`) for icons, tabular numeric readouts, and trailing actions across repeated rows.
- **Do** keep all primary popovers zero-scroll at `1440×900`, deferring low-frequency telemetry (battery health, cycle count) and rich editors to the `820×600` Settings window.
- **Do** prefer official **Material Icons / Material Symbols** (`viewBox="0 0 24 24"`) for all system UI glyphs, use mathematically symmetric SVG paths for M3 Expressive shapes, and keep one canonical icon per app across Launcher, Dock, and Tray [[M3-Icons]](#references) [[XDG-Icon]](#references).
- **Do** bottom-align popovers triggered from the bottom-left `Status Island` in vertical left-bar mode.

### Don't:
- **Don't** hand-draw ad-hoc UI icons when a Material Icon exists, hand-estimate asymmetric scalloped Bezier paths, or mix inconsistent app icons/colors between Dock, Launcher, and Tray.
- **Don't** fill large Control Center tiles with solid high-saturation `primary`, or duplicate `Notifications` / `Do Not Disturb` across both Control Center and Calendar.
- **Don't** style read-only telemetry (such as `AI usage` quota) as an active ON/OFF toggle tile.
- **Don't** apply wavy playback tracks to hardware or configuration sliders (volume, mic, brightness, gaps), or reuse the scalloped brand silhouette across more than two distinct meanings.
- **Don't** place a destructive "Forget" trash icon in place of "Disconnect" on a connected Bluetooth device, or ship mobile `"Tap"` copy on a Linux desktop.
- **Don't** cram wallpaper browsers, rule editors, or plugin settings pages into a `396px` transient popover.

---

## References

1. **[M3-Color]** Google Material Design 3 — *Color Roles & Dynamic Color (HCT)*: https://m3.material.io/styles/color/roles · https://m3.material.io/styles/color/system/how-the-system-works
2. **[M3-Elevation]** Google Material Design 3 — *Elevation & Tonal Surface Layering*: https://m3.material.io/styles/elevation/overview
3. **[M3-States]** Google Material Design 3 — *Interaction States & State Layers*: https://m3.material.io/foundations/interaction/states/overview
4. **[M3-Shape]** Google Material Design 3 — *Shape Scale & Expressive Shapes*: https://m3.material.io/styles/shape/overview
5. **[M3-Typography]** Google Material Design 3 — *Typography Scale*: https://m3.material.io/styles/typography/overview
6. **[M3-Motion]** Google Material Design 3 — *Motion Physics, Easing & Duration*: https://m3.material.io/styles/motion/overview
7. **[M3-Icons]** Google Material Design 3 — *Icons Overview & Material Symbols / Icons*: https://m3.material.io/styles/icons/overview · https://fonts.google.com/icons
8. **[XDG-Icon]** freedesktop.org — *XDG Icon Theme Specification* (runtime Linux desktop application icon lookup): https://specifications.freedesktop.org/icon-theme-spec/latest/
9. **[WCAG-2.2]** W3C — *Web Content Accessibility Guidelines (WCAG) 2.2* (SC 1.4.3 Contrast Minimum, SC 1.4.11 Non-text Contrast, SC 2.4.7 Focus Visible, SC 2.4.11 Focus Not Obscured, SC 2.4.13 Focus Appearance, SC 2.5.8 Target Size Minimum): https://www.w3.org/TR/WCAG22/
10. **[Wayland-Layer]** Wayland Protocols — *Session Lock (`ext-session-lock-v1`) & Layer Shell Surfaces*: https://wayland.app/protocols/ext-session-lock-v1
11. **[z-shell-Paper]** `z-shell` Paper Design Canvas (*z-shell — All Surfaces & Panels* & *Desktop Placement*): https://app.paper.design/file/01M7J3P8QM6GW1HSHNW0M8TQSV/p-2-0
12. **[z-shell-ADR-0003]** Internal Architecture Decision Record — [docs/adr/0003-pure-rust-audio-and-theme-engines.md](docs/adr/0003-pure-rust-audio-and-theme-engines.md) & [crates/z-shell-theme/src/palette.rs](crates/z-shell-theme/src/palette.rs)
13. **[z-shell-SCOPE]** Internal Product Scope & Domain Glossary — [SCOPE.md](SCOPE.md) & [GLOSSARY.md](GLOSSARY.md)
