# Plugin Manifest & Registry Contract (v1)

Authoritative Phase 2 contract shared between `crates/z-shell-plugins` (Rust) and `packages/composer` (Bun/TS).

## 1. `plugin.toml` Schema (Single Source of Truth)

```toml
id = "z-shell/example"          # required: canonical PluginId (<author>/<plugin>, <= 128 bytes)
name = "Example Plugin"         # required: non-empty display name
version = "1.0.0"               # required: strict MAJOR.MINOR.PATCH (decimal, no leading zeros, no prerelease/build)
plugin_api = 1                  # required: positive integer <= 1
author = "z-shell"              # optional
license = "MIT"                 # optional (default: "MIT")
description = "..."             # optional
dependencies = ["tool"]         # optional informational metadata

[host_capabilities]             # maps to zgui-js package.schema.json capabilities; `session_lock` is FORBIDDEN
commands = ["tool"]             # optional array of non-empty command names/paths
image_prefixes = []             # optional array of canonical absolute paths or constrained runtime templates ($XDG_RUNTIME_DIR, $HOME, $XDG_DATA_HOME, ${WAYLAND_DISPLAY})
unix_sockets = []               # optional array of canonical absolute paths or constrained runtime templates
named_sockets = []              # optional array of host-resolved socket names (^[A-Za-z][A-Za-z0-9_-]{0,63}$)
shell_surfaces = false          # optional bool
control_channel = false         # optional bool

[bus_permissions]
topics_read = ["settings"]
topics_publish = ["plugin.z-shell.example.state"]
commands_register = ["plugin.z-shell.example.ping"]
inhibitors = false

[[setting]]                     # optional plugin-level shared settings schema
key = "refresh_seconds"
type = "integer"                # "string" | "integer" | "number" | "boolean"
default = 300
min = 30                        # optional numeric lower bound
max = 3600                      # optional numeric upper bound
secret = false                  # optional bool (default: false; secrets excluded from public snapshots/exports)

# Entry tables (7 fixed kinds):
# [[widget]], [[shortcut]], [[panel]], [[service]], [[launcher_provider]], [[settings_page]], [[layer]]
[[service]]
id = "worker"
entry = "src/worker.ts"         # required: relative path strictly inside plugin root (no .., no symlink escape)
title = "Background Worker"
description = "..."             # optional

[[widget]]
id = "indicator"
entry = "src/indicator.tsx"
title = "Bar Indicator"

  [[widget.setting]]            # optional per-entry setting schema (same fields as [[setting]])
  key = "compact"
  type = "boolean"
  default = true
```

### Hard Validation Rules
- `deny_unknown_fields` on manifest tables so typos (including any attempt to pass `session_lock` in `[host_capabilities]`) fail loudly!
- All entry `id`s within one plugin must be unique valid slugs (`author/plugin:entry <= 128 bytes`).
- Every `entry` file must exist, be a regular file, and its canonicalized path must remain strictly inside the canonicalized plugin root directory (rejecting `..`, absolute paths, and symlinks pointing outside the root).
- Every `topics_publish` and `commands_register` entry in `[bus_permissions]` must start with `plugin.`.
- `plugin.toml` is parsed purely statically; plugin source code is NEVER executed during manifest parsing or auditing.

## 2. Registry File (`$XDG_STATE_HOME/z-shell/plugins/registry.json`)

Written atomically (`0600` unique temp file + `fsync` + `rename` + dir `fsync`) under `plugins.lock` `flock`.

```json
{
  "schema_version": 1,
  "plugins": {
    "z-shell/example": {
      "id": "z-shell/example",
      "name": "Example Plugin",
      "version": "1.0.0",
      "plugin_api": 1,
      "source": {
        "kind": "path",
        "root": "/abs/path/to/plugin"
      },
      "content_digest": "sha256:<64-hex>",
      "enabled": false,
      "revoked": false,
      "requested_capabilities": {
        "host": {
          "commands": [],
          "imagePrefixes": [],
          "unixSockets": [],
          "namedSockets": [],
          "shellSurfaces": false,
          "controlChannel": false
        },
        "bus": {
          "topicsRead": [],
          "topicsPublish": [],
          "commandsRegister": [],
          "inhibitors": false
        }
      },
      "approved_capabilities": null,
      "accepted_build_id": null
    }
  }
}
```

For `git` sources:
```json
{
  "kind": "git",
  "url": "https://example.invalid/repo.git",
  "rev": "<40-hex-commit-sha>",
  "ref_name": "main",
  "root": "/abs/path/to/exported/files"
}
```

## 3. Content Digest Algorithm

Deterministic SHA-256 over all regular files inside the plugin root (excluding `.git/`):
1. Walk files recursively (rejecting any symlink pointing outside the root).
2. Sort by POSIX-normalized relative path (`/` separators) in lexicographical byte order.
3. For each file, feed `relative_path_utf8`, `\0`, `file_len_decimal`, `\0`, `raw_file_bytes`, `\0` into SHA-256.
4. Format as `sha256:<lowercase-64-hex>`.

## 4. Capability Approval & Expansion Semantics

- Installing (`add`) records `requested_capabilities`, `enabled = false`, `approved_capabilities = null`.
- `audit` computes exact added/removed capabilities vs `approved_capabilities` (empty when `null`).
- `approve` snapshots `requested_capabilities` into `approved_capabilities` and sets `revoked = false`.
- `revoke` clears `approved_capabilities = null`, sets `revoked = true`, and forces `enabled = false`.
- `enable` succeeds ONLY when `approved_capabilities` covers every capability in `requested_capabilities` (no unapproved expansion), `revoked == false`, and `content_digest` matches the current files on disk.
- `sync` updates `path`/`git` content (refusing network git fetch when `offline_mode == true`); if new `requested_capabilities` expand beyond `approved_capabilities`, `enabled` is forced to `false` until the user explicitly re-approves.
