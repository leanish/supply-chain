/**
 * The version every npm copy should land on (design item 26), decided by
 * code, not by npm:
 *
 *   - a direct dependency's copy: its planned target, or the version its
 *     declaration had in the base;
 *   - every other copy: the highest version within all its dependents'
 *     ranges (or within the repository's plain override for it, which
 *     replaces them), at or above its base version, at least
 *     `releaseAgeDays` old (own packages any age), that adds no advisory
 *     group the package doesn't already have in the base (the gate's
 *     `compare` rule), isn't malware and doesn't break the publisher
 *     identity — every candidate weighed on one snapshot; its base version
 *     when nothing newer is eligible;
 *   - a copy whose candidates can't all be judged (the registry can't list
 *     them, a publish time is unknown, a dependent's spec isn't a range) is
 *     unresolved: it stays at its base version, and is reported, never claimed as the rule's choice; a new copy
 *     with no provable target fails the unit;
 *   - a package the repository's overrides name in a way this doesn't reason
 *     about is kept at base and reported as unresolved.
 */
import semver from "semver";

import type { PackageVersion } from "../../ci/src/package-version.ts";
import type { Snapshot } from "../../ci/src/snapshot.ts";
import { groupsOf } from "../../ci/src/young-fixes.ts";

import { type Copy, type NpmGraph, rangeOf } from "./npm-graph.ts";
import type { RepositoryOverrides } from "./npm-overrides.ts";

const DAY_MS = 86_400_000;

/** What deciding reads from outside: the registry, the advisory snapshot and the identity check. */
export interface TargetSources {
  /** Every version the registry lists; undefined when it can't list them. */
  versions(name: string): Promise<ReadonlyArray<string> | undefined>;
  /** When a version was published; undefined when the registry can't say. */
  published(name: string, version: string): Promise<Date | undefined>;
  /** One snapshot over `packages` and `candidates`. */
  snapshot(packages: ReadonlyArray<PackageVersion>, candidates: ReadonlyArray<PackageVersion>): Promise<Snapshot>;
  /** What `compare` would reject about `to` replacing `from` (publisher identity). */
  identity(name: string, from: string, to: string): Promise<ReadonlyArray<string>>;
  readonly isOwn: (name: string) => boolean;
  readonly releaseAgeDays: number;
  readonly now: Date;
}

export interface TargetInputs {
  readonly graph: NpmGraph;
  /** The lockfile's base graph (empty for a new lockfile). */
  readonly base: NpmGraph | undefined;
  /** Every version of each package anywhere in the base (all lockfiles): what `compare` counts as inherited. */
  readonly baseVersions: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly overrides: RepositoryOverrides;
  /** Copy path → the version a direct dependency's copy must be at. */
  readonly direct: ReadonlyMap<string, string>;
}

export type Decision =
  | { readonly copy: Copy; readonly kind: "target"; readonly target: string; readonly direct: boolean }
  | { readonly copy: Copy; readonly kind: "unresolved"; readonly target: string | undefined; readonly why: string };

/** The target of every copy that can move on its own (bundled ones ride with their parent). */
export async function decideTargets(inputs: TargetInputs, sources: TargetSources): Promise<Decision[]> {
  const { graph, overrides, direct } = inputs;
  const copies = graph.copies().filter((copy) => !copy.bundled);
  const pending: Array<{ copy: Copy; baseVersion: string | undefined; candidates: string[] }> = [];
  const decisions: Decision[] = [];
  for (const copy of copies) {
    const planned = direct.get(copy.path);
    if (planned !== undefined) {
      decisions.push({ copy, kind: "target", target: planned, direct: true });
      continue;
    }
    if ((overrides.isComplex(copy.installedAs) || overrides.isComplex(copy.name))) {
      decisions.push({ copy, kind: "unresolved", target: baseVersionOf(copy, inputs, () => true), why: `the repository's scoped overrides name ${copy.name}; keeping its base version instead of claiming a choice` });
      continue;
    }
    const found = await candidatesOf(copy, inputs, sources);
    if ("why" in found) decisions.push({ copy, kind: "unresolved", target: found.baseVersion, why: found.why });
    else pending.push({ copy, ...found });
  }
  if (pending.length === 0) return decisions;

  const names = [...new Set(pending.map(({ copy }) => copy.name))];
  const baseline = names.flatMap((name) => (inputs.baseVersions.get(name) ?? []).map((version) => ({ ecosystem: "npm" as const, name, version })));
  const weighed = pending.flatMap(({ copy, candidates }) => candidates.map((version) => ({ ecosystem: "npm" as const, name: copy.name, version })));
  let snapshot: Snapshot;
  try { snapshot = await sources.snapshot(baseline, weighed); }
  catch (err) {
    return [...decisions, ...pending.map(({ copy, baseVersion }) => ({ copy, kind: "unresolved" as const, target: baseVersion, why: `advisory lookup failed: ${(err as Error).message}` }))];
  }
  for (const { copy, baseVersion, candidates } of pending) {
    let target: string | undefined;
    try {
      if ([...(inputs.baseVersions.get(copy.name) ?? []), ...candidates].some((version) => !snapshot.covers({ ecosystem: "npm", name: copy.name, version }))) throw new Error("the snapshot does not cover every candidate and base version");
      const inherited = new Set((inputs.baseVersions.get(copy.name) ?? []).flatMap((version) => [...groupsOf(snapshot, { ecosystem: "npm", name: copy.name, version })]));
      for (const version of candidates) {
        if (await eligible(copy.name, version, baseVersion, inherited, snapshot, sources)) {
          target = version;
          break;
        }
      }
    } catch (err) {
      decisions.push({ copy, kind: "unresolved", target: baseVersion, why: `candidate lookup failed: ${(err as Error).message}` });
      continue;
    }
    target ??= baseVersion;
    if (target === undefined) decisions.push({ copy, kind: "unresolved", target: undefined, why: `no version of ${copy.name} within its ranges is eligible, and it's new here` });
    else if (semver.valid(rangeOf(overrides.rangeFor(copy.installedAs) ?? overrides.rangeFor(copy.name) ?? "*") ?? "") !== null) decisions.push({ copy, kind: "unresolved", target, why: "the repository override pins this copy" });
    else decisions.push({ copy, kind: "target", target, direct: false });
  }
  return decisions;
}

