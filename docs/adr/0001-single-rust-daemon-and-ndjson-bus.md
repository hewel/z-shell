# Single Rust Shell Daemon Over a Bidirectional NDJSON Unix Socket Bus

**Status:** accepted

In line with `zgui-js` ADR-0002, all desktop integrations live outside the UI runtime in a single Rust **Shell daemon** (`z-shelld`) paired with a thin CLI (`z-shell`) and a QuickJS-safe TypeScript SDK (`@z-shell/sdk`). The daemon exposes two distinct same-UID (`SO_PEERCRED`) `0600` Unix domain sockets inside a verified `0700` `$XDG_RUNTIME_DIR/z-shell` directory (refusing to fall back to shared `/tmp`): a **Public bus channel** (`bus-<display>.sock`) for CLI and ordinary clients, and a **Host control channel** (`host-<display>.sock`) exclusively for the trusted `zgui-js` native host. Single-instance ownership is guarded by an exclusive `flock` lockfile so no instance ever unlinks a sibling's socket.

The wire format is a strict **z-shell NDJSON profile** (JSON-RPC 2.0 envelope with mandatory `jsonrpc: "2.0"`, mutually exclusive `result`/`error`, `id: null` on uncorrelatable parse errors, and all protocol integers constrained to JS safe integers `<= 2^53 - 1`). Every connection must complete `bus.hello` protocol version negotiation before issuing any other request. The daemon derives caller identity and trust role (`Public` vs `PrivilegedHost`) strictly from the authenticated connection—caller-supplied `plugin_id` values are attribution metadata only, never credentials—and enforces non-overlapping namespaces (`plugin.*` for plugin topics and plugin control commands).

Every **Topic** commit, revision increment, and per-client ordered outbound enqueue occurs inside one serialized critical section (never holding locks across socket I/O), carrying `(daemon_instance_id, topic_instance_id, revision)` and distinguishing **Source baseline** from **Subscription snapshot**. Slow subscribers exceeding their frame or byte budget receive an explicit `topic.reset` notification (or disconnect) rather than silently dropping the latest revision, and deleted topics emit `topic.removed`. Each connection owns bounded in-flight tasks, frame/byte queues, and resource leases; on disconnect the connection owner is retired first so late in-flight tasks can never resurrect topics, commands, or inhibitors. Image bytes are never base64-inlined into JSON: the daemon emits short-lived **Daemon media tokens** (`MediaRef`) that the native host fetches under strict byte/dimension budgets and registers as session-scoped **Host image handles** (`zgui-blob://<id>`).

## Considered Options

- **One daemon process per desktop subsystem:** Rejected because it multiplies socket discovery, lifecycle supervision, cross-domain coordination (such as MPRIS inhibiting Idle), and QuickJS connection handles.
- **Single shared socket trusting caller-provided `plugin_id` strings:** Rejected because same-UID proves only the Unix user; CLI tools and ordinary clients must not be able to spoof lock acknowledgements, unlock approvals, or arbitrary host-privileged mutations.
- **Length-prefixed binary framing (MessagePack/CBOR) multiplexing control and image bytes:** Rejected because it requires shipping a binary decoder inside QuickJS and degrades human readability of deterministic `zgui-js` preview fixtures.

## Consequences

- `z-shelld` can be built, tested, and operated via `z-shell` and `@z-shell/sdk` independently of `zgui-js` UI readiness.
- Every core service, state writer, and bus handler operates under explicit connection/frame/byte budgets and mockable transport/clock boundaries so both Rust concurrency tests and `zgui-js` `FixtureTransport` can verify ordering, backpressure reset, and crash cleanup deterministically.
