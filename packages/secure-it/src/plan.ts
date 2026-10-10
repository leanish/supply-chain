/**
 * Security plans decided without a model: one batch of non-major packages,
 * each package needing a major apart, all malware together, or an exact
 * security-floor removal proved without locks. Every package's
 * failing copies stay together; a blocked copy leaves that package out.
 *
 *   - **how**, per version and location: npm — a direct dependency changes its
 *     range and lock (`npm-direct`); a transitive one whose parents' ranges all
 *     allow `to` is locked at exactly `to` (`npm-lock`); otherwise an override
 *     pins it, with a floor entry (`npm-override`). Gradle — a declared
 *     dependency changes its version (`gradle-declared`); a transitive one gets
 *     a floor, an explicit dependency with `because(...)`, and its entry
 *     (`gradle-floor`). Actions — the `uses:` is pinned to the tag's commit
 *     (`action-pin`).
 *
 * The tool materializes exact npm moves and proved npm floor removals; the
 * agent applies Gradle/Actions edits and major adaptations. Every edit is verified.
 */
import { dirname } from "node:path";

import semver from "semver";

import { type SecurityFix, severityRank } from "../../ci/src/candidates.ts";
import type { CarriedPackage } from "../../ci/src/carrier-candidates.ts";
import type { NpmPeerPlanner } from "../../ci/src/npm-peers.ts";
import type { HeldVersion } from "../../ci/src/release-age.ts";
import { gradleLocation, type GradleInventory } from "../../ci/src/gradle.ts";
import type { Ecosystem } from "../../ci/src/versions.ts";

import type { FloorRemoval } from "./floor-removal.ts";

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
  /** npm: a parent move, with the gate locations of the copies it lets lock inside its range. */
  readonly unblocks?: ReadonlyArray<string>;
  /** A carrier move: the packages it replaces (bundled npm copies, or the Gradle module a parent brings), each with its advisories. */
  readonly carries?: ReadonlyArray<CarriedPackage>;
}

/** A dependent that moves so its range admits a copy's security target (`npm-parents.ts`). */
export interface ParentMove {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  /** `to`'s compatible line (its own: parents never cross one). */
  readonly line: string;
  /** Its own gate location. */
  readonly location: string;
  /** The copy's location it lets lock. */
  readonly unblocks: string;
}

/**
 * A fix as planned: the rule's choice, the parents that let npm lock it where an override would be needed, and notes
 * on why a parent couldn't (for the PR).
 */
export type FixWork = SecurityFix & { readonly parents?: ReadonlyArray<ParentMove>; readonly notes?: ReadonlyArray<string> };

export type PlanKind = "routine" | "major" | "malware" | "floor-removal";

export interface OmittedMoves {
  readonly moves: ReadonlyArray<PlannedMove>;
  readonly problems: ReadonlyArray<string>;
}

/** A version the plan takes before the release-age wait ends, as the gate's final comparison held it. */
export interface PlannedHold extends HeldVersion {
  /** For people only (`releaseSignals`): provenance, publisher, install scripts. */
  readonly signals: ReadonlyArray<string>;
}

export interface ChangePlan {
  /**
   * Set from the verifying comparison, never from planning: what the gate's
   * cooldown holds. Non-empty, the PR stays a draft with a warning until the
   * last one ages, then it's retired (`cooldown.ts` in the gate).
   */
  readonly cooldown?: ReadonlyArray<PlannedHold>;
  readonly requiredNpm?: ReadonlyArray<import("./npm-required-plan.ts").PlannedRequirement>;
  readonly notes?: ReadonlyArray<string>;
  readonly floorRemoval?: FloorRemoval;
  /** Absent in plans published before batching; those PRs retain per-package reviews. */
  readonly kind?: PlanKind;
  /** For the branch name: `security`, `<package>-major`, `malware`, or `floor-removal`. */
  readonly topic: string;
  readonly malware: boolean;
  /** `ecosystem|name` of every package the plan moves or removes a floor for. */
  readonly packages: ReadonlyArray<string>;
  readonly moves: ReadonlyArray<PlannedMove>;
  readonly severity: string | undefined;
  /** Explicit moves left out after a failed batch, visible in the report and PR. */
  readonly leftOut?: ReadonlyArray<OmittedMoves>;
  /** Connected npm packages must be omitted together if a verification retry drops one. */
  readonly coupled?: ReadonlyArray<ReadonlyArray<string>>;
}

