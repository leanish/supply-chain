/**
 * Fixes that arrive inside a carrier: a bundled npm copy ships in its
 * carrier's tarball, so the only way to replace it is another version of the
 * carrier. The same rule chooses that version in secure-it and proves it in
 * the gate, reading each carrier version's bundle from its authenticated
 * registry archive (`npm-bundles.ts`).
 *
 * A carrier version *fixes* when
 *   - every carried target (a bundled package's advisory group) is gone: no
 *     package of that name anywhere in its bundle has it, wherever it sits;
 *   - its bundle adds no package + advisory group pair the old bundle lacked,
 *     and holds no malware;
 *   - the carrier itself still fixes its own targets, if it has any, and adds
 *     no advisory group of its own (`fixes` in young-fixes.ts).
 * The rule is the security rule: ascending from the current version, the
 * first compatible line with a fixing version; in it, the lowest fixing
 * version at least `releaseAgeDays` old, else the lowest (own packages: the
 * lowest, whatever its age). Leaving malware is the malware rule instead: the
 * nearest clean version at least `releaseAgeDays` old, newer in its line
 * first, then older in its line, then newer lines.
 *
 * Bundles are read lazily, in that order, and only as far as the decision
 * needs: every version before the first fix, then only aged versions in its
 * line. A version whose bundle can't be read, or whose publish time is
 * unknown, ends the search as incomplete: it never counts as "doesn't fix".
 * Each batch of newly read bundles extends one advisory snapshot over
 * everything read so far, and the decision is taken on the last one, so its
 * alias groups are consistent.
 */
import type { Config } from "./config.ts";
import { isObject } from "./json.ts";
import type { BundleContents } from "./npm-bundles.ts";
import type { NpmRegistry } from "./npm-registry.ts";
import type { PackageName, PackageVersion } from "./package-version.ts";
import type { Snapshot } from "./snapshot.ts";
import { versionScheme } from "./versions.ts";
import { compatibleLine, fixes, groupsOf, type VersionCatalog } from "./young-fixes.ts";

const DAY_MS = 86_400_000;
/** Bundles read before each new advisory snapshot. */
const BATCH = 4;

export type CompleteBundle = Extract<BundleContents, { complete: true }>;

/** An advisory to remove from a bundled package: any id of its alias group. */
export interface CarriedTarget {
  readonly name: string;
  readonly advisory: string;
}

export interface CarrierSearch {
  readonly carrier: string;
  readonly from: string;
  /** The bundle `from` ships, read from its locked, authenticated archive. */
  readonly fromBundle: CompleteBundle;
  readonly carried: ReadonlyArray<CarriedTarget>;
  /** Advisories (any id of their groups) on the carrier itself the move must fix too. */
  readonly own: ReadonlyArray<string>;
  /** Leaving malware in the carrier or its bundle: the malware rule. */
  readonly malicious: boolean;
  /** Candidate versions, ascending (`movesFrom`, `any` direction for malware). */
  readonly versions: ReadonlyArray<string>;
  /** Own packages skip the wait. */
  readonly ownPackage: boolean;
}

export interface CarrierServices {
  readonly bundles: (version: string) => Promise<BundleContents>;
  /** An advisory snapshot covering exactly these versions (and whatever else the caller adds). */
  readonly scan: (packages: ReadonlyArray<PackageVersion>) => Promise<Snapshot>;
  readonly catalog: VersionCatalog;
  readonly config: Config;
  readonly now: Date;
}

export type CarrierChoice =
  | { readonly kind: "chosen"; readonly version: string; readonly line: string; readonly aged: boolean; readonly bundle: CompleteBundle; readonly snapshot: Snapshot }
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "incomplete"; readonly reason: string };

/** The carrier version the rule picks for `search`. */
export async function chooseCarrier(search: CarrierSearch, services: CarrierServices): Promise<CarrierChoice> {
  const state = new SearchState(search, services);
  return search.malicious ? leaveMalware(search, services, state) : fixTargets(search, services, state);
}

