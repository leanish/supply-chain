/** Protect computed npm locks and dependency fields after an agent's edits. */
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { FLOORS_PATH } from "../../ci/src/floors.ts";
import type { Tree } from "../../ci/src/tree.ts";

export const NPM_DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies", "peerDependenciesMeta", "overrides", "workspaces"] as const;

export async function computedNpmProblems(files: ReadonlyMap<string, string> | undefined, head: Tree, major: boolean, base?: Tree, changedFiles: ReadonlyArray<string> = []): Promise<string[]> {
  const problems: string[] = [];
  if (files === undefined) return problems;
  const paths = new Set([...files.keys(), ...changedFiles.filter((path) => ["package.json", "package-lock.json", "npm-shrinkwrap.json"].includes(basename(path)))]);
  for (const path of paths) {
    const expected = files.get(path) ?? await base?.read(path);
    const actual = await head.read(path);
    if (actual === expected) continue;
    // A mixed batch may add Gradle floors to this shared record; npm floor records are tool-owned.
    if (path === FLOORS_PATH && actual !== undefined && expected !== undefined) {
      try {
        const npmFloors = (text: string) => (JSON.parse(text).floors as Array<{ ecosystem: string }>).filter((floor) => floor.ecosystem === "npm");
        if (isDeepStrictEqual(npmFloors(actual), npmFloors(expected))) continue;
      } catch {
        // Unreadable records fail below, before compare reads them.
      }
    }
    if (major && basename(path) === "package.json" && actual !== undefined && expected !== undefined) {
      try {
        const before = JSON.parse(expected) as Record<string, unknown>;
        const after = JSON.parse(actual) as Record<string, unknown>;
        if (NPM_DEPENDENCY_FIELDS.every((field) => isDeepStrictEqual(before[field], after[field]))) continue;
      } catch {
        // An unreadable manifest is a changed, unverified file.
      }
    }
    problems.push(`${path} differs from secure-it's computed npm plan`);
  }
  return problems;
}
