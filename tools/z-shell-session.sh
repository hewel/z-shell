#!/usr/bin/env bash
set -euo pipefail

DEFAULT_BINDIR="@BINDIR@"
DEFAULT_DATADIR="@DATADIR@"

if [[ "$DEFAULT_BINDIR" == "@""BINDIR@" ]]; then
  DEFAULT_BINDIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
fi
if [[ "$DEFAULT_DATADIR" == "@""DATADIR@" ]]; then
  DEFAULT_DATADIR="${XDG_DATA_HOME:-$HOME/.local/share}/z-shell"
fi

BINDIR="${Z_SHELL_BINDIR:-$DEFAULT_BINDIR}"
DATADIR="${Z_SHELL_DATADIR:-$DEFAULT_DATADIR}"
Z_SHELLD="${Z_SHELLD_EXECUTABLE:-$BINDIR/z-shelld}"
Z_SHELL_CLI="${Z_SHELL_CLI_EXECUTABLE:-$BINDIR/z-shell}"
ZGUI_HOST="${ZGUI_JS_HOST_EXECUTABLE:-$DATADIR/libexec/zgui-host}"
BUNDLE_DIR="${Z_SHELL_BUNDLE_DIR:-$DATADIR/bundle}"

usage() {
  cat <<'EOF'
Usage:
  z-shell-session [--ui-only] [-- <zgui-host-args...>]
  z-shell-session msg <command> [args...]

Commands:
  msg <command> [args...]   Send a UI control command to the active zgui-host
                            (for example: panel launcher, panel clipboard,
                             settings, monitor, power lock, status, ping)

Options:
  --ui-only                 Wait for an existing z-shelld bus socket and exec
                            zgui-host directly (used by z-shell-ui.service)
  -h, --help                Show this help message and exit
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "${XDG_RUNTIME_DIR:-}" || "${XDG_RUNTIME_DIR}" != /* ]]; then
  echo "z-shell-session: XDG_RUNTIME_DIR must be set to an absolute path" >&2
  exit 1
fi

DISPLAY_NAME="${WAYLAND_DISPLAY:-wayland-0}"
if [[ -z "$DISPLAY_NAME" || "$DISPLAY_NAME" == "." || "$DISPLAY_NAME" == ".." || "$DISPLAY_NAME" == *"/"* || "$DISPLAY_NAME" == *"\\"* || "$DISPLAY_NAME" =~ [[:space:][:cntrl:]] ]]; then
  echo "z-shell-session: invalid WAYLAND_DISPLAY value: '$DISPLAY_NAME'" >&2
  exit 2
fi

RUNTIME_DIR="${XDG_RUNTIME_DIR%/}/z-shell"
BUS_SOCK="$RUNTIME_DIR/bus-$DISPLAY_NAME.sock"
UI_SOCK="$RUNTIME_DIR/ui-$DISPLAY_NAME.sock"
BYTECODE_CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/z-shell/plugin-bytecode"

if [[ "${1:-}" == "msg" ]]; then
  shift
  if (( $# == 0 )); then
    echo "z-shell-session: msg requires a command (run 'z-shell-session --help')" >&2
    exit 2
  fi
  if [[ ! -x "$ZGUI_HOST" ]]; then
    echo "z-shell-session: zgui-host executable not found at $ZGUI_HOST" >&2
    exit 1
  fi
  exec "$ZGUI_HOST" msg --control-socket "$UI_SOCK" "$@"
fi

UI_ONLY=0
EXTRA_ARGS=()
while (( $# > 0 )); do
  case "$1" in
    --ui-only)
      UI_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      EXTRA_ARGS=("$@")
      break
      ;;
    -*)
      echo "z-shell-session: unknown option '$1' (run 'z-shell-session --help')" >&2
      exit 2
      ;;
    *)
      echo "z-shell-session: unexpected argument '$1' (run 'z-shell-session --help')" >&2
      exit 2
      ;;
  esac
done

install -d -m 0700 "$RUNTIME_DIR" "$BYTECODE_CACHE_DIR"
chmod 0700 "$RUNTIME_DIR" "$BYTECODE_CACHE_DIR"

if [[ ! -x "$ZGUI_HOST" ]]; then
  echo "z-shell-session: zgui-host executable not found at $ZGUI_HOST" >&2
  exit 1
fi

if [[ ! -f "$BUNDLE_DIR/manifest.json" ]]; then
  echo "z-shell-session: shell bundle manifest not found at $BUNDLE_DIR/manifest.json" >&2
  exit 1
fi

if [[ -e "$UI_SOCK" || -S "$UI_SOCK" ]]; then
  if "$ZGUI_HOST" msg --control-socket "$UI_SOCK" ping >/dev/null 2>&1; then
    echo "z-shell-session: UI host is already active at $UI_SOCK" >&2
    exit 75
  fi
  rm -f "$UI_SOCK"
fi

OWNED_DAEMON_PID=""
UI_PID=""
CLEANED_UP=0

cleanup() {
  if (( CLEANED_UP )); then
    return
  fi
  CLEANED_UP=1
  if [[ -n "$UI_PID" ]] && kill -0 "$UI_PID" 2>/dev/null; then
    kill -TERM "$UI_PID" 2>/dev/null || true
    wait "$UI_PID" 2>/dev/null || true
  fi
  if [[ -n "$OWNED_DAEMON_PID" ]] && kill -0 "$OWNED_DAEMON_PID" 2>/dev/null; then
    kill -TERM "$OWNED_DAEMON_PID" 2>/dev/null || true
    wait "$OWNED_DAEMON_PID" 2>/dev/null || true
  fi
}

DAEMON_READY=0
if [[ -x "$Z_SHELL_CLI" && -S "$BUS_SOCK" ]] && "$Z_SHELL_CLI" --socket "$BUS_SOCK" status >/dev/null 2>&1; then
  DAEMON_READY=1
fi

if (( DAEMON_READY == 0 && UI_ONLY == 0 )); then
  if [[ ! -x "$Z_SHELLD" ]]; then
    echo "z-shell-session: z-shelld executable not found at $Z_SHELLD" >&2
    exit 1
  fi
  trap cleanup EXIT INT TERM
  "$Z_SHELLD" &
  OWNED_DAEMON_PID=$!
fi

for _ in $(seq 1 50); do
  if [[ -S "$BUS_SOCK" ]]; then
    break
  fi
  if [[ -n "$OWNED_DAEMON_PID" ]] && ! kill -0 "$OWNED_DAEMON_PID" 2>/dev/null; then
    echo "z-shell-session: z-shelld exited before creating $BUS_SOCK" >&2
    exit 1
  fi
  sleep 0.1
done

if [[ ! -S "$BUS_SOCK" ]]; then
  echo "z-shell-session: timed out waiting for daemon bus socket at $BUS_SOCK" >&2
  exit 1
fi

HOST_ARGS=(
  --pure-shell
  --bundle "$BUNDLE_DIR"
  --control-socket "$UI_SOCK"
  --bytecode-cache-dir "$BYTECODE_CACHE_DIR"
)

if [[ -n "${NIRI_SOCKET:-}" && -S "${NIRI_SOCKET}" ]]; then
  HOST_ARGS+=(--bind-socket "niri=$NIRI_SOCKET")
fi

if (( ${#EXTRA_ARGS[@]} > 0 )); then
  HOST_ARGS+=("${EXTRA_ARGS[@]}")
fi

if [[ -z "$OWNED_DAEMON_PID" ]]; then
  exec "$ZGUI_HOST" "${HOST_ARGS[@]}"
fi

"$ZGUI_HOST" "${HOST_ARGS[@]}" &
UI_PID=$!

set +e
wait "$UI_PID"
UI_STATUS=$?
set -e
UI_PID=""
exit "$UI_STATUS"
