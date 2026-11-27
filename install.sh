#!/usr/bin/env bash
set -euo pipefail
shopt -u patsub_replacement 2>/dev/null || true

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PREFIX=""
SYSTEMD_DIR_OVERRIDE=""
PAM_DIR_OVERRIDE=""
INSTALL_SYSTEMD=1
INSTALL_PAM=1
ENABLE_SYSTEMD=0
BUILD_STANDALONE=0
ENABLE_FIRST_PARTY=0
INIT_CONFIG=0
AUTO_START=1
RESTART_AFTER=0
SKIP_BUILD=0
OFFLINE=0
DOCTOR_ONLY=0
UNINSTALL=0
PURGE=0

usage() {
  cat <<'EOF'
z-shell local source installer (user-local XDG layout, no sudo)

Usage:
  ./install.sh [options]

Options:
  --prefix <DIR>          Install binaries to <DIR>/bin and assets to <DIR>/share/z-shell
                          (default: ${XDG_BIN_HOME:-~/.local/bin} and ${XDG_DATA_HOME:-~/.local/share}/z-shell)
  --systemd-dir <DIR>     Install systemd user units to <DIR>
                          (default: ${XDG_CONFIG_HOME:-~/.config}/systemd/user)
  --no-systemd            Do not install systemd --user unit files
  --enable-systemd        Run 'systemctl --user enable z-shelld.service z-shell-ui.service'
  --pam-dir <DIR>         Install PAM service configuration z-shell into <DIR>
                          (default: /etc/pam.d when writable; always staged at <DATADIR>/pam.d/z-shell)
  --no-pam                Do not install system PAM service configuration
  --standalone            Build a zero-plugin shell bundle (mutually exclusive with --enable-first-party)
  --enable-first-party    Register, approve, and enable all 3 first-party plugins before building
  --init-config           Create default settings.toml if it does not exist yet
  --no-start              Install only; do not auto-start or restart in an active Wayland session
  --restart               Force restart/reload in an active Wayland session
  --skip-build            Install already-built release binaries and shell bundle without rebuilding
  --offline               Pass --offline to cargo/bun where applicable
  --doctor, --check       Run preflight toolchain and runtime dependency checks, then exit
  --uninstall             Remove installed binaries, bundle, private host, and systemd user units
  --purge                 With --uninstall, also remove z-shell config, state, and cache directories
  -h, --help              Show this help message and exit
EOF
}

