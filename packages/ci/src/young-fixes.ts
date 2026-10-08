/**
 * The proof that a version younger than the wait may be taken anyway: it's
 * the security fix the version rule would pick.
 *
 * For a young version V replacing R, the targets are the advisory groups
 * that affect R and not V (malware aside; an upgrade that fixes A and leaves
 * B fixes A). Candidates are the registry's versions above R, up to the end
 * of V's line (prereleases only if R is one; Maven keeps R's flavor, `-jre`).
 * A candidate fixes when no target affects it and it adds no advisory R
 * doesn't have, malware included. The rule:
 *   1. the first line, from R's own compatible line upward, with a fixing
 *      candidate (so a backport beats a newer major);
 *   2. in it, the lowest fixing candidate at least `releaseAgeDays` old;
 *   3. else the lowest fixing candidate, however young.
 * V passes only if it's that version. If an older fix in the line turns 7
 * days old before CI runs, the proof fails on purpose: that one is safer.
 *
 * All of it is read from the comparison's snapshot, which includes every
 * candidate, so the proof and the comparison see the same advisories.
 */
import type { Config } from "./config.ts";
import { type PackageName, type PackageVersion, versionKey } from "./package-version.ts";
import type { Snapshot } from "./snapshot.ts";
import { type Ecosystem, versionScheme } from "./versions.ts";

const DAY_MS = 86_400_000;

/** Where a package's versions and their publish times come from. */
export interface VersionCatalog {
  /** Every version the registry has, in any order; undefined when it can't list them. */
  versions(pkg: PackageName): Promise<ReadonlyArray<string> | undefined>;
  /** When `pkg` was published; undefined when the registry can't say. */
  published(pkg: PackageVersion): Promise<Date | undefined>;
}

export interface YoungVersion {
  readonly pkg: PackageVersion;
  /** Versions of the package the change replaces. */
  readonly replaced: ReadonlyArray<string>;
}

/** The compatible line of `version`: config's override (leading numeric segments), else the ecosystem's rule. */
export function compatibleLine(config: Config, pkg: PackageName, version: string): string {
  const segments = lineOverride(config, pkg);
  if (segments === undefined) return versionScheme(pkg.ecosystem).line(version);
  const numbers = version.split(/[.\-+]/).filter((part) => /^\d+$/.test(part));
  return numbers.slice(0, segments).join(".");
}

function lineOverride(config: Config, pkg: PackageName): number | undefined {
  const key = `${pkg.ecosystem}:${pkg.name}`;
  for (const [pattern, segments] of config.compatibleLines) {
    if (pattern === key || (pattern.endsWith("*") && key.startsWith(pattern.slice(0, -1)))) return segments;
  }
  return undefined;
}

/** The versions the proof weighs for replacing `from` with `to`, in ascending order. */
export function candidateVersions(config: Config, pkg: PackageName, from: string, to: string, all: ReadonlyArray<string>): string[] {
  const scheme = versionScheme(pkg.ecosystem);
  const parses = (version: string) => {
    try {
      scheme.compare(version, from);
      return true;
    } catch {
      return false;
    }
  };
  const line = (version: string) => compatibleLine(config, pkg, version);
  return [...new Set(all)]
    .filter(parses)
    .filter((version) => scheme.compare(version, from) > 0)
    .filter((version) => scheme.isPrerelease(from) || !scheme.isPrerelease(version))
    .filter((version) => scheme.flavor(version) === scheme.flavor(from))
    .filter((version) => scheme.compare(version, to) <= 0 || line(version) === line(to) || line(version) === line(from))
    .sort(scheme.compare);
}

export interface Candidates {
  /** Every candidate version, to scan with the rest. */
  readonly versions: ReadonlyArray<PackageVersion>;
  /** `versionKey` of a young version → replaced version → its candidates, ascending. */
  readonly byChange: ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<string>>>;
}

