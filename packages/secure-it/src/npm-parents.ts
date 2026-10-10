/**
 * Parent first, where npm would otherwise need an override: when a dependent's
 * range excludes a transitive copy's security target, secure-it first looks
 * for a version of that dependent which admits it, so the parent moves and the
 * copy is locked inside the parent's own range, instead of an override pinning
 * it against that range.
 *
 * For each excluding dependent P (not bundled: a bundled parent can't move on
 * its own), the candidate is P's lowest version in its own compatible line,
 * above its current one, that is at least `releaseAgeDays` old (own packages:
 * any age), still requires the copy with a range admitting the target, adds
 * no advisory group of its own and no malware, passes the publisher identity
 * check, and can itself move without an override (a workspace declares it, or
 * every dependent's range admits it). If every excluding dependent of a
 * location has one, that location's copy is locked and the parents move with
 * it; otherwise that location keeps today's override. Parents are aged, so the
 * gate needs no new justification for them.
 */
import { ActionsGitHub } from "../../ci/src/actions-github.ts";
import { IdentityCheck } from "../../ci/src/candidates.ts";
import { NpmCatalog } from "../../ci/src/catalogs.ts";
import { type Config, isOwnPackage } from "../../ci/src/config.ts";
import type { Exceptions } from "../../ci/src/exceptions.ts";
import { type GateEnvironment, snapshotOptions } from "../../ci/src/gate.ts";
import { npmLocation } from "../../ci/src/inventory.ts";
import { isObject } from "../../ci/src/json.ts";
import { lockedPackages } from "../../ci/src/npm-lock.ts";
import { NpmRegistry } from "../../ci/src/npm-registry.ts";
import { requirementSpec, requirements } from "../../ci/src/npm-required.ts";
import { takeSnapshot } from "../../ci/src/take-snapshot.ts";
import { compatibleLine, fixes, movesFrom } from "../../ci/src/young-fixes.ts";

import { type Dependent, dependentsOf, type FixWork, lockfileOf, type ParentMove, satisfies } from "./plan.ts";

const DAY_MS = 86_400_000;

export interface ParentInputs {
  readonly lockfiles: ReadonlyMap<string, unknown>;
  readonly env: GateEnvironment;
  readonly config: Config;
  readonly exceptions: Exceptions;
}

