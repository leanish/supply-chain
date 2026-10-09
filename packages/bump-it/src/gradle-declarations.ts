/** Per-declaration versions, including several versions of one package in one inherited configuration. */
import { gradleLocation, type GradleInventory } from "../../ci/src/gradle.ts";
import { gradleSourceIndex } from "../../ci/src/gradle-sources.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { declaredAt } from "../../remediation/src/edit-checks.ts";
import type { PlannedMove } from "./plan.ts";

/**
 * Whether an unplanned declared dependency's change at a Gradle location is plugin-driven, so verification lets it
 * through: the repository's Gradle sources name it neither before nor after (see `gradleSourceIndex`), the plan moves a
 * plugin of that build (a move on a buildscript or settings classpath), and only its version changed (as many
 * declarations before as after: nothing added or removed). bump-it never plans such dependencies (updating the
 * Kotlin plugin moves the stdlib it adds), and the gate still judges every version that changes. Anything else keeps
 * the strict checks: a declaration the index can't read changes only with a plugin update in its build.
 */
export async function pluginDriven(base: Tree, head: Tree, inventories: { readonly base: GradleInventory | undefined; readonly head: GradleInventory | undefined }, moves: ReadonlyArray<PlannedMove>): Promise<(name: string, location: string) => boolean> {
  const buildOf = new Map<string, string>();
  const classpath = new Set<string>();
  for (const build of [inventories.base, inventories.head].flatMap((inventory) => inventory?.builds ?? [])) {
    for (const configuration of build.configurations) {
      const location = gradleLocation(build.build, configuration.id);
      buildOf.set(location, build.build);
      if (configuration.kind === "buildscript" || configuration.kind === "settings") classpath.add(location);
    }
  }
  const planned = moves.filter((move) => move.mechanism === "gradle-declared");
  const pluginBuilds = new Set(planned.flatMap((move) => move.locations.filter((location) => classpath.has(location)).map((location) => buildOf.get(location)!)));
  if (pluginBuilds.size === 0) return () => false;
  const [before, after] = await Promise.all([gradleSourceIndex(base), gradleSourceIndex(head)]);
  return (name, location) => {
    const build = buildOf.get(location);
    if (build === undefined || !pluginBuilds.has(build)) return false;
    if (planned.some((move) => move.name === name && move.locations.includes(location))) return false;
    const [group, artifact] = name.split(":") as [string, string];
    if (before.named(group, artifact) || after.named(group, artifact)) return false;
    const was = declaredAt(inventories.base, location, name);
    return was.length > 0 && was.length === declaredAt(inventories.head, location, name).length;
  };
}

export function gradleDeclarationProblems(moves: ReadonlyArray<PlannedMove>, base: GradleInventory | undefined, head: GradleInventory | undefined, driven: (name: string, location: string) => boolean = () => false): string[] {
  const planned = moves.filter((move) => move.mechanism === "gradle-declared");
  const entries = new Map<string, { location: string; name: string }>();
  for (const inventory of [base, head]) {
    for (const build of inventory?.builds ?? []) {
      for (const configuration of build.configurations) {
        for (const declaration of configuration.declared) {
          if (declaration.version === undefined) {
            continue;
          }
          const location = gradleLocation(build.build, configuration.id);
          const name = `${declaration.group}:${declaration.name}`;
          entries.set(`${location}|${name}`, { location, name });
        }
      }
    }
  }
  const problems: string[] = [];
  for (const { location, name } of entries.values()) {
    if (driven(name, location)) continue;
    const before = declaredAt(base, location, name);
    const after = declaredAt(head, location, name).sort();
    const selected = planned.filter((move) => move.name === name && move.locations.includes(location));
    const expected = before.map((version) => selected.find((move) => move.from === version)?.to ?? version).sort();
    if (JSON.stringify(expected) === JSON.stringify(after)) {
      continue;
    }
    if (selected.length === 1 && before.length === 1) {
      problems.push(`${location} must declare ${name} exactly ${selected[0]!.to}`);
    } else {
      problems.push(`${name} declarations at ${location} changed outside the plan: expected ${expected.join(", ") || "none"}, got ${after.join(", ") || "none"}`);
    }
  }
  for (const move of planned) {
    for (const location of move.locations) {
      if (!declaredAt(base, location, move.name).includes(move.from)) {
        problems.push(`${location} has no source declaration of ${move.name} ${move.from}`);
      }
    }
  }
  return problems;
}
