import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type Floor, FLOORS_PATH, parseFloors } from "../../ci/src/floors.ts";
import { runCompare, type GateEnvironment } from "../../ci/src/gate.ts";
import type { GradleInventory } from "../../ci/src/gradle.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { withoutFloorRecords, withoutOverrides } from "../src/floor-removal.ts";
import type { ChangePlan } from "../src/plan.ts";
import { verifyPlan, type VerifyInputs } from "../src/verify.ts";

vi.mock("../../ci/src/gate.ts", async (load) => ({ ...await load<typeof import("../../ci/src/gate.ts")>(), runCompare: vi.fn() }));
beforeEach(() => {
  vi.mocked(runCompare).mockReset();
  vi.mocked(runCompare).mockResolvedValue({ failures: [], headFindings: [], warnings: [], notes: [], gaps: [], osvScannerVersion: "2.6.0", configText: undefined, cooldown: { evaluated: true, releaseAgeDays: 7, held: [] } });
});
const ID = "CVE-2026-12345";
const raw = (name: string, ecosystem = "npm", purpose = "security") => ({ ecosystem, package: name, version: ecosystem === "npm" ? "2.0.0" : "2.0", declaredIn: ecosystem === "npm" ? "package.json" : "build.gradle.kts",
  selector: ecosystem === "npm" ? [name] : [":runtimeClasspath"], purpose, advisories: purpose === "security" ? [ID] : [], reason: "needed", added: "2026-10-01" });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const tree = (id: string, data: Record<string, string>): Tree => ({ id, read: async (path) => data[path], list: async () => [] });
const env: GateEnvironment = { run: async () => { throw new Error("no process expected"); }, fetch: async () => { throw new Error("no network expected"); }, now: () => new Date(), osvScanner: "osv", githubToken: undefined };

function fixture() {
  const records = JSON.stringify({ floors: [raw("lib"), raw("compat", "npm", "compatibility")] });
  const floors = parseFloors(JSON.parse(records));
  const manifest = JSON.stringify({ dependencies: { parent: "^1.0.0" }, overrides: { lib: "2.0.0", compat: "1.0.0" } });
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { parent: "^1.0.0" } }, "node_modules/parent": { version: "1.1.0" }, "node_modules/lib": { version: "2.0.0" }, "node_modules/compat": { version: "1.0.0" } } });
  const was = { [FLOORS_PATH]: records, "package.json": manifest, "package-lock.json": lock };
  const now = { ...was, [FLOORS_PATH]: withoutFloorRecords(records, [floors[0]!]), "package.json": withoutOverrides(manifest, [floors[0]!]) };
  const plan: ChangePlan = { kind: "floor-removal", topic: "floor-removal", moves: [], packages: ["npm|lib"], malware: false, severity: undefined,
    floorRemoval: { floors: [floors[0]!], files: Object.entries(now).map(([path, text]) => ({ path, sha256: hash(text) })), notes: [] } };
  const input: VerifyInputs = { plan, base: tree("base", was), head: tree("head", now), env, gradle: {}, changedFiles: [FLOORS_PATH, "package.json", "package-lock.json"] };
  return { input, was, now, floors };
}

function gradle(declared: ReadonlyArray<{ group: string; name: string; version: string; reason: string | undefined }>): GradleInventory {
  return { schemaVersion: 1, tree: "fixture", builds: [{ build: ".", configurations: [{ id: ":runtimeClasspath", kind: "project", declared,
    resolved: [{ group: "g", name: "lib", version: "2.1" }], error: undefined, unresolved: [] }] }] };
}

