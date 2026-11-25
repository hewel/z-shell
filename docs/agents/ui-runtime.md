# UI Runtime, `zgui-js`, and Local Verification

Reference for agents working on `apps/shell/`, `plugins/*/src/`, or `tools/oxlint-design-plugin.mjs`.

## 安装与排查 `zgui-js`

- 在仓库根目录运行 `bun install --frozen-lockfile`。npm 包提供 SDK、构建器和预览字体；`@hewel/zgui-cli` 在 Linux x64 上会安装预编译的 `zgui-host`，无需检出或构建上游仓库。
- 用 `bunx zgui-js doctor --json` 检查平台包、可执行文件和 ABI。默认安装的宿主来源应为 `platform-package`；`bun tools/resolve-zgui-host.ts` 输出开发与预览实际使用的路径。
- 调试上游源码时，设置 `ZGUI_JS_HOST_EXECUTABLE` 指向已构建的宿主，或设置 `ZGUI_ROOT` 指向上游 Cargo 工作区（优先 `target/release`，其次 `target/debug`）。二者都设置时，可执行文件优先。仅在未安装预编译宿主且未设置覆盖项时，才尝试使用相邻 `../zgui-js` 中已构建的宿主。
- 上游排查入口：`vendor/zgui-style/src/sheets/ua.rs`（焦点样式）、`vendor/zgui-paint/src/lower/`（绘制转换）、`crates/zgui-host/src/main.rs`（CLI、`--pure-shell` 和 `msg`）。
- 控制命令：`zgui-host msg --app-id dev.zshell.shell <command>`，例如 `ping`、`status` 或 `settings appearance`。

## Fast Local Build & Visual Inspection

- Rebuild shell bundle without running tests (~4s, auto-reloads `--watch`): `bun run build:shell`
- 启动本地 Wayland 会话（默认使用预编译宿主，并清理残留的控制套接字）：`bun run dev:local`
- Keep headless preview PNG captures for visual self-inspection via `read_file`:
  ```bash
  PREVIEW_OUT_DIR=/tmp/z-shell-preview bun test apps/shell/tests/design-preview.test.ts
  ```
  Inspect `$PREVIEW_OUT_DIR/<prefix>/out/captures/surfaces/<surface>/<id>.png` before handing off visual UI changes.

## Paper ↔ Preview Visual Parity Workflow

Use `docs/design/paper-manifest.json` (which pins `paperFileId`, every Dark/Light Paper `nodeId`, its exported `refFile`, and its `previewRelPath`) together with `bun run design:compare` whenever updating UI chrome, typography, geometry, or elevation:

1. **Export Paper reference screenshots** (when design artboards changed) into `/tmp/z-shell-paper-refs/<refFile>` using the Paper MCP `get_screenshot` / `export` tool and the `nodeId` entries in `docs/design/paper-manifest.json`.
2. **Capture fresh headless previews** via L4 tests:
   ```bash
   PREVIEW_OUT_DIR=/tmp/z-shell-preview bun test apps/shell/tests/design-preview.test.ts
   ```
3. **Generate the side-by-side comparison gallery + PNG contact sheets**:
   ```bash
   bun run design:compare --refs-dir /tmp/z-shell-paper-refs --preview-dir /tmp/z-shell-preview --out-dir /tmp/z-shell-compare
   ```
   (Pass `--run-preview` to invoke `design-preview.test.ts` automatically in one step.)
4. **Visually audit before handing off**: open `/tmp/z-shell-compare/index.html` in a browser for interactive Dark/Light/Checker inspection, and **MANDATORILY** call `read_file` on:
   - `/tmp/z-shell-compare/sheets/sheet-*.png` (paired Paper vs Headless Preview surfaces)
   - `/tmp/z-shell-compare/sheets/states.png` (interactive & chaos states)
   - **`/tmp/z-shell-compare/sheets/hover-atlas.png`** (side-by-side `Rest | Hover` cropped cards with virtual cursor markers — verify concentric full-card `M3InteractiveCard` hover, isolated secondary control hover with zero double-highlight, and `0 px diff` on non-interactive indicators).

## Interactive, Motion & Dirty-Data Automated Guards

Rather than brittle full-screen golden snapshots, interaction and motion regressions are locked down by property invariants across L1, L2, and L4:

