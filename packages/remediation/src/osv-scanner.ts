/**
 * The OSV-Scanner the tools run, outside the sandbox: the version
 * `packages/ci/tools.json` pins for CI, installed by CI's own installer (which
 * checks its sha256) into the tool's **state** directory — never the build
 * cache, the working copy or a temp dir, which sandboxed commands can write —
 * and checked again right before every run, so a binary swapped in between
 * isn't executed.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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

export interface TrustedBinary {
  readonly path: string;
  /** Fails unless the file at `path` still has the pinned sha256. */
  verify(): Promise<void>;
}

/**
 * The pinned OSV-Scanner under `stateDir`, installed first when it's missing or
 * doesn't match its sha256. `sandboxWritable` lists the directories sandboxed
 * commands may write; the binary must be outside all of them.
 */
export async function ensureOsvScanner(
  stateDir: string,
  sandboxWritable: ReadonlyArray<string>,
  run: RunProcess = runProcess,
  platform = osvPlatform(),
): Promise<TrustedBinary> {
  if (platform === undefined) throw new Error(`no OSV-Scanner is pinned for ${process.platform}/${process.arch}`);
  const pinned = JSON.parse(await readFile(TOOLS_JSON, "utf8")) as { "osv-scanner": { version: string; sha256: Record<string, string> } };
  const { version, sha256 } = pinned["osv-scanner"];
  const expected = sha256[platform];
  if (expected === undefined) throw new Error(`tools.json pins no OSV-Scanner sha256 for ${platform}`);
  const dir = join(stateDir, "tools", `osv-scanner-${version}`);
  const binary = join(dir, "osv-scanner");
  const writable = sandboxWritable.find((root) => isInside(binary, root));
  if (writable !== undefined) throw new Error(`OSV-Scanner would live in ${writable}, which sandboxed commands can write`);
  const trusted: TrustedBinary = {
    path: binary,
    async verify() {
      if ((await sha256Of(binary)) !== expected) throw new Error(`${binary} no longer matches OSV-Scanner ${version}'s pinned sha256; not running it`);
    },
  };
  if ((await sha256Of(binary)) === expected) return trusted;
  const installed = await run(INSTALLER, [dir]);
  if (installed.code !== 0) throw new Error(`installing OSV-Scanner ${version} failed: ${installed.stderr.trim().split("\n").at(-1) ?? ""}`);
  if ((await sha256Of(binary)) !== expected) throw new Error(`the installed OSV-Scanner at ${binary} doesn't match its pinned sha256`);
  return trusted;
}

/** `run`, checking `binary` right before each time it runs it. */
export function verifyingRun(run: RunProcess, binary: TrustedBinary): RunProcess {
  return async (command, args, options) => {
    if (command === binary.path) await binary.verify();
    return run(command, args, options);
  };
}

function isInside(path: string, root: string): boolean {
  const from = relative(resolve(root), resolve(path));
  return from === "" || (!from.startsWith("..") && !isAbsolute(from));
}

async function sha256Of(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
