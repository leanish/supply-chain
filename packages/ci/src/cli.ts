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
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { baseSources, type GateEnvironment, type GateOutcome, lenientSources, runCompare, runScan, treeSources } from "./gate.ts";
import { type GradleInventory, parseGradleInventory, runGradleInventory } from "./gradle.ts";
import { runProcess } from "./process.ts";
import type { Fetch } from "./http.ts";
import { configDigest, emitReport, REPORT_SCHEMA_VERSION, type Report } from "./report.ts";
import { parsePlan, planRescan, publishRescan, readVerdicts, verdictSummary } from "./rescan.ts";
import { gitTree, type Tree, workingTree } from "./tree.ts";

const USAGE = `usage:
  supply-chain compare --base <rev> [--head <rev>] [--base-gradle <file>] [--head-gradle <file>] [--repo <dir>] [--report <file>]
  supply-chain scan [--head <rev> | --head worktree] [--head-gradle <file>] [--repo <dir>] [--report <file>]
  supply-chain gradle-inventory --out <file> [--repo <dir>]
  supply-chain npm-signatures [--repo <dir>]
  supply-chain rescan-plan --github-repo <owner/repo> --out <file> [--pr <number>]
  supply-chain rescan-verdict --pr <number> --pr-head <sha> --base <sha> --report <file> --out <file>
  supply-chain publish-rescan --github-repo <owner/repo> --plan <file> --verdicts <dir> --context <name> --started-at <iso> [--target-url <url>]`;

interface Options {
  base?: string;
  head?: string;
  repo?: string;
  report?: string;
  out?: string;
  "base-gradle"?: string;
  "head-gradle"?: string;
  "github-repo"?: string;
  pr?: string;
  "pr-head"?: string;
  plan?: string;
  verdicts?: string;
  context?: string;
  "started-at"?: string;
  "target-url"?: string;
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
        "github-repo": { type: "string" },
        pr: { type: "string" },
        "pr-head": { type: "string" },
        plan: { type: "string" },
        verdicts: { type: "string" },
        context: { type: "string" },
        "started-at": { type: "string" },
        "target-url": { type: "string" },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const repo = values.repo ?? process.cwd();
  if (command === "gradle-inventory" && values.out !== undefined) return gradleInventoryCommand(repo, values.out);
  if (command === "npm-signatures") return npmSignaturesCommand(repo);
  if (command === "rescan-plan" || command === "rescan-verdict" || command === "publish-rescan") return rescanCommand(command, values, env);
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
    const headSources = await treeSources(head);
    const headGradle = await gradleInput(values["head-gradle"], head, headSources.gradleBuilds, "head", repo);
    if (command === "compare") {
      base = await gitTree(repo, values.base!, runProcess);
      const baseBuilds = (await baseSources(base, headSources)).gradleBuilds;
      const baseGradle = await gradleInput(values["base-gradle"], base, baseBuilds, "base", repo);
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
 * tree's commit and builds), made inline for the working tree, or none when
 * the tree has no Gradle builds.
 */
async function gradleInput(
  file: string | undefined,
  tree: Tree,
  builds: ReadonlyArray<string>,
  side: "base" | "head",
  repo: string,
): Promise<GradleInventory | undefined> {
  if (builds.length === 0) {
    if (file !== undefined) throw new Error(`${tree.id} has no Gradle builds, but --${side}-gradle was given`);
    return undefined;
  }
  if (file !== undefined) return parseGradleInventory(JSON.parse(await readFile(file, "utf8")), tree.id, builds);
  if (tree.id === "worktree") return runGradleInventory(repo, builds, "worktree", runProcess);
  throw new Error(`${tree.id} has Gradle builds: make its inventory with \`gradle-inventory\` on a checkout and pass it with --${side}-gradle`);
}

/** Runs the Gradle inventory on the checkout at `repo` (clean, at its HEAD commit) and writes it to `out`. */
async function gradleInventoryCommand(repo: string, out: string): Promise<number> {
  try {
    const head = await gitTree(repo, "HEAD", runProcess);
    const dirty = await runProcess("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo });
    if (dirty.code !== 0 || dirty.stdout.trim() !== "") {
      throw new Error("the checkout has changes to tracked files: the inventory wouldn't describe its commit");
    }
    const builds = (await lenientSources(head)).gradleBuilds;
    if (builds.length === 0) {
      // A base before the first Gradle build: nothing to write, and compare won't ask for it.
      console.log(`gradle-inventory: ${head.id} has no Gradle builds; nothing written`);
      return 0;
    }
    const inventory = await runGradleInventory(repo, builds, head.id, runProcess);
    await writeFile(out, `${JSON.stringify(inventory)}\n`);
    console.log(`gradle-inventory: ${inventory.builds.length} build(s) of ${head.id} written to ${out}`);
    return 0;
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 2;
  }
}

/**
 * After the gate passed: `npm ci --ignore-scripts` next to every lockfile the
 * tree lists (no package code runs), then `npm audit signatures`, which checks
 * the registry signatures and provenance attestations of what was installed.
 */
async function npmSignaturesCommand(repo: string): Promise<number> {
  try {
    const { lockfiles } = await lenientSources(workingTree(repo));
    for (const lockfile of lockfiles) {
      const dir = join(repo, dirname(lockfile));
      for (const args of [["ci", "--ignore-scripts", "--no-audit", "--no-fund"], ["audit", "signatures"]]) {
        const result = await runProcess("npm", args, { cwd: dir });
        process.stdout.write(result.stdout);
        if (result.code !== 0) throw new Error(`npm ${args.join(" ")} in ${dirname(lockfile)} failed: ${result.stderr.trim().split("\n").slice(-3).join(" / ")}`);
      }
    }
    console.log(`npm-signatures: ${lockfiles.length} lockfile(s) installed without scripts and verified`);
    return 0;
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}

async function rescanCommand(command: string, values: Options, env: NodeJS.ProcessEnv): Promise<number> {
  try {
    const token = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"];
    const required = (name: keyof Options): string => {
      const value = values[name];
      if (value === undefined || value === "") throw new Error(`${command} needs --${name}\n${USAGE}`);
      return value;
    };
    if (command === "rescan-verdict") {
      const report = JSON.parse(await readFile(required("report"), "utf8")) as Report;
      const verdict = {
        number: Number(required("pr")),
        head: required("pr-head"),
        base: required("base"),
        completed: report.completed,
        verdict: report.verdict,
        summary: verdictSummary(report),
      };
      await writeFile(required("out"), `${JSON.stringify(verdict)}\n`);
      return 0;
    }
    if (token === undefined) throw new Error(`${command} needs GITHUB_TOKEN`);
    const fetcher: Fetch = (url, init) => fetch(url, init);
    if (command === "rescan-plan") {
      const only = values.pr === undefined || values.pr === "" ? undefined : Number(values.pr);
      const plan = await planRescan({ fetch: fetcher, token, repository: required("github-repo") }, only);
      await writeFile(required("out"), `${JSON.stringify(plan)}\n`);
      console.log(`rescan-plan: ${plan.length} open PR(s)`);
      return 0;
    }
    const plan = parsePlan(JSON.parse(await readFile(required("plan"), "utf8")));
    const posted = await publishRescan(plan, await readVerdicts(required("verdicts")), {
      fetch: fetcher,
      token,
      repository: required("github-repo"),
      context: required("context"),
      startedAt: new Date(required("started-at")),
      targetUrl: values["target-url"],
      log: (line) => console.log(line),
    });
    console.log(`publish-rescan: ${posted} status(es) posted`);
    return 0;
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 1;
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