describe("floor-removal verification", () => {
  it("allows exactly the planned security record and override to disappear, leaving compatibility intact", async () => {
    const { input } = fixture();
    expect(await verifyPlan(input)).toEqual([]);
    expect(runCompare).toHaveBeenCalledOnce();
    expect(await verifyPlan({ ...input, plan: { ...input.plan, kind: "routine", floorRemoval: undefined } })).toContainEqual(expect.stringContaining("was removed"));
  });
  it("rejects incomplete removal, extra records and compatibility changes before compare", async () => {
    const { input, was, now } = fixture();
    for (const data of [{ ...now, [FLOORS_PATH]: was[FLOORS_PATH] }, { ...now, [FLOORS_PATH]: '{"floors":[]}' },
      { ...now, "package.json": was["package.json"] }, { ...now, "package.json": JSON.stringify({ overrides: { compat: "9.0.0" } }) }]) {
      expect(await verifyPlan({ ...input, head: tree("bad", data) })).not.toEqual([]);
    }
    expect(runCompare).not.toHaveBeenCalled();
  });
  it("requires exact computed npm bytes and forbids unrelated files, direct changes, and extra override edits", async () => {
    const { input, now } = fixture();
    const changed = { ...now, "package-lock.json": now["package-lock.json"].replace('"1.1.0"', '"1.2.0"') };
    expect(await verifyPlan({ ...input, head: tree("bad", changed) })).toContainEqual(expect.stringContaining("joint unlocked resolution"));
    const rehashed = { ...input.plan, floorRemoval: { ...input.plan.floorRemoval!, files: Object.entries(changed).map(([path, text]) => ({ path, sha256: hash(text) })) } };
    expect(await verifyPlan({ ...input, plan: rehashed, head: tree("bad", changed) })).toContainEqual(expect.stringContaining("outside the plan"));
    expect(await verifyPlan({ ...input, changedFiles: [...input.changedFiles, "src/extra.ts"] })).toContain("floor-removal may not change src/extra.ts");
    expect(await verifyPlan({ ...input, changedFiles: [...input.changedFiles, ".github/supply-chain.json"] })).toContainEqual(expect.stringContaining("gate's own policy"));
    const extra = { ...now, "package.json": now["package.json"].replace('"^1.0.0"', '"^9.0.0"') };
    expect(await verifyPlan({ ...input, head: tree("bad", extra) })).toContainEqual(expect.stringContaining("more than the planned override"));
    expect(runCompare).not.toHaveBeenCalled();
  });
  it("checks recorded advisory aliases even if compare calls them inherited, and forwards all compare failures", async () => {
    const { input } = fixture();
    vi.mocked(runCompare).mockResolvedValue({ failures: ["identity changed"], headFindings: [{ ecosystem: "npm", name: "lib", version: "1.0.0", advisory: "GHSA-rq7h-c2jc-7f22", ids: [ID], malicious: false, locations: ["node_modules/lib"], summary: undefined, severity: undefined }], warnings: [], notes: [], gaps: [], osvScannerVersion: "2.6.0", configText: undefined, cooldown: { evaluated: true, releaseAgeDays: 7, held: [] } });
    expect(await verifyPlan(input)).toEqual(["compare: identity changed", "lib@1.0.0 still has GHSA-rq7h-c2jc-7f22"]);
  });
  it("removes multiple Gradle floors jointly and preserves every other declaration", async () => {
    const records = JSON.stringify({ floors: [raw("g:lib", "Maven"), raw("g:other", "Maven"), raw("g:compat", "Maven", "compatibility")] });
    const floors = parseFloors(JSON.parse(records));
    const removed = floors.slice(0, 2);
    const before = [{ group: "g", name: "lib", version: "2.0", reason: ID }, { group: "g", name: "other", version: "2.0", reason: ID }, { group: "g", name: "compat", version: "2.0", reason: "runtime" }, { group: "g", name: "parent", version: "3.0", reason: undefined }];
    const after = before.slice(2);
    const text = withoutFloorRecords(records, removed);
    const plan: ChangePlan = { kind: "floor-removal", topic: "floor-removal", malware: false, severity: undefined, packages: ["Maven|g:lib", "Maven|g:other"], moves: [], floorRemoval: { floors: removed, files: [{ path: FLOORS_PATH, sha256: hash(text) }], notes: [] } };
    const input: VerifyInputs = { plan, base: tree("base", { [FLOORS_PATH]: records, "build.gradle.kts": "before" }), head: tree("head", { [FLOORS_PATH]: text, "build.gradle.kts": "after" }), env,
      gradle: { base: gradle(before), head: gradle(after) }, changedFiles: [FLOORS_PATH, "build.gradle.kts"] };
    expect(await verifyPlan(input)).toEqual([]);
    expect(await verifyPlan({ ...input, gradle: { ...input.gradle, head: gradle([...after, before[0]!]) } })).toContainEqual(expect.stringContaining("exactly the planned"));
    expect(await verifyPlan({ ...input, gradle: { ...input.gradle, head: gradle(after.map((entry) => ({ ...entry, version: "9.0" }))) } })).toContainEqual(expect.stringContaining("compatibility floor"));
    expect(await verifyPlan({ ...input, gradle: { ...input.gradle, head: gradle([after[0]!]) } })).toContainEqual(expect.stringContaining("exactly the planned"));
  });
  it("rejects a fabricated removal record, even when its file hashes match", async () => {
    const { input } = fixture();
    const unknown: Floor = { ...input.plan.floorRemoval!.floors[0]!, version: "9.0.0" };
    expect(await verifyPlan({ ...input, plan: { ...input.plan, floorRemoval: { ...input.plan.floorRemoval!, floors: [unknown] } } })).toContainEqual(expect.stringContaining("base security floor exactly"));
  });
});
