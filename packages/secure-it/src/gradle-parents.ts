/**
 * Parent first, where Gradle would otherwise get a floor: for a vulnerable
 * module X that no source-named declaration holds (a transitive, or one only
 * a plugin declares), secure-it first looks for a declared dependency D that
 * brings X in every vulnerable configuration, and a version of D that brings
 * a fixed X, before adding a floor.
 *
 * Roots are the source-named, versioned declarations whose resolved node
 * reaches X through the configuration's resolved graph (dependency edges, not
 * constraints) in every vulnerable location; the inventory's edges are the
 * evidence, and a configuration without them leaves the floor. Roots are tried
 * by the fewest configurations they're declared in, then by name. For a root,
 * the candidates are its versions in its own compatible line, above the one
 * the base declares, past the release-age wait, adding no advisory group of
 * its own (and fixing its own targets too, when D is a failing fix of the same
 * unit: then from that fix's version up). Each is proved, lowest first, by a
 * reference resolution: the base with D moved across its whole declaration
 * reach, applied by Gradle (`gradle-reference.ts`), in which X, wherever it's
 * still resolved in the vulnerable configurations, has none of the targets. A
 * budget of probes is shared by every root of one module; a probe that fails,
 * a budget spent or anything unknown leaves the floor, with a note.
 *
 * A proved parent becomes a `gradle-declared` move of D that `carries` X: X's
 * floor isn't planned, and verification checks X's targets are gone.
 */
import { ActionsGitHub } from "../../ci/src/actions-github.ts";
import type { CarriedPackage } from "../../ci/src/carrier-candidates.ts";
import type { Config } from "../../ci/src/config.ts";
import { type GateEnvironment, snapshotOptions, versionCatalogs } from "../../ci/src/gate.ts";
import { type GradleConfiguration, type GradleInventory, gradleLocation } from "../../ci/src/gradle.ts";
import type { PackageVersion } from "../../ci/src/package-version.ts";
import { takeSnapshot } from "../../ci/src/take-snapshot.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { versionScheme } from "../../ci/src/versions.ts";
import { compatibleLine, fixes, movesFrom, targetsOf } from "../../ci/src/young-fixes.ts";
import { declaredAt, resolvedAt, UNVERSIONED } from "../../remediation/src/edit-checks.ts";
import { referenceProblems, referenceTransform } from "../../remediation/src/gradle-reference.ts";
import type { GradleInventories } from "../../remediation/src/inventories.ts";

import { type FixWork, gradleMechanism } from "./plan.ts";

const DAY_MS = 86_400_000;
/** Reference resolutions one vulnerable module may cost, across all its roots. */
export const PARENT_PROBES = 6;

export interface GradleParentInputs {
  readonly base: Tree;
  readonly gradle: GradleInventory;
  readonly named: (group: string, name: string) => boolean;
  readonly inventories: Pick<GradleInventories, "ofCommit">;
  readonly env: GateEnvironment;
  readonly config: Config;
}

/** `work` with each Gradle fix a parent can carry folded into that parent's move, and notes on the rest. */
export async function withGradleParents(work: ReadonlyArray<FixWork>, inputs: GradleParentInputs): Promise<{ readonly fixes: FixWork[]; readonly notes: string[] }> {
  let fixesNow = [...work];
  const notes: string[] = [];
  for (const fix of work) {
    if (fix.ecosystem !== "Maven" || fix.to === undefined || fix.malicious || fix.carries !== undefined) continue;
    const floored = fix.locations.filter((location) => gradleMechanism(inputs, fix.name, location) === "gradle-floor");
    if (floored.length === 0) continue;
    const found = await parentFor(fix, floored, fixesNow, inputs).catch((error: unknown) => `searching its parents failed: ${error instanceof Error ? error.message : String(error)}`);
    if (typeof found === "string") {
      notes.push(`${fix.name}@${fix.from} gets a floor: ${found}`);
      continue;
    }
    fixesNow = fold(fixesNow, fix, floored, found);
  }
  return { fixes: fixesNow, notes };
}

interface Parent {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly line: string;
  readonly locations: ReadonlyArray<string>;
  readonly carried: CarriedPackage;
}

