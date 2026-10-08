/** Preserve recorded floors and their declarations; only exact, planned security changes may alter them. */
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { type Floor, FLOORS_PATH, overrideAt, parseFloors } from "../../ci/src/floors.ts";
import { gradleLocation, type GradleInventory } from "../../ci/src/gradle.ts";
import type { Tree } from "../../ci/src/tree.ts";

import { floorIdentity } from "./floor-removal.ts";
import type { ChangePlan, PlannedMove } from "./plan.ts";

export async function preservedFloors(plan: ChangePlan, base: Tree, head: Tree, gradle: { base?: GradleInventory; head?: GradleInventory }): Promise<string[]> {
  const before = await floorsOf(base);
  const after = await floorsOf(head);
  const problems: string[] = [];
  for (const floor of before) {
    const next = after.find((candidate) => floorKey(candidate) === floorKey(floor));
    const label = `${floor.purpose} floor ${floor.package} in ${floor.declaredIn}`;
    if (next === undefined && plan.kind === "floor-removal" && floor.purpose === "security" && plan.floorRemoval?.floors.some((removed) => floorIdentity(removed) === floorIdentity(floor))) {
      problems.push(...await removedDeclaration(floor, plan.floorRemoval!.floors, head, gradle));
      continue;
    }
    if (next === undefined) {
      problems.push(`${label} was removed or its selector changed`);
      continue;
    }
    const changedRecord = !isDeepStrictEqual(normalized(floor), normalized(next));
    const changedDeclaration = !isDeepStrictEqual(await declarations(floor, base, gradle.base), await declarations(next, head, gradle.head));
    if (!changedRecord && !changedDeclaration) continue;
    if (floor.purpose === "compatibility" || !plannedUpdate(plan, floor, next)) {
      problems.push(`${label} or its declaration changed outside an explicit security-floor move`);
    }
  }
  for (const removed of plan.floorRemoval?.floors ?? []) {
    if (plan.kind !== "floor-removal" || removed.purpose !== "security" || !before.some((floor) => floorIdentity(floor) === floorIdentity(removed))) {
      problems.push(`${removed.package}: removal must name a base security floor exactly`);
    } else if (after.some((floor) => floorKey(floor) === floorKey(removed))) {
      problems.push(`${removed.package}: planned floor record was not removed`);
    }
  }
  for (const floor of after.filter((candidate) => !before.some((old) => floorKey(old) === floorKey(candidate)))) {
    const moves = matchingMoves(plan, floor, true);
    if (floor.purpose !== "security" || moves.length === 0 || !floor.advisories.every((id) => moves.some((move) => move.advisories.includes(id)))) {
      problems.push(`floor ${floor.package} in ${floor.declaredIn} was added outside the plan`);
    }
  }
  return problems;
}

async function removedDeclaration(floor: Floor, removed: ReadonlyArray<Floor>, head: Tree, gradle: { base?: GradleInventory; head?: GradleInventory }): Promise<string[]> {
  if (floor.ecosystem === "npm") {
    const overrides = JSON.parse(await head.read(floor.declaredIn) ?? "{}").overrides as unknown;
    return floor.overridePaths.filter((path) => overrideAt(overrides, path) !== undefined)
      .map((path) => `${floor.package}: planned override ${path.join(" > ")} was not removed`);
  }
  const problems: string[] = [];
  const configurations = (inventory: GradleInventory | undefined, location: string) => inventory?.builds
    .flatMap((build) => build.configurations.map((config) => ({ location: gradleLocation(build.build, config.id), config })))
    .find((candidate) => candidate.location === location)?.config;
  for (const location of floor.locations) {
    const before = configurations(gradle.base, location);
    const after = configurations(gradle.head, location);
    if (before === undefined || after === undefined) {
      problems.push(`${floor.package}: removal needs both configuration inventories at ${location}`);
      continue;
    }
    if (!before.declared.some((entry) => matchesFloor(entry, floor))) {
      problems.push(`${floor.package}: no exact advisory floor declaration at ${location}`);
    }
    // Every other declaration here, including this package's parents and constraints, stays.
    const expected = before.declared.filter((entry) => !removed.some((other) =>
      other.ecosystem === "Maven" && other.locations.includes(location) && matchesFloor(entry, other)));
    if (!isDeepStrictEqual(declarationSignatures(expected), declarationSignatures(after.declared))) {
      problems.push(`${floor.package}: ${location} did not remove exactly the planned floor declarations`);
    }
  }
  return problems;
}

