/**
 * What a Gradle edit must match: the base with the plan applied programmatically, not by text. The reference init
 * script moves each planned declaration in place (keeping its version's form) and adds planned floors (secure-it's
 * floor removal uses its own script); the inventory of that build is what a faithful edit resolves and declares,
 * including whatever a planned plugin update adds or moves by running. Both tools then require the edit's inventory to
 * be the same, location by location, so nothing the plan didn't do can change what the build resolves (a constraint, a
 * forced version, a resolution rule, a substitution, from any file or code) or declares (a versionless declaration
 * included). A change that alters neither isn't seen: the protected scope is the resolved modules and the declarations.
 */
import { fileURLToPath } from "node:url";

import { gradleLocation, type GradleInventory } from "../../ci/src/gradle.ts";

import { declaredAt, UNVERSIONED } from "./edit-checks.ts";
import type { GradleTransform } from "./inventories.ts";

const REFERENCE_INIT_SCRIPT = fileURLToPath(new URL("../../ci/gradle/supply-chain-reference.init.gradle", import.meta.url));
/** The `because(...)` the reference script gives each declaration it moves, so its whole reach shows in the inventory. */
const MOVED_REASON = "moved by the supply-chain reference";

/** A declaration move: `name`'s declarations at `from` that the `locations` inherit go to `to`. */
export interface ReferenceMove {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly locations: ReadonlyArray<string>;
}

/** A floor: `name:version`, with `because(reason)`, added at `locations`. */
export interface ReferenceFloor {
  readonly name: string;
  readonly version: string;
  readonly reason: string;
  readonly locations: ReadonlyArray<string>;
}

export function referenceTransform(moves: ReadonlyArray<ReferenceMove>, floors: ReadonlyArray<ReferenceFloor>): GradleTransform {
  return {
    initScript: REFERENCE_INIT_SCRIPT,
    property: "supplyChain.reference.file",
    content: (repositoryRoot) => ({ repositoryRoot, movedReason: MOVED_REASON, moves, floors }),
  };
}

/**
 * Whether the plan landed in the reference, as the base declared it, and went nowhere else: at each move's and
 * floor's locations, the package's declarations are the base's with exactly the `from`s planned there turned into `to`
 * and the floors planned there added; and a declaration the reference moved (it carries `MOVED_REASON`) shows only
 * at its move's locations, however Gradle came to reach another (a configuration inheriting it, one created later,
 * the same declaration shared). A build that reset a moved version, or a location the reference couldn't move, shows
 * here rather than passing as the plan's reference. Anything else the reference changed is the plan's own fallout:
 * the base's build ran with the plan applied (a planned plugin update adding or moving what that plugin declares).
 */
export function referenceProblems(base: GradleInventory | undefined, reference: GradleInventory | undefined, moves: ReadonlyArray<ReferenceMove>, floors: ReadonlyArray<ReferenceFloor>): string[] {
  const problems: string[] = [];
  const touched = new Map<string, { name: string; location: string }>();
  for (const { name, locations } of [...moves, ...floors]) {
    for (const location of locations) touched.set(JSON.stringify([name, location]), { name, location });
  }
  for (const { name, location } of touched.values()) {
    const was = declaredAt(base, location, name);
    const here = moves.filter((move) => move.name === name && move.locations.includes(location));
    for (const move of here.filter((move) => !was.includes(move.from))) problems.push(`the plan's base has no declaration of ${name} ${move.from} to move at ${location}`);
    const added = floors.filter((floor) => floor.name === name && floor.locations.includes(location)).map((floor) => floor.version);
    const expected = [...was.map((version) => here.find((move) => move.from === version)?.to ?? version), ...added].sort();
    const actual = declaredAt(reference, location, name).sort();
    if (!sameList(actual, expected)) problems.push(`the plan's reference declares ${name} ${listed(actual)} at ${location}, not ${listed(expected)}`);
  }
  for (const build of reference?.builds ?? []) {
    for (const configuration of build.configurations) {
      const location = gradleLocation(build.build, configuration.id);
      for (const declared of configuration.declared.filter((entry) => entry.reason === MOVED_REASON)) {
        const name = `${declared.group}:${declared.name}`;
        if (!moves.some((move) => move.name === name && move.locations.includes(location))) problems.push(`the plan's reference moved ${name} at ${location}, which the plan doesn't list`);
      }
    }
  }
  return problems;
}

