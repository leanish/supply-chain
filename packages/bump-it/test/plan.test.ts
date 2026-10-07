import { describe, expect, it } from "vitest";
import { planBlock } from "../../remediation/src/plan-blocks.ts";
import { planDigest, planFor, planOf, planSection, withPlanSection } from "../src/plan.ts";
import { majorUnits, routineUnit } from "../src/units.ts";

import { candidate } from "./fixtures.ts";

const npm = { files: new Map([["package-lock.json", "lock bytes"], ["package.json", '{"dependencies":{"lib":"^1.1.0"}}']]), changes: [], notes: [] };
describe("units and persisted plan", () => {
  it("groups routine moves and each major's declarations together, prioritising reach", () => {
    const bumps = [candidate(), candidate({ name: "other", locations: ["a", "b"] }), candidate({ from: "0.1.0", locations: ["ws"], minor: undefined })];
    expect(routineUnit(bumps).moves.map((move) => move.name)).toEqual(["lib", "other"]);
    expect(majorUnits(bumps).map((unit) => [unit.package, unit.moves.length])).toEqual([["npm|lib", 2], ["npm|other", 1]]);
  });
  it("round trips without file contents; hashes include transitive-only changes, not report notes", async () => {
    const plan = await planFor(routineUnit([candidate()]), npm, async () => undefined);
    expect(planOf(planSection(plan))).toEqual(plan);
    expect(planSection(plan)).not.toContain("lock bytes");
    expect(planDigest({ ...plan, notes: ["report"] })).toBe(planDigest(plan));
    expect(planDigest(await planFor(routineUnit([candidate()]), { ...npm, files: new Map([["package-lock.json", "changed bytes"]]) }, async () => undefined))).not.toBe(planDigest(plan));
    expect(planDigest({ ...plan, moves: [...plan.moves].reverse(), npmFiles: [...plan.npmFiles].reverse() })).toBe(planDigest(plan));
  });
  it("caps both the visible and hidden change list with the remaining count", async () => {
    const changes = Array.from({ length: 1000 }, (_, n) => ({ lockfile: "package-lock.json", name: `lib${n}`, path: `node_modules/lib${n}`, from: "1.0.0", to: "1.1.0" }));
    const plan = await planFor(routineUnit([]), { ...npm, changes }, async () => undefined);
    expect(plan.changes).toHaveLength(30);
    expect(planSection(plan)).toContain("and 970 more");
    expect(planSection(plan).length).toBeLessThan(20000);
  });
  it("replaces the previous section once while keeping the surrounding PR body", async () => {
    const plan = await planFor(routineUnit([candidate()]), npm, async () => undefined);
    const updated = withPlanSection(`before\n${planSection(plan)}\nafter`, { ...plan, notes: ["new note"] });
    expect(updated).toContain("before"); expect(updated).toContain("after");
    expect(updated.match(/leanish:plan/g)).toHaveLength(1);
    expect(planOf(updated)?.notes).toEqual(["new note"]);
  });
  it("rejects malformed blocks and unsafe file paths", async () => {
    const plan = await planFor(routineUnit([candidate()]), npm, async () => undefined);
    expect(planOf(planBlock({ ...plan, npmFiles: [{ path: "../secret", sha256: "a".repeat(64) }] }))).toBeUndefined();
    expect(planOf(planBlock({ ...plan, moves: [{ name: "lib" }] }))).toBeUndefined();
    expect(planOf("<!-- leanish:plan Zm9v -->")).toBeUndefined();
  });
  it("resolves and persists action tag commits, failing closed when absent", async () => {
    const unit = routineUnit([candidate({ ecosystem: "GitHub Actions", name: "actions/checkout", declarations: [], locations: [".github/workflows/ci.yml"] })]);
    expect((await planFor(unit, { ...npm, files: new Map() }, async () => "a".repeat(40))).moves[0]?.commitSha).toBe("a".repeat(40));
    await expect(planFor(unit, npm, async () => undefined)).rejects.toThrow("no commit");
  });
});
