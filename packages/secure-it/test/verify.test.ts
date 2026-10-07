import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { GateEnvironment } from "../../ci/src/gate.ts";
import { runProcess, type RunProcess } from "../../ci/src/process.ts";
import type { Tree } from "../../ci/src/tree.ts";
import { fakeFetch } from "../../ci/test/fake-fetch.ts";
import type { ChangePlan } from "../src/plan.ts";
import { verifyPlan } from "../src/verify.ts";

const NOW = new Date("2026-10-07T12:00:00Z");
const OLD = "2026-01-01T00:00:00Z";

function lock(root: Record<string, string>, installed: Record<string, string>): string {
  const packages: Record<string, object> = { "": { name: "app", dependencies: root } };
  for (const [name, version] of Object.entries(installed)) {
    packages[`node_modules/${name}`] = { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: "sha512-AAAA" };
  }
  return JSON.stringify({ lockfileVersion: 3, packages });
}

function tree(id: string, files: Record<string, string>): Tree {
  return { id, read: async (path) => files[path], list: async (dir) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`)) };
}

/** Fake osv-scanner from `affected`, fake npm registry where every version of lib and other is old and published by one maintainer. */
function environment(affected: Record<string, string[]>): GateEnvironment {
  const run: RunProcess = async (command, args, options) => {
    if (command !== "osv-scanner") return runProcess(command, args, options);
    if (args[0] === "--version") return { code: 0, stdout: "osv-scanner version: 2.6.0\n", stderr: "" };
    const inventory = JSON.parse(await readFile(args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, ""), "utf8")) as {
      results: Array<{ packages: Array<{ package: { name: string; version: string; ecosystem: string } }> }>;
    };
    const packages = inventory.results[0]!.packages.map(({ package: pkg }) => ({
      package: pkg,
      vulnerabilities: (affected[`${pkg.name}@${pkg.version}`] ?? []).map((id) => ({ id, summary: `${id} summary` })),
    }));
    return { code: 1, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
  };
  const manifest = { _npmUser: { name: "maintainer" }, dist: {} };
  const versions = ["1.0.0", "1.0.1", "1.0.2", "1.1.0"];
  const routes: Record<string, { body: unknown }> = {};
  for (const name of ["lib", "other"]) {
    routes[`https://registry.npmjs.org/${name}`] = {
      body: { time: Object.fromEntries(versions.map((v) => [v, OLD])), versions: Object.fromEntries(versions.map((v) => [v, manifest])) },
    };
    for (const v of versions) routes[`https://registry.npmjs.org/${name}/${v}`] = { body: {} };
  }
  return { run, fetch: fakeFetch(routes), now: () => NOW, osvScanner: "osv-scanner", githubToken: undefined };
}

const PLAN: ChangePlan = {
  topic: "lib",
  malware: false,
  packages: ["npm|lib"],
  severity: "HIGH",
  moves: [{ ecosystem: "npm", name: "lib", from: "1.0.0", to: "1.0.1", mechanism: "npm-direct", locations: ["node_modules/lib"], advisories: ["GHSA-a"], major: false, commitSha: undefined, declaredAs: undefined }],
};

const BASE = tree("b".repeat(40), { "package-lock.json": lock({ lib: "^1.0.0", other: "^1.0.0" }, { lib: "1.0.0", other: "1.0.0" }) });
const AFFECTED = { "lib@1.0.0": ["GHSA-a"] };

async function verify(headLock: string, options: { affected?: Record<string, string[]>; changed?: string[] } = {}) {
  return verifyPlan({
    plan: PLAN,
    base: BASE,
    head: tree("worktree", { "package-lock.json": headLock }),
    env: environment(options.affected ?? AFFECTED),
    gradle: {},
    changedFiles: options.changed ?? ["package.json", "package-lock.json"],
  });
}

