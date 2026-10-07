import { describe, expect, it } from "vitest";
import { planBlock } from "../../remediation/src/plan-blocks.ts";
import { planDigest, planFor, planOf, planSection, withPlanSection } from "../src/plan.ts";
import { WRAPPER_FILES, WRAPPER_PROPERTIES } from "../src/gradle-wrapper.ts";
import { majorUnits, routineUnit } from "../src/units.ts";

import { candidate } from "./fixtures.ts";

const npm = { files: new Map([["package-lock.json", "lock bytes"], ["package.json", '{"dependencies":{"lib":"^1.1.0"}}']]), changes: [], notes: [] };
describe("units and persisted plan", () => {
  it("groups routine moves and each major's declarations together, prioritising reach", () => {
    const bumps = [candidate(), candidate({ name: "other", locations: ["a", "b"] }), candidate({ from: "0.1.0", locations: ["ws"], minor: undefined })];
    expect(routineUnit(bumps).moves.map((move) => move.name)).toEqual(["lib", "other"]);
    expect(majorUnits(bumps).map((unit) => [unit.package, unit.moves.length])).toEqual([["npm|lib", 2], ["npm|other", 1]]);
  });
  it("persists wrapper targets and includes official hashes in identity, rejecting incomplete or unsafe wrapper blocks", async () => {
    const move = { ecosystem: "Gradle Wrapper" as const, name: "gradle/gradle", from: "8.0", to: "8.1", mechanism: "gradle-wrapper" as const,
      major: false, locations: [WRAPPER_PROPERTIES], declarations: [],
      wrapper: { distributionUrl: "https://services.gradle.org/distributions/gradle-8.1-bin.zip", distributionSha256: "a".repeat(64), jarSha256: "b".repeat(64) } };
    const plan = await planFor(routineUnit([], { routine: move }), { ...npm, files: new Map() }, async () => undefined);
    expect(planOf(planSection(plan))).toEqual(plan);
    expect(planDigest({ ...plan, moves: [{ ...move, wrapper: { ...move.wrapper, jarSha256: "c".repeat(64) } }] })).not.toBe(planDigest(plan));
    for (const changed of [{ ...move, wrapper: undefined }, { ...move, locations: ["other.properties"] },
      { ...move, wrapper: { ...move.wrapper, distributionUrl: "https://evil.invalid/gradle.zip" } }]) {
      expect(planOf(planBlock({ ...plan, moves: [changed] }))).toBeUndefined();
    }
  });
  it("records generated wrapper hashes and modes in identity, rejecting incomplete or duplicate artifact lists", async () => {
    const planned = await planFor(routineUnit([]), npm, async () => undefined);
    const wrapperFiles = WRAPPER_FILES.map((path) => ({ path, sha256: "a".repeat(64), executable: path === "gradlew" }));
    const plan = { ...planned, wrapperFiles };
    expect(planOf(planSection(plan))).toEqual(plan);
    expect(planDigest({ ...plan, wrapperFiles: [...wrapperFiles].reverse() })).toBe(planDigest(plan));
    expect(planDigest({ ...plan, wrapperFiles: wrapperFiles.map((file) => ({ ...file, sha256: "b".repeat(64) })) })).not.toBe(planDigest(plan));
    expect(planDigest({ ...plan, wrapperFiles: wrapperFiles.map((file) => ({ ...file, executable: !file.executable })) })).not.toBe(planDigest(plan));
    for (const files of [wrapperFiles.slice(1), [...wrapperFiles.slice(1), wrapperFiles[1]],
      wrapperFiles.map((file) => ({ ...file, path: "../escape" })), wrapperFiles.map((file) => ({ ...file, sha256: "bad" }))]) {
      expect(planOf(planBlock({ ...plan, wrapperFiles: files }))).toBeUndefined();
    }
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
  it.each(["kind", "ecosystem"])("rejects an array coerced into the %s enum", async (field) => {
    const plan = await planFor(routineUnit([candidate()]), npm, async () => undefined);
    const malformed = field === "kind"
      ? { ...plan, kind: [plan.kind] }
      : { ...plan, moves: plan.moves.map((move) => ({ ...move, ecosystem: [move.ecosystem] })) };
    expect(planOf(planBlock(malformed))).toBeUndefined();
  });
  it("resolves and persists action tag commits, failing closed when absent", async () => {
    const unit = routineUnit([candidate({ ecosystem: "GitHub Actions", name: "actions/checkout", declarations: [], locations: [".github/workflows/ci.yml"] })]);
    expect((await planFor(unit, { ...npm, files: new Map() }, async () => "a".repeat(40))).moves[0]?.commitSha).toBe("a".repeat(40));
    await expect(planFor(unit, npm, async () => undefined)).rejects.toThrow("no commit");
  });
});
