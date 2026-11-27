# Motion System Specification: z-shell (Material Design 3)

> **Conformance Goal**: Faithfully replicate the **Material Design 3 Motion System**—both the modern **M3 Expressive Spring Physics engine** (`md.sys.motion.spring.*`) [[M3-Motion-Physics]](#references) and the **M3 Easing & Duration token ladder** (`md.sys.motion.easing.*`, `md.sys.motion.duration.*`) [[M3-Motion-Easing]](#references)—on `zgui-js` (Solid 2.0 TSX + Lightning CSS Modules on QuickJS) for high-refresh Linux Wayland desktops (`60Hz`–`240Hz`).

Static Paper artboards capture layout, tonal hierarchy, and resting/active states, but cannot express velocity, spring retargeting, or choreography. This document is the authoritative engineering specification for implementing M3 motion across every `z-shell` surface.

---

## 1. Dual-Layer Architecture & Motion Schemes

Material Design 3 replaces fixed-duration easing with **real spring physics** as the primary motion primitive, while retaining easing/duration tokens for deterministic non-spring effects and CSS-only transitions [[M3-Motion-Overview]](#references) [[M3-Motion-Physics]](#references).

### Core Principles
1. **Physics First, Interruption Always**: Every spatial transition (position, scale, height, width, rotation, shape morph) is driven by a continuous spring solver carrying live `(position, velocity)` state. If the user clicks another island, hammers volume keys, switches workspaces `1 → 2 → 3`, or dismisses a popover mid-flight, the spring **retargets smoothly from its current velocity**—never snapping or restarting from zero.
2. **Spatial vs. Effects Separation**:
   - **Spatial springs** (`*.spatial`) animate geometry (`translate`, `scale`, `rotate`, `width`, `height`, `border-radius`, SVG morphs) and allow controlled overshoot.
   - **Effects springs** (`*.effects`) animate visual attributes (`opacity`, `color`, `background-color`, `border-color`, `box-shadow`) and are **critically damped ($\zeta = 1.0$)** so opacity and color **never bounce or overshoot**.
3. **Zero Idle CPU**: Every animation loop (`requestAnimationFrame` / Wayland frame callback) must terminate immediately once all active springs reach their settling threshold. Persistent bars never run idle tick animations (see *The No-1Hz-Flicker Rule* in [DESIGN.md](../../DESIGN.md)).

### Product Motion Schemes
`z-shell` implements all three M3-aligned schemes (configurable via `settings.toml`, e.g., `[theme].motion_scheme`):

| Scheme | Default Role in `z-shell` | Spatial Feel | Effects Feel |
|---|---|---|---|
| **`standard`** *(Default)* | Everyday desktop productivity | Crisp, high damping ($\zeta = 0.9$), virtually no bounce | Critically damped ($\zeta = 1.0$) |
| **`expressive`** | Opt-in M3 Expressive desktop mode & scoped hero moments | Lively, lower damping ($\zeta = 0.6$–$0.8$), tactile overshoot | Critically damped ($\zeta = 1.0$) |
| **`reduced`** | Accessibility (`WCAG 2.2 SC 2.3.3`) | Spatial displacement disabled; replaced by fast opacity fade | Critically damped (`fast.effects`, $\le 120\text{ms}$) |

> **Scoped Expressive Override**: Per Material Design 3's motion-scheme guidance [[M3-Motion-Physics]](#references), even when the global scheme is `standard`, specific hero focal moments—`21 · Lock Screen` password shape morphing and error shake—explicitly bind to `expressive` spatial tokens.

---

## 2. Official Material Design 3 Spring Physics Tokens

All M3 spring tokens assume unit mass $m = 1.0$ and are parameterized by **stiffness** ($k$) and **damping ratio** ($\zeta$) [[M3-Motion-Specs]](#references).

### 2.1 Standard Motion Scheme (Default)

| M3 Token | CSS / TS Key | Stiffness ($k$) | Damping Ratio ($\zeta$) | Approx. Settle (`1%`) | Primary Usage in `z-shell` |
|---|---|---:|---:|---:|---|
| `md.sys.motion.spring.fast.spatial` | `spring.standard.fastSpatial` | `1400` | `0.9` | ~`170ms` | Switches, workspace pill morph, chevron rotation, tooltip/OSD, container expand |
| `md.sys.motion.spring.default.spatial` | `spring.standard.defaultSpatial` | `700` | `0.9` | ~`240ms` | Bar popovers, Shared Axis X sub-panels, centered modals, notification stack reflow, dock slide |
| `md.sys.motion.spring.slow.spatial` | `spring.standard.slowSpatial` | `300` | `0.9` | ~`370ms` | Large viewport transitions (`20 · Workspace Overview`, `21 · Lock Screen` entrance) |
| `md.sys.motion.spring.fast.effects` | `spring.standard.fastEffects` | `3800` | `1.0` | ~`110ms` | Hover/press state layers, focus ring fade, toggle fill color, popover exit opacity |
| `md.sys.motion.spring.default.effects` | `spring.standard.defaultEffects` | `1600` | `1.0` | ~`170ms` | Popover/modal scrim opacity, Settings tab crossfade, active row tinting |
| `md.sys.motion.spring.slow.effects` | `spring.standard.slowEffects` | `800` | `1.0` | ~`240ms` | Lock Screen unlock fade, wallpaper crossfade, theme palette commit transition |

### 2.2 Expressive Motion Scheme

| M3 Token | CSS / TS Key | Stiffness ($k$) | Damping Ratio ($\zeta$) | Approx. Settle (`1%`) | Primary Usage in `z-shell` |
|---|---|---:|---:|---:|---|
| `md.sys.motion.spring.fast.spatial` | `spring.expressive.fastSpatial` | `800` | `0.6` | ~`340ms` | Lock Screen password shape pop/morph, error shake, expressive switch/chip bounce |
| `md.sys.motion.spring.default.spatial` | `spring.expressive.defaultSpatial` | `380` | `0.8` | ~`380ms` | Popovers, sub-panels, modals, dock & toast bounce in Expressive mode |
| `md.sys.motion.spring.slow.spatial` | `spring.expressive.slowSpatial` | `200` | `0.8` | ~`530ms` | Fullscreen overview / lock screen hero transitions in Expressive mode |
| `md.sys.motion.spring.fast.effects` | `spring.expressive.fastEffects` | `3800` | `1.0` | ~`110ms` | Identical to Standard (effects never bounce) |
| `md.sys.motion.spring.default.effects` | `spring.expressive.defaultEffects` | `1600` | `1.0` | ~`170ms` | Identical to Standard (effects never bounce) |
| `md.sys.motion.spring.slow.effects` | `spring.expressive.slowEffects` | `800` | `1.0` | ~`240ms` | Identical to Standard (effects never bounce) |

---

## 3. Official Material Design 3 Easing & Duration Tokens

Used for Lightning CSS Modules / CSS transitions where a JS spring loop is unnecessary (such as simple hover state layers, static timed crossfades, and idle pre-action screen dim) [[M3-Motion-Easing]](#references).

### 3.1 Easing Tokens

| M3 Token | CSS Value | Usage Rule |
|---|---|---|
| `md.sys.motion.easing.emphasized` | Two-segment path `M 0,0 C 0.05,0 0.133333,0.06 0.166666,0.4 C 0.208333,0.82 0.25,1 1,1` (use `linear(...)` below or spring) | Elements that begin and end on screen |
| `md.sys.motion.easing.emphasized-decelerate` | `cubic-bezier(0.05, 0.7, 0.1, 1.0)` | Elements entering the viewport |
| `md.sys.motion.easing.emphasized-accelerate` | `cubic-bezier(0.3, 0.0, 0.8, 0.15)` | Elements exiting the viewport permanently |
| `md.sys.motion.easing.standard` | `cubic-bezier(0.2, 0.0, 0.0, 1.0)` | Utilitarian on-screen state/layout shifts |
| `md.sys.motion.easing.standard-decelerate` | `cubic-bezier(0.0, 0.0, 0.0, 1.0)` | Utilitarian entrances and opacity fade-ins |
| `md.sys.motion.easing.standard-accelerate` | `cubic-bezier(0.3, 0.0, 1.0, 1.0)` | Utilitarian exits and opacity fade-outs |
| `md.sys.motion.easing.linear` | `cubic-bezier(0.0, 0.0, 1.0, 1.0)` | Continuous playback waves, `idle.pre_action_fade_seconds` dim |

Exact CSS `linear()` representation of M3 `emphasized` (`FastOutExtraSlowIn`) for CSS stylesheets that support CSS Easing Level 2 [[M3-Motion-Easing]](#references):

```css
--motion-easing-emphasized: linear(
  0, 0.002, 0.01 3.6%, 0.034, 0.074 9.1%, 0.128 11.4%, 0.194 13.4%, 0.271 15%,
  0.344 16.1%, 0.544, 0.66 20.6%, 0.717 22.4%, 0.765 24.6%, 0.808 27.3%,
  0.845 30.4%, 0.883 35.1%, 0.916 40.6%, 0.942 47.2%, 0.963 55%, 0.979 64%,
  0.991 74.4%, 0.998 86.4%, 1
);
```

### 3.2 Duration Tokens

| Tier | Token | Value | Typical Desktop Role |
|---|---|---:|---|
| **Short** | `short1` / `short2` / `short3` / `short4` | `50ms` / `100ms` / `150ms` / `200ms` | State layers (`short2`), icon/color shifts (`short3`), fast exits (`short3`–`short4`) |
| **Medium** | `medium1` / `medium2` / `medium3` / `medium4` | `250ms` / `300ms` / `350ms` / `400ms` | Popover entrances (`medium1`), sub-panel Shared Axis (`medium2`), modals (`medium2`–`medium3`) |
| **Long** | `long1` / `long2` / `long3` / `long4` | `450ms` / `500ms` / `550ms` / `600ms` | Workspace Overview, Lock Screen unlock, wallpaper crossfade |
| **Extra Long** | `extra-long1` .. `extra-long4` | `700ms` / `800ms` / `900ms` / `1000ms` | Ambient slow transitions only (never block input) |

---

## 4. Analytical Spring Solver for `zgui-js` (QuickJS + Solid 2.0)

### Why Closed-Form Analytical Solving Is Mandatory
High-stiffness M3 Effects springs ($k = 3800, \zeta = 1.0$) become numerically unstable under naive fixed-step Euler integration at `60Hz` ($\Delta t \approx 16.67\text{ms}$). `z-shell` must evaluate the **exact closed-form solution** of the damped harmonic oscillator ($m = 1$) at elapsed time $t \ge 0$ from initial displacement $x_0 = x_{\text{start}} - x_{\text{target}}$ and initial velocity $v_0$:

$$\omega_0 = \sqrt{k}$$

- **Underdamped ($\zeta < 1$, Spatial springs)** with $\omega_d = \omega_0 \sqrt{1 - \zeta^2}$:
  $$x(t) = x_{\text{target}} + e^{-\zeta\omega_0 t}\left(x_0 \cos(\omega_d t) + \frac{v_0 + \zeta\omega_0 x_0}{\omega_d}\sin(\omega_d t)\right)$$
  $$v(t) = e^{-\zeta\omega_0 t}\left(v_0 \cos(\omega_d t) - \frac{\zeta\omega_0 v_0 + \omega_0^2 x_0}{\omega_d}\sin(\omega_d t)\right)$$

- **Critically damped ($\zeta = 1$, Effects springs)**:
  $$x(t) = x_{\text{target}} + e^{-\omega_0 t}\left(x_0 + (v_0 + \omega_0 x_0) t\right)$$
  $$v(t) = e^{-\omega_0 t}\left(v_0 - \omega_0(v_0 + \omega_0 x_0) t\right)$$

### Implementation & Shared Scheduler (`packages/sdk/src/motion.ts` → `@z-shell/sdk/zgui`)
The authoritative closed-form solver (`sampleSpring`), M3 token tables (`M3_SPRINGS`, `M3_EASINGS`, `M3_DURATIONS`), single global frame scheduler (`registerFrameTicker`), and Solid 2.0 primitives (`createM3Spring`, `createPresence`, `createPhaseLoop`) live in [packages/sdk/src/motion.ts](../../packages/sdk/src/motion.ts) and [packages/sdk/src/zgui-motion.ts](../../packages/sdk/src/zgui-motion.ts), shared by both `apps/shell` and first-party plugins so every surface runs on **one frame loop** that cancels automatically when `activeMotionTickerCount() === 0`.

### Unit-Specific Settling Thresholds (`SPRING_EPSILON`)
| Property Type | `epsilon` | Rationale |
|---|---|---|
| Translation / Width / Height (`px`) | `0.1` | Sub-pixel invisible at 1× and 2× HiDPI |
| Scale / Opacity (unitless `0..1`) | `0.001` | Smooth ending without premature pop |
| Rotation (`deg`) | `0.05` | Crisp stop on chevrons and lock-screen shapes |

---

## 5. Complete Surface-by-Surface Choreography Map

Every surface designed in Paper and documented in [DESIGN.md](../../DESIGN.md) binds to an explicit M3 transition pattern [[M3-Transitions]](#references):

### 5.1 Edge Bars & Persistent Indicators (`09`, `09B`, `09C`, `09D`)

| Interaction | Pattern | Spatial Token | Effects Token | Exact Geometry / Behavior |
|---|---|---|---|---|
| **Active workspace capsule** (`1 ↔ 2 ↔ 3`) | Shared-bounds morph | `fast.spatial` | `fast.effects` | Pill slides & morphs width (`8px` dot ↔ `24px` numbered capsule) along bar axis; rapid workspace switching retargets continuously. |
| **Bar island active highlight** | State & border tint | — | `fast.effects` | Background steps `surface-container → surface-container-high` (or `primary-container` in docked mode) with `primary` border fade. |
| **Unread notification pill** (`🔔 2`) | Count pop & reveal | `fast.spatial` | `fast.effects` | Appears from `scale(0.85) → 1.0` when count `0 → ≥1`; numeral crossfades on increment. |
| **AI usage circular ring** | Radial sweep | `default.spatial` | — | SVG `stroke-dashoffset` springs smoothly on quota poll updates. |
| **Media island waveform (`bar-media`)** | State morph | `default.spatial` | `fast.effects` | One-shot transition between expanded `mediaEq` (`primary`) when audible and quiet stubs (`on-surface-variant`) when paused or muted (`0%` steady-state CPU). |
| **Bar mode switch** (Floating ↔ Docked) | Layout shift | `default.spatial` | `default.effects` | Bar height (`46px ↔ 38px`), corner radii (`16px ↔ 0px`), and outer margin (`14px ↔ 0px`) morph cleanly without flashing. |

### 5.2 Anchored Bar Popovers (`01 · Main`, `13 · Calendar`, `14 · Media Player`, `15 · Nosleep`, `16 · AI Usage`)

- **Enter**:
  - `transform-origin`:
    - Top Bar (`09` / `09C`): `top right` (Control Center), `top center` (Calendar), or `top <triggerX>` (Nosleep / AI Usage / Media).
    - Left Vertical Bar (`09B` / `09D`): `bottom left` (Control Center & sub-panels), `center left` (Calendar), `bottom left` (plugin popovers).
  - Spatial (`default.spatial`): `scale(0.94 → 1.0)` + directional slide (`translateY(-8px → 0)` from Top Bar; `translateX(-8px → 0)` from Left Bar).
  - Effects (`fast.effects`): `opacity(0 → 1)`.
- **Exit**:
  - Faster and calmer than entry (per M3 exit asymmetry [[M3-Motion-Easing]](#references)): `scale(1.0 → 0.96)` + `translate(-4px)` with `fast.spatial` (or `emphasized-accelerate` `150ms`) + `opacity(1 → 0)` with `fast.effects`.
- **Adjacent Island Handoff** (e.g., Calendar open → click Control Center):
  - Dismiss outgoing popover with `fast.effects` (`opacity 1 → 0` in ~`100ms`) while immediately starting incoming popover's `default.spatial` enter so pointer-to-popover latency feels instantaneous.

### 5.3 Control Center Sub-Panels (`01 · Main` ↔ `02 · Wi-Fi`, `03 · Bluetooth`, `04 · Sound`, `04B · Battery & Power`)

Uses GPU-friendly **M3 Shared Axis X** while keeping Wayland `PopupSurface height="auto"` (avoiding per-frame `xdg_popup` buffer reallocations) [[M3-Transitions]](#references):
- **Forward drill-down** (`01 · Main` → sub-panel):
  - Incoming view: `translateX(+24px → 0)` (`default.spatial`), `opacity(0 → 1)` ramped over the latter `70%` (`fast.effects`).
- **Back navigation** (sub-panel → `01 · Main`):
  - Exact mirror: incoming `-24px → 0` (`default.spatial`) with `opacity(0 → 1)` ramp.
- **Inline Container Expansions** (`01 · Main` Power Menu bar, `02 · Wi-Fi` Password Prompt row, `16 · AI Usage` provider accordions):
  - Scale/opacity reveal + chevron `rotate(0deg → 180deg)` via `fast.spatial` and `fast.effects`.

### 5.4 Settings Window (`22 · Appearance` through `22H · Niri Overview`)

Uses **M3 Fade Through** + **Sliding Sidebar Indicator** [[M3-Transitions]](#references):
- **Window Open / Close**: Centered modal enter (`scale 0.96 → 1.0`, `translateY 10px → 0` via `default.spatial`, scrim `0 → 1` via `default.effects`).
- **Sidebar Tab Switch** (`Appearance` ↔ `Bar & layout` ↔ `Idle & sleep` ↔ `Power & battery` ↔ `Plugins` ↔ `AI usage` ↔ `Theme bridges` ↔ `Niri overview`):
  - Active `primary-container` indicator pill slides vertically between nav rows using `fast.spatial` (continuous retargeting if the user presses `↑`/`↓` quickly!).
  - Right content pane (`604px`) uses **M3 Fade Through**: outgoing pane fades `opacity(1 → 0)` in `short2` (`100ms`, `standard-accelerate`), incoming pane enters with `opacity(0 → 1)` (`default.effects`) + subtle `translateY(6px → 0)` (`fast.spatial`). Never slide horizontally between unrelated sidebar tabs—horizontal motion is reserved strictly for parent-child Shared Axis navigation.
- **Inline Rule Selection** (`22C · Idle & Sleep` selecting a rule to load into the Rule Editor):
  - Selected row tint (`fast.effects`) + editor fields quick crossfade (`short2` `100ms`).

### 5.5 Centered Modals & Dialogs (`17 · Power Dialog`, `18 · Launcher`, `19 · Clipboard`, `20 · Workspace Overview`, `23 · Polkit Auth Prompt`)

| Surface | Enter Motion | Exit Motion | Internal Motion |
|---|---|---|---|
| **`18 · Launcher`** & **`19 · Clipboard`** | Scrim `default.effects`; card `scale(0.95 → 1.0)` + `translateY(10px → 0)` (`default.spatial`) | `scale(1.0 → 0.97)` + `opacity(1 → 0)` (`fast.effects`, ~`120ms`) | Keyboard selection highlight slides/snaps via `fast.spatial`; filter chips (`All / Pinned / Text / Images`) morph active fill via `fast.effects`. |
| **`17 · Power Dialog`** & **`23 · Polkit Auth Prompt`** | Scrim `default.effects`; dialog `scale(0.92 → 1.0)` (`default.spatial`) + `opacity(0 → 1)` (`fast.effects`) | `scale(1.0 → 0.94)` + `opacity(1 → 0)` (`fast.effects`) | `23 · Polkit` auth failure runs damped horizontal shake (`±8px`, `expressive.fast.spatial`) and highlights border in `error`. |
| **`20 · Workspace Overview`** | Backdrop dim `slow.effects`; workspace grid zooms `scale(1.06 → 1.0)` (`slow.spatial`) to echo compositor zoom-out | Zooms back `scale(1.0 → 1.04)` + `opacity(1 → 0)` (`default.spatial`) | Dragging a window thumbnail across workspace slots uses `fast.spatial` lift (`scale 1.04`) and drop snap. |

### 5.6 Transient Overlays (`10 · Dock`, `11 · OSD`, `12C · Live Notification Stream`)

- **`10 · Dock`**: Auto-hide slides from bottom edge (`translateY(100% + 14px) ↔ 0`, `default.spatial`); active/running indicator dot (`4px → 12px` width) morphs via `fast.spatial`; subtle icon hover lift (`translateY(0 → -3px)`, `fast.spatial`).
- **`11 · OSD` (Volume / Brightness / IME)**:
  - Appears from `translateY(12px → 0)` + `scale(0.94 → 1.0)` (`fast.spatial`) + `opacity(0 → 1)` (`fast.effects`).
  - **Key-repeat rule**: Repeating volume/brightness keys resets the auto-dismiss timer (`1500ms`) and retargets the straight progress bar fill (`fast.spatial`) without re-playing the entrance animation.
- **`12C · Live Notification Stream`**:
  - Caps simultaneous live groups at 3 distinct apps (`app_key`); groups same-app popups with tucked deck peeks and in-place `M3Collapsible` `+N` expansion.
  - Enters from right screen edge (`translateX(24px → 0)` + `opacity 0 → 1`, `default.spatial`) and dismisses rightward (`fast.spatial`).
  - Stacked toasts reflow smoothly when an individual popup or collapsed app group is dismissed.

### 5.7 Hero Expressive Moments (`21 · Lock Screen` & `14 · Media Player`)

- **`21 · Lock Screen`** (`ext-session-lock-v1`):
  - **Lock entry**: Dimmed wallpaper + UI fades in with `slow.effects`; if triggered after `[idle].pre_action_fade_seconds`, precedes lock with a smooth `linear` dim over `pre_action_fade_seconds` (`2000ms` default).
  - **Password character entry** *(Expressive hero moment)*: Each typed character appends the next symmetric M3 shape in sequence (`Cookie4 → Clover4 → Sunny → Circle → Cookie6 → Flower5`), animating `scale(0.2 → 1.0)` + `rotate(-45deg → 0deg)` with **`expressive.fast.spatial`** (`k = 800, ζ = 0.6`). Backspace shrinks the last shape `scale(1.0 → 0.0)` with `fast.effects`.
  - **PAM auth failure**: Password pill executes a horizontal spring impulse (`v0 = ±650 px/s`, `expressive.fast.spatial`), briefly tints border to `error`, and clears dots sequentially.
  - **Unlock success**: Content scales `1.0 → 1.04` + fades `1 → 0` via `slow.effects` (`~240ms`) as `ext-session-lock-v1` unlocks.
- **`14 · Media Player`**:
  - **Wavy progress track**: Continuous horizontal phase travel (`24px/s`, `linear`) **strictly while `playback_status == "Playing"`**. When paused, the wave amplitude springs smoothly `1.0 → 0.0` (flattening into a calm straight track) via `default.spatial`, stopping the animation loop completely so idle CPU drops to `0%`.
  - **Waveform icon (`MediaEqIcon`)**: The `28px` cover-art fallback and `12px` per-player pills breathe smoothly across 5 bars (`~1.15–1.68Hz`) while that player is `Playing` and the default sink is unmuted with positive volume, settling via `default.spatial` back to the canonical `mediaEq` silhouette at `0%` idle CPU when paused, muted, or in `reduced` motion.

### 5.8 Micro-Interactions & Controls

| Control | Property | Token | Notes |
|---|---|---|---|
| **M3 Switch** | Thumb translation + press stretch (`18px → 20px` width on pointerdown) + track fill | `fast.spatial` (geometry), `fast.effects` (fill) | Subtle tactile stretch kept cleanly inside the `3px` track inset. |
| **Tonal Track Segmented Control** | Sliding `primary-container` indicator pill translates along `10px` recessed track + label color crossfade | `fast.spatial` (slide), `fast.effects` (color) | Smooth continuous retargeting with zero neighbor displacement (`22`, `22B`, `22D`, `22G`, `04B`). |
| **Quick Control Tile** (`01 · Main`) | Press feedback (`scale 1.0 → 0.985`), active container fill (`surface-container-high ↔ primary-container`), icon well tint | `fast.spatial` (scale), `fast.effects` (color) | Keep scale subtle so 2-column grid stays crisp. |
| **Precision Sliders** (`01`, `04`, `11`, `22B`, `22H`) | Pointer drag: **0ms direct tracking** (no spring lag) + vertical handle narrowing (`4px → 2.5px`); Track click / keyboard step: `fast.spatial` fill & handle snap | Direct / `fast.spatial` | Leading icon well tints to `primary-container` and right-side tabular readout highlights in `primary` (`fast.effects`); no duplicate white floating bubble on labeled rows. |
| **State Layers** (`Hover / Focus / Press / Drag`) | Translucent foreground overlay (`8%` / `12%` / `12%` / `16%`, per `material-web` `_md-sys-state.scss`) | `fast.effects` (`short2` `100ms` CSS) | Never animate `outline-width`; fade focus ring opacity smoothly. |

### 5.9 Motion Craft & Continuity Contracts (Anti-Stiffness Standards)

To prevent transitions from feeling like single-frame pops or monolithic static bitmaps, every surface and control must honor these five choreography contracts:

1. **Clip-Height Spring Expansion (No Frame-0 Height Snap / No Instant Collapse)**:
   - Inline expandable sections (`01 · Main` Power Menu bar, `02 · Wi-Fi` Password Prompt row, `16 · AI Usage` provider accordions) MUST animate outer clip height (`0 ↔ measuredHeight` via `fast.spatial`, `overflow: hidden`) paired with `createPresence` exit retention so closing smoothly collapses instead of snapping shorter on unmount.
   - Inner content glides subtly (`translateY(-4px → 0)`) with a delayed opacity ramp, and the triggering chevron rotates `0deg ↔ 180deg` (`fast.spatial`).
2. **Dual-Layer Overlapping Shared Axis X + Height Interpolation**:
   - Parent ↔ sub-panel drill-down (`01 · Main ↔ 02/03/04/04B`) MUST retain the outgoing view briefly (~`90ms` `fast.effects` fade + `-12px` opposite drift) while the incoming view enters from `+20px` (`default.spatial`) and the container smoothly interpolates height between views. Never unmount the outgoing page on frame 0 with an instant height jump.
3. **Two-Layer Shell/Content Micro-Parallax & Asymmetric Exit**:
   - Popovers and modals separate outer shell unfold (`scale(0.95 → 1.0)` + directional `translate(-6px → 0)` from the exact triggering anchor) from inner content settle (`~20–30ms` delayed opacity ramp + `translateY(-4px → 0)`), giving crisp depth without slow per-row waterfalls.
   - Programmatic dismisses (`Esc`, bar trigger toggle, adjacent island switch) MUST execute a fast asymmetric exit (`scale(1.0 → 0.965)`, `translate(-4px)`, `opacity(1 → 0)` over ~`120–140ms`); reserve `dismissInstant()` strictly for compositor-forced `xdg_popup` dismissal.
4. **Continuous Sliding Shared Indicators & FLIP Reflow**:
   - Mutually exclusive selection tracks (`09`/`09B` Workspaces active capsule, `10 · Dock` focused app bar, `M3SegmentedControl`, `SettingsWindow` sidebar, `18 · Launcher` & `19 · Clipboard` keyboard `↑↓` selection highlight) MUST use a single velocity-preserving `fast.spatial` sliding indicator tracking target `(x, y, width, height)`—physically gliding between slots instead of unmounting/remounting or teleporting highlight fills.
   - Dynamic lists and bars (`12 · Notification Popup` stack promotions, `10 · Dock` app open/close capsule width morph) smoothly reflow via FLIP position delta / spring width interpolation instead of snapping or remounting in place.
5. **Universal Pointer Affordance, Tactile Press & Activation Feedback**:
   - Every enabled interactive control (`<Button>`, primitives, bar islands, Quick Tiles, list rows, chips, dock tiles) MUST set `cursor: pointer` and render a clear hover lift/tint (`short2`/`short3`, never masked by inline `backgroundColor`).
   - Button & tile activation MUST feel visibly responsive: apply tactile press compression (`scale(0.95–0.96)` on compact buttons/icon buttons/chips; `scale(0.975)` on wide Quick Tiles/cards) and active toggle icon pop (`scale(0.86 → 1.0)` via `fast.spatial`) strictly on **inner visual children** so interactive hit-target bounds stay stationary (`zshell/no-hover-hit-target-shift`).
   - Small spatial indicators and inline expansions may tune standard damping slightly livelier (`ζ ≈ 0.82–0.85`, yielding a subtle 1–2% settle cushion) while keeping all `*.effects` springs strictly critically damped (`ζ = 1.0`).

---

## 6. Reduced Motion & Performance Guardrails

1. **WCAG 2.2 SC 2.3.3 (`motion_scheme = "reduced"`)** [[WCAG-2.2]](#references):
   - All spatial translations (`translateX`/`Y`), scales (`scale`), rotations, and expressive overshoots are bypassed (`0px` displacement, `scale = 1.0`).
   - Transitions degrade cleanly to `fast.effects` opacity crossfades ($\le 120\text{ms}$).
   - Media Player wave flattens to a static straight track; Lock Screen password shapes still display their crisp symmetric silhouettes but appear via opacity without pop/rotation.
2. **Compositor-Only Hot Path**:
   - Prefer `transform` and `opacity` during `144Hz` frame loops. Where outer container height morphs (Control Center sub-panels, accordion expansion), clip inner layers with `overflow: clip` and avoid re-flowing unrelated siblings.
3. **Never Block Input**:
   - Pointer clicks and keyboard shortcuts (`Esc`, `Enter`, `↑`/`↓`, `Tab`) must be accepted immediately during any enter/exit animation—never lock controls until a spring settles.

---

## References

1. **[M3-Motion-Overview]** Google Material Design 3 — *Motion Overview*: https://m3.material.io/styles/motion/overview
2. **[M3-Motion-Physics]** Google Material Design 3 — *Motion Physics System (Spatial & Effects Springs, Standard vs. Expressive Schemes)*: https://m3.material.io/styles/motion/overview/how-it-works
3. **[M3-Motion-Specs]** Google Material Design 3 — *Motion Specs & Spring Tokens (`md.sys.motion.spring.*`)*: https://m3.material.io/styles/motion/overview/specs
4. **[M3-Motion-Easing]** Google Material Design 3 — *Easing & Duration Tokens (`md.sys.motion.easing.*`, `md.sys.motion.duration.*`)*: https://m3.material.io/styles/motion/easing-and-duration/tokens-specs
5. **[M3-Transitions]** Google Material Design 3 — *Transition Patterns (Container Transform, Shared Axis, Fade Through, Fade)*: https://m3.material.io/styles/motion/transitions/transition-patterns
6. **[WCAG-2.2]** W3C — *Web Content Accessibility Guidelines (WCAG) 2.2*, SC 2.3.3 Animation from Interactions: https://www.w3.org/TR/WCAG22/#animation-from-interactions
7. **[z-shell-DESIGN]** `z-shell` Core Design System Specification — [DESIGN.md](../../DESIGN.md)
8. **[z-shell-SCOPE]** `z-shell` Architecture & Domain Scope — [SCOPE.md](../../SCOPE.md)