/** What the plan reads about the tree: its npm lockfiles (path → parsed JSON) and its Gradle inventory. */
export interface PlanInputs {
  readonly lockfiles: ReadonlyMap<string, unknown>;
  readonly gradle: GradleInventory | undefined;
  /** Whether the base's Gradle sources name a coordinate (`gradleSourceIndex`); required with `gradle`. */
  readonly named: ((group: string, name: string) => boolean) | undefined;
  /** The commit a tag of an action points at. */
  readonly tagCommit: (action: string, tag: string) => Promise<string | undefined>;
}

export const packageKey = (fix: Pick<SecurityFix, "ecosystem" | "name">) => `${fix.ecosystem}|${fix.name}`;

export interface SecurityUnit {
  readonly kind: PlanKind;
  readonly topic: string;
  readonly work: ReadonlyArray<SecurityFix>;
  readonly coupled?: ReadonlyArray<ReadonlyArray<string>>;
  /** Predicted to take a version younger than the wait (the verifying comparison decides). */
  readonly held?: boolean;
}

/** The routine batch's topic for the fixes that can't wait: their own PR, so they don't hold the others back. */
export const HELD_TOPIC = "security-cooldown";

/**
 * Complete each unit's direct-peer set before an agent sees it (an
 * unsatisfiable set is reported), then split the routine batch: fixes whose
 * target is younger than the wait, with every package coupled to them, go to
 * a held unit of their own.
 */
export async function coupledWork(fixes: ReadonlyArray<SecurityFix>, peers?: NpmPeerPlanner): Promise<Selection> {
  const completed = await completedWork(fixes, peers);
  return { ...completed, units: completed.units.flatMap(splitByAge) };
}

/** Young fixes and their coupled closure apart from the rest; majors and malware stay whole, held if anything is young. */
export function splitByAge(unit: SecurityUnit): SecurityUnit[] {
  const young = new Set(unit.work.filter(isYoungTarget).map(packageKey));
  if (unit.kind !== "routine" || young.size === 0) return [{ ...unit, held: young.size > 0 }];
  for (;;) {
    const size = young.size;
    for (const set of unit.coupled ?? []) if (set.some((key) => young.has(key))) for (const key of set) young.add(key);
    if (young.size === size) break;
  }
  const part = (held: boolean): SecurityUnit | undefined => {
    const work = unit.work.filter((fix) => young.has(packageKey(fix)) === held);
    if (work.length === 0) return undefined;
    const coupled = unit.coupled?.filter((set) => set.some((key) => young.has(key)) === held);
    return { kind: "routine", topic: held ? HELD_TOPIC : unit.topic, work, held, ...(coupled === undefined ? {} : { coupled }) };
  };
  return [part(false), part(true)].filter((entry): entry is SecurityUnit => entry !== undefined);
}

/** A fix whose target the rule took though it's younger than the wait. */
export const isYoungTarget = (fix: SecurityFix) => fix.to !== undefined && !fix.to.aged;

async function completedWork(fixes: ReadonlyArray<SecurityFix>, peers?: NpmPeerPlanner): Promise<Selection> {
  const selected = selectWork(fixes);
  if (peers === undefined) return selected;
  const units: SecurityUnit[] = [];
  const blocked = [...selected.blocked];
  for (const unit of selected.units) {
    const result = await peers.resolve(unit.work.filter((fix) => fix.ecosystem === "npm").map((fix) => ({ ...fix, to: fix.to!.version })));
    const omitted = new Set(result.blocked.flatMap((group) => group.moves.map((move) => move.name)));
    // Copies of a package and their connected companions remain indivisible across lockfiles too, as do a copy and
    // the parents (or carriers) it's tied to.
    const tied = (unit.coupled ?? []).map((set) => set.filter((key) => key.startsWith("npm|")).map((key) => key.slice("npm|".length)));
    for (;;) {
      const size = omitted.size;
      for (const set of [...result.sets, ...tied]) {
        if (set.some((name) => omitted.has(name))) for (const name of set) omitted.add(name);
      }
      if (omitted.size === size) break;
    }
    if (result.blocked.length > 0) blocked.push({ packages: [...omitted].map((name) => `npm|${name}`).sort(), reasons: result.blocked.map((group) => group.reason) });
    if (unit.kind === "malware" && omitted.size > 0) continue;
    const work = unit.work.filter((fix) => fix.ecosystem !== "npm" || !omitted.has(fix.name));
    if (work.length === 0) continue;
    const companions: SecurityFix[] = result.additions.filter((move) => !omitted.has(move.name)).map((move) => ({
      ecosystem: "npm", name: move.name, from: move.from, locations: move.locations, targets: [], unfixable: [], malicious: false,
      severity: undefined, problem: undefined,
      to: { version: move.to, line: move.line, aged: move.aged, major: false, blockers: [] },
    }));
    const peerSets = result.sets.filter((set) => !set.some((name) => omitted.has(name))).map((set) => set.map((name) => `npm|${name}`));
    const kept = new Set(work.map(packageKey));
    const coupled = [...(unit.coupled ?? []).filter((set) => set.every((key) => kept.has(key))), ...peerSets];
    units.push({ ...unit, work: [...work, ...companions], coupled });
  }
  return { units, blocked };
}

