import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { detectLinkedZguiRoot } from "../../../tools/resolve-zgui-host.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

function removeTempTree(target: string): void {
  try {
    chmodSync(target, 0o700);
  } catch {
    // Ignore missing directory.
  }
  rmSync(target, { recursive: true, force: true });
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function createFakeRepo(root: string): {
  readonly mockHost: string;
} {
  mkdirSync(join(root, "tools", "systemd"), { recursive: true });
  mkdirSync(join(root, "target", "release"), { recursive: true });
  mkdirSync(join(root, "apps", "shell", ".zgui-generations", "gen-1"), { recursive: true });

  cpSync(join(REPO_ROOT, "install.sh"), join(root, "install.sh"));
  cpSync(join(REPO_ROOT, "tools", "z-shell-session.sh"), join(root, "tools", "z-shell-session.sh"));
  cpSync(
    join(REPO_ROOT, "tools", "systemd", "z-shelld.service.in"),
    join(root, "tools", "systemd", "z-shelld.service.in"),
  );
  cpSync(
    join(REPO_ROOT, "tools", "systemd", "z-shell-ui.service.in"),
    join(root, "tools", "systemd", "z-shell-ui.service.in"),
  );

  for (const plugin of ["ai-usage", "niri-overview", "theme-bridges"]) {
    const pluginDest = join(root, "plugins", plugin);
    mkdirSync(pluginDest, { recursive: true });
    cpSync(join(REPO_ROOT, "plugins", plugin, "plugin.toml"), join(pluginDest, "plugin.toml"));
    cpSync(join(REPO_ROOT, "plugins", plugin, "src"), join(pluginDest, "src"), { recursive: true });
  }

  for (const bin of ["z-shelld", "z-shell", "z-shell-pam-helper"]) {
    writeExecutable(join(root, "target", "release", bin), `#!/usr/bin/env bash\necho "${bin} ok"\n`);
  }

  writeFileSync(
    join(root, "apps", "shell", ".zgui-generations", "gen-1", "manifest.json"),
    JSON.stringify({ id: "dev.zshell.shell" }),
  );
  symlinkSync(".zgui-generations/gen-1", join(root, "apps", "shell", "dist"), "dir");

  const mockHost = join(root, "mock-zgui-host");
  writeExecutable(
    mockHost,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  echo '{"name":"zgui-host","version":"0.1.2","hostApiVersion":1,"schemaVersion":2}'
  exit 0
fi
exit 0
`,
  );

  return { mockHost };
}

async function createUnixSocket(path: string): Promise<() => void> {
  const server = createServer();
  await new Promise<void>((resolveReady, rejectReady) => {
    server.once("error", rejectReady);
    server.listen(path, () => resolveReady());
  });
  return () => {
    server.close();
  };
}

describe("install.sh and z-shell-session", () => {
  test("detectLinkedZguiRoot resolves link: Cargo workspace and ignores semver specs", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "z-shell-linked-root-"));
    try {
      const upstream = join(tempDir, "zgui-js");
      mkdirSync(join(upstream, "crates", "zgui-host"), { recursive: true });
      mkdirSync(join(upstream, "packages", "build"), { recursive: true });
      writeFileSync(join(upstream, "Cargo.toml"), "[workspace]\n");
      writeFileSync(join(upstream, "crates", "zgui-host", "Cargo.toml"), "[package]\nname = \"zgui-host\"\n");

      const linkedRepo = join(tempDir, "linked-repo");
      mkdirSync(linkedRepo, { recursive: true });
      writeFileSync(
        join(linkedRepo, "package.json"),
        JSON.stringify({
          devDependencies: { "@hewel/zgui-build": "link:../zgui-js/packages/build" },
        }),
      );
      expect(detectLinkedZguiRoot(linkedRepo)).toBe(upstream);

      const registryRepo = join(tempDir, "registry-repo");
      mkdirSync(registryRepo, { recursive: true });
      writeFileSync(
        join(registryRepo, "package.json"),
        JSON.stringify({
          devDependencies: { "@hewel/zgui-build": "0.1.0" },
        }),
      );
      expect(detectLinkedZguiRoot(registryRepo)).toBeNull();
    } finally {
      removeTempTree(tempDir);
    }
  });

  test("shell scripts pass bash -n syntax check", () => {
    for (const rel of ["install.sh", "tools/z-shell-session.sh"]) {
      const res = Bun.spawnSync(["bash", "-n", join(REPO_ROOT, rel)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(res.exitCode, `${rel}: ${res.stderr.toString()}`).toBe(0);
    }
  });

  test("install.sh --skip-build installs dereferenced bundle, stamps units, preserves settings, and uninstalls/purges cleanly", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "z-shell-install-test-"));
    try {
      const fakeRepo = join(tempDir, "repo");
      const { mockHost } = createFakeRepo(fakeRepo);
      const xdgHome = join(tempDir, "home");
      const binDir = join(xdgHome, ".local", "bin");
      const dataDir = join(xdgHome, ".local", "share");
      const configDir = join(xdgHome, ".config");
      const stateDir = join(xdgHome, ".local", "state");
      const cacheDir = join(xdgHome, ".cache");
      const systemdDir = join(configDir, "systemd", "user");

      const env = {
        ...process.env,
        HOME: xdgHome,
        XDG_BIN_HOME: binDir,
        XDG_DATA_HOME: dataDir,
        XDG_CONFIG_HOME: configDir,
        XDG_STATE_HOME: stateDir,
        XDG_CACHE_HOME: cacheDir,
        XDG_RUNTIME_DIR: join(tempDir, "runtime"),
        WAYLAND_DISPLAY: "",
        ZGUI_JS_HOST_EXECUTABLE: mockHost,
      };

      const conflictRes = Bun.spawnSync(
        [join(fakeRepo, "install.sh"), "--no-start", "--restart"],
        { cwd: fakeRepo, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(conflictRes.exitCode).toBe(2);

      const installRes = Bun.spawnSync(
        [join(fakeRepo, "install.sh"), "--skip-build", "--init-config", "--systemd-dir", systemdDir],
        { cwd: fakeRepo, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(installRes.exitCode, installRes.stderr.toString()).toBe(0);

      for (const bin of ["z-shelld", "z-shell", "z-shell-pam-helper", "z-shell-session"]) {
        expect(existsSync(join(binDir, bin))).toBe(true);
      }

      const installedBundle = join(dataDir, "z-shell", "bundle");
      expect(lstatSync(installedBundle).isSymbolicLink()).toBe(false);
      expect(existsSync(join(installedBundle, "manifest.json"))).toBe(true);
      expect(existsSync(join(dataDir, "z-shell", "libexec", "zgui-host"))).toBe(true);
      expect(existsSync(join(dataDir, "z-shell", "bundled-plugins", "ai-usage", "plugin.toml"))).toBe(true);

      const unitDaemon = readFileSync(join(systemdDir, "z-shelld.service"), "utf8");
      const unitUi = readFileSync(join(systemdDir, "z-shell-ui.service"), "utf8");
      expect(unitDaemon).toContain(`ExecStart="${binDir}/z-shelld"`);
      expect(unitUi).toContain(`ExecStart="${binDir}/z-shell-session" --ui-only`);
      expect(unitUi).toContain("RestartPreventExitStatus=75");

      const settingsFile = join(configDir, "z-shell", "settings.toml");
      expect(statSync(settingsFile).mode & 0o777).toBe(0o600);
      writeFileSync(settingsFile, "# custom user edit\n");

      // Re-running with --init-config --no-systemd must preserve user settings.toml.
      const altSystemdDir = join(tempDir, "alt-systemd");
      const reinstallRes = Bun.spawnSync(
        [join(fakeRepo, "install.sh"), "--skip-build", "--init-config", "--no-systemd", "--systemd-dir", altSystemdDir],
        { cwd: fakeRepo, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(reinstallRes.exitCode, reinstallRes.stderr.toString()).toBe(0);
      expect(readFileSync(settingsFile, "utf8")).toBe("# custom user edit\n");
      expect(existsSync(join(altSystemdDir, "z-shelld.service"))).toBe(false);

      // Prepare read-only plugin bundle in state dir to verify uninstall vs purge.
      const roBundleDir = join(stateDir, "z-shell", "plugins", "bundles", "z-shell__ai-usage", "sha256_abc");
      mkdirSync(roBundleDir, { recursive: true });
      writeFileSync(join(roBundleDir, "plugin.toml"), "id = \"z-shell/ai-usage\"\n", { mode: 0o444 });
      chmodSync(roBundleDir, 0o555);
      mkdirSync(join(cacheDir, "z-shell"), { recursive: true });
      writeFileSync(join(cacheDir, "z-shell", "marker"), "cached");

      const uninstallRes = Bun.spawnSync(
        [join(fakeRepo, "install.sh"), "--uninstall", "--systemd-dir", systemdDir],
        { cwd: fakeRepo, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(uninstallRes.exitCode, uninstallRes.stderr.toString()).toBe(0);
      expect(existsSync(join(binDir, "z-shell-session"))).toBe(false);
      expect(existsSync(join(dataDir, "z-shell"))).toBe(false);
      expect(existsSync(join(systemdDir, "z-shelld.service"))).toBe(false);
      expect(existsSync(settingsFile)).toBe(true);
      expect(existsSync(roBundleDir)).toBe(true);

      const purgeRes = Bun.spawnSync(
        [join(fakeRepo, "install.sh"), "--uninstall", "--purge", "--systemd-dir", systemdDir],
        { cwd: fakeRepo, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(purgeRes.exitCode, purgeRes.stderr.toString()).toBe(0);
      expect(existsSync(join(configDir, "z-shell"))).toBe(false);
      expect(existsSync(join(stateDir, "z-shell"))).toBe(false);
      expect(existsSync(join(cacheDir, "z-shell"))).toBe(false);
    } finally {
      removeTempTree(tempDir);
    }
  });

  test("install.sh auto-starts on active Wayland session unless --no-start is passed", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "z-shell-autostart-test-"));
    const pidFiles: string[] = [];
    let closeWayland: (() => void) | null = null;
    try {
      const fakeRepo = join(tempDir, "repo");
      createFakeRepo(fakeRepo);

      const xdgHome = join(tempDir, "home");
      const binDir = join(xdgHome, ".local", "bin");
      const dataDir = join(xdgHome, ".local", "share");
      const configDir = join(xdgHome, ".config");
      const stateDir = join(xdgHome, ".local", "state");
      const cacheDir = join(xdgHome, ".cache");
      const runtimeDir = join(tempDir, "runtime");
      mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
      chmodSync(runtimeDir, 0o700);

      const waylandSock = join(runtimeDir, "wayland-live");
      closeWayland = await createUnixSocket(waylandSock);

      const busSock = join(runtimeDir, "z-shell", "bus-wayland-live.sock");
      const startedMarker = join(tempDir, "session-started");
      const uiReadyFlag = join(tempDir, "ui-ready");
      const daemonPidFile = join(tempDir, "daemon.pid");
      const uiPidFile = join(tempDir, "ui.pid");
      pidFiles.push(uiPidFile, daemonPidFile);

      writeExecutable(
        join(fakeRepo, "target", "release", "z-shelld"),
        `#!/usr/bin/env bash
echo $$ > ${JSON.stringify(daemonPidFile)}
mkdir -p ${JSON.stringify(join(runtimeDir, "z-shell"))}
bun -e 'require("node:net").createServer().listen(process.argv[1]); setInterval(() => {}, 1000);' ${JSON.stringify(busSock)} &
CHILD=$!
trap 'kill -TERM "$CHILD" 2>/dev/null || true; wait "$CHILD" 2>/dev/null || true; exit 0' TERM INT
wait "$CHILD"
`,
      );

      writeExecutable(
        join(fakeRepo, "target", "release", "z-shell"),
        `#!/usr/bin/env bash
if [[ "\${*}" == *"status"* && -S ${JSON.stringify(busSock)} ]]; then
  exit 0
fi
exit 1
`,
      );

      const mockHost = join(fakeRepo, "mock-zgui-host");
      writeExecutable(
        mockHost,
        `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  echo '{"name":"zgui-host","version":"0.1.2","hostApiVersion":1,"schemaVersion":2}'
  exit 0
fi
if [[ "\${1:-}" == "msg" ]]; then
  if [[ -f ${JSON.stringify(uiReadyFlag)} ]]; then
    exit 0
  fi
  exit 1
fi
echo $$ > ${JSON.stringify(uiPidFile)}
touch ${JSON.stringify(uiReadyFlag)}
echo started > ${JSON.stringify(startedMarker)}
sleep 30 &
CHILD=$!
trap 'kill -TERM "$CHILD" 2>/dev/null || true; wait "$CHILD" 2>/dev/null || true; exit 0' TERM INT
wait "$CHILD"
`,
      );

      const env = {
        ...process.env,
        HOME: xdgHome,
        XDG_BIN_HOME: binDir,
        XDG_DATA_HOME: dataDir,
        XDG_CONFIG_HOME: configDir,
        XDG_STATE_HOME: stateDir,
        XDG_CACHE_HOME: cacheDir,
        XDG_RUNTIME_DIR: runtimeDir,
        WAYLAND_DISPLAY: "wayland-live",
        NIRI_SOCKET: "",
        ZGUI_JS_HOST_EXECUTABLE: mockHost,
      };

      const noStartRes = Bun.spawnSync(
        [join(fakeRepo, "install.sh"), "--skip-build", "--no-systemd", "--no-start"],
        { cwd: fakeRepo, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(noStartRes.exitCode, noStartRes.stderr.toString()).toBe(0);
      expect(existsSync(startedMarker)).toBe(false);

      const autoStartRes = Bun.spawnSync(
        [join(fakeRepo, "install.sh"), "--skip-build", "--no-systemd"],
        { cwd: fakeRepo, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(autoStartRes.exitCode, autoStartRes.stderr.toString()).toBe(0);
      expect(autoStartRes.stdout.toString()).toContain("Session active on wayland-live");
      expect(existsSync(startedMarker)).toBe(true);
    } finally {
      for (const pidFile of pidFiles) {
        if (existsSync(pidFile)) {
          const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
          if (Number.isFinite(pid) && pid > 0) {
            try {
              process.kill(pid, "SIGTERM");
            } catch {
              // Ignore already-exited process.
            }
          }
        }
      }
      closeWayland?.();
      removeTempTree(tempDir);
    }
  });

  test("z-shell-session handles msg forwarding, validation, stale sockets, live conflicts, and daemon lifecycle", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "z-shell-session-test-"));
    try {
      const binDir = join(tempDir, "bin");
      const dataDir = join(tempDir, "data");
      const runtimeBase = join(tempDir, "runtime");
      const cacheHome = join(tempDir, "cache");
      const bundleDir = join(dataDir, "bundle");
      const libexecDir = join(dataDir, "libexec");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(bundleDir, { recursive: true });
      mkdirSync(libexecDir, { recursive: true });
      mkdirSync(runtimeBase, { recursive: true });
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify({ id: "dev.zshell.shell" }));

      const sessionScript = join(binDir, "z-shell-session");
      const rawScript = readFileSync(join(REPO_ROOT, "tools", "z-shell-session.sh"), "utf8")
        .replaceAll("@BINDIR@", binDir)
        .replaceAll("@DATADIR@", dataDir);
      writeExecutable(sessionScript, rawScript);

      const hostLog = join(tempDir, "host-args.log");
      const mockHost = join(libexecDir, "zgui-host");
      writeExecutable(
        mockHost,
        `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(hostLog)}
if [[ "\${1:-}" == "msg" ]]; then
  if [[ "\${MOCK_PING_OK:-0}" == "1" ]]; then
    exit 0
  fi
  exit 1
fi
exit 0
`,
      );

      const baseEnv: Record<string, string> = {
        ...process.env,
        HOME: tempDir,
        XDG_RUNTIME_DIR: runtimeBase,
        XDG_CACHE_HOME: cacheHome,
        WAYLAND_DISPLAY: "wayland-test",
        NIRI_SOCKET: "",
      };

      // 1. Missing XDG_RUNTIME_DIR and path traversal WAYLAND_DISPLAY are rejected.
      const noRuntimeEnv = { ...baseEnv };
      delete noRuntimeEnv.XDG_RUNTIME_DIR;
      const missingRuntime = Bun.spawnSync([sessionScript, "msg", "ping"], {
        env: noRuntimeEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(missingRuntime.exitCode).toBe(1);

      const badDisplay = Bun.spawnSync([sessionScript, "msg", "ping"], {
        env: { ...baseEnv, WAYLAND_DISPLAY: "../escape" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(badDisplay.exitCode).toBe(2);

      // 2. msg forwards strictly with --control-socket and without --app-id.
      const uiSock = join(runtimeBase, "z-shell", "ui-wayland-test.sock");
      const msgRes = Bun.spawnSync([sessionScript, "msg", "panel", "launcher"], {
        env: { ...baseEnv, MOCK_PING_OK: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(msgRes.exitCode, msgRes.stderr.toString()).toBe(0);
      const recordedMsg = readFileSync(hostLog, "utf8").trim().split("\n").pop() ?? "";
      expect(recordedMsg).toBe(`msg --control-socket ${uiSock} panel launcher`);
      expect(recordedMsg).not.toContain("--app-id");

      // 3. Stale UI socket is unlinked and NIRI_SOCKET is forwarded when live.
      mkdirSync(join(runtimeBase, "z-shell"), { recursive: true, mode: 0o700 });
      writeFileSync(uiSock, "stale");
      const niriSock = join(tempDir, "niri.sock");
      const closeNiri = await createUnixSocket(niriSock);

      const busSock = join(runtimeBase, "z-shell", "bus-wayland-test.sock");
      const closeBus = await createUnixSocket(busSock);
      writeExecutable(
        join(binDir, "z-shell"),
        `#!/usr/bin/env bash
if [[ "\${*}" == *"status"* ]]; then
  exit 0
fi
exit 1
`,
      );

      writeFileSync(hostLog, "");
      const reuseRes = Bun.spawnSync([sessionScript], {
        env: { ...baseEnv, MOCK_PING_OK: "0", NIRI_SOCKET: niriSock },
        stdout: "pipe",
        stderr: "pipe",
      });
      closeNiri();
      closeBus();
      expect(reuseRes.exitCode, reuseRes.stderr.toString()).toBe(0);
      expect(existsSync(uiSock)).toBe(false);
      const launchCalls = readFileSync(hostLog, "utf8").trim().split("\n");
      expect(launchCalls[0]).toBe(`msg --control-socket ${uiSock} ping`);
      expect(launchCalls[1]).toContain(`--pure-shell --bundle ${bundleDir} --control-socket ${uiSock}`);
      expect(launchCalls[1]).toContain(`--bytecode-cache-dir ${join(cacheHome, "z-shell", "plugin-bytecode")}`);
      expect(launchCalls[1]).toContain(`--bind-socket niri=${niriSock}`);

      // 4. Live UI socket causes exit 75 without unlinking.
      const closeBus2 = await createUnixSocket(busSock);
      const closeUi = await createUnixSocket(uiSock);
      const liveConflict = Bun.spawnSync([sessionScript], {
        env: { ...baseEnv, MOCK_PING_OK: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(liveConflict.exitCode).toBe(75);
      expect(existsSync(uiSock)).toBe(true);
      closeUi();
      closeBus2();

      // 5. Standalone mode spawns z-shelld and terminates it when zgui-host exits.
      rmSync(uiSock, { force: true });
      rmSync(busSock, { force: true });
      const daemonState = join(tempDir, "daemon-stopped");
      writeExecutable(
        join(binDir, "z-shell"),
        `#!/usr/bin/env bash
exit 1
`,
      );
      writeExecutable(
        join(binDir, "z-shelld"),
        `#!/usr/bin/env bash
bun -e 'const s = require("node:net").createServer().listen(process.argv[1]); setInterval(() => {}, 1000);' ${JSON.stringify(busSock)} &
CHILD=$!
trap 'kill -TERM "$CHILD" 2>/dev/null || true; wait "$CHILD" 2>/dev/null || true; echo stopped > ${JSON.stringify(daemonState)}; rm -f ${JSON.stringify(busSock)}; exit 0' TERM INT
wait "$CHILD"
`,
      );
      const standaloneRes = Bun.spawnSync([sessionScript], {
        env: baseEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(standaloneRes.exitCode, standaloneRes.stderr.toString()).toBe(0);
      expect(existsSync(daemonState)).toBe(true);
    } finally {
      removeTempTree(tempDir);
    }
  });
});
