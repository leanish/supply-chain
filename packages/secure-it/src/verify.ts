/**
 * The checks secure-it runs on the agent's edit before it publishes anything
 * (design item 23). Any problem stops the publication:
 *
 *   1. `compare` base → working tree passes (it judges every version that
 *      changed, transitives a parent update pulled in included);
 *   2. every planned move landed exactly: npm, the lockfile entry at each
 *      planned location is `to`; Gradle, each planned configuration resolves
 *      `to` (or above, when Gradle's own conflict resolution picks a version
 *      another path requires, which `compare` has judged); Actions, every use
 *      in each planned file is pinned to the tag's commit with `# <to>`;
 *   3. none of the targeted advisories affects any version of a planned
 *      package left in the tree (a swap for another vulnerable version would
 *      pass `compare` as inherited, not here);
 *   4. no direct dependency outside the planned packages changed version;
 *   5. only dependency files changed, unless a move is a major.
 */
import { basename } from "node:path";

import { readActionsInventory, commentTag } from "../../ci/src/actions-inventory.ts";
import { findingsOf } from "../../ci/src/findings.ts";
import { type GateEnvironment, type GradleInputs, readScanState, runCompare } from "../../ci/src/gate.ts";
import { gradleLocation, type GradleInventory } from "../../ci/src/gradle.ts";
import { directDependencies } from "../../ci/src/npm-lock.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { versionScheme } from "../../ci/src/versions.ts";

import { lockfilesOf } from "./inventory.ts";
import { type ChangePlan, lockfileOf, packageKey } from "./plan.ts";

export interface VerifyInputs {
  readonly plan: ChangePlan;
  readonly base: Tree;
  readonly head: Tree;
  readonly env: GateEnvironment;
  readonly gradle: GradleInputs;
  /** Paths the edit changed, added or removed in the working copy. */
  readonly changedFiles: ReadonlyArray<string>;
}

/** What's wrong with the edit; empty when it can be published. */
export async function verifyPlan(inputs: VerifyInputs): Promise<string[]> {
  const { plan, base, head, env, gradle } = inputs;
  const problems: string[] = [];

  const compared = await runCompare(base, head, env, gradle);
  problems.push(...compared.failures.map((failure) => `compare: ${failure}`));

  problems.push(...(await landed(plan, head, gradle.head)));

  const state = await readScanState(head, env, { head: gradle.head });
  const planned = new Set(plan.packages);
  for (const finding of findingsOf(state.packages, state.snapshot)) {
    if (!planned.has(packageKey(finding))) continue;
    const targeted = plan.moves.filter((move) => move.name === finding.name && move.advisories.some((advisory) => finding.ids.includes(advisory)));
    if (targeted.length > 0) problems.push(`${finding.name}@${finding.version} still has ${finding.advisory}, which the plan was to fix`);
  }

  const before = await directVersions(base, gradle.base);
  const after = await directVersions(head, gradle.head);
  for (const [key, version] of after) {
    const [ecosystem, name] = key.split("|");
    if (planned.has(`${ecosystem}|${name}`) || before.get(key) === version) continue;
    problems.push(`${name} changed from ${before.get(key) ?? "nothing"} to ${version} at ${key.split("|").slice(2).join("|")}, outside the plan`);
  }
  for (const [key, version] of before) {
    const [ecosystem, name] = key.split("|");
    if (!planned.has(`${ecosystem}|${name}`) && !after.has(key)) problems.push(`${name} ${version} was removed at ${key.split("|").slice(2).join("|")}, outside the plan`);
  }

  if (!plan.moves.some((move) => move.major)) {
    const actions = plan.moves.some((move) => move.mechanism === "action-pin");
    const outside = inputs.changedFiles.filter((path) => !isDependencyFile(path, actions));
    if (outside.length > 0) problems.push(`the edit changed ${outside.join(", ")}, which only a major move may touch`);
  }
  return problems;
}

async function landed(plan: ChangePlan, head: Tree, gradle: GradleInventory | undefined): Promise<string[]> {
  const problems: string[] = [];
  const locks = await lockfilesOf(head);
  const actions = plan.moves.some((move) => move.mechanism === "action-pin") ? await readActionsInventory(head) : undefined;
  for (const move of plan.moves) {
    for (const location of move.locations) {
      if (move.ecosystem === "npm") {
        const { lock, key } = lockfileOf(locks, location);
        const entry = ((lock ?? {}) as { packages?: Record<string, { version?: string; name?: string }> }).packages?.[key];
        if (entry?.version !== move.to) problems.push(`${move.name} at ${location} is ${entry?.version ?? "gone"}, not ${move.to}`);
      } else if (move.ecosystem === "Maven") {
        const resolved = resolvedAt(gradle, location, move.name);
        if (resolved === undefined) problems.push(`${location} no longer resolves ${move.name}`);
        else if (versionScheme("Maven").compare(resolved, move.to) < 0) problems.push(`${location} resolves ${move.name} ${resolved}, below ${move.to}`);
      } else {
        const uses = (actions?.uses ?? []).filter((use) => use.file === location && use.name === move.name.toLowerCase());
        if (uses.length === 0) problems.push(`${location} no longer uses ${move.name}`);
        for (const use of uses) {
          if (use.ref !== move.commitSha || commentTag(use) !== move.to) problems.push(`${location} uses ${move.name}@${use.ref} (${use.comment ?? "no comment"}), not ${move.commitSha} # ${move.to}`);
        }
      }
    }
  }
  return problems;
}

function resolvedAt(gradle: GradleInventory | undefined, location: string, name: string): string | undefined {
  for (const build of gradle?.builds ?? []) {
    for (const configuration of build.configurations) {
      if (gradleLocation(build.build, configuration.id) !== location) continue;
      return configuration.resolved.find((component) => `${component.group}:${component.name}` === name)?.version;
    }
  }
  return undefined;
}

/** `ecosystem|name|where` → version, for every direct declaration: npm per lockfile and workspace, Gradle per configuration. */
async function directVersions(tree: Tree, gradle: GradleInventory | undefined): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  for (const [path, lock] of await lockfilesOf(tree)) {
    for (const dependency of directDependencies(lock)) {
      versions.set(`npm|${dependency.name}|${path}#${dependency.workspace || "."}:${dependency.declaredAs}`, dependency.version);
    }
  }
  for (const build of gradle?.builds ?? []) {
    for (const configuration of build.configurations) {
      for (const declared of configuration.declared) {
        if (declared.version === undefined) continue;
        versions.set(`Maven|${declared.group}:${declared.name}|${gradleLocation(build.build, configuration.id)}`, declared.version);
      }
    }
  }
  return versions;
}

const DEPENDENCY_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "gradle.lockfile", "buildscript-gradle.lockfile"]);

function isDependencyFile(path: string, actions: boolean): boolean {
  const name = basename(path);
  if (DEPENDENCY_FILES.has(name)) return true;
  if (name.endsWith(".gradle") || name.endsWith(".gradle.kts")) return true;
  if (path === "gradle/libs.versions.toml" || path.endsWith("/gradle/libs.versions.toml")) return true;
  if (path === ".github/dependency-floors.json") return true;
  return actions && (path.startsWith(".github/workflows/") || path.startsWith(".github/actions/") || name === "action.yml" || name === "action.yaml");
}