/** `work` with X's floored locations carried by the parent's move (merged into the parent's own fix when it has one). */
function fold(work: ReadonlyArray<FixWork>, fix: FixWork, floored: ReadonlyArray<string>, parent: Parent): FixWork[] {
  const rest = fix.locations.filter((location) => !floored.includes(location));
  const own = work.find((entry) => entry.ecosystem === "Maven" && entry.name === parent.name);
  const to = { version: parent.to, line: parent.line, aged: true, major: false, blockers: [] };
  const carrier: FixWork = own === undefined
    ? { ecosystem: "Maven", name: parent.name, from: parent.from, locations: parent.locations, targets: [], unfixable: [], malicious: false, severity: fix.severity, to, problem: undefined, carries: [parent.carried] }
    : { ...own, locations: [...new Set([...own.locations, ...parent.locations])], to, carries: [...(own.carries ?? []), parent.carried] };
  return work.flatMap((entry) => {
    if (entry === fix) return rest.length === 0 ? [] : [{ ...fix, locations: rest }];
    if (entry === own) return [carrier];
    return [entry];
  }).concat(own === undefined ? [carrier] : []);
}

async function parentFor(fix: FixWork, floored: ReadonlyArray<string>, work: ReadonlyArray<FixWork>, inputs: GradleParentInputs): Promise<Parent | string> {
  const configurations = floored.map((location) => configurationAt(inputs.gradle, location));
  if (configurations.some((entry) => entry === undefined)) return "a vulnerable configuration isn't in the inventory";
  if (configurations.some((entry) => entry!.configuration.edges === undefined)) return "the inventory doesn't record who brings it";
  const roots = rootsOf(fix.name, configurations.map((entry) => entry!.configuration), inputs.named);
  if (roots.length === 0) return `no declared dependency brings it in every vulnerable configuration (${floored.join(", ")})`;
  const ordered = roots.map((name) => ({ name, reach: reachOf(inputs.gradle, name) })).sort((a, b) => a.reach.length - b.reach.length || (a.name < b.name ? -1 : 1));
  let budget = PARENT_PROBES;
  const reasons: string[] = [];
  for (const { name, reach } of ordered) {
    const result = await tryRoot(fix, floored, name, reach, work, inputs, () => budget-- > 0);
    if (typeof result !== "string") return result;
    reasons.push(`${name}: ${result}`);
    if (budget <= 0) break;
  }
  return reasons.join("; ");
}

