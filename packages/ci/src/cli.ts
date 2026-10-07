#!/usr/bin/env node
/**
 * supply-chain: the CI gate.
 *
 *   supply-chain compare --base <rev> [--head <rev>] [--base-gradle <file>] [--head-gradle <file>] [--repo <dir>] [--report <file>]
 *   supply-chain scan [--head <rev> | --head worktree] [--head-gradle <file>] [--repo <dir>] [--report <file>]
 *   supply-chain gradle-inventory --out <file> [--head worktree] [--repo <dir>]
 *   supply-chain candidates --rule security|bump [--head <rev> | --head worktree] [--head-gradle <file>] [--repo <dir>] [--out <file>]
 *
 * `compare` (pull requests) fails on findings head adds, on malware anywhere
 * in head, and on added or changed versions that fail the release-age,
 * source or identity checks. `scan` (the default branch) fails on every
 * finding without an exception. Both read files from git objects (or the
 * working tree), never running anything from them; a Gradle build's
 * inventory comes from `gradle-inventory`, which does run the build (in CI, in
 * a job of its own), or inline for `--head worktree`. `candidates` prints, as
 * JSON, where to move versions: `--rule security`, the fix the rule picks for
 * every version a scan fails on (secure-it); `--rule bump`, the highest
 * acceptable version of every direct dependency, in its line and the highest
 * newer one (bump-it).
 *
 * Exit codes: 0 pass, 1 fail, 2 the gate couldn't complete (also a failure).
 * Environment: OSV_SCANNER (default `osv-scanner` on PATH), GITHUB_TOKEN or
 * GH_TOKEN for the GitHub API, GITHUB_STEP_SUMMARY and GITHUB_ACTIONS in CI,
 * SUPPLY_CHAIN_COMMIT to record the tool's own commit.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { bumpCandidates, securityCandidates } from "./candidates.ts";
import { baseSources, type GateEnvironment, type GateOutcome, lenientSources, runCompare, runScan, treeSources } from "./gate.ts";
import { type GradleInventory, parseGradleInventory, runGradleInventory } from "./gradle.ts";
import { runProcess, withoutCredentials } from "./process.ts";
import { type Fetch, namingFailures } from "./http.ts";
import { configDigest, emitReport, REPORT_SCHEMA_VERSION, type Report } from "./report.ts";
import { parsePlan, planRescan, type RescanSteps, runRescan } from "./rescan.ts";
import { gitTree, type Tree, workingTree } from "./tree.ts";

const PREPARE_PR = fileURLToPath(new URL("../scripts/prepare-pr.sh", import.meta.url));

const USAGE = `usage:
  supply-chain candidates --rule security|bump [--head <rev> | --head worktree] [--head-gradle <file>] [--repo <dir>] [--out <file>]
  supply-chain compare --base <rev> [--head <rev>] [--base-gradle <file>] [--head-gradle <file>] [--repo <dir>] [--report <file>]
  supply-chain scan [--head <rev> | --head worktree] [--head-gradle <file>] [--repo <dir>] [--report <file>]
  supply-chain gradle-inventory --out <file> [--head worktree] [--repo <dir>]
  supply-chain npm-signatures [--repo <dir>]
  supply-chain rescan-plan --github-repo <owner/repo> --out <file> [--pr <number>]
  supply-chain rescan --github-repo <owner/repo> --plan <file> --inventories <dir> --context <name> --started-at <iso> [--repo <dir>] [--reports <dir>] [--target-url <url>]`;

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
  rule?: string;
  plan?: string;
  inventories?: string;
  reports?: string;
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
        rule: { type: "string" },
        plan: { type: "string" },
        inventories: { type: "string" },
        reports: { type: "string" },
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
  const repo = resolve(values.repo ?? process.cwd());
  if (command === "gradle-inventory" && values.out !== undefined) return gradleInventoryCommand(repo, values.out, values.head);
  if (command === "npm-signatures") return npmSignaturesCommand(repo);
  if (command === "candidates") return candidatesCommand(values, env, repo);
  if (command === "rescan-plan" || command === "rescan") return rescanCommand(command, values, env, repo);
  if ((command !== "compare" && command !== "scan") || (command === "compare" && values.base === undefined)) {
    console.error(USAGE);
    return 2;
  }
  const gate: GateEnvironment = {
    run: runProcess,
    fetch: namingFailures((url, init) => fetch(url, init)),
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
    if (command === "compare") {
      base = await gitTree(repo, values.base!, runProcess);
      outcome = await compareTrees(base, head, gate, { base: values["base-gradle"], head: values["head-gradle"] }, repo);
    } else {
      const headGradle = await gradleInput(values["head-gradle"], head, (await treeSources(head)).gradleBuilds, "head", repo);
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
    prHeadSha: undefined,
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
 * Where to move versions, as JSON, written to `--out` or printed: the security fixes (`--rule security`, for
 * secure-it) or the bumps of direct dependencies (`--rule bump`, for bump-it). Exits 0 when it could tell, whatever
 * it found; 2 when it couldn't, including an incomplete inventory (the JSON is still written, with `incomplete`).
 */
