/**
 * What one secure-it run changes, decided without a model (design items
 * 21–22). From the gate's `candidates --rule security`:
 *
 *   - **what:** every malicious package together (a PR can't pass while any
 *     malware remains), else the most severe package (then by name) whose
 *     every failing version can move; a group with a version that can't (no
 *     fix, an identity break) is reported as blocked, never planned in part;
 *   - **how**, per version and location: npm — a direct dependency changes its
 *     range and lock (`npm-direct`); a transitive one whose parents' ranges all
 *     allow `to` is locked at exactly `to` (`npm-lock`); otherwise an override
 *     pins it, with a floor entry (`npm-override`). Gradle — a declared
 *     dependency changes its version (`gradle-declared`); a transitive one gets
 *     a floor, an explicit dependency with `because(...)`, and its entry
 *     (`gradle-floor`). Actions — the `uses:` is pinned to the tag's commit
 *     (`action-pin`).
 *
 * The agent applies the plan; the tool then verifies it landed (verify.ts).
 */
import { dirname } from "node:path";

import semver from "semver";

import { type SecurityFix, severityRank } from "../../ci/src/candidates.ts";
import { gradleLocation, type GradleInventory } from "../../ci/src/gradle.ts";
import type { Ecosystem } from "../../ci/src/versions.ts";

export type Mechanism = "npm-direct" | "npm-lock" | "npm-override" | "gradle-declared" | "gradle-floor" | "action-pin";

export interface PlannedMove {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly mechanism: Mechanism;
  /** Where `from` is: npm lockfile paths, Gradle configuration locations, workflow files. */
  readonly locations: ReadonlyArray<string>;
  /** The advisory groups the move fixes. */
  readonly advisories: ReadonlyArray<string>;
  /** Outside `from`'s compatible line: the agent may adapt code. */
  readonly major: boolean;
  /** `action-pin`: the commit the tag `to` points at. */
  readonly commitSha: string | undefined;
  /** npm: the key it's installed and declared under when that isn't its name (an `npm:` alias). */
  readonly declaredAs: string | undefined;
}

export interface ChangePlan {
  /** For the branch name: `malware`, or the package's name. */
  readonly topic: string;
  readonly malware: boolean;
  /** `ecosystem|name` of every package the plan moves. */
  readonly packages: ReadonlyArray<string>;
  readonly moves: ReadonlyArray<PlannedMove>;
  readonly severity: string | undefined;
}

/** What the plan reads about the tree: its npm lockfiles (path → parsed JSON) and its Gradle inventory. */
export interface PlanInputs {
  readonly lockfiles: ReadonlyMap<string, unknown>;
  readonly gradle: GradleInventory | undefined;
  /** The commit a tag of an action points at. */
  readonly tagCommit: (action: string, tag: string) => Promise<string | undefined>;
}

export const packageKey = (fix: Pick<SecurityFix, "ecosystem" | "name">) => `${fix.ecosystem}|${fix.name}`;

export interface Selection {
  /** The fixes this run takes on, a complete group; empty when none can go. */
  readonly work: ReadonlyArray<SecurityFix>;
  /** Groups that come first but can't go, each with why: for a human, or for a later run. */
  readonly blocked: ReadonlyArray<{ readonly packages: ReadonlyArray<string>; readonly reasons: ReadonlyArray<string> }>;
}

const isActionable = (fix: SecurityFix) => fix.to !== undefined && fix.to.blockers.length === 0;
const reasonOf = (fix: SecurityFix) => `${fix.name}@${fix.from}: ${fix.problem ?? fix.to?.blockers.join("; ") ?? "no move"}`;

/**
 * What this run takes on: the malicious packages, all of them or none (one left
 * behind fails the PR anyway); else the most severe package whose every failing
 * version can move, the more severe ones that can't reported as blocked.
 */
export function selectWork(fixes: ReadonlyArray<SecurityFix>): Selection {
  const malicious = fixes.filter((fix) => fix.malicious);
  if (malicious.length > 0) {
    const stuck = malicious.filter((fix) => !isActionable(fix));
    return stuck.length === 0
      ? { work: malicious, blocked: [] }
      : { work: [], blocked: [{ packages: [...new Set(malicious.map(packageKey))].sort(), reasons: stuck.map(reasonOf) }] };
  }
  const byPackage = new Map<string, SecurityFix[]>();
  for (const fix of fixes) byPackage.set(packageKey(fix), [...(byPackage.get(packageKey(fix)) ?? []), fix]);
  const ranked = [...byPackage.entries()].sort(([a, left], [b, right]) => {
    const severity = Math.max(...right.map((fix) => severityRank(fix.severity))) - Math.max(...left.map((fix) => severityRank(fix.severity)));
    return severity !== 0 ? severity : a < b ? -1 : a > b ? 1 : 0;
  });
  const blocked: Array<{ packages: string[]; reasons: string[] }> = [];
  for (const [key, group] of ranked) {
    const stuck = group.filter((fix) => !isActionable(fix));
    if (stuck.length === 0) return { work: group, blocked };
    blocked.push({ packages: [key], reasons: stuck.map(reasonOf) });
  }
  return { work: [], blocked };
}

