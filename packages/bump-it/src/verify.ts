/** Item 27: policy first, exact npm data, per-declaration Gradle moves, then publication. */
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { type GateEnvironment, type GradleInputs, readSettings, runCompare, treeSources } from "../../ci/src/gate.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { actionsOutsidePlan, declaredAt, directChangesOutside, directVersions, FLOORS_FILE, isDependencyFile, policyFence } from "../../remediation/src/edit-checks.ts";

import { gradleDeclarationProblems } from "./gradle-declarations.ts";
import { plannedPinsLanded } from "./action-pins.ts";
import { type BumpPlan, DEPENDENCY_FIELDS, dependencyDigest, sha256 } from "./plan.ts";

export interface VerifyInputs {
  readonly plan: BumpPlan;
  readonly npmFiles: ReadonlyMap<string, string>;
  readonly base: Tree;
  readonly head: Tree;
  readonly env: GateEnvironment;
  readonly gradle: GradleInputs;
  readonly changedFiles: ReadonlyArray<string>;
}

export const isNpmLock = (path: string) => ["package-lock.json", "npm-shrinkwrap.json"].includes(basename(path));

export async function verifyPlan(inputs: VerifyInputs): Promise<string[]> {
  const { plan, base, head, gradle } = inputs;
  const pins = plan.moves.filter((move) => move.mechanism === "action-pin").map((move) => ({ ...move, commitSha: move.commitSha }));
  const fenced = await policyFence(inputs.changedFiles, pins, base, head);
  if (fenced.length > 0) return fenced;
  const problems = await npmProblems(inputs);
  if (await base.read(FLOORS_FILE) !== await head.read(FLOORS_FILE)) problems.push("bump-it may not change dependency floors");
  problems.push(...await floorProblems(base, head, gradle));
  const before = await directVersions(base, gradle.base);
  const after = await directVersions(head, gradle.head);
  const planned = (ecosystem: string, name: string, where: string) => plan.moves.some((move) => move.ecosystem === ecosystem && move.name === name && (move.ecosystem === "npm" ? move.declarations.some((declaration) => where === `${declaration.lockfile}#${declaration.workspace}:${declaration.declaredAs}`) : move.locations.includes(where)));
  problems.push(...directChangesOutside(before, after, planned));
  problems.push(...gradleDeclarationProblems(plan.moves, gradle.base, gradle.head));
  problems.push(...await plannedPinsLanded(plan.moves, base, head), ...await actionsOutsidePlan(pins, base, head));
  if (plan.kind !== "major") {
    const outside = inputs.changedFiles.filter((path) => !isDependencyFile(path, pins.length > 0));
    if (outside.length > 0) problems.push(`only a major may change ${outside.join(", ")}`);
  }
  // A malformed plan or modified lockfile need not execute the gate at all.
  if (problems.length > 0) return problems;
  const compared = await runCompare(base, head, inputs.env, gradle);
  return compared.failures.map((failure) => `compare: ${failure}`);
}

/** Also used before adapting: the persisted hashes must match the bytes we protect. */
export async function plannedFiles(plan: BumpPlan, tree: Tree): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const file of plan.npmFiles) {
    const text = await tree.read(file.path);
    if (text === undefined || (plan.kind === "major" && basename(file.path) === "package.json" ? dependencyDigest(text) !== file.dependencySha256 : sha256(text) !== file.sha256)) throw new Error(`${file.path} no longer matches the recorded npm plan`);
    files.set(file.path, text);
  }
  return files;
}

async function npmProblems(inputs: VerifyInputs): Promise<string[]> {
  const { base, head, plan, npmFiles } = inputs;
  const problems: string[] = [];
  const locked = new Set([...(await treeSources(base)).lockfiles, ...(await treeSources(head)).lockfiles, ...inputs.changedFiles.filter(isNpmLock)]);
  for (const file of plan.npmFiles) {
    const expected = npmFiles.get(file.path);
    if (expected === undefined || (plan.kind === "major" && basename(file.path) === "package.json" ? dependencyDigest(expected) !== file.dependencySha256 : sha256(expected) !== file.sha256)) problems.push(`${file.path}: expected npm bytes don't match the plan`);
    if (isNpmLock(file.path)) locked.add(file.path);
  }
  for (const path of locked) {
    if (await head.read(path) !== (npmFiles.get(path) ?? await base.read(path))) problems.push(`${path} differs from the exact planned lockfile`);
  }
  const manifests = new Set([...inputs.changedFiles, ...plan.npmFiles.map((file) => file.path)].filter((path) => basename(path) === "package.json"));
  for (const path of manifests) {
    const expected = npmFiles.get(path) ?? await base.read(path);
    const actual = await head.read(path);
    if (actual === expected) continue;
    if (actual === undefined || expected === undefined) { problems.push(`${path} was added or removed outside the npm plan`); continue; }
    try {
      const wanted = JSON.parse(expected) as Record<string, unknown>;
      const found = JSON.parse(actual) as Record<string, unknown>;
      const fields = plan.kind === "major" ? DEPENDENCY_FIELDS : [...new Set([...Object.keys(wanted), ...Object.keys(found)])];
      if (fields.some((field) => !isDeepStrictEqual(wanted[field], found[field]))) problems.push(`${path} changed ${plan.kind === "major" ? "dependency fields" : "fields"} outside the npm plan`);
    } catch { problems.push(`${path} does not parse as a package manifest`); }
  }
  return problems;
}

async function floorProblems(base: Tree, head: Tree, gradle: GradleInputs): Promise<string[]> {
  const problems: string[] = [];
  for (const floor of (await readSettings(base)).floors) {
    if (floor.ecosystem === "Maven") {
      for (const location of floor.locations) {
        if (!isDeepStrictEqual(declaredAt(gradle.base, location, floor.package), declaredAt(gradle.head, location, floor.package))) problems.push(`floor declaration for ${floor.package} changed at ${location}`);
      }
    } else {
      const overrides = async (tree: Tree) => JSON.parse(await tree.read(floor.declaredIn) ?? "{}").overrides as unknown;
      const at = (value: unknown, path: ReadonlyArray<string>): unknown => path.reduce<unknown>((node, key) => node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined, value);
      const was = await overrides(base);
      const now = await overrides(head);
      if (floor.overridePaths.some((path) => !isDeepStrictEqual(at(was, path), at(now, path)))) problems.push(`floor override for ${floor.package} changed`);
    }
  }
  return problems;
}
