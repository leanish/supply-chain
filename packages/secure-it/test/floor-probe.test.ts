import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Floor, FLOORS_PATH, parseFloors } from "../../ci/src/floors.ts";
import type { GateEnvironment } from "../../ci/src/gate.ts";
import { versionKey } from "../../ci/src/package-version.ts";
import type { RunProcess } from "../../ci/src/process.ts";
import { Snapshot } from "../../ci/src/snapshot.ts";
import { takeSnapshot } from "../../ci/src/take-snapshot.ts";
import type { Tree } from "../../ci/src/tree.ts";
import type { ToolRunContext } from "../../remediation/src/command.ts";
import { unlockedGradle } from "../src/floor-gradle.ts";
import { probeInCopy } from "../src/floor-probe.ts";

vi.mock("../src/floor-gradle.ts", () => ({ unlockedGradle: vi.fn(async () => undefined) }));
vi.mock("../../ci/src/take-snapshot.ts", () => ({ takeSnapshot: vi.fn(async (packages) => new Snapshot(new Map(packages.map((pkg: Parameters<typeof versionKey>[0]) => [versionKey(pkg), []])), [], new Date("2026-10-07"))) }));
const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const raw = { ecosystem: "npm", package: "lib", version: "2.0.0", declaredIn: "package.json", selector: ["lib"],
  purpose: "security", advisories: ["CVE-2026-12345"], reason: "security", added: "2026-10-01" };
const floors = parseFloors({ floors: [raw] });
const ENV = { run: async () => { throw new Error("not expected"); }, fetch: async () => { throw new Error("no network"); }, now: () => new Date("2026-10-07"), osvScanner: "osv", githubToken: undefined } as GateEnvironment;
const NEW_LOCK = JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { parent: "^1.0.0" } }, "node_modules/parent": { version: "1.1.0" }, "node_modules/lib": { version: "2.1.0" } } });

async function fixture(options: { shrinkwrap?: boolean; exclude?: string[]; version?: string; rewrite?: boolean; fail?: boolean } = {}) {
  const dir = await mkdtemp(join(process.cwd(), ".floor-probe-"));
  dirs.push(dir);
  const lock = options.shrinkwrap ? "npm-shrinkwrap.json" : "package-lock.json";
  const data: Record<string, string> = {
    [FLOORS_PATH]: JSON.stringify({ floors: [raw] }), "package.json": JSON.stringify({ scripts: { test: "vitest" }, dependencies: { parent: "^1.0.0" }, overrides: { lib: "2.0.0" } }),
    [lock]: JSON.stringify({ packages: { "node_modules/lib": { version: "2.0.0" } } }),
    ".github/supply-chain.json": JSON.stringify({ npm: { lockfiles: [lock] } }),
  };
  await mkdir(join(dir, ".github"));
  for (const [path, text] of Object.entries(data)) await writeFile(join(dir, path), text);
  // An unconfigured alternate lockfile must not influence the unlocked resolution either.
  await writeFile(join(dir, options.shrinkwrap ? "package-lock.json" : "npm-shrinkwrap.json"), "stale lock");
  const tree: Tree = { id: "base", read: async (path) => data[path], list: async () => [] };
  const context = { workingCopy: { projectId: "acme/widget", path: dir, gitDir: join(dir, "metadata"), headSha: "a".repeat(40), branch: "main" },
    releaseAgeDays: 7, releaseAgeExclude: options.exclude ?? [], isolation: {}, now: new Date("2026-10-07") } as unknown as ToolRunContext;
  const calls: string[][] = [];
  const run: RunProcess = async (command, args, opts) => {
    expect(command).toBe("codex");
    expect(args[0]).toBe("sandbox");
    expect(opts?.cwd).toBe(dir);
    const npm = [...args.slice(args.indexOf("--") + 1)];
    calls.push(npm);
    if (npm[1] === "--version") return { code: 0, stdout: options.version ?? "11.20.0", stderr: "" };
    await expect(readFile(join(dir, "package-lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(dir, "npm-shrinkwrap.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(dir, "package.json"), "utf8"))).toEqual({ scripts: { test: "vitest" }, dependencies: { parent: "^1.0.0" } });
    if (options.fail) return { code: 1, stdout: "", stderr: "no eligible version" };
    await writeFile(join(dir, "package-lock.json"), NEW_LOCK);
    if (options.rewrite) await writeFile(join(dir, "package.json"), "{}");
    return { code: 0, stdout: "", stderr: "" };
  };
  return { context, tree, dir, calls, run, lock };
}

