import { describe, expect, it } from "vitest";
import type { Tree } from "../../ci/src/tree.ts";
import { constrainedUnit } from "../src/constraints.ts";
import { routineUnit } from "../src/units.ts";
import { candidate } from "./fixtures.ts";
const tree = (manifest: unknown): Tree => ({ id: "base", read: async () => JSON.stringify(manifest), list: async () => [] });
describe("override bounds on direct declarations", () => {
  it("holds a pinned direct at base and keeps unrelated routine moves", async () => {
    const result = await constrainedUnit(routineUnit([candidate(), candidate({ name: "other", declarations: [{ lockfile: "package-lock.json", workspace: ".", declaredAs: "other", spec: "^1" }] })]), tree({ overrides: { lib: "1.0.0" } }));
    expect(result.unit.moves.map((move) => move.name)).toEqual(["other"]);
    expect(result.notes).toMatchObject([expect.stringContaining("lib stays at base")]);
  });
  it("uses the installed alias key for an alias override and preserves a contextual parent move", async () => {
    const alias = candidate({ declarations: [{ lockfile: "package-lock.json", workspace: ".", declaredAs: "compat", spec: "npm:lib@^1" }] });
    expect((await constrainedUnit(routineUnit([alias]), tree({ overrides: { compat: "npm:lib@1.0.0" } }))).unit.moves).toEqual([]);
    expect((await constrainedUnit(routineUnit([candidate()]), tree({ overrides: { lib: { child: "1.0.0" } } }))).unit.moves).toHaveLength(1);
  });
});
