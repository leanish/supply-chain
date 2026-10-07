/**
 * The checks secure-it runs on the agent's edit before it publishes anything
 * (design item 23). Any problem stops the publication:
 *
 *   0. the gate's own policy is untouched, major or not: its config, its
 *      exceptions, and every workflow and action file — in a file a planned
 *      action pin names, everything but that pin's ref and comment (checked
 *      first, since `compare` reads policy from head);
 *   1. `compare` base → working tree passes (it judges every version that
 *      changed, transitives a parent update pulled in included);
 *   2. every planned move landed exactly: npm, the lockfile entry at each
 *      planned location is `to`; Gradle, each planned configuration declares
 *      exactly `to` and resolves it (or above: then the exact declaration shows
 *      Gradle's conflict resolution picked a version another path requires,
 *      which `compare` has judged); Actions, every use in each planned file is
 *      pinned to the tag's commit with `# <to>`;
 *   3. none of the targeted advisories affects any version of a planned
 *      package left in the tree (a swap for another vulnerable version would
 *      pass `compare` as inherited, not here);
 *   4. no direct dependency outside the planned packages changed version, and
 *      no action use outside the plan changed;
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

  const pinned = new Set(plan.moves.filter((move) => move.mechanism === "action-pin").flatMap((move) => move.locations));
  const policy = inputs.changedFiles.filter((path) => isPolicyFile(path) && !pinned.has(path));
  if (policy.length > 0) return [`the edit changed ${policy.join(", ")}: the gate's own policy, which no plan may change`];
  const pinnedActions = new Set(plan.moves.filter((move) => move.mechanism === "action-pin").map((move) => move.name.toLowerCase()));
  for (const path of inputs.changedFiles.filter((changed) => pinned.has(changed))) {
    const before = pinsMasked(await base.read(path), pinnedActions);
    const after = pinsMasked(await head.read(path), pinnedActions);
    if (before !== after) return [`the edit changed ${path} beyond its planned action pins: the gate's own policy, which no plan may change`];
  }

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
  problems.push(...(await actionsOutsidePlan(plan, base, head)));

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
        const declared = declaredAt(gradle, location, move.name);
        const resolved = resolvedAt(gradle, location, move.name);
        if (!declared.includes(move.to)) problems.push(`${location} declares ${move.name} ${declared.length === 0 ? "nowhere" : declared.join(", ")}, not ${move.to}`);
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

/** The versions a configuration declares (or inherits) for `name`. */
function declaredAt(gradle: GradleInventory | undefined, location: string, name: string): string[] {
  for (const build of gradle?.builds ?? []) {
    for (const configuration of build.configurations) {
      if (gradleLocation(build.build, configuration.id) !== location) continue;
      return configuration.declared.filter((declared) => `${declared.group}:${declared.name}` === name && declared.version !== undefined).map((declared) => declared.version!);
    }
  }
  return [];
}

/** Action uses that changed outside the plan: a use of an unplanned action, or of a planned one in an unplanned file. */
async function actionsOutsidePlan(plan: ChangePlan, base: Tree, head: Tree): Promise<string[]> {
  const planned = new Map<string, Set<string>>();
  for (const move of plan.moves.filter((m) => m.mechanism === "action-pin")) {
    planned.set(move.name.toLowerCase(), new Set([...(planned.get(move.name.toLowerCase()) ?? []), ...move.locations]));
  }
  const outside = (use: { name: string; file: string }) => !planned.get(use.name)?.has(use.file);
  const occurrences = async (tree: Tree) =>
    (await readActionsInventory(tree)).uses.filter(outside).map((use) => `${use.file}: ${use.name}${use.path === undefined ? "" : `/${use.path}`}@${use.ref}${use.comment === undefined ? "" : ` # ${use.comment}`}`);
  const before = await occurrences(base);
  const after = await occurrences(head);
  const count = (list: string[]) => list.reduce((map, entry) => map.set(entry, (map.get(entry) ?? 0) + 1), new Map<string, number>());
  const was = count(before);
  const now = count(after);
  const changed = [...new Set([...was.keys(), ...now.keys()])].filter((entry) => was.get(entry) !== now.get(entry)).sort();
  return changed.map((entry) => `the action use ${entry} changed outside the plan`);
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

/** A workflow's text with the ref and comment of each use of `actions` masked: what a planned pin may change. */
function pinsMasked(text: string | undefined, actions: ReadonlySet<string>): string | undefined {
  if (text === undefined) return undefined;
  return text
    .split("\n")
    .map((line) => {
      const use = /^(\s*(?:-\s*)?uses:\s*)(["']?)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)((?:\/[^@\s"']*)?)@[^\s"'#]+\2(\s+#.*)?\s*$/.exec(line);
      if (use === null || !actions.has(use[3]!.toLowerCase())) return line;
      return `${use[1]}${use[2]}${use[3]}${use[4]}@<pinned>${use[2]}`;
    })
    .join("\n");
}

/** The gate's policy: its config and exceptions, and every workflow and action file (only planned pins may change one). */
function isPolicyFile(path: string): boolean {
  const name = basename(path);
  return (
    path === ".github/supply-chain.json" ||
    path === ".github/supply-chain-exceptions.json" ||
    path.startsWith(".github/workflows/") ||
    path.startsWith(".github/actions/") ||
    name === "action.yml" ||
    name === "action.yaml"
  );
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
