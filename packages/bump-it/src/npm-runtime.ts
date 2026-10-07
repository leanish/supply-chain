/** Registry decisions in the tool; npm resolution in an exported, sandboxed scratch tree. */
import { dirname } from "node:path";
import semver from "semver";

import { ActionsGitHub } from "../../ci/src/actions-github.ts";
import { IdentityCheck } from "../../ci/src/candidates.ts";
import { type GateEnvironment, type GradleInputs, readSettings, snapshotOptions, treeSources, versionCatalogs } from "../../ci/src/gate.ts";
import { readInventory } from "../../ci/src/inventory.ts";
import { NpmRegistry } from "../../ci/src/npm-registry.ts";
import { isOwnPackage } from "../../ci/src/config.ts";
import { takeSnapshot } from "../../ci/src/take-snapshot.ts";
import type { Tree } from "../../ci/src/tree.ts";
import type { ToolRunContext } from "../../remediation/src/command.ts";
import { exportCommit } from "../../remediation/src/git-copies.ts";
import { lockfilesOf } from "../../remediation/src/inventories.ts";
import { runSandboxed } from "../../remediation/src/sandboxed.ts";

import { computeNpm, type NpmCommand, type NpmResult } from "./npm-compute.ts";
import type { TargetSources } from "./npm-targets.ts";
import type { Unit } from "./units.ts";

export async function targetSources(base: Tree, env: GateEnvironment, gradle: GradleInputs["head"]): Promise<TargetSources> {
  const { config, exceptions } = await readSettings(base);
  const inventory = await readInventory(base, await treeSources(base), { gradle });
  const actions = new ActionsGitHub(env.fetch, env.githubToken);
  const registry = new NpmRegistry(env.fetch);
  const catalog = versionCatalogs(config, env, actions, registry).npm;
  const now = env.now();
  const identity = new IdentityCheck(registry, inventory.npm, exceptions, now.toISOString().slice(0, 10));
  return {
    versions: (name) => catalog.versions({ ecosystem: "npm", name }),
    published: (name, version) => catalog.published({ ecosystem: "npm", name, version }),
    snapshot: (packages, candidates) => takeSnapshot(packages, snapshotOptions(config, env, actions), candidates),
    identity: (name, from, to) => identity.problems({ ecosystem: "npm", name, version: from }, to),
    isOwn: (name) => isOwnPackage(config.ownPackages, { ecosystem: "npm", name }),
    releaseAgeDays: config.releaseAgeDays,
    now,
  };
}

export async function requireNpmExcludes(npm: NpmCommand, dir: string, exclude: ReadonlyArray<string>): Promise<void> {
  if (exclude.length === 0) return;
  const result = await npm(dir, ["--version"]);
  const version = semver.valid(result.stdout.trim());
  if (result.code !== 0 || version === null || !semver.gte(version, "11.17.0")) throw new Error(`ownPackages requires npm >= 11.17.0 (min-release-age-exclude); got ${result.stdout.trim() || result.stderr.trim() || "no version"}`);
}

export async function computeOnBase(context: ToolRunContext, unit: Unit, base: Tree, env: GateEnvironment, gradle: GradleInputs["head"]): Promise<NpmResult> {
  const locks = await lockfilesOf(base);
  if (locks.size === 0 || unit.kind === "major" && !unit.moves.some((move) => move.ecosystem === "npm")) return { files: new Map(), changes: [], notes: [] };
  const scratch = await exportCommit(context.workingCopy, base.id);
  try {
    const npm: NpmCommand = (cwd, args) => runSandboxed(context.isolation, { workingCopy: { ...context.workingCopy, path: cwd }, command: ["npm", ...args] });
    // Check the same npm executable and per-project environment that computes the lockfile.
    for (const lock of locks.keys()) await requireNpmExcludes(npm, `${scratch.dir}/${dirname(lock)}`, context.releaseAgeExclude);
    const sources = await targetSources(base, env, gradle);
    return await computeNpm({ kind: unit.kind, dir: scratch.dir, baseLocks: locks, moves: unit.moves.flatMap((move) => move.declarations.map((declaration) => ({ ...declaration, name: move.name, to: move.to }))), npm, window: { days: context.releaseAgeDays, exclude: context.releaseAgeExclude }, sources });
  } finally { await scratch.remove(); }
}
