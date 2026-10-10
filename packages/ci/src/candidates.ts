/**
 * Where secure-it and bump-it move versions, chosen with the gate's own code.
 *
 * Security (`securityCandidates`): the rule the gate checks a young fix
 * against (young-fixes.ts), so picking and checking can't disagree. For each
 * version a full scan fails on, its candidates are every newer version the
 * registry lists, in any line (no prereleases unless it is one; Maven keeps
 * its flavor), scanned in a second snapshot together with the version itself;
 * its targets are its unexcepted advisory groups as that snapshot groups them,
 * so targets and fixes come from the same data. A target no listed version
 * fixes is reported as unfixable and left (fixing A and leaving B is allowed).
 * The choice: the first compatible line, from the version's own upward, with a
 * version that fixes every fixable target and adds no advisory group; in it,
 * the lowest such version at least `releaseAgeDays` old, else the lowest (own
 * packages skip the wait). A choice outside the version's own line is a
 * `major` move: the code may need adapting. A malicious version moves to the
 * nearest clean version at least `releaseAgeDays` old (own packages: any
 * age): newer in its line first, then older in its line (a downgrade), then
 * newer lines. An npm choice whose publisher identity `compare` would reject
 * keeps that as a blocker: a reviewed `identity` exception is the way through.
 *
 * Bumps (`bumpCandidates`): see there.
 */
import { actionGaps } from "./actions-changes.ts";
import { type CarriedPackage, type CarrierContext, type CarrierGroup, decideCarrier, splitBundled } from "./carrier-candidates.ts";
import { type Config, isOwnPackage } from "./config.ts";
import { type Exceptions, unexcusedProblem } from "./exceptions.ts";
import { findingsOf, type Located } from "./findings.ts";
import type { Floor } from "./floors.ts";
import {
  bundleReader,
  type GateEnvironment,
  type GradleInputs,
  inventoryProblems,
  readScanState,
  type ScanState,
  snapshotOptions,
  versionCatalogs,
} from "./gate.ts";
import { gradleLocation } from "./gradle.ts";
import { gradleSourceIndex } from "./gradle-sources.ts";
import type { NpmLockfile } from "./inventory.ts";
import { directDependencies, type LockedPackage, NPM_REGISTRY } from "./npm-lock.ts";
import { NpmRegistry } from "./npm-registry.ts";
import { nodeRuntime, nodeTypeProblem, nodeTypeVersions } from "./node-runtime.ts";
import { requiredPeerTargets } from "./npm-required-peers.ts";
import { type PeerMove, type NpmPeerPlanner, prepareNpmPeers } from "./npm-peers.ts";
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
  /** What `compare` would still reject about the move (npm publisher identity), each needing a reviewed exception. */
  readonly blockers: ReadonlyArray<string>;
}

export interface SecurityFix {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly from: string;
  /** Lockfile paths, Gradle configuration ids or workflow files where `from` is. */
  readonly locations: ReadonlyArray<string>;
  /** The failing advisory groups to fix (malware aside), as the second snapshot groups them. */
  readonly targets: ReadonlyArray<string>;
  /** Targets no listed version fixes: `to` leaves them. */
  readonly unfixable: ReadonlyArray<string>;
  readonly malicious: boolean;
  /** The highest severity among its failing advisories, as they state it (`CRITICAL`, `HIGH`, …); undefined when none does. */
  readonly severity: string | undefined;
  readonly to: SecurityMove | undefined;
  /** Why there's no `to`. */
  readonly problem: string | undefined;
  /** A carrier move: the bundled packages it replaces, and their advisories (`carrier-candidates.ts`). */
  readonly carries?: ReadonlyArray<CarriedPackage>;
}