export interface Selection {
  readonly units: ReadonlyArray<SecurityUnit>;
  readonly blocked: ReadonlyArray<{ readonly packages: ReadonlyArray<string>; readonly reasons: ReadonlyArray<string> }>;
}

const isActionable = (fix: SecurityFix) => fix.to !== undefined && fix.to.blockers.length === 0;
const reasonOf = (fix: SecurityFix) => `${fix.name}@${fix.from}: ${fix.problem ?? fix.to?.blockers.join("; ") ?? "no move"}`;

/** Malware first and indivisible; otherwise a routine batch and one unit per major package. */
export function selectWork(fixes: ReadonlyArray<SecurityFix>): Selection {
  const malicious = fixes.filter((fix) => fix.malicious);
  if (malicious.length > 0) {
    const stuck = malicious.filter((fix) => !isActionable(fix));
    return stuck.length === 0
      ? { units: [{ kind: "malware", topic: "malware", work: malicious }], blocked: [] }
      : { units: [], blocked: [{ packages: [...new Set(malicious.map(packageKey))].sort(), reasons: stuck.map(reasonOf) }] };
  }
  const groups = rankedGroups(fixes);
  const blocked: Array<{ packages: string[]; reasons: string[] }> = [];
  const actionable = new Map<string, SecurityFix[]>();
  for (const [key, group] of groups) {
    const stuck = group.filter((fix) => !isActionable(fix));
    if (stuck.length > 0) blocked.push({ packages: [key], reasons: stuck.map(reasonOf) });
    else actionable.set(key, group);
  }
  // Packages tied by a carried target land together or not at all: verification checks every copy of it.
  const carried = carriedSets(fixes).filter((set) => set.every((key) => actionable.has(key)));
  const routine: SecurityFix[] = [];
  const majors: SecurityUnit[] = [];
  const placed = new Set<string>();
  for (const [key, group] of actionable) {
    if (placed.has(key)) continue;
    const tied = connected(key, carried).filter((other) => actionable.has(other));
    for (const other of tied) placed.add(other);
    const work = tied.flatMap((other) => actionable.get(other)!);
    const coupled = carried.filter((set) => set.some((other) => tied.includes(other)));
    if (work.some((fix) => fix.to!.major)) majors.push({ kind: "major", topic: `${group[0]!.name}-major`, work, ...(coupled.length === 0 ? {} : { coupled }) });
    else routine.push(...work);
  }
  const routineCoupled = carried.filter((set) => set.every((key) => routine.some((fix) => packageKey(fix) === key)));
  const units: SecurityUnit[] = routine.length === 0 ? [] : [{ kind: "routine", topic: "security", work: routine, ...(routineCoupled.length === 0 ? {} : { coupled: routineCoupled }) }];
  return { units: [...units, ...majors], blocked };
}

/**
 * For each package a carrier move carries: the carriers that carry it and the package's own fix, when there's more
 * than one of them; and each npm copy with the parents that let it lock.
 */
function carriedSets(fixes: ReadonlyArray<FixWork>): string[][] {
  const byPackage = new Map<string, Set<string>>();
  for (const fix of fixes) {
    // A copy and the parents that let it lock land together.
    for (const parent of fix.parents ?? []) {
      const key = `npm|${parent.name}`;
      if (fixes.some((other) => packageKey(other) === key)) byPackage.set(`parent:${packageKey(fix)}:${key}`, new Set([packageKey(fix), key]));
    }
    for (const carried of fix.carries ?? []) {
      const key = `${fix.ecosystem}|${carried.name}`;
      const set = byPackage.get(key) ?? new Set<string>();
      set.add(packageKey(fix));
      if (fixes.some((other) => packageKey(other) === key)) set.add(key);
      byPackage.set(key, set);
    }
  }
  return [...byPackage.values()].filter((set) => set.size > 1).map((set) => [...set].sort());
}

