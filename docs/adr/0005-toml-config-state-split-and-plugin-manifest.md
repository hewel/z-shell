# TOML Config/State Separation and Static Plugin Composition

**Status:** accepted

> _Proposed to be partially reopened by [ADR-0007](0007-runtime-plugin-loading-and-store-architecture.md) on static whole-shell plugin composition: runtime plugin loading replaces build-time整壳 re-bundling via **Plugin composer**, while the three-tier TOML config/state split, `plugin.toml` single source of truth, `PluginId → EntryId → InstanceId` scoping, and permanent `sessionLock` prohibition remain in full effect._

Following Noctalia's configuration discipline and `zgui-js`'s sealed-manifest security model, `z-shell` separates state into three distinct tiers:
1. **User settings** (`$XDG_CONFIG_HOME/z-shell/settings.toml`): human-editable declarative configuration, hot-reloaded on atomic replacement with debouncing, retaining the last valid config on error and emitting live updates only when committed values change.
2. **Durable state** (`$XDG_STATE_HOME/z-shell/state.toml`): recoverable shell-owned state (pinned apps, last wallpaper, owner-scoped tables) persisted by a single serialized writer using exclusive `0600` unique temp files, `fsync` on file and parent directory, and cross-display `flock` locking—never mutating in-memory state or topic revisions before disk commit succeeds.
3. **Live state**: ephemeral runtime observations and connection-scoped leases (connected clients, inhibitors, **Sleep hold**, pending unlock approvals) kept strictly in memory and never serialized to `state.toml`.

Each **Plugin** is a directory identified by `author/plugin` with a static `plugin.toml` as the **single source of truth** declaring:
- Cumulative integer `plugin_api` compatibility level (independent of package semver and bus protocol version).
- **Plugin entries** (`author/plugin:entry`) across seven kinds (`widget`, `shortcut`, `panel`, `service`, `launcher_provider`, `settings_page`, `layer`), distinguishing shared plugin settings from per-entry and per-**Entry instance** (`PluginId → EntryId → InstanceId`) display settings, with typed defaults, validation ranges, and secret fields excluded from public snapshots/exports.
- Required `z-shelld` **Bus** permissions (separate from host capabilities) and required `zgui-js` capabilities aligned with `zgui-js/packages/build/src/build.ts` (`commands`, `imagePrefixes`, `unixSockets`, `shellSurfaces`, `controlChannel`). `sessionLock` is never grantable through ordinary plugin composition.

Same-session TSX plugins execute as **trusted composed code** inside `zgui-js`'s single QuickJS Session: `manifest.json` seals the user-approved capability union of the composed package rather than acting as a per-entry sandbox. `PluginManager` pins `git` sources by commit/content digest, validates that all entry paths and symlinks remain inside the plugin root, parses manifests without executing plugin code, and separates download, capability diff audit, explicit user approval (re-approval required on any capability expansion), build publication, and `zgui-js` native acceptance.

## Considered Options

- **Dynamic runtime `eval` of arbitrary TSX plugins from disk:** Rejected because it contradicts `zgui-js`'s zero-authority sealed `manifest.json` package model and complicates static TypeScript/StyleX compilation.
- **Maintaining separate hand-written TS manifests alongside `plugin.toml`:** Rejected because dual sources of truth drift; `plugin.toml` is authoritative and generates/validates the typed TS descriptor at compose time.
- **Treating `capabilities.bus` as a per-plugin sandbox inside one QuickJS Session:** Rejected because plugins sharing one JS engine share one connection and heap; trust boundaries must match OS/connection boundaries.

## Consequences

- `z-shelld` parses TOML in Rust and delivers scoped, non-secret JSON views over the **Bus**, so QuickJS plugins never ship a TOML parser or receive unrelated plugins' secrets.
- Failed candidate plugin builds never replace the last enabled package, and revoking a capability never silently restores a prior approval.
