/** Per-declaration versions, including several versions of one package in one inherited configuration. */
import { gradleLocation, type GradleInventory } from "../../ci/src/gradle.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { declaredAt } from "../../remediation/src/edit-checks.ts";
import type { PlannedMove } from "./plan.ts";

/**
 * Whether an unplanned declared dependency's change at a Gradle location is plugin-driven, so verification lets it
 * through: the plan moves a plugin of that build (a move on a buildscript or settings classpath), only its version
 * changed (as many declarations before as after: nothing added or removed), and every file the unit changed, outside
 * `checkedElsewhere` (files verified exactly by their own checks), exists on both sides and differs only by planned version swaps
 * (`from` to `to`, each a whole version string). Nothing but the planned edits changed, so the planned plugin update
 * moved it (updating the Kotlin plugin moves the stdlib it adds); the gate still judges every version that changes.
 * A swap is recognised by its text alone, so a dependency written with a planned move's exact `from` version may move
 * to its `to` with it, as one sharing a version variable with the plugin does.
 */
export async function pluginDriven(base: Tree, head: Tree, inventories: { readonly base: GradleInventory | undefined; readonly head: GradleInventory | undefined }, moves: ReadonlyArray<PlannedMove>, changedFiles: ReadonlyArray<string>, checkedElsewhere: ReadonlySet<string>): Promise<(name: string, location: string) => boolean> {
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
  for (const path of changedFiles.filter((file) => !checkedElsewhere.has(file))) {
    // An added or deleted file is an edit, however empty.
    const [before, after] = [await base.read(path), await head.read(path)];
    if (before === undefined || after === undefined || !onlySwaps(before, after, planned)) return () => false;
  }
  return (name, location) => {
    const build = buildOf.get(location);
    if (build === undefined || !pluginBuilds.has(build)) return false;
    if (planned.some((move) => move.name === name && move.locations.includes(location))) return false;
    const was = declaredAt(inventories.base, location, name);
    return was.length > 0 && was.length === declaredAt(inventories.head, location, name).length;
  };
}

/** Whether `after` is `before` with some whole version strings swapped as planned, and nothing else changed. */
function onlySwaps(before: string, after: string, moves: ReadonlyArray<PlannedMove>): boolean {
  const versionChar = (text: string, index: number) => /[\w.+-]/.test(text[index] ?? "");
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    const swap = moves.find((move) => before.startsWith(move.from, i) && after.startsWith(move.to, j)
      && !versionChar(before, i - 1) && !versionChar(before, i + move.from.length) && !versionChar(after, j + move.to.length));
    if (swap !== undefined) {
      i += swap.from.length;
      j += swap.to.length;
    } else if (before[i] === after[j] && i < before.length) {
      i++;
      j++;
    } else {
      return false;
    }
  }
  return true;
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
