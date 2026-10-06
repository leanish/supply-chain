/**
 * The versions secure-it moves vulnerable versions to, chosen by the rule the
 * gate checks a young fix against (young-fixes.ts), so picking and checking
 * can't disagree.
 *
 * For each version a full scan fails on, the targets are its failing advisory
 * groups (an excepted one stays); a target no listed version fixes is left
 * for later (fixing A and leaving B is allowed), reported as unfixable. Its candidates are every newer version the
 * registry lists, in any line (no prereleases unless it is one; Maven keeps
 * its flavor), scanned in one snapshot with the version itself, so targets and
 * fixes are read from the same data. The choice: the first compatible line,
 * from the version's own upward, with a version that fixes every target and
 * adds no advisory group; in it, the lowest such version at least
 * `releaseAgeDays` old, else the lowest (own packages skip the wait). A choice
 * outside the version's own line is a `major` move: the code may need
 * adapting. A malicious version moves to the nearest clean version at least
 * `releaseAgeDays` old: newer in its line first, then older in its line (a
 * downgrade), then newer lines.
 */
import { type Config, isOwnPackage } from "./config.ts";
import { unexcusedProblem } from "./exceptions.ts";
import { findingsOf, type Located } from "./findings.ts";
import type { Floor } from "./floors.ts";
import { type GateEnvironment, type GradleInputs, readScanState, type ScanState, snapshotOptions, versionCatalogs } from "./gate.ts";
import { gradleLocation } from "./gradle.ts";
import { directDependencies } from "./npm-lock.ts";
import { type PackageName, type PackageVersion, versionKey } from "./package-version.ts";
import type { Snapshot } from "./snapshot.ts";
import { takeSnapshot } from "./take-snapshot.ts";
import type { Tree } from "./tree.ts";
import { type Ecosystem, versionScheme } from "./versions.ts";
import { compatibleLine, fixes, movesFrom, ruleChoice, targetsOf, type VersionCatalog } from "./young-fixes.ts";

const DAY_MS = 86_400_000;

export interface SecurityMove {
  readonly version: string;
  /** The compatible line it's in. */
  readonly line: string;
  /**
   * At least `releaseAgeDays` old; false for the lowest fix when no fix in its line is that old yet, and for own
   * packages, which skip the wait (their age isn't checked).
   */
  readonly aged: boolean;
  /** Outside the current version's line: the code may need adapting. */
  readonly major: boolean;
}

export interface SecurityFix {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly from: string;
  /** Lockfile paths, Gradle configuration ids or workflow files where `from` is. */
  readonly locations: ReadonlyArray<string>;
  /** The failing advisory groups to fix (malware aside). */
  readonly targets: ReadonlyArray<string>;
  /** Targets no listed version fixes: `to` leaves them. */
  readonly unfixable: ReadonlyArray<string>;
  readonly malicious: boolean;
  readonly to: SecurityMove | undefined;
  /** Why there's no `to`. */
  readonly problem: string | undefined;
}

export interface SecurityCandidates {
  readonly fixes: ReadonlyArray<SecurityFix>;
  readonly gaps: ReadonlyArray<string>;
  readonly osvScannerVersion: string;
}

