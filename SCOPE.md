# Scope

`z-shell` is a modular Linux Wayland desktop shell whose UI renders on `zgui-js` (Solid 2.0 TSX + Lightning CSS Modules on QuickJS) and whose desktop integrations live in an independent Rust **Shell daemon** (`z-shelld`). It provides universal desktop services and a bidirectional plugin **Bus**, leaving compositor window management, standalone applications, and compositor- or vendor-specific workflows to compositors, dedicated tools, and TSX **Plugins**.

## In scope

- **Core daemon & bus (`z-shelld` + `z-shell`)**:
  - Separate **Public bus channel** and **Host control channel** (same-UID `SO_PEERCRED`, `0600` sockets, `flock` single-instance ownership, mandatory `bus.hello` version negotiation).
  - Strictly ordered **Topics** carrying `daemon_instance_id`, `topic_instance_id`, `revision`, distinct **Source baseline** vs **Subscription snapshot**, `topic.removed`, and slow-consumer `topic.reset`.
  - Bidirectional plugin extension points in reserved `plugin.` namespaces (**Topics**, **Control commands**, auto-cleaned inhibitors, theme sinks, launcher providers) plus user automation **Hooks** (`event → command`).
  - Deterministic `FixtureTransport` supporting async scheduling, disconnect, queue saturation, and session retirement.
- **Configuration & state**: Strictly separated TOML **User settings** (`settings.toml`, hot-reloadable), **Durable state** (`state.toml`, serialized atomic writes with cross-display locking), and in-memory **Live state**; enforced `offline_mode`.
- **Plugin ecosystem**:
  - Static `plugin.toml` as the single source of truth (`author/plugin`, `author/plugin:entry`, cumulative integer `plugin_api`, `PluginId → EntryId → InstanceId` config scoping, pinned `git` commit/digest and local `path` sources).
  - Seven entry kinds: `widget`, `shortcut`, `panel`, `service`, `launcher_provider`, `settings_page`, and `layer`. Unlike Noctalia (which includes `desktop_widget` and auto-generates plugin settings from schema alone), `z-shell` prioritizes first-class custom TSX `settings_page` entries while leaving desktop-layer widgets to `layer` entries.
  - Trusted composed TSX package model: the Bun **Plugin composer** resolves, minimizes, and displays concrete capability diffs (`commands`, `imagePrefixes`, `unixSockets`, `shellSurfaces`, `controlChannel`) before sealing into `zgui-js`'s `manifest.json`; `sessionLock` is never grantable by ordinary plugins.
- **Universal Wayland & Linux desktop services**:
  - Generic Wayland protocols with per-protocol capability reporting (`wl_output`/`xdg-output-v1`, `ext-workspace-v1`, `zwlr_foreign_toplevel_manager_v1`, `zwlr_output_power_manager_v1`), plus cross-process output identity with `output_gone` handling.
  - Pure-Rust PulseAudio native protocol audio (`pipewire-pulse`); honest read-only privacy telemetry reporting `unknown` where camera/screencast capture cannot be observed.
  - NetworkManager (Wi-Fi credentials over private requests, never persisted in settings or fixtures), BlueZ, UPower, `power-profiles-daemon`, `logind`, sysfs `brightness` (`controllable` check), optional display night light (separate from HCT theming), system telemetry, and AccountsService user info.
  - `org.freedesktop.Notifications`, SNI `StatusNotifierWatcher`/`DBusMenu`, MPRIS + bounded async cover fetching, XDG `.desktop` apps & fuzzy launcher with `query_id` cancellation.
  - Native Wayland clipboard (`ext-data-control-v1`/`wlr-data-control`) with Secret Service + ChaCha20-Poly1305 encrypted persistence.
  - Isolated **PAM helper** authentication and fail-closed cross-process **Idle & Sleep** coordination over the **Host control channel**.
  - Session **Polkit agent** (`[polkit].enabled`, default `true`), with a non-secret `session.polkit` topic and host-only identity selection, response, and cancellation. Prompts are hidden while the shell is locking or locked. An unavailable PolicyKit Authority or an existing agent does not prevent daemon startup.
  - Pure-Rust Material 3 HCT dynamic palette engine (optional `matugen` CLI backend), reversible GTK 3/4 linking, and allowlisted template application consuming committed palettes.
  - Dedicated **Wallpaper** service (`crates/z-shell-wallpaper`) managing directory scanning, bounded thumbnail & active-image staging under `$XDG_RUNTIME_DIR/z-shell/media/`, global and per-output durable persistence in `state.toml`, optional lock/sleep-aware slideshow, and automatic theme seed linkage.
- **First-party reference TS plugins**: `z-shell/ai-usage`, `z-shell/nosleep`, `z-shell/theme-bridges`, and `z-shell/niri-overview`.

## Out of scope

- **UI rendering or Wayland pixel/input surfaces in `z-shelld`**: Owned exclusively by `zgui-js` (see `zgui-js` ADR-0002).
- **Per-entry sandboxing of mutually untrusted plugins inside one QuickJS Session**: Same-session TSX plugins are trusted composed code sealed as one package capability union; isolating untrusted plugins would require OS-level process boundaries.
- **Compositor-specific IPC inside `z-shelld` core**: Niri, Hyprland, Sway, or ShojiWM private IPC sockets belong in TSX plugins glued over `zgui-js` capabilities and bus extension points.
- **Window management or managing compositor dotfiles**: Tiling, window rules, output arrangement, and compositor configs stay in the compositor.
- **C-header build dependencies for core audio/PAM/GTK**: Core builds must not require `libpipewire-dev`, `libpulse-dev`, or `libpam-dev` headers at compile time.
- **Unrestricted runtime `eval` of arbitrary TSX**: Plugins are statically composed with explicit user-approved capability declarations.
- **Plaintext clipboard persistence**: If the Secret Service keyring is locked or unavailable, clipboard history degrades to memory-only.
- **Replacing standalone desktop applications**: File managers, drive mounters, display greeters, and screen-casting tools remain separate programs.
