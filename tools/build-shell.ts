import { resolve } from "node:path";
import { buildShellApplication } from "@z-shell/composer";

const repoRoot = resolve(import.meta.dir, "..");
const appDirectory = resolve(repoRoot, "apps/shell");

const t0 = performance.now();
const published = await buildShellApplication({ app: "shell", appDirectory });
const ms = Math.round(performance.now() - t0);
console.log(`Built ${published.manifest.id} -> ${published.dist} (${ms}ms)`);
