/** A removal changes only its exact records/declarations and the tool's jointly resolved npm bytes. */
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { FLOORS_PATH } from "../../ci/src/floors.ts";
import { runCompare } from "../../ci/src/gate.ts";
import { gradleLocation, type GradleInventory } from "../../ci/src/gradle.ts";
import { actionsOutsidePlan, directChangesOutside, directVersions } from "../../remediation/src/edit-checks.ts";

import { floorFindings, validRemoval, withoutFloorRecords, withoutOverrides } from "./floor-removal.ts";
import type { VerifyInputs } from "./verify.ts";

export async function verifyRemovalEdit(inputs: VerifyInputs): Promise<string[]> {
  const { plan, base, head, gradle } = inputs;
  const removal = plan.floorRemoval;
  if (!validRemoval(removal) || plan.moves.length > 0 || plan.malware) return ["invalid floor-removal plan"];
  const problems: string[] = [];
  const record = await base.read(FLOORS_PATH);
  if (record === undefined || await head.read(FLOORS_PATH) !== withoutFloorRecords(record, removal.floors)) {
    problems.push("floor-removal must remove exactly the planned records, preserving all others");
  }
  for (const file of removal.files) {
    const text = await head.read(file.path);
    if (text === undefined || createHash("sha256").update(text).digest("hex") !== file.sha256) {
      problems.push(`${file.path} differs from the joint unlocked resolution's planned bytes`);
    }
  }
  const allowed = new Set([FLOORS_PATH, ...removal.files.map((file) => file.path), ...removal.floors.filter((floor) => floor.ecosystem === "Maven").map((floor) => floor.declaredIn)]);
  for (const path of inputs.changedFiles.filter((path) => !allowed.has(path))) problems.push(`floor-removal may not change ${path}`);
  for (const file of removal.files) {
    if (basename(file.path) !== "package.json") continue;
    const before = await base.read(file.path);
    const floors = removal.floors.filter((floor) => floor.ecosystem === "npm" && floor.declaredIn === file.path);
    if (before === undefined || floors.length === 0 || await head.read(file.path) !== withoutOverrides(before, floors)) {
      problems.push(`${file.path}: floor removal changed more than the planned override versions`);
    }
  }
  problems.push(...await actionsOutsidePlan([], base, head));
  // Removing Gradle floors cannot alter any unrelated declaration (including reasons or inherited declarations).
  const selected = new Map<string, Set<string>>();
  for (const floor of removal.floors.filter((floor) => floor.ecosystem === "Maven")) {
    for (const location of floor.locations) selected.set(location, new Set([...(selected.get(location) ?? []), floor.package]));
  }
  if (!isDeepStrictEqual(otherDeclarations(gradle.base, selected), otherDeclarations(gradle.head, selected))) {
    problems.push("floor-removal changed unrelated Gradle declarations or configurations");
  }
  const before = await directVersions(base, gradle.base);
  const after = await directVersions(head, gradle.head);
  problems.push(...directChangesOutside(before, after, (ecosystem, name, location) => ecosystem === "Maven" &&
    removal.floors.some((floor) => floor.ecosystem === "Maven" && floor.package === name && floor.locations.includes(location))));
  if (problems.length > 0) return problems;
  const compared = await runCompare(base, head, inputs.env, gradle);
  return [...compared.failures.map((failure) => `compare: ${failure}`), ...removal.floors.flatMap((floor) =>
    floorFindings(floor, compared.headFindings).map((finding) => `${floor.package}@${finding.version} still has ${finding.advisory}`))];
}

function otherDeclarations(inventory: GradleInventory | undefined, selected: ReadonlyMap<string, Set<string>>): string[] {
  return (inventory?.builds ?? []).flatMap((build) => build.configurations.map((config) => {
    const location = gradleLocation(build.build, config.id);
    const removed = selected.get(location);
    const declarations = config.declared.filter((entry) => !removed?.has(`${entry.group}:${entry.name}`)).map((entry) => JSON.stringify(entry)).sort();
    return JSON.stringify([location, config.kind, declarations]);
  })).sort();
}
