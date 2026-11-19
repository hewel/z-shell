# z-shell

The UI-independent daemon, bus protocol, and TSX plugin ecosystem powering the z-shell Wayland desktop shell.

## Language

### Runtime & Bus

**Shell daemon**:
The single long-lived process (`z-shelld`) that owns desktop service integrations, state topics, persistence, and the Unix domain socket bus.
_Avoid_: Backend server, helper, service host

**Daemon instance**:
One boot incarnation of the shell daemon, identified by an opaque `daemon_instance_id` that changes on every restart.
_Avoid_: Generation (reserved for `zgui-js` UI session incarnations)

**Public bus channel**:
The same-UID Unix domain socket (`bus-<display>.sock`) used by ordinary CLI invocations, observers, and non-privileged bus clients.
_Avoid_: Host socket, control pipe

**Host control channel**:
The dedicated same-UID Unix domain socket (`host-<display>.sock`) reserved exclusively for the trusted `zgui-js` native host to exchange lock acknowledgements, unlock approvals, and privileged lifecycle commands.
_Avoid_: Admin socket, public bus

**Bus**:
The bidirectional NDJSON Unix domain socket protocol spanning the public bus channel and host control channel.
_Avoid_: IPC pipe, message queue

**Topic**:
A named, versioned state stream published on the bus, delivering a subscription snapshot followed by strictly ordered monotonic revision updates.
_Avoid_: Channel, store, feed

**Topic instance**:
One lifecycle incarnation of a topic (`topic_instance_id`); unregistering and re-registering a plugin topic allocates a new topic instance so subscribers never confuse recycled revisions.
_Avoid_: Generation, version

**Source baseline**:
The first settled state emitted when an external desktop data source (such as D-Bus, PulseAudio, or Wayland) connects or re-syncs; consumers suppress user-visible transitions such as OSDs or hooks on it.
_Avoid_: Subscription snapshot, startup event

**Subscription snapshot**:
The current committed topic state returned synchronously when a client subscribes to an already-active topic; ordered atomically ahead of any subsequent updates on that connection.
_Avoid_: Source baseline, initial event

**Control command**:
A named action invokable from the CLI (`z-shell msg`), hooks, or bus clients, routed either to a daemon core handler or to a plugin-owned handler in the `plugin.` namespace.
_Avoid_: IPC line, subcommand, trigger

**Daemon media token**:
A short-lived, scope-limited reference (`MediaRef`) emitted by the shell daemon pointing either to a restricted runtime cache file or an out-of-band binary pull handle.
_Avoid_: Image URL, data URI, image handle

**Host image handle**:
A session-scoped opaque `zgui-blob://<id>` reference owned by the `zgui-js` native host after fetching and validating bytes from a daemon media token outside the QuickJS heap.
_Avoid_: Media token, blob URL

### Configuration & State

**User settings**:
Human-editable declarative configuration stored in `settings.toml` under `$XDG_CONFIG_HOME/z-shell/`, supporting live reload and UI overrides.
_Avoid_: Preferences, config state

**Durable state**:
Recoverable shell-owned state persisted separately in `state.toml` under `$XDG_STATE_HOME/z-shell/` (such as pinned apps, last wallpaper, or owner-scoped UI tables).
_Avoid_: Settings, config, live state

**Live state**:
Process-local ephemeral observations and connection-scoped leases (such as connected clients, active inhibitors, sleep hold, or pending unlock approvals) that never persist across daemon restarts.
_Avoid_: Durable state, state file

**Hook**:
A user-configured automation rule binding a committed shell event to a registered control command or allowlisted executable argv.
_Avoid_: Plugin lifecycle callback

### Plugins

**Plugin**:
A distributable TSX/TypeScript package identified by `author/plugin` with a static `plugin.toml` manifest declaring its `plugin_api` level, entries, config schema/defaults, and required capabilities.
_Avoid_: Extension, addon, module

**Plugin entry**:
One static contribution declared inside a plugin (`author/plugin:entry`) of a fixed kind: `widget`, `shortcut`, `panel`, `service`, `launcher_provider`, `settings_page`, or `layer`.
_Avoid_: Component, instance

**Entry instance**:
One concrete mounted occurrence of a plugin entry (for example, a bar widget placed on two different outputs with distinct per-instance display settings).
_Avoid_: Plugin entry, component

**Plugin composer**:
The build-time step that bundles enabled plugins together with the shell UI into one trusted `zgui-js` package and merges their user-approved capabilities into a sealed `manifest.json`.
_Avoid_: Plugin loader, sandbox, dynamic evaluator

### Desktop Domains

**Sleep hold**:
A lock-screen phase during which system sleep is pending and authentication-driven unlocking is suppressed; releasing it permits a fresh authentication and never unlocks by itself.
_Avoid_: Suspend lock, auth block

**Lock acknowledgement**:
Confirmation sent over the host control channel exclusively when the compositor emits `ext_session_lock_v1.locked` for the active lock object, permitting the shell daemon to release a pending `logind` sleep delay inhibitor.
_Avoid_: Lock ready, lock started

**PAM helper**:
A short-lived dedicated child process executing `pam_authenticate` outside `z-shelld`'s address space so blocking or faulty PAM modules cannot corrupt or stall the daemon.
_Avoid_: Auth thread

**Clipboard payload**:
The original bytes of a Wayland clipboard selection paired with its advertised MIME type and encoding, preserved verbatim without lossy transcoding.
_Avoid_: Clip, snippet
