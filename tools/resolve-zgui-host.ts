import { probeNativeHost, resolveNativeHost, type ResolvedNativeHost } from "@hewel/zgui-build";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

export interface ResolvedZguiHost {
  readonly executable: string;
  readonly source: ResolvedNativeHost["source"];
  readonly runRoot?: string | undefined;
  readonly cargoRoot?: string | undefined;
  readonly abi?: ResolvedNativeHost["abi"];
}

export function detectLinkedZguiRoot(rootDir: string = repoRoot): string | null {
  try {
    const raw = readFileSync(join(rootDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as {
      readonly dependencies?: Readonly<Record<string, unknown>>;
      readonly devDependencies?: Readonly<Record<string, unknown>>;
    };
    const spec = pkg.devDependencies?.["@hewel/zgui-build"] ?? pkg.dependencies?.["@hewel/zgui-build"];
    if (typeof spec !== "string") return null;

    let rawPath: string | null = null;
    if (spec.startsWith("link:")) rawPath = spec.slice("link:".length);
    else if (spec.startsWith("file:")) rawPath = spec.slice("file:".length);
    if (rawPath === null || rawPath.length === 0) return null;

    let dir = resolve(rootDir, rawPath);
    for (let depth = 0; depth <= 3; depth++) {
      if (existsSync(join(dir, "Cargo.toml")) && existsSync(join(dir, "crates", "zgui-host", "Cargo.toml"))) {
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveBuiltHost(cargoRoot: string): ResolvedZguiHost | null {
  for (const profile of ["release", "debug"]) {
    const executable = join(cargoRoot, "target", profile, "zgui-host");
    try {
      accessSync(executable, constants.X_OK);
    } catch {
      continue;
    }
    return { executable, source: "cargo", runRoot: cargoRoot, cargoRoot, abi: probeNativeHost(executable) };
  }
  return null;
}

export async function resolveZguiHost(): Promise<ResolvedZguiHost | null> {
  const options = { allowCargoBuild: false, verifyAbi: true };
  if (process.env.ZGUI_JS_HOST_EXECUTABLE?.trim()) return resolveNativeHost(options);

  const root = process.env.ZGUI_ROOT?.trim();
  if (root) {
    const cargoRoot = resolve(root);
    const host = resolveBuiltHost(cargoRoot);
    if (host === null) throw new Error(`ZGUI_ROOT 下没有已构建的可执行 zgui-host：${cargoRoot}`);
    return host;
  }

  const linkedRoot = detectLinkedZguiRoot(repoRoot);
  if (linkedRoot !== null) {
    const linkedHost = resolveBuiltHost(linkedRoot);
    if (linkedHost !== null) return linkedHost;
  }

  const require = createRequire(join(repoRoot, "package.json"));
  // Bun 隔离安装时，平台包只能从声明该可选依赖的 CLI 包解析。
  const cliDir = dirname(require.resolve("@hewel/zgui-cli/package.json"));
  try {
    return await resolveNativeHost({ ...options, cwd: repoRoot, searchFrom: [cliDir] });
  } catch (error) {
    // 0.1.0 未区分错误码；仅在找不到宿主时回退，不掩盖完整性或 ABI 错误。
    if (!(error instanceof Error) || !error.message.startsWith("Cannot locate a zgui-js zgui-host binary")) {
      throw error;
    }
    return resolveBuiltHost(resolve(repoRoot, "../zgui-js"));
  }
}

if (import.meta.main) {
  if (process.argv.includes("--print-linked-root")) {
    const linkedRoot = detectLinkedZguiRoot(repoRoot);
    if (linkedRoot === null) {
      process.exitCode = 1;
    } else {
      console.log(linkedRoot);
    }
  } else {
    const host = await resolveZguiHost();
    if (host === null) {
      console.error("未找到 zgui-host。");
      process.exitCode = 1;
    } else {
      console.log(host.executable);
    }
  }
}
