import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { SecurityFix } from "../../ci/src/candidates.ts";
import { parseConfig } from "../../ci/src/config.ts";
import { NO_EXCEPTIONS } from "../../ci/src/exceptions.ts";
import type { GateEnvironment } from "../../ci/src/gate.ts";
import { runProcess, type RunProcess } from "../../ci/src/process.ts";
import { fakeFetch } from "../../ci/test/fake-fetch.ts";
import { withParents } from "../src/npm-parents.ts";
import { withParentsPlanned } from "../src/secure-it.ts";
import { coupledWork, planFor } from "../src/plan.ts";

const NOW = new Date("2026-10-10T12:00:00Z");
const OLD = "2026-01-01T00:00:00Z";
const YOUNG = "2026-10-09T00:00:00Z";

/** `name` → version → its publish time and its dependencies. */
type Registry = Record<string, Record<string, { readonly time: string; readonly dependencies?: Record<string, string> }>>;

function environment(registry: Registry, affected: Record<string, string[]> = {}): GateEnvironment {
  const run: RunProcess = async (command, args, options) => {
    if (command !== "osv-scanner") return runProcess(command, args, options);
    if (args[0] === "--version") return { code: 0, stdout: "osv-scanner version: 2.6.0\n", stderr: "" };
    const inventory = JSON.parse(await readFile(args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, ""), "utf8")) as {
      results: Array<{ packages: Array<{ package: { name: string; version: string; ecosystem: string } }> }>;
    };
    const packages = inventory.results[0]!.packages.map(({ package: pkg }) => ({
      package: pkg,
      vulnerabilities: (affected[`${pkg.name}@${pkg.version}`] ?? []).map((id) => ({ id, summary: id })),
    }));
    return { code: 1, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
  };
  const routes: Parameters<typeof fakeFetch>[0] = {};
  for (const [name, versions] of Object.entries(registry)) {
    routes[`https://registry.npmjs.org/${name}`] = { body: {
      time: Object.fromEntries(Object.entries(versions).map(([version, entry]) => [version, entry.time])),
      versions: Object.fromEntries(Object.entries(versions).map(([version, entry]) => [version, { _npmUser: { name: "maintainer" }, dependencies: entry.dependencies ?? {}, dist: {} }])),
    } };
    for (const version of Object.keys(versions)) routes[`https://registry.npmjs.org/${name}/${version}`] = { body: {} };
  }
  return { run, fetch: fakeFetch(routes), now: () => NOW, osvScanner: "osv-scanner", githubToken: undefined };
}

/** The app declares `parent` (`^1.0.0`), which pins `brace` with `~1.1.0`. */
function lockfiles() {
  return new Map([["package-lock.json", { lockfileVersion: 3, packages: {
    "": { name: "app", dependencies: { parent: "^1.0.0" } },
    "node_modules/parent": { version: "1.0.0", dependencies: { brace: "~1.1.0" } },
    "node_modules/brace": { version: "1.1.0" },
  } }]]);
}

const brace = (to = "1.2.4"): SecurityFix => ({
  ecosystem: "npm", name: "brace", from: "1.1.0", locations: ["node_modules/brace"], targets: ["GHSA-brace"], unfixable: [], malicious: false, severity: "HIGH",
  to: { version: to, line: "1", aged: true, major: false, blockers: [] }, problem: undefined,
});

async function parents(registry: Registry, options: { affected?: Record<string, string[]>; locks?: ReadonlyMap<string, unknown> } = {}) {
  const fixes = await withParents([brace()], { lockfiles: options.locks ?? lockfiles(), env: environment(registry, options.affected), config: parseConfig({}), exceptions: NO_EXCEPTIONS });
  return { fixes, notes: fixes.flatMap((fix) => fix.notes ?? []) };
}

const PARENT = {
  "1.0.0": { time: OLD, dependencies: { brace: "~1.1.0" } },
  "1.0.1": { time: OLD, dependencies: { brace: "~1.1.0" } },
  "1.2.0": { time: OLD, dependencies: { brace: "^1.2.4" } },
  "1.3.0": { time: OLD, dependencies: { brace: "^1.2.4" } },
  "2.0.0": { time: OLD, dependencies: { brace: "^2.0.0" } },
};

