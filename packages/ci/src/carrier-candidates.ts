/**
 * Security fixes for failing bundled npm copies: a bundled copy can't move on
 * its own, so its failing advisories become the targets of a move of its
 * carrier (the nearest locked ancestor that isn't bundled itself), chosen by
 * the carrier rule (`carrier-fixes.ts`). Every carrier version is one fix,
 * whatever lockfiles and paths hold it: it carries the targets of every
 * failing copy its bundle ships, plus its own advisories when it has failing
 * ones too, and its bundle is read from its locked archive and must match
 * what each lockfile records.
 */
import { type CarriedTarget, chooseCarrier, registryIntegrity } from "./carrier-fixes.ts";
import { type Config, isOwnPackage } from "./config.ts";
import type { Finding } from "./findings.ts";
import { type NpmLockfile, npmLocation } from "./inventory.ts";
import { type BundleReader, bundleMismatches } from "./npm-bundles.ts";
import type { LockedPackage } from "./npm-lock.ts";
import type { NpmRegistry } from "./npm-registry.ts";
import { type PackageVersion, versionKey } from "./package-version.ts";
import type { Snapshot } from "./snapshot.ts";
import { compatibleLine, movesFrom, type VersionCatalog } from "./young-fixes.ts";

/** A bundled package a carrier move replaces. */
export interface CarriedPackage {
  readonly name: string;
  /** Its failing versions in the current bundle. */
  readonly from: ReadonlyArray<string>;
  /** Where those copies are (gate locations). */
  readonly locations: ReadonlyArray<string>;
  /** The advisory groups the move removes from it. */
  readonly advisories: ReadonlyArray<string>;
  /** The versions of it the chosen carrier version ships; empty when it ships none. Empty before a choice. */
  readonly to: ReadonlyArray<string>;
}

/** One carrier version with failing bundled copies, gathered from unexcused findings. */
export interface CarrierGroup {
  readonly name: string;
  readonly version: string;
  /** Each lockfile copy of it: its lockfile and key. */
  readonly copies: Array<{ readonly lockfile: NpmLockfile; readonly copy: LockedPackage }>;
  readonly carried: Map<string, { versions: Set<string>; locations: Set<string>; advisories: Set<string> }>;
  malicious: boolean;
  readonly severities: Array<string | undefined>;
}

/** Each gate location of an npm copy, with its lockfile. */
export function npmCopies(lockfiles: ReadonlyArray<NpmLockfile>): Map<string, { readonly lockfile: NpmLockfile; readonly copy: LockedPackage }> {
  const copies = new Map<string, { lockfile: NpmLockfile; copy: LockedPackage }>();
  for (const lockfile of lockfiles) for (const copy of lockfile.packages) copies.set(npmLocation(lockfile.path, copy.path), { lockfile, copy });
  return copies;
}

/** The copy whose tarball ships a bundled one: its nearest ancestor that isn't bundled. */
export function carrierOf(lockfile: NpmLockfile, path: string): LockedPackage {
  let current = path;
  for (;;) {
    const cut = current.lastIndexOf("/node_modules/");
    const parent = cut === -1 ? undefined : lockfile.packages.find((pkg) => pkg.path === current.slice(0, cut));
    if (parent === undefined) throw new Error(`${lockfile.path}: no locked package ships the bundled ${path}`);
    if (!parent.bundled) return parent;
    current = parent.path;
  }
}

/**
 * Splits failing npm findings: locations of bundled copies go to their
 * carrier's group, the rest stay. `rest` maps each finding to the locations
 * left for an ordinary fix.
 */
export function splitBundled(findings: ReadonlyArray<Finding>, lockfiles: ReadonlyArray<NpmLockfile>): { readonly rest: ReadonlyArray<Finding>; readonly carriers: ReadonlyArray<CarrierGroup> } {
  const copies = npmCopies(lockfiles);
  const groups = new Map<string, CarrierGroup>();
  const rest: Finding[] = [];
  for (const finding of findings) {
    const bundled = finding.ecosystem === "npm" ? finding.locations.filter((location) => copies.get(location)?.copy.bundled === true) : [];
    const left = finding.locations.filter((location) => !bundled.includes(location));
    if (left.length > 0) rest.push({ ...finding, locations: left });
    for (const location of bundled) {
      const { lockfile, copy } = copies.get(location)!;
      const carrier = carrierOf(lockfile, copy.path);
      const key = versionKey({ ecosystem: "npm", name: carrier.name, version: carrier.version });
      const group: CarrierGroup = groups.get(key) ?? { name: carrier.name, version: carrier.version, copies: [], carried: new Map(), malicious: false, severities: [] };
      if (!group.copies.some((entry) => entry.lockfile.path === lockfile.path && entry.copy.path === carrier.path)) group.copies.push({ lockfile, copy: carrier });
      const entry = group.carried.get(copy.name) ?? { versions: new Set<string>(), locations: new Set<string>(), advisories: new Set<string>() };
      entry.versions.add(copy.version);
      entry.locations.add(location);
      entry.advisories.add(finding.advisory);
      group.carried.set(copy.name, entry);
      group.malicious ||= finding.malicious;
      group.severities.push(finding.severity);
      groups.set(key, group);
    }
  }
  return { rest, carriers: [...groups.values()] };
}

