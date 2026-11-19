# Pure-Rust Audio Protocol and Material 3 Theme Engine

**Status:** accepted

To keep `z-shelld` portable and free of C header / `bindgen` build dependencies, the audio domain speaks the PulseAudio native Unix-socket protocol directly in pure Rust against `pipewire-pulse` (supporting sinks, sources, default switching, per-app streams, and native event subscriptions), and the theme engine generates Material 3 HCT palettes directly in pure Rust from a seed color or wallpaper dominant color—with an optional `matugen` CLI backend for users who prefer it.

Audio/privacy observation remains strictly honest about its visibility limits: PulseAudio stream inspection can observe audio capture streams, but cannot prove that cameras or Wayland screencasts are inactive; unobservable capture classes must report `unknown` rather than claiming "safe". Display night light belongs to a capability-probed display/gamma backend rather than the HCT palette engine, and temporary runtime toggles never mutate scheduled settings.

The theme engine publishes only **committed** palettes onto the `theme` **Topic**; rapid generation requests coalesce and stale results are rejected. Reversible GTK 3/4 linking (off by default, loading `libgio` dynamically at runtime) and optional palette templates write only to allowlisted targets with conflict detection and recovery records; external application write failures are surfaced diagnostically and never roll back an already-committed shell palette. Browser or compositor-specific theme bridges subscribe to committed theme broadcasts as **Plugins**.

## Considered Options

- **Binding `libpipewire-0.3` via `pipewire-rs`:** Rejected because it requires `libpipewire-dev` and `libclang` in every build and CI environment and ties builds to system PipeWire header versions.
- **Shelling out to `wpctl` / `pactl`:** Rejected because polling/parsing CLI output is fragile for live event streams and per-app audio stream controls.
- **Requiring external `matugen` CLI as the sole palette generator:** Rejected because it breaks zero-dependency out-of-the-box theming and makes theme tests non-deterministic across `matugen` versions.

## Consequences

- `cargo build` and `cargo test` succeed in minimal environments without `libpipewire-dev`, `libpulse-dev`, or `matugen` installed.
- Pure-Rust M3 HCT generation yields deterministic palettes across unit tests and preview fixtures while keeping external theme sinks strictly isolated from core shell stability.
