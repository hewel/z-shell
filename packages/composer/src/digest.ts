import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

interface DigestFile {
  readonly relativePath: string;
  readonly absolutePath: string;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function walk(
  root: string,
  directory: string,
  relativeDirectory: string,
  ancestors: ReadonlySet<string>,
  files: DigestFile[],
): void {
  const canonicalDirectory = realpathSync(directory);
  if (directory !== root && !isInside(root, canonicalDirectory)) {
    throw new Error(`digest walk escapes plugin root through a symlink: ${relativeDirectory}`);
  }
  if (ancestors.has(canonicalDirectory)) {
    throw new Error(`digest walk encountered a symlink directory cycle: ${relativeDirectory || "."}`);
  }
  const nextAncestors = new Set(ancestors).add(canonicalDirectory);
  for (const name of readdirSync(directory)) {
    const relativePath = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
    if (relativePath === ".git") continue;
    const absolutePath = join(directory, name);
    const linkStat = lstatSync(absolutePath);
    let targetStat = linkStat;
    let canonicalPath = absolutePath;
    if (linkStat.isSymbolicLink()) {
      canonicalPath = realpathSync(absolutePath);
      if (!isInside(root, canonicalPath)) {
        throw new Error(`digest file escapes plugin root through a symlink: ${relativePath}`);
      }
      targetStat = statSync(canonicalPath);
    }
    if (targetStat.isDirectory()) {
      walk(root, absolutePath, relativePath, nextAncestors, files);
    } else if (targetStat.isFile()) {
      files.push({ relativePath, absolutePath });
    }
  }
}

/** Computes the exact deterministic content digest from plugin-manifest-v1.md section 3. */
export function computeContentDigest(pluginRoot: string): string {
  const root = realpathSync(pluginRoot);
  if (!statSync(root).isDirectory()) throw new Error(`plugin root is not a directory: ${pluginRoot}`);
  const files: DigestFile[] = [];
  walk(root, root, "", new Set(), files);
  files.sort((left, right) =>
    Buffer.compare(Buffer.from(left.relativePath, "utf8"), Buffer.from(right.relativePath, "utf8")),
  );

  const hash = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    const bytes = readFileSync(file.absolutePath);
    hash.update(Buffer.from(file.relativePath, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(String(bytes.byteLength));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    hash.update(Buffer.from([0]));
  }
  return `sha256:${hash.digest("hex")}`;
}
