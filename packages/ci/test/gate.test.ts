import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type GateEnvironment, runCompare, runScan } from "../src/gate.ts";
import { runProcess, type RunProcess } from "../src/process.ts";
import { gitTree, workingTree } from "../src/tree.ts";
import { fakeFetch } from "./fake-fetch.ts";

const NOW = new Date("2026-10-06T12:00:00Z");

function lock(entries: Record<string, string>): string {
  const packages: Record<string, object> = { "": { name: "app" } };
  for (const [name, version] of Object.entries(entries)) {
    packages[`node_modules/${name}`] = { version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: "sha512-AAAA" };
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

/** Fake osv-scanner (answers from `affected`, records every inventory) in front of the real git. */
function environment(affected: Record<string, string[]>, scans: string[][]): GateEnvironment {
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

  it("names a revision git can't resolve", async () => {
    await expect(gitTree(repo, "nope", runProcess)).rejects.toThrow("git can't resolve nope to a commit");
  });
});
