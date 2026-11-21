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

## Runtime & Test Gotchas

- **Stale Rust binaries**: `packages/composer/tests/first-party-plugins.test.ts` spawns `target/debug/z-shell` and `target/debug/z-shelld`. After editing Rust crates (`crates/*`), run `cargo build --bins` before targeted `bun test` runs.
- **Plugin UI Bus subscriptions**: `first-party-plugins.test.ts` asserts a strict sequential list of `topic.subscribe` frames (`plugin.*` only). Plugin UIs must read shared motion state via `useGlobalMotionScheme()` from `@z-shell/sdk/zgui` rather than opening extra `settings` or `theme` subscriptions.
- **QuickJS & `@hewel/zgui` typing**: `tsconfig.quickjs.json` omits global `performance` (guard via `globalThis` + `Date.now()` fallback); `Button` has no `role` prop; host reduced-motion lives on `globalThis.__zgui.getReducedMotion` (use `isHostReducedMotion()` from `@z-shell/sdk/zgui`); Bun unit tests have no global `requestAnimationFrame`.
- **Solid 2 `<Show keyed>`**: Keyed `<Show>` render callbacks must accept a parameter (`_key => ...`) to remount on truthy-to-truthy key changes, and read non-key retained state inside `untrack(...)` so programmatic exit transitions never remount child surfaces.
- **Fast UI feedback loop**: Use `bun run test:ui` during UI iteration (~25s); reserve `bun run check` for the final pre-commit gate.
