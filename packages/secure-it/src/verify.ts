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
 *   2. every planned move landed: npm, the lockfile entry at each planned
 *      location is `to`; Gradle, each planned configuration resolves `to` (or
 *      above: Gradle's conflict resolution picked a version another path
 *      requires, which `compare` has judged); Actions, every use in each
 *      planned file is pinned to the tag's commit with `# <to>`;
 *   3. none of the targeted advisories affects any version of a planned
 *      package left in the tree (a swap for another vulnerable version would
 *      pass `compare` as inherited, not here), using compare's head snapshot,
 *      nor any version of a package a carrier move carries (a bundled npm copy,
 *      or the Gradle module a moved parent brings); and each npm carrier's
 *      head copies lock the registry's archive of its target and record exactly
 *      the bundle that archive ships;
 *   4. no direct npm dependency outside the planned packages changed version,
 *      no action use outside the plan changed, and Gradle resolves and declares
 *      exactly what the plan's reference does (the base with the planned
 *      declaration moves and floors applied by Gradle, so a planned plugin
 *      update's own fallout is in it: `gradle-reference.ts`);
 *   5. only dependency files changed, unless a move is a major.
 */
import { computedNpmProblems } from "../../remediation/src/npm-file-checks.ts";
import { registryIntegrity } from "../../ci/src/carrier-fixes.ts";
import { type BundleReader, bundleMismatches } from "../../ci/src/npm-bundles.ts";
import { lockedPackages } from "../../ci/src/npm-lock.ts";
import { NpmRegistry } from "../../ci/src/npm-registry.ts";
import type { CooldownEvaluation } from "../../ci/src/cooldown.ts";
import { bundleReader, type GateEnvironment, type GradleInputs, runCompare } from "../../ci/src/gate.ts";
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
  UNVERSIONED,
} from "../../remediation/src/edit-checks.ts";
import { referenceDifferences, type ReferenceFloor, type ReferenceMove, referenceProblems } from "../../remediation/src/gradle-reference.ts";
import { lockfilesOf } from "../../remediation/src/inventories.ts";

import { preservedFloors } from "./floor-checks.ts";
import { verifyRemovalEdit } from "./floor-verification.ts";
import { type ChangePlan, lockfileOf, packageKey } from "./plan.ts";

export interface VerifyInputs {
  readonly npmFiles?: ReadonlyMap<string, string>;
  readonly plan: ChangePlan;
  readonly base: Tree;
  readonly head: Tree;
  readonly env: GateEnvironment;
  readonly gradle: GradleInputs;
  /**
   * The base's inventory with the plan applied by Gradle (its declaration moves and floors, or, removing floors,
   * without them): what head's must be.
   */
  readonly reference: GradleInventory | undefined;
  /** Paths the edit changed, added or removed in the working copy. */
  readonly changedFiles: ReadonlyArray<string>;
  /** Told what the verifying comparison's cooldown holds, whenever the comparison runs. */
  readonly cooldown?: (evaluation: CooldownEvaluation) => void;
  /** Reads carrier archives; one shared with planning saves downloads. */
  readonly bundles?: BundleReader;
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

  problems.push(...(await landed(plan, head, gradle.head)));
  problems.push(...(await pinsLanded(pins, head)));

  const planned = new Set(plan.packages);
  for (const finding of compared.headFindings) {
    // By alias group, as the comparison groups them: the same advisory can come back under another id.
    const isTarget = (advisory: string) => compared.group(advisory) === finding.advisory;
    const carriers = plan.moves.filter((move) => move.ecosystem === finding.ecosystem &&
      (move.carries ?? []).some((carried) => carried.name === finding.name && carried.advisories.some(isTarget)));
    if (carriers.length > 0) problems.push(`${finding.name}@${finding.version} still has ${finding.advisory}, which moving ${carriers.map((move) => move.name).join(", ")} was to fix`);
    if (!planned.has(packageKey(finding))) continue;
    const targeted = plan.moves.filter((move) => move.ecosystem === finding.ecosystem && move.name === finding.name && move.advisories.some(isTarget));
    if (targeted.length > 0) problems.push(`${finding.name}@${finding.version} still has ${finding.advisory}, which the plan was to fix`);
  }
  problems.push(...(await carriersShipped(plan, head, inputs.bundles ?? bundleReader(env), new NpmRegistry(env.fetch))));