/** Every key reachable from `key` through sets sharing a key, `key` first. */
function connected(key: string, sets: ReadonlyArray<ReadonlyArray<string>>): string[] {
  const found = [key];
  for (let at = 0; at < found.length; at++) {
    for (const set of sets) if (set.includes(found[at]!)) for (const other of set) if (!found.includes(other)) found.push(other);
  }
  return found;
}

function rankedGroups(fixes: ReadonlyArray<SecurityFix>): Array<[string, SecurityFix[]]> {
  const byPackage = new Map<string, SecurityFix[]>();
  for (const fix of fixes) byPackage.set(packageKey(fix), [...(byPackage.get(packageKey(fix)) ?? []), fix]);
  return [...byPackage.entries()].sort(([a, left], [b, right]) => {
    const severity = Math.max(...right.map((fix) => severityRank(fix.severity))) - Math.max(...left.map((fix) => severityRank(fix.severity)));
    return severity !== 0 ? severity : a < b ? -1 : a > b ? 1 : 0;
  });
}

/** The plan for `work` (from `selectWork`); fails on a fix without a move. */
export async function planFor(work: ReadonlyArray<FixWork>, inputs: PlanInputs, unit?: Pick<SecurityUnit, "kind" | "topic" | "coupled">): Promise<ChangePlan> {
  if (work.length === 0) throw new Error("planFor needs at least one fix");
  const moves: PlannedMove[] = [];
  for (const fix of work) {
    const to = fix.to;
    if (to === undefined) throw new Error(`${fix.name}@${fix.from} has no move: ${fix.problem ?? "unknown"}`);
    // Only what can be fixed is a target: an advisory no version fixes stays, inherited (fixing A and leaving B).
    // A carrier's own targets only: what it carries stays with each carried package (`carries`).
    const advisories = fix.targets.filter((target) => !fix.unfixable.includes(target));
    const base = { ecosystem: fix.ecosystem, name: fix.name, from: fix.from, to: to.version, advisories, major: to.major, ...(fix.carries === undefined ? {} : { carries: fix.carries }) };
    if (fix.ecosystem === "GitHub Actions") {
      const commitSha = await inputs.tagCommit(fix.name, to.version);
      if (commitSha === undefined) throw new Error(`${fix.name} has no tag ${to.version} to pin to`);
      moves.push({ ...base, mechanism: "action-pin", locations: fix.locations, commitSha, declaredAs: undefined });
      continue;
    }
    const byMechanism = new Map<string, { mechanism: Mechanism; declaredAs: string | undefined; locations: string[] }>();
    for (const location of fix.locations) {
      const found =
        fix.ecosystem === "npm" ? npmMechanism(inputs.lockfiles, fix.name, location, to.version) : { mechanism: gradleMechanism(inputs, fix.name, location), declaredAs: undefined };
      // Parents that admit the target turn an override into a lock inside their own ranges.
      // Parents that admit the target, moving in the same unit, turn an override into a lock inside their own ranges.
      const lifted = found.mechanism === "npm-override" && (fix.parents ?? []).some((parent) => parent.unblocks === location &&
        work.some((other) => other.ecosystem === "npm" && other.name === parent.name && other.to?.version === parent.to && other.locations.includes(parent.location)));
      const { mechanism, declaredAs } = lifted ? { ...found, mechanism: "npm-lock" as const } : found;
      const key = `${mechanism}|${declaredAs ?? ""}`;
      const entry = byMechanism.get(key) ?? { mechanism, declaredAs, locations: [] };
      entry.locations.push(location);
      byMechanism.set(key, entry);
    }
    const unblocks = work.flatMap((other) => (other.parents ?? []).filter((parent) => parent.name === fix.name && parent.to === to.version).map((parent) => parent.unblocks));
    for (const [, { mechanism, declaredAs, locations }] of [...byMechanism.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      moves.push({ ...base, mechanism, locations, commitSha: undefined, declaredAs, ...(unblocks.length === 0 ? {} : { unblocks: [...new Set(unblocks)].sort() }) });
    }
  }
  const coupled = [...(unit?.coupled ?? [])];
  const packages = [...new Set(work.map(packageKey))].sort();
  const malware = work.some((fix) => fix.malicious);
  const severity = work.map((fix) => fix.severity).reduce<string | undefined>((best, next) => (severityRank(next) > severityRank(best) ? next : best), undefined);
  const kind = unit?.kind ?? (malware ? "malware" : moves.some((move) => move.major) ? "major" : "routine");
  const topic = unit?.topic ?? (kind === "malware" ? "malware" : kind === "routine" ? "security" : `${work[0]!.name}-major`);
  const notes = [...new Set(work.flatMap((fix) => fix.notes ?? []))];
  return { kind, topic, malware, packages, moves, severity, ...(coupled.length === 0 ? {} : { coupled }), ...(notes.length === 0 ? {} : { notes }) };
}

/**
 * Carrier moves that would need an npm override (the carrier is transitive and a dependent's range excludes the
 * chosen version) aren't made: overriding a carrier would need floor records of what it carries. Such a fix gets a
 * blocker, so it's reported instead of planned.
 */
export function withUnsupportedCarriers<T extends SecurityFix>(fixes: ReadonlyArray<T>, lockfiles: ReadonlyMap<string, unknown>): T[] {
  return fixes.map((fix) => {
    if (fix.ecosystem !== "npm" || fix.carries === undefined || fix.to === undefined) return fix;
    const to = fix.to;
    const overridden = fix.locations.filter((location) => npmMechanism(lockfiles, fix.name, location, to.version).mechanism === "npm-override");
    if (overridden.length === 0) return fix;
    return { ...fix, to: { ...to, blockers: [...to.blockers, `${fix.name}@${to.version} would need an npm override at ${overridden.join(", ")}, which secure-it doesn't do for a carrier`] } };
  });
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
  const { installedAs, declaredByWorkspace, dependents } = dependentsOf(lockfiles, location);
  const declaredAs = installedAs === name ? undefined : installedAs;
  if (declaredByWorkspace) return { mechanism: "npm-direct", declaredAs };
  return { mechanism: dependents.length > 0 && dependents.every((dependent) => satisfies(to, dependent.spec)) ? "npm-lock" : "npm-override", declaredAs };
}

/** A locked package that depends on a copy, with the range it asks for it. */
export interface Dependent {
  readonly path: string;
  readonly spec: string;
  readonly name: string;
  readonly version: string | undefined;
  readonly bundled: boolean;
}

/**
 * Who depends on the copy at an npm gate location: each entry whose nearest `node_modules/<installedAs>` walking up
 * from it is that copy (`installedAs` is its name, or an `npm:` alias's key), and whether a workspace declares it.
 */
export function dependentsOf(lockfiles: ReadonlyMap<string, unknown>, location: string): { readonly installedAs: string; readonly declaredByWorkspace: boolean; readonly dependents: ReadonlyArray<Dependent> } {
  const { lock, key } = lockfileOf(lockfiles, location);
  const packages = ((lock ?? {}) as { packages?: Record<string, LockEntry & { name?: string; version?: string; inBundle?: boolean }> }).packages ?? {};
  const installedAs = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
  const dependents: Dependent[] = [];
  let declaredByWorkspace = false;
  for (const [path, entry] of Object.entries(packages)) {
    if (entry.link === true) continue;
    const specs = { ...entry.peerDependencies, ...entry.optionalDependencies, ...entry.devDependencies, ...entry.dependencies };
    const spec = specs[installedAs];
    if (spec === undefined || nearestCopy(packages, path, installedAs) !== key) continue;
    if (!path.includes("node_modules/")) declaredByWorkspace = true;
    else dependents.push({ path, spec, name: entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length), version: entry.version, bundled: entry.inBundle === true });
  }
  return { installedAs, declaredByWorkspace, dependents };
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

export function satisfies(version: string, range: string): boolean {
  const alias = /^npm:(?:@[^/@]+\/)?[^@]+(?:@(.+))?$/.exec(range.trim());
  const effective = alias === null ? range : (alias[1] ?? "*");
  return semver.validRange(effective) !== null && semver.satisfies(version, effective, { includePrerelease: false });
}

/**
 * A declaration the repository's own sources name is moved; anything else gets a floor (an explicit dependency with
 * `because(...)`), the transitive and the plugin-added alike: no file holds a plugin's declaration to edit.
 */
export function gradleMechanism(inputs: Pick<PlanInputs, "gradle" | "named">, name: string, location: string): Mechanism {
  const { gradle, named } = inputs;
  if (gradle === undefined || named === undefined) throw new Error(`a Maven move for ${name} at ${location} without a Gradle inventory and its source index`);
  const [group, artifact] = name.split(":") as [string, string];
  for (const build of gradle.builds) {
    for (const configuration of build.configurations) {
      if (gradleLocation(build.build, configuration.id) !== location) continue;
      return configuration.declared.some((declared) => `${declared.group}:${declared.name}` === name) && named(group, artifact) ? "gradle-declared" : "gradle-floor";
    }
  }
  throw new Error(`the Gradle inventory has no configuration ${location}`);
}
