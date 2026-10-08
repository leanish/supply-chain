#!/usr/bin/env node
/**
 * supply-chain: the CI gate.
 *
 *   supply-chain compare --base <rev> [--head <rev>] [--repo <dir>] [--report <file>]
 *   supply-chain scan [--head <rev> | --head worktree] [--repo <dir>] [--report <file>]
 *
 * `compare` (pull requests) fails on findings head adds, on malware anywhere
 * in head, and on added or changed versions that fail the release-age,
 * source or identity checks. `scan` (the default branch) fails on every
 * finding without an exception. Both read files from git objects (or the
 * working tree), never running anything from them.
 *
 * Exit codes: 0 pass, 1 fail, 2 the gate couldn't complete (also a failure).
 * Environment: OSV_SCANNER (default `osv-scanner` on PATH), GITHUB_TOKEN or
 * GH_TOKEN for the GitHub API, GITHUB_STEP_SUMMARY and GITHUB_ACTIONS in CI,
 * SUPPLY_CHAIN_COMMIT to record the tool's own commit.
 */
import { parseArgs } from "node:util";

import { type GateEnvironment, type GateOutcome, runCompare, runScan } from "./gate.ts";
import { configDigest, emitReport, REPORT_SCHEMA_VERSION, type Report } from "./report.ts";
import { runProcess } from "./process.ts";
import { gitTree, type Tree, workingTree } from "./tree.ts";

const USAGE = `usage:
  supply-chain compare --base <rev> [--head <rev>] [--repo <dir>] [--report <file>]
  supply-chain scan [--head <rev> | --head worktree] [--repo <dir>] [--report <file>]`;

export async function main(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = argv;
  let values: { base?: string; head?: string; repo?: string; report?: string };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: { base: { type: "string" }, head: { type: "string" }, repo: { type: "string" }, report: { type: "string" } },
      strict: true,
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  if ((command !== "compare" && command !== "scan") || (command === "compare" && values.base === undefined)) {
    console.error(USAGE);
    return 2;
  }
  const repo = values.repo ?? process.cwd();
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
    if (command === "compare") {
      base = await gitTree(repo, values.base!, runProcess);
      outcome = await runCompare(base, head, gate);
    } else {
      outcome = await runScan(head, gate);
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

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`✗ ${(err as Error).message}`);
      process.exit(2);
    },
  );
}