describe("unlocked sandboxed npm floor proof", () => {
  it.each([false, true])("removes both lock formats, resolves under the window, and returns exact bytes (shrinkwrap=%s)", async (shrinkwrap) => {
    const f = await fixture({ shrinkwrap, exclude: ["@leanish/*"] });
    const result = await probeInCopy(f.context, f.dir, f.tree, floors, ENV, f.run);
    expect(f.calls).toEqual([
      ["npm", "--version"], ["npm", "install", "--package-lock-only", "--ignore-scripts", "--audit=false", "--fund=false", "--min-release-age=7", "--min-release-age-exclude=@leanish/*"],
    ]);
    expect([...result.files.keys()].sort()).toEqual([FLOORS_PATH, f.lock, "package.json"].sort());
    expect(result.files.get(f.lock)).toBe(NEW_LOCK);
    expect(JSON.parse(result.files.get(FLOORS_PATH)!)).toEqual({ floors: [] });
    expect(takeSnapshot).toHaveBeenCalledOnce();
    expect(vi.mocked(takeSnapshot).mock.calls[0]?.[0]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "lib", version: "2.1.0" })]));
    expect(unlockedGradle).toHaveBeenCalledOnce();
    expect(result.problems).toEqual([]);
    expect(result.findings).toEqual([]);
  });
  it("checks npm exclusion support before resolution, and never exempts locked young versions in an unlocked proof", async () => {
    const old = await fixture({ exclude: ["@leanish/*"], version: "11.14.1" });
    await expect(probeInCopy(old.context, old.dir, old.tree, floors, ENV, old.run)).rejects.toThrow("npm >= 11.17.0");
    expect(old.calls).toEqual([["npm", "--version"]]);
    const supported = await fixture();
    await probeInCopy(supported.context, supported.dir, supported.tree, floors, ENV, supported.run);
    expect(supported.calls).toHaveLength(1);
    expect(supported.calls[0]?.some((arg) => arg.startsWith("--min-release-age-exclude="))).toBe(false);
  });
  it("fails closed on npm errors or a rewritten manifest", async () => {
    const failed = await fixture({ fail: true });
    await expect(probeInCopy(failed.context, failed.dir, failed.tree, floors, ENV, failed.run)).rejects.toThrow("no eligible version");
    const rewritten = await fixture({ rewrite: true });
    await expect(probeInCopy(rewritten.context, rewritten.dir, rewritten.tree, floors, ENV, rewritten.run)).rejects.toThrow("rewrote the planned manifest");
  });
  it("reports incomplete snapshots and includes affected aliases in the proof", async () => {
    const f = await fixture();
    vi.mocked(takeSnapshot).mockImplementationOnce(async (packages) => new Snapshot(new Map(packages.map((pkg) => [versionKey(pkg), pkg.name === "lib"
      ? [{ id: "GHSA-rq7h-c2jc-7f22", ids: ["GHSA-rq7h-c2jc-7f22", "CVE-2026-12345"], source: "osv" as const, malicious: false, summary: undefined, severity: undefined }] : []])), ["unreadable repository advisory"], new Date()));
    const result = await probeInCopy(f.context, f.dir, f.tree, floors, ENV, f.run);
    expect(result.findings).toContainEqual(expect.objectContaining({ name: "lib", ids: expect.arrayContaining(["CVE-2026-12345"]) }));
    expect(result.problems).toEqual(["unreadable repository advisory"]);
  });
  it("rejects traversal and unsupported npm declaration files before starting any process", async () => {
    const f = await fixture();
    const unsafe: Floor = { ...floors[0]!, declaredIn: "../package.json" };
    await expect(probeInCopy(f.context, f.dir, f.tree, [unsafe], ENV, f.run)).rejects.toThrow("unsafe floor declaration path");
    expect(f.calls).toEqual([]);
    await expect(probeInCopy(f.context, f.dir, f.tree, [{ ...floors[0]!, declaredIn: "extra.json" }], ENV, f.run)).rejects.toThrow("must be declared in package.json");
    expect(f.calls).toEqual([]);
  });
});
