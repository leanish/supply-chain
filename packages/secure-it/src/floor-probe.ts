/** Unlocked floor proofs run repository code only in exported, sandboxed scratch copies. */
import { readFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { ActionsGitHub } from "../../ci/src/actions-github.ts";
import { findingsOf } from "../../ci/src/findings.ts";
import { type Floor, FLOORS_PATH, overrideAt } from "../../ci/src/floors.ts";
import { type GateEnvironment, inventoryProblems, readSettings, snapshotOptions, treeSources } from "../../ci/src/gate.ts";
import { located, readInventory } from "../../ci/src/inventory.ts";
import { runProcess, type RunProcess } from "../../ci/src/process.ts";
import { takeSnapshot } from "../../ci/src/take-snapshot.ts";
import { type Tree, workingTree } from "../../ci/src/tree.ts";
import type { ToolRunContext } from "../../remediation/src/command.ts";
import { exportCommit } from "../../remediation/src/git-copies.ts";
import { assertLocalFile, removeLocalFile, writeLocalFile } from "../../remediation/src/local-files.ts";
import { requireNpmExcludes } from "../../remediation/src/npm-version.ts";
import { runSandboxed } from "../../remediation/src/sandboxed.ts";

import { unlockedGradle } from "./floor-gradle.ts";
import { safeFile, type RemovalProbe, withoutFloorRecords, withoutOverrides } from "./floor-removal.ts";

export async function probeOnBase(context: ToolRunContext, base: Tree, floors: ReadonlyArray<Floor>, env: GateEnvironment): Promise<RemovalProbe> {
  const copy = await exportCommit(context.workingCopy, base.id);
  try {
    return await probeInCopy(context, copy.dir, base, floors, env);
  } finally {
    await copy.remove();
  }
}

/** The process boundary is replaceable for network-free tests; production always uses runSandboxed. */
export async function probeInCopy(context: ToolRunContext, dir: string, base: Tree, floors: ReadonlyArray<Floor>, env: GateEnvironment, run: RunProcess = runProcess): Promise<RemovalProbe> {
  const record = await base.read(FLOORS_PATH);
  if (record === undefined) throw new Error("floor removal needs recorded security floors");
  if (floors.some((floor) => !safeFile(floor.declaredIn))) throw new Error("unsafe floor declaration path");
  if (floors.some((floor) => floor.ecosystem === "npm" && basename(floor.declaredIn) !== "package.json")) {
    throw new Error("npm security floors must be declared in package.json");
  }
  const files = new Map<string, string>([[FLOORS_PATH, withoutFloorRecords(record, floors)]]);
  await writeLocalFile(dir, FLOORS_PATH, files.get(FLOORS_PATH)!);
  for (const path of new Set(floors.filter((floor) => floor.ecosystem === "npm").map((floor) => floor.declaredIn))) {
    const text = await base.read(path);
    if (text === undefined) throw new Error(`floor declaration ${path} is missing`);
    const removed = floors.filter((floor) => floor.declaredIn === path && floor.ecosystem === "npm");
    const overrides = (JSON.parse(text) as Record<string, unknown>)["overrides"];
    for (const floor of removed) {
      if (floor.overridePaths.some((selector) => overrideAt(overrides, selector) === undefined)) throw new Error(`${floor.package}: the recorded override is absent`);
    }
    files.set(path, withoutOverrides(text, removed));
    await writeLocalFile(dir, path, files.get(path)!);
  }
  const sources = await treeSources(base);
  for (const manifest of [...files.keys()].filter((path) => basename(path) === "package.json")) {
    const locks = sources.lockfiles.filter((path) => dirname(path) === dirname(manifest));
    if (locks.length !== 1) throw new Error(`${manifest}: floor removal requires exactly one configured sibling npm lockfile`);
    const lock = locks[0]!;
    await unlockedNpm(context, dir, lock, run);
    if (await readFile(join(dir, manifest), "utf8") !== files.get(manifest)) throw new Error(`${manifest}: npm rewrote the planned manifest`);
    await assertLocalFile(dir, lock);
    files.set(lock, await readFile(join(dir, lock), "utf8"));
  }
  const scratch = workingTree(dir);
  const workingCopy = { ...context.workingCopy, path: dir };
  const gradle = await unlockedGradle(context, workingCopy, scratch, floors, run);
  // A build may write dependency files: re-read after all repository code finishes.
  for (const [path, expected] of files) {
    if (await scratch.read(path) !== expected) throw new Error(`${path}: the unlocked build changed the computed npm/floor bytes`);
  }
  const { config } = await readSettings(base);
  const inventory = await readInventory(scratch, { ...sources, gradleBuilds: floors.some((floor) => floor.ecosystem === "Maven") ? sources.gradleBuilds : [] }, { gradle });
  const problems = inventoryProblems(inventory, config);
  const packages = located(inventory).filter((pkg) => floors.some((floor) => floor.ecosystem === pkg.ecosystem && floor.package === pkg.name));
  const snapshot = await takeSnapshot(packages, snapshotOptions(config, env, new ActionsGitHub(env.fetch, env.githubToken)));
  return { files, findings: findingsOf(packages, snapshot), problems: [...problems, ...snapshot.gaps] };
}

async function unlockedNpm(context: ToolRunContext, root: string, lock: string, run: RunProcess): Promise<void> {
  const dir = dirname(lock);
  const cwd = dir === "." ? root : join(root, dir);
  // Both lock formats can influence npm, even when only one is configured for the gate.
  for (const filename of ["package-lock.json", "npm-shrinkwrap.json"]) {
    await removeLocalFile(root, dir === "." ? filename : `${dir}/${filename}`);
  }
  const npm = async (_dir: string, args: ReadonlyArray<string>) => runSandboxed(context.isolation, {
    workingCopy: { ...context.workingCopy, path: cwd }, command: ["npm", ...args],
  }, run);
  await requireNpmExcludes(npm, cwd, context.releaseAgeExclude, "own-package exclusions in an unlocked floor proof");
  const result = await npm(cwd, ["install", "--package-lock-only", "--ignore-scripts", "--audit=false", "--fund=false",
    `--min-release-age=${context.releaseAgeDays}`, ...context.releaseAgeExclude.map((name) => `--min-release-age-exclude=${name}`)]);
  if (result.code !== 0) throw new Error(`unlocked npm resolution failed: ${result.stderr.trim() || result.stdout.trim()}`);
  if (basename(lock) === "npm-shrinkwrap.json") {
    await assertLocalFile(root, dir === "." ? "package-lock.json" : `${dir}/package-lock.json`);
    await assertLocalFile(root, lock);
    await rename(join(cwd, "package-lock.json"), join(root, lock));
  }
}
