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
import { requiredPath, requirementSpec, requirements } from "../../ci/src/npm-required.ts";
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

/** What one parent occurrence must admit: each copy it brings whose target its current range excludes. */
interface Obligation {
  readonly fix: FixWork;
  /** The copy's gate location. */
  readonly location: string;
  readonly name: string;
  readonly to: string;
}

/**
 * `fixes` with `parents` on each npm fix whose override could be avoided, and a note on each fix that keeps one. A
 * parent occurrence gets one version, admitting every copy it must (from every fix of the batch); a parent with a
 * fix of its own keeps that fix's version, and only parents it when that version admits them.
 */
export async function withParents(fixes: ReadonlyArray<FixWork>, inputs: ParentInputs): Promise<FixWork[]> {
  const registry = new NpmRegistry(inputs.env.fetch);
  const search = new ParentSearch(registry, inputs);
  // Each excluding parent occurrence (lockfile + path), with what it must admit.
  const occurrences = new Map<string, { dependent: Dependent; lockfile: string; obligations: Obligation[] }>();
  // Copy locations whose every excluding parent must move for the copy to be locked.
  const blockedBy = new Map<string, string[]>();
  for (const fix of fixes) {
    if (fix.ecosystem !== "npm" || fix.to === undefined || fix.carries !== undefined || fix.malicious) continue;
    for (const location of fix.locations) {
      const { declaredByWorkspace, dependents } = dependentsOf(inputs.lockfiles, location);
      const excluding = dependents.filter((dependent) => !satisfies(fix.to!.version, dependent.spec));
      if (declaredByWorkspace || dependents.length === 0 || excluding.length === 0) continue;
      const lockfile = lockfilePathOf(inputs.lockfiles, location);
      const keys: string[] = [];
      for (const dependent of excluding) {
        const key = `${lockfile}|${dependent.path}`;
        const entry = occurrences.get(key) ?? { dependent, lockfile, obligations: [] };
        entry.obligations.push({ fix, location, name: fix.name, to: fix.to.version });
        occurrences.set(key, entry);
        keys.push(key);
      }
      blockedBy.set(`${fix.name}|${location}`, keys);
    }
  }
  // An occurrence must also keep admitting every other planned copy it supplies, even one its range admits today.
  for (const [key, entry] of occurrences) {
    for (const fix of fixes) {
      if (fix.ecosystem !== "npm" || fix.to === undefined || fix.carries !== undefined || fix.malicious) continue;
      for (const location of fix.locations) {
        if (entry.obligations.some((obligation) => obligation.fix === fix && obligation.location === location)) continue;
        if (lockfilePathOf(inputs.lockfiles, location) !== entry.lockfile) continue;
        if (dependentsOf(inputs.lockfiles, location).dependents.some((dependent) => dependent.path === entry.dependent.path)) {
          entry.obligations.push({ fix, location, name: fix.name, to: fix.to.version });
        }
      }
    }
    occurrences.set(key, entry);
  }
  const chosen = new Map<string, ParentMove[] | string>();
  for (const [key, { dependent, lockfile, obligations }] of occurrences) {
    const own = fixes.find((fix) => fix.ecosystem === "npm" && fix.name === dependent.name && fix.to !== undefined);
    // A search that can't finish leaves the override, as before parents were tried.
    const move = await search.parentFor(dependent, lockfile, obligations, own?.to?.version)
      .catch((error: unknown) => `searching ${dependent.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    chosen.set(key, typeof move === "string" ? move : obligations.map((obligation) => ({ ...move, unblocks: obligation.location })));
  }
  const result = fixes.map((fix) => {
    const parents: ParentMove[] = [];
    const notes: string[] = [];
    for (const location of fix.locations) {
      const keys = blockedBy.get(`${fix.name}|${location}`);
      if (keys === undefined) continue;
      const results = keys.map((key) => chosen.get(key)!);
      const why = results.find((result): result is string => typeof result === "string");
      if (why !== undefined) {
        notes.push(`${fix.name}@${fix.to!.version} at ${location} keeps an override: ${why}`);
        continue;
      }
      for (const result of results as ParentMove[][]) parents.push(...result.filter((move) => move.unblocks === location));
    }
    if (parents.length === 0 && notes.length === 0) return fix;
    return { ...fix, ...(parents.length === 0 ? {} : { parents }), ...(notes.length === 0 ? {} : { notes: [...(fix.notes ?? []), ...notes] }) };
  });
  return [...result, ...parentFixes(result)];
}

/**
 * Each chosen parent that has no fix of its own, as a fix with no targets: so it's coupled to the copies it unblocks
 * before the batch splits into units, and it anchors the direct-peer closure like any move.
 */
function parentFixes(fixes: ReadonlyArray<FixWork>): FixWork[] {
  // One fix per transition: occurrences in different lockfiles can start from, and move to, different versions.
  const byTransition = new Map<string, FixWork>();
  for (const fix of fixes) {
    for (const parent of fix.parents ?? []) {
      if (fixes.some((other) => other.ecosystem === "npm" && other.name === parent.name)) continue;
      const key = `${parent.name}|${parent.from}|${parent.to}`;
      const existing = byTransition.get(key);
      const locations = [...new Set([...(existing?.locations ?? []), parent.location])].sort();
      byTransition.set(key, existing !== undefined ? { ...existing, locations } : {
        ecosystem: "npm", name: parent.name, from: parent.from, locations, targets: [], unfixable: [], malicious: false, severity: fix.severity,
        to: { version: parent.to, line: parent.line, aged: true, major: false, blockers: [] }, problem: undefined,
      });
    }
  }
  return [...byTransition.values()];
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

  /**
   * The move of `dependent` (in `lockfile`) whose requirements admit every obligation's target, through the edge that
   * actually installs each copy; `pinned` when the parent's own security fix fixes its version. Or why there's none.
   */
  async parentFor(dependent: Dependent, lockfile: string, obligations: ReadonlyArray<Obligation>, pinned: string | undefined): Promise<Omit<ParentMove, "unblocks"> | string> {
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
    const packages = ((lockfiles.get(lockfile) ?? {}) as { packages?: Record<string, unknown> }).packages ?? {};
    const wanted = obligations.map((obligation) => `${obligation.name}@${obligation.to}`).join(", ");
    const versions = pinned !== undefined ? [pinned] : movesFrom(parent, from, listed, "above").filter((version) => line(version) === line(from));
    // Cheap filters first (line, age, the ranges for the copies); advisories are read for the survivors at once.
    const admitting: string[] = [];
    for (const version of versions) {
      if (!own && pinned === undefined) {
        const published = await this.#catalog.published({ ...parent, version });
        if (published === undefined || (now.getTime() - published.getTime()) / DAY_MS < config.releaseAgeDays) continue;
      }
      const manifest = doc.versions[version];
      if (isObject(manifest) && obligations.every((obligation) => admits(manifest, packages, dependent.path, obligation))) admitting.push(version);
    }
    if (admitting.length === 0) {
      return pinned !== undefined
        ? `${dependent.name}'s own security fix ${pinned} doesn't admit ${wanted}`
        : `no ${dependent.name} version in its line past the wait requires ${wanted} in ranges admitting them`;
    }
    const snapshot = await takeSnapshot([{ ...parent, version: from }], snapshotOptions(config, env, new ActionsGitHub(env.fetch, env.githubToken)),
      admitting.map((version) => ({ ...parent, version })));
    const parentLocation = npmLocation(lockfile, dependent.path);
    const movable = dependentsOf(lockfiles, parentLocation);
    for (const version of admitting) {
      if (pinned === undefined && !fixes(snapshot, parent, from, [], version)) continue;
      if ((await this.#identity.problems({ ...parent, version: from }, version)).length > 0) continue;
      if (!movable.declaredByWorkspace && !(movable.dependents.length > 0 && movable.dependents.every((entry) => satisfies(version, entry.spec)))) continue;
      return { name: dependent.name, from, to: version, location: parentLocation, line: line(version) };
    }
    return `no ${dependent.name} version admitting ${wanted} is free of new advisories, keeps its publisher, and moves without an override itself`;
  }
}

/**
 * Whether a parent version's requirements admit an obligation's target: every edge of its manifest that would
 * install the very copy (an ordinary dependency below the parent, a peer beside it, as npm places them) admits it,
 * and there's at least one.
 */
function admits(manifest: Record<string, unknown>, packages: Readonly<Record<string, unknown>>, parentPath: string, obligation: Obligation): boolean {
  const key = obligation.location.slice(obligation.location.lastIndexOf("node_modules/") + "node_modules/".length);
  const copy = obligation.location.slice(obligation.location.indexOf("node_modules/"));
  const applicable = requirements(manifest).filter((edge) => edge.key === key && requiredPath(packages, parentPath, edge.key, edge.peer) === copy);
  return applicable.length > 0 && applicable.every((edge) => {
    const spec = requirementSpec(edge.key, edge.spec);
    return spec.name === obligation.name && satisfies(obligation.to, spec.range);
  });
}

/** The lockfile path whose directory prefixes a gate location. */
function lockfilePathOf(lockfiles: ReadonlyMap<string, unknown>, location: string): string {
  const { lock } = lockfileOf(lockfiles, location);
  for (const [path, candidate] of lockfiles) if (candidate === lock) return path;
  throw new Error(`no lockfile holds ${location}`);
}
