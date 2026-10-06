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
import { type GateEnvironment, type GradleInputs, readScanState, snapshotOptions, versionCatalogs } from "./gate.ts";
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