resolve_abs_path() {
  local p="$1"
  if [[ "$p" != /* ]]; then
    p="$PWD/$p"
  fi
  if [[ "$p" != "/" ]]; then
    p="${p%/}"
  fi
  printf '%s' "$p"
}

while (( $# > 0 )); do
  case "$1" in
    --prefix)
      if (( $# < 2 )) || [[ -z "$2" ]]; then
        echo "error: --prefix requires a directory argument" >&2
        exit 2
      fi
      PREFIX="$(resolve_abs_path "$2")"
      shift 2
      ;;
    --systemd-dir)
      if (( $# < 2 )) || [[ -z "$2" ]]; then
        echo "error: --systemd-dir requires a directory argument" >&2
        exit 2
      fi
      SYSTEMD_DIR_OVERRIDE="$(resolve_abs_path "$2")"
      shift 2
      ;;
    --no-systemd)
      INSTALL_SYSTEMD=0
      shift
      ;;
    --enable-systemd)
      ENABLE_SYSTEMD=1
      shift
      ;;
    --pam-dir)
      if (( $# < 2 )) || [[ -z "$2" ]]; then
        echo "error: --pam-dir requires a directory argument" >&2
        exit 2
      fi
      PAM_DIR_OVERRIDE="$(resolve_abs_path "$2")"
      shift 2
      ;;
    --no-pam)
      INSTALL_PAM=0
      shift
      ;;
    --standalone)
      BUILD_STANDALONE=1
      shift
      ;;
    --enable-first-party)
      ENABLE_FIRST_PARTY=1
      shift
      ;;
    --init-config)
      INIT_CONFIG=1
      shift
      ;;
    --no-start)
      AUTO_START=0
      shift
      ;;
    --restart)
      RESTART_AFTER=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --offline)
      OFFLINE=1
      shift
      ;;
    --doctor|--check)
      DOCTOR_ONLY=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    --purge)
      PURGE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "error: unknown option '$1' (run './install.sh --help')" >&2
      exit 2
      ;;
    *)
      echo "error: unexpected positional argument '$1' (run './install.sh --help')" >&2
      exit 2
      ;;
  esac
done

if (( BUILD_STANDALONE == 1 && ENABLE_FIRST_PARTY == 1 )); then
  echo "error: --standalone and --enable-first-party cannot be combined" >&2
  exit 2
fi

if (( PURGE == 1 && UNINSTALL == 0 )); then
  echo "error: --purge requires --uninstall" >&2
  exit 2
fi

if (( INSTALL_SYSTEMD == 0 && ENABLE_SYSTEMD == 1 )); then
  echo "error: --no-systemd and --enable-systemd cannot be combined" >&2
  exit 2
fi

if (( AUTO_START == 0 && RESTART_AFTER == 1 )); then
  echo "error: --no-start and --restart cannot be combined" >&2
  exit 2
fi

if [[ -n "$PREFIX" ]]; then
  BINDIR="$PREFIX/bin"
  DATADIR="$PREFIX/share/z-shell"
else
  BINDIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
  DATADIR="${XDG_DATA_HOME:-$HOME/.local/share}/z-shell"
fi

SYSTEMD_USER_DIR="${SYSTEMD_DIR_OVERRIDE:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/z-shell"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/z-shell"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/z-shell"

detect_distro_family() {
  local id="" id_like=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    id="${ID:-}"
    id_like="${ID_LIKE:-}"
  fi
  local combined=" $id $id_like "
  if [[ "$combined" == *" arch "* || "$combined" == *" cachyos "* || "$combined" == *" manjaro "* || "$combined" == *" endeavouros "* ]]; then
    echo "arch"
  elif [[ "$combined" == *" debian "* || "$combined" == *" ubuntu "* || "$combined" == *" pop "* ]]; then
    echo "debian"
  elif [[ "$combined" == *" fedora "* || "$combined" == *" rhel "* ]]; then
    echo "fedora"
  elif [[ "$combined" == *" nixos "* ]]; then
    echo "nixos"
  else
    echo "generic"
  fi
}

print_pkg_hint() {
  local family="$1" kind="$2"
  case "$family:$kind" in
    arch:toolchain)
      echo "  hint (Arch): pacman -S rustup bun base-devel (then 'rustup default stable')" >&2
      ;;
    arch:runtime)
      echo "  hint (Arch): pacman -S pam polkit vulkan-icd-loader" >&2
      ;;
    debian:toolchain)
      echo "  hint (Debian/Ubuntu): install rustup (https://rustup.rs) and bun (https://bun.sh)" >&2
      ;;
    debian:runtime)
      echo "  hint (Debian/Ubuntu): apt install libpam0g polkitd libvulkan1" >&2
      ;;
    fedora:toolchain)
      echo "  hint (Fedora): dnf install rust cargo (or rustup) and bun (https://bun.sh)" >&2
      ;;
    fedora:runtime)
      echo "  hint (Fedora): dnf install pam polkit vulkan-loader" >&2
      ;;
    nixos:*)
      echo "  hint (NixOS): add cargo, rustc, bun, linux-pam, polkit, vulkan-loader to your shell/system packages" >&2
      ;;
    *:toolchain)
      echo "  hint: install Rust >= 1.88 (https://rustup.rs) and Bun >= 1.4.4 (https://bun.sh)" >&2
      ;;
    *:runtime)
      echo "  hint: ensure libpam.so.0, polkit-agent-helper-1, and libvulkan.so.1 are installed via your distro package manager" >&2
      ;;
  esac
}

version_ge() {
  local actual="$1" required="$2"
  [[ "$(printf '%s\n%s\n' "$required" "$actual" | sort -V | head -n1)" == "$required" ]]
}

has_shared_lib() {
  local lib_name="$1"
  if command -v ldconfig >/dev/null 2>&1 && ldconfig -p 2>/dev/null | grep -Fq "$lib_name"; then
    return 0
  fi
  local dir
  for dir in /lib /usr/lib /usr/lib64 /lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu /lib/aarch64-linux-gnu /usr/lib/aarch64-linux-gnu /run/opengl-driver/lib; do
    if [[ -e "$dir/$lib_name" ]]; then
      return 0
    fi
  done
  return 1
}

find_polkit_helper() {
  if [[ -S /run/polkit/agent-helper.socket ]]; then
    printf '%s' "/run/polkit/agent-helper.socket"
    return 0
  fi
  local candidate
  for candidate in \
    /run/wrappers/bin/polkit-agent-helper-1 \
    /usr/lib/polkit-1/polkit-agent-helper-1 \
    /usr/libexec/polkit-agent-helper-1 \
    /usr/lib64/polkit-1/polkit-agent-helper-1 \
    /usr/lib/*-linux-gnu/polkit-1/polkit-agent-helper-1; do
    if [[ -x "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

run_preflight() {
  local family missing_fatal=0 missing_runtime=0
  family="$(detect_distro_family)"

  if [[ "$(uname -s)" != "Linux" ]]; then
    echo "error: z-shell only supports Linux Wayland desktops (detected: $(uname -s))" >&2
    exit 1
  fi

  if (( SKIP_BUILD == 0 )); then
    if ! command -v cargo >/dev/null 2>&1 || ! command -v rustc >/dev/null 2>&1; then
      echo "error: cargo and rustc (>= 1.88) are required to build z-shell" >&2
      missing_fatal=1
    else
      local rust_ver
      rust_ver="$(rustc --version | awk '{print $2}')"
      if ! version_ge "$rust_ver" "1.88.0"; then
        echo "error: rustc >= 1.88.0 is required (found $rust_ver)" >&2
        missing_fatal=1
      elif (( DOCTOR_ONLY == 1 )); then
        echo "ok: rustc $rust_ver"
      fi
    fi

    if ! command -v bun >/dev/null 2>&1; then
      echo "error: bun (>= 1.4.4) is required to build the z-shell UI bundle" >&2
      missing_fatal=1
    else
      local bun_ver
      bun_ver="$(bun --version | sed 's/^v//')"
      if ! version_ge "$bun_ver" "1.4.4"; then
        echo "error: bun >= 1.4.4 is required (found $bun_ver)" >&2
        missing_fatal=1
      elif (( DOCTOR_ONLY == 1 )); then
        echo "ok: bun $bun_ver"
      fi
    fi

    if (( missing_fatal == 1 )); then
      print_pkg_hint "$family" toolchain
      exit 1
    fi
  else
    local bin_name
    for bin_name in z-shelld z-shell z-shell-pam-helper; do
      if [[ ! -x "$REPO_ROOT/target/release/$bin_name" ]]; then
        echo "error: --skip-build requires prebuilt $REPO_ROOT/target/release/$bin_name" >&2
        missing_fatal=1
      fi
    done
    if [[ ! -f "$REPO_ROOT/apps/shell/dist/manifest.json" ]]; then
      echo "error: --skip-build requires prebuilt $REPO_ROOT/apps/shell/dist/manifest.json" >&2
      missing_fatal=1
    fi
    if [[ -z "${ZGUI_JS_HOST_EXECUTABLE:-}" ]] && ! command -v bun >/dev/null 2>&1; then
      echo "error: --skip-build requires bun (or ZGUI_JS_HOST_EXECUTABLE) to resolve zgui-host" >&2
      missing_fatal=1
    fi
    if (( missing_fatal == 1 )); then
      exit 1
    fi
  fi

  if ! has_shared_lib "libpam.so.0"; then
    echo "warning: libpam.so.0 not found; PAM lock-screen authentication will fail at runtime" >&2
    missing_runtime=1
  elif (( DOCTOR_ONLY == 1 )); then
    echo "ok: libpam.so.0"
  fi

  local polkit_path=""
  if polkit_path="$(find_polkit_helper)"; then
    if (( DOCTOR_ONLY == 1 )); then
      echo "ok: polkit-agent-helper-1 ($polkit_path)"
    fi
  else
    echo "warning: polkit-agent-helper-1 not found; Polkit prompt handling will be unavailable" >&2
    missing_runtime=1
  fi

  if ! has_shared_lib "libvulkan.so.1"; then
    echo "warning: libvulkan.so.1 not found; zgui-host GPU rendering requires a Vulkan ICD/loader" >&2
    missing_runtime=1
  elif (( DOCTOR_ONLY == 1 )); then
    echo "ok: libvulkan.so.1"
  fi

  if (( missing_runtime == 1 )); then
    print_pkg_hint "$family" runtime
  fi

  if (( DOCTOR_ONLY == 1 )); then
    local tool
    for tool in git systemctl dbus-daemon pactl fcitx5; do
      if command -v "$tool" >/dev/null 2>&1; then
        echo "ok: optional $tool ($(command -v "$tool"))"
      else
        echo "info: optional $tool not found in PATH"
      fi
    done
  fi
}

install_atomic_bin() {
  local src="$1" dest="$2"
  local tmp="${dest}.tmp.$$"
  install -m 0755 "$src" "$tmp"
  mv -f "$tmp" "$dest"
}

render_template_atomic() {
  local src="$1" dest="$2" mode="$3"
  local tmp="${dest}.tmp.$$"
  : > "$tmp"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line//@BINDIR@/$BINDIR}"
    line="${line//@DATADIR@/$DATADIR}"
    printf '%s\n' "$line" >> "$tmp"
  done < "$src"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
}

run_uninstall() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now z-shell-ui.service z-shelld.service >/dev/null 2>&1 || true
  fi

  rm -f \
    "$BINDIR/z-shelld" \
    "$BINDIR/z-shell" \
    "$BINDIR/z-shell-pam-helper" \
    "$BINDIR/z-shell-session" \
    "$SYSTEMD_USER_DIR/z-shelld.service" \
    "$SYSTEMD_USER_DIR/z-shell-ui.service"

  if [[ -n "$PAM_DIR_OVERRIDE" ]]; then
    rm -f "$PAM_DIR_OVERRIDE/z-shell"
  fi

  rm -rf "$DATADIR"

  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi

  if (( PURGE == 1 )); then
    chmod -R u+rwX "$STATE_DIR" 2>/dev/null || true
    rm -rf "$CONFIG_DIR" "$STATE_DIR" "$CACHE_DIR"
    echo "Uninstalled z-shell and purged config/state/cache directories."
  else
    echo "Uninstalled z-shell binaries, bundle, private host, and systemd user units."
    echo "Preserved user data under: $CONFIG_DIR, $STATE_DIR, $CACHE_DIR (pass --purge to remove)."
  fi
}

resolve_host_binary() {
  if [[ -n "${ZGUI_JS_HOST_EXECUTABLE:-}" ]]; then
    if [[ ! -x "$ZGUI_JS_HOST_EXECUTABLE" ]]; then
      echo "error: ZGUI_JS_HOST_EXECUTABLE is not executable: $ZGUI_JS_HOST_EXECUTABLE" >&2
      exit 1
    fi
    "$ZGUI_JS_HOST_EXECUTABLE" --version --json >/dev/null
    printf '%s' "$ZGUI_JS_HOST_EXECUTABLE"
    return 0
  fi

  local upstream_root=""
  if [[ -n "${ZGUI_ROOT:-}" ]]; then
    upstream_root="$(resolve_abs_path "$ZGUI_ROOT")"
  elif command -v bun >/dev/null 2>&1; then
    upstream_root="$(bun "$REPO_ROOT/tools/resolve-zgui-host.ts" --print-linked-root 2>/dev/null || true)"
  fi

  local resolved=""
  if [[ -n "$upstream_root" ]]; then
    if [[ ! -x "$upstream_root/target/release/zgui-host" ]]; then
      if (( SKIP_BUILD == 1 )); then
        echo "error: linked upstream zgui-host not built at $upstream_root/target/release/zgui-host (drop --skip-build or build it first)" >&2
        exit 1
      fi
      echo "Building linked upstream zgui-host in $upstream_root..." >&2
      local host_cargo_args=(build --release -p zgui-host)
      if (( OFFLINE == 1 )); then
        host_cargo_args+=(--offline)
      fi
      (cd "$upstream_root" && cargo "${host_cargo_args[@]}")
    fi
    resolved="$(ZGUI_ROOT="$upstream_root" bun "$REPO_ROOT/tools/resolve-zgui-host.ts")"
  else
    resolved="$(bun "$REPO_ROOT/tools/resolve-zgui-host.ts")"
  fi

  if [[ -z "$resolved" || ! -x "$resolved" ]]; then
    echo "error: failed to resolve an executable zgui-host binary" >&2
    exit 1
  fi
  "$resolved" --version --json >/dev/null
  printf '%s' "$resolved"
}

write_default_config_if_missing() {
  install -d -m 0700 "$CONFIG_DIR"
  local cfg="$CONFIG_DIR/settings.toml"
  if [[ -e "$cfg" ]]; then
    echo "Preserving existing user settings at $cfg"
    return 0
  fi

  local tmp="${cfg}.tmp.$$"
  cat > "$tmp" <<'EOF'
# z-shell User settings (hot-reloaded via: z-shell msg settings.reload)

[general]
offline_mode = false
log_level = "info"

[bar]
position = "top"
gaps = 14
clock_24h = true

[theme]
mode = "dark"            # "dark" | "light" | "auto"
variant = "tonal"        # "tonal" | "vibrant" | "expressive" | "fidelity" | "neutral" | "mono"
backend = "builtin"      # "builtin" | "matugen"
gtk_linking = false

[wallpaper]
directories = ["~/Pictures/wallpapers"]
fit = "cover"            # "cover" | "contain" | "fill" | "center"
sync_theme = true        # derive from global wallpaper when theme.seed_color is unset
slideshow_seconds = 0    # disabled; positive values rotate the global image

[ime]
mode = "indicator_only"  # "indicator_only" | "kimpanel" | "disabled"
candidate_layout = "auto"
switch_osd = true

[polkit]
enabled = true

[idle]
pre_action_fade_seconds = 2

[[idle.rules]]
name = "lock"
enabled = false
timeout_seconds = 600
action = "lock"

[[idle.rules]]
name = "screen-off"
enabled = false
timeout_seconds = 660
locked_timeout_seconds = 60
action = "screen_off"
EOF
  chmod 0600 "$tmp"
  mv -f "$tmp" "$cfg"
  echo "Created default user settings at $cfg"
}

if (( UNINSTALL == 1 )); then
  run_uninstall
  exit 0
fi

run_preflight
if (( DOCTOR_ONLY == 1 )); then
  echo "Preflight check passed."
  exit 0
fi

if (( SKIP_BUILD == 0 )); then
  if (( OFFLINE == 1 )) && [[ -d "$REPO_ROOT/node_modules" ]]; then
    echo "Skipping bun install (--offline with existing node_modules)."
  elif (( OFFLINE == 1 )); then
    (cd "$REPO_ROOT" && bun install --frozen-lockfile --offline)
  elif command -v git >/dev/null 2>&1 \
    && git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && git -C "$REPO_ROOT" diff --quiet HEAD -- package.json apps/shell/package.json packages/composer/package.json bun.lock 2>/dev/null; then
    (cd "$REPO_ROOT" && bun install --frozen-lockfile)
  else
    (cd "$REPO_ROOT" && bun install)
  fi

  CARGO_ARGS=(build --release --bins)
  if (( OFFLINE == 1 )); then
    CARGO_ARGS+=(--offline)
  fi
  (cd "$REPO_ROOT" && cargo "${CARGO_ARGS[@]}")
fi

ZGUI_HOST_BIN="$(resolve_host_binary)"
Z_SHELL_BIN="$REPO_ROOT/target/release/z-shell"

if (( ENABLE_FIRST_PARTY == 1 )); then
  for plugin_name in ai-usage niri-overview theme-bridges; do
    plugin_id="z-shell/$plugin_name"
    if "$Z_SHELL_BIN" --json plugin audit "$plugin_id" >/dev/null 2>&1; then
      "$Z_SHELL_BIN" plugin sync "$plugin_id" >/dev/null
    else
      "$Z_SHELL_BIN" plugin add --path "$REPO_ROOT/plugins/$plugin_name" >/dev/null
    fi
    "$Z_SHELL_BIN" plugin approve "$plugin_id" >/dev/null
    "$Z_SHELL_BIN" plugin enable "$plugin_id" >/dev/null
  done
elif (( BUILD_STANDALONE == 0 )) && [[ -x "$Z_SHELL_BIN" ]]; then
  for plugin_name in ai-usage niri-overview theme-bridges; do
    plugin_id="z-shell/$plugin_name"
    plugin_audit="$("$Z_SHELL_BIN" --json plugin audit "$plugin_id" 2>/dev/null || true)"
    if [[ -n "$plugin_audit" && "$plugin_audit" == *"\"source_identity\": \"path:$REPO_ROOT/plugins/$plugin_name\""* ]]; then
      "$Z_SHELL_BIN" plugin sync "$plugin_id" >/dev/null 2>&1 || true
    fi
  done
fi

if (( SKIP_BUILD == 0 )); then
  BUILD_ARGS=("$REPO_ROOT/tools/build-shell.ts")
  if (( BUILD_STANDALONE == 1 )); then
    BUILD_ARGS+=(--standalone)
  fi
  (cd "$REPO_ROOT" && bun "${BUILD_ARGS[@]}")
fi

install -d -m 0755 "$BINDIR" "$DATADIR" "$DATADIR/libexec" "$DATADIR/pam.d"

install_atomic_bin "$REPO_ROOT/target/release/z-shelld" "$BINDIR/z-shelld"
install_atomic_bin "$REPO_ROOT/target/release/z-shell" "$BINDIR/z-shell"
install_atomic_bin "$REPO_ROOT/target/release/z-shell-pam-helper" "$BINDIR/z-shell-pam-helper"
install_atomic_bin "$ZGUI_HOST_BIN" "$DATADIR/libexec/zgui-host"
render_template_atomic "$REPO_ROOT/tools/z-shell-session.sh" "$BINDIR/z-shell-session" 0755

stage_pam_config() {
  local dest="$1"
  local tmp="${dest}.tmp.$$"
  if [[ -r /etc/pam.d/common-auth && ! -r /etc/pam.d/system-auth ]]; then
    cat > "$tmp" <<'EOF'
#%PAM-1.0
# PAM configuration for z-shell lock-screen authentication (ADR-0004: pam_authenticate only).

auth       include      common-auth
account    include      common-account
password   include      common-password
session    include      common-session
EOF
    chmod 0644 "$tmp"
  else
    install -m 0644 "$REPO_ROOT/tools/pam.d/z-shell" "$tmp"
  fi
  mv -f "$tmp" "$dest"
}

stage_pam_config "$DATADIR/pam.d/z-shell"

INSTALLED_PAM_FILE=""
if (( INSTALL_PAM == 1 )); then
  TARGET_PAM_DIR=""
  if [[ -n "$PAM_DIR_OVERRIDE" ]]; then
    install -d -m 0755 "$PAM_DIR_OVERRIDE"
    TARGET_PAM_DIR="$PAM_DIR_OVERRIDE"
  elif [[ -d /etc/pam.d && -w /etc/pam.d ]]; then
    TARGET_PAM_DIR="/etc/pam.d"
  fi

  if [[ -n "$TARGET_PAM_DIR" ]]; then
    INSTALLED_PAM_FILE="$TARGET_PAM_DIR/z-shell"
    if [[ -e "$INSTALLED_PAM_FILE" ]]; then
      echo "Preserving existing PAM configuration at $INSTALLED_PAM_FILE"
    else
      stage_pam_config "$INSTALLED_PAM_FILE"
    fi
  fi
fi

STAGE_BUNDLE="$DATADIR/.bundle-stage.$$"
OLD_BUNDLE="$DATADIR/.bundle-old.$$"
rm -rf "$STAGE_BUNDLE" "$OLD_BUNDLE"
mkdir -p "$STAGE_BUNDLE"
cp -rL "$REPO_ROOT/apps/shell/dist/." "$STAGE_BUNDLE/"
if [[ -e "$DATADIR/bundle" || -L "$DATADIR/bundle" ]]; then
  mv "$DATADIR/bundle" "$OLD_BUNDLE"
fi
mv "$STAGE_BUNDLE" "$DATADIR/bundle"
rm -rf "$OLD_BUNDLE"

STAGE_PLUGINS="$DATADIR/.bundled-plugins-stage.$$"
OLD_PLUGINS="$DATADIR/.bundled-plugins-old.$$"
rm -rf "$STAGE_PLUGINS" "$OLD_PLUGINS"
mkdir -p "$STAGE_PLUGINS"
for plugin_name in ai-usage niri-overview theme-bridges; do
  mkdir -p "$STAGE_PLUGINS/$plugin_name"
  cp "$REPO_ROOT/plugins/$plugin_name/plugin.toml" "$STAGE_PLUGINS/$plugin_name/"
  cp -r "$REPO_ROOT/plugins/$plugin_name/src" "$STAGE_PLUGINS/$plugin_name/"
done
if [[ -e "$DATADIR/bundled-plugins" || -L "$DATADIR/bundled-plugins" ]]; then
  mv "$DATADIR/bundled-plugins" "$OLD_PLUGINS"
fi
mv "$STAGE_PLUGINS" "$DATADIR/bundled-plugins"
rm -rf "$OLD_PLUGINS"

if (( INSTALL_SYSTEMD == 1 )); then
  install -d -m 0755 "$SYSTEMD_USER_DIR"
  render_template_atomic "$REPO_ROOT/tools/systemd/z-shelld.service.in" "$SYSTEMD_USER_DIR/z-shelld.service" 0644
  render_template_atomic "$REPO_ROOT/tools/systemd/z-shell-ui.service.in" "$SYSTEMD_USER_DIR/z-shell-ui.service" 0644
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  if (( ENABLE_SYSTEMD == 1 )); then
    if ! command -v systemctl >/dev/null 2>&1; then
      echo "error: --enable-systemd requested, but systemctl was not found" >&2
      exit 1
    fi
    systemctl --user enable z-shelld.service z-shell-ui.service
  fi
fi

if (( INIT_CONFIG == 1 )); then
  write_default_config_if_missing
fi

has_active_wayland_session() {
  [[ -n "${XDG_RUNTIME_DIR:-}" && "${XDG_RUNTIME_DIR}" == /* && -n "${WAYLAND_DISPLAY:-}" && -S "${XDG_RUNTIME_DIR%/}/${WAYLAND_DISPLAY}" ]]
}

stop_standalone_session() {
  local ui_sock="$1" host_sock="$2"
  if command -v pkill >/dev/null 2>&1; then
    pkill -TERM -f -- "--control-socket $ui_sock" 2>/dev/null || true
  fi
  if [[ -S "$host_sock" ]]; then
    "$BINDIR/z-shell" --host --socket "$host_sock" msg quit >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 20); do
    if ! "$DATADIR/libexec/zgui-host" msg --control-socket "$ui_sock" ping >/dev/null 2>&1 && [[ ! -S "$host_sock" ]]; then
      break
    fi
    sleep 0.1
  done
}

start_or_restart_session() {
  local display_name="${WAYLAND_DISPLAY}"
  local runtime_subdir="${XDG_RUNTIME_DIR%/}/z-shell"
  local bus_sock="$runtime_subdir/bus-$display_name.sock"
  local ui_sock="$runtime_subdir/ui-$display_name.sock"
  local host_sock="$runtime_subdir/host-$display_name.sock"
  local used_systemd=0

  if (( INSTALL_SYSTEMD == 1 )) && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    used_systemd=1
    local import_vars=(WAYLAND_DISPLAY XDG_RUNTIME_DIR)
    if [[ -n "${NIRI_SOCKET:-}" ]]; then
      import_vars+=(NIRI_SOCKET)
    fi
    if [[ -n "${XDG_CURRENT_DESKTOP:-}" ]]; then
      import_vars+=(XDG_CURRENT_DESKTOP)
    fi
    systemctl --user import-environment "${import_vars[@]}" >/dev/null 2>&1 || true

    if ! systemctl --user is-active --quiet z-shell-ui.service \
      && "$DATADIR/libexec/zgui-host" msg --control-socket "$ui_sock" ping >/dev/null 2>&1; then
      if command -v pkill >/dev/null 2>&1; then
        pkill -TERM -f -- "--control-socket $ui_sock" 2>/dev/null || true
      fi
      if ! systemctl --user is-active --quiet z-shelld.service && [[ -S "$host_sock" ]]; then
        "$BINDIR/z-shell" --host --socket "$host_sock" msg quit >/dev/null 2>&1 || true
      fi
      for _ in $(seq 1 20); do
        if ! "$DATADIR/libexec/zgui-host" msg --control-socket "$ui_sock" ping >/dev/null 2>&1; then
          break
        fi
        sleep 0.1
      done
    fi

    systemctl --user restart z-shelld.service z-shell-ui.service
  else
    if "$DATADIR/libexec/zgui-host" msg --control-socket "$ui_sock" ping >/dev/null 2>&1 || [[ -S "$host_sock" ]]; then
      stop_standalone_session "$ui_sock" "$host_sock"
    fi
    nohup "$BINDIR/z-shell-session" >/dev/null 2>&1 </dev/null &
  fi

  local ready=0
  for _ in $(seq 1 50); do
    if "$BINDIR/z-shell" --socket "$bus_sock" status >/dev/null 2>&1 \
      && "$DATADIR/libexec/zgui-host" msg --control-socket "$ui_sock" ping >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.1
  done

  if (( ready == 1 )); then
    echo "Session active on $display_name (z-shelld + zgui-host running)."
  else
    echo "error: z-shell failed to become ready on $display_name within 5s" >&2
    if (( used_systemd == 1 )); then
      echo "Check logs with: journalctl --user -u z-shelld.service -u z-shell-ui.service -n 25 --no-pager" >&2
    fi
    exit 1
  fi
}

if (( AUTO_START == 1 || RESTART_AFTER == 1 )) && has_active_wayland_session; then
  start_or_restart_session
fi

cat <<EOF

Installed z-shell:
  Binaries:        $BINDIR/{z-shelld,z-shell,z-shell-pam-helper,z-shell-session}
  Shell bundle:    $DATADIR/bundle
  Private host:    $DATADIR/libexec/zgui-host
  First-party ref: $DATADIR/bundled-plugins
EOF

if (( INSTALL_SYSTEMD == 1 )); then
  echo "  Systemd units:   $SYSTEMD_USER_DIR/{z-shelld.service,z-shell-ui.service}"
fi
if [[ -n "$INSTALLED_PAM_FILE" ]]; then
  echo "  PAM config:      $INSTALLED_PAM_FILE"
else
  echo "  PAM reference:   $DATADIR/pam.d/z-shell"
  if (( INSTALL_PAM == 1 )) && [[ ! -r /etc/pam.d/z-shell && ! -r /usr/lib/pam.d/z-shell && ! -r /lib/pam.d/z-shell ]]; then
    echo "                   (optional system install: sudo install -Dm644 \"$DATADIR/pam.d/z-shell\" /etc/pam.d/z-shell)"
  fi
fi

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *)
    echo ""
    echo "Note: $BINDIR is not in your current PATH. Add it to your shell profile:"
    echo "  export PATH=\"$BINDIR:\$PATH\""
    ;;
esac

cat <<'EOF'

Start session:
  Direct (e.g. Niri spawn-at-startup): z-shell-session
  systemd --user:                      systemctl --user enable --now z-shelld.service z-shell-ui.service

UI hotkeys:
  z-shell-session msg panel launcher
  z-shell-session msg panel clipboard
  z-shell-session msg settings
  z-shell-session msg monitor
  z-shell-session msg power lock
EOF