async function tryRoot(fix: FixWork, floored: ReadonlyArray<string>, root: string, reach: ReadonlyArray<string>, work: ReadonlyArray<FixWork>, inputs: GradleParentInputs, spend: () => boolean): Promise<Parent | string> {
  const { config, env } = inputs;
  const declared = [...new Set(reach.flatMap((location) => declaredAt(inputs.gradle, location, root)).filter((version) => version !== UNVERSIONED))];
  if (declared.length !== 1) return `declared at ${declared.length === 0 ? "no version" : declared.sort().join(", ")}, not one version to move`;
  const from = declared[0]!;
  const parent = { ecosystem: "Maven" as const, name: root };
  const own = work.find((entry) => entry.ecosystem === "Maven" && entry.name === root && entry.to !== undefined);
  const ownTargets = own === undefined ? [] : own.targets.filter((target) => !own.unfixable.includes(target));
  const catalogs = versionCatalogs(config, env, new ActionsGitHub(env.fetch, env.githubToken));
  const listed = await catalogs.Maven.versions(parent);
  if (listed === undefined) return "its versions can't be listed";
  const line = (version: string) => compatibleLine(config, parent, version);
  const floor = own?.to?.version;
  const scheme = versionScheme("Maven");
  const aged: string[] = [];
  for (const version of movesFrom(parent, from, listed, "above")) {
    if (line(version) !== line(from) || (floor !== undefined && scheme.compare(version, floor) < 0)) continue;
    const published = await catalogs.Maven.published({ ...parent, version });
    if (published !== undefined && (env.now().getTime() - published.getTime()) / DAY_MS >= config.releaseAgeDays) aged.push(version);
  }
  if (aged.length === 0) return `no version in its line past the wait${floor === undefined ? "" : ` from ${floor}`}`;
  const options = snapshotOptions(config, env, new ActionsGitHub(env.fetch, env.githubToken));
  const rootSnapshot = await takeSnapshot([{ ...parent, version: from }], options, aged.map((version) => ({ ...parent, version })));
  const clean = aged.filter((version) => fixes(rootSnapshot, parent, from, ownTargets, version));
  if (clean.length === 0) return "every version past the wait brings an advisory of its own or leaves its own";
  for (const version of clean) {
    if (!spend()) return "the probe budget is spent";
    const moves = [{ name: root, from, to: version, locations: reach }];
    const reference = await inputs.inventories.ofCommit(inputs.base, { transform: referenceTransform(moves, []) });
    const landed = referenceProblems(inputs.gradle, reference, moves, []);
    if (reference === undefined || landed.length > 0) return `${version} can't be applied faithfully: ${landed.join("; ") || "no inventory"}`;
    const brought = [...new Set(floored.flatMap((location) => {
      const resolved = resolvedAt(reference, location, fix.name);
      return resolved === undefined ? [] : [resolved];
    }))];
    const packages: PackageVersion[] = [{ ecosystem: "Maven", name: fix.name, version: fix.from }, ...brought.map((resolved): PackageVersion => ({ ecosystem: "Maven", name: fix.name, version: resolved }))];
    const snapshot = await takeSnapshot(packages, options);
    const targets = new Set(fix.targets.filter((target) => !fix.unfixable.includes(target)).map((target) => snapshot.group(target)));
    const left = brought.filter((resolved) => targetsOf(snapshot, { ecosystem: "Maven", name: fix.name, version: resolved }).some((group) => targets.has(group)));
    if (left.length > 0) continue;
    return {
      name: root, from, to: version, line: line(version), locations: reach,
      carried: { name: fix.name, from: [fix.from], to: brought.sort(), locations: [...floored].sort(), advisories: fix.targets.filter((target) => !fix.unfixable.includes(target)) },
    };
  }
  return `no version past the wait brings ${fix.name} without ${fix.targets.join(", ")}`;
}

/** Source-named, versioned declarations whose resolved node reaches `name` in every configuration. */
function rootsOf(name: string, configurations: ReadonlyArray<GradleConfiguration>, named: (group: string, name: string) => boolean): string[] {
  const perConfiguration = configurations.map((configuration) => {
    const reaching = new Set<string>();
    for (const declared of configuration.declared) {
      const coordinate = `${declared.group}:${declared.name}`;
      if (coordinate === name || declared.version === undefined || !named(declared.group, declared.name)) continue;
      const resolved = configuration.resolved.find((entry) => entry.group === declared.group && entry.name === declared.name);
      if (resolved !== undefined && reaches(configuration, `${coordinate}:${resolved.version}`, name)) reaching.add(coordinate);
    }
    return reaching;
  });
  const [first, ...rest] = perConfiguration;
  return [...(first ?? [])].filter((coordinate) => rest.every((set) => set.has(coordinate))).sort();
}

/** Whether `start` reaches any version of module `name` along dependency (not constraint) edges. */
function reaches(configuration: GradleConfiguration, start: string, name: string): boolean {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const edge of configuration.edges ?? []) {
      if (edge.constraint || edge.from !== node || seen.has(edge.to)) continue;
      if (edge.to.startsWith(`${name}:`)) return true;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return false;
}

/** Every configuration (gate location) that declares `name` with a version: where moving the declaration reaches. */
function reachOf(gradle: GradleInventory, name: string): string[] {
  const reach: string[] = [];
  for (const build of gradle.builds) {
    for (const configuration of build.configurations) {
      if (configuration.declared.some((declared) => `${declared.group}:${declared.name}` === name && declared.version !== undefined)) reach.push(gradleLocation(build.build, configuration.id));
    }
  }
  return reach.sort();
}

function configurationAt(gradle: GradleInventory, location: string): { readonly configuration: GradleConfiguration } | undefined {
  for (const build of gradle.builds) {
    for (const configuration of build.configurations) if (gradleLocation(build.build, configuration.id) === location) return { configuration };
  }
  return undefined;
}