type DeclaredDependency = GradleInventory["builds"][number]["configurations"][number]["declared"][number];

function matchesFloor(dependency: DeclaredDependency, floor: Floor): boolean {
  return `${dependency.group}:${dependency.name}` === floor.package && dependency.version === floor.version &&
    floor.advisories.every((id) => dependency.reason?.toUpperCase().includes(id.toUpperCase()));
}

function declarationSignatures(entries: ReadonlyArray<DeclaredDependency>): string[] {
  return entries.map((entry) => JSON.stringify(entry)).sort();
}

async function floorsOf(tree: Tree): Promise<Floor[]> {
  const text = await tree.read(FLOORS_PATH);
  return text === undefined ? [] : parseFloors(JSON.parse(text));
}

function normalized(floor: Floor): Floor {
  return { ...floor, locations: [...floor.locations].sort(), overridePaths: [...floor.overridePaths].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), advisories: [...floor.advisories].sort() };
}

function floorKey(floor: Floor): string {
  const sorted = normalized(floor);
  return JSON.stringify([floor.ecosystem, floor.package, floor.declaredIn, sorted.locations, sorted.overridePaths]);
}

function matchingMoves(plan: ChangePlan, floor: Floor, addition: boolean): PlannedMove[] {
  const moves = plan.moves.filter((move) => move.ecosystem === floor.ecosystem && move.name === floor.package && move.to === floor.version);
  if (floor.ecosystem === "Maven") {
    const allowed = moves.filter((move) => move.mechanism === "gradle-floor" || !addition && move.mechanism === "gradle-declared");
    return floor.locations.every((location) => allowed.some((move) => move.locations.includes(location))) ? allowed : [];
  }
  const dir = dirname(floor.declaredIn);
  return moves.filter((move) => move.mechanism === "npm-override" && move.locations.some((location) =>
    dir === "." ? location.startsWith("node_modules/") : location.startsWith(`${dir}/node_modules/`)));
}

function plannedUpdate(plan: ChangePlan, before: Floor, after: Floor): boolean {
  const moves = matchingMoves(plan, after, false).filter((move) => move.from === before.version);
  if (moves.length === 0 || after.purpose !== "security") return false;
  // Record history and scope stay intact; the exact new version and extra target IDs are the planned change.
  if (!isDeepStrictEqual(normalized({ ...before, version: after.version, advisories: after.advisories }), normalized(after))) return false;
  return before.advisories.every((id) => after.advisories.includes(id)) && after.advisories.every((id) =>
    before.advisories.includes(id) || moves.some((move) => move.advisories.includes(id)));
}

async function declarations(floor: Floor, tree: Tree, gradle: GradleInventory | undefined): Promise<unknown> {
  if (floor.ecosystem === "npm") {
    const manifest = await tree.read(floor.declaredIn);
    const overrides = manifest === undefined ? undefined : (JSON.parse(manifest) as Record<string, unknown>)["overrides"];
    return floor.overridePaths.map((path) => [JSON.stringify(path), overrideAt(overrides, path)]).sort(([a], [b]) => String(a).localeCompare(String(b)));
  }
  return floor.locations.map((location) => {
    const configuration = gradle?.builds.flatMap((build) => build.configurations.map((config) => ({ location: gradleLocation(build.build, config.id), config })))
      .find((candidate) => candidate.location === location)?.config;
    const declared = configuration?.declared.filter((entry) => `${entry.group}:${entry.name}` === floor.package)
      .map((entry) => JSON.stringify([entry.version, entry.reason])).sort();
    return [location, declared];
  }).sort(([a], [b]) => String(a).localeCompare(String(b)));
}