async function fixTargets(search: CarrierSearch, services: CarrierServices, state: SearchState): Promise<CarrierChoice> {
  const line = (version: string) => compatibleLine(services.config, carrierName(search), version);
  let first: string | undefined;
  for (let at = 0; at < search.versions.length; at++) {
    const version = search.versions[at]!;
    if (first !== undefined && line(version) !== line(first)) break;
    if (first !== undefined && !search.ownPackage) {
      // Past the first fix only an aged version can still win, so a young one's bundle isn't read.
      const age = await ageOf(search, services, version);
      if (age === undefined) return incomplete(`the publish time of ${search.carrier}@${version} is unknown, so an older fix in its line can't be ruled out`);
      if (age < services.config.releaseAgeDays) continue;
    }
    // Before the first fix every version is read, a batch of its line at a time; after it, only the aged one judged.
    const ahead = first === undefined ? search.versions.slice(at, at + BATCH).filter((next) => line(next) === line(version)) : [version];
    const verdict = await state.fixes(version, ahead);
    if (verdict.kind === "incomplete") return verdict;
    if (!verdict.fixes) continue;
    if (first === undefined) {
      first = version;
      if (search.ownPackage) return state.chosen(version, line(version), false);
      const age = await ageOf(search, services, version);
      if (age === undefined) return incomplete(`the publish time of ${search.carrier}@${version} is unknown`);
      if (age >= services.config.releaseAgeDays) return state.chosen(version, line(version), true);
      continue;
    }
    return state.chosen(version, line(version), true);
  }
  if (first !== undefined) return state.chosen(first, line(first), false);
  return { kind: "none", reason: `no ${search.carrier} version above ${search.from} ships a bundle without ${describe(search.carried)}${search.own.length === 0 ? "" : ` and fixes ${search.own.join(", ")}`}` };
}

async function leaveMalware(search: CarrierSearch, services: CarrierServices, state: SearchState): Promise<CarrierChoice> {
  const name = carrierName(search);
  const line = (version: string) => compatibleLine(services.config, name, version);
  const sameLine = (version: string) => line(version) === line(search.from);
  const newer = search.versions.filter((version) => isAbove(version, search.from));
  const order = [...newer.filter(sameLine), ...search.versions.filter((version) => !isAbove(version, search.from) && sameLine(version)).reverse(), ...newer.filter((version) => !sameLine(version))];
  for (const version of order) {
    if (!search.ownPackage) {
      const age = await ageOf(search, services, version);
      if (age === undefined) return incomplete(`the publish time of ${search.carrier}@${version} is unknown`);
      if (age < services.config.releaseAgeDays) continue;
    }
    const verdict = await state.fixes(version, [version]);
    if (verdict.kind === "incomplete") return verdict;
    if (verdict.fixes) return state.chosen(version, line(version), !search.ownPackage);
  }
  return { kind: "none", reason: `no clean ${search.carrier} version${search.ownPackage ? "" : ` at least ${services.config.releaseAgeDays} days old`} to leave the malicious bundle of ${search.from} for` };
}

/** Reads bundles in batches and judges versions on one snapshot extended with each batch. */
class SearchState {
  readonly #search: CarrierSearch;
  readonly #services: CarrierServices;
  readonly #bundles = new Map<string, BundleContents>();
  #snapshot: Snapshot | undefined;

  constructor(search: CarrierSearch, services: CarrierServices) {
    this.#search = search;
    this.#services = services;
  }