- **L1 `zshell/interactive-hover-radius`** (`tools/oxlint-design-plugin.mjs`): requires explicit `borderRadius` on inline-styled `<Button>` / `<control>` elements (exempting CSS Module primitives and specialized `slider` / `progressIndicator` / `switch` / `dock` / `bar-segment` controls) so universal hover layers never paint sharp rectangles.
- **L1 `zshell/no-partial-card-hover`** (`tools/oxlint-design-plugin.mjs`): forbids negative `margin` (`-2px`, `-4px -6px`, `-6px -8px`, negative `marginTop/Right/Bottom/Left`) on `<Button>` / `<control>` elements inside cards, which causes clipped "box-in-box" hover highlights. Use `<M3InteractiveCard>` (stretched sibling hit layer `position: absolute; inset: 0px; border-radius: inherit; z-index: 0` with `pointer-events: none` inherited by card content) + `<M3CardAction>` (`position: relative; z-index: 2; pointer-events: auto` on independent secondary controls like `×`, `M3Switch`, `Pin`, `Forget`, action buttons, and sliders) or `SplitTile` instead.
- **L2 CSS selector exclusions** (`apps/shell/tests/design-lint.test.ts`): asserts `apps/shell/src/app.css` universal `control:hover` / `control:active` exclude `:disabled`, `[role="slider"]`, `[role="progressIndicator"]`, `[role="progressBar"]`, `[data-switch-root="true"]`, `[data-dock-item="true"]`, and `[data-bar-segment]`.
- **L4 hover pixel-diff invariants & Hover Atlas** (`apps/shell/tests/design-preview.test.ts`, using `diffRegionPixels` in `preview-harness.ts`):
  - Non-interactive (`role="progressIndicator"`) and `:disabled` controls must produce `diffPixels === 0` on pointer hover.
  - Interactive controls (`CalendarPanel` notification cards, `ClipboardPanel` rows, `IdlePane` rule rows, `QuickSettings` SplitTiles/sliders, `MediaPanel` sink/Play, `Settings` nav/segmented/wallpaper, `StatusBar` island, `Dock` icons) must produce `diffPixels > 0` on hover, zero diff on outer bounding-box corners (Anti-Sharp-Box), full edge-to-edge card fill on `M3InteractiveCard` body hover, zero card double-highlight when hovering `<M3CardAction>` secondary controls, and identical `boundsLogical` across `rest` / `hover` / `pressed` (rendered together in `sheets/hover-atlas.png`).
- **L4 virtual-time in-flight keyframes**: asserts mid-flight spring frames (`t ≈ 55–60ms`) differ from both `t=0ms` and settled `t=400–450ms` for the `StatusBar` sliding workspace capsule and `IdlePane` `M3SegmentedControl`, plus stable `Launcher` card geometry during search filtering.
- **L4 dirty-data fixtures**: verifies 17+ notifications isolated scroll, empty-label `"default"` actions hidden, `28×28` / `30×30` vertical bar circular pills, Ethernet + disconnected Wi-Fi neutral state, null-avatar fallback visibility, and 16:9 screenshot toast icon `object-fit: cover` rounded clipping (rendered together in `sheets/states.png`).

## Wayland Surface Chrome Rules

- **`WindowSurface` (`xdg_toplevel`, e.g. `SettingsWindow`)**: Follow `prefer-no-csd` — render opaque edge-to-edge without client-side outer `borderRadius`, outer `border`, or root `boxShadow`. The Wayland compositor owns window corners, border, and drop shadow.
- **`PopupSurface` (`ShellPanels`, `PluginHost`, `BarPopups`)**: Transparent rounded surface (`borderRadius: 22px` for panels, `16px` for menus) with outer drop shadow bleed via `geometryInsets={POPOVER_SHADOW_INSETS}` (`{ top: 20, right: 28, bottom: 38, left: 28 }`), matching `POPOVER_BLEED_STYLE` padding, `boxShadow: "var(--shadow-level-2)"`, and `inputRegion={[cardNode]}` / rounded `blurRegion` bound strictly to the inner visual card so clicks pass through and blur never leaks into the shadow gutter. Never put CSS `boxShadow` on a flush `PopupSurface` without `geometryInsets`. Never use `maxHeight: "100vh"` inside an auto-height (`height="auto"`) `PopupSurface` — once the surface shrinks (e.g., navigating to a shorter subpage), `100vh` clamps to that smaller viewport and prevents the popup from growing back; use explicit pixel `PANEL_MAX_HEIGHTS` instead.
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
- UI 迭代时运行 `bun run test:ui`；无头预览在软件渲染下可能耗时更长。提交前运行完整的 `bun run check`。
