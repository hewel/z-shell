# UI Runtime, `zgui-js`, and Local Verification

Reference for agents working on `apps/shell/`, `plugins/*/src/`, or `tools/oxlint-design-plugin.mjs`.

## Sibling `zgui-js` Repository

- Local path: `../zgui-js` (linked via `package.json` `link:../zgui-js/packages/*`).
- Native host binaries:
  - Release (preferred for live testing): `../zgui-js/target/release/native-host`
  - Debug (used by headless preview tests): `../zgui-js/target/debug/native-host`
- Key upstream locations when diagnosing rendering/style issues:
  - UA stylesheet (`:focus-visible` ring): `../zgui-js/vendor/zgui-style/src/sheets/ua.rs`
  - Outline/clip/vector paint lowering: `../zgui-js/vendor/zgui-paint/src/lower/`
  - CLI flags & `--pure-shell` / `msg`: `../zgui-js/crates/native-host/src/main.rs`
- Control CLI syntax: `native-host msg --app-id dev.zshell.shell <command>` (e.g., `ping`, `status`, `settings appearance`, `panel launcher`, `power poweroff`).

## Fast Local Build & Visual Inspection

- Rebuild shell bundle without running tests (~4s, auto-reloads `--watch`): `bun run build:shell`
- Launch local Wayland session (prefers `--release` binaries, cleans stale control socket): `bun run dev:local`
- Keep headless preview PNG captures for visual self-inspection via `read_file`:
  ```bash
  PREVIEW_OUT_DIR=/tmp/z-shell-preview bun test apps/shell/tests/design-preview.test.ts
  ```
  Inspect `$PREVIEW_OUT_DIR/<prefix>/out/captures/surfaces/<surface>/<id>.png` before handing off visual UI changes.

## Wayland Surface Chrome Rules

- **`WindowSurface` (`xdg_toplevel`, e.g. `SettingsWindow`)**: Follow `prefer-no-csd` — render opaque edge-to-edge without client-side outer `borderRadius`, outer `border`, or root `boxShadow`. The Wayland compositor owns window corners, border, and drop shadow.
- **`PopupSurface` (`ShellPanels`, `PluginHost`)**: Transparent rounded surface (`borderRadius: 22px`). Never put CSS `boxShadow` on the flush `100%`-width root container (it bleeds into the 4 square corner cutouts). Never use `maxHeight: "100vh"` inside an auto-height (`height="auto"`) `PopupSurface` — once the surface shrinks (e.g., navigating to a shorter subpage), `100vh` clamps to that smaller viewport and prevents the popup from growing back; use explicit pixel `PANEL_MAX_HEIGHTS` instead.
- **`LayerSurface` with drop shadows (`StatusBar`, `DockSurface`, `OsdOverlay`, `NotificationToasts`)**: Expand the transparent buffer with explicit `shadowBleed` padding so shadows fade to `alpha <= 8` at surface edges, while keeping `exclusiveZone`, `resolveBarPopupAnchor`, and click-through `inputRegion` strictly on the visual island bounds.

## 4-Layer Design Lint Architecture

1. **Static AST (`oxlint`)**: `tools/oxlint-design-plugin.mjs` + `.oxlintrc.json` + unit tests in `apps/shell/tests/design-lint.test.ts`.
2. **Token & Geometry Sync**: `apps/shell/tests/design-lint.test.ts` (`DESIGN.md` ↔ `app.css` ↔ `theme.ts` ↔ `shapes.ts` ↔ `topics.ts`).
3. **Rust WCAG 2.2 Contrast**: `crates/z-shell-theme/tests/`.
4. **Headless Preview Pixel & Geometry Guards**: `apps/shell/tests/design-preview.test.ts` (hit targets, bar anti-collision, shadow clipping, popup corner transparency, opaque toplevel edges, dock vertical centering, hover hit-target stability, `scrollMetrics.overflowY`).