export interface SecurityCandidates {
  readonly fixes: ReadonlyArray<SecurityFix>;
  /** Direct-peer closure on the same snapshot as these security targets. */
  readonly npmPeers?: NpmPeerPlanner;
  /**
   * The closure again with more npm versions to move (parents a fix's range needs), on a snapshot that covers them
   * and their direct peers' candidates too.
   */
  readonly peersWith?: (extra: ReadonlyArray<PackageVersion>) => Promise<NpmPeerPlanner>;
  /** What makes the inventory incomplete (a configuration that didn't resolve, an unrecorded bundle): the list can't be trusted to be whole. */
  readonly incomplete: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
  readonly osvScannerVersion: string;
}

/** The fix the rule picks for every version a full scan of `head` fails on. */
export async function securityCandidates(head: Tree, env: GateEnvironment, gradle: GradleInputs = {}): Promise<SecurityCandidates> {
  const state = await readScanState(head, env, gradle);
  const { config, exceptions } = state.settings;
  const now = env.now();
  const today = now.toISOString().slice(0, 10);
  const failing = new Map<string, { pkg: Located; malicious: boolean; advisories: string[]; severities: Array<string | undefined> }>();
  // Bundled copies can only move with their carrier: their findings become the carrier's targets.
  const { rest, carriers } = splitBundled(unexcused(state.packages, state.snapshot, exceptions, today), state.inventory.npm);
  for (const finding of rest) {
    const pkg: Located = { ecosystem: finding.ecosystem, name: finding.name, version: finding.version, locations: finding.locations };
    const entry = failing.get(versionKey(pkg)) ?? { pkg, malicious: false, advisories: [], severities: [] };
    entry.malicious ||= finding.malicious;
    entry.advisories.push(finding.advisory);
    entry.severities.push(finding.severity);
    failing.set(versionKey(pkg), entry);
  }
  // A carrier failing on its own too is one move with both kinds of targets.
  const carrierOwn = new Map<string, { pkg: Located; malicious: boolean; advisories: string[]; severities: Array<string | undefined> }>();
  for (const group of carriers) {
    const key = versionKey({ ecosystem: "npm", name: group.name, version: group.version });
    const own = failing.get(key);
    if (own === undefined) continue;
    carrierOwn.set(key, own);
    failing.delete(key);
  }

  const registry = new NpmRegistry(env.fetch);
  const catalogs = versionCatalogs(config, env, state.github, registry);
  const identity = new IdentityCheck(registry, state.inventory.npm, exceptions, today);
  // Carriers are decided first, on snapshots of their own: their choices then join the peer closure and its snapshot.
  const carrierContext: CarrierContext = {
    reader: bundleReader(env), registry, catalog: catalogs.npm, config, now,
    scan: (packages) => takeSnapshot(packages, snapshotOptions(config, env, state.github)),
    identity: (pkg, to) => identity.problems(pkg, to),
  };
  const carried: SecurityFix[] = [];
  for (const group of carriers) carried.push(await carrierFix(group, carrierOwn.get(versionKey({ ecosystem: "npm", name: group.name, version: group.version })), carrierContext));
  const listings = new Map<string, ReadonlyArray<string> | undefined>();
  const candidates: PackageVersion[] = carried.flatMap((fix) => (fix.to === undefined ? [] : [{ ecosystem: "npm" as const, name: fix.name, version: fix.to.version }]));
  for (const { pkg, malicious } of failing.values()) {
    const listed = await catalogs[pkg.ecosystem].versions(pkg);
    const moves = listed === undefined ? undefined : movesFrom(pkg, pkg.version, listed, malicious ? "any" : "above");
    listings.set(versionKey(pkg), moves);
    candidates.push(...(moves ?? []).map((version) => ({ ...pkg, version })));
  }
  const peers = await preparePeers(head, state, registry, catalogs.npm, candidates, identity, now, true);
  // Direct-peer candidates join the security candidates: one snapshot decides the entire batch.
  const bases: Located[] = [...[...failing.values()].map(({ pkg }) => pkg), ...carried.map((fix): Located => ({ ecosystem: "npm", name: fix.name, version: fix.from, locations: fix.locations }))];
  const snapshot = await takeSnapshot([...bases, ...peers.bases], snapshotOptions(config, env, state.github), [...candidates, ...peers.candidates]);

  const found: SecurityFix[] = [];
  for (const { pkg } of failing.values()) {
    // Regrouped on the second snapshot: a candidate can link aliases into another canonical id.
    const current = unexcused([pkg], snapshot, exceptions, today);
    const malicious = current.some((finding) => finding.malicious);
    const targets = targetsOf(snapshot, pkg, new Set(current.map((finding) => finding.advisory)));
    const severity = highestSeverity(current.map((finding) => finding.severity));
    const base = { ecosystem: pkg.ecosystem, name: pkg.name, from: pkg.version, locations: pkg.locations, targets, malicious, severity };
    const moves = listings.get(versionKey(pkg));
    const problem = (why: string): SecurityFix => ({ ...base, unfixable: [], to: undefined, problem: why });
    if (moves === undefined) {
      found.push(problem(`the registry doesn't list ${pkg.name}'s versions completely, so the rule can't be applied`));
    } else if (!malicious && targets.length === 0) {
      found.push(problem(`no failing advisory affects ${pkg.name}@${pkg.version} in the second snapshot (withdrawn or reclassified since the scan)`));
    } else {
      found.push(await chooseMove(pkg, targets, malicious, moves, { snapshot, catalog: catalogs[pkg.ecosystem], config, now, identity }, base));
    }
  }
  found.push(...carried);
  return {
    fixes: found,
    npmPeers: { resolve: (moves) => peers.resolve(moves, snapshot) },
    peersWith: async (extra) => {
      const more = await preparePeers(head, state, registry, catalogs.npm, [...candidates, ...extra], identity, now, true);
      const wider = await takeSnapshot([...bases, ...more.bases], snapshotOptions(config, env, state.github), [...candidates, ...extra, ...more.candidates]);
      return { resolve: (moves) => more.resolve(moves, wider) };
    },
    incomplete: inventoryProblems(state.inventory, config),
    gaps: [...state.snapshot.gaps, ...snapshot.gaps, ...actionGaps(state.inventory.actions, state.resolutions)],
    osvScannerVersion: state.osvScannerVersion,
  };
}