async function candidatesCommand(values: Options, env: NodeJS.ProcessEnv, repo: string): Promise<number> {
  if (values.rule !== "security" && values.rule !== "bump") {
    console.error(`candidates needs --rule security or --rule bump\n${USAGE}`);
    return 2;
  }
  try {
    const gate: GateEnvironment = {
      run: runProcess,
      fetch: namingFailures((url, init) => fetch(url, init)),
      now: () => new Date(),
      osvScanner: env["OSV_SCANNER"] ?? "osv-scanner",
      githubToken: env["GITHUB_TOKEN"] ?? env["GH_TOKEN"],
    };
    const head = values.head === "worktree" ? workingTree(repo) : await gitTree(repo, values.head ?? "HEAD", runProcess);
    const headGradle = await gradleInput(values["head-gradle"], head, (await treeSources(head)).gradleBuilds, "head", repo);
    const found = values.rule === "security" ? await securityCandidates(head, gate, { head: headGradle }) : await bumpCandidates(head, gate, { head: headGradle });
    // The in-process peer planner is for remediation tools, not the JSON report.
    const json = `${JSON.stringify({ tree: head.id, ...found, npmPeers: undefined }, null, 2)}\n`;
    if (values.out === undefined) process.stdout.write(json);
    else await writeFile(values.out, json);
    for (const problem of found.incomplete) console.error(`✗ incomplete inventory: ${problem}`);
    return found.incomplete.length === 0 ? 0 : 2;
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 2;
  }
}

