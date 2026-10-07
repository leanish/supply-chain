/** Per-declaration versions, including several versions of one package in one inherited configuration. */
import { gradleLocation, type GradleInventory } from "../../ci/src/gradle.ts";
import { declaredAt } from "../../remediation/src/edit-checks.ts";
import type { PlannedMove } from "./plan.ts";

export function gradleDeclarationProblems(moves: ReadonlyArray<PlannedMove>, base: GradleInventory | undefined, head: GradleInventory | undefined): string[] {
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
