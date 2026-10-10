/**
 * The checks secure-it runs on the agent's edit before it publishes anything
 * (design item 23). Any problem stops the publication:
 *
 *   0. the gate's own policy is untouched, major or not: its config, its
 *      exceptions, and every workflow and action file — in a file a planned
 *      action pin names, everything but that pin's ref and comment (checked
 *      first, since `compare` reads policy from head);
 *      recorded floors and their declarations are preserved, except exact
 *      planned security changes, additions, or removals in a floor-removal plan;
 *      compatibility floors never change;
 *   1. `compare` base → working tree passes (it judges every version that
 *      changed, transitives a parent update pulled in included);
 *   2. every planned move landed exactly: npm, the lockfile entry at each
 *      planned location is `to`; Gradle, each planned configuration declares
 *      what base did with `from` declared as `to` (a floor: `to` added), and
 *      nothing else, and resolves it (or above: then the exact declarations
 *      show Gradle's conflict resolution picked a version another path
 *      requires, which `compare` has judged); Actions, every use in each planned file is
 *      pinned to the tag's commit with `# <to>`;
 *   3. none of the targeted advisories affects any version of a planned
 *      package left in the tree (a swap for another vulnerable version would
 *      pass `compare` as inherited, not here), using compare's head snapshot;
 *   4. no direct dependency outside the planned packages changed version, and
 *      no action use outside the plan changed; a planned Gradle plugin
 *      update's own fallout aside, when nothing but the planned edits changed
 *      (`pluginDriven`; a floor added or kept is an edit, so it never qualifies);
 *   5. only dependency files changed, unless a move is a major.
 */
import { computedNpmProblems } from "../../remediation/src/npm-file-checks.ts";
import type { CooldownEvaluation } from "../../ci/src/cooldown.ts";
import { type GateEnvironment, type GradleInputs, runCompare } from "../../ci/src/gate.ts";
import type { GradleInventory } from "../../ci/src/gradle.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { versionScheme } from "../../ci/src/versions.ts";
import {
  actionsOutsidePlan,
  declaredAt,
  directChangesOutside,
  directVersions,
  isDependencyFile,
  pinsLanded,
  type PlannedPin,
  policyFence,
  resolvedAt,
} from "../../remediation/src/edit-checks.ts";
import { lockfilesOf } from "../../remediation/src/inventories.ts";
import { pluginDriven } from "../../remediation/src/plugin-driven.ts";

import { preservedFloors } from "./floor-checks.ts";
import { verifyRemovalEdit } from "./floor-verification.ts";
import { type ChangePlan, lockfileOf, packageKey, type PlannedMove } from "./plan.ts";

export interface VerifyInputs {
  readonly npmFiles?: ReadonlyMap<string, string>;
  readonly plan: ChangePlan;
  readonly base: Tree;
  readonly head: Tree;
  readonly env: GateEnvironment;
  readonly gradle: GradleInputs;
  /** Paths the edit changed, added or removed in the working copy. */
  readonly changedFiles: ReadonlyArray<string>;
  /** Tracked paths whose file mode changed. */
  readonly modeChanged: ReadonlyArray<string>;
  /** Told what the verifying comparison's cooldown holds, whenever the comparison runs. */
  readonly cooldown?: (evaluation: CooldownEvaluation) => void;
}