describe("moving a parent instead of overriding its range", () => {
  it("takes the parent's lowest aged version in its line that admits the target, and plans the copy as a lock", async () => {
    const result = await parents({ parent: PARENT });
    expect(result.notes).toEqual([]);
    expect(result.fixes[0]!.parents).toEqual([{ name: "parent", from: "1.0.0", to: "1.2.0", line: "1", location: "node_modules/parent", unblocks: "node_modules/brace" }]);
    const plan = await planFor(result.fixes, { named: undefined, lockfiles: lockfiles(), gradle: undefined, tagCommit: async () => undefined });
    expect(plan.moves.map((move) => [move.name, move.mechanism, move.to, move.advisories])).toEqual([
      ["brace", "npm-lock", "1.2.4", ["GHSA-brace"]],
      ["parent", "npm-direct", "1.2.0", []],
    ]);
    const { units } = await coupledWork(result.fixes);
    expect(units.map((unit) => [unit.work.map((fix) => fix.name).sort(), unit.coupled])).toEqual([[["brace", "parent"], [["npm|brace", "npm|parent"]]]]);
    expect(plan.packages).toEqual(["npm|brace", "npm|parent"]);
  });

  it.each<[string, Registry["x"], Record<string, string[]>, string]>([
    ["only a young version admits it", { ...PARENT, "1.2.0": { ...PARENT["1.2.0"]!, time: YOUNG }, "1.3.0": { ...PARENT["1.3.0"]!, time: YOUNG } }, {}, "no parent version in its line past the wait"],
    ["only another line admits it", { "1.0.0": PARENT["1.0.0"]!, "2.0.0": PARENT["2.0.0"]! }, {}, "no parent version in its line past the wait"],
    ["every admitting version brings an advisory of its own", PARENT, { "parent@1.2.0": ["GHSA-p"], "parent@1.3.0": ["GHSA-p"] }, "free of new advisories"],
  ])("keeps the override when %s", async (_, versions, affected, note) => {
    const result = await parents({ parent: versions }, { affected });
    expect(result.fixes[0]!.parents).toBeUndefined();
    expect(result.notes).toEqual([expect.stringContaining(note)]);
    const plan = await planFor(result.fixes, { named: undefined, lockfiles: lockfiles(), gradle: undefined, tagCommit: async () => undefined });
    expect(plan.moves.map((move) => move.mechanism)).toEqual(["npm-override"]);
  });

  it("skips an admitting version with an advisory for the next one", async () => {
    const result = await parents({ parent: PARENT }, { affected: { "parent@1.2.0": ["GHSA-p"] } });
    expect(result.fixes[0]!.parents?.[0]?.to).toBe("1.3.0");
  });

  it("keeps the override for a bundled parent", async () => {
    const locks = new Map([["package-lock.json", { lockfileVersion: 3, packages: {
      "": { name: "app", dependencies: { carrier: "^1.0.0" } },
      "node_modules/carrier": { version: "1.0.0" },
      "node_modules/carrier/node_modules/parent": { version: "1.0.0", dependencies: { brace: "~1.1.0" }, inBundle: true },
      "node_modules/brace": { version: "1.1.0" },
    } }]]);
    const result = await parents({ parent: PARENT }, { locks });
    expect(result.notes).toEqual([expect.stringContaining("is bundled")]);
  });

  it("keeps the override when the parent's own dependents wouldn't admit it", async () => {
    const locks = new Map([["package-lock.json", { lockfileVersion: 3, packages: {
      "": { name: "app", dependencies: { holder: "^1.0.0" } },
      "node_modules/holder": { version: "1.0.0", dependencies: { parent: "~1.0.0" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { brace: "~1.1.0" } },
      "node_modules/brace": { version: "1.1.0" },
    } }]]);
    const result = await parents({ parent: PARENT }, { locks });
    expect(result.notes).toEqual([expect.stringContaining("moves without an override itself")]);
  });

  it("keeps the override, with the reason, when the registry can't be read", async () => {
    const result = await parents({});
    expect(result.notes).toEqual([expect.stringContaining("searching parent failed")]);
  });
});

describe("npm parents, regressions", () => {
  const fixOf = (name: string, from: string, to: string, location = `node_modules/${name}`): SecurityFix => ({
    ecosystem: "npm", name, from, locations: [location], targets: [`GHSA-${name}`], unfixable: [], malicious: false, severity: "HIGH",
    to: { version: to, line: to.split(".")[0]!, aged: true, major: false, blockers: [] }, problem: undefined,
  });
  const twoChildren = () => new Map([["package-lock.json", { lockfileVersion: 3, packages: {
    "": { name: "app", dependencies: { parent: "^1.0.0" } },
    "node_modules/parent": { version: "1.0.0", dependencies: { x: "~1.0.0", y: "~1.0.0" } },
    "node_modules/x": { version: "1.0.0" },
    "node_modules/y": { version: "1.0.0" },
  } }]]);
  const run = (fixes: SecurityFix[], registry: Registry, locks: ReadonlyMap<string, unknown>) =>
    withParents(fixes, { lockfiles: locks, env: environment(registry), config: parseConfig({}), exceptions: NO_EXCEPTIONS });

  it("gives one parent occurrence one version admitting every copy it must", async () => {
    const registry: Registry = { parent: {
      "1.0.0": { time: OLD, dependencies: { x: "~1.0.0", y: "~1.0.0" } },
      "1.1.0": { time: OLD, dependencies: { x: "^1.1.0", y: "~1.0.0" } },
      "1.2.0": { time: OLD, dependencies: { x: "^1.1.0", y: "^1.1.0" } },
    } };
    const fixes = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("y", "1.0.0", "1.1.0")], registry, twoChildren());
    expect(fixes.filter((fix) => fix.parents !== undefined).map((fix) => fix.parents!.map((parent) => parent.to))).toEqual([["1.2.0"], ["1.2.0"]]);
    const plan = await planFor(fixes, { named: undefined, lockfiles: twoChildren(), gradle: undefined, tagCommit: async () => undefined });
    expect(plan.moves.filter((move) => move.name === "parent")).toEqual([expect.objectContaining({ to: "1.2.0", locations: ["node_modules/parent"] })]);
  });

  it("parents only through the version the parent's own fix takes", async () => {
    const registry: Registry = { parent: {
      "1.0.0": { time: OLD, dependencies: { x: "~1.0.0", y: "~1.0.0" } },
      "1.1.0": { time: OLD, dependencies: { x: "^1.1.0", y: "~1.0.0" } },
      "1.2.0": { time: OLD, dependencies: { x: "^1.1.0", y: "~1.0.0" } },
    } };
    const fixes = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("parent", "1.0.0", "1.2.0")], registry, twoChildren());
    expect(fixes[0]!.parents?.map((parent) => parent.to)).toEqual(["1.2.0"]);
  });

  it("reads the range of the edge that installs the copy, not a peer's", async () => {
    const locks = new Map([["package-lock.json", { lockfileVersion: 3, packages: {
      "": { name: "app", dependencies: { parent: "^1.0.0" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { x: "~1.0.0" } },
      "node_modules/parent/node_modules/x": { version: "1.0.0" },
    } }]]);
    const registry: Registry = { parent: {
      "1.0.0": { time: OLD, dependencies: { x: "~1.0.0" } },
      "1.1.0": { time: OLD, dependencies: { x: "~1.0.0" } },
      "1.2.0": { time: OLD, dependencies: { x: "^1.1.0" } },
    } };
    // 1.1.0 also asks for x as a peer admitting the fix, but its own nested copy stays ~1.0.0.
    const environmentWithPeer = environment(registry);
    const fetch = environmentWithPeer.fetch;
    const withPeer: typeof environmentWithPeer = { ...environmentWithPeer, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (url !== "https://registry.npmjs.org/parent") return response;
      const body = await response.json() as { versions: Record<string, Record<string, unknown>> };
      body.versions["1.1.0"]!["peerDependencies"] = { x: "^1.1.0" };
      return { ...response, json: async () => body, text: async () => JSON.stringify(body) };
    } };
    const fixes = await withParents([fixOf("x", "1.0.0", "1.1.0", "node_modules/parent/node_modules/x")], { lockfiles: locks, env: withPeer, config: parseConfig({}), exceptions: NO_EXCEPTIONS });
    expect(fixes[0]!.parents?.map((parent) => parent.to)).toEqual(["1.2.0"]);
  });

  it("moves a transitive parent too, locked inside its own parent's range", async () => {
    const locks = new Map([["package-lock.json", { lockfileVersion: 3, packages: {
      "": { name: "app", dependencies: { holder: "^1.0.0" } },
      "node_modules/holder": { version: "1.0.0", dependencies: { parent: "^1.0.0" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { x: "~1.0.0" } },
      "node_modules/x": { version: "1.0.0" },
    } }]]);
    const registry: Registry = { parent: { "1.0.0": { time: OLD, dependencies: { x: "~1.0.0" } }, "1.1.0": { time: OLD, dependencies: { x: "^1.1.0" } } } };
    const fixes = await run([fixOf("x", "1.0.0", "1.1.0")], registry, locks);
    const plan = await planFor(fixes, { named: undefined, lockfiles: locks, gradle: undefined, tagCommit: async () => undefined });
    expect(plan.moves.map((move) => [move.name, move.mechanism, move.to])).toEqual([["x", "npm-lock", "1.1.0"], ["parent", "npm-lock", "1.1.0"]]);
  });
});