/**
 * Where `head` differs from `reference`: a build or configuration only one has (or of another kind), the modules a
 * configuration resolves, its declarations (every version, versionless ones included), and anything either fails to
 * resolve.
 */
export function referenceDifferences(reference: GradleInventory | undefined, head: GradleInventory | undefined): string[] {
  if (reference === undefined && head === undefined) return [];
  if (reference === undefined || head === undefined) return [`the edit ${head === undefined ? "removed" : "added"} the Gradle inventory the plan's reference ${head === undefined ? "has" : "doesn't have"}`];
  const was = locations(reference);
  const now = locations(head);
  const problems: string[] = [];
  for (const location of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const expected = was.get(location);
    const actual = now.get(location);
    if (expected === undefined || actual === undefined) {
      problems.push(`${location} is ${expected === undefined ? "only in the edit" : "missing from the edit"}, unlike the plan's reference`);
      continue;
    }
    if (expected.kind !== actual.kind) problems.push(`${location} is a ${actual.kind} configuration in the edit, ${expected.kind} in the plan's reference`);
    for (const failure of expected.failures) problems.push(`${location} doesn't resolve in the plan's reference: ${failure}`);
    for (const failure of actual.failures) problems.push(`${location} doesn't resolve in the edit: ${failure}`);
    problems.push(...listDifference(location, "resolves", expected.resolved, actual.resolved));
    problems.push(...listDifference(location, "declares", expected.declared, actual.declared));
  }
  return problems;
}

interface LocationEntries {
  readonly kind: string;
  readonly resolved: ReadonlyArray<string>;
  readonly declared: ReadonlyArray<string>;
  readonly failures: ReadonlyArray<string>;
}

function locations(inventory: GradleInventory): Map<string, LocationEntries> {
  const entries = new Map<string, LocationEntries>();
  for (const build of inventory.builds) {
    for (const configuration of build.configurations) {
      entries.set(gradleLocation(build.build, configuration.id), {
        kind: configuration.kind,
        resolved: configuration.resolved.map((module) => `${module.group}:${module.name}:${module.version}`).sort(),
        declared: configuration.declared.map((declared) => `${declared.group}:${declared.name} ${declared.version ?? UNVERSIONED}`).sort(),
        failures: [...(configuration.error === undefined ? [] : [configuration.error]), ...configuration.unresolved.map((entry) => `${entry.requested}: ${entry.failure}`)],
      });
    }
  }
  return entries;
}

/** What `actual` has beyond `expected` and lacks from it, as multisets. */
function listDifference(location: string, verb: string, expected: ReadonlyArray<string>, actual: ReadonlyArray<string>): string[] {
  const extra = without(actual, expected);
  const missing = without(expected, actual);
  if (extra.length === 0 && missing.length === 0) return [];
  const parts = [...(extra.length > 0 ? [`also ${verb} ${extra.join(", ")}`] : []), ...(missing.length > 0 ? [`no longer ${verb} ${missing.join(", ")}`] : [])];
  return [`${location}, unlike the plan's reference, ${parts.join(" and ")}`];
}

function without(from: ReadonlyArray<string>, minus: ReadonlyArray<string>): string[] {
  const left = [...from];
  for (const entry of minus) {
    const at = left.indexOf(entry);
    if (at !== -1) left.splice(at, 1);
  }
  return left;
}

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((entry, index) => entry === b[index]);
const listed = (versions: ReadonlyArray<string>) => (versions.length === 0 ? "nothing" : versions.join(", "));
