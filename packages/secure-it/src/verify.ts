/**
 * The checks secure-it runs on the agent's edit before it publishes anything
 * (design item 23). Any problem stops the publication:
 *
 *   0. the gate's own policy is untouched, major or not: its config, its
 *      exceptions, and every workflow and action file — in a file a planned
 *      action pin names, everything but that pin's ref and comment (checked
 *      first, since `compare` reads policy from head);
 *      recorded floors and their declarations are preserved, except exact
 *      planned security changes and additions; compatibility floors never change;
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
 *      pass `compare` as inherited, not here), using compare's head snapshot;
 *   4. no direct dependency outside the planned packages changed version, and
 *      no action use outside the plan changed;
 *   5. only dependency files changed, unless a move is a major.
 */
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

import { preservedFloors } from "./floor-checks.ts";
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

  const pins = pinsOf(plan);
  const fenced = await policyFence(inputs.changedFiles, pins, base, head);
  if (fenced.length > 0) return fenced;
  const floors = await preservedFloors(plan, base, head, gradle);
  if (floors.length > 0) return floors;

  const compared = await runCompare(base, head, env, gradle);
  problems.push(...compared.failures.map((failure) => `compare: ${failure}`));

  problems.push(...(await landed(plan, head, gradle.head)));
  problems.push(...(await pinsLanded(pins, head)));

  const planned = new Set(plan.packages);
  for (const finding of compared.headFindings) {
    if (!planned.has(packageKey(finding))) continue;
    const targeted = plan.moves.filter((move) => move.ecosystem === finding.ecosystem && move.name === finding.name && move.advisories.some((advisory) => finding.ids.includes(advisory)));
    if (targeted.length > 0) problems.push(`${finding.name}@${finding.version} still has ${finding.advisory}, which the plan was to fix`);
  }

  const before = await directVersions(base, gradle.base);
  const after = await directVersions(head, gradle.head);
  problems.push(...directChangesOutside(before, after, (ecosystem, name) => planned.has(`${ecosystem}|${name}`)));
  problems.push(...(await actionsOutsidePlan(pins, base, head)));

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
      }
    }
  }
  return problems;
}

function pinsOf(plan: ChangePlan): PlannedPin[] {
  return plan.moves.filter((move) => move.mechanism === "action-pin").map((move) => ({ name: move.name, to: move.to, commitSha: move.commitSha, locations: move.locations }));
}
