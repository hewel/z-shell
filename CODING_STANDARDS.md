# Coding Standards (Judgement-Call Review Rules)

Read during code review. Mechanical checks live in `tools/oxlint-design-plugin.mjs`, `tsconfig*.json`, `apps/shell/tests/design-preview.test.ts`, and `cargo clippy` — do not duplicate them here.

## UI Semantics & Surface Architecture

- **Truthful icon-to-action semantics**: Every Material Icon must accurately represent the command wired to its `onClick` handler. Never display a glyph whose canonical meaning differs from the action (for example, rendering `shuffle`/`repeat` icons on ±10s seek buttons).
- **Retire unreachable UI paths on migration**: When a flow moves to a new surface (such as moving inline settings/wallpaper subpages into `SettingsWindow`), delete the superseded subpage components and duplicate constants in the same change.
- **Compositor-owned toplevel chrome (`prefer-no-csd`)**: `WindowSurface` (`xdg_toplevel`) windows must fill their frame opaquely and delegate outer corner clipping, window border, and shadow to the Wayland compositor. Never stack client-side outer corners or drop shadows onto an `xdg_toplevel`.
- **Single-source popover and surface chrome**: Share geometry and frame chrome helpers (such as `resolvePopoverGeometry` / `POPOVER_FRAME_STYLE`) across shell panels and plugin panels instead of copying placement tables.

## Motion Craft & Material Judgement

Review against [docs/design/motion.md §5.9](docs/design/motion.md#59-motion-craft--continuity-contracts-anti-stiffness-standards) and [DESIGN.md](DESIGN.md#elevation-vocabulary) when editing animated surfaces or frosted-glass layers (mechanical guards like `zshell/scoped-dismiss-instant`, `zshell/no-hover-hit-target-shift`, and `zshell/no-unblurred-translucent-surface` are enforced by `oxlint`):

- **Four-Tier Frosted Glass vs. Solid Material Hierarchy**: When compositor backdrop blur (`ext_background_effect_v1` / compositor `layer-rule`) is enabled, keep translucency strictly graded by surface density—Dock Tier C (`40–42%`) glassier than Floating Bar (`52–62%`), glassier than Transient Popover Velvet Frost Tier B (`78%`), while Docked Bars and Settings Window remain `100%` solid M3.
- **Clip-Height Spring Expansion & Exit Retention**: Inline expandable sections (`PowerMenuRow`, Wi-Fi password prompts, AI Usage accordions) must animate outer clip height (`0 ↔ measuredHeight` via `fast.spatial`, `overflow: hidden`) with `createPresence` exit retention, subtle inner glide + delayed opacity, and `0° ↔ 180°` chevron rotation—never bare `<Show>` frame-0 height jumps or instant collapse on close.
- **Dual-Layer Overlapping Shared Axis X & Shell/Content Micro-Parallax**: Parent ↔ sub-panel drill-down (`01 · Main ↔ sub-panels`) must briefly retain the outgoing view while interpolating container height rather than unmounting on frame 0; popovers and modals should separate outer shell unfold from `~20–30ms` delayed inner content settle.
- **Continuous Sliding Indicators, FLIP Reflow & Micro-Tactile Feel**: Mutually exclusive selection tracks (`Workspaces`, `M3SegmentedControl`, `SettingsWindow` sidebar, `Launcher` / `Clipboard` keyboard selection) must use a velocity-preserving `fast.spatial` sliding indicator; dynamic lists/bars (`NotificationToasts`, `DockSurface` width) should reflow via FLIP/spring interpolation. Small spatial indicators may tune standard damping to `ζ ≈ 0.82–0.85` (keeping all `*.effects` strictly `ζ = 1.0`), with press compression and active icon pulse applied strictly to inner visual children.

## Tests & Fixtures

- **Relative virtual time in preview scenarios**: Derive command reply `atMs` values from a cumulative timeline (`createVirtualTimeline`) rather than hand-computed absolute millisecond constants that break whenever an earlier `clock.advance` step changes.
- **Cross-host test portability**: Never gate direct-runnable tests on optional host wrappers (`nix-shell`); use the wrapper when present and fall back to direct execution.
- **No fabricated state in UI chrome**: Badges, subtitles, and status rows must reflect real daemon/plugin snapshots (never hardcoded compositor names, fake uptimes, or stubbed hardware toggles).