/** A carrier version's fix; a decision that can't be made (an archive, a scan) is the fix's problem, not the run's. */
async function carrierFix(group: CarrierGroup, own: { pkg: Located; malicious: boolean; advisories: string[]; severities: Array<string | undefined> } | undefined, context: CarrierContext): Promise<SecurityFix> {
  const malicious = group.malicious || own?.malicious === true;
  const decision = await decideCarrier(group, own?.advisories ?? [], malicious, context).catch((error: unknown) => ({
    from: group.version, locations: [], carries: [], unfixable: [], to: undefined,
    problem: `${group.name}@${group.version}'s carrier move can't be decided: ${error instanceof Error ? error.message : String(error)}`,
  }));
  return {
    ecosystem: "npm",
    name: group.name,
    from: group.version,
    locations: [...new Set([...decision.locations, ...(own?.pkg.locations ?? [])])].sort(),
    targets: [...new Set(own?.advisories ?? [])],
    unfixable: decision.unfixable,
    malicious,
    severity: highestSeverity([...group.severities, ...(own?.severities ?? [])]),
    to: decision.to,
    problem: decision.problem,
    carries: decision.carries,
  };
}

const SEVERITY_RANK: Readonly<Record<string, number>> = { CRITICAL: 4, HIGH: 3, MODERATE: 2, MEDIUM: 2, LOW: 1 };

/** How severe a severity is, for ordering: CRITICAL 4, HIGH 3, MODERATE or MEDIUM 2, LOW 1, anything else 0. */
export function severityRank(severity: string | undefined): number {
  return severity === undefined ? 0 : (SEVERITY_RANK[severity.toUpperCase()] ?? 0);
}