/** The fix the rule picks for every version a full scan of `head` fails on. */
export async function securityCandidates(head: Tree, env: GateEnvironment, gradle: GradleInputs = {}): Promise<SecurityCandidates> {
  const state = await readScanState(head, env, gradle);
  const { config, exceptions } = state.settings;
  const now = env.now();
  const today = now.toISOString().slice(0, 10);
  const failing = new Map<string, { pkg: Located; groups: Set<string>; malicious: boolean }>();
  for (const finding of findingsOf(state.packages, state.snapshot)) {
    if (unexcusedProblem(finding, exceptions, state.snapshot, today) === undefined) continue;
    const pkg: Located = { ecosystem: finding.ecosystem, name: finding.name, version: finding.version, locations: finding.locations };
    const entry = failing.get(versionKey(pkg)) ?? { pkg, groups: new Set<string>(), malicious: false };
    entry.groups.add(finding.advisory);
    entry.malicious ||= finding.malicious;
    failing.set(versionKey(pkg), entry);
  }

  const catalogs = versionCatalogs(config, env, state.github);
  const listings = new Map<string, ReadonlyArray<string> | undefined>();
  const candidates: PackageVersion[] = [];
  for (const { pkg, malicious } of failing.values()) {
    const listed = await catalogs[pkg.ecosystem].versions(pkg);
    const moves = listed === undefined ? undefined : movesFrom(pkg, pkg.version, listed, malicious ? "any" : "above");
    listings.set(versionKey(pkg), moves);
    candidates.push(...(moves ?? []).map((version) => ({ ...pkg, version })));
  }
  // One snapshot over the failing versions and every candidate: targets and fixes come from the same data.
  const snapshot = await takeSnapshot([...failing.values()].map(({ pkg }) => pkg), snapshotOptions(config, env, state.github), candidates);

  const found: SecurityFix[] = [];
  for (const { pkg, groups, malicious } of failing.values()) {
    const targets = targetsOf(snapshot, pkg, groups);
    const base = { ecosystem: pkg.ecosystem, name: pkg.name, from: pkg.version, locations: pkg.locations, targets, malicious };
    const moves = listings.get(versionKey(pkg));
    const problem = (why: string): SecurityFix => ({ ...base, unfixable: [], to: undefined, problem: why });
    if (moves === undefined) {
      found.push(problem(`the registry doesn't list ${pkg.name}'s versions completely, so the rule can't be applied`));
    } else if (!malicious && targets.length === 0) {
      found.push(problem(`no failing advisory affects ${pkg.name}@${pkg.version} in the second snapshot (withdrawn or reclassified since the scan)`));
    } else {
      found.push(await chooseMove(pkg, targets, malicious, moves, { snapshot, catalog: catalogs[pkg.ecosystem], config, now }, base));
    }
  }
  return { fixes: found, gaps: [...state.snapshot.gaps, ...snapshot.gaps], osvScannerVersion: state.osvScannerVersion };
}

interface ChoiceContext {
  readonly snapshot: Snapshot;
  readonly catalog: VersionCatalog;
  readonly config: Config;
  readonly now: Date;
}

async function chooseMove(
  pkg: PackageVersion,
  targets: ReadonlyArray<string>,
  malicious: boolean,
  moves: ReadonlyArray<string>,
  context: ChoiceContext,
  base: Omit<SecurityFix, "to" | "problem" | "unfixable">,
): Promise<SecurityFix> {
  const { snapshot, catalog, config, now } = context;
  const name: PackageName = { ecosystem: pkg.ecosystem, name: pkg.name };
  const line = (version: string) => compatibleLine(config, name, version);
  const fixable = targets.filter((target) => moves.some((version) => fixes(snapshot, name, pkg.version, [target], version)));
  const unfixable = targets.filter((target) => !fixable.includes(target));
  const move = (version: string, aged: boolean): SecurityFix => ({
    ...base,
    unfixable,
    to: { version, line: line(version), aged, major: line(version) !== line(pkg.version) },
    problem: undefined,
  });
  const none = (why: string): SecurityFix => ({ ...base, unfixable, to: undefined, problem: why });
  const fixing = moves.filter((version) => fixes(snapshot, name, pkg.version, fixable, version));
  if (malicious) {
    const scheme = versionScheme(pkg.ecosystem);
    const sameLine = (version: string) => line(version) === line(pkg.version);
    const newer = fixing.filter((version) => scheme.compare(version, pkg.version) > 0);
    const order = [
      ...newer.filter(sameLine),
      ...fixing.filter((version) => scheme.compare(version, pkg.version) < 0 && sameLine(version)).reverse(),
      ...newer.filter((version) => !sameLine(version)),
    ];
    for (const version of order) {
      const published = await catalog.published({ ...name, version });
      if (published !== undefined && (now.getTime() - published.getTime()) / DAY_MS >= config.releaseAgeDays) return move(version, true);
    }
    return none(`no clean version of ${pkg.name} at least ${config.releaseAgeDays} days old to leave the malicious ${pkg.version} for`);
  }
  if (fixable.length === 0) return none(`no version above ${pkg.version} fixes ${targets.join(", ")}`);
  if (fixing.length === 0) return none(`no single version above ${pkg.version} fixes all of ${fixable.join(", ")}, though each has a fix`);
  if (isOwnPackage(config.ownPackages, name)) {
    // Own packages skip the wait: the lowest fix in the first line that has one.
    const first = line(fixing[0]!);
    return move(fixing.find((version) => line(version) === first)!, false);
  }
  const choice = await ruleChoice(name, fixing, catalog, config, now);
  if (choice.kind === "undated") {
    return none(`the publish time of ${choice.versions.join(", ")} (fixing, line ${choice.line}) is unknown, so the rule can't tell which fix is old enough`);
  }
  return move(choice.version, choice.aged);
}

