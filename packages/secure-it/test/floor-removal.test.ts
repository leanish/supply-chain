import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { Finding } from "../../ci/src/findings.ts";
import { type Floor, FLOORS_PATH, parseFloors } from "../../ci/src/floors.ts";
import { planBlock } from "../../remediation/src/plan-blocks.ts";
import { floorIdentity, selectRemovals, validRemoval, withoutFloorRecords, withoutOverrides } from "../src/floor-removal.ts";
import { planDigest, planOf, planSection } from "../src/plan-block.ts";

const ID = "CVE-2026-12345";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const floor = (name: string, purpose = "security"): Floor => parseFloors({ floors: [{ ecosystem: "npm", package: name, version: "2.0.0", declaredIn: "package.json",
  selector: [name], purpose, advisories: purpose === "security" ? [ID] : [], reason: "needed", added: "2026-10-01" }] })[0]!;
const findings = (name: string): Finding[] => [{ ecosystem: "npm", name, version: "1.0.0", advisory: "GHSA-rq7h-c2jc-7f22", ids: [ID, "GHSA-rq7h-c2jc-7f22"],
  malicious: false, summary: undefined, severity: undefined, locations: ["node_modules/lib"] }];
const files = new Map([[FLOORS_PATH, '{"floors":[]}'], ["package.json", "{}"], ["package-lock.json", "joint unlocked bytes"]]);

describe("joint unlocked floor selection", () => {
  it("qualifies security floors alone, then proves the entire set in one resolution; compatibility is never probed", async () => {
    const calls: string[][] = [];
    const result = await selectRemovals([floor("b"), floor("a"), floor("compat", "compatibility")], async (removed) => {
      calls.push(removed.map((floor) => floor.package));
      return { files, findings: [], problems: [] };
    }, hash);
    expect(calls).toEqual([["a"], ["b"], ["a", "b"]]);
    expect(result.plan).toMatchObject({ kind: "floor-removal", topic: "floor-removal", moves: [], packages: ["npm|a", "npm|b"] });
    expect(result.files).toBe(files);
    expect(result.plan?.floorRemoval?.files).toContainEqual({ path: "package-lock.json", sha256: hash("joint unlocked bytes") });
    expect(planOf(planSection(result.plan!))).toEqual(result.plan);
    expect(planSection(result.plan!)).not.toContain("joint unlocked bytes");
    expect(planDigest({ ...result.plan!, floorRemoval: { ...result.plan!.floorRemoval!, notes: ["different report"] } })).toBe(planDigest(result.plan!));
  });
  it("does not trust individually safe floors when their joint resolution regresses, and shrinks one at a time", async () => {
    const calls: string[][] = [];
    const result = await selectRemovals([floor("a"), floor("b"), floor("c")], async (removed) => {
      calls.push(removed.map((floor) => floor.package));
      return { files, findings: removed.length > 1 ? findings(removed[0]!.package) : [], problems: [] };
    }, hash);
    expect(calls).toEqual([["a"], ["b"], ["c"], ["a", "b", "c"], ["b", "c"], ["c"]]);
    expect(result.plan?.floorRemoval?.floors.map((floor) => floor.package)).toEqual(["c"]);
    expect(result.notes).toEqual([expect.stringContaining("a in package.json: floor retained"), expect.stringContaining("b in package.json: floor retained")]);
    expect(planSection(result.plan!)).toContain("floor retained");
  });
  it("reports vulnerable parents, incomplete proofs and exceptions without guessing a removal", async () => {
    const result = await selectRemovals([floor("affected"), floor("incomplete"), floor("failed")], async (removed) => {
      const name = removed[0]!.package;
      if (name === "failed") throw new Error("registry unavailable");
      return { files, findings: name === "affected" ? findings(name) : [], problems: name === "incomplete" ? ["missing advisory coverage"] : [] };
    }, hash);
    expect(result.plan).toBeUndefined();
    expect(result.files.size).toBe(0);
    expect(result.notes).toEqual(expect.arrayContaining([expect.stringContaining("still has GHSA"), expect.stringContaining("registry unavailable"), expect.stringContaining("missing advisory coverage")]));
  });
  it("shrinks after a joint resolver failure and uses only a successful final resolution's bytes", async () => {
    const result = await selectRemovals([floor("a"), floor("b")], async (removed) => {
      if (removed.length === 2) throw new Error("joint conflict");
      return { files, findings: [], problems: [] };
    }, hash);
    expect(result.plan?.floorRemoval?.floors.map((floor) => floor.package)).toEqual(["a"]);
    expect(result.notes).toEqual([expect.stringContaining("b in package.json: floor retained (joint conflict)")]);
  });
});