  problems.push(...directChangesOutside(await directVersions(base), await directVersions(head), (ecosystem, name) => planned.has(`${ecosystem}|${name}`)));
  const reference = referencePlan(plan, gradle.base);
  problems.push(...reference.problems, ...referenceProblems(gradle.base, inputs.reference, reference.moves, reference.floors), ...referenceDifferences(inputs.reference, gradle.head));
  problems.push(...(await actionsOutsidePlan(pins, base, head)));

  if (!plan.moves.some((move) => move.major)) {
    const actions = plan.moves.some((move) => move.mechanism === "action-pin");
    const outside = inputs.changedFiles.filter((path) => !isDependencyFile(path, actions));
    if (outside.length > 0) problems.push(`the edit changed ${outside.join(", ")}, which only a major move may touch`);
  }
  return problems;
}

/**
 * Each carrier move's head copies lock the registry's archive of `to`, and record exactly the bundle that archive
 * ships: npm wrote the bundled entries, and they're what the gate scanned.
 */
async function carriersShipped(plan: ChangePlan, head: Tree, reader: BundleReader, registry: NpmRegistry): Promise<string[]> {
  const problems: string[] = [];
  const locks = await lockfilesOf(head);
  for (const move of plan.moves.filter((move) => move.ecosystem === "npm" && move.carries !== undefined)) {
    const published = await registryIntegrity(registry, move.name, move.to);
    for (const location of move.locations) {
      const { lock, key } = lockfileOf(locks, location);
      const copy = lockedPackages(lock).find((pkg) => pkg.path === key);
      if (copy === undefined || copy.version !== move.to) continue;
      if (published === undefined || copy.integrity !== published) {
        problems.push(`${move.name} at ${location} doesn't lock the registry's ${move.to} archive`);
        continue;
      }
      const bundle = await reader.read(move.name, move.to, copy.integrity);
      if (!bundle.complete) problems.push(`${move.name} at ${location}: its bundle can't be checked: ${bundle.reason}`);
      else problems.push(...bundleMismatches(lockedPackages(lock), key, bundle).map((problem) => `${location}: ${problem}`));
    }
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
        const resolved = resolvedAt(gradle, location, move.name);
        if (resolved === undefined) problems.push(`${location} no longer resolves ${move.name}`);
        else if (versionScheme("Maven").compare(resolved, move.to) < 0) problems.push(`${location} resolves ${move.name} ${resolved}, below ${move.to}`);
      }
    }
  }
  return problems;
}

/**
 * The plan's Gradle moves and floors for its reference. A declaration move's `from` is the one version the base
 * declares at its locations (the version that resolved there needn't be it); none, or several, can't be moved
 * faithfully.
 */
export function referencePlan(plan: ChangePlan, base: GradleInventory | undefined): { moves: ReferenceMove[]; floors: ReferenceFloor[]; problems: string[] } {
  const moves: ReferenceMove[] = [];
  const floors: ReferenceFloor[] = [];
  const problems: string[] = [];
  for (const move of plan.moves) {
    if (move.mechanism === "gradle-floor") {
      floors.push({ name: move.name, version: move.to, reason: move.advisories.join(", "), locations: move.locations });
    } else if (move.mechanism === "gradle-declared") {
      const declared = [...new Set(move.locations.flatMap((location) => declaredAt(base, location, move.name)).filter((version) => version !== UNVERSIONED))];
      if (declared.length === 1) moves.push({ name: move.name, from: declared[0]!, to: move.to, locations: move.locations });
      else problems.push(`${move.name} is declared at ${declared.length === 0 ? "no version" : declared.sort().join(", ")} across ${move.locations.join(", ")}: not one version to move to ${move.to}`);
    }
  }
  return { moves, floors, problems };
}

function pinsOf(plan: ChangePlan): PlannedPin[] {
  return plan.moves.filter((move) => move.mechanism === "action-pin").map((move) => ({ name: move.name, to: move.to, commitSha: move.commitSha, locations: move.locations }));
}