/** What's wrong with the edit; empty when it can be published. */
export async function verifyPlan(inputs: VerifyInputs): Promise<string[]> {
  const { plan, base, head, env, gradle } = inputs;
  const problems: string[] = [];

  const pins = pinsOf(plan);
  const fenced = await policyFence(inputs.changedFiles, pins, base, head);
  if (fenced.length > 0) return fenced;
  const npm = await computedNpmProblems(inputs.npmFiles, head, plan.moves.some((move) => move.major), base, inputs.changedFiles);
  if (npm.length > 0) return npm;
  const floors = await preservedFloors(plan, base, head, gradle);
  if (floors.length > 0) return floors;

  if (plan.kind === "floor-removal") return verifyRemovalEdit(inputs);

  const compared = await runCompare(base, head, env, gradle);
  problems.push(...compared.failures.map((failure) => `compare: ${failure}`));
  inputs.cooldown?.(compared.cooldown);

  problems.push(...(await landed(plan, head, gradle.base, gradle.head)));
  problems.push(...(await pinsLanded(pins, head)));

  const planned = new Set(plan.packages);
  for (const finding of compared.headFindings) {
    if (!planned.has(packageKey(finding))) continue;
    const targeted = plan.moves.filter((move) => move.ecosystem === finding.ecosystem && move.name === finding.name && move.advisories.some((advisory) => finding.ids.includes(advisory)));
    if (targeted.length > 0) problems.push(`${finding.name}@${finding.version} still has ${finding.advisory}, which the plan was to fix`);
  }

  // Verified exactly by their own checks: npm files holding the planned text, and planned pins' files (masked but for the pins).
  const exactNpm: string[] = [];
  for (const [path, text] of inputs.npmFiles ?? []) if (await head.read(path) === text) exactNpm.push(path);
  const edits = { changedFiles: inputs.changedFiles, modeChanged: inputs.modeChanged, textChecked: new Set([...exactNpm, ...pins.flatMap((pin) => pin.locations)]), bytesChecked: new Set<string>() };
  const driven = await pluginDriven(base, head, { base: gradle.base, head: gradle.head }, plan.moves.filter((move) => move.mechanism === "gradle-declared"), edits);
  const before = await directVersions(base, gradle.base);
  const after = await directVersions(head, gradle.head);
  // A planned Gradle package is exempt only where it's planned (`landed` checks those exactly); npm's are checked by lockfile.
  const plannedAt = (name: string, where: string) => plan.moves.some((move) => move.ecosystem === "Maven" && move.name === name && move.locations.includes(where));
  problems.push(...directChangesOutside(before, after, (ecosystem, name, where) =>
    ecosystem === "Maven" ? plannedAt(name, where) || driven(name, where) : planned.has(`${ecosystem}|${name}`)));
  problems.push(...(await actionsOutsidePlan(pins, base, head)));

  if (!plan.moves.some((move) => move.major)) {
    const actions = plan.moves.some((move) => move.mechanism === "action-pin");
    const outside = inputs.changedFiles.filter((path) => !isDependencyFile(path, actions));
    if (outside.length > 0) problems.push(`the edit changed ${outside.join(", ")}, which only a major move may touch`);
  }
  return problems;
}

async function landed(plan: ChangePlan, head: Tree, baseGradle: GradleInventory | undefined, gradle: GradleInventory | undefined): Promise<string[]> {
  const problems: string[] = [];
  const locks = await lockfilesOf(head);
  for (const move of plan.moves) {
    for (const location of move.locations) {
      if (move.ecosystem === "npm") {
        const { lock, key } = lockfileOf(locks, location);
        const entry = ((lock ?? {}) as { packages?: Record<string, { version?: string; name?: string }> }).packages?.[key];
        if (entry?.version !== move.to) problems.push(`${move.name} at ${location} is ${entry?.version ?? "gone"}, not ${move.to}`);
      } else if (move.ecosystem === "Maven") {
        const was = declaredAt(baseGradle, location, move.name);
        const declared = declaredAt(gradle, location, move.name);
        const resolved = resolvedAt(gradle, location, move.name);
        if (!plannedDeclarations(was, declared, move)) {
          problems.push(`${location} declares ${move.name} ${declared.length === 0 ? "nowhere" : [...declared].sort().join(", ")} (was ${was.length === 0 ? "nothing" : [...was].sort().join(", ")}), not just ${move.mechanism === "gradle-floor" ? `${move.to} added` : `one version declared as ${move.to}`}`);
        }
        if (resolved === undefined) problems.push(`${location} no longer resolves ${move.name}`);
        else if (versionScheme("Maven").compare(resolved, move.to) < 0) problems.push(`${location} resolves ${move.name} ${resolved}, below ${move.to}`);
      }
    }
  }
  return problems;
}

/**
 * Whether a configuration's declarations changed exactly as planned: a floor adds one `to` and removes nothing; a
 * declaration move turns the copies of one version (the one that resolved to `from`, which needn't equal it) into
 * `to`, adding and removing nothing else.
 */
function plannedDeclarations(was: ReadonlyArray<string>, now: ReadonlyArray<string>, move: PlannedMove): boolean {
  const added = without(now, was);
  const removed = without(was, now);
  if (added.length === 0 || added.some((version) => version !== move.to)) return false;
  if (move.mechanism === "gradle-floor") return added.length === 1 && removed.length === 0;
  return removed.length === added.length && removed.every((version) => version === removed[0]);
}

/** `from` with one copy of each of `minus`'s entries taken out (multisets). */
function without(from: ReadonlyArray<string>, minus: ReadonlyArray<string>): string[] {
  const left = [...from];
  for (const version of minus) {
    const at = left.indexOf(version);
    if (at !== -1) left.splice(at, 1);
  }
  return left;
}

function pinsOf(plan: ChangePlan): PlannedPin[] {
  return plan.moves.filter((move) => move.mechanism === "action-pin").map((move) => ({ name: move.name, to: move.to, commitSha: move.commitSha, locations: move.locations }));
}