export interface CarrierContext {
  readonly reader: BundleReader;
  readonly registry: NpmRegistry;
  readonly catalog: VersionCatalog;
  readonly config: Config;
  readonly now: Date;
  readonly scan: (packages: ReadonlyArray<PackageVersion>) => Promise<Snapshot>;
  readonly identity: (pkg: PackageVersion, to: string) => Promise<string[]>;
}

export interface CarrierDecision {
  readonly from: string;
  readonly locations: ReadonlyArray<string>;
  readonly carries: ReadonlyArray<CarriedPackage>;
  readonly to: { readonly version: string; readonly line: string; readonly aged: boolean; readonly major: boolean; readonly blockers: ReadonlyArray<string> } | undefined;
  readonly problem: string | undefined;
}

/** The carrier move for `group`, fixing `own` (its own failing advisory groups) too. */
export async function decideCarrier(group: CarrierGroup, own: ReadonlyArray<string>, malicious: boolean, context: CarrierContext): Promise<CarrierDecision> {
  const pkg: PackageVersion = { ecosystem: "npm", name: group.name, version: group.version };
  const locations = group.copies.map(({ lockfile, copy }) => npmLocation(lockfile.path, copy.path)).sort();
  const carriedTargets: CarriedTarget[] = [...group.carried.entries()].flatMap(([name, entry]) => [...entry.advisories].map((advisory) => ({ name, advisory })));
  const carries = (to: (name: string) => ReadonlyArray<string>): CarriedPackage[] => [...group.carried.entries()]
    .map(([name, entry]) => ({ name, from: [...entry.versions].sort(), locations: [...entry.locations].sort(), advisories: [...entry.advisories].sort(), to: to(name) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const none = (problem: string): CarrierDecision => ({ from: group.version, locations, carries: carries(() => []), to: undefined, problem });

  const integrities = new Set(group.copies.map(({ copy }) => copy.integrity));
  if (integrities.size !== 1) return none(`the copies of ${group.name}@${group.version} lock different archives`);
  const fromBundle = await context.reader.read(group.name, group.version, [...integrities][0]);
  if (!fromBundle.complete) return none(`${group.name}@${group.version}'s bundle can't be read: ${fromBundle.reason}`);
  const recorded = group.copies.flatMap(({ lockfile, copy }) => bundleMismatches(lockfile.packages, copy.path, fromBundle).map((problem) => `${lockfile.path}: ${problem}`));
  if (recorded.length > 0) return none(recorded.join("; "));
  const listed = await context.catalog.versions(pkg);
  if (listed === undefined) return none(`the registry doesn't list ${group.name}'s versions completely, so the rule can't be applied`);
  const choice = await chooseCarrier({
    carrier: group.name,
    from: group.version,
    fromBundle,
    carried: carriedTargets,
    own,
    malicious,
    versions: movesFrom(pkg, group.version, listed, malicious ? "any" : "above"),
    ownPackage: isOwnPackage(context.config.ownPackages, pkg),
  }, {
    bundles: async (version) => context.reader.read(group.name, version, await registryIntegrity(context.registry, group.name, version)),
    scan: context.scan,
    catalog: context.catalog,
    config: context.config,
    now: context.now,
  });
  if (choice.kind !== "chosen") return none(choice.reason);
  const line = (version: string) => compatibleLine(context.config, pkg, version);
  return {
    from: group.version,
    locations,
    carries: carries((name) => [...new Set(choice.bundle.packages.filter((entry) => entry.name === name).map((entry) => entry.version))].sort()),
    to: { version: choice.version, line: choice.line, aged: choice.aged, major: line(choice.version) !== line(group.version), blockers: await context.identity(pkg, choice.version) },
    problem: undefined,
  };
}
