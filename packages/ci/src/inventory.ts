/**
 * What one side of a comparison has installed, read from its tree: every
 * npm lockfile (raw entries for the npm-only checks) and the Gradle
 * inventory made from it, merged into located package versions for the
 * advisory scan.
 *
 * Which sources a repository has is decided once, from head: configured
 * lockfiles and builds, or else `package-lock.json` and the root Gradle build
 * when the tree has them, so an ecosystem present in the repository is never
 * skipped for lack of configuration.
 */
import { dirname } from "node:path";

import type { Config } from "./config.ts";
import type { Located } from "./findings.ts";
import { type GradleInventory, gradleLocated } from "./gradle.ts";
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
  readonly gradle: GradleInventory | undefined;
}

export interface Sources {
  readonly lockfiles: ReadonlyArray<string>;
  readonly gradleBuilds: ReadonlyArray<string>;
}

const GRADLE_ROOT_FILES = ["settings.gradle.kts", "settings.gradle", "build.gradle.kts", "build.gradle"];

export async function sourcesOf(tree: Tree, config: Config): Promise<Sources> {
  const lockfiles = config.npm.lockfiles ?? ((await tree.read("package-lock.json")) === undefined ? [] : ["package-lock.json"]);
  let gradleBuilds = config.gradle.builds;
  if (gradleBuilds === undefined) {
    const found = await Promise.all(GRADLE_ROOT_FILES.map(async (file) => (await tree.read(file)) !== undefined));
    gradleBuilds = found.some(Boolean) ? ["."] : [];
  }
  if (lockfiles.length === 0 && gradleBuilds.length === 0) {
    throw new Error(`${tree.id} has no package-lock.json or Gradle build, and supply-chain.json lists none`);
  }
  return { lockfiles, gradleBuilds };
}

export interface ReadOptions {
  /** Base may predate a lockfile head adds: it reads as empty there. */
  readonly missingLockfilesAreEmpty?: boolean;
  /** The Gradle inventory made from this tree; required when the sources list builds. */
  readonly gradle?: GradleInventory | undefined;
}

export async function readInventory(tree: Tree, sources: Sources, options: ReadOptions = {}): Promise<Inventory> {
  const npm: NpmLockfile[] = [];
  for (const path of sources.lockfiles) {
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
  if (sources.gradleBuilds.length > 0 && options.gradle === undefined) {
    throw new Error(`${tree.id} has Gradle builds (${sources.gradleBuilds.join(", ")}), but no Gradle inventory was given for it`);
  }
  return { tree: tree.id, npm, gradle: sources.gradleBuilds.length > 0 ? options.gradle : undefined };
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
  const npm: Located[] = [...byVersion.values()].map((entry) => ({ ecosystem: "npm", ...entry }));
  return inventory.gradle === undefined ? npm : [...npm, ...gradleLocated(inventory.gradle)];
}