/** How many of a line's newest aged versions bump-it weighs: past them, it reports instead of digging further. */
export const BUMP_DEPTH = 10;

export interface BumpMove {
  readonly version: string;
  readonly line: string;
}

/** A dependency the repository declares directly, and where bump-it can move it. */
export interface BumpCandidate {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly from: string;
  /** npm: the lockfile path and workspace (`lockfile#workspace`); Gradle: configuration ids; Actions: workflow files. */
  readonly locations: ReadonlyArray<string>;
  /** The highest acceptable version in `from`'s own line (minors and patches go together in one PR). */
  readonly minor: BumpMove | undefined;
  /** The highest acceptable version of the highest newer line (each major is a PR of its own). */
  readonly major: BumpMove | undefined;
  /** Why a line with newer versions has no acceptable one. */
  readonly problems: ReadonlyArray<string>;
}

export interface BumpCandidates {
  readonly bumps: ReadonlyArray<BumpCandidate>;
  readonly gaps: ReadonlyArray<string>;
  readonly osvScannerVersion: string;
}

/**
 * Where bump-it can move each directly declared dependency: in its own line
 * and in the highest newer line, the highest version at least
 * `releaseAgeDays` old (own packages skip the wait) that adds no advisory
 * group and no malware, judged on one snapshot of the current versions and
 * every version weighed. Direct means: npm dependencies the root and the
 * workspaces of every checked lockfile declare; Gradle dependencies declared
 * with a version, recorded floors aside (bump-it doesn't raise floors); and
 * every `uses:` pinned to a release. Gradle transitives are never bumped.
 */
export async function bumpCandidates(head: Tree, env: GateEnvironment, gradle: GradleInputs = {}): Promise<BumpCandidates> {
  const state = await readScanState(head, env, gradle);
  const { config, floors } = state.settings;
  const now = env.now();
  const direct = await directOf(head, state, floors);
  const catalogs = versionCatalogs(config, env, state.github);

  const weighed = new Map<string, { own: Located; lines: Array<{ line: string; versions: string[]; problem?: string }> }>();
  const candidates: PackageVersion[] = [];
  const problemsOf = new Map<string, string[]>();
  for (const pkg of direct) {
    const listed = await catalogs[pkg.ecosystem].versions(pkg);
    if (listed === undefined) {
      problemsOf.set(versionKey(pkg), [`the registry doesn't list ${pkg.name}'s versions completely`]);
      continue;
    }
    const newer = movesFrom(pkg, pkg.version, listed);
    const line = (version: string) => compatibleLine(config, pkg, version);
    const own = line(pkg.version);
    const higher = newer.filter((version) => line(version) !== own);
    const lines = [own, ...(higher.length === 0 ? [] : [line(higher.at(-1)!)])];
    const picked: Array<{ line: string; versions: string[] }> = [];
    for (const target of lines) {
      const inLine = newer.filter((version) => line(version) === target).reverse();
      if (inLine.length === 0) continue;
      const aged = await newestAged(pkg, inLine, catalogs[pkg.ecosystem], config, now);
      picked.push({ line: target, versions: aged });
      candidates.push(...aged.map((version) => ({ ...pkg, version })));
    }
    weighed.set(versionKey(pkg), { own: pkg, lines: picked });
  }
  const snapshot = await takeSnapshot(direct, snapshotOptions(config, env, state.github), candidates);

  const bumps: BumpCandidate[] = [];
  for (const pkg of direct) {
    const entry = weighed.get(versionKey(pkg));
    const problems = [...(problemsOf.get(versionKey(pkg)) ?? [])];
    let minor: BumpMove | undefined;
    let major: BumpMove | undefined;
    const ownLine = compatibleLine(config, pkg, pkg.version);
    for (const { line, versions } of entry?.lines ?? []) {
      if (versions.length === 0) continue;
      const accepted = versions.find((version) => fixes(snapshot, pkg, pkg.version, [], version));
      if (accepted === undefined) {
        problems.push(`each of the ${versions.length} newest versions of line ${line} old enough adds an advisory or is malicious`);
        continue;
      }
      if (line === ownLine) minor = { version: accepted, line };
      else major = { version: accepted, line };
    }
    bumps.push({ ecosystem: pkg.ecosystem, name: pkg.name, from: pkg.version, locations: pkg.locations, minor, major, problems });
  }
  return { bumps, gaps: [...state.snapshot.gaps, ...snapshot.gaps], osvScannerVersion: state.osvScannerVersion };
}

