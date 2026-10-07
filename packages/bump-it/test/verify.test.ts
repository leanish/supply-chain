import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCompare, type GateEnvironment } from "../../ci/src/gate.ts";
import type { GradleInventory } from "../../ci/src/gradle.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { type BumpPlan, planFor } from "../src/plan.ts";
import { routineUnit, majorUnits } from "../src/units.ts";
import { plannedFiles, verifyPlan, type VerifyInputs } from "../src/verify.ts";
import { candidate } from "./fixtures.ts";

vi.mock("../../ci/src/gate.ts", async (original) => ({ ...await original<object>(), runCompare: vi.fn(async () => ({ failures: [], warnings: [], notes: [], gaps: [], osvScannerVersion: "2.6.0", configText: undefined })) }));
const tree = (id: string, files: Record<string, string>): Tree => ({ id, read: async (path) => files[path], list: async (dir) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`)) });
const manifest = (lib = "^1.0.0", scripts: object = {}) => JSON.stringify({ dependencies: { lib }, scripts });
const lock = (lib = "1.0.0", other = "1.0.0") => JSON.stringify({ packages: { "": { dependencies: { lib: `^${lib}`, other: "^1" } }, "node_modules/lib": { version: lib }, "node_modules/other": { version: other } } });
const env: GateEnvironment = { run: async () => { throw new Error("must not execute"); }, fetch: async () => { throw new Error("must not fetch"); }, now: () => new Date(), osvScanner: "osv-scanner", githubToken: undefined };
async function fixture(major = false) {
  const unit = major ? majorUnits([candidate()])[0]! : routineUnit([candidate()]);
  const to = major ? "2.0.0" : "1.1.0";
  const npm = { files: new Map([["package.json", manifest(`^${to}`)], ["package-lock.json", lock(to)]]), changes: [], notes: [] };
  const plan = await planFor(unit, npm, async () => undefined);
  const baseFiles = { "package.json": manifest(), "package-lock.json": lock() };
  const headFiles = Object.fromEntries(npm.files);
  const input: VerifyInputs = { plan, npmFiles: npm.files, base: tree("base", baseFiles), head: tree("head", headFiles), env, gradle: {}, changedFiles: [...npm.files.keys()] };
  return { input, baseFiles, headFiles, plan };
}
function gradle(version: string, other = "1.0", resolved = version): GradleInventory {
  return { schemaVersion: 1, tree: "worktree", builds: [{ build: ".", configurations: [{ id: ":runtimeClasspath", kind: "project", unresolved: [], error: undefined, resolved: [{ group: "g", name: "lib", version: resolved }], declared: [{ group: "g", name: "lib", version, reason: undefined }] }, { id: ":testRuntimeClasspath", kind: "project", unresolved: [], error: undefined, resolved: [{ group: "g", name: "lib", version: other }], declared: [{ group: "g", name: "lib", version: other, reason: undefined }] }] }] };
}
beforeEach(() => { vi.mocked(runCompare).mockClear(); vi.mocked(runCompare).mockResolvedValue({ failures: [], warnings: [], notes: [], gaps: [], osvScannerVersion: "2.6.0", configText: undefined }); });
describe("bump verification", () => {
  it("accepts exactly planned files and forwards the full comparison failure", async () => {
    const { input } = await fixture();
    expect(await verifyPlan(input)).toEqual([]);
    vi.mocked(runCompare).mockResolvedValue({ failures: ["new advisory"], warnings: [], notes: [], gaps: [], osvScannerVersion: "2.6.0", configText: undefined });
    expect(await verifyPlan(input)).toEqual(["compare: new advisory"]);
  });
  it("fences policy first, including a major, without calling compare", async () => {
    const { input, headFiles } = await fixture(true);
    expect(await verifyPlan({ ...input, head: tree("head", { ...headFiles, ".github/supply-chain.json": "{}" }), changedFiles: [...input.changedFiles, ".github/supply-chain.json"] })).toMatchObject([expect.stringContaining("gate's own policy")]);
    expect(runCompare).not.toHaveBeenCalled();
  });
  it("requires planned lockfiles byte for byte and rejects a new unplanned lockfile", async () => {
    const { input, headFiles } = await fixture();
    expect(await verifyPlan({ ...input, head: tree("head", { ...headFiles, "package-lock.json": `${headFiles["package-lock.json"]}\n` }) })).toContain("package-lock.json differs from the exact planned lockfile");
    expect(await verifyPlan({ ...input, head: tree("head", { ...headFiles, "tools/package-lock.json": lock() }), changedFiles: [...input.changedFiles, "tools/package-lock.json"] })).toContain("tools/package-lock.json differs from the exact planned lockfile");
  });
  it("rejects changes to an unplanned workspace manifest's dependencies", async () => {
    const { input, baseFiles, headFiles } = await fixture(true);
    const problems = await verifyPlan({ ...input, base: tree("base", { ...baseFiles, "ws/package.json": manifest() }), head: tree("head", { ...headFiles, "ws/package.json": manifest("^1.2.0") }), changedFiles: [...input.changedFiles, "ws/package.json"] });
    expect(problems).toContain("ws/package.json changed dependency fields outside the npm plan");
  });
  it("allows scripts/config only in a major, while protecting even peer metadata and bundled dependencies", async () => {
    const major = await fixture(true);
    const scripts = manifest("^2.0.0", { test: "new-cli --changed" });
    expect(await verifyPlan({ ...major.input, head: tree("head", { ...major.headFiles, "package.json": scripts }), changedFiles: [...major.input.changedFiles, "src/adaptation.ts"] })).toEqual([]);
    const files = await plannedFiles(major.plan, tree("head", { ...major.headFiles, "package.json": scripts }));
    expect(files.get("package.json")).toBe(scripts);
    expect(await verifyPlan({ ...major.input, npmFiles: files, head: tree("head", { ...major.headFiles, "package.json": scripts }) })).toEqual([]);
    const altered = JSON.stringify({ ...JSON.parse(scripts), peerDependenciesMeta: { lib: { optional: true } } });
    expect(await verifyPlan({ ...major.input, head: tree("head", { ...major.headFiles, "package.json": altered }) })).toContain("package.json changed dependency fields outside the npm plan");
    const routine = await fixture();
    expect(await verifyPlan({ ...routine.input, head: tree("head", { ...routine.headFiles, "package.json": manifest("^1.1.0", { test: "true" }) }) })).toContain("package.json changed fields outside the npm plan");
  });
  it("rejects code in a routine PR", async () => {
    const { input } = await fixture();
    expect(await verifyPlan({ ...input, changedFiles: [...input.changedFiles, "src/main.ts"] })).toContain("only a major may change src/main.ts");
  });
  it("protects every unplanned Gradle location of a planned package and declares planned ones exactly", async () => {
    const plan = await planFor(routineUnit([candidate({ ecosystem: "Maven", name: "g:lib", from: "1.0", locations: [":runtimeClasspath"], declarations: [] })]), { files: new Map(), changes: [], notes: [] }, async () => undefined);
    const input: VerifyInputs = { plan, npmFiles: new Map(), base: tree("base", {}), head: tree("head", {}), env, gradle: { base: gradle("1.0"), head: gradle("1.1.0", "1.0", "1.2.0") }, changedFiles: ["build.gradle.kts"] };
    expect(await verifyPlan(input)).toEqual([]);
    expect(await verifyPlan({ ...input, gradle: { ...input.gradle, head: gradle("1.1.0", "1.1.0") } })).toContainEqual(expect.stringContaining("outside the plan"));
    expect(await verifyPlan({ ...input, gradle: { ...input.gradle, head: gradle("1.2.0") } })).toContain(":runtimeClasspath must declare g:lib exactly 1.1.0");
  });
  it("keeps floors and their declarations immutable even when a plan names them", async () => {
    const floor = JSON.stringify({ floors: [{ ecosystem: "Maven", package: "g:lib", version: "1.0", declaredIn: "build.gradle", selector: [":runtimeClasspath"], purpose: "compatibility", reason: "works", added: "2026-01-01" }] });
    const plan = await planFor(routineUnit([candidate({ ecosystem: "Maven", name: "g:lib", from: "1.0", locations: [":runtimeClasspath"], declarations: [] })]), { files: new Map(), changes: [], notes: [] }, async () => undefined);
    const input: VerifyInputs = { plan, npmFiles: new Map(), base: tree("base", { ".github/dependency-floors.json": floor }), head: tree("head", { ".github/dependency-floors.json": floor }), env, gradle: { base: gradle("1.0"), head: gradle("1.1.0") }, changedFiles: ["build.gradle"] };
    expect(await verifyPlan(input)).toContain("floor declaration for g:lib changed at :runtimeClasspath");
    expect(await verifyPlan({ ...input, head: tree("head", {}) })).toContain("bump-it may not change dependency floors");
  });
  it("pins Actions and refuses any other change in a planned workflow", async () => {
    const path = ".github/workflows/ci.yml";
    const old = `on: push\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@${"0".repeat(40)} # 1.0.0\n`;
    const target = old.replace("0".repeat(40), "1".repeat(40)).replace("# 1.0.0", "# 1.1.0");
    const unit = routineUnit([candidate({ ecosystem: "GitHub Actions", name: "actions/checkout", declarations: [], locations: [path] })]);
    const plan = await planFor(unit, { files: new Map(), changes: [], notes: [] }, async () => "1".repeat(40));
    const input: VerifyInputs = { plan, npmFiles: new Map(), base: tree("base", { [path]: old }), head: tree("head", { [path]: target }), env, gradle: {}, changedFiles: [path] };
    expect(await verifyPlan(input)).toEqual([]);
    expect(await verifyPlan({ ...input, head: tree("head", { [path]: target.replace("on: push", "on: pull_request") }) })).toMatchObject([expect.stringContaining("beyond its planned action pins")]);
  });
  it("refuses altered expected bytes and corrupted hashes before an adaptation", async () => {
    const { input, plan } = await fixture(true);
    await expect(plannedFiles(plan, tree("head", { "package-lock.json": "bad" }))).rejects.toThrow("recorded npm plan");
    const corrupted: BumpPlan = { ...plan, npmFiles: plan.npmFiles.map((file) => ({ ...file, sha256: "0".repeat(64), dependencySha256: "0".repeat(64) })) };
    expect(await verifyPlan({ ...input, plan: corrupted })).toMatchObject([expect.stringContaining("don't match the plan"), expect.stringContaining("don't match the plan")]);
  });
});
