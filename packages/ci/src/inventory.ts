/**
 * What one side of a comparison has installed, read from its tree: every
 * configured npm lockfile (each must exist), as raw lockfile entries for the
 * npm-only checks and as located package versions for the advisory scan.
 */
import { dirname } from "node:path";

import type { Config } from "./config.ts";
import type { Located } from "./findings.ts";
import { bundleProblems, type LockedPackage, lockedPackages } from "./npm-lock.ts";
import { versionKey } from "./package-version.ts";
import type { Tree } from "./tree.ts";

export interface NpmLockfile {
  readonly path: string;
  readonly packages: ReadonlyArray<LockedPackage>;
  /** Bundles the lockfile doesn't fully record. */
  readonly bundleProblems: ReadonlyArray<string>;
}

export interface Inventory {
  readonly tree: string;
  readonly npm: ReadonlyArray<NpmLockfile>;
}

export interface ReadOptions {
  /** Base may predate a lockfile head adds: it reads as empty there. */
  readonly missingLockfilesAreEmpty?: boolean;
}

export async function readInventory(tree: Tree, config: Config, options: ReadOptions = {}): Promise<Inventory> {
  const npm: NpmLockfile[] = [];
  for (const path of config.npm.lockfiles) {
    const text = await tree.read(path);
    if (text === undefined && options.missingLockfilesAreEmpty === true) {
      npm.push({ path, packages: [], bundleProblems: [] });
      continue;
    }
    if (text === undefined) throw new Error(`${path} isn't in ${tree.id}, but supply-chain.json lists it`);
    let lock: unknown;
    try {
      lock = JSON.parse(text);
    } catch {
      throw new Error(`${path} in ${tree.id} isn't JSON`);
    }
    npm.push({ path, packages: lockedPackages(lock), bundleProblems: bundleProblems(lock) });
  }
  return { tree: tree.id, npm };
}

/** Lockfile paths as locations: `node_modules/x` for the root lockfile, `tools/cli/node_modules/x` for one in `tools/cli`. */
export function npmLocation(lockfile: string, path: string): string {
  const dir = dirname(lockfile);
  return dir === "." ? path : `${dir}/${path}`;
}

/** Every package version in the inventory, with all its locations. */
export function located(inventory: Inventory): Located[] {
  const byVersion = new Map<string, { name: string; version: string; locations: string[] }>();
  for (const lockfile of inventory.npm) {
    for (const pkg of lockfile.packages) {
      const key = versionKey({ ecosystem: "npm", name: pkg.name, version: pkg.version });
      const entry = byVersion.get(key) ?? { name: pkg.name, version: pkg.version, locations: [] };
      entry.locations.push(npmLocation(lockfile.path, pkg.path));
      byVersion.set(key, entry);
    }
  }
  return [...byVersion.values()].map((entry) => ({ ecosystem: "npm", ...entry }));
}