/** Up to `BUMP_DEPTH` versions of `newestFirst` old enough (own packages: any age), newest first. */
async function newestAged(
  pkg: PackageVersion,
  newestFirst: ReadonlyArray<string>,
  catalog: VersionCatalog,
  config: Config,
  now: Date,
): Promise<string[]> {
  if (isOwnPackage(config.ownPackages, pkg)) return newestFirst.slice(0, BUMP_DEPTH);
  const aged: string[] = [];
  for (const version of newestFirst) {
    if (aged.length === BUMP_DEPTH) break;
    const published = await catalog.published({ ...pkg, version });
    if (published !== undefined && (now.getTime() - published.getTime()) / DAY_MS >= config.releaseAgeDays) aged.push(version);
  }
  return aged;
}

/** The directly declared dependencies of the scanned tree, one per version, with where each is declared, sorted. */
async function directOf(head: Tree, state: ScanState, floors: ReadonlyArray<Floor>): Promise<Located[]> {
  const byVersion = new Map<string, { pkg: PackageVersion; locations: Set<string> }>();
  const add = (pkg: PackageVersion, location: string) => {
    const entry = byVersion.get(versionKey(pkg)) ?? { pkg, locations: new Set<string>() };
    entry.locations.add(location);
    byVersion.set(versionKey(pkg), entry);
  };
  for (const lockfile of state.inventory.npm) {
    const text = await head.read(lockfile.path);
    if (text === undefined) throw new Error(`${lockfile.path} disappeared while reading it`);
    for (const dependency of directDependencies(JSON.parse(text))) {
      add({ ecosystem: "npm", name: dependency.name, version: dependency.version }, `${lockfile.path}#${dependency.workspace || "."}`);
    }
  }
  const floored = new Set(floors.filter((floor) => floor.ecosystem === "Maven").map((floor) => `${floor.package}@${floor.version}`));
  for (const build of state.inventory.gradle?.builds ?? []) {
    for (const configuration of build.configurations) {
      for (const declared of configuration.declared) {
        if (declared.version === undefined) continue;
        const name = `${declared.group}:${declared.name}`;
        if (floored.has(`${name}@${declared.version}`)) continue;
        add({ ecosystem: "Maven", name, version: declared.version }, gradleLocation(build.build, configuration.id));
      }
    }
  }
  for (const pkg of state.packages.filter((located) => located.ecosystem === "GitHub Actions")) {
    for (const location of pkg.locations) add(pkg, location);
  }
  return [...byVersion.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, { pkg, locations }]) => ({ ...pkg, locations: [...locations].sort() }));
}
