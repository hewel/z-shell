# z-shell

A modular Linux Wayland desktop shell built around a single **Rust Shell daemon** (`z-shelld`), a thin **CLI** (`z-shell`), a QuickJS-safe **TypeScript SDK & Plugin API**, and a static **Plugin composer** designed to pair with [`zgui-js`](https://github.com/hewel/zgui-js) (Solid 2.0 TSX + StyleX on QuickJS).

> **Current status:** All UI-independent backend services, security boundaries, protocol daemons, plugin tooling, and first-party reference plugins are implemented and verified. The `zgui-js` UI shell layer is the next milestone.

## Architecture

```text
                        ┌──────────────────────────────────────────────┐
                        │           zgui-js UI Host (QuickJS)          │
                        │   Shell Surfaces · Lock Screen · TSX Plugins │
                        │        @z-shell/sdk · @z-shell/plugin-api    │
                        └──────────┬───────────────────────┬───────────┘
                   host-<d>.sock   │ (PrivilegedHost)      │ bus-<d>.sock (Public)
                  (0600, SO_PEERCRED)                      │
                        ┌──────────▼───────────────────────▼───────────┐
                        │               z-shelld (Rust)                │
                        │  NDJSON JSON-RPC Bus · TOML Settings/State   │
                        │  Wayland · System · Desktop · IME · Theme    │
                        │  Clipboard · Idle/Lock · Polkit · Plugins    │
                        └──────────┬───────────────────────┬───────────┘
                                   │ stdin/stdout JSON     │ system/session D-Bus
                                   ▼                       ▼
                          z-shell-pam-helper       polkit-agent-helper-1
                          (isolated libpam)        Wayland · PipeWire · logind
```

### Core Design Principles

- **Dual-socket trust boundary**: `bus-<display>.sock` (`Public`) serves CLI tools, observers, and plugins; `host-<display>.sock` (`PrivilegedHost`) is reserved exclusively for the trusted UI host (lock acknowledgements, PAM unlock approvals, Polkit credentials, Wi-Fi secrets, binary media fetches, and durable state writes). Both sockets enforce `0600` permissions and `SO_PEERCRED` same-UID verification.
- **Zero-C-header core**: Audio (PipeWire/PulseAudio native protocol), Material 3 HCT palette generation, PAM authentication (`dlopen("libpam.so.0")` in an isolated child process), and Polkit (`polkit-agent-helper-1` line protocol) require no system C development headers.
- **Compositor-agnostic core, compositor-specific plugins**: `z-shelld` binds only standard Wayland protocols (`wl_output`, `xdg-output-v1`, `ext-workspace-v1`, `zwlr_foreign_toplevel_manager_v1`, `zwlr_output_power_manager_v1`, `ext-idle-notify-v1`, `ext-data-control-v1`/`wlr-data-control`). Compositor-private IPC (such as Niri overview geometry or ShojiWM theme sockets) lives in first-party plugins.
- **Static plugin composition**: Plugins declare capabilities, entries, and settings statically in `plugin.toml` without executing plugin code during audit. `@z-shell/composer` verifies SHA-256 content digests and explicit user approvals before producing a sealed capability union (never granting `sessionLock` to ordinary plugins).

## Capabilities

| Domain | Highlights |
| :--- | :--- |
| **NDJSON Bus & Config** | Mandatory `bus.hello` handshake, strictly monotonic topic revisions, `SourceBaseline` vs `Live` updates, slow-consumer `topic.reset`, connection-scoped cleanup, and atomic `settings.toml` / `state.toml` separation (`flock` + `0600` temp file + `fsync`). |
| **Generic Wayland** | Multi-output geometry with instance-generation IDs (`output_gone` on hotplug races), `ext-workspace-v1`, `zwlr_foreign_toplevel_manager_v1`, `zwlr_output_power_manager_v1`, and per-domain capability states (`readable`, `controllable`, `unsupported`, `disconnected`). |
| **System & Hardware** | Pure-Rust PulseAudio native client (`pipewire-pulse`), NetworkManager (privileged Wi-Fi credentials), BlueZ, UPower, Power Profiles Daemon, `logind`, sysfs backlight, CPU/memory/thermal telemetry, and honest `system.privacy` reporting. |
| **Desktop Protocols & Fcitx5 IME** | `org.freedesktop.Notifications` (popups + history + DND), SNI `StatusNotifierWatcher` + async `DBusMenu`, MPRIS + bounded offline-aware cover fetching, XDG `.desktop` launcher (`query_id` cancellation + plugin providers), and dual-mode Fcitx5 IME (`indicator_only` via SNI + `Controller1` by default, opt-in `kimpanel` via `org.kde.impanel2` with separate `desktop.ime` / `desktop.ime.panel` topics). |
| **Encrypted Clipboard** | Native `ext-data-control-v1` / `wlr-data-control` with verbatim MIME/Latin-1 preservation, `x-kde-passwordManagerHint` rejection, ChaCha20-Poly1305 + Secret Service encrypted history (degrading cleanly to memory-only), revocable out-of-band media handles, and lock-screen read denial. |
| **Session, PAM, Idle & Polkit** | Isolated `z-shell-pam-helper`, fail-closed cross-process lock & `PrepareForSleep` coordinator (host-verified `ext_session_lock_v1.locked` ACK, single-use scoped unlock approvals, sleep hold, optional `fallback_locker`), declarative `[[idle.rules]]`, Caffeine, `org.freedesktop.ScreenSaver`, `ext-idle-notify-v1`, DPMS screen-off, and session Polkit agent (`session.polkit` + host-only `host.polkit-*` commands). |
| **Theme Engine** | Pure-Rust Material 3 HCT palette generator (31 roles, 6 variants, Dark/Light/Auto), bounded wallpaper seed extraction, optional `matugen` CLI backend with stale-sequence rejection, and reversible GTK 3/4 linking with conflict detection. |
| **Wallpaper** | Paginated PNG/JPEG/WebP catalog, confined media tokens, durable global and per-output assignments, lock/sleep-aware slideshow, and optional theme linkage. |
| **Plugin Ecosystem** | Offline-capable `z-shell plugin` CLI (`path` & commit-pinned `git` sources), capability diff audit/approval/revocation, `@z-shell/composer`, QuickJS-safe `@z-shell/sdk` & `@z-shell/plugin-api`, and 4 first-party reference plugins (`ai-usage`, `nosleep`, `theme-bridges`, `niri-overview`). |

## Repository Layout

```text
crates/
  z-shell-protocol/    Wire protocol types, identifier validation, shared test vectors
  z-shell-config/      XDG path security, settings.toml, state.toml, atomic persistence
  z-shell-bus/         Dual-socket NDJSON broker, SO_PEERCRED, ordered queues, inhibitors
  z-shell-plugins/     Static plugin.toml parser, SHA-256 digest, git/path PluginManager
  z-shell-wayland/     Generic Wayland outputs, workspaces, windows, and output power
  z-shell-theme/       Pure-Rust Material 3 HCT engine, wallpaper seed, Matugen, GTK linker
  z-shell-wallpaper/   Wallpaper catalog, runtime media, durable assignments, slideshow
  z-shell-system/      PulseAudio, NetworkManager, BlueZ, UPower, PPD, logind, telemetry
  z-shell-clipboard/   Wayland data-control clipboard with ChaCha20-Poly1305 persistence
  z-shell-desktop/     Notifications, SNI/DBusMenu tray, MPRIS, XDG launcher, Fcitx5 IME
  z-shell-session/     z-shell-pam-helper, ADR-0004 lock/sleep/idle coordinator, Polkit agent
  z-shelld/            Single Shell daemon binary assembling all domains & privacy guards
  z-shell-cli/         Thin CLI (z-shell) for bus queries, commands, and plugin management

packages/
  sdk/                 @z-shell/sdk (QuickJS-safe ES2022 client + @z-shell/sdk/bun transport)
  plugin-api/          @z-shell/plugin-api (scoped PluginContext & manifest types)
  composer/            @z-shell/composer (static validator, capability union, codegen)

plugins/
  ai-usage/            z-shell/ai-usage (ai-usagebar + optional Codex Resets feed)
  nosleep/             z-shell/nosleep (manual & agent-working bus sleep inhibition)
  theme-bridges/       z-shell/theme-bridges (ShojiWM UDS + reversible Zen Browser CSS)
  niri-overview/       z-shell/niri-overview (Niri IPC snapshot backfill & viewport layout)

docs/
  adr/                 Architecture Decision Records (0001–0006)
  plugin-manifest-v1.md Authoritative plugin.toml, registry.json, and digest specification
schemas/
  protocol-vectors.json Shared Rust ↔ TypeScript wire-format & identifier test vectors
```

## Quick Start

### Prerequisites

- **Rust** `>= 1.88` (Cargo workspace)
- **Bun** `>= 1.4`

### Build & Verify

Run the full verification suite (Rust formatting, QuickJS + Composer TypeScript checking via `tsrs`, Rust workspace tests, Clippy `-D warnings`, Rustdoc, binary builds, and Bun integration tests):

```bash
bun install
bun run check
```

Individual commands:

```bash
cargo build --bins          # Builds z-shelld, z-shell, and z-shell-pam-helper
bun run typecheck           # Checks tsconfig.quickjs.json (ES2022 zero-global) & composer
bun run test:rust           # cargo test + clippy -D warnings + cargo doc --no-deps
bun run test:ts             # Builds binaries and runs all packages/ and plugins/ Bun tests
```

### Running the Daemon & CLI

```bash
# Start the shell daemon (requires $XDG_RUNTIME_DIR)
./target/debug/z-shelld

# Inspect daemon status, active topics, and control commands
./target/debug/z-shell status
./target/debug/z-shell topics
./target/debug/z-shell commands

# Stream live NDJSON updates for a topic
./target/debug/z-shell watch desktop.ime

# Invoke a core or plugin control command
./target/debug/z-shell msg settings.reload
./target/debug/z-shell msg ime.toggle
./target/debug/z-shell msg idle.caffeine --payload '{"enabled":true}'
```

### Managing Plugins

```bash
# Add, audit, approve, and enable a local plugin
./target/debug/z-shell plugin add --path ./plugins/nosleep
./target/debug/z-shell plugin audit z-shell/nosleep
./target/debug/z-shell plugin approve z-shell/nosleep
./target/debug/z-shell plugin enable z-shell/nosleep
./target/debug/z-shell plugin list
```

## Configuration

User settings live in `$XDG_CONFIG_HOME/z-shell/settings.toml` (hot-reloaded via `z-shell msg settings.reload`); shell-owned durable state lives separately in `$XDG_STATE_HOME/z-shell/state.toml`.

```toml
[general]
offline_mode = false
log_level = "info"

[bar]
position = "top"
gaps = 14
clock_24h = true

[theme]
mode = "dark"            # "dark" | "light" | "auto"
variant = "tonal"        # "tonal" | "vibrant" | "expressive" | "fidelity" | "neutral" | "mono"
backend = "builtin"      # "builtin" | "matugen"
gtk_linking = false

[wallpaper]
directories = ["~/Pictures/wallpapers"]
fit = "cover"            # "cover" | "contain" | "fill" | "center"
sync_theme = true        # derive from global wallpaper when theme.seed_color is unset
slideshow_seconds = 0    # disabled; positive values rotate the global image

[ime]
mode = "indicator_only"  # "indicator_only" | "kimpanel" | "disabled"
candidate_layout = "auto"
switch_osd = true

[polkit]
enabled = true

[idle]
pre_action_fade_seconds = 2

[[idle.rules]]
name = "lock"
enabled = false
timeout_seconds = 600
action = "lock"

[[idle.rules]]
name = "screen-off"
enabled = false
timeout_seconds = 660
locked_timeout_seconds = 60
action = "screen_off"
```

### Wallpaper

Subscribe to `wallpaper` for the global image (`current`) and connector-specific overrides
(`per_output`, keyed by names such as `DP-1`). The renderer only needs an `imagePrefixes`
entry for `$XDG_RUNTIME_DIR/z-shell/media/wallpapers/`; resolve `media` and `thumbnail` as
daemon media tokens, not `source_path` as a host image path.

```bash
z-shell msg wallpaper.list --payload '{"offset":0,"limit":24}'
z-shell msg wallpaper.set --payload '{"path":"/home/me/Pictures/desktop.webp"}'
z-shell msg wallpaper.set --payload '{"path":"/home/me/Pictures/portrait.jpg","output":"DP-1","fit":"contain"}'
z-shell msg wallpaper.clear --payload '{"output":"DP-1"}'
z-shell msg wallpaper.rescan
```

Omit `output` for the global assignment. `wallpaper.next`, `wallpaper.previous`, and
`wallpaper.random` take the same optional `output`. Source paths survive daemon restarts;
one-off `fit` overrides do not. Scans are non-recursive, cap the picker at 512 images,
and skip missing directories and undecodable files. Images are limited to 64 MiB encoded
and 8192 pixels per edge; picker thumbnails are no larger than 320 × 320 pixels. Public
mutations are denied during shell lock, but the topic and picker remain readable.

## Documentation

- [SCOPE.md](SCOPE.md) — Project scope and phase boundaries
- [GLOSSARY.md](GLOSSARY.md) — Canonical domain vocabulary
- [docs/plugin-manifest-v1.md](docs/plugin-manifest-v1.md) — `plugin.toml`, `registry.json`, and SHA-256 digest contract
- Architecture Decision Records:
  - [ADR-0001](docs/adr/0001-single-rust-daemon-and-ndjson-bus.md) — Single Rust daemon and NDJSON bus
  - [ADR-0002](docs/adr/0002-generic-wayland-and-plugin-compositor-glue.md) — Generic Wayland in core, compositor IPC as plugins
  - [ADR-0003](docs/adr/0003-pure-rust-audio-and-theme-engines.md) — Pure-Rust audio and theme engines
  - [ADR-0004](docs/adr/0004-cross-process-lock-and-idle-coordination.md) — Cross-process lock and idle coordination
  - [ADR-0005](docs/adr/0005-toml-config-state-split-and-plugin-manifest.md) — TOML config/state separation and static plugin composition
  - [ADR-0006](docs/adr/0006-fcitx5-input-method-dual-mode-and-panel-split.md) — Fcitx5 dual-mode integration and topic split

## License

Dual-licensed under `MIT OR Apache-2.0`.