function highestSeverity(severities: ReadonlyArray<string | undefined>): string | undefined {
  return severities.reduce<string | undefined>((best, next) => (severityRank(next) > severityRank(best) ? next : best), undefined);
}

/** Findings on `packages` that fail: no valid exception covers them (malware never has one). */
function unexcused(packages: ReadonlyArray<Located>, snapshot: Snapshot, exceptions: Exceptions, today: string) {
  return findingsOf(packages, snapshot).filter((finding) => unexcusedProblem(finding, exceptions, snapshot, today) !== undefined);
}

interface ChoiceContext {
  readonly snapshot: Snapshot;
  readonly catalog: VersionCatalog;
  readonly config: Config;
  readonly now: Date;
  readonly identity: IdentityCheck;
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
  const own = isOwnPackage(config.ownPackages, name);
  const line = (version: string) => compatibleLine(config, name, version);
  const fixable = targets.filter((target) => moves.some((version) => fixes(snapshot, name, pkg.version, [target], version)));
  const unfixable = targets.filter((target) => !fixable.includes(target));
  const move = async (version: string, aged: boolean): Promise<SecurityFix> => ({
    ...base,
    unfixable,
    to: { version, line: line(version), aged, major: line(version) !== line(pkg.version), blockers: await context.identity.problems(pkg, version) },
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
    // Own packages skip the wait here too; the version must still be clean.
    if (own && order.length > 0) return move(order[0]!, false);
    for (const version of order) {
      if (await isAged({ ...name, version }, catalog, config, now)) return move(version, true);
    }
    return none(`no clean version of ${pkg.name} at least ${config.releaseAgeDays} days old to leave the malicious ${pkg.version} for`);
  }
  if (fixable.length === 0) return none(`no version above ${pkg.version} fixes ${targets.join(", ")}`);
  if (fixing.length === 0) return none(`no single version above ${pkg.version} fixes all of ${fixable.join(", ")}, though each has a fix`);
  if (own) {
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

async function isAged(pkg: PackageVersion, catalog: VersionCatalog, config: Config, now: Date): Promise<boolean> {
  const published = await catalog.published(pkg);
  return published !== undefined && (now.getTime() - published.getTime()) / DAY_MS >= config.releaseAgeDays;
}

/**
 * The npm publisher identity check `compare` runs on a version that replaces
 * another: against every copy of the replaced version the lockfiles ship from
 * the registry, with the same exceptions. Other ecosystems have none.
 */
export class IdentityCheck {
  readonly #registry: NpmRegistry;
  readonly #lockfiles: ReadonlyArray<NpmLockfile>;
  readonly #exceptions: Exceptions;
  readonly #today: string;

  constructor(registry: NpmRegistry, lockfiles: ReadonlyArray<NpmLockfile>, exceptions: Exceptions, today: string) {
    this.#registry = registry;
    this.#lockfiles = lockfiles;
    this.#exceptions = exceptions;
    this.#today = today;
  }

  async problems(from: PackageVersion, to: string): Promise<string[]> {
    if (from.ecosystem !== "npm") return [];
    const shipped = new Map<string, string | undefined>();
    for (const lockfile of this.#lockfiles) {
      for (const copy of lockfile.packages) {
        if (copy.name !== from.name || copy.version !== from.version || copy.bundled || !copy.resolved?.startsWith(`${NPM_REGISTRY}/`)) continue;
        if (shipped.get(copy.version) === undefined) shipped.set(copy.version, copy.integrity);
      }
    }
    const doc = await this.#registry.packument(from.name);
    const manifest = doc.versions[to] as { dist?: { integrity?: unknown; tarball?: unknown } } | undefined;
    const candidate: LockedPackage = {
      name: from.name,
      version: to,
      path: `node_modules/${from.name}`,
      resolved: typeof manifest?.dist?.tarball === "string" ? manifest.dist.tarball : undefined,
      bundled: false,
      integrity: typeof manifest?.dist?.integrity === "string" ? manifest.dist.integrity : undefined,
    };
    return this.#registry.identityProblems(candidate, shipped, this.#exceptions, this.#today);
  }
}

/** How many of a line's newest aged versions bump-it weighs: past them, it reports instead of digging further. */
export const BUMP_DEPTH = 10;

export interface BumpMove {
  readonly version: string;
  readonly line: string;
}

/** Where an npm dependency is declared, for editing it. */
export interface NpmDeclaration {
  readonly lockfile: string;
  /** The declaring workspace, `.` for the root. */
  readonly workspace: string;
  /** The key it's declared under: its name, or an `npm:` alias. */
  readonly declaredAs: string;
  /** The range as written. */
  readonly spec: string;
}

/** A dependency the repository declares directly, and where bump-it can move it. */
export interface BumpCandidate {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly from: string;
  /** npm: `lockfile#workspace`; Gradle: configuration ids; Actions: workflow files. */
  readonly locations: ReadonlyArray<string>;
  /** npm only: each declaration of this version, with the key and range to edit. */
  readonly declarations: ReadonlyArray<NpmDeclaration>;
  /** The highest acceptable version in `from`'s own line (minors and patches go together in one PR). */
  readonly minor: BumpMove | undefined;
  /** The highest acceptable version of the highest newer line that has one (each major is a PR of its own). */
  readonly major: BumpMove | undefined;
  /** What kept versions out: a line whose weighed versions all add an advisory, an identity break, a registry that can't list. */
  readonly problems: ReadonlyArray<string>;
}

export interface BumpCandidates {
  readonly bumps: ReadonlyArray<BumpCandidate>;
  readonly npmPeers?: NpmPeerPlanner;
  /** As in `SecurityCandidates`: the inventory isn't whole, so neither is this list. */
  readonly incomplete: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
  readonly osvScannerVersion: string;
  /** Declared dependencies left out because no supported declaration of them was found in their build's sources. */
  readonly notes: ReadonlyArray<string>;
}

interface Direct extends Located {
  readonly declarations: ReadonlyArray<NpmDeclaration>;
}

/** One line of one dependency, still to judge: its newest aged versions, newest first. */
interface Pending {
  readonly pkg: Direct;
  readonly line: string;
  readonly versions: ReadonlyArray<string>;
}

/**
 * Where bump-it can move each directly declared dependency: in its own line,
 * and in the highest newer line that has an acceptable version (lines are
 * tried from the highest down), the highest version at least `releaseAgeDays`
 * old (own packages skip the wait) that adds no advisory group, no malware
 * and, on npm, no publisher identity break. Each round of lines is judged on
 * one snapshot of the current versions and every version weighed in it.
 * Direct means: npm dependencies the root and the workspaces of every checked
 * lockfile declare (aliases included); Gradle dependencies declared with a
 * version, recorded floors aside (bump-it doesn't raise floors); and every
 * `uses:` pinned to a release. Gradle transitives are never bumped. Node API
 * types are capped at the lowest declared runtime major; unreadable runtime
 * metadata permits only moves within the current type major.
 */
export async function bumpCandidates(head: Tree, env: GateEnvironment, gradle: GradleInputs = {}): Promise<BumpCandidates> {
  const state = await readScanState(head, env, gradle);
  const { config, floors, exceptions } = state.settings;
  const now = env.now();
  const today = now.toISOString().slice(0, 10);
  const { direct, notes } = await directOf(head, state, floors);
  const registry = new NpmRegistry(env.fetch);
  const catalogs = versionCatalogs(config, env, state.github, registry);
  const identity = new IdentityCheck(registry, state.inventory.npm, exceptions, today);

  const problems = new Map<string, string[]>(direct.map((pkg) => [versionKey(pkg), []]));
  const minors = new Map<string, BumpMove>();
  const majors = new Map<string, BumpMove>();
  // Higher lines still to try per dependency, highest first.
  const higherLines = new Map<string, string[]>();
  const newerOf = new Map<string, ReadonlyArray<string>>();
  let round: Pending[] = [];
  for (const pkg of direct) {
    const listed = await catalogs[pkg.ecosystem].versions(pkg);
    if (listed === undefined) {
      problems.get(versionKey(pkg))!.push(`the registry doesn't list ${pkg.name}'s versions completely`);
      continue;
    }
    const allowed = pkg.ecosystem === "npm" && pkg.name === "@types/node"
      ? await nodeVersionsFor(head, pkg, listed, problems.get(versionKey(pkg))!) : listed;
    const newer = movesFrom(pkg, pkg.version, allowed);
    newerOf.set(versionKey(pkg), newer);
    const line = (version: string) => compatibleLine(config, pkg, version);
    const own = line(pkg.version);
    higherLines.set(versionKey(pkg), [...new Set(newer.map(line).filter((candidate) => candidate !== own))].reverse());
    round.push(...(await pending(pkg, own, newer, catalogs[pkg.ecosystem], config, now)));
    round.push(...(await nextHigherLine(pkg, higherLines.get(versionKey(pkg))!, newer, catalogs[pkg.ecosystem], config, now)));
  }

  const snapshots: Snapshot[] = [];
  while (round.length > 0) {
    const snapshot = await takeSnapshot(
      [...new Map(round.map(({ pkg }) => [versionKey(pkg), pkg])).values()],
      snapshotOptions(config, env, state.github),
      round.flatMap(({ pkg, versions }) => versions.map((version) => ({ ...pkg, version }))),
    );
    snapshots.push(snapshot);
    const next: Pending[] = [];
    for (const { pkg, line, versions } of round) {
      const key = versionKey(pkg);
      const ownLine = line === compatibleLine(config, pkg, pkg.version);
      let accepted: string | undefined;
      for (const version of versions) {
        if (!fixes(snapshot, pkg, pkg.version, [], version)) continue;
        const breaks = await identity.problems(pkg, version);
        if (breaks.length > 0) {
          problems.get(key)!.push(...breaks);
          continue;
        }
        accepted = version;
        break;
      }
      if (accepted !== undefined) {
        (ownLine ? minors : majors).set(key, { version: accepted, line });
        continue;
      }
      problems.get(key)!.push(`each of the ${versions.length} newest versions of line ${line} old enough adds an advisory, is malicious or breaks identity`);
      if (ownLine) continue;
      // This major line has nothing acceptable: try the next one down.
      next.push(...(await nextHigherLine(pkg, higherLines.get(key)!, newerOf.get(key)!, catalogs[pkg.ecosystem], config, now)));
    }
    round = next;
  }

  const bumps: BumpCandidate[] = direct.map((pkg) => ({
    ecosystem: pkg.ecosystem,
    name: pkg.name,
    from: pkg.version,
    locations: pkg.locations,
    declarations: pkg.declarations,
    minor: minors.get(versionKey(pkg)),
    major: majors.get(versionKey(pkg)),
    problems: problems.get(versionKey(pkg))!,
  }));
  const selected = bumps.flatMap((bump) => [bump.minor, bump.major].flatMap((move) =>
    move === undefined ? [] : [{ ecosystem: bump.ecosystem, name: bump.name, version: move.version }]));
  const peers = await preparePeers(head, state, registry, catalogs.npm, selected, identity, now);
  const peerSnapshot = peers.bases.length === 0 ? undefined : await takeSnapshot(peers.bases, snapshotOptions(config, env, state.github), peers.candidates);
  return {
    bumps,
    npmPeers: peerSnapshot === undefined ? undefined : { resolve: (moves) => peers.resolve(moves, peerSnapshot) },
    incomplete: inventoryProblems(state.inventory, config),
    gaps: [...state.snapshot.gaps, ...snapshots.flatMap((snapshot) => snapshot.gaps), ...(peerSnapshot?.gaps ?? []), ...actionGaps(state.inventory.actions, state.resolutions)],
    osvScannerVersion: state.osvScannerVersion,
    notes,
  };
}

async function nodeVersionsFor(head: Tree, pkg: Direct, listed: ReadonlyArray<string>, problems: string[]): Promise<ReadonlyArray<string>> {
  const runtime = await nodeRuntime(head, pkg.declarations);
  const allowed = nodeTypeVersions(pkg.version, listed, runtime);
  if (runtime.major === undefined || allowed.length !== listed.length) problems.push(nodeTypeProblem(runtime));
  return allowed;
}

async function preparePeers(head: Tree, state: ScanState, registry: NpmRegistry, catalog: VersionCatalog, seeds: ReadonlyArray<PackageVersion>, identity: IdentityCheck, now: Date, security = false) {
  const locks = new Map<string, unknown>();
  for (const lock of state.inventory.npm) {
    const text = await head.read(lock.path);
    if (text === undefined) throw new Error(`${lock.path} disappeared while reading peers`);
    locks.set(lock.path, JSON.parse(text));
  }
  const config = state.settings.config;
  return prepareNpmPeers(locks, seeds, {
    ...(security ? { requiredYoung: (_name: string, _from: string, lockfile: string, path: string, anchors: ReadonlyArray<PeerMove>) =>
      forcedPeerVersion(locks, lockfile, path, anchors, registry, config, now) } : {}),
    versions: (name) => catalog.versions({ ecosystem: "npm", name }),
    manifest: async (name, version) => (await registry.packument(name)).versions[version],
    published: (name, version) => catalog.published({ ecosystem: "npm", name, version }),
    identity: (name, from, to) => identity.problems({ ecosystem: "npm", name, version: from }, to),
    line: (name, version) => compatibleLine(config, { ecosystem: "npm", name }, version),
    isOwn: (name) => isOwnPackage(config.ownPackages, { ecosystem: "npm", name }),
    now,
    releaseAgeDays: config.releaseAgeDays,
  });
}

async function forcedPeerVersion(locks: ReadonlyMap<string, unknown>, lockfile: string, path: string, anchors: ReadonlyArray<PeerMove>, registry: NpmRegistry, config: Config, now: Date): Promise<string | undefined> {
  const lock = locks.get(lockfile) as { packages: Record<string, unknown> };
  const original = lock.packages;
  const chosen = structuredClone(original);
  const dir = lockfile.includes("/") ? lockfile.slice(0, lockfile.lastIndexOf("/")) : "";
  const inLock = (location: string) => dir === "" ? location : location.startsWith(`${dir}/`) ? location.slice(dir.length + 1) : undefined;
  const roots = anchors.flatMap((anchor) => anchor.locations.flatMap((location) => {
    const key = inLock(location);
    const entry = key === undefined ? undefined : chosen[key];
    if (key === undefined || entry === null || typeof entry !== "object") return [];
    chosen[key] = { ...entry, version: anchor.to };
    return [{ name: anchor.name, version: anchor.to, path: key }];
  }));
  for (const root of roots) {
    const required = await requiredPeerTargets(root, original, chosen, registry, config, now, new Set(roots.map((root) => root.path)));
    const target = required.find((target) => target.path === path);
    if (target !== undefined) return target.version;
  }
  return undefined;
}

/** The highest of `lines` (consumed from the front) with a version old enough to weigh, or none left. */
async function nextHigherLine(
  pkg: Direct,
  lines: string[],
  newer: ReadonlyArray<string>,
  catalog: VersionCatalog,
  config: Config,
  now: Date,
): Promise<Pending[]> {
  for (let line = lines.shift(); line !== undefined; line = lines.shift()) {
    const found = await pending(pkg, line, newer, catalog, config, now);
    if (found.length > 0) return found;
  }
  return [];
}

/** `line`'s newest versions old enough to weigh (none when it has no newer version or none is old enough). */
async function pending(
  pkg: Direct,
  line: string,
  newer: ReadonlyArray<string>,
  catalog: VersionCatalog,
  config: Config,
  now: Date,
): Promise<Pending[]> {
  const inLine = newer.filter((version) => compatibleLine(config, pkg, version) === line).reverse();
  if (inLine.length === 0) return [];
  const versions = await newestAged(pkg, inLine, catalog, config, now);
  return versions.length === 0 ? [] : [{ pkg, line, versions }];
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
    if (await isAged({ ...pkg, version }, catalog, config, now)) aged.push(version);
  }
  return aged;
}

/**
 * The directly declared dependencies of the scanned tree, one per version, with where each is declared, sorted. A
 * Gradle dependency counts only when the repository's Gradle sources name it (see `gradleSourceIndex`): plugins add
 * dependencies too, and a bump needs a declaration to move. The rest are listed in `notes`.
 */
async function directOf(head: Tree, state: ScanState, floors: ReadonlyArray<Floor>): Promise<{ direct: Direct[]; notes: string[] }> {
  const byVersion = new Map<string, { pkg: PackageVersion; locations: Set<string>; declarations: NpmDeclaration[] }>();
  const add = (pkg: PackageVersion, location: string, declaration?: NpmDeclaration) => {
    const entry = byVersion.get(versionKey(pkg)) ?? { pkg, locations: new Set<string>(), declarations: [] };
    entry.locations.add(location);
    if (declaration !== undefined) entry.declarations.push(declaration);
    byVersion.set(versionKey(pkg), entry);
  };
  for (const lockfile of state.inventory.npm) {
    const text = await head.read(lockfile.path);
    if (text === undefined) throw new Error(`${lockfile.path} disappeared while reading it`);
    for (const dependency of directDependencies(JSON.parse(text))) {
      const workspace = dependency.workspace || ".";
      add({ ecosystem: "npm", name: dependency.name, version: dependency.version }, `${lockfile.path}#${workspace}`, {
        lockfile: lockfile.path,
        workspace,
        declaredAs: dependency.declaredAs,
        spec: dependency.spec,
      });
    }
  }
  const floored = new Set(floors.filter((floor) => floor.ecosystem === "Maven").map((floor) => `${floor.package}@${floor.version}`));
  const builds = state.inventory.gradle?.builds ?? [];
  const sources = builds.length === 0 ? undefined : await gradleSourceIndex(head);
  const unnamed = new Map<string, Set<string>>();
  for (const build of builds) {
    for (const configuration of build.configurations) {
      for (const declared of configuration.declared) {
        if (declared.version === undefined) continue;
        const name = `${declared.group}:${declared.name}`;
        if (floored.has(`${name}@${declared.version}`)) continue;
        const location = gradleLocation(build.build, configuration.id);
        if (!sources!.named(declared.group, declared.name)) {
          const key = `${name}@${declared.version}`;
          unnamed.set(key, (unnamed.get(key) ?? new Set()).add(location));
          continue;
        }
        add({ ecosystem: "Maven", name, version: declared.version }, location);
      }
    }
  }
  const notes = [...unnamed.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, locations]) =>
    `${key}: not named in the repository's Gradle sources (${[...locations].sort().join(", ")}), so it isn't moved automatically; a plugin may add it, or it uses notation bump-it doesn't read`);
  for (const pkg of state.packages.filter((located) => located.ecosystem === "GitHub Actions")) {
    for (const location of pkg.locations) add(pkg, location);
  }
  const direct = [...byVersion.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, { pkg, locations, declarations }]) => ({ ...pkg, locations: [...locations].sort(), declarations }));
  return { direct, notes };
}
