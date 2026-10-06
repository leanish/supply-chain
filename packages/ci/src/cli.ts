#!/usr/bin/env node
/**
 * supply-chain: the CI gate.
 *
 *   supply-chain compare --base <rev> [--head <rev>] [--base-gradle <file>] [--head-gradle <file>] [--repo <dir>] [--report <file>]
 *   supply-chain scan [--head <rev> | --head worktree] [--head-gradle <file>] [--repo <dir>] [--report <file>]
 *   supply-chain gradle-inventory --out <file> [--repo <dir>]
 *
 * `compare` (pull requests) fails on findings head adds, on malware anywhere
 * in head, and on added or changed versions that fail the release-age,
 * source or identity checks. `scan` (the default branch) fails on every
 * finding without an exception. Both read files from git objects (or the
 * working tree), never running anything from them; a Gradle build's
 * inventory comes from `gradle-inventory`, which does run the build (in CI, in
 * a job of its own), or inline for `--head worktree`.
 *
 * Exit codes: 0 pass, 1 fail, 2 the gate couldn't complete (also a failure).
 * Environment: OSV_SCANNER (default `osv-scanner` on PATH), GITHUB_TOKEN or
 * GH_TOKEN for the GitHub API, GITHUB_STEP_SUMMARY and GITHUB_ACTIONS in CI,
 * SUPPLY_CHAIN_COMMIT to record the tool's own commit.
 */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { type GateEnvironment, type GateOutcome, runCompare, runScan, treeSources } from "./gate.ts";
import { type GradleInventory, parseGradleInventory, runGradleInventory } from "./gradle.ts";
import { runProcess } from "./process.ts";
import { configDigest, emitReport, REPORT_SCHEMA_VERSION, type Report } from "./report.ts";
import { gitTree, type Tree, workingTree } from "./tree.ts";

const USAGE = `usage:
  supply-chain compare --base <rev> [--head <rev>] [--base-gradle <file>] [--head-gradle <file>] [--repo <dir>] [--report <file>]
  supply-chain scan [--head <rev> | --head worktree] [--head-gradle <file>] [--repo <dir>] [--report <file>]
  supply-chain gradle-inventory --out <file> [--repo <dir>]`;

interface Options {
  base?: string;
  head?: string;
  repo?: string;
  report?: string;
  out?: string;
  "base-gradle"?: string;
  "head-gradle"?: string;
}

export async function main(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = argv;
  let values: Options;
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: {
        base: { type: "string" },
        head: { type: "string" },
        repo: { type: "string" },
        report: { type: "string" },
        out: { type: "string" },
        "base-gradle": { type: "string" },
        "head-gradle": { type: "string" },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const repo = values.repo ?? process.cwd();
  if (command === "gradle-inventory" && values.out !== undefined) return gradleInventoryCommand(repo, values.out);
  if ((command !== "compare" && command !== "scan") || (command === "compare" && values.base === undefined)) {
    console.error(USAGE);
    return 2;
  }
  const gate: GateEnvironment = {
    run: runProcess,
    fetch: (url, init) => fetch(url, init),
    now: () => new Date(),
    osvScanner: env["OSV_SCANNER"] ?? "osv-scanner",
    githubToken: env["GITHUB_TOKEN"] ?? env["GH_TOKEN"],
  };
  const startedAt = new Date();
  let head: Tree | undefined;
  let base: Tree | undefined;
  let outcome: GateOutcome | undefined;
  let error: string | undefined;
  try {
    head = values.head === "worktree" ? workingTree(repo) : await gitTree(repo, values.head ?? "HEAD", runProcess);
    const headBuilds = (await treeSources(head)).gradleBuilds;
    const headGradle = await gradleInput(values["head-gradle"], head, headBuilds, repo);
    if (command === "compare") {
      base = await gitTree(repo, values.base!, runProcess);
      const baseGradle = await gradleInput(values["base-gradle"], base, headBuilds.length > 0 ? undefined : [], repo);
      outcome = await runCompare(base, head, gate, { base: baseGradle, head: headGradle });
    } else {
      outcome = await runScan(head, gate, { head: headGradle });
    }
  } catch (err) {
    error = (err as Error).message;
  }
  const completed = outcome !== undefined;
  const report: Report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: command,
    tool: { commit: env["SUPPLY_CHAIN_COMMIT"], osvScanner: outcome?.osvScannerVersion },
    configDigest: configDigest(outcome?.configText),
    baseSha: base?.id,
    headSha: head?.id ?? values.head ?? "HEAD",
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    completed,
    verdict: completed && outcome!.failures.length === 0 ? "pass" : "fail",
    failures: outcome?.failures ?? [],
    warnings: outcome?.warnings ?? [],
    notes: outcome?.notes ?? [],
    gaps: outcome?.gaps ?? [],
    error,
  };
  await emitReport(report, {
    reportPath: values.report,
    summaryPath: env["GITHUB_STEP_SUMMARY"],
    annotations: env["GITHUB_ACTIONS"] === "true",
    log: (line) => console.log(line),
  });
  if (!completed) return 2;
  return report.verdict === "pass" ? 0 : 1;
}

/**
 * The Gradle inventory for a tree: read from `file` (checked against the
 * tree's commit and, when given, its builds), made inline for the working
 * tree, or none when the tree has no Gradle builds. `builds` undefined: any
 * set (base may have had other builds than head).
 */
async function gradleInput(
  file: string | undefined,
  tree: Tree,
  builds: ReadonlyArray<string> | undefined,
  repo: string,
): Promise<GradleInventory | undefined> {
  if (file !== undefined) return parseGradleInventory(JSON.parse(await readFile(file, "utf8")), tree.id, builds);
  if (builds !== undefined && builds.length === 0) return undefined;
  if (tree.id === "worktree") return runGradleInventory(repo, builds ?? (await treeSources(tree)).gradleBuilds, "worktree", runProcess);
  throw new Error(`${tree.id} has Gradle builds: make its inventory with \`gradle-inventory\` on a checkout and pass it with --${
    builds === undefined ? "base" : "head"
  }-gradle`);
}

/** Runs the Gradle inventory on the checkout at `repo` (clean, at its HEAD commit) and writes it to `out`. */
async function gradleInventoryCommand(repo: string, out: string): Promise<number> {
  try {
    const head = await gitTree(repo, "HEAD", runProcess);
    const dirty = await runProcess("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo });
    if (dirty.code !== 0 || dirty.stdout.trim() !== "") {
      throw new Error("the checkout has changes to tracked files: the inventory wouldn't describe its commit");
    }
    const builds = (await treeSources(head)).gradleBuilds;
    if (builds.length === 0) throw new Error(`${head.id} has no Gradle builds to inventory`);
    const inventory = await runGradleInventory(repo, builds, head.id, runProcess);
    await writeFile(out, `${JSON.stringify(inventory)}\n`);
    console.log(`gradle-inventory: ${inventory.builds.length} build(s) of ${head.id} written to ${out}`);
    return 0;
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`✗ ${(err as Error).message}`);
      process.exit(2);
    },
  );
}