describe("verifyPlan", () => {
  it("passes an edit that moved exactly the planned version and fixed its advisories", async () => {
    expect(await verify(lock({ lib: "^1.0.1", other: "^1.0.0" }, { lib: "1.0.1", other: "1.0.0" }))).toEqual([]);
  });

  it("fails a move that landed on another version, or left the targeted advisory in place", async () => {
    expect(await verify(lock({ lib: "^1.0.2", other: "^1.0.0" }, { lib: "1.0.2", other: "1.0.0" }))).toEqual(["lib at node_modules/lib is 1.0.2, not 1.0.1"]);
    // Swapping one vulnerable version for another passes compare (the finding is inherited); not here.
    const still = await verify(lock({ lib: "^1.0.1", other: "^1.0.0" }, { lib: "1.0.1", other: "1.0.0" }), { affected: { ...AFFECTED, "lib@1.0.1": ["GHSA-a"] } });
    expect(still).toEqual(["lib@1.0.1 still has GHSA-a, which the plan was to fix"]);
  });

  it("fails a change to another direct dependency, and a code change for a move that isn't a major", async () => {
    const other = await verify(lock({ lib: "^1.0.1", other: "^1.1.0" }, { lib: "1.0.1", other: "1.1.0" }));
    expect(other).toEqual(["other changed from 1.0.0 to 1.1.0 at package-lock.json#.:other, outside the plan"]);
    const code = await verify(lock({ lib: "^1.0.1", other: "^1.0.0" }, { lib: "1.0.1", other: "1.0.0" }), { changed: ["package-lock.json", "src/index.ts"] });
    expect(code).toEqual(["the edit changed src/index.ts, which only a major move may touch"]);
  });

  it("fails what compare fails: a new finding the edit brings", async () => {
    const problems = await verify(lock({ lib: "^1.0.1", other: "^1.0.0" }, { lib: "1.0.1", other: "1.0.0" }), { affected: { ...AFFECTED, "lib@1.0.1": ["GHSA-new"] } });
    expect(problems).toEqual(["compare: new: lib@1.0.1: GHSA-new has no exception"]);
  });

  it("rejects a change to the gate's own policy first, even for a major", async () => {
    const majorPlan: ChangePlan = { ...PLAN, moves: PLAN.moves.map((move) => ({ ...move, major: true })) };
    const problems = await verifyPlan({
      plan: majorPlan,
      base: BASE,
      head: tree("worktree", { "package-lock.json": lock({ lib: "^1.0.1", other: "^1.0.0" }, { lib: "1.0.1", other: "1.0.0" }) }),
      env: environment(AFFECTED),
      gradle: {},
      changedFiles: ["package-lock.json", ".github/supply-chain-exceptions.json", ".github/workflows/ci.yml"],
    });
    expect(problems).toEqual(["the edit changed .github/supply-chain-exceptions.json, .github/workflows/ci.yml: the gate's own policy, which no plan may change"]);
  });

  it("requires a Gradle move to be declared at exactly `to`, a higher resolution allowed only next to that declaration", async () => {
    const config = (declared: string, resolved: string) => ({
      tree: "worktree",
      builds: [
        {
          build: ".",
          configurations: [
            {
              id: ":runtimeClasspath",
              kind: "project",
              resolved: [{ group: "g", name: "lib", version: resolved }],
              unresolved: [],
              declared: [{ group: "g", name: "lib", version: declared, reason: undefined }],
              error: undefined,
            },
          ],
        },
      ],
    });
    const plan: ChangePlan = {
      topic: "g:lib",
      malware: false,
      packages: ["Maven|g:lib"],
      severity: "HIGH",
      moves: [{ ecosystem: "Maven", name: "g:lib", from: "1.0", to: "1.1", mechanism: "gradle-declared", locations: [":runtimeClasspath"], advisories: [], major: false, commitSha: undefined, declaredAs: undefined }],
    };
    const settings = tree("b".repeat(40), { "settings.gradle": "" });
    const verifyWith = (declared: string, resolved: string) =>
      verifyPlan({
        plan,
        base: settings,
        head: tree("worktree", { "settings.gradle": "" }),
        env: environment({}),
        gradle: { base: config("1.0", "1.0") as never, head: config(declared, resolved) as never },
        changedFiles: ["build.gradle.kts"],
      });
    const overshoot = await verifyWith("1.2", "1.2");
    expect(overshoot).toContain(":runtimeClasspath declares g:lib 1.2, not 1.1");
    const resolvedHigher = await verifyWith("1.1", "1.2");
    // Only the landing checks here (compare can't date g:lib in this fake registry).
    expect(resolvedHigher.filter((problem) => !problem.startsWith("compare:"))).toEqual([]);
  });

  it("rejects an action use that changed outside the plan", async () => {
    const workflow = (ref: string) => `on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/cache@${ref} # v4.2.4\n`;
    const actionPlan: ChangePlan = {
      topic: "actions/checkout",
      malware: false,
      packages: ["GitHub Actions|actions/checkout"],
      severity: "HIGH",
      moves: [],
    };
    const problems = await verifyPlan({
      plan: actionPlan,
      base: tree("b".repeat(40), { ".github/workflows/ci.yml": workflow("a".repeat(40)) }),
      head: tree("worktree", { ".github/workflows/ci.yml": workflow("c".repeat(40)) }),
      env: environment({}),
      gradle: {},
      changedFiles: [],
    });
    expect(problems.filter((problem) => problem.includes("outside the plan"))).toEqual([
      `the action use .github/workflows/ci.yml: actions/cache@${"a".repeat(40)} # v4.2.4 changed outside the plan`,
      `the action use .github/workflows/ci.yml: actions/cache@${"c".repeat(40)} # v4.2.4 changed outside the plan`,
    ]);
  });

  it("lets a planned pin change only its own ref and comment in the workflow", async () => {
    const old = "a".repeat(40);
    const pin = "c".repeat(40);
    const workflow = (trigger: string, ref: string, tag: string) =>
      `on: ${trigger}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${ref} # ${tag}\n`;
    const pinPlan: ChangePlan = {
      topic: "actions/checkout",
      malware: false,
      packages: ["GitHub Actions|actions/checkout"],
      severity: "HIGH",
      moves: [{ ecosystem: "GitHub Actions", name: "actions/checkout", from: "v4.2.2", to: "v4.2.3", mechanism: "action-pin", locations: [".github/workflows/ci.yml"], advisories: [], major: false, commitSha: pin, declaredAs: undefined }],
    };
    const verifyWith = (trigger: string) =>
      verifyPlan({
        plan: pinPlan,
        base: tree("b".repeat(40), { ".github/workflows/ci.yml": workflow("[push, pull_request]", old, "v4.2.2") }),
        head: tree("worktree", { ".github/workflows/ci.yml": workflow(trigger, pin, "v4.2.3") }),
        env: environment({}),
        gradle: {},
        changedFiles: [".github/workflows/ci.yml"],
      });
    expect(await verifyWith("workflow_dispatch")).toEqual([
      "the edit changed .github/workflows/ci.yml beyond its planned action pins: the gate's own policy, which no plan may change",
    ]);
    expect((await verifyWith("[push, pull_request]")).filter((problem) => problem.includes("policy"))).toEqual([]);

    // A line inside a block scalar that only looks like a `uses:` isn't masked: changing it is a policy change.
    const withScript = (line: string, ref: string, tag: string) =>
      `on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${ref} # ${tag}\n      - run: |\n          ${line}\n`;
    const script = await verifyPlan({
      plan: pinPlan,
      base: tree("b".repeat(40), { ".github/workflows/ci.yml": withScript("echo hi", old, "v4.2.2") }),
      head: tree("worktree", { ".github/workflows/ci.yml": withScript("uses: actions/checkout@$(touch${IFS}/tmp/pwn)", pin, "v4.2.3") }),
      env: environment({}),
      gradle: {},
      changedFiles: [".github/workflows/ci.yml"],
    });
    expect(script).toEqual(["the edit changed .github/workflows/ci.yml beyond its planned action pins: the gate's own policy, which no plan may change"]);
  });
});
