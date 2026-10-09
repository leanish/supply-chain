import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCompare, type GateEnvironment } from "../../ci/src/gate.ts";
import type { GradleInventory } from "../../ci/src/gradle.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { type BumpPlan, planFor } from "../src/plan.ts";
import { gradleWrapperPlanner, WRAPPER_FILES, WRAPPER_PROPERTIES } from "../src/gradle-wrapper.ts";
import { routineUnit, majorUnits } from "../src/units.ts";
import { plannedFiles, verifyPlan, type VerifyInputs } from "../src/verify.ts";
import { candidate } from "./fixtures.ts";

vi.mock("../../ci/src/gate.ts", async (original) => ({ ...await original<object>(), runCompare: vi.fn(async () => ({ failures: [], warnings: [], notes: [], gaps: [], osvScannerVersion: "2.6.0", configText: undefined, cooldown: { evaluated: true, releaseAgeDays: 7, held: [] } })) }));
const tree = (id: string, files: Record<string, string>): Tree => ({ id, read: async (path) => files[path], list: async (dir) => Object.keys(files).filter((path) => dir === "." || path.startsWith(`${dir}/`)) });
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
beforeEach(() => { vi.mocked(runCompare).mockClear(); vi.mocked(runCompare).mockResolvedValue({ headFindings: [], failures: [], warnings: [], notes: [], gaps: [], osvScannerVersion: "2.6.0", configText: undefined, cooldown: { evaluated: true, releaseAgeDays: 7, held: [] } }); });
describe("bump verification", () => {
  it("verifies official wrapper targets before compare and only permits wrapper files with a planned move", async () => {
    const sum = "a".repeat(64);
    const jar = "b".repeat(64);
    const release = { version: "8.1", buildTime: "20260101000000+0000", snapshot: false, broken: false,
      downloadUrl: "https://services.gradle.org/distributions/gradle-8.1-bin.zip", checksum: sum, wrapperChecksum: jar };
    const source = { ...env, now: () => new Date("2026-10-07"), fetch: async (url: string) => ({ ok: true, status: 200,
      headers: { get: () => null }, json: async () => url.endsWith("/versions/all") ? [release] : [], text: async () => "" }) };
    const wrapper = gradleWrapperPlanner(source, 7);
    const properties = (version: string) => `distributionUrl=https\\://services.gradle.org/distributions/gradle-${version}-bin.zip\ndistributionSha256Sum=${sum}`;
    const base = tree("base", { [WRAPPER_PROPERTIES]: properties("8.0") });
    const found = await wrapper.candidates(base);
    const planned = await planFor(routineUnit([], found), { files: new Map(), changes: [], notes: [] }, async () => undefined);
    const wrapperFiles = WRAPPER_FILES.map((path) => ({ path, sha256: "c".repeat(64), executable: path === "gradlew" }));
    const plan = { ...planned, wrapperFiles };
    const input: VerifyInputs = { plan, wrapperFiles, npmFiles: new Map(), base, head: tree("head", { [WRAPPER_PROPERTIES]: properties("8.1") }),
      env, wrapper, wrapperJarSha256: jar, gradle: {}, changedFiles: WRAPPER_FILES };
    expect(await verifyPlan(input)).toEqual([]);
    expect(runCompare).toHaveBeenCalledOnce();
    vi.mocked(runCompare).mockClear();
    for (const path of WRAPPER_FILES) {
      expect(await verifyPlan({ ...input, wrapperFiles: wrapperFiles.map((file) => file.path === path ? { ...file, sha256: "d".repeat(64) } : file) }))
        .toContain("wrapper files differ from the tool-generated bytes or executable modes");
    }
    expect(await verifyPlan({ ...input, wrapperFiles: wrapperFiles.map((file) => ({ ...file, executable: !file.executable })) }))
      .toContain("wrapper files differ from the tool-generated bytes or executable modes");
    expect(await verifyPlan({ ...input, plan: planned })).toContain("wrapper files differ from the tool-generated bytes or executable modes");
    expect(await verifyPlan({ ...input, wrapperJarSha256: "wrong" })).toContainEqual(expect.stringContaining("wrapper checksum"));
    expect(runCompare).not.toHaveBeenCalled();
    expect(await verifyPlan({ ...input, changedFiles: [...WRAPPER_FILES, "src/other.ts"] })).toContain("only a major may change src/other.ts");
    for (const kind of ["routine", "major"] as const) {
      expect(await verifyPlan({ ...input, plan: { ...plan, kind, moves: [] } })).toContain("Gradle wrapper files changed outside the plan");
    }
  });
  it("accepts exactly planned files and forwards the full comparison failure", async () => {
    const { input } = await fixture();
    expect(await verifyPlan(input)).toEqual([]);
    vi.mocked(runCompare).mockResolvedValue({ headFindings: [], failures: ["new advisory"], warnings: [], notes: [], gaps: [], osvScannerVersion: "2.6.0", configText: undefined, cooldown: { evaluated: true, releaseAgeDays: 7, held: [] } });
    expect(await verifyPlan(input)).toEqual(["compare: new advisory"]);
  });
  it("refuses anything the cooldown holds, or a cooldown it couldn't evaluate", async () => {
    const { input } = await fixture();
    const held = { ecosystem: "npm" as const, name: "lib", version: "1.0.1", replaced: ["1.0.0"], published: "2026-10-06T00:00:00.000Z", eligibleAt: "2026-10-13T00:00:00.000Z", justification: "exception" as const };
    vi.mocked(runCompare).mockResolvedValue({ headFindings: [], failures: [], warnings: [], notes: [], gaps: [], osvScannerVersion: "2.6.0", configText: undefined, cooldown: { evaluated: true, releaseAgeDays: 7, held: [held] } });
    expect(await verifyPlan(input)).toEqual(["under the release-age wait: npm lib@1.0.1: published 2026-10-06T00:00:00.000Z, held until 2026-10-13T00:00:00.000Z (a release-age exception)"]);
    vi.mocked(runCompare).mockResolvedValue({ headFindings: [], failures: [], warnings: [], notes: [], gaps: [], osvScannerVersion: "2.6.0", configText: undefined, cooldown: { evaluated: false, reason: "base broke" } });
    expect(await verifyPlan(input)).toEqual(["the cooldown can't be evaluated: base broke"]);
  });
  it("preserves tool-computed transitives absent from the explicit moves", async () => {
    const { input, baseFiles, headFiles } = await fixture();
    const withChild = (text: string, version: string) => {
      const parsed = JSON.parse(text);
      parsed.packages["node_modules/lib"].dependencies = { child: "^1" };
      parsed.packages["node_modules/child"] = { version };
      return JSON.stringify(parsed);
    };
    const files = new Map(input.npmFiles);
    const expected = withChild(headFiles["package-lock.json"]!, "1.1.0");
    files.set("package-lock.json", expected);
    const plan = await planFor(routineUnit([candidate()]), { files, changes: [], notes: [] }, async () => undefined);
    const computed: VerifyInputs = { ...input, plan, npmFiles: files,
      base: tree("base", { ...baseFiles, "package-lock.json": withChild(baseFiles["package-lock.json"]!, "1.0.0") }),
      head: tree("head", { ...headFiles, "package-lock.json": expected }) };
    expect(plan.moves.map((move) => move.name)).toEqual(["lib"]);
    expect(await verifyPlan(computed)).toEqual([]);
    expect(await verifyPlan({ ...computed, head: tree("head", { ...headFiles, "package-lock.json": withChild(expected, "1.0.0") }) })).toContain("package-lock.json differs from the exact planned lockfile");
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
    const script = (version: string) => ({ "build.gradle.kts": `dependencies { implementation("g:lib:${version}") }` });
    const input: VerifyInputs = { plan, npmFiles: new Map(), base: tree("base", script("1.0")), head: tree("head", script("1.1.0")), env, gradle: { base: gradle("1.0"), head: gradle("1.1.0", "1.0", "1.2.0") }, changedFiles: ["build.gradle.kts"] };
    expect(await verifyPlan(input)).toEqual([]);
    expect(await verifyPlan({ ...input, gradle: { ...input.gradle, head: gradle("1.1.0", "1.1.0") } })).toContainEqual(expect.stringContaining("outside the plan"));
    expect(await verifyPlan({ ...input, gradle: { ...input.gradle, head: gradle("1.2.0") } })).toContain(":runtimeClasspath must declare g:lib exactly 1.1.0");
  });
  it("lets a plugin update move the dependencies the plugin declares, but nothing the build declares itself", async () => {
    // Moving the Kotlin plugin moves the kotlin-stdlib it adds; no build file names kotlin-stdlib.
    const marker = "org.jetbrains.kotlin.jvm:org.jetbrains.kotlin.jvm.gradle.plugin";
    const plan = await planFor(routineUnit([candidate({ ecosystem: "Maven", name: marker, from: "2.0.0", minor: { version: "2.1.0", line: "2" }, major: undefined, locations: [":buildscript.classpath"], declarations: [] })]), { files: new Map(), changes: [], notes: [] }, async () => undefined);
    const inventory = (kotlin: string, lib = "1.0"): GradleInventory => ({ schemaVersion: 1, tree: "worktree", builds: [{ build: ".", configurations: [
      { id: ":buildscript.classpath", kind: "buildscript", unresolved: [], error: undefined, resolved: [], declared: [{ group: "org.jetbrains.kotlin.jvm", name: "org.jetbrains.kotlin.jvm.gradle.plugin", version: kotlin, reason: undefined }] },
      { id: ":compileClasspath", kind: "project", unresolved: [], error: undefined, resolved: [], declared: [{ group: "org.jetbrains.kotlin", name: "kotlin-stdlib", version: kotlin, reason: undefined }, { group: "g", name: "lib", version: lib, reason: undefined }] },
    ] }] });
    const script = (kotlin: string, lib = "1.0") => ({ "build.gradle.kts": `plugins { id("org.jetbrains.kotlin.jvm") version "${kotlin}" }\ndependencies { implementation("g:lib:${lib}") }` });
    const input: VerifyInputs = { plan, npmFiles: new Map(), base: tree("base", script("2.0.0")), head: tree("head", script("2.1.0")), env, gradle: { base: inventory("2.0.0"), head: inventory("2.1.0") }, changedFiles: ["build.gradle.kts"] };
    expect(await verifyPlan(input)).toEqual([]);
    expect(await verifyPlan({ ...input, head: tree("head", script("2.1.0", "1.1")), gradle: { ...input.gradle, head: inventory("2.1.0", "1.1") } })).toContainEqual(expect.stringContaining("g:lib"));
    // The plugin move itself must still land exactly.
    expect(await verifyPlan({ ...input, gradle: { base: inventory("2.0.0"), head: { ...inventory("2.1.0"), builds: [{ ...inventory("2.1.0").builds[0]!, configurations: [
      { ...inventory("2.2.0").builds[0]!.configurations[0]! }, inventory("2.1.0").builds[0]!.configurations[1]!] }] } } })).toContainEqual(expect.stringContaining("exactly 2.1.0"));
    // Not a version change: an unreadable explicit declaration (kotlin("reflect", ...)) removed, or a new one added.
    const withReflect = (inv: GradleInventory, reflect: boolean): GradleInventory => ({ ...inv, builds: [{ ...inv.builds[0]!, configurations: [inv.builds[0]!.configurations[0]!,
      { ...inv.builds[0]!.configurations[1]!, declared: [...inv.builds[0]!.configurations[1]!.declared, ...reflect ? [{ group: "org.jetbrains.kotlin", name: "kotlin-reflect", version: "2.0.0", reason: undefined }] : []] }] }] });
    expect(await verifyPlan({ ...input, gradle: { base: withReflect(inventory("2.0.0"), true), head: withReflect(inventory("2.1.0"), false) } })).toContainEqual(expect.stringContaining("kotlin-reflect"));
    expect(await verifyPlan({ ...input, gradle: { base: withReflect(inventory("2.0.0"), false), head: withReflect(inventory("2.1.0"), true) } })).toContainEqual(expect.stringContaining("kotlin-reflect"));
  });
  it("lets a plugin-driven change through only when the unit's files differ from base by the planned version swaps alone", async () => {
    const marker = "org.jetbrains.kotlin.jvm:org.jetbrains.kotlin.jvm.gradle.plugin";
    const plan = await planFor(routineUnit([candidate({ ecosystem: "Maven", name: marker, from: "2.0.0", minor: { version: "2.1.0", line: "2" }, major: undefined, locations: [":buildscript.classpath"], declarations: [] })]), { files: new Map(), changes: [], notes: [] }, async () => undefined);
    const inventory = (kotlin: string, { stdlibBuild = ".", reflect = "1.9.0" } = {}): GradleInventory => ({ schemaVersion: 1, tree: "worktree", builds: [".", "tools"].map((build) => ({ build, configurations: [
      { id: ":buildscript.classpath", kind: "buildscript" as const, unresolved: [], error: undefined, resolved: [], declared: build === "." ? [{ group: "org.jetbrains.kotlin.jvm", name: "org.jetbrains.kotlin.jvm.gradle.plugin", version: kotlin, reason: undefined }] : [] },
      { id: ":compileClasspath", kind: "project" as const, unresolved: [], error: undefined, resolved: [], declared: [
        { group: "org.jetbrains.kotlin", name: "kotlin-stdlib", version: build === stdlibBuild ? kotlin : "2.0.0", reason: undefined },
        { group: "org.jetbrains.kotlin", name: "kotlin-reflect", version: reflect, reason: undefined },
      ] },
    ] })) });
    const script = (kotlin: string, reflect = "1.9.0", other = "12.0.0") => `plugins { id("org.jetbrains.kotlin.jvm") version "${kotlin}" }\ndependencies { implementation(kotlin("reflect", "${reflect}")) }\n// other: ${other}`;
    const files = (kotlin: string, rest: Parameters<typeof script> extends [string, ...infer R] ? R : never = []) => ({ "build.gradle.kts": script(kotlin, ...rest), "tools/build.gradle.kts": "plugins { java }" });
    const input: VerifyInputs = { plan, npmFiles: new Map(), base: tree("base", files("2.0.0")), head: tree("head", files("2.1.0")), env, gradle: { base: inventory("2.0.0"), head: inventory("2.1.0") }, changedFiles: ["build.gradle.kts"] };
    expect(await verifyPlan(input)).toEqual([]);
    // An unplanned edit next to the plugin update, in notation nothing reads: the text shows it.
    expect(await verifyPlan({ ...input, head: tree("head", files("2.1.0", ["1.8.0"])), gradle: { ...input.gradle, head: inventory("2.1.0", { reflect: "1.8.0" }) } }))
      .toContainEqual(expect.stringContaining("kotlin-reflect"));
    // A swap must be a whole version: 12.0.0 holds 2.0.0, but isn't it.
    expect(await verifyPlan({ ...input, head: tree("head", files("2.1.0", ["1.9.0", "12.1.0"])) })).toContainEqual(expect.stringContaining("kotlin-stdlib"));
    // Any other changed file turns the exemption off.
    expect(await verifyPlan({ ...input, head: tree("head", { ...files("2.1.0"), "gradle.properties": "kotlin.code.style=official" }), changedFiles: ["build.gradle.kts", "gradle.properties"] }))
      .toContainEqual(expect.stringContaining("kotlin-stdlib"));
    // The plugin moved in the root build; the stdlib changing in tools isn't its doing.
    const problems = await verifyPlan({ ...input, gradle: { base: inventory("2.0.0", { stdlibBuild: "tools" }), head: inventory("2.1.0", { stdlibBuild: "tools" }) } });
    expect(problems).not.toEqual([]);
    expect(problems).toEqual(problems.map(() => expect.stringContaining("tools/:compileClasspath")));
  });
  it("protects declarations it can't read when the plan moves no plugin of their build", async () => {
    const plan = await planFor(routineUnit([candidate({ ecosystem: "Maven", name: "g:lib", from: "1.0", minor: { version: "1.1", line: "1" }, major: undefined, locations: [":compileClasspath"], declarations: [] })]), { files: new Map(), changes: [], notes: [] }, async () => undefined);
    const inventory = (lib: string, stdlib: string): GradleInventory => ({ schemaVersion: 1, tree: "worktree", builds: [{ build: ".", configurations: [
      { id: ":compileClasspath", kind: "project", unresolved: [], error: undefined, resolved: [], declared: [{ group: "g", name: "lib", version: lib, reason: undefined }, { group: "org.jetbrains.kotlin", name: "kotlin-stdlib", version: stdlib, reason: undefined }] },
    ] }] });
    const script = (lib: string) => ({ "build.gradle.kts": `dependencies { implementation("g:lib:${lib}") }` });
    const input: VerifyInputs = { plan, npmFiles: new Map(), base: tree("base", script("1.0")), head: tree("head", script("1.1")), env, gradle: { base: inventory("1.0", "2.0.0"), head: inventory("1.1", "2.0.0") }, changedFiles: ["build.gradle.kts"] };
    expect(await verifyPlan(input)).toEqual([]);
    expect(await verifyPlan({ ...input, gradle: { ...input.gradle, head: inventory("1.1", "2.1.0") } })).toContainEqual(expect.stringContaining("kotlin-stdlib"));
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
