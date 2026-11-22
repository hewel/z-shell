# Component Primitives Specification: z-shell (Material Design 3 Desktop)

> **Conformance Goal**: Align every interactive control in `z-shell` (`apps/shell/` and first-party `plugins/`) with **Material Design 3 Components** [[M3-Components]](#references) and verified **Material Web v0.192** component tokens [[M3-Web]](#references), paired with selective **M3 Expressive** upgrades (vertical-handle sliders) and desktop pointer/keyboard density. Visual reference artboards live on the Paper canvas page **M3 Components — Desktop Spec** [[z-shell-Paper-Components]](#references).

---

## 1. Global Interaction States, State Layers & Focus Ring

All interactive controls share one state-layer opacity ladder sourced directly from `material-components/material-web` (`tokens/versions/v0_192/_md-sys-state.scss`) [[M3-Web]](#references):

| State | Overlay / Opacity Token | Value | Color Source | Motion Token |
|---|---|---:|---|---|
| **Hover** | `md.sys.state.hover.state-layer-opacity` | `0.08` (`8%`) | Control foreground (`on-surface`, `primary`, `on-primary`, `on-primary-container`, `on-secondary-container`) | `fast.effects` (`100ms`) |
| **Focus** | `md.sys.state.focus.state-layer-opacity` | `0.12` (`12%`) | Same as foreground + Focus Ring | `fast.effects` (`100ms`) |
| **Pressed** | `md.sys.state.pressed.state-layer-opacity` | `0.12` (`12%`) | Same as foreground | `fast.effects` (`100ms`) |
| **Dragged** | `md.sys.state.dragged.state-layer-opacity` | `0.16` (`16%`) | Same as foreground (slider drag, workspace window drag) | `fast.effects` |
| **Disabled (Ink)** | `disabled-label-text-opacity` / `disabled-icon-opacity` | `0.38` (`38%`) | `on-surface` | None (static) |
| **Disabled (Container / Outline)** | `disabled-container-opacity` / `disabled-outline-opacity` | `0.12` (`12%`) | `on-surface` | None (static) |

### Universal Pointer Affordance & Tactile Activation Contract
- **Pointer Cursor Everywhere**: Every enabled interactive surface (`<Button>`, `M3Button`, `M3IconButton`, `M3Switch`, `M3FilterChip`, `M3SegmentedControl` options, bar islands, dock tiles, list rows, clickable cards, sliders) MUST declare `cursor: pointer` (`cursor: default` when `:disabled`) so pointer entry immediately signals interactivity on Wayland.
- **Universal Visible Hover**: Every interactive element—including bare `<Button>` triggers in `StatusBar`, `QuickSettingsPanel`, `ClipboardPanel`, `SettingsWindow`, `OverviewOverlay`, and dialogs—MUST expose a clear hover visual change (`≥ 8%` foreground state layer, subtle container step, or border brighten via `short2`/`short3`, never blocked by an opaque inline `style={{ backgroundColor }}` that suppresses CSS `:hover`).
- **Perceptible Activation Animation (Press & Toggle)**: A bare `8% → 12%` background shift is imperceptible in dark mode. Every button, tile, chip, and bar trigger MUST pair pressed state-layer tinting with **inner-visual press compression** (`scale(0.95–0.96)` on buttons/icon buttons/chips, `scale(0.975)` on wide Quick Tiles/cards, strictly on an inner visual wrapper so hit targets never shift per `zshell/no-hover-hit-target-shift`), plus a spring **icon pop (`scale 0.86 → 1.0`, `fast.spatial`)** and smooth fill/border crossfade when toggling selected/active state.

### Focus Indicator Contract
- **Desktop Focus Ring**: `outline: 2px solid var(--color-primary); outline-offset: 2px` (`--zgui-ring: var(--color-primary)`), active on `:focus-visible` (WCAG 2.2 SC 2.4.7 / 2.4.13).
- **Composite Inputs**: Inputs embedded inside a styled shell (search bars, password pills, rule editor fields) delegate focus styling to the outer wrapper (`:focus-within` with `2px solid var(--color-primary)`) rather than drawing a clipped inner box.
- **Never animate `outline-width`**; transition ring opacity smoothly via `fast.effects`.

---

## 2. Desktop M3 Component Primitives

Every primitive below specifies desktop geometry, exact M3 color role pairings, disabled behavior, and motion binding (see [docs/design/motion.md](motion.md) for spring constants).

### 2.1 Buttons (`C2`)

Desktop standard height is **`34px`** with **`10px` (`--radius-md`)** radius; compact utility height is **`28px`** with **`8px` (`--radius-sm`)** radius. Buttons do **not** morph corner radius on press (zero pill-to-square jitter on fast pointer clicks); state feedback uses `fast.effects` state layers (`+8%` hover, `+12%` focus/press). Leading icon size: `16px`. (`999px` pill radius is reserved for Switches, Badges/Count Pills, Active Workspace Capsules, and Status Pills.)

| Variant | Container Role | Label & Icon Role | Border / Hairline | Disabled Container / Ink | Primary Usage in `z-shell` |
|---|---|---|---|---|---|
| **Filled** | `primary` | `on-primary` | None | `on-surface @ 12%` / `on-surface @ 38%` | Single highest-priority CTA per surface (`Apply`, `Authenticate`, `Connect`) |
| **Accent Tonal** *(Desktop active)* | `primary-container` | `on-primary-container` | `1px primary @ 30%` optional | `on-surface @ 12%` / `on-surface @ 38%` | Active desktop actions, selected tonal triggers, bar active states |
| **Neutral Tonal** *(Upstream M3 Tonal)* | `secondary-container` | `on-secondary-container` | None | `on-surface @ 12%` / `on-surface @ 38%` | Neutral secondary actions (`Today`, `Reapply all`, notification actions) |
| **Outlined** | `transparent` (or `surface-container-high` for dialog `Cancel`) | `primary` (or `on-surface` neutral utility) | `1px solid outline` / `outline-variant` (`primary` on focus) | `1px on-surface @ 12%` / `on-surface @ 38%` | Secondary cancel/reset actions, safe dialog `Cancel` button |
| **Text** | `transparent` | `primary` | None | `transparent` / `on-surface @ 38%` | Low-emphasis inline links, `Clear unpinned` (or `error` text for inline destructive `Remove`) |
| **Destructive** | `error-container` | `on-error-container` | `1px error @ 35%` | `on-surface @ 12%` / `on-surface @ 38%` | Confirmed session-ending or destructive actions (`Shut down`, `Power off` confirmation) |

> **Calm Active Surface Guardrail**: Never use **Filled** (`primary`) for large containers, toggle tiles, or more than one primary CTA per surface. Use **Accent Tonal** (`primary-container`) for prominent active desktop controls and **Neutral Tonal** (`secondary-container`) for non-accent secondary actions.

### 2.2 Icon Buttons (`C2`)

Desktop standard hit box is **`32×32px`** (compact **`28×28px`**, minimum hit target ≥ `24×24px` per WCAG 2.2 SC 2.5.8) with uniform **`10px` (`--radius-md`)** radius across both unselected and selected states (no circle-to-square morph). Icon optical size: `16px`–`18px` on the `24×24` Material grid.

- **Variants**:
  - `Standard`: transparent rest → `primary @ 14%` container + `primary` icon when selected.
  - `Filled Tonal`: `surface-container-highest` rest → `primary-container` + `1px primary @ 30%` + `on-primary-container` icon when selected.
  - `Filled (Hero)`: `surface-container-highest` rest → `primary` + `on-primary` icon (budgeted to hero controls like Media Play/Pause).
  - `Outlined`: `1px solid outline` rest → `surface-container-highest` + `1.5px solid primary` + `primary` icon when selected (never glaring white `inverse-surface` fills in dark mode).

### 2.3 Split Actions & Quick Control Tiles (`C2`)

- **Quick Control Tile (`01 · Main`)**: `50px` height, `--radius-tile` (`14px`), 2-column grid.
  - **Active**: `primary-container`, `1px solid primary @ 30%`, `on-primary-container` text, `30×30px` icon well (`primary @ 18%`, `primary` or `on-primary-container` icon per lint pairing).
  - **Inactive**: `surface-container-high`, `on-surface` title, `on-surface-variant` subtitle, `30×30px` icon well (`surface-container-highest`).
  - **Split Action Divider**: Split tiles (`Wi-Fi`, `Bluetooth`, `Nosleep`) separate the left toggle region from the right `>` sub-panel trigger with an explicit `1px × 22px` vertical hairline (`on-primary-container @ 22%` when active; `outline-variant @ 55%` when inactive).
- **Split Button (Toolbar / Header)**: Single unified `34px` `10px`-radius container (`primary-container` + `1px primary @ 30%`) divided internally by a `1px × 20px` vertical hairline separating the primary action from the `30px` chevron menu trigger.

### 2.4 Switch (`C3`)

Follows `material-web` `_md-comp-switch.scss` color and state semantics scaled proportionally from mobile `52×32px` to desktop **`44×24px`** (satisfies ≥ `24×24px` hit target):

| State | Track | Border | Handle (Thumb) | Handle Icon |
|---|---|---|---|---|
| **Off (Unselected)** | `44×24px`, `surface-container-highest`, `999px` | `1.5px solid outline` | `14×14px` circle, `outline` (`5px` inset) | None |
| **Off (Hover)** | Same + subtle `+8%` halo centered around thumb | `1.5px solid outline` | `14×14px` circle, `outline` (retains muted tone; halo supplies hover feedback) | None |
| **On (Selected)** | `44×24px`, `primary`, `999px` | None | `18×18px` circle, `on-primary` (`3px` inset) | `11×11px` Material `check`, `on-primary-container` |
| **Pressed (On / Off)** | Same as state + state layer | Same as state | Stretches smoothly to `20×18px` (`fast.spatial`) staying cleanly inside `3px` track inset | Retains check when On |
| **Disabled (Off)** | `surface-container-highest @ 12%` | `1.5px solid on-surface @ 12%` | `14×14px`, `on-surface @ 38%` | None |
| **Disabled (On)** | `on-surface @ 12%` | `1px solid outline-variant @ 50%` | `18×18px`, opaque `surface-container` + `1px outline-variant @ 50%` | `11×11px` `check`, `on-surface @ 38%` |

### 2.5 Slider — M3 Expressive Desktop (`C3`)

`z-shell` adopts the **M3 2024+ / Expressive vertical-handle slider** across all continuous hardware and configuration controls (`01 · Main`, `04 · Sound`, `11 · OSD`, `22B · Bar & Layout`, `22H · Niri Overview`), unifying straight tracks with clear drag affordance:

- **Overall Hit Height**: `24px` interactive lane (`20px` visual handle height).
- **Active Track**: `10px` tall (`8px` in compact rows), `primary`, outer left radius `5px`, inner gap-facing radius `2px`.
- **Handle Gap**: Explicit **`4px` transparent gap** on *both* sides of the handle so the vertical bar reads cleanly without intersecting track caps.
- **Vertical Handle & Drag Feedback**: `4px × 20px` (`border-radius: 2px`), `primary`. On pointer drag, narrows cleanly to **`2.5px × 22px`** (`on-primary-container`, `fast.spatial`) while highlighting the row's leading icon well (`primary-container`) and right-side tabular readout (`primary`, `600` weight). **Do not show a redundant floating value bubble** when a numeric readout is already visible in the row (only unlabeled sliders may show a dark `surface-container-highest` + `outline-variant` readout tooltip on drag).
- **Inactive Track & End Stop Dot**: `10px` tall, `surface-container-highest`, inner gap-facing radius `2px`, outer right radius `5px`, containing a **`4×4px` circular `primary` stop dot** inset `3px` from the trailing edge.
- **Disabled**: Active track & handle `on-surface @ 38%`; inactive track `on-surface @ 12%`.
- **Repeated Row Alignment**: Slider rows use `flex-shrink: 0` fixed slots (`30px` leading icon, flexible track, `32px`–`36px` right-aligned `JetBrains Mono` `tabular-nums` readout, `26px` trailing action or spacer).
- **Expressive Budget Rule**: Hardware and settings sliders are **always straight**; wavy tracks are strictly restricted to `14 · Media Player`.

### 2.6 Progress Indicators (`C3`)

- **Linear Progress**: `4px`–`6px` height, `999px` outer caps, `primary` active bar + `4px` gap + `surface-container-highest` inactive track with `4px` end stop dot (matching M3 Expressive linear progress).
- **Circular Progress**: `18px`–`24px` diameter (`2.5px` stroke, `stroke-linecap: round`), `primary` active arc + `surface-container-highest` track (`AI Usage` bar ring, loading states).
- **Wavy Media Progress (`14 · Media Player` only)**: Sinusoidal active track (`24px/s` horizontal phase travel while `playback_status == "Playing"`; flattens via `default.spatial` amplitude `1.0 → 0.0` when paused or in `reduced` motion scheme) + vertical `4px` scrubber handle + straight inactive track.

### 2.7 Tonal Track Segmented Control (`C4`)

Desktop mutually exclusive selectors (`Light / Auto / Dark`, `Standard / Expressive / Reduced`, `Floating islands / Docked flush`, `Top / Left / Right`, `Built-in Rust HCT / matugen CLI`, `Power Saver / Balanced / Performance`) use a **Tonal Track Segmented Control** rather than M3 Expressive's shape-morphing Connected Button Group:

- **Outer Track**: `34px` height (`32px` compact), `padding: 3px`, `--radius-md` (`10px`), `1px solid outline-variant @ 55%` hairline, recessed backing (`surface-container` inside `surface-container-high` cards, or `surface` inside `surface-container` panels).
- **Sliding Active Indicator**: Full inner height (`26px`–`28px`), concentric `--radius-sm` (`8px`), `primary-container` fill + `1px solid primary @ 30%` hairline, `on-primary-container` semi-bold (`600`) label. Translates smoothly along the track via M3 `fast.spatial` (`k = 1400, ζ = 0.9`) with continuous retargeting and **zero neighbor layout shift**.
- **Unselected Segments**: Transparent container (`on-surface-variant` `500` text), `8%` `on-surface` hover state layer inside `8px` radius. No redundant leading check icon so compact desktop labels stay aligned and uncrowded.

### 2.8 Chips & Badges (`C4`)

- **Filter Chip (`19 · Clipboard`, `22 · Appearance`, `18 · Launcher`)**:
  - Height: **`28px`**, radius: **`8px`** (`--radius-sm`).
  - Unselected: `transparent` container, `1px solid outline` (`flat-unselected-outline-width: 1px`), `on-surface-variant` text + optional tabular count.
  - Selected: `primary-container`, `on-primary-container`, **`border: none`** (`flat-selected-outline-width: 0px` per `material-web` `_md-comp-filter-chip.scss`), leading `14px` `check` icon.
  - Disabled: `on-surface @ 12%` outline/fill, `on-surface @ 38%` text.
- **Input Chip** (identity / filter tags, e.g. `hewel · uid 1000`): `28px` height, `999px` pill, `surface-container-highest` (or `primary-container` when active), leading `14px` icon + label + optional trailing dismiss `close`.
- **Badges & Status Pills**:
  - Small dot badge: `6×6px` circle (`primary` for active plugin/status, `error` for urgent alert).
  - Count pill: `18px` height, `999px` pill, `JetBrains Mono` `tabular-nums` (`10px`–`11px`), `primary-container` / `on-primary-container` (or `error` / `on-error` for unread urgent count).

### 2.9 Lists, Menus & Navigation (`C5`)

- **Desktop List Item (`02 · Wi-Fi`, `03 · Bluetooth`, `04 · Sound`, `18 · Launcher`, `19 · Clipboard`)**:
  - One-line / compact row: `44px`–`48px` height, `--radius-tile` (`14px`) or `--radius-md` (`10px`).
  - Two-line / connected device row: **`52px` min-height**, `--radius-card` (`16px`), `primary-container` + `on-primary-container` when connected/active, `surface-container-high` at rest, `32×32px` leading icon well, trailing safe action (`Disconnect`, never destructive `Remove/Forget` on connected rows).
- **Vertical Menu**: `surface-container`, `1px solid outline-variant @ 55%`, `--radius-card` (`16px`), Level 2 popover shadow, `34px` menu rows (`8px` radius), `1px outline-variant @ 45%` section dividers, right-aligned `JetBrains Mono` shortcut hints.
- **Settings Navigation Rail (`22`–`22H`)**: `216px` fixed width on Level 0 `surface` with `1px outline-variant @ 42%` right hairline; `11px` uppercase section headers (`+0.04em`, `outline`); `34px` nav rows (`10px` radius) with sliding `primary-container` active pill (`fast.spatial`) and `6px` `primary` active-plugin status dots.

### 2.10 Text Fields, Search Bars & Dialogs (`C6`)

- **Outlined / Composite Text Field (`02 · Wi-Fi` Password, `22C · Idle & Sleep` Rule Editor, `23 · Polkit`)**:
  - Height: `36px`–`40px` desktop single-line (`52px` when carrying an inline top caption label inside the container), `--radius-md` (`10px`), `surface-container` or `surface-container-high` backing.
  - States (per `material-web` `_md-comp-outlined-text-field.scss`):
    - Rest: `1px solid outline` (or `outline-variant @ 70%` on recessed dark cards), `on-surface-variant` label.
    - Hover: `1px solid on-surface`.
    - Focused: **`2px solid primary`** on the outer wrapper (`:focus-within`), `primary` label & caret.
    - Error: **`2px solid error`** (or `1.5px`–`2px`), `error` label, trailing `error` icon, and `error` supporting message below.
- **Search Bar (`18 · Launcher`, `19 · Clipboard`)**: `46px` height, concentric **`14px`** (`--radius-tile`, matching `22px` outer modal), `surface-container-high`, leading `18px`–`20px` `search` icon, `14px` input text, trailing `Esc` / `⌘K` mono hint badge, `:focus-within` `2px solid primary`.
- **Compact Dialog (`17 · Power Dialog`, `23 · Polkit Auth Prompt`)**: `360px` width, `surface-container`, `1px solid outline-variant @ 55%`, `--radius-panel` (`22px`), Level 3 modal shadow over dimmed scrim; `46×46px` `14px`-radius header badge (`error-container @ 38%` + `1px error @ 35%` for destructive dialogs; `primary-container` for Polkit), `Title`/`Headline` heading, concise supporting copy, right-aligned `34px` `10px`-radius action buttons (clear **Outlined/Neutral `Cancel`** button + `Filled` or `Destructive` primary CTA).

---

## 3. Documented Desktop Deviations from `material-web` v0.192

Every departure from upstream `material-components/material-web` v0.192 is intentional and bounded:

| Area | Upstream `material-web` v0.192 | `z-shell` Desktop Spec | Rationale |
|---|---|---|---|
| **Slider** | 2023 M3 (`20px` round slider handle, `4px` track) | **M3 2024+ / Expressive** (`4px` vertical handle narrowing to `2.5px` on drag + `4px` gap + `10px` track + stop dot; no duplicate white drag pill on labeled rows) | Matches latest `m3.material.io/components` visual language while avoiding glaring white floating bubbles over rows that already display live tabular readouts. |
| **Buttons, Icon Buttons & Search** | Pill (`999px`) buttons & search; M3 Expressive pressed pill-to-square & circle-to-square morphs; `inverse-surface` selected outlined icon button | Uniform desktop **`10px` (`--radius-md`)** buttons (`34px`) & icon buttons (`32px`), **`14px`** Search Bar, zero shape morph on click, dark `surface-container-highest` + `1.5px primary` selected outlined icon button | Eliminates fast-click radius flicker (~70ms pointer clicks), keeps dark surfaces calm, and aligns every action control with the desktop concentric shape scale. |
| **Segmented Selector** | Bordered segmented button (v0.192) / shape-morphing Connected Button Group (M3 Expressive) | **Tonal Track Segmented Control** (`10px` recessed track + `8px` sliding `primary-container` pill, zero check icon) | Eliminates corner-mismatch triangular gaps between `6px` and `999px` neighbors, preserves clear single-control group bounds on dark surfaces, avoids neighbor hit-target displacement on click, and pairs cleanly with `fast.spatial` sliding indicator motion. |
| **Filled Tonal Button** | Single `secondary-container` / `on-secondary-container` role (`_md-comp-filled-tonal-button.scss`) | Explicit split: **Accent Tonal (`primary-container`)** vs **Neutral Tonal (`secondary-container`)** | Enforces *The Calm Active Surface Rule*—large active desktop controls use `primary-container` instead of glaring solid `primary`, while neutral secondary actions remain `secondary-container`. |
| **Focus Ring** | `3px solid secondary`, `2px` outward offset (`_md-comp-focus-ring.scss`) | **`2px solid primary`**, `outline-offset: 2px` (`--zgui-ring`) | Higher dark-mode legibility across dense `1px`-bordered Wayland surfaces while meeting WCAG 2.2 SC 2.4.13. |
| **Dialog Container** | `surface-container-high` (`level3`, `_md-comp-dialog.scss`) | Unified **`surface-container`** + `1px outline-variant @ 55%` + Level 3 shadow | Matches all `z-shell` popovers and modals so inner `surface-container-high` cards and inputs maintain a consistent +1 tonal step. |
| **Control Sizing & Density** | Mobile touch targets (`40px` buttons, `52×32px` switch, `32px` chips, `56px`–`72px` list items) | Desktop pointer/keyboard targets (`34px` buttons, `44×24px` switch, `28px` chips, `44px`–`52px` list items; all ≥ `24×24px`) | Preserves zero-scroll popovers on `1440×900` without sacrificing WCAG 2.2 SC 2.5.8 target size. |

---

## 4. Shared Implementation Layer (`@z-shell/sdk/primitives`)

Reusable M3 desktop primitives live in [packages/sdk/src/zgui-primitives.tsx](../../packages/sdk/src/zgui-primitives.tsx) and [packages/sdk/src/zgui-primitives.module.css](../../packages/sdk/src/zgui-primitives.module.css) (compiled via `zgui-js` Lightning CSS Modules) and are imported across `apps/shell/` and first-party `plugins/*/src/` via `@z-shell/sdk/primitives` (kept separate from the pure-TS `@z-shell/sdk/zgui` entrypoint):

- **Exported Primitives**: `M3Button`, `M3IconButton`, `M3Switch`, `M3Slider`, `M3SliderRow`, `M3SegmentedControl`, `M3FilterChip`, `M3LinearProgress`, `M3DialogShell`.
- **Headless Behavioral Primitives**: Vertical popups (`apps/shell/src/surfaces/BarPopups.tsx`) pair with upstream `@hewel/zgui/primitives` (`MenuRootPrimitive`, `MenuListPrimitive`, `MenuItemPrimitive`) for roving focus, typeahead, and dismiss cascades.
- **Lint Enforcement**: Hand-rolling duplicate switches or sliders outside `zgui-primitives.tsx` is blocked by L1 `zshell/no-duplicate-primitives`; CSS Module color/focus/hover invariants are enforced by L2 `apps/shell/tests/design-lint.test.ts`; pixel geometry is verified by L4 `apps/shell/tests/design-preview.test.ts` in both Dark and Light modes. See [DESIGN.md](../../DESIGN.md#lint-enforced-contracts).

---

## References

1. **[M3-Components]** Google Material Design 3 — *Components Overview & Expressive Specs*: https://m3.material.io/components
2. **[M3-Web]** Google `material-components/material-web` — *Official M3 Design Tokens (`tokens/versions/v0_192/`)*: https://github.com/material-components/material-web/tree/main/tokens/versions/v0_192
3. **[M3-States]** Google Material Design 3 — *Interaction States & State Layers*: https://m3.material.io/foundations/interaction/states/overview
4. **[z-shell-Paper-Components]** `z-shell` Paper Design Canvas — *M3 Components — Desktop Spec (Dark)* & *M3 Components — Light Mode*: https://app.paper.design/file/01M7J3P8QM6GW1HSHNW0M8TQSV/p-3-0 · https://app.paper.design/file/01M7J3P8QM6GW1HSHNW0M8TQSV/p-4-0
5. **[z-shell-Paper-Light-Showcase]** `z-shell` Paper Design Canvas — *z-shell — Light Mode Showcase*: https://app.paper.design/file/01M7J3P8QM6GW1HSHNW0M8TQSV/p-5-0
6. **[z-shell-DESIGN]** `z-shell` Core Design System Specification — [DESIGN.md](../../DESIGN.md)
7. **[z-shell-Motion]** `z-shell` Motion System Specification — [docs/design/motion.md](motion.md)
