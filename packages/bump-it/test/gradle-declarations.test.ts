import { describe, expect, it } from "vitest";
import type { GradleInventory } from "../../ci/src/gradle.ts";
import { gradleDeclarationProblems } from "../src/gradle-declarations.ts";
import { routineUnit } from "../src/units.ts";
import { candidate } from "./fixtures.ts";
const inventory = (versions: string[]): GradleInventory => ({ tree: "tree", schemaVersion: 1, builds: [{ build: ".", configurations: [{ id: ":runtimeClasspath", kind: "project", declared: versions.map((version) => ({ group: "g", name: "lib", version, reason: undefined })), resolved: [], unresolved: [], error: undefined }] }] });
describe("multiple Gradle declarations", () => {
  it("moves each planned source separately and leaves every other declaration unchanged", () => {
    const moves = routineUnit([candidate({ ecosystem: "Maven", name: "g:lib", locations: [":runtimeClasspath"], from: "1.0.0", minor: { version: "1.1.0", line: "1" }, declarations: [] }), candidate({ ecosystem: "Maven", name: "g:lib", locations: [":runtimeClasspath"], from: "2.0.0", minor: { version: "2.1.0", line: "2" }, declarations: [] })]).moves;
    expect(gradleDeclarationProblems(moves, inventory(["1.0.0", "2.0.0", "3.0.0"]), inventory(["1.1.0", "2.1.0", "3.0.0"]))).toEqual([]);
    expect(gradleDeclarationProblems(moves, inventory(["1.0.0", "2.0.0", "3.0.0"]), inventory(["1.1.0", "2.1.0", "3.1.0"]))).toContainEqual(expect.stringContaining("outside the plan"));
  });
  it("catches an unplanned duplicate declaration changing even when the last version is unchanged", () => {
    expect(gradleDeclarationProblems([], inventory(["1.0.0", "2.0.0"]), inventory(["1.1.0", "2.0.0"]))).toContainEqual(expect.stringContaining("outside the plan"));
  });
});
