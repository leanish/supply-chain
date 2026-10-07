import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { versionKey } from "../../ci/src/package-version.ts";
import { Snapshot } from "../../ci/src/snapshot.ts";
import { computeNpm, MAX_PASSES, type NpmCommand, type NpmInputs } from "../src/npm-compute.ts";
import { requireNpmExcludes } from "../src/npm-runtime.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const manifest = { name: "root", dependencies: { parent: "^1.0.0", frozen: "^1.0.0" } };
const lock = (parent = "1.0.0", child = "1.0.0", frozen = "1.0.0") => ({ lockfileVersion: 3, packages: { "": { ...manifest }, "node_modules/parent": { version: parent, dependencies: { child: "^1" } }, "node_modules/child": { version: child }, "node_modules/frozen": { version: frozen } } });
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
async function fixture(script?: (dir: string, args: ReadonlyArray<string>, n: number) => Promise<void>) {
  const dir = await mkdtemp(join(process.cwd(), ".bump-test-")); dirs.push(dir);
  await writeFile(join(dir, "package.json"), json(manifest));
  await writeFile(join(dir, "package-lock.json"), json(lock()));
  const calls: string[][] = [];
  const npm: NpmCommand = async (cwd, args) => { expect(cwd).toBe(dir); calls.push([...args]); await script?.(dir, args, calls.length); return { code: 0, stdout: "", stderr: "" }; };
  const inputs: NpmInputs = { dir, baseLocks: new Map([["package-lock.json", lock()]]), moves: [{ name: "parent", to: "1.1.0", lockfile: "package-lock.json", workspace: ".", declaredAs: "parent", spec: "^1.0.0" }], npm, kind: "routine", window: { days: 7, exclude: ["@own/*", "@other/*"] }, sources: { versions: async () => ["1.0.0", "1.1.0"], published: async () => new Date("2026-09-01"), snapshot: async (base, candidates) => new Snapshot(new Map([...base, ...candidates].map((pkg) => [versionKey(pkg), []])), [], new Date()), identity: async () => [], isOwn: () => false, releaseAgeDays: 7, now: new Date("2026-10-07") } };
  return { dir, inputs, calls };
}
describe("exact npm computation", () => {
  it("runs install/update/pin/install/restore/install with every release-age flag, returning only changed files", async () => {
    const h = await fixture(async (dir, args, n) => {
      const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      if (n <= 2) {
        expect(manifest.dependencies.parent).toBe("^1.1.0");
        await writeFile(join(dir, "package-lock.json"), json(lock("1.2.0", "1.0.0", "1.2.0")));
      } else if (n === 3) {
        expect(manifest.dependencies).toEqual({ parent: "1.1.0", frozen: "1.0.0" });
        expect(manifest.overrides).toEqual({ "child@1.0.0": "1.1.0" });
        await writeFile(join(dir, "package-lock.json"), json(lock("1.1.0", "1.1.0", "1.0.0")));
      } else {
        expect(manifest.dependencies).toEqual({ parent: "^1.1.0", frozen: "^1.0.0" });
        expect(manifest.overrides).toBeUndefined();
      }
      expect(args).toContain("--min-release-age=7");
      expect(args).toContain("--min-release-age-exclude=@own/*");
      expect(args).toContain("--min-release-age-exclude=@other/*");
      expect(args).toContain("--ignore-scripts");
    });
    const result = await computeNpm(h.inputs);
    expect(h.calls.map((call) => call[0])).toEqual(["install", "update", "install", "install"]);
    expect([...result.files.keys()]).toEqual(["package.json", "package-lock.json"]);
    expect(result.changes.map((change) => [change.name, change.to])).toEqual([["child", "1.1.0"], ["parent", "1.1.0"]]);
  });
  it("does no routine refresh for a major, and freezes other direct declarations", async () => {
    const h = await fixture(async (dir, _args, n) => {
      await writeFile(join(dir, "package-lock.json"), json(n === 1 ? lock("2.1.0", "1.0.0", "1.1.0") : lock("2.0.0", "1.0.0")));
    });
    await computeNpm({ ...h.inputs, kind: "major", moves: h.inputs.moves.map((move) => ({ ...move, to: "2.0.0" })) });
    expect(h.calls.map((call) => call[0])).toEqual(["install", "install", "install"]);
  });
  it("fails after MAX_PASSES when npm keeps undoing the exact targets", async () => {
    const h = await fixture(async (dir) => { await writeFile(join(dir, "package-lock.json"), json(lock())); });
    await expect(computeNpm(h.inputs)).rejects.toThrow(`after ${MAX_PASSES} passes`);
    expect(h.calls).toHaveLength(2 + MAX_PASSES * 2);
  });
  it("refuses npm's unplanned manifest rewrite", async () => {
    const h = await fixture(async (dir) => {
      await writeFile(join(dir, "package-lock.json"), json(lock("1.1.0", "1.1.0")));
      await writeFile(join(dir, "package.json"), json({ ...manifest, dependencies: { ...manifest.dependencies, parent: "^1.1.0" }, scripts: { surprise: "true" } }));
    });
    await expect(computeNpm(h.inputs)).rejects.toThrow("npm rewrote package.json");
  });
  it("preserves manifest formatting and only returns a changed lockfile for a transitive refresh", async () => {
    const h = await fixture(async (dir) => { await writeFile(join(dir, "package-lock.json"), json(lock("1.0.0", "1.1.0"))); });
    const compact = JSON.stringify(manifest);
    await writeFile(join(h.dir, "package.json"), compact);
    const result = await computeNpm({ ...h.inputs, moves: [] });
    expect([...result.files.keys()]).toEqual(["package-lock.json"]);
    expect(await readFile(join(h.dir, "package.json"), "utf8")).toBe(compact);
  });
  it("fails clearly on an npm command failure", async () => {
    const h = await fixture();
    await expect(computeNpm({ ...h.inputs, npm: async () => ({ code: 1, stdout: "", stderr: "offline" }) })).rejects.toThrow("offline");
  });
  it("computes configured nested lockfiles and workspace aliases, returning their repo paths", async () => {
    const h = await fixture();
    const root = join(h.dir, "tools");
    await mkdir(join(root, "ws"), { recursive: true });
    const rootManifest = { name: "tools", workspaces: ["ws"] };
    const wsManifest = { dependencies: { compat: "npm:lib@^1.0.0" } };
    const base = { packages: { "": rootManifest, ws: wsManifest, "node_modules/compat": { name: "lib", version: "1.0.0" } } };
    await writeFile(join(root, "package.json"), json(rootManifest));
    await writeFile(join(root, "ws/package.json"), json(wsManifest));
    await writeFile(join(root, "package-lock.json"), json(base));
    const npm: NpmCommand = async (cwd, args) => {
      expect(cwd).toBe(root); expect(args[0]).toBe("install");
      expect(JSON.parse(await readFile(join(root, "ws/package.json"), "utf8")).dependencies.compat).toBe("npm:lib@^2.0.0");
      await writeFile(join(root, "package-lock.json"), json({ packages: { ...base.packages, ws: { dependencies: { compat: "npm:lib@^2.0.0" } }, "node_modules/compat": { name: "lib", version: "2.0.0" } } }));
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await computeNpm({ ...h.inputs, npm, kind: "major", baseLocks: new Map([["tools/package-lock.json", base]]), moves: [{ lockfile: "tools/package-lock.json", workspace: "ws", declaredAs: "compat", spec: "npm:lib@^1.0.0", name: "lib", to: "2.0.0" }] });
    expect([...result.files.keys()]).toEqual(["tools/ws/package.json", "tools/package-lock.json"]);
    expect(result.changes).toMatchObject([{ name: "lib", path: "node_modules/compat", to: "2.0.0" }]);
  });
  it("rejects a planned declaration disappearing instead of treating it as converged", async () => {
    const h = await fixture(async (dir) => { await writeFile(join(dir, "package-lock.json"), json({ packages: { "": {}, "node_modules/child": { version: "1.1.0" } } })); });
    await expect(computeNpm(h.inputs)).rejects.toThrow("planned declaration .:parent disappeared");
  });
  it("returns unresolved notes when failed lookups are held at base, without failing other moves", async () => {
    const h = await fixture(async (dir) => { await writeFile(join(dir, "package-lock.json"), json(lock("1.1.0"))); });
    const result = await computeNpm({ ...h.inputs, sources: { ...h.inputs.sources, versions: async () => undefined } });
    expect(result.notes).toMatchObject([expect.stringContaining("child at node_modules/child stays at 1.0.0")]);
    expect(result.changes).toMatchObject([{ name: "parent", to: "1.1.0" }]);
  });
  it("reports exact repository pins separately from unresolved lookups", async () => {
    const h = await fixture(async (dir) => {
      await writeFile(join(dir, "package-lock.json"), json(lock("1.1.0")));
    });
    await writeFile(join(h.dir, "package.json"), json({ ...manifest, overrides: { child: "1.0.0" } }));
    const result = await computeNpm(h.inputs);
    expect(result.notes).toEqual(["package-lock.json: child at node_modules/child is pinned at 1.0.0 by the repository override"]);
  });
  it("uses a configured shrinkwrap and refuses a shadowed package-lock", async () => {
    const h = await fixture();
    await writeFile(join(h.dir, "npm-shrinkwrap.json"), json(lock()));
    await expect(computeNpm(h.inputs)).rejects.toThrow("shadowed");
    const result = await computeNpm({ ...h.inputs, moves: [], kind: "major", baseLocks: new Map([["npm-shrinkwrap.json", lock()]]), npm: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(result.files.size).toBe(0);
  });
  it("requires npm 11.17 only when own scopes need exclusion, with no registry call", async () => {
    const fake: NpmCommand = async (_dir, args) => { expect(args).toEqual(["--version"]); return { code: 0, stdout: "11.14.1\n", stderr: "" }; };
    await expect(requireNpmExcludes(fake, ".", ["@own/*"])).rejects.toThrow("11.17.0");
    await requireNpmExcludes(async () => { throw new Error("must not run"); }, ".", []);
    await requireNpmExcludes(async () => ({ code: 0, stdout: "11.20.0", stderr: "" }), ".", ["@own/*"]);
  });
});
