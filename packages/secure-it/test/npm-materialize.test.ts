import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseFloors } from "../../ci/src/floors.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { computedNpmProblems } from "../../remediation/src/npm-file-checks.ts";
import { materializeInCopy } from "../src/npm-materialize.ts";
import { type ChangePlan, type PlannedMove } from "../src/plan.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const now = new Date("2026-10-09");
const move = (name = "vite", to = "8.3.3", mechanism: PlannedMove["mechanism"] = "npm-direct", location = `node_modules/${name}`): PlannedMove => ({ ecosystem: "npm", name, from: "8.3.2", to, mechanism, locations: [location], advisories: ["GHSA-rq7h-c2jc-7f22"], major: false, commitSha: undefined, declaredAs: undefined });
const plan = (moves: PlannedMove[]): ChangePlan => ({ kind: "routine", topic: "security", malware: false, packages: moves.map((move) => `npm|${move.name}`), moves, severity: "HIGH" });

async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(join(process.cwd(), ".materialize-test-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, text);
  }
  const base: Tree = { id: "base", read: async (path) => files[path], list: async (path) => Object.keys(files).filter((file) => file.startsWith(`${path}/`)) };
  return { dir, base };
}

describe("security npm materialization", () => {
  it("prevents excluded-name drift before resolution and restores the intended range and formatting", async () => {
    const original = '{\r\n\t"dependencies": { "vite": "^8.3.2", "other": "~1.0.0" }\r\n}';
    const lock = { packages: { "": { dependencies: { vite: "^8.3.2", other: "~1.0.0" } }, "node_modules/vite": { version: "8.3.2" }, "node_modules/other": { version: "1.0.0" } } };
    const h = await fixture({ "package.json": original, "package-lock.json": json(lock) });
    let calls = 0;
    const files = await materializeInCopy({ releaseAgeDays: 7, now }, h.dir, h.base, plan([move()]), ["vite"], async (cwd, args) => {
      expect(cwd).toBe(h.dir);
      if (args[0] === "--version") return { code: 0, stdout: "11.19.1", stderr: "" };
      expect(args).toContain("--min-release-age=7");
      expect(args).toContain("--min-release-age-exclude=vite");
      const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      if (++calls === 1) {
        // A range here would select Vite 8.3.4 and fail on its young PostCSS requirement.
        if (manifest.dependencies.vite !== "8.3.3") return { code: 1, stdout: "", stderr: "ETARGET postcss@^8.5.29" };
        expect(manifest.dependencies.other).toBe("1.0.0");
      } else expect(manifest.dependencies.vite).toBe("^8.3.3");
      await writeFile(join(cwd, "package-lock.json"), json({ packages: { ...lock.packages, "": manifest, "node_modules/vite": { version: "8.3.3" } } }));
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(calls).toBe(2);
    expect(files.get("package.json")).toBe(original.replace('^8.3.2', '^8.3.3'));
    expect(JSON.parse(files.get("package-lock.json")!).packages["node_modules/vite"].version).toBe("8.3.3");
  });

  it("keeps an unplanned direct's object-form override compatible during security materialization", async () => {
    const root = { dependencies: { vite: "^8.3.2", other: "^1.0.0" }, overrides: { other: { ".": "^1.0.0", child: "2.0.0" } } };
    const lock = { packages: { "": root, "node_modules/vite": { version: "8.3.2" }, "node_modules/other": { version: "1.0.0" } } };
    const h = await fixture({ "package.json": json(root), "package-lock.json": json(lock) });
    let calls = 0;
    const files = await materializeInCopy({ releaseAgeDays: 7, now }, h.dir, h.base, plan([move()]), [], async (cwd) => {
      const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      if (manifest.overrides.other["."] !== manifest.dependencies.other) return { code: 1, stdout: "", stderr: "EOVERRIDE other" };
      expect(manifest.overrides.other.child).toBe("2.0.0");
      expect(manifest.dependencies.other).toBe(++calls === 1 ? "1.0.0" : "^1.0.0");
      await writeFile(join(cwd, "package-lock.json"), json({ packages: { ...lock.packages, "": manifest, "node_modules/vite": { version: "8.3.3" } } }));
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(JSON.parse(files.get("package.json")!).overrides).toEqual(root.overrides);
    expect(calls).toBe(2);
  });

  it("lands a peer-only target through a temporary exact declaration when overrides would be ignored", async () => {
    const lock = { packages: { "": { devDependencies: { vitest: "^5" } }, "node_modules/vitest": { version: "5.0.3", peerDependencies: { vite: "^8" } }, "node_modules/vite": { version: "8.3.2", peer: true } } };
    const manifest = json(lock.packages[""]);
    const h = await fixture({ "package.json": manifest, "package-lock.json": json(lock) });
    let selected = "8.3.2";
    const files = await materializeInCopy({ releaseAgeDays: 7, now }, h.dir, h.base, plan([move("vite", "8.3.3", "npm-lock")]), [], async (cwd) => {
      const root = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      if (root.devDependencies.vite !== undefined) selected = root.devDependencies.vite;
      // Like the real resolver, this fake intentionally ignores overrides for this peer.
      await writeFile(join(cwd, "package-lock.json"), json({ packages: { ...lock.packages, "": root, "node_modules/vite": { version: selected, peer: true } } }));
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(files.get("package.json")).toBe(manifest);
    expect(JSON.parse(files.get("package-lock.json")!).packages["node_modules/vite"].version).toBe("8.3.3");
  });

  it("pins the full peer-coupled direct set simultaneously", async () => {
    const root = { devDependencies: { vitest: "^4.1.7", "@vitest/ui": "~4.1.7", "@vitest/coverage-v8": "4.1.7" } };
    const packages: Record<string, unknown> = { "": root };
    for (const name of Object.keys(root.devDependencies)) packages[`node_modules/${name}`] = { version: "4.1.7" };
    const h = await fixture({ "package.json": json(root), "package-lock.json": json({ packages }) });
    let calls = 0;
    await materializeInCopy({ releaseAgeDays: 7, now }, h.dir, h.base, plan(Object.keys(root.devDependencies).map((name) => move(name, "4.1.11"))), [], async (cwd) => {
      const root = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      if (++calls === 1) expect(Object.values(root.devDependencies)).toEqual(["4.1.11", "4.1.11", "4.1.11"]);
      const result: Record<string, unknown> = { ...packages, "": root };
      for (const name of Object.keys(root.devDependencies)) result[`node_modules/${name}`] = { version: "4.1.11" };
      await writeFile(join(cwd, "package-lock.json"), json({ packages: result }));
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(JSON.parse(await readFile(join(h.dir, "package.json"), "utf8"))).toEqual({ devDependencies: { vitest: "^4.1.11", "@vitest/ui": "~4.1.11", "@vitest/coverage-v8": "4.1.11" } });
  });

  it("fails closed if the restored install moves a target again", async () => {
    const root = { dependencies: { vite: "^8.3.2" } };
    const lock = { packages: { "": root, "node_modules/vite": { version: "8.3.2" } } };
    const h = await fixture({ "package.json": json(root), "package-lock.json": json(lock) });
    await expect(materializeInCopy({ releaseAgeDays: 7, now }, h.dir, h.base, plan([move()]), [], async (cwd) => {
      await writeFile(join(cwd, "package-lock.json"), json({ packages: { ...lock.packages, "node_modules/vite": { version: "8.3.4" } } }));
      return { code: 0, stdout: "", stderr: "" };
    })).rejects.toThrow("did not land exactly at 8.3.3");
  });

  it("protects computed locks and dependency fields, allowing only a major's manifest scripts to change", async () => {
    const expected = new Map([["package.json", json({ dependencies: { vite: "^8.3.3" } })], ["package-lock.json", "lock"]]);
    const head = (manifest: unknown, lock = "lock"): Tree => ({ id: "head", list: async () => [], read: async (path) => path === "package.json" ? json(manifest) : lock });
    expect(await computedNpmProblems(expected, head({ dependencies: { vite: "^8.3.3" }, scripts: { test: "true" } }), true)).toEqual([]);
    expect(await computedNpmProblems(expected, head({ dependencies: { vite: "^8.3.4" } }), true)).toEqual(["package.json differs from secure-it's computed npm plan"]);
    expect(await computedNpmProblems(expected, head({ dependencies: { vite: "^8.3.3" }, scripts: { test: "true" } }), false)).toHaveLength(1);
    expect(await computedNpmProblems(expected, head({ dependencies: { vite: "^8.3.3" } }, "changed"), true)).toEqual(["package-lock.json differs from secure-it's computed npm plan"]);
  });
  it("keeps lasting security overrides and their floor records while removing temporary pins", async () => {
    const root = { dependencies: { parent: "^1.0.0" }, overrides: { other: "1.0.0" } };
    const lock = { packages: { "": root, "node_modules/parent": { version: "1.0.0", dependencies: { vite: "^7" } }, "node_modules/vite": { version: "7.0.0" }, "node_modules/other": { version: "1.0.0" } } };
    const floor = { ecosystem: "npm", package: "other", version: "1.0.0", declaredIn: "package.json", selector: ["other"], purpose: "compatibility", advisories: [], reason: "Compatibility", added: "2026-09-01" };
    const h = await fixture({ "package.json": json(root), "package-lock.json": json(lock), ".github/dependency-floors.json": json({ floors: [floor] }) });
    const files = await materializeInCopy({ releaseAgeDays: 7, now }, h.dir, h.base, plan([move("vite", "8.3.3", "npm-override")]), [], async (cwd) => {
      const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      expect(manifest.overrides.vite).toBe("8.3.3");
      expect(manifest.overrides.other).toBe("1.0.0");
      await writeFile(join(cwd, "package-lock.json"), json({ packages: { ...lock.packages, "": manifest, "node_modules/vite": { version: "8.3.3" } } }));
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(JSON.parse(files.get("package.json")!).overrides).toEqual({ other: "1.0.0", vite: "8.3.3" });
    const records = JSON.parse(files.get(".github/dependency-floors.json")!).floors;
    expect(records[0]).toEqual(floor);
    expect(records[1]).toMatchObject({ package: "vite", version: "8.3.3", selector: [["vite"]], purpose: "security", advisories: ["GHSA-rq7h-c2jc-7f22"] });
  });

  it("updates an existing security floor in place, including a string selector", async () => {
    const root = { dependencies: { parent: "^1" }, overrides: { vite: "8.3.2" } };
    const lock = { packages: { "": root, "node_modules/parent": { version: "1.0.0", dependencies: { vite: "^7" } }, "node_modules/vite": { version: "8.3.2" } } };
    const floor = { ecosystem: "npm", package: "vite", version: "8.3.2", declaredIn: "package.json", selector: "vite", purpose: "security", advisories: ["GHSA-rq7h-c2jc-7f22"], reason: "Original reason", added: "2026-09-01" };
    const h = await fixture({ "package.json": json(root), "package-lock.json": json(lock), ".github/dependency-floors.json": json({ floors: [floor] }) });
    const files = await materializeInCopy({ releaseAgeDays: 7, now }, h.dir, h.base, plan([move("vite", "8.3.3", "npm-override")]), [], async (cwd) => {
      await writeFile(join(cwd, "package-lock.json"), json({ packages: { ...lock.packages, "node_modules/vite": { version: "8.3.3" } } }));
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(JSON.parse(files.get(".github/dependency-floors.json")!).floors).toEqual([{ ...floor, version: "8.3.3" }]);
  });

  it("updates an object-form security override's own version, keeping its child rules and their floors", async () => {
    const root = { dependencies: { parent: "^1" }, overrides: { vite: { ".": "8.3.2", child: "2.0.0" } } };
    const lock = { packages: { "": root, "node_modules/parent": { version: "1.0.0", dependencies: { vite: "^7" } }, "node_modules/vite": { version: "8.3.2" }, "node_modules/child": { version: "2.0.0" } } };
    const security = { ecosystem: "npm", package: "vite", version: "8.3.2", declaredIn: "package.json", selector: ["vite"], purpose: "security", advisories: ["GHSA-rq7h-c2jc-7f22"], reason: "Original reason", added: "2026-09-01" };
    const compatibility = { ecosystem: "npm", package: "child", version: "2.0.0", declaredIn: "package.json", selector: [["vite", "child"]], purpose: "compatibility", advisories: [], reason: "Compatibility", added: "2026-09-01" };
    const h = await fixture({ "package.json": json(root), "package-lock.json": json(lock), ".github/dependency-floors.json": json({ floors: [security, compatibility] }) });
    const files = await materializeInCopy({ releaseAgeDays: 7, now }, h.dir, h.base, plan([move("vite", "8.3.3", "npm-override")]), [], async (cwd) => {
      const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      expect(manifest.overrides.vite).toEqual({ ".": "8.3.3", child: "2.0.0" });
      await writeFile(join(cwd, "package-lock.json"), json({ packages: { ...lock.packages, "": manifest, "node_modules/vite": { version: "8.3.3" } } }));
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(JSON.parse(files.get("package.json")!).overrides).toEqual({ vite: { ".": "8.3.3", child: "2.0.0" } });
    const floors = JSON.parse(files.get(".github/dependency-floors.json")!);
    expect(floors.floors).toEqual([{ ...security, version: "8.3.3" }, compatibility]);
    expect(parseFloors(floors).map((floor) => [floor.package, floor.overridePaths])).toEqual([["vite", [["vite"]]], ["child", [["vite", "child"]]]]);
  });

  it("permits planned Gradle records beside tool-written npm floors, but protects the npm records", async () => {
    const npm = { ecosystem: "npm", package: "vite", version: "8.3.3" };
    const expected = new Map([[".github/dependency-floors.json", json({ floors: [npm] })]]);
    const head: Tree = { id: "head", list: async () => [], read: async () => json({ floors: [npm, { ecosystem: "Maven", package: "a:b" }] }) };
    expect(await computedNpmProblems(expected, head, false)).toEqual([]);
    expect(await computedNpmProblems(expected, { ...head, read: async () => json({ floors: [{ ...npm, version: "8.3.4" }] }) }, false)).toHaveLength(1);
  });

  it("protects npm files outside the computed lockfile set", async () => {
    const base: Tree = { id: "base", list: async () => [], read: async () => "base lock" };
    const head: Tree = { ...base, id: "head", read: async () => "changed lock" };
    expect(await computedNpmProblems(new Map(), head, false, base, ["other/package-lock.json"])).toEqual(["other/package-lock.json differs from secure-it's computed npm plan"]);
  });

  it("preserves a workspace alias's field, prefix and formatting through temporary exact resolution", async () => {
    const root = { workspaces: ["ws"] };
    const manifest = '{"devDependencies":{"compat":"npm:lib@~1.0.0"}}';
    const lock = { packages: { "": root, ws: JSON.parse(manifest), "node_modules/compat": { name: "lib", version: "1.0.0" } } };
    const h = await fixture({ "package.json": json(root), "ws/package.json": manifest, "package-lock.json": json(lock) });
    let count = 0;
    const files = await materializeInCopy({ releaseAgeDays: 7, now }, h.dir, h.base, plan([{ ...move("lib", "1.1.0", "npm-direct", "node_modules/compat"), from: "1.0.0", declaredAs: "compat" }]), [], async (cwd) => {
      const workspace = JSON.parse(await readFile(join(cwd, "ws/package.json"), "utf8"));
      expect(workspace.devDependencies.compat).toBe(++count === 1 ? "npm:lib@1.1.0" : "npm:lib@~1.1.0");
      await writeFile(join(cwd, "package-lock.json"), json({ packages: { ...lock.packages, ws: workspace, "node_modules/compat": { name: "lib", version: "1.1.0" } } }));
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(files.get("ws/package.json")).toBe(manifest.replace("~1.0.0", "~1.1.0"));
    expect(files.get("package.json")).toBe(json(root));
  });

});
