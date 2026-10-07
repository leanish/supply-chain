/**
 * The OSV-Scanner the tools run: the version `packages/ci/tools.json` pins for
 * CI, installed into the tool's cache by CI's own installer (which checks its
 * sha256), and checked again before every use, so a binary someone swapped in
 * the cache isn't run.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runProcess, type RunProcess } from "../../ci/src/process.ts";

const TOOLS_JSON = fileURLToPath(new URL("../../ci/tools.json", import.meta.url));
const INSTALLER = fileURLToPath(new URL("../../ci/scripts/install-osv-scanner.sh", import.meta.url));

/** The platform key `tools.json` uses, or undefined where nothing is pinned. */
export function osvPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  if (platform === "linux" && arch === "x64") return "linux_amd64";
  if (platform === "darwin" && arch === "arm64") return "darwin_arm64";
  return undefined;
}

/** The path of the pinned OSV-Scanner under `cacheDir`, installing it first when it's missing or doesn't match its sha256. */
export async function ensureOsvScanner(cacheDir: string, run: RunProcess = runProcess, platform = osvPlatform()): Promise<string> {
  if (platform === undefined) throw new Error(`no OSV-Scanner is pinned for ${process.platform}/${process.arch}`);
  const pinned = JSON.parse(await readFile(TOOLS_JSON, "utf8")) as { "osv-scanner": { version: string; sha256: Record<string, string> } };
  const { version, sha256 } = pinned["osv-scanner"];
  const expected = sha256[platform];
  if (expected === undefined) throw new Error(`tools.json pins no OSV-Scanner sha256 for ${platform}`);
  const dir = join(cacheDir, "tools", `osv-scanner-${version}`);
  const binary = join(dir, "osv-scanner");
  if ((await sha256Of(binary)) === expected) return binary;
  const installed = await run(INSTALLER, [dir]);
  if (installed.code !== 0) throw new Error(`installing OSV-Scanner ${version} failed: ${installed.stderr.trim().split("\n").at(-1) ?? ""}`);
  if ((await sha256Of(binary)) !== expected) throw new Error(`the installed OSV-Scanner at ${binary} doesn't match its pinned sha256`);
  return binary;
}

async function sha256Of(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
