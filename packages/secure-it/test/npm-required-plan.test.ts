import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCompare } from "../../ci/src/gate.ts";
import { environment, files, FIXED, json, locked, metadata, NOW, OLD, postcss, tree, vite, YOUNG, securityBatch } from "../../ci/test/required-fixture.ts";
import { materializeInCopy } from "../src/npm-materialize.ts";
import { requiredNpmPlan } from "../src/npm-required-plan.ts";
import { npmWindowFor } from "../src/npm-window.ts";
import { planDigest, planOf, planSection } from "../src/plan-block.ts";
import { retryWithoutNamed } from "../src/retry.ts";
import type { ChangePlan } from "../src/plan.ts";

const plan: ChangePlan = { kind: "routine", topic: "security", malware: false, packages: ["npm|vite"], severity: "HIGH", moves: [
  { ecosystem: "npm", name: "vite", from: "8.3.2", to: "8.3.3", mechanism: "npm-direct", locations: ["node_modules/vite"], advisories: [FIXED], major: false, commitSha: undefined, declaredAs: undefined },
] };
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("security-required npm planning and exact materialization", () => {
  it("plans a shared young requirement for a security batch that the gate proves independently", async () => {
    const batch = securityBatch();
    const h = environment(batch);
    const joint = { ...plan, packages: ["npm|vite", "npm|bundler"], moves: [plan.moves[0]!, { ...plan.moves[0]!, name: "bundler", locations: ["node_modules/bundler"] }] };
    const computed = await requiredNpmPlan(tree(batch.base), joint, h.env);
    expect(computed.requiredNpm?.map((target) => [target.name, target.version])).toEqual([["postcss", "8.5.29"], ["postcss", "8.5.29"]]);
    expect((await runCompare(tree(batch.base), tree(batch.head, "head"), h.env)).failures).toEqual([]);
    expect(h.scans).toHaveLength(2); // One for planning, one for the independent gate.
  });

  it.each([true, false])("pins the lowest required target simultaneously, restores manifests (existing copy: %s)", async (existing) => {
    const original = files("8.3.2", existing ? "8.5.28" : undefined);
    const base = tree(original);
    const h = environment();
    const computed = await requiredNpmPlan(base, plan, h.env);
    expect(computed.requiredNpm).toMatchObject([{ name: "postcss", version: "8.5.29", lockfile: "package-lock.json" }]);
    expect(computed.notes?.join()).toContain("no version satisfying");
    expect(planDigest(computed)).not.toBe(planDigest(plan));
    expect(planOf(planSection(computed))).toEqual(computed);
    expect(h.scans).toHaveLength(1);
    const window = await npmWindowFor(computed, 7, [], NOW, h.env.fetch);
    expect(window.exclude).toEqual(["postcss", "vite"]);
    const dir = await mkdtemp(join(process.cwd(), ".required-test-"));
    dirs.push(dir);
    for (const [path, text] of Object.entries(original)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    let calls = 0;
    const result = await materializeInCopy({ releaseAgeDays: 7, now: NOW }, dir, base, computed, window.exclude, async (cwd, args) => {
      if (args[0] === "--version") return { code: 0, stdout: "11.19.1", stderr: "" };
      expect(args).toContain("--min-release-age=7");
      expect(args).toContain("--min-release-age-exclude=postcss");
      const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      if (++calls === 1) {
        expect(manifest.devDependencies).toEqual({ vite: "8.3.3", postcss: "8.5.29" });
      } else expect(manifest.devDependencies).toEqual({ vite: "^8.3.3" });
      const lock = JSON.parse(original["package-lock.json"]!);
      lock.packages[""] = manifest;
      lock.packages["node_modules/vite"] = locked("vite", "8.3.3");
      lock.packages["node_modules/postcss"] = locked("postcss", "8.5.29");
      await writeFile(join(cwd, "package-lock.json"), json(lock));
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(calls).toBe(2);
    expect(result.get("package.json")).toBe(original["package.json"]!.replace("^8.3.2", "^8.3.3"));
    expect(JSON.parse(result.get("package-lock.json")!).packages["node_modules/postcss"].version).toBe("8.5.29");
  });

  it("keeps a second security root's own target where the first root's requirement reaches it", async () => {
    // 8.5.29 satisfies vite's ^8.5.29 but is vulnerable; postcss's own fix, 8.5.30, stands and needs no required target.
    const affected = { "vite@8.3.2": [FIXED], "postcss@8.5.28": ["GHSA-postcss"], "postcss@8.5.29": ["GHSA-postcss"] };
    const joint: ChangePlan = { ...plan, packages: ["npm|postcss", "npm|vite"], moves: [plan.moves[0]!,
      { ...plan.moves[0]!, name: "postcss", from: "8.5.28", to: "8.5.30", mechanism: "npm-lock", locations: ["node_modules/postcss"], advisories: ["GHSA-postcss"] }] };
    const h = environment({ affected });
    const computed = await requiredNpmPlan(tree(files()), joint, h.env);
    // No required target, but vite still depends on postcss's fix: a retry that drops postcss drops vite too.
    expect(computed).toEqual({ ...joint, coupled: [["npm|vite", "npm|postcss"]] });
    expect(retryWithoutNamed(computed, ["compare: postcss@8.5.30 adds an advisory"]).plan).toBeUndefined();
    expect((await runCompare(tree(files()), tree(files("8.3.3", "8.5.30"), "head"), h.env)).failures).toEqual([]);
  });

  it("does not exempt PostCSS when an aged version satisfies the security root", async () => {
    const doc = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { postcss: "^8.5.28" } } } };
    expect(await requiredNpmPlan(tree(files()), plan, environment({ docs: { vite: doc } }).env)).toEqual(plan);
  });

  it("blocks an unsafe lowest version rather than substituting a higher young one", async () => {
    const env = environment({ affected: { "postcss@8.5.29": ["GHSA-new"] } }).env;
    await expect(requiredNpmPlan(tree(files()), plan, env)).rejects.toThrow("lowest required version adds an advisory");
  });

  it("blocks identity changes on the lowest required version", async () => {
    const doc = { ...postcss, versions: { ...postcss.versions, "8.5.29": { ...metadata, _npmUser: { name: "new-publisher" } } } };
    await expect(requiredNpmPlan(tree(files()), plan, environment({ docs: { postcss: doc } }).env)).rejects.toThrow("hadn't published");
  });

  it("expands a required direct companion without crossing its compatible line", async () => {
    const original = files();
    const lock = JSON.parse(original["package-lock.json"]!);
    lock.packages[""].devDependencies.postcss = "^8.5.28";
    original["package.json"] = json(lock.packages[""]);
    original["package-lock.json"] = json(lock);
    const result = await requiredNpmPlan(tree(original), plan, environment().env);
    expect(result.moves).toContainEqual(expect.objectContaining({ name: "postcss", to: "8.5.29", mechanism: "npm-direct", major: false }));
    const newMajor = { time: { "8.5.28": OLD, "9.0.0": YOUNG }, versions: { "8.5.28": metadata, "9.0.0": metadata } };
    const root = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { postcss: "^9" } } } };
    await expect(requiredNpmPlan(tree(original), plan, environment({ docs: { vite: root, postcss: newMajor } }).env)).rejects.toThrow("no stable non-deprecated version satisfies");
  });
  it("records an aged bridge only when its descendant needs a young exemption", async () => {
    const root = { ...vite, versions: { ...vite.versions, "8.3.3": { ...metadata, dependencies: { bridge: "^1" } } } };
    const bridge = { time: { "1.0.0": OLD }, versions: { "1.0.0": { ...metadata, dependencies: { postcss: "^8.5.29" } } } };
    const result = await requiredNpmPlan(tree(files()), plan, environment({ docs: { vite: root, bridge } }).env);
    expect(result.requiredNpm?.map((target) => [target.name, target.version, target.exempt])).toEqual([["bridge", "1.0.0", false], ["postcss", "8.5.29", true]]);
  });

  it("keeps existing compatibility pins as constraints instead of silently widening them", async () => {
    const original = files();
    const manifest = JSON.parse(original["package.json"]!);
    manifest.overrides = { postcss: "8.5.28" };
    original["package.json"] = json(manifest);
    await expect(requiredNpmPlan(tree(original), plan, environment().env)).rejects.toThrow("no stable non-deprecated version satisfies");
  });

  it("supports a major security root in a cycle with a compatible young direct peer", async () => {
    const root = { ...vite, time: { ...vite.time, "9.0.0": YOUNG }, versions: { "8.3.2": metadata,
      "9.0.0": { ...metadata, peerDependencies: { plugin: "^1.0.1" } },
    } };
    const plugin = { time: { "1.0.0": OLD, "1.0.1": YOUNG }, versions: {
      "1.0.0": { ...metadata, peerDependencies: { vite: "^8" } },
      "1.0.1": { ...metadata, peerDependencies: { vite: "^9" } },
    } };
    const original = files();
    const lock = JSON.parse(original["package-lock.json"]!);
    lock.packages[""].devDependencies.plugin = "^1.0.0";
    lock.packages["node_modules/plugin"] = locked("plugin", "1.0.0");
    original["package.json"] = json(lock.packages[""]);
    original["package-lock.json"] = json(lock);
    const env = environment({ docs: { vite: root, plugin } }).env;
    const major = { ...plan, kind: "major" as const, moves: [{ ...plan.moves[0]!, to: "9.0.0", major: true }] };
    const result = await requiredNpmPlan(tree(original), major, env);
    expect(result.requiredNpm?.some((target) => target.name === "plugin" && target.version === "1.0.1")).toBe(true);
    lock.packages["node_modules/vite"] = locked("vite", "9.0.0");
    lock.packages["node_modules/plugin"] = locked("plugin", "1.0.1");
    lock.packages[""].devDependencies = { vite: "^9.0.0", plugin: "^1.0.1" };
    const head = { "package.json": json(lock.packages[""]), "package-lock.json": json(lock) };
    expect((await runCompare(tree(original), tree(head, "head"), env)).failures).toEqual([]);
  });

  it("can introduce a required copy while an unrelated compatibility override stays intact", async () => {
    const original = files("8.3.2", undefined);
    const manifest = JSON.parse(original["package.json"]!);
    manifest.overrides = { other: "1.0.0" };
    const lock = JSON.parse(original["package-lock.json"]!);
    lock.packages["node_modules/other"] = locked("other", "1.0.0");
    original["package.json"] = json(manifest);
    original["package-lock.json"] = json(lock);
    const other = { time: { "1.0.0": OLD }, versions: { "1.0.0": metadata } };
    const computed = await requiredNpmPlan(tree(original), plan, environment({ docs: { other } }).env);
    expect(computed.requiredNpm).toMatchObject([{ name: "postcss", version: "8.5.29" }]);
  });

});
