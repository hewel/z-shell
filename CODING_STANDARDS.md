# Coding Standards (Judgement-Call Review Rules)

Read during code review. Mechanical checks live in `tools/oxlint-design-plugin.mjs`, `tsconfig*.json`, `apps/shell/tests/design-preview.test.ts`, and `cargo clippy` — do not duplicate them here.

## UI Semantics & Surface Architecture

- **Truthful icon-to-action semantics**: Every Material Icon must accurately represent the command wired to its `onClick` handler. Never display a glyph whose canonical meaning differs from the action (for example, rendering `shuffle`/`repeat` icons on ±10s seek buttons).
- **Retire unreachable UI paths on migration**: When a flow moves to a new surface (such as moving inline settings/wallpaper subpages into `SettingsWindow`), delete the superseded subpage components and duplicate constants in the same change.
- **Compositor-owned toplevel chrome (`prefer-no-csd`)**: `WindowSurface` (`xdg_toplevel`) windows must fill their frame opaquely and delegate outer corner clipping, window border, and shadow to the Wayland compositor. Never stack client-side outer corners or drop shadows onto an `xdg_toplevel`.
- **Single-source popover and surface chrome**: Share geometry and frame chrome helpers (such as `resolvePopoverGeometry` / `POPOVER_FRAME_STYLE`) across shell panels and plugin panels instead of copying placement tables.

## Tests & Fixtures

- **Relative virtual time in preview scenarios**: Derive command reply `atMs` values from a cumulative timeline (`createVirtualTimeline`) rather than hand-computed absolute millisecond constants that break whenever an earlier `clock.advance` step changes.
- **Cross-host test portability**: Never gate direct-runnable tests on optional host wrappers (`nix-shell`); use the wrapper when present and fall back to direct execution.
- **No fabricated state in UI chrome**: Badges, subtitles, and status rows must reflect real daemon/plugin snapshots (never hardcoded compositor names, fake uptimes, or stubbed hardware toggles).