/** The candidates of every young version that replaces something. */
export async function gatherCandidates(
  young: ReadonlyArray<YoungVersion>,
  catalogs: Readonly<Record<Ecosystem, VersionCatalog>>,
  config: Config,
): Promise<Candidates> {
  const versions: PackageVersion[] = [];
  const byChange = new Map<string, Map<string, ReadonlyArray<string>>>();
  for (const change of young) {
    if (change.replaced.length === 0) continue;
    const listed = await catalogs[change.pkg.ecosystem].versions(change.pkg);
    // No listing, no proof: the young version alone would look like the only fix.
    if (listed === undefined) continue;
    // The young version itself, even if the registry's listing lags behind.
    const all = [...listed, change.pkg.version];
    const perReplaced = new Map<string, ReadonlyArray<string>>();
    for (const from of change.replaced) {
      const found = candidateVersions(config, change.pkg, from, change.pkg.version, all);
      perReplaced.set(from, found);
      versions.push(...found.map((version) => ({ ...change.pkg, version })));
    }
    byChange.set(versionKey(change.pkg), perReplaced);
  }
  return { versions, byChange };
}

/**
 * Why `young` isn't the fix the rule picks (for each version it replaces), or
 * undefined when it is. `candidates` maps each replaced version to its
 * candidate versions, all in the snapshot.
 */
export async function youngFixProblem(
  young: YoungVersion,
  candidates: ReadonlyMap<string, ReadonlyArray<string>>,
  snapshot: Snapshot,
  catalog: VersionCatalog,
  config: Config,
  now: Date,
): Promise<string | undefined> {
  const { pkg } = young;
  const groups = (version: string) =>
    new Set(snapshot.advisories({ ecosystem: pkg.ecosystem, name: pkg.name, version }).map((advisory) => snapshot.group(advisory.id)));
  const malicious = (version: string) => snapshot.advisories({ ecosystem: pkg.ecosystem, name: pkg.name, version }).some((advisory) => advisory.malicious);
  if (young.replaced.length === 0) return "it's new here, not a fix of an earlier version";
  if (candidates.size === 0) return `the registry doesn't list ${pkg.name}'s versions, so the rule can't be checked`;
  const reasons: string[] = [];
  for (const from of young.replaced) {
    const before = groups(from);
    const after = groups(pkg.version);
    const maliciousGroups = new Set(
      snapshot.advisories({ ecosystem: pkg.ecosystem, name: pkg.name, version: from }).filter((a) => a.malicious).map((a) => snapshot.group(a.id)),
    );
    const targets = [...before].filter((group) => !after.has(group) && !maliciousGroups.has(group));
    if (targets.length === 0) {
      reasons.push(`it fixes no advisory affecting ${from}`);
      continue;
    }
    const fixes = (version: string) => {
      const found = groups(version);
      return !malicious(version) && targets.every((group) => !found.has(group)) && [...found].every((group) => before.has(group));
    };
    const fixing = (candidates.get(from) ?? []).filter(fixes);
    if (fixing.length === 0) {
      reasons.push(`no candidate above ${from} fixes ${targets.join(", ")}`);
      continue;
    }
    const firstLine = compatibleLine(config, pkg, fixing[0]!);
    const inLine = fixing.filter((version) => compatibleLine(config, pkg, version) === firstLine);
    const ages = await agesOf(inLine, pkg, catalog, now);
    const undated = inLine.filter((version, i) => ages[i] === undefined && version !== pkg.version);
    if (undated.length > 0) {
      reasons.push(`the publish time of ${undated.join(", ")} (fixing too, line ${firstLine}) is unknown, so an older fix can't be ruled out`);
      continue;
    }
    const chosen = inLine.find((_, i) => ages[i]! >= config.releaseAgeDays);
    const expected = chosen ?? inLine[0]!;
    if (expected === pkg.version) return undefined;
    reasons.push(
      chosen === undefined
        ? `the lowest version fixing ${targets.join(", ")} above ${from} is ${expected} (line ${firstLine})`
        : `${expected} fixes ${targets.join(", ")} too and is at least ${config.releaseAgeDays} days old (line ${firstLine})`,
    );
  }
  return reasons.join("; ");
}

/** Each version's age in days, undefined where the registry can't say. */
async function agesOf(versions: ReadonlyArray<string>, pkg: PackageName, catalog: VersionCatalog, now: Date): Promise<Array<number | undefined>> {
  const ages: Array<number | undefined> = [];
  for (const version of versions) {
    const published = await catalog.published({ ...pkg, version });
    ages.push(published === undefined ? undefined : (now.getTime() - published.getTime()) / DAY_MS);
  }
  return ages;
}
