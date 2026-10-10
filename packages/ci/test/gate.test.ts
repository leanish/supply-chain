import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type GateEnvironment, runCompare, runScan } from "../src/gate.ts";
import type { GradleInventory } from "../src/gradle.ts";
import { runProcess, type RunProcess } from "../src/process.ts";
import { gitTree, workingTree } from "../src/tree.ts";
import { fakeFetch } from "./fake-fetch.ts";

const NOW = new Date("2026-10-06T12:00:00Z");

function lock(entries: Record<string, string>): string {
  const packages: Record<string, object> = { "": { name: "app" } };
  for (const [name, version] of Object.entries(entries)) {
    packages[`node_modules/${name}`] = { version, resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`, integrity: "sha512-AAAA" };
  }
  return JSON.stringify({ lockfileVersion: 3, packages });
}

let repo: string;
const git = (...args: string[]) =>
  runProcess("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd: repo }).then((result) => {
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  });

async function commit(files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "change");
  return git("rev-parse", "HEAD");
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "supply-chain-gate-"));
  await git("init", "-q", "-b", "main");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** Fake osv-scanner (answers from `affected`, records every inventory) in front of the real git; `routes` add fake HTTP answers. */
function environment(affected: Record<string, string[]>, scans: string[][], routes: Parameters<typeof fakeFetch>[0] = {}): GateEnvironment {
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
  const old = "2026-01-01T00:00:00Z";
  const manifest = { _npmUser: { name: "maintainer" }, dist: {} };
  const fetch = fakeFetch({
    "https://registry.npmjs.org/lib": { body: { time: { "1.0.0": old, "1.1.0": old }, versions: { "1.0.0": manifest, "1.1.0": manifest } } },
    "https://registry.npmjs.org/added": { body: { time: { "2.0.0": old }, versions: { "2.0.0": manifest } } },
    "https://registry.npmjs.org/lib/1.0.0": { body: {} },
    "https://registry.npmjs.org/lib/1.1.0": { body: {} },
    "https://registry.npmjs.org/added/2.0.0": { body: {} },
    "https://registry.npmjs.org/stable/1.0.0": { body: {} },
    "https://repo1.maven.org/maven2/org/xerial/snappy/snappy-java/1.1.10.10/snappy-java-1.1.10.10.pom": {
      headers: { "last-modified": "Mon, 01 Jun 2026 00:00:00 GMT" },
      text: "<project></project>",
    },
    ...routes,
    "https://repo1.maven.org/maven2/org/xerial/snappy/snappy-java/1.1.10.8/snappy-java-1.1.10.8.pom": {
      headers: { "last-modified": "Sat, 19 Jul 2025 21:17:47 GMT" },
      text: "<project></project>",
    },
  });
  return { run, fetch, now: () => NOW, osvScanner: "osv-scanner", githubToken: undefined };
}

describe("gate", () => {
  it("compares base and head against one scan of their union, failing only what head adds", async () => {
    const base = await commit({ "package-lock.json": lock({ lib: "1.0.0", stable: "1.0.0" }) });
    const head = await commit({ "package-lock.json": lock({ lib: "1.1.0", stable: "1.0.0", added: "2.0.0" }) });
    const scans: string[][] = [];
    const affected = { "lib@1.0.0": ["GHSA-fixed"], "stable@1.0.0": ["GHSA-shared"], "added@2.0.0": ["GHSA-new"] };
    const outcome = await runCompare(await gitTree(repo, base, runProcess), await gitTree(repo, head, runProcess), environment(affected, scans));
    expect(scans).toEqual([["added@2.0.0", "lib@1.0.0", "lib@1.1.0", "stable@1.0.0"]]);
    expect(outcome.failures).toEqual(["new: added@2.0.0: GHSA-new has no exception"]);
    expect(outcome.warnings).toEqual(["inherited: stable@1.0.0: GHSA-shared GHSA-shared summary"]);
    expect(outcome.notes).toEqual(["fixed: lib@1.0.0: GHSA-fixed GHSA-fixed summary"]);
    expect(outcome.gaps).toHaveLength(4);
    expect(outcome.osvScannerVersion).toBe("2.6.0");
  });

  it("reads config and exceptions from head, and lets an exception cover what head adds", async () => {
    const base = await commit({ "package-lock.json": lock({ stable: "1.0.0" }) });
    const exceptions = {
      vulnerabilities: [
        { id: "GHSA-new", package: "added", version: "2.0.0", paths: ["node_modules/added"], reason: "dev only", expires: "2026-12-31" },
      ],
    };
    const head = await commit({
      "package-lock.json": lock({ stable: "1.0.0", added: "2.0.0" }),
      ".github/supply-chain-exceptions.json": JSON.stringify(exceptions),
    });
    const outcome = await runCompare(
      await gitTree(repo, base, runProcess),
      await gitTree(repo, head, runProcess),
      environment({ "added@2.0.0": ["GHSA-new"] }, []),
    );
    expect(outcome.failures).toEqual([]);
  });

  it("scans every finding of one tree, and fails a configured lockfile that's missing or unknown config", async () => {
    const head = await commit({ "package-lock.json": lock({ stable: "1.0.0" }) });
    const outcome = await runScan(await gitTree(repo, head, runProcess), environment({ "stable@1.0.0": ["GHSA-shared"] }, []));
    expect(outcome.failures).toEqual(["stable@1.0.0: GHSA-shared has no exception"]);

    await commit({ ".github/supply-chain.json": JSON.stringify({ npm: { lockfiles: ["package-lock.json", "tools/package-lock.json"] } }) });
    await expect(runScan(workingTree(repo), environment({}, []))).rejects.toThrow(
      "tools/package-lock.json isn't in worktree, but supply-chain.json lists it",
    );
    await commit({ ".github/supply-chain.json": JSON.stringify({ npm: { lockfile: "x" } }) });
    await expect(runScan(workingTree(repo), environment({}, []))).rejects.toThrow("unknown field(s): lockfile");
  });

  it("treats a lockfile base doesn't have yet as empty", async () => {
    const base = await commit({ "package-lock.json": lock({ stable: "1.0.0" }) });
    const head = await commit({
      "tools/package-lock.json": lock({ lib: "1.1.0" }),
      ".github/supply-chain.json": JSON.stringify({ npm: { lockfiles: ["package-lock.json", "tools/package-lock.json"] } }),
    });
    const outcome = await runCompare(
      await gitTree(repo, base, runProcess),
      await gitTree(repo, head, runProcess),
      environment({ "lib@1.1.0": ["GHSA-tool"] }, []),
    );
    expect(outcome.failures).toEqual(["new: lib@1.1.0: GHSA-tool has no exception"]);
  });

  it("compares Gradle inventories too, and fails on a hole in either side's resolution", async () => {
    const base = await commit({ "build.gradle.kts": "plugins { java }\n" });
    const head = await commit({ "build.gradle.kts": "plugins { java }\n// snappy 1.1.10.10\n" });
    const gradle = (tree: string, version: string, unresolved: object[] = []): GradleInventory => ({
      schemaVersion: 1,
      tree,
      builds: [
        {
          build: ".",
          configurations: [
            {
              id: ":runtimeClasspath",
              kind: "project",
              resolved: [{ group: "org.xerial.snappy", name: "snappy-java", version }],
              unresolved: unresolved as never,
              declared: [],
              error: undefined,
            },
          ],
        },
      ],
    });
    const affected = { "org.xerial.snappy:snappy-java@1.1.10.8": ["GHSA-wmgv-28fv-894x"] };
    const baseTree = await gitTree(repo, base, runProcess);
    const headTree = await gitTree(repo, head, runProcess);
    const outcome = await runCompare(baseTree, headTree, environment(affected, []), {
      base: gradle(base, "1.1.10.8"),
      head: gradle(head, "1.1.10.10"),
    });
    expect(outcome.failures).toEqual([]);
    expect(outcome.notes).toEqual(["fixed: org.xerial.snappy:snappy-java@1.1.10.8: GHSA-wmgv-28fv-894x GHSA-wmgv-28fv-894x summary"]);
    const holed = await runCompare(baseTree, headTree, environment(affected, []), {
      base: gradle(base, "1.1.10.8", [{ requested: "com.acme:gone:1.0", failure: "not found" }]),
      head: gradle(head, "1.1.10.10"),
    });
    expect(holed.failures).toEqual(["base: Gradle :runtimeClasspath couldn't resolve com.acme:gone:1.0: not found"]);
    await expect(runCompare(baseTree, headTree, environment(affected, []))).rejects.toThrow(
      "has Gradle builds (.), but no Gradle inventory was given for it",
    );
  });

  it("gives each side its own sources: head may add the first Gradle build, or remove the last", async () => {
    const npmOnly = await commit({ "package-lock.json": lock({ stable: "1.0.0" }) });
    const withGradle = await commit({ "build.gradle.kts": "plugins { java }\n" });
    const inventory = (tree: string): GradleInventory => ({
      schemaVersion: 1,
      tree,
      builds: [
        {
          build: ".",
          configurations: [
            {
              id: ":runtimeClasspath",
              kind: "project",
              resolved: [{ group: "org.xerial.snappy", name: "snappy-java", version: "1.1.10.8" }],
              unresolved: [],
              declared: [],
              error: undefined,
            },
          ],
        },
      ],
    });
    const affected = { "org.xerial.snappy:snappy-java@1.1.10.8": ["GHSA-wmgv-28fv-894x"] };
    const npmTree = await gitTree(repo, npmOnly, runProcess);
    const gradleTree = await gitTree(repo, withGradle, runProcess);
    // Adding the first build: no base inventory exists, nor is one needed; its findings are new.
    const added = await runCompare(npmTree, gradleTree, environment(affected, []), { head: inventory(withGradle) });
    expect(added.failures).toEqual(["new: org.xerial.snappy:snappy-java@1.1.10.8: GHSA-wmgv-28fv-894x has no exception"]);
    // Removing the last build: base's inventory still counts, so what it had is fixed.
    const removed = await runCompare(gradleTree, npmTree, environment(affected, []), { base: inventory(withGradle) });
    expect(removed.notes).toEqual(["fixed: org.xerial.snappy:snappy-java@1.1.10.8: GHSA-wmgv-28fv-894x GHSA-wmgv-28fv-894x summary"]);
    await expect(runCompare(gradleTree, npmTree, environment(affected, []))).rejects.toThrow("no Gradle inventory was given for it");
  });

  it("checks workflows' actions: a new advisory on a changed action fails, so does an unpinned new one", async () => {
    const old = "11bd71901bbe5b1630ceea73d27597364c9af683";
    const current = "3d3c42e5aac5ba805825da76410c181273ba90b1";
    const workflow = (lines: string) => `on: pull_request\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n${lines}`;
    const base = await commit({
      "package-lock.json": lock({ stable: "1.0.0" }),
      ".github/workflows/ci.yml": workflow(`      - uses: actions/checkout@${old} # v4.2.2\n`),
    });
    const head = await commit({
      ".github/workflows/ci.yml": workflow(`      - uses: actions/checkout@${current} # v7.0.1\n      - uses: actions/setup-node@v7\n`),
    });
    const api = "https://api.github.com";
    const affects = (version: string, type: string) =>
      `${api}/advisories?ecosystem=actions&affects=${encodeURIComponent(`actions/checkout@${version}`)}&type=${type}&per_page=100`;
    const routes = {
      [`${api}/repos/actions/checkout/git/ref/tags/v4.2.2`]: { body: { object: { type: "commit", sha: old } } },
      [`${api}/repos/actions/checkout/git/ref/tags/v7.0.1`]: { body: { object: { type: "commit", sha: current } } },
      [`${api}/repos/actions/checkout/releases?per_page=100&page=1`]: {
        body: [
          { tag_name: "v7.0.1", published_at: "2026-04-10T17:31:14Z" },
          { tag_name: "v4.2.2", published_at: "2024-10-23T14:46:00Z" },
        ],
      },
      [affects("v4.2.2", "reviewed")]: { body: [] },
      [affects("v4.2.2", "malware")]: { body: [] },
      [affects("v7.0.1", "reviewed")]: { body: [{ ghsa_id: "GHSA-new-in-v7", summary: "made up", severity: "low" }] },
      [affects("v7.0.1", "malware")]: { body: [] },
      [`${api}/repos/actions/checkout/security-advisories?state=published&per_page=100`]: { body: [] },
    };
    const outcome = await runCompare(await gitTree(repo, base, runProcess), await gitTree(repo, head, runProcess), environment({}, [], routes));
    expect(outcome.failures).toEqual([
      "new: actions/checkout@v7.0.1: GHSA-new-in-v7 has no exception",
      "actions/setup-node@v7 (.github/workflows/ci.yml) is new or changed, so it must be pinned to a full commit SHA with a `# vX.Y.Z` comment",
    ]);
  });

  it("reads workflows from git objects whatever their names, and takes a shell-only workflow as something to check", async () => {
    const head = await commit({ ".github/workflows/déploiement ✓.yml": "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n" });
    const tree = await gitTree(repo, head, runProcess);
    expect(await tree.list(".github/workflows")).toEqual([".github/workflows/déploiement ✓.yml"]);
    const outcome = await runScan(tree, environment({}, []));
    expect(outcome.failures).toEqual([]);
  });

  it("names a revision git can't resolve", async () => {
    await expect(gitTree(repo, "nope", runProcess)).rejects.toThrow("git can't resolve nope to a commit");
  });
});