describe("npm parents, second round", () => {
  const fixOf = (name: string, from: string, to: string, aged = true): SecurityFix => ({
    ecosystem: "npm", name, from, locations: [`node_modules/${name}`], targets: [`GHSA-${name}`], unfixable: [], malicious: false, severity: "HIGH",
    to: { version: to, line: to.split(".")[0]!, aged, major: false, blockers: [] }, problem: undefined,
  });
  const locks = (ranges: Record<string, string>) => new Map([["package-lock.json", { lockfileVersion: 3, packages: {
    "": { name: "app", dependencies: { parent: "^1.0.0", q: "^1.0.0" } },
    "node_modules/parent": { version: "1.0.0", dependencies: ranges },
    "node_modules/x": { version: "1.0.0" },
    "node_modules/y": { version: "1.0.0" },
    "node_modules/q": { version: "1.0.0" },
  } }]]);
  const run = (fixes: SecurityFix[], registry: Registry, lockfiles: ReadonlyMap<string, unknown>) =>
    withParents(fixes, { lockfiles, env: environment(registry), config: parseConfig({}), exceptions: NO_EXCEPTIONS });

  it("keeps admitting the copies the parent's range already admits", async () => {
    const registry: Registry = { parent: {
      "1.0.0": { time: OLD, dependencies: { x: "^1.0.0", y: "~1.0.0" } },
      "1.1.0": { time: OLD, dependencies: { x: "~1.0.0", y: "^1.1.0" } },
      "1.2.0": { time: OLD, dependencies: { x: "^1.1.0", y: "^1.1.0" } },
    } };
    const fixes = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("y", "1.0.0", "1.1.0")], registry, locks({ x: "^1.0.0", y: "~1.0.0" }));
    expect(fixes.find((fix) => fix.name === "y")?.parents?.map((parent) => parent.to)).toEqual(["1.2.0"]);
  });

  it("ties a copy to its parent's own young fix, in one held unit", async () => {
    const registry: Registry = { parent: {
      "1.0.0": { time: OLD, dependencies: { x: "~1.0.0" } },
      "1.1.0": { time: YOUNG, dependencies: { x: "^1.1.0" } },
    } };
    const fixes = await run([fixOf("x", "1.0.0", "1.1.0"), fixOf("parent", "1.0.0", "1.1.0", false)], registry, locks({ x: "~1.0.0" }));
    const { units } = await coupledWork(fixes);
    expect(units.map((unit) => [unit.topic, unit.work.map((fix) => fix.name).sort()])).toEqual([["security-cooldown", ["parent", "x"]]]);
  });

  it("anchors the direct-peer closure on a chosen parent", async () => {
    const registry: Registry = { parent: { "1.0.0": { time: OLD, dependencies: { x: "~1.0.0" } }, "1.1.0": { time: OLD, dependencies: { x: "^1.1.0" } } } };
    const fixes = await run([fixOf("x", "1.0.0", "1.1.0")], registry, locks({ x: "~1.0.0" }));
    const anchors: string[] = [];
    await coupledWork(fixes, { resolve: async (moves) => {
      anchors.push(...moves.map((move) => `${move.name}@${move.to}`));
      return { additions: [], blocked: [], sets: [] };
    } });
    expect(anchors.sort()).toEqual(["parent@1.1.0", "x@1.1.0"]);
  });
});