/** A copy's candidates, newest first and old enough; or why they can't all be judged. */
async function candidatesOf(
  copy: Copy,
  inputs: TargetInputs,
  sources: TargetSources,
): Promise<{ readonly baseVersion: string | undefined; readonly candidates: string[] } | { readonly baseVersion: string | undefined; readonly why: string }> {
  const overridden = inputs.overrides.rangeFor(copy.installedAs) ?? inputs.overrides.rangeFor(copy.name);
  const specs = overridden !== undefined ? [overridden] : inputs.graph.edgesTo(copy.path).map((edge) => edge.spec);
  const ranges = specs.map(rangeOf);
  const within = (version: string) => ranges.every((range) => range !== undefined && semver.satisfies(version, range));
  const baseVersion = baseVersionOf(copy, inputs, ranges.some((range) => range === undefined) ? () => true : within);
  if (ranges.some((range) => range === undefined)) return { baseVersion, why: `a dependent of ${copy.name} at ${copy.path} asks for '${specs.find((spec) => rangeOf(spec) === undefined)}', not a version range` };
  let listed: ReadonlyArray<string> | undefined;
  try {
    listed = await sources.versions(copy.name);
  } catch (err) {
    return { baseVersion, why: `the registry couldn't list ${copy.name}'s versions: ${(err as Error).message}` };
  }
  if (listed === undefined) return { baseVersion, why: `the registry doesn't list ${copy.name}'s versions completely` };
  const prerelease = semver.prerelease(copy.version) !== null;
  const inRange = listed
    .filter((version) => semver.valid(version) !== null && (prerelease || semver.prerelease(version) === null) && within(version))
    .filter((version) => baseVersion === undefined || semver.gte(version, baseVersion))
    .sort(semver.rcompare);
  const candidates: string[] = [];
  const own = sources.isOwn(copy.name);
  for (const version of inRange) {
    if (own) {
      candidates.push(version);
      continue;
    }
    let published: Date | undefined;
    try { published = await sources.published(copy.name, version); }
    catch (err) { return { baseVersion, why: `publish-time lookup failed: ${(err as Error).message}` }; }
    if (published === undefined) return { baseVersion, why: `the registry has no publish time for ${copy.name}@${version}, so its age can't be judged` };
    if ((sources.now.getTime() - published.getTime()) / DAY_MS >= sources.releaseAgeDays) candidates.push(version);
  }
  return { baseVersion, candidates };
}

/**
 * The version this copy had in the base: the base's copy at the same path
 * when it's the same package within its ranges now, else the highest base
 * version of the package in this lockfile within them; undefined when it's new.
 */
function baseVersionOf(copy: Copy, inputs: TargetInputs, within: (version: string) => boolean): string | undefined {
  const copies = inputs.base?.copies().filter((other) => other.name === copy.name) ?? [];
  const same = copies.find((other) => other.path === copy.path);
  if (same !== undefined && within(same.version)) return same.version;
  return copies
    .map((other) => other.version)
    .filter(within)
    .sort(semver.rcompare)[0];
}

async function eligible(name: string, version: string, baseVersion: string | undefined, inherited: ReadonlySet<string>, snapshot: Snapshot, sources: TargetSources): Promise<boolean> {
  const pkg = { ecosystem: "npm" as const, name, version };
  if (snapshot.advisories(pkg).some((advisory) => advisory.malicious)) return false;
  if ([...groupsOf(snapshot, pkg)].some((group) => !inherited.has(group))) return false;
  if (baseVersion === undefined || version === baseVersion) return true;
  return (await sources.identity(name, baseVersion, version)).length === 0;
}