/** The plan for `work` (from `selectWork`); fails on a fix without a move. */
export async function planFor(work: ReadonlyArray<SecurityFix>, inputs: PlanInputs): Promise<ChangePlan> {
  if (work.length === 0) throw new Error("planFor needs at least one fix");
  const moves: PlannedMove[] = [];
  for (const fix of work) {
    const to = fix.to;
    if (to === undefined) throw new Error(`${fix.name}@${fix.from} has no move: ${fix.problem ?? "unknown"}`);
    // Only what can be fixed is a target: an advisory no version fixes stays, inherited (fixing A and leaving B).
    const advisories = fix.targets.filter((target) => !fix.unfixable.includes(target));
    const base = { ecosystem: fix.ecosystem, name: fix.name, from: fix.from, to: to.version, advisories, major: to.major };
    if (fix.ecosystem === "GitHub Actions") {
      const commitSha = await inputs.tagCommit(fix.name, to.version);
      if (commitSha === undefined) throw new Error(`${fix.name} has no tag ${to.version} to pin to`);
      moves.push({ ...base, mechanism: "action-pin", locations: fix.locations, commitSha, declaredAs: undefined });
      continue;
    }
    const byMechanism = new Map<string, { mechanism: Mechanism; declaredAs: string | undefined; locations: string[] }>();
    for (const location of fix.locations) {
      const { mechanism, declaredAs } =
        fix.ecosystem === "npm" ? npmMechanism(inputs.lockfiles, fix.name, location, to.version) : { mechanism: gradleMechanism(inputs.gradle, fix.name, location), declaredAs: undefined };
      const key = `${mechanism}|${declaredAs ?? ""}`;
      const entry = byMechanism.get(key) ?? { mechanism, declaredAs, locations: [] };
      entry.locations.push(location);
      byMechanism.set(key, entry);
    }
    for (const [, { mechanism, declaredAs, locations }] of [...byMechanism.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      moves.push({ ...base, mechanism, locations, commitSha: undefined, declaredAs });
    }
  }
  const packages = [...new Set(work.map(packageKey))].sort();
  const malware = work.some((fix) => fix.malicious);
  const severity = work.map((fix) => fix.severity).reduce<string | undefined>((best, next) => (severityRank(next) > severityRank(best) ? next : best), undefined);
  return { topic: malware ? "malware" : work[0]!.name, malware, packages, moves, severity };
}

/** The lockfile a gate npm location (`<lockfile dir>/node_modules/…`) belongs to, and the lockfile key inside it. */
export function lockfileOf(lockfiles: ReadonlyMap<string, unknown>, location: string): { readonly lock: unknown; readonly key: string } {
  // The deepest lockfile directory that prefixes the location (a nested lockfile's own node_modules aren't the root's).
  const matching = [...lockfiles.keys()]
    .map((path) => ({ path, dir: dirname(path) }))
    .filter(({ dir }) => dir === "." || location.startsWith(`${dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  if (matching === undefined) throw new Error(`no checked lockfile holds ${location}`);
  return { lock: lockfiles.get(matching.path), key: matching.dir === "." ? location : location.slice(matching.dir.length + 1) };
}

interface LockEntry {
  readonly link?: boolean;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

function npmMechanism(lockfiles: ReadonlyMap<string, unknown>, name: string, location: string, to: string): { mechanism: Mechanism; declaredAs: string | undefined } {
  const { lock, key } = lockfileOf(lockfiles, location);
  const packages = ((lock ?? {}) as { packages?: Record<string, LockEntry> }).packages ?? {};
  // The key it's installed under: its name, or an `npm:` alias (`node_modules/compat` holding `lib`).
  const installedAs = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  const declaredAs = installedAs === name ? undefined : installedAs;
  // Who depends on this copy: each entry whose nearest `node_modules/<installedAs>` walking up from it is `key`.
  const ranges: string[] = [];
  let declaredByWorkspace = false;
  for (const [path, entry] of Object.entries(packages)) {
    if (entry.link === true) continue;
    const specs = { ...entry.peerDependencies, ...entry.optionalDependencies, ...entry.devDependencies, ...entry.dependencies };
    const spec = specs[installedAs];
    if (spec === undefined || nearestCopy(packages, path, installedAs) !== key) continue;
    if (!path.includes("node_modules/")) declaredByWorkspace = true;
    else ranges.push(spec);
  }
  if (declaredByWorkspace) return { mechanism: "npm-direct", declaredAs };
  return { mechanism: ranges.length > 0 && ranges.every((range) => satisfies(to, range)) ? "npm-lock" : "npm-override", declaredAs };
}

/** The lockfile key of the copy of `name` an entry at `from` resolves to, walking up its `node_modules`. */
function nearestCopy(packages: Record<string, unknown>, from: string, name: string): string | undefined {
  let dir = from;
  for (;;) {
    const candidate = dir === "" ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (packages[candidate] !== undefined) return candidate;
    if (dir === "") return undefined;
    const cut = dir.lastIndexOf("/node_modules/");
    dir = cut !== -1 ? dir.slice(0, cut) : dir.includes("/") && !dir.startsWith("node_modules/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
}

function satisfies(version: string, range: string): boolean {
  const alias = /^npm:(?:@[^/@]+\/)?[^@]+(?:@(.+))?$/.exec(range.trim());
  const effective = alias === null ? range : (alias[1] ?? "*");
  return semver.validRange(effective) !== null && semver.satisfies(version, effective, { includePrerelease: false });
}

function gradleMechanism(gradle: GradleInventory | undefined, name: string, location: string): Mechanism {
  if (gradle === undefined) throw new Error(`a Maven move for ${name} at ${location} without a Gradle inventory`);
  for (const build of gradle.builds) {
    for (const configuration of build.configurations) {
      if (gradleLocation(build.build, configuration.id) !== location) continue;
      return configuration.declared.some((declared) => `${declared.group}:${declared.name}` === name) ? "gradle-declared" : "gradle-floor";
    }
  }
  throw new Error(`the Gradle inventory has no configuration ${location}`);
}
