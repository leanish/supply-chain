import { describe, expect, it } from "vitest";

import type { GradleInventory } from "../../ci/src/gradle.ts";
import { referenceDifferences, referenceProblems, referenceTransform } from "../src/gradle-reference.ts";

const inventory = (versions: ReadonlyArray<string | undefined>, resolved = "1.0.0", extra: Partial<GradleInventory["builds"][number]["configurations"][number]> = {}): GradleInventory => ({ tree: "tree", schemaVersion: 1, builds: [{ build: ".", configurations: [{
  id: ":runtimeClasspath", kind: "project", declared: versions.map((version) => ({ group: "g", name: "lib", version, reason: undefined })),
  resolved: [{ group: "g", name: "lib", version: resolved }], unresolved: [], error: undefined, ...extra,
}] }] });
const move = (from: string, to: string) => ({ name: "g:lib", from, to, locations: [":runtimeClasspath"] });

describe("the plan's Gradle reference", () => {
  it("hands the reference script the plan, for the build it runs on", () => {
    const transform = referenceTransform([move("1.0.0", "1.1.0")], []);
    expect(transform.initScript).toMatch(/supply-chain-reference\.init\.gradle$/);
    expect(transform.property).toBe("supplyChain.reference.file");
    expect(transform.content("/tmp/repo")).toEqual({ repositoryRoot: "/tmp/repo", moves: [move("1.0.0", "1.1.0")], floors: [] });
  });

  it("requires each move's sources, and only them, to have moved in the reference, versionless declarations kept", () => {
    const moves = [move("1.0.0", "1.1.0"), move("2.0.0", "2.1.0")];
    expect(referenceProblems(inventory(["1.0.0", "2.0.0", "3.0.0", undefined]), inventory(["1.1.0", "2.1.0", "3.0.0", undefined]), moves, [])).toEqual([]);
    expect(referenceProblems(inventory(["1.0.0", "2.0.0", "3.0.0"]), inventory(["1.1.0", "2.1.0", "3.1.0"]), moves, [])).toEqual([
      "the plan's reference declares g:lib 1.1.0, 2.1.0, 3.1.0 at :runtimeClasspath, not 1.1.0, 2.1.0, 3.0.0",
    ]);
    // A build that reset the move, or a versionless declaration the move took over.
    expect(referenceProblems(inventory(["1.0.0"]), inventory(["1.0.0"]), [move("1.0.0", "1.1.0")], [])).toHaveLength(1);
    expect(referenceProblems(inventory(["1.0.0", undefined]), inventory(["1.1.0", "1.1.0"]), [move("1.0.0", "1.1.0")], [])).toHaveLength(1);
    expect(referenceProblems(inventory(["2.0.0"]), inventory(["2.0.0"]), [move("1.0.0", "1.1.0")], [])).toEqual(["the plan's base has no declaration of g:lib 1.0.0 to move at :runtimeClasspath"]);
  });

  it("requires each floor added in the reference, next to what was declared", () => {
    const floor = { name: "g:lib", version: "1.2.0", reason: "GHSA-test", locations: [":runtimeClasspath"] };
    expect(referenceProblems(inventory(["1.0.0"]), inventory(["1.0.0", "1.2.0"]), [], [floor])).toEqual([]);
    expect(referenceProblems(inventory(["1.0.0"]), inventory(["1.2.0"]), [], [floor])).toHaveLength(1);
  });

  it("finds every way head differs from the reference: modules, declarations (versionless too), configurations and failures", () => {
    const reference = inventory(["1.0.0", undefined]);
    expect(referenceDifferences(reference, inventory(["1.0.0", undefined]))).toEqual([]);
    expect(referenceDifferences(reference, inventory(["1.0.0", undefined], "9.0.0"))).toEqual([":runtimeClasspath, unlike the plan's reference, also resolves g:lib:9.0.0 and no longer resolves g:lib:1.0.0"]);
    expect(referenceDifferences(reference, inventory(["1.0.0"]))).toEqual([":runtimeClasspath, unlike the plan's reference, no longer declares g:lib (no version)"]);
    expect(referenceDifferences(reference, inventory(["1.0.0", undefined, undefined]))).toEqual([":runtimeClasspath, unlike the plan's reference, also declares g:lib (no version)"]);
    expect(referenceDifferences(reference, inventory(["1.0.0", undefined], "1.0.0", { kind: "buildscript" }))).toEqual([":runtimeClasspath is a buildscript configuration in the edit, project in the plan's reference"]);
    expect(referenceDifferences(reference, inventory(["1.0.0", undefined], "1.0.0", { unresolved: [{ requested: "g:lib:2.0.0", failure: "not found" }] }))).toEqual([":runtimeClasspath doesn't resolve in the edit: g:lib:2.0.0: not found"]);
    expect(referenceDifferences(inventory(["1.0.0", undefined], "1.0.0", { error: "boom" }), reference)).toEqual([":runtimeClasspath doesn't resolve in the plan's reference: boom"]);
    const elsewhere: GradleInventory = { ...reference, builds: [{ build: "tools", configurations: reference.builds[0]!.configurations }] };
    expect(referenceDifferences(reference, elsewhere)).toEqual([
      ":runtimeClasspath is missing from the edit, unlike the plan's reference",
      "tools/:runtimeClasspath is only in the edit, unlike the plan's reference",
    ]);
    expect(referenceDifferences(undefined, undefined)).toEqual([]);
    expect(referenceDifferences(reference, undefined)).toHaveLength(1);
  });
});