  /** Whether `version` fixes; `ahead` (starting with it) are read together when it isn't read yet. */
  async fixes(version: string, ahead: ReadonlyArray<string>): Promise<{ readonly kind: "judged"; readonly fixes: boolean } | Extract<CarrierChoice, { kind: "incomplete" }>> {
    if (!this.#bundles.has(version)) {
      for (const next of ahead) if (!this.#bundles.has(next)) this.#bundles.set(next, await this.#services.bundles(next));
      this.#snapshot = await this.#services.scan(this.#covered());
    }
    const bundle = this.#bundles.get(version)!;
    if (!bundle.complete) return incomplete(`${this.#search.carrier}@${version}'s bundle can't be read: ${bundle.reason}`);
    return { kind: "judged", fixes: carrierFixes(this.#search, version, bundle, this.#snapshot!) };
  }

  chosen(version: string, line: string, aged: boolean): CarrierChoice {
    const bundle = this.#bundles.get(version);
    if (bundle === undefined || !bundle.complete || this.#snapshot === undefined) throw new Error(`${this.#search.carrier}@${version} was chosen unread`);
    return { kind: "chosen", version, line, aged, bundle, snapshot: this.#snapshot };
  }

  #covered(): PackageVersion[] {
    const carrier = (version: string): PackageVersion => ({ ecosystem: "npm", name: this.#search.carrier, version });
    const bundled = (bundle: CompleteBundle) => bundle.packages.map((pkg): PackageVersion => ({ ecosystem: "npm", name: pkg.name, version: pkg.version }));
    const read = [...this.#bundles.entries()].flatMap(([version, bundle]) => [carrier(version), ...(bundle.complete ? bundled(bundle) : [])]);
    return [carrier(this.#search.from), ...bundled(this.#search.fromBundle), ...read];
  }
}

/** The predicate in the file header, on one snapshot covering both bundles and both carrier versions. */
export function carrierFixes(search: Pick<CarrierSearch, "carrier" | "from" | "fromBundle" | "carried" | "own">, version: string, bundle: CompleteBundle, snapshot: Snapshot): boolean {
  const name = carrierName(search);
  if (!fixes(snapshot, name, search.from, search.own.map((id) => snapshot.group(id)), version)) return false;
  const before = bundlePairs(search.fromBundle, snapshot);
  const after = bundlePairs(bundle, snapshot);
  if (after.malicious) return false;
  if ([...after.pairs].some((pair) => !before.pairs.has(pair))) return false;
  return search.carried.every((target) => !after.pairs.has(`${target.name}|${snapshot.group(target.advisory)}`));
}

/** Each bundled package's advisory groups as `name|group`, and whether any is malware. */
export function bundlePairs(bundle: CompleteBundle, snapshot: Snapshot): { readonly pairs: ReadonlySet<string>; readonly malicious: boolean } {
  const pairs = new Set<string>();
  let malicious = false;
  for (const pkg of bundle.packages) {
    const version: PackageVersion = { ecosystem: "npm", name: pkg.name, version: pkg.version };
    for (const advisory of snapshot.advisories(version)) malicious ||= advisory.malicious;
    for (const group of groupsOf(snapshot, version)) pairs.add(`${pkg.name}|${group}`);
  }
  return { pairs, malicious };
}

/**
 * The carried targets a change from `fromBundle` to `toBundle` removes: each
 * bundled package + advisory group (malware aside) the old bundle has and the
 * new one doesn't.
 */
export function removedTargets(fromBundle: CompleteBundle, toBundle: CompleteBundle, snapshot: Snapshot): CarriedTarget[] {
  const after = bundlePairs(toBundle, snapshot).pairs;
  const removed = new Map<string, CarriedTarget>();
  for (const pkg of fromBundle.packages) {
    const version: PackageVersion = { ecosystem: "npm", name: pkg.name, version: pkg.version };
    for (const advisory of snapshot.advisories(version)) {
      if (advisory.malicious) continue;
      const pair = `${pkg.name}|${snapshot.group(advisory.id)}`;
      if (!after.has(pair)) removed.set(pair, { name: pkg.name, advisory: snapshot.group(advisory.id) });
    }
  }
  return [...removed.values()];
}

/** The integrity the registry publishes for `name@version`, to authenticate a candidate's archive. */
export async function registryIntegrity(registry: NpmRegistry, name: string, version: string): Promise<string | undefined> {
  const manifest = (await registry.packument(name)).versions[version];
  const dist = isObject(manifest) ? manifest["dist"] : undefined;
  const integrity = isObject(dist) ? dist["integrity"] : undefined;
  return typeof integrity === "string" ? integrity : undefined;
}

/** Carried targets for messages: `name GHSA-…`. */
export function describe(targets: ReadonlyArray<CarriedTarget>): string {
  return [...new Set(targets.map((target) => `${target.name} ${target.advisory}`))].join(", ");
}

function carrierName(search: Pick<CarrierSearch, "carrier">): PackageName {
  return { ecosystem: "npm", name: search.carrier };
}

async function ageOf(search: CarrierSearch, services: CarrierServices, version: string): Promise<number | undefined> {
  const published = await services.catalog.published({ ecosystem: "npm", name: search.carrier, version });
  return published === undefined ? undefined : (services.now.getTime() - published.getTime()) / DAY_MS;
}

function isAbove(version: string, from: string): boolean {
  return versionScheme("npm").compare(version, from) > 0;
}

function incomplete(reason: string): Extract<CarrierChoice, { kind: "incomplete" }> {
  return { kind: "incomplete", reason };
}