/** `fixes` with `parents` on each npm fix whose override could be avoided, and notes on why it couldn't elsewhere. */
export async function withParents(fixes: ReadonlyArray<FixWork>, inputs: ParentInputs): Promise<{ readonly fixes: FixWork[]; readonly notes: string[] }> {
  const registry = new NpmRegistry(inputs.env.fetch);
  const search = new ParentSearch(registry, inputs);
  const notes: string[] = [];
  const result: FixWork[] = [];
  for (const fix of fixes) {
    if (fix.ecosystem !== "npm" || fix.to === undefined || fix.carries !== undefined || fix.malicious) {
      result.push(fix);
      continue;
    }
    const parents: ParentMove[] = [];
    for (const location of fix.locations) {
      const { declaredByWorkspace, dependents } = dependentsOf(inputs.lockfiles, location);
      const excluding = dependents.filter((dependent) => !satisfies(fix.to!.version, dependent.spec));
      if (declaredByWorkspace || dependents.length === 0 || excluding.length === 0) continue;
      const found: ParentMove[] = [];
      for (const dependent of excluding) {
        // A search that can't finish leaves the override, as before parents were tried.
        const move = await search.parentFor(dependent, location, fix.name, fix.to.version)
          .catch((error: unknown) => `searching ${dependent.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (typeof move === "string") {
          notes.push(`${fix.name}@${fix.to.version} at ${location} keeps an override: ${move}`);
          break;
        }
        found.push(move);
      }
      if (found.length === excluding.length) parents.push(...found);
    }
    result.push(parents.length === 0 ? fix : { ...fix, parents });
  }
  return { fixes: result, notes };
}

class ParentSearch {
  readonly #registry: NpmRegistry;
  readonly #catalog: NpmCatalog;
  readonly #inputs: ParentInputs;
  readonly #identity: IdentityCheck;

  constructor(registry: NpmRegistry, inputs: ParentInputs) {
    this.#registry = registry;
    this.#catalog = new NpmCatalog(registry);
    this.#inputs = inputs;
    const npm = [...inputs.lockfiles].map(([path, lock]) => ({ path, packages: lockedPackages(lock), bundleProblems: [] }));
    this.#identity = new IdentityCheck(registry, npm, inputs.exceptions, inputs.env.now().toISOString().slice(0, 10));
  }

  /** The move of `dependent` that admits `to` for the copy at `location`, or why there's none. */
  async parentFor(dependent: Dependent, location: string, name: string, to: string): Promise<ParentMove | string> {
    const { config, env, lockfiles } = this.#inputs;
    if (dependent.bundled) return `${dependent.name} at ${dependent.path} is bundled in its parent's tarball`;
    if (dependent.version === undefined) return `${dependent.name} at ${dependent.path} has no locked version`;
    const parent = { ecosystem: "npm" as const, name: dependent.name };
    const from = dependent.version;
    const listed = await this.#catalog.versions(parent);
    if (listed === undefined) return `the registry doesn't list ${dependent.name}'s versions`;
    const line = (version: string) => compatibleLine(config, parent, version);
    const own = isOwnPackage(config.ownPackages, parent);
    const now = env.now();
    const doc = await this.#registry.packument(dependent.name);
    const installedAs = location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);
    // Cheap filters first (line, age, the range for the copy); advisories are read for the survivors at once.
    const admitting: string[] = [];
    for (const version of movesFrom(parent, from, listed, "above").filter((version) => line(version) === line(from))) {
      if (!own) {
        const published = await this.#catalog.published({ ...parent, version });
        if (published === undefined || (now.getTime() - published.getTime()) / DAY_MS < config.releaseAgeDays) continue;
      }
      const manifest = doc.versions[version];
      if (!isObject(manifest)) continue;
      const edge = requirements(manifest).find((candidate) => candidate.key === installedAs);
      if (edge === undefined) continue;
      const spec = requirementSpec(edge.key, edge.spec);
      if (spec.name !== name || !satisfies(to, spec.range)) continue;
      admitting.push(version);
    }
    if (admitting.length === 0) return `no ${dependent.name} version in its line past the wait requires ${name} in a range admitting ${to}`;
    const snapshot = await takeSnapshot([{ ...parent, version: from }], snapshotOptions(config, env, new ActionsGitHub(env.fetch, env.githubToken)),
      admitting.map((version) => ({ ...parent, version })));
    const parentLocation = npmLocation(lockfilePathOf(lockfiles, location), dependent.path);
    const movable = dependentsOf(lockfiles, parentLocation);
    for (const version of admitting) {
      if (!fixes(snapshot, parent, from, [], version)) continue;
      if ((await this.#identity.problems({ ...parent, version: from }, version)).length > 0) continue;
      if (!movable.declaredByWorkspace && !(movable.dependents.length > 0 && movable.dependents.every((entry) => satisfies(version, entry.spec)))) continue;
      return { name: dependent.name, from, to: version, location: parentLocation, unblocks: location };
    }
    return `no ${dependent.name} version admitting ${name}@${to} is free of new advisories, keeps its publisher, and moves without an override itself`;
  }
}

/** The lockfile path whose directory prefixes a gate location. */
function lockfilePathOf(lockfiles: ReadonlyMap<string, unknown>, location: string): string {
  const { lock } = lockfileOf(lockfiles, location);
  for (const [path, candidate] of lockfiles) if (candidate === lock) return path;
  throw new Error(`no lockfile holds ${location}`);
}
