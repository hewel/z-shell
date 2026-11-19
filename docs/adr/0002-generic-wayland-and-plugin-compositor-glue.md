# Generic Wayland Protocols in Core, Compositor IPC as TSX Plugins

**Status:** accepted

`z-shelld` core binds only compositor-agnostic Wayland protocols (`wl_output` + `xdg-output-v1`, `ext-workspace-v1`, `zwlr_foreign_toplevel_manager_v1`, `zwlr_output_power_manager_v1`, `ext-idle-notify-v1`, and `ext-data-control-v1`/`wlr-data-control`) and never couples to Niri, Hyprland, Sway, or ShojiWM private IPC sockets. Each Wayland protocol domain explicitly reports its live capability state (`readable`, `controllable`, `unsupported`, or `disconnected`) so missing workspace or DPMS support degrades cleanly without breaking other domains. Because `z-shelld` and `zgui-js` maintain independent Wayland connections, outputs are never correlated by raw Wayland object IDs, array indices, or bare connector names alone; cross-process output identity carries an instance generation and surfaces explicit `output_gone` errors during hotplug races rather than misrouting actions to another monitor.

Features requiring compositor-private IPC or vendor workflows—such as Niri geometric workspace overview coordinates, ShojiWM window-frame theme sockets, AI Usage, or Herdr/Nosleep—live as first-party TSX **Plugins** glued over `zgui-js` capabilities and `z-shelld` bus extension points. Compositor plugin adapters must implement capability detection, initial snapshot backfill (for compositors whose event streams omit initial state), disconnect/overflow reset, and bounded queues, publishing only normalized state onto `plugin.*` **Topics**. Keyboard layout reporting follows seat/backend capability discovery (read-only or unsupported when the compositor exposes no switch protocol).

## Considered Options

- **Building compositor-specific adapters (Niri/ShojiWM/Hyprland) into `z-shelld` core:** Rejected because each compositor evolves private IPC formats independently, bloats core maintenance, and conflates universal desktop services with compositor glue.
- **Using `ext-image-copy-capture` / `wlr-screencopy` in core for Workspace Overview:** Rejected due to continuous GPU/memory capture overhead and unnecessary screencopy authority for core shell operation.

## Consequences

- Core workspaces, active window, dock tracking, and display power work across any Wayland compositor supporting standard protocols without per-compositor branches.
- Missing protocols report structured `unsupported` states instead of silent empties or crashes, and compositor restarts cleanly reset subscriptions.
