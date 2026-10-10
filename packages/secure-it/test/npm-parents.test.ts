import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { SecurityFix } from "../../ci/src/candidates.ts";
import { parseConfig } from "../../ci/src/config.ts";
import { NO_EXCEPTIONS } from "../../ci/src/exceptions.ts";
import type { GateEnvironment } from "../../ci/src/gate.ts";
import { runProcess, type RunProcess } from "../../ci/src/process.ts";
import { fakeFetch } from "../../ci/test/fake-fetch.ts";
import { withParents } from "../src/npm-parents.ts";
import { planFor } from "../src/plan.ts";

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

const parents = (registry: Registry, options: { affected?: Record<string, string[]>; locks?: ReadonlyMap<string, unknown> } = {}) =>
  withParents([brace()], { lockfiles: options.locks ?? lockfiles(), env: environment(registry, options.affected), config: parseConfig({}), exceptions: NO_EXCEPTIONS });

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
    expect(result.fixes[0]!.parents).toEqual([{ name: "parent", from: "1.0.0", to: "1.2.0", location: "node_modules/parent", unblocks: "node_modules/brace" }]);
    const plan = await planFor(result.fixes, { named: undefined, lockfiles: lockfiles(), gradle: undefined, tagCommit: async () => undefined });
    expect(plan.moves.map((move) => [move.name, move.mechanism, move.to, move.advisories])).toEqual([
      ["brace", "npm-lock", "1.2.4", ["GHSA-brace"]],
      ["parent", "npm-direct", "1.2.0", []],
    ]);
    expect(plan.coupled).toEqual([["npm|brace", "npm|parent"]]);
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
