# Cross-Process Lock Screen and Idle/Sleep Coordination

**Status:** accepted

Because `zgui-js` owns the `ext-session-lock-v1` Wayland surfaces (failing closed on session fault or teardown) while `z-shelld` owns idle detection (`ext-idle-notify-v1`, `org.freedesktop.ScreenSaver`), `logind` `PrepareForSleep` delay inhibitors, and authentication orchestration, lock and sleep transitions follow a strict state-machine handshake exclusively over the **Host control channel** (`host-<display>.sock`). Ordinary CLI and **Public bus channel** clients may *request* locking (`lock.request`), but may never emit **Lock acknowledgement**, submit credentials, or approve unlocking.

Authentication executes inside a dedicated short-lived **PAM helper** child process (`dlopen("libpam.so.0")`, `pam_authenticate` only) communicating with `z-shelld` over an anonymous private pipe, isolating blocking or misbehaving PAM modules from the daemon's address space. Credentials never traverse ordinary topics, commands, logs, or fixture ledgers.

## Lock & Sleep Invariants

| Invariant | Enforcement Rule |
|---|---|
| **Only `ext_session_lock_v1.locked` produces ACK** | Sent exclusively by the trusted `zgui-js` native host over the **Host control channel** for the active lock object. Opening a panel, creating surfaces, painting a frame, or spawning a fallback locker is never an ACK; receiving `finished` before `locked` means lock acquisition failed. |
| **Single-use scoped unlock approvals** | Every unlock approval binds `(daemon_instance_id, ui_session_generation, lock_id, auth_attempt_id)` and is consumed at most once. Entering **Sleep hold**, reconnecting, restarting the daemon, or replacing the lock immediately invalidates any prior approval; waking from sleep can never consume a pre-sleep PAM result. |
| **Locked vs. not-yet-locked failure modes** | Once locked, any JS fault, timeout, hot reload, or disconnect fails closed (never calls `unlock_and_destroy`). Before `locked` arrives, `z-shelld` must never claim the session is safely locked; recovery after a crash depends on compositor policy. |
| **Bounded `PrepareForSleep` delay** | `z-shelld` holds the `logind` delay inhibitor FD *before* `PrepareForSleep(true)` arrives and re-acquires it on wake. Because `logind` enforces `InhibitDelayMaxSec`, external suspend may proceed on timeout—`z-shelld` must report unacknowledged suspend explicitly rather than promising an absolute veto, whereas shell-initiated suspend may abort if locking fails. |
| **Optional fallback locker** | If no `zgui-js` host is connected when a lock is requested, `z-shelld` may spawn an explicit user-configured `fallback_locker` argv; spawning it is reported as fallback execution, not a host-verified `locked` ACK. |

## Considered Options

- **Running `dlopen("libpam.so.0")` in-process inside `z-shelld`:** Rejected (revised from initial draft following Noctalia's `pam_helper` pattern) because third-party PAM stacks can leak memory, block unpredictably, alter signal masks, or crash the entire desktop daemon.
- **Accepting lock ACKs or PAM RPCs on the Public bus channel:** Rejected because any same-UID CLI or script could spoof lock acknowledgement or intercept/replay unlock states.

## Consequences

- Both `z-shelld` and `zgui-js` fail closed independently: a UI crash keeps an acquired compositor lock engaged, and a daemon disconnect never emits an unlock approval.
- The lock protocol state machine is frozen and verified with mock `logind`/PAM/host tests before Phase 2 ABI freeze, while full PAM helper integration completes in Phase 7.
