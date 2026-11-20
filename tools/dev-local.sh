#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZGUI_ROOT="${ZGUI_ROOT:-$(cd "$REPO_ROOT/../zgui-js" && pwd)}"

if [[ -x "$REPO_ROOT/target/release/z-shelld" ]]; then
  Z_SHELLD="$REPO_ROOT/target/release/z-shelld"
elif [[ -x "$REPO_ROOT/target/debug/z-shelld" ]]; then
  echo "warning: using debug z-shelld (build release with: cargo build --release --bins --offline)" >&2
  Z_SHELLD="$REPO_ROOT/target/debug/z-shelld"
else
  echo "error: z-shelld binary not found; build with: cargo build --release --bins --offline" >&2
  exit 1
fi

if [[ -x "$ZGUI_ROOT/target/release/native-host" ]]; then
  NATIVE_HOST="$ZGUI_ROOT/target/release/native-host"
elif [[ -x "$ZGUI_ROOT/target/debug/native-host" ]]; then
  echo "warning: using debug native-host (build release with: cargo build --release --manifest-path ../zgui-js/Cargo.toml -p native-host --offline)" >&2
  NATIVE_HOST="$ZGUI_ROOT/target/debug/native-host"
else
  echo "error: native-host binary not found; build with: cargo build --release --manifest-path ../zgui-js/Cargo.toml -p native-host --offline" >&2
  exit 1
fi

if [[ ! -d "$REPO_ROOT/apps/shell/dist" ]]; then
  bun run --cwd "$REPO_ROOT" build:shell
fi

CONTROL_SOCK="${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}/zgui-js/dev.zshell.shell.sock"
if [[ -S "$CONTROL_SOCK" ]] && ! pgrep -x native-host >/dev/null 2>&1; then
  rm -f "$CONTROL_SOCK"
fi

DAEMON_PID=""
cleanup() {
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

"$Z_SHELLD" &
DAEMON_PID=$!

BUS_SOCK="$XDG_RUNTIME_DIR/z-shell/bus-${WAYLAND_DISPLAY:-wayland-0}.sock"
for _ in $(seq 1 50); do
  [[ -S "$BUS_SOCK" ]] && break
  sleep 0.1
done

HOST_ARGS=(--pure-shell --watch --bundle "$REPO_ROOT/apps/shell/dist")
if [[ -n "${NIRI_SOCKET:-}" ]]; then
  HOST_ARGS+=(--bind-socket "niri=$NIRI_SOCKET")
fi

echo "Starting native-host ($NATIVE_HOST) with --watch."
echo "Control CLI: $NATIVE_HOST msg --app-id dev.zshell.shell <command>"
"$NATIVE_HOST" "${HOST_ARGS[@]}"
