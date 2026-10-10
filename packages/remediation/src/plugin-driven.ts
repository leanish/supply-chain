/**
 * The proof both tools use to let a planned Gradle plugin update's own fallout through verification: what the plugin
 * adds to its build changes with it, though no file names it. bump-it and secure-it each pass their planned
 * declaration moves and what the edit changed.
 */
import { gradleLocation, type GradleInventory } from "../../ci/src/gradle.ts";
import type { Tree } from "../../ci/src/tree.ts";

/** A planned move of a declared Gradle dependency: `from` to `to` at Gradle configuration `locations`. */
export interface ClasspathMove {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly locations: ReadonlyArray<string>;
}

/** What a unit changed, and which of those changes other checks verify exactly. */
export interface UnitEdits {
  readonly changedFiles: ReadonlyArray<string>;
  /** Tracked paths whose file mode changed. */
  readonly modeChanged: ReadonlyArray<string>;
  /** Files whose text another check compares exactly (beyond what it plans). */
  readonly textChecked: ReadonlySet<string>;
  /** Files whose bytes and mode another check compares exactly. */
  readonly bytesChecked: ReadonlySet<string>;
}

/**
 * Whether an unplanned change of a declared dependency at a Gradle location is plugin-driven, so verification lets it
 * through: the plan moves a plugin of that build (a move on a buildscript or settings classpath), the dependency isn't
 * itself planned there, and nothing but the planned edits changed: no file mode outside `bytesChecked`, no text that
 * isn't valid UTF-8, and every other changed file outside `textChecked` exists on both sides and differs only by planned
 * version swaps (`from` to `to`, each a whole version string). The planned plugin update then made the change: a
 * version moved, or a declaration added or removed (updating the Kotlin plugin moves the stdlib it adds; a convention
 * plugin's new version adds a library). The gate still judges every version that changes. A swap is recognised by its
 * text alone, so a dependency written with a planned move's exact `from` version may move to its `to` with it, as one
 * sharing a version variable with the plugin does.
 */
export async function pluginDriven(base: Tree, head: Tree, inventories: { readonly base: GradleInventory | undefined; readonly head: GradleInventory | undefined }, moves: ReadonlyArray<ClasspathMove>, edits: UnitEdits): Promise<(name: string, location: string) => boolean> {
  const buildOf = new Map<string, string>();
  const classpath = new Set<string>();
  for (const build of [inventories.base, inventories.head].flatMap((inventory) => inventory?.builds ?? [])) {
    for (const configuration of build.configurations) {
      const location = gradleLocation(build.build, configuration.id);
      buildOf.set(location, build.build);
      if (configuration.kind === "buildscript" || configuration.kind === "settings") classpath.add(location);
    }
  }
  const pluginBuilds = new Set(moves.flatMap((move) => move.locations.filter((location) => classpath.has(location)).map((location) => buildOf.get(location)!)));
  if (pluginBuilds.size === 0 || edits.modeChanged.some((path) => !edits.bytesChecked.has(path))) return () => false;
  for (const path of edits.changedFiles.filter((file) => !edits.bytesChecked.has(file))) {
    const [before, after] = [await base.read(path), await head.read(path)];
    // Text that isn't valid UTF-8 can't show its bytes: different bytes may read the same, here or in a text check elsewhere.
    if (before !== undefined && lossy(before) || after !== undefined && lossy(after)) return () => false;
    if (edits.textChecked.has(path)) continue;
    // An added or deleted file is an edit, however empty.
    if (before === undefined || after === undefined || !onlySwaps(before, after, moves)) return () => false;
  }
  return (name, location) => {
    const build = buildOf.get(location);
    if (build === undefined || !pluginBuilds.has(build)) return false;
    return !moves.some((move) => move.name === name && move.locations.includes(location));
  };
}

/** Whether decoding replaced invalid bytes, so different bytes may read as the same text. */
function lossy(text: string): boolean {
  return text.includes("\uFFFD");
}

/** Whether `after` is `before` with some whole version strings swapped as planned, and nothing else changed. */
function onlySwaps(before: string, after: string, moves: ReadonlyArray<ClasspathMove>): boolean {
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