/** `compare` on two trees, each side's Gradle inventory read from its file (or made inline for the working tree). */
async function compareTrees(
  base: Tree,
  head: Tree,
  gate: GateEnvironment,
  files: { base: string | undefined; head: string | undefined },
  repo: string,
): Promise<GateOutcome> {
  const headSources = await treeSources(head);
  const headGradle = await gradleInput(files.head, head, headSources.gradleBuilds, "head", repo);
  const baseGradle = await gradleInput(files.base, base, (await baseSources(base, headSources)).gradleBuilds, "base", repo);
  return runCompare(base, head, gate, { base: baseGradle, head: headGradle });
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

/** Runs the Gradle inventory on the checkout at `repo` (clean, at its HEAD commit, or its working tree) and writes it to `out`. */
async function gradleInventoryCommand(repo: string, out: string, which: string | undefined): Promise<number> {
  try {
    if (which !== undefined && which !== "worktree") throw new Error(`gradle-inventory inventories HEAD or, with --head worktree, the working tree; got --head ${which}`);
    // The working tree as it is (an edit not committed yet, for secure-it and bump-it), or the checkout's clean HEAD.
    const head = which === "worktree" ? workingTree(repo) : await gitTree(repo, "HEAD", runProcess);
    if (which === undefined) {
      const dirty = await runProcess("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo });
      if (dirty.code !== 0 || dirty.stdout.trim() !== "") {
        throw new Error("the checkout has changes to tracked files: the inventory wouldn't describe its commit");
      }
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
 * The problems, if any.
 */
async function npmSignatures(repo: string): Promise<string[]> {
  const { lockfiles } = await lenientSources(workingTree(repo));
  const env = withoutCredentials(process.env);
  for (const lockfile of lockfiles) {
    const dir = join(repo, dirname(lockfile));
    for (const args of [["ci", "--ignore-scripts", "--no-audit", "--no-fund"], ["audit", "signatures"]]) {
      const result = await runProcess("npm", args, { cwd: dir, env });
      process.stdout.write(result.stdout);
      if (result.code !== 0) {
        return [`npm ${args.join(" ")} in ${dirname(lockfile)} failed: ${result.stderr.trim().split("\n").slice(-3).join(" / ")}`];
      }
    }
  }
  return [];
}

async function npmSignaturesCommand(repo: string): Promise<number> {
  try {
    const problems = await npmSignatures(repo);
    for (const problem of problems) console.error(`✗ ${problem}`);
    if (problems.length === 0) console.log("npm-signatures: every lockfile installed without scripts and verified");
    return problems.length === 0 ? 0 : 1;
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
}

async function rescanCommand(command: string, values: Options, env: NodeJS.ProcessEnv, repo: string): Promise<number> {
  try {
    const token = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"];
    const required = (name: keyof Options): string => {
      const value = values[name];
      if (value === undefined || value === "") throw new Error(`${command} needs --${name}\n${USAGE}`);
      return value;
    };
    if (token === undefined) throw new Error(`${command} needs GITHUB_TOKEN`);
    const fetcher: Fetch = namingFailures((url, init) => fetch(url, init));
    if (command === "rescan-plan") {
      const only = values.pr === undefined || values.pr === "" ? undefined : Number(values.pr);
      const plan = await planRescan({ fetch: fetcher, token, repository: required("github-repo") }, only);
      await writeFile(required("out"), `${JSON.stringify(plan)}\n`);
      console.log(`rescan-plan: ${plan.length} open PR(s)`);
      return 0;
    }
    const plan = parsePlan(JSON.parse(await readFile(required("plan"), "utf8")));
    const gate: GateEnvironment = {
      run: runProcess,
      fetch: fetcher,
      now: () => new Date(),
      osvScanner: env["OSV_SCANNER"] ?? "osv-scanner",
      githubToken: token,
    };
    if (values.reports !== undefined) await mkdir(values.reports, { recursive: true });
    const steps: RescanSteps = {
      async prepare(pr) {
        const result = await runProcess(PREPARE_PR, [String(pr.number), pr.head, pr.base], {
          cwd: repo,
          env: { ...withoutCredentials(env), GIT_FETCH_TOKEN: token },
        });
        if (result.code !== 0) throw new Error(`merging #${pr.number} onto its base failed: ${result.stderr.trim().split("\n").at(-1) ?? ""}`);
        const out = Object.fromEntries(result.stdout.trim().split("\n").map((line) => line.split("=") as [string, string]));
        if (out["base"] === undefined || out["head"] === undefined) throw new Error(`prepare-pr.sh printed no commits for #${pr.number}`);
        return { base: out["base"], head: out["head"] };
      },
      async compare(baseRev, headRev, gradle) {
        const outcome = await compareTrees(await gitTree(repo, baseRev, runProcess), await gitTree(repo, headRev, runProcess), gate, gradle, repo);
        return {
          osvScannerVersion: outcome.osvScannerVersion,
          configDigest: configDigest(outcome.configText),
          completed: true,
          verdict: outcome.failures.length === 0 ? "pass" : "fail",
          failures: outcome.failures,
          warnings: outcome.warnings,
          gaps: outcome.gaps,
          notes: outcome.notes,
        };
      },
      signatures: () => npmSignatures(repo),
      async reset() {
        await runProcess("git", ["reset", "--hard", "--quiet"], { cwd: repo });
        await runProcess("git", ["clean", "-ffdxq"], { cwd: repo });
      },
      // Each PR's full report (gaps and notes included) as a file and in the step summary: for people, not an input.
      async record(pr, result) {
        const outcome = result.outcome;
        const report: Report = {
          schemaVersion: REPORT_SCHEMA_VERSION,
          mode: "compare",
          tool: { commit: env["SUPPLY_CHAIN_COMMIT"], osvScanner: outcome?.osvScannerVersion },
          configDigest: outcome?.configDigest ?? "unknown",
          // The pair the gate checked: the PR merged onto its base's tip (or the PR head against its merge base).
          baseSha: result.compared?.base,
          headSha: result.compared?.head ?? pr.head,
          prHeadSha: pr.head,
          startedAt: values["started-at"]!,
          completedAt: new Date().toISOString(),
          completed: outcome?.completed ?? false,
          verdict: result.state === "success" ? "pass" : "fail",
          failures: outcome?.failures ?? [],
          warnings: outcome?.warnings ?? [],
          notes: outcome?.notes ?? [],
          gaps: outcome?.gaps ?? [],
          error: result.error,
        };
        console.log(`#${pr.number} (${pr.baseRef} ← ${pr.head.slice(0, 12)}):`);
        await emitReport(report, {
          reportPath: values.reports === undefined ? undefined : join(values.reports, `report-${pr.number}.json`),
          summaryPath: env["GITHUB_STEP_SUMMARY"],
          annotations: false,
          log: (line) => console.log(`  ${line}`),
        });
      },
    };
    const posted = await runRescan(plan, required("inventories"), steps, {
      fetch: fetcher,
      token,
      repository: required("github-repo"),
      context: required("context"),
      startedAt: new Date(required("started-at")),
      targetUrl: values["target-url"],
      log: (line) => console.log(line),
    });
    console.log(`rescan: ${posted} status(es) posted`);
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