describe("exact floor edits and persisted plans", () => {
  it("removes only selected security records and preserves compatibility metadata and JSON formatting", () => {
    const raw = { floors: [{ ecosystem: "npm", package: "lib", version: "2.0.0", declaredIn: "package.json", selector: ["lib"], purpose: "security", advisories: [ID], reason: "security", added: "2026-10-01" },
      { ecosystem: "npm", package: "compat", version: "1.0.0", declaredIn: "package.json", selector: ["compat"], purpose: "compatibility", advisories: [], reason: "runtime", added: "2026-10-01" }] };
    const text = JSON.stringify(raw, null, "\t").replaceAll("\n", "\r\n");
    const parsed = parseFloors(raw);
    const changed = withoutFloorRecords(text, [parsed[0]!]);
    expect(JSON.parse(changed)).toEqual({ floors: [raw.floors[1]] });
    expect(changed).toContain("\r\n\t");
    expect(changed.endsWith("\n")).toBe(false);
    expect(() => withoutFloorRecords(text, [parsed[1]!])).toThrow("existing security floor exactly");
    expect(() => withoutFloorRecords(text, [{ ...parsed[0]!, version: "9.0.0" }])).toThrow("exactly");
  });
  it("removes nested override versions without deleting unplanned nested or compatibility overrides", () => {
    const selected = { ...floor("parent"), overridePaths: [["parent"]] };
    const manifest = { scripts: { test: "vitest" }, dependencies: { root: "^1" }, overrides: { parent: { ".": "2.0.0", child: "3.0.0" }, compat: "1.0.0" } };
    const text = JSON.stringify(manifest, null, 4) + "\n";
    expect(JSON.parse(withoutOverrides(text, [selected]))).toEqual({ ...manifest, overrides: { parent: { child: "3.0.0" }, compat: "1.0.0" } });
    expect(withoutOverrides(text, [selected])).toContain('\n    "scripts"');
    const nested = { ...floor("child"), overridePaths: [["parent", "child"]] };
    expect(JSON.parse(withoutOverrides(text, [selected, nested])).overrides).toEqual({ compat: "1.0.0" });
    expect(() => withoutOverrides(text, [floor("missing")])).toThrow("missing override");
  });
  it("rejects compatibility removals, unsafe paths, duplicate selectors and incomplete persisted hashes", async () => {
    const result = await selectRemovals([floor("a")], async () => ({ files, findings: [], problems: [] }), hash);
    const removal = result.plan!.floorRemoval!;
    expect(validRemoval(removal)).toBe(true);
    for (const changed of [
      { ...removal, floors: [floor("compat", "compatibility")] }, { ...removal, floors: [...removal.floors, ...removal.floors] },
      { ...removal, floors: removal.floors.map((floor) => ({ ...floor, declaredIn: "../package.json" })) },
      { ...removal, files: [{ path: "../secret", sha256: hash("x") }] }, { ...removal, files: [{ path: "src/arbitrary.ts", sha256: hash("x") }] },
      { ...removal, files: removal.files.map((file) => ({ ...file, sha256: "bad" })) },
    ]) {
      expect(planOf(planBlock({ ...result.plan, floorRemoval: changed }))).toBeUndefined();
    }
    expect(floorIdentity(floor("a"))).toBe(floorIdentity({ ...floor("a"), advisories: [...floor("a").advisories].reverse() }));
  });
});
