import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bumpCandidates, type SecurityFix, securityCandidates } from "../src/candidates.ts";
import type { GateEnvironment } from "../src/gate.ts";
import { runProcess, type RunProcess } from "../src/process.ts";
import { workingTree } from "../src/tree.ts";
import { fakeFetch } from "./fake-fetch.ts";

const NOW = new Date("2026-10-07T12:00:00Z");
const OLD = "2026-01-01T00:00:00Z";
const YESTERDAY = "2026-10-06T00:00:00Z";

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "supply-chain-candidates-"));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function tree(locked: Record<string, string>, files: Record<string, string> = {}, root: object = { name: "app" }, extra: Record<string, object> = {}) {
  const packages: Record<string, object> = { "": root, ...extra };
  for (const [name, version] of Object.entries(locked)) {
    packages[`node_modules/${name}`] = { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: "sha512-AAAA" };
  }
  await writeFile(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  return workingTree(repo);
}

/** Every version of `name` the registry lists, with its publish time. */
type Registry = Record<string, Record<string, string>>;

/** Fake osv-scanner answering from `affected` (`name@version` → ids), fake npm registry from `registry`; records scans. */
function environment(affected: Record<string, string[]>, registry: Registry, scans: string[][] = []): GateEnvironment {
  const run: RunProcess = async (command, args, options) => {
    if (command !== "osv-scanner") return runProcess(command, args, options);
    if (args[0] === "--version") return { code: 0, stdout: "osv-scanner version: 2.6.0\n", stderr: "" };
    const inventory = JSON.parse(await readFile(args[args.indexOf("--lockfile") + 1]!.replace(/^osv-scanner:/, ""), "utf8")) as {
      results: Array<{ packages: Array<{ package: { name: string; version: string; ecosystem: string } }> }>;
    };
    const requested = inventory.results[0]!.packages.map(({ package: pkg }) => pkg);
    scans.push(requested.map((pkg) => `${pkg.name}@${pkg.version}`).sort());
    const packages = requested.map((pkg) => ({
      package: pkg,
      vulnerabilities: (affected[`${pkg.name}@${pkg.version}`] ?? []).map((id) => ({ id, summary: `${id} summary` })),
    }));
    return { code: 1, stdout: JSON.stringify({ results: [{ packages }] }), stderr: "" };
  };
  const manifest = { _npmUser: { name: "maintainer" }, dist: {} };
  const routes = Object.fromEntries(
    Object.entries(registry).flatMap(([name, versions]) => [
      [
        `https://registry.npmjs.org/${name.replace("/", "%2F")}`,
        { body: { time: versions, versions: Object.fromEntries(Object.keys(versions).map((version) => [version, manifest])) } },
      ],
      // Each version's manifest, for its source repository (none here).
      ...Object.keys(versions).map((version) => [`https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`, { body: {} }]),
    ]),
  );
  return { run, fetch: fakeFetch(routes), now: () => NOW, osvScanner: "osv-scanner", githubToken: undefined };
}

function moves(fixes: ReadonlyArray<SecurityFix>): Array<[string, string | undefined, string | undefined]> {
  return fixes.map((fix) => [`${fix.name}@${fix.from}`, fix.to?.version, fix.problem]);
}

describe("securityCandidates", () => {
  it("picks the lowest aged fix in the version's own line, scanning every candidate with it in one snapshot", async () => {
    const scans: string[][] = [];
    const affected = { "lib@1.0.0": ["GHSA-a"], "lib@1.0.1": ["GHSA-a"] };
    const registry = { lib: { "1.0.0": OLD, "1.0.1": OLD, "1.0.2": OLD, "1.1.0": OLD, "2.0.0": OLD } };
    const found = await securityCandidates(await tree({ lib: "1.0.0" }), environment(affected, registry, scans));
    expect(found.fixes).toEqual([
      {
        ecosystem: "npm",
        name: "lib",
        from: "1.0.0",
        locations: ["node_modules/lib"],
        targets: ["GHSA-a"],
        unfixable: [],
        malicious: false,
        to: { version: "1.0.2", line: "1", aged: true, major: false },
        problem: undefined,
      },
    ]);
    expect(scans).toEqual([["lib@1.0.0"], ["lib@1.0.0", "lib@1.0.1", "lib@1.0.2", "lib@1.1.0", "lib@2.0.0"]]);
  });

  it("takes a young fix when no fix in the line is old enough, and prefers a young backport to an aged major", async () => {
    const affected = { "lib@1.9.4": ["GHSA-a"] };
    const registry = { lib: { "1.9.4": OLD, "1.9.5": YESTERDAY, "2.0.0": OLD } };
    const found = await securityCandidates(await tree({ lib: "1.9.4" }), environment(affected, registry));
    expect(found.fixes[0]?.to).toEqual({ version: "1.9.5", line: "1", aged: false, major: false });
  });

  it("moves to the lowest fixing major when only a major fixes, flagged for the agent", async () => {
    const affected = { "lib@1.0.0": ["GHSA-a"], "lib@1.5.0": ["GHSA-a"] };
    const registry = { lib: { "1.0.0": OLD, "1.5.0": OLD, "2.0.0": YESTERDAY, "2.1.0": OLD, "3.0.0": OLD } };
    const found = await securityCandidates(await tree({ lib: "1.0.0" }), environment(affected, registry));
    expect(found.fixes[0]?.to).toEqual({ version: "2.1.0", line: "2", aged: true, major: true });
  });

  it("fixes A and leaves B when nothing fixes B, never adding an advisory", async () => {
    const affected = { "lib@1.0.0": ["GHSA-a", "GHSA-b"], "lib@1.0.1": ["GHSA-b", "GHSA-new"], "lib@1.0.2": ["GHSA-b"], "lib@1.0.3": [] };
    const registry = { lib: { "1.0.0": OLD, "1.0.1": OLD, "1.0.2": OLD } };
    const found = await securityCandidates(await tree({ lib: "1.0.0" }), environment(affected, registry));
    expect(found.fixes[0]).toMatchObject({ targets: ["GHSA-a", "GHSA-b"], unfixable: ["GHSA-b"], to: { version: "1.0.2" } });
  });

  it("leaves a malicious version for the nearest clean aged one: newer in its line, else older, else a newer line", async () => {
    const affected = { "evil@1.0.1": ["MAL-2026-1"], "evil@1.0.2": ["MAL-2026-1"] };
    const newer = await securityCandidates(
      await tree({ evil: "1.0.1" }),
      environment(affected, { evil: { "1.0.0": OLD, "1.0.1": OLD, "1.0.2": OLD, "1.0.3": YESTERDAY, "1.0.4": OLD } }),
    );
    expect(newer.fixes[0]).toMatchObject({ malicious: true, to: { version: "1.0.4", aged: true, major: false } });
    const older = await securityCandidates(
      await tree({ evil: "1.0.1" }),
      environment(affected, { evil: { "0.9.0": OLD, "1.0.0": OLD, "1.0.1": OLD, "1.0.2": OLD, "2.0.0": OLD } }),
    );
    expect(older.fixes[0]?.to?.version).toBe("1.0.0");
    const none = await securityCandidates(await tree({ evil: "1.0.1" }), environment(affected, { evil: { "1.0.1": OLD, "1.0.3": YESTERDAY } }));
    expect(moves(none.fixes)).toEqual([["evil@1.0.1", undefined, "no clean version of evil at least 7 days old to leave the malicious 1.0.1 for"]]);
  });

  it("lets own packages skip the wait, and leaves excepted findings alone", async () => {
    const affected = { "@acme/lib@1.0.0": ["GHSA-a"], "other@1.0.0": ["GHSA-x"] };
    const registry = { "@acme/lib": { "1.0.0": OLD, "1.0.1": YESTERDAY, "1.0.2": OLD }, other: { "1.0.0": OLD, "1.0.1": OLD } };
    const exceptions = {
      vulnerabilities: [{ id: "GHSA-x", package: "other", version: "1.0.0", paths: ["node_modules/other"], reason: "dev only", expires: "2026-12-31" }],
    };
    const head = await tree(
      { "@acme/lib": "1.0.0", other: "1.0.0" },
      {
        ".github/supply-chain.json": JSON.stringify({ ownPackages: { npm: { scopes: ["@acme"] } } }),
        ".github/supply-chain-exceptions.json": JSON.stringify(exceptions),
      },
    );
    const found = await securityCandidates(head, environment(affected, registry));
    expect(moves(found.fixes)).toEqual([["@acme/lib@1.0.0", "1.0.1", undefined]]);
  });

  it("says why when nothing fixes, or an older fix's publish time is unknown", async () => {
    const affected = { "lib@1.0.0": ["GHSA-a"], "lib@1.1.0": ["GHSA-a"], "odd@1.0.0": ["GHSA-o"] };
    const registry = { lib: { "1.0.0": OLD, "1.1.0": OLD }, odd: { "1.0.0": OLD, "1.0.2": OLD } };
    const head = await tree({ lib: "1.0.0", odd: "1.0.0" });
    const env = environment(affected, registry);
    const withUndated: GateEnvironment = {
      ...env,
      fetch: async (url, init) => {
        if (url === "https://registry.npmjs.org/odd") {
          const manifest = { _npmUser: { name: "maintainer" }, dist: {} };
          const body = { time: { "1.0.0": OLD, "1.0.2": OLD }, versions: { "1.0.0": manifest, "1.0.1": manifest, "1.0.2": manifest } };
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
        }
        return env.fetch(url, init);
      },
    };
    const found = await securityCandidates(head, withUndated);
    expect(moves(found.fixes)).toEqual([
      ["lib@1.0.0", undefined, "no version above 1.0.0 fixes GHSA-a"],
      ["odd@1.0.0", undefined, "the publish time of 1.0.1 (fixing, line 1) is unknown, so the rule can't tell which fix is old enough"],
    ]);
  });
});

describe("bumpCandidates", () => {
  it("moves each direct dependency to its line's highest aged version and its highest newer line's, leaving transitives alone", async () => {
    const scans: string[][] = [];
    const registry = {
      lib: { "1.0.0": OLD, "1.2.0": OLD, "1.3.0": YESTERDAY, "2.0.0": OLD, "3.0.0": OLD, "3.1.0": OLD },
      dev: { "0.5.0": OLD, "0.5.1": OLD, "0.6.0": OLD },
      transitive: { "1.0.0": OLD, "1.5.0": OLD },
    };
    const head = await tree({ lib: "1.0.0", dev: "0.5.0", transitive: "1.0.0" }, {}, { name: "app", dependencies: { lib: "^1.0.0" }, devDependencies: { dev: "~0.5.0" } });
    const found = await bumpCandidates(head, environment({}, registry, scans));
    expect(found.bumps).toEqual([
      // npm's caret line for 0.x is the minor: 0.6.0 is a "major" move.
      { ecosystem: "npm", name: "dev", from: "0.5.0", locations: ["package-lock.json#."], minor: { version: "0.5.1", line: "0.5" }, major: { version: "0.6.0", line: "0.6" }, problems: [] },
      {
        ecosystem: "npm",
        name: "lib",
        from: "1.0.0",
        locations: ["package-lock.json#."],
        minor: { version: "1.2.0", line: "1" },
        major: { version: "3.1.0", line: "3" },
        problems: [],
      },
    ]);
    expect(scans[1]).toEqual(["dev@0.5.0", "dev@0.5.1", "dev@0.6.0", "lib@1.0.0", "lib@1.2.0", "lib@3.0.0", "lib@3.1.0"]);
  });

  it("skips versions that add an advisory or malware, and says so when a whole line does", async () => {
    const affected = { "lib@1.2.0": ["GHSA-new"], "lib@2.0.0": ["MAL-2026-9"], "lib@1.0.0": ["GHSA-old"], "lib@1.1.0": ["GHSA-old"] };
    const registry = { lib: { "1.0.0": OLD, "1.1.0": OLD, "1.2.0": OLD, "2.0.0": OLD } };
    const head = await tree({ lib: "1.0.0" }, {}, { name: "app", dependencies: { lib: "^1.0.0" } });
    const found = await bumpCandidates(head, environment(affected, registry));
    expect(found.bumps).toEqual([
      {
        ecosystem: "npm",
        name: "lib",
        from: "1.0.0",
        locations: ["package-lock.json#."],
        minor: { version: "1.1.0", line: "1" },
        major: undefined,
        problems: ["each of the 1 newest versions of line 2 old enough adds an advisory or is malicious"],
      },
    ]);
  });

  it("reads workspaces' own copies, lets own packages skip the wait, and ignores non-registry specs", async () => {
    const registry = { "@acme/kit": { "1.0.0": OLD, "1.0.1": YESTERDAY }, shared: { "2.0.0": OLD, "2.1.0": OLD } };
    const head = await tree(
      { "@acme/kit": "1.0.0", shared: "2.1.0" },
      { ".github/supply-chain.json": JSON.stringify({ ownPackages: { npm: { scopes: ["@acme"] } } }) },
      { name: "app", workspaces: ["tools/x"], dependencies: { "@acme/kit": "^1.0.0", local: "file:../local" } },
      {
        "tools/x": { name: "x", dependencies: { shared: "^2.0.0", gh: "github:owner/repo" } },
        "tools/x/node_modules/shared": { version: "2.0.0", resolved: "https://registry.npmjs.org/shared/-/shared-2.0.0.tgz", integrity: "sha512-AAAA" },
        "node_modules/x": { resolved: "tools/x", link: true },
      },
    );
    const found = await bumpCandidates(head, environment({}, registry));
    expect(found.bumps.map((bump) => [bump.name, bump.from, bump.locations, bump.minor?.version])).toEqual([
      ["@acme/kit", "1.0.0", ["package-lock.json#."], "1.0.1"],
      ["shared", "2.0.0", ["package-lock.json#tools/x"], "2.1.0"],
    ]);
  });
});