describe("npm parents, third round", () => {
  const fixAt = (location: string, from: string, to: string): SecurityFix => ({
    ecosystem: "npm", name: "x", from, locations: [location], targets: ["GHSA-x"], unfixable: [], malicious: false, severity: "HIGH",
    to: { version: to, line: to.split(".")[0]!, aged: true, major: false, blockers: [] }, problem: undefined,
  });
  const lock = (parent: string, x: string, range: string) => ({ lockfileVersion: 3, packages: {
    "": { name: "app", dependencies: { parent: `^${parent}` } },
    "node_modules/parent": { version: parent, dependencies: { x: range } },
    "node_modules/x": { version: x },
  } });
  const registry: Registry = { parent: {
    "1.0.0": { time: OLD, dependencies: { x: "~1.0.0" } }, "1.1.0": { time: OLD, dependencies: { x: "^1.1.0" } },
    "2.0.0": { time: OLD, dependencies: { x: "~1.0.0" } }, "2.1.0": { time: OLD, dependencies: { x: "^1.1.0" } },
  } };

  it("keeps each occurrence's own transition when lockfiles hold different versions of the parent", async () => {
    const lockfiles = new Map<string, unknown>([["package-lock.json", lock("1.0.0", "1.0.0", "~1.0.0")], ["sub/package-lock.json", lock("2.0.0", "1.0.0", "~1.0.0")]]);
    const fixes = await withParents([fixAt("node_modules/x", "1.0.0", "1.1.0"), fixAt("sub/node_modules/x", "1.0.0", "1.1.0")],
      { lockfiles, env: environment(registry), config: parseConfig({}), exceptions: NO_EXCEPTIONS });
    expect(fixes.filter((fix) => fix.name === "parent").map((fix) => [fix.from, fix.to?.version, fix.locations])).toEqual([
      ["1.0.0", "1.1.0", ["node_modules/parent"]],
      ["2.0.0", "2.1.0", ["sub/node_modules/parent"]],
    ]);
  });

  it("rebuilds the direct-peer closure with the parents it adds", async () => {
    const files: Record<string, string> = { "package-lock.json": JSON.stringify(lock("1.0.0", "1.0.0", "~1.0.0")) };
    const tree = { id: "base", read: async (path: string) => files[path], list: async () => [] };
    const asked: string[][] = [];
    const found = {
      fixes: [fixAt("node_modules/x", "1.0.0", "1.1.0")], incomplete: [], gaps: [], osvScannerVersion: "2.6.0",
      npmPeers: { resolve: async () => ({ additions: [], blocked: [], sets: [] }) },
      peersWith: async (extra: ReadonlyArray<{ name: string; version: string }>) => {
        asked.push(extra.map((pkg) => `${pkg.name}@${pkg.version}`));
        return { resolve: async () => ({ additions: [], blocked: [], sets: [] }) };
      },
    };
    const planned = await withParentsPlanned(found, { tree, gradle: undefined }, environment(registry), { ofCommit: async () => undefined, ofWorkingTree: async () => undefined });
    expect(asked).toEqual([["parent@1.1.0"]]);
    expect(planned.fixes.map((fix) => fix.name).sort()).toEqual(["parent", "x"]);
  });
});
