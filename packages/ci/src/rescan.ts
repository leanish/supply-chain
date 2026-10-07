/**
 * The daily rescan of open PRs.
 *
 * Each open PR's head, merged onto its base's current tip, is compared
 * against that tip with today's advisories. The Gradle inventories come from
 * one job per PR that runs the build (base first, uploaded before any PR code
 * runs); everything else happens in a single job that runs no code from the
 * repository: it re-reads each PR, merges it, compares, checks npm registry
 * signatures, and posts the verdict as a commit status on the PR's head,
 * under the same name as the required `supply-chain` check. GitHub requires
 * both to pass, so a red status blocks the merge although the PR's own check
 * was green; the latest status of a context wins, and nothing is posted on the
 * test merge commit (GitHub would evaluate that one instead). The verdict
 * never leaves that job, so nothing another job uploads can stand in for it.
 *
 * A PR that closed, got a new head, or whose base moved is skipped (its
 * verdict would be stale); a newer status from another run is never
 * overwritten; a PR whose inventories or comparison didn't complete gets a
 * failure: a scan that didn't complete is never read as clean.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Fetch } from "./http.ts";
import { isObject } from "./json.ts";

const GITHUB_API = "https://api.github.com";
export const MAX_RESCANNED_PRS = 256;

export interface PlannedPr {
  readonly number: number;
  readonly head: string;
  readonly base: string;
  readonly baseRef: string;
}

/** Parses the plan's PR list (`gh pr list` JSON plus base tips), checking its shape and size. */
export function parsePlan(raw: unknown): PlannedPr[] {
  if (!Array.isArray(raw)) throw new Error("rescan plan must be a list");
  if (raw.length > MAX_RESCANNED_PRS) throw new Error(`${raw.length} open PRs: the rescan handles at most ${MAX_RESCANNED_PRS}`);
  return raw.map((entry: unknown) => {
    if (
      !isObject(entry) ||
      !Number.isInteger(entry["number"]) ||
      !isSha(entry["head"]) ||
      !isSha(entry["base"]) ||
      typeof entry["baseRef"] !== "string" ||
      entry["baseRef"] === ""
    ) {
      throw new Error(`rescan plan has a malformed entry: ${JSON.stringify(entry)}`);
    }
    return { number: entry["number"] as number, head: entry["head"], base: entry["base"], baseRef: entry["baseRef"] };
  });
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

export interface PublishOptions {
  readonly fetch: Fetch;
  readonly token: string;
  /** `owner/repo`. */
  readonly repository: string;
  /** The required check's name, which the status reuses. */
  readonly context: string;
  /** When the rescan started: a status created after it is newer than this verdict. */
  readonly startedAt: Date;
  /** Link to the rescan run, for the status. */
  readonly targetUrl: string | undefined;
  readonly log: (line: string) => void;
}

/** The open PRs (every page), each with its base branch's current tip; only `only` when given. */
export async function planRescan(
  options: Pick<PublishOptions, "fetch" | "token" | "repository">,
  only: number | undefined,
): Promise<PlannedPr[]> {
  const api = github({ ...options, context: "", startedAt: new Date(0), targetUrl: undefined, log: () => undefined });
  const pulls: unknown[] = [];
  if (only !== undefined) {
    const pr = await api.get(`/repos/${options.repository}/pulls/${only}`);
    if (!isObject(pr) || pr["state"] !== "open") throw new Error(`PR #${only} isn't open`);
    pulls.push(pr);
  } else {
    for (let page = 1; ; page++) {
      const batch = await api.get(`/repos/${options.repository}/pulls?state=open&per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error("GitHub's open PR list isn't a list");
      pulls.push(...batch);
      if (batch.length < 100) break;
      if (pulls.length > MAX_RESCANNED_PRS) break;
    }
  }
  const tips = new Map<string, string>();
  const plan: PlannedPr[] = [];
  for (const pr of pulls) {
    const baseRef = dig(pr, "base", "ref");
    if (typeof baseRef !== "string") throw new Error("GitHub returned a PR without a base");
    if (!tips.has(baseRef)) {
      const tip = dig(await api.get(`/repos/${options.repository}/branches/${encodeURIComponent(baseRef)}`), "commit", "sha");
      if (!isSha(tip)) throw new Error(`can't read the tip of ${baseRef}`);
      tips.set(baseRef, tip);
    }
    plan.push({ number: dig(pr, "number") as number, head: dig(pr, "head", "sha") as string, base: tips.get(baseRef)!, baseRef });
  }
  return parsePlan(plan);
}

/** What the rescan does to one PR, given as steps so it can be exercised without git, npm or a network. */
export interface RescanSteps {
  /** Merges the PR onto its base in the checkout (prepare-pr.sh); the commits to compare. */
  prepare(pr: PlannedPr): Promise<{ base: string; head: string }>;
  /** The gate on the pair, with the PR's Gradle inventory files when there are any. */
  compare(base: string, head: string, gradle: { base: string | undefined; head: string | undefined }): Promise<RescanOutcome>;
  /** On a passing comparison only: install and verify in clean npm projects, without repository config or executable sources. */
  signatures(): Promise<string[]>;
  /** Back to a clean checkout before the next PR. */
  reset(): Promise<void>;
  /**
   * Keeps what the rescan found on one PR (a report file, the step summary); called whether or not it's posted.
   * `compared` is the merged pair the gate checked, once `prepare` returned one.
   */
  record(
    pr: PlannedPr,
    result: {
      state: "success" | "failure";
      description: string;
      compared: { base: string; head: string } | undefined;
      outcome: RescanOutcome | undefined;
      error: string | undefined;
    },
  ): Promise<void>;
}

export interface RescanOutcome {
  readonly osvScannerVersion: string;
  /** As in the report: sha256 of the head's supply-chain.json, or `default`. */
  readonly configDigest: string;
  readonly completed: boolean;
  readonly verdict: "pass" | "fail";
  readonly failures: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
}

/**
 * The inventory job writes `done` in each side's artifact once that side's
 * inventory succeeded (and `gradle.json` when the side has Gradle builds);
 * without both markers the PR's rescan didn't complete.
 */
async function inventoriesOf(dir: string, pr: PlannedPr): Promise<{ base: string | undefined; head: string | undefined } | string> {
  const found: Record<string, string | undefined> = {};
  for (const side of ["base", "head"] as const) {
    const sideDir = join(dir, `rescan-inventory-${pr.number}-${side}`);
    const files = await readdir(sideDir).catch(() => [] as string[]);
    if (!files.includes("done")) return `the ${side} inventory didn't complete`;
    found[side] = files.includes("gradle.json") ? join(sideDir, "gradle.json") : undefined;
  }
  return { base: found["base"], head: found["head"] };
}

/** Rescans every planned PR that's still as planned and posts its verdict; returns how many statuses were posted. */
export async function runRescan(
  plan: ReadonlyArray<PlannedPr>,
  inventoriesDir: string,
  steps: RescanSteps,
  options: PublishOptions,
): Promise<number> {
  const api = github(options);
  let posted = 0;
  for (const pr of plan) {
    if (!(await stillAsPlanned(pr, api, options))) continue;
    let state: "success" | "failure";
    let description: string;
    let compared: { base: string; head: string } | undefined;
    let outcome: RescanOutcome | undefined;
    let error: string | undefined;
    try {
      const inventories = await inventoriesOf(inventoriesDir, pr);
      if (typeof inventories === "string") throw new Error(inventories);
      compared = await steps.prepare(pr);
      const gated = await steps.compare(compared.base, compared.head, inventories);
      const signatureProblems = gated.completed && gated.verdict === "pass" ? await steps.signatures() : [];
      outcome = { ...gated, failures: [...gated.failures, ...signatureProblems] };
      state = outcome.completed && outcome.verdict === "pass" && signatureProblems.length === 0 ? "success" : "failure";
      description = `Daily rescan: ${verdictSummary({ ...outcome, verdict: state === "success" ? "pass" : "fail" })}`;
    } catch (err) {
      error = (err as Error).message;
      state = "failure";
      description = `Daily rescan didn't complete: ${error}`;
    } finally {
      await steps.reset();
    }
    await steps.record(pr, { state, description, compared, outcome, error });
    // Again right before posting: the PR or its base may have moved while it was being scanned.
    if (!(await stillAsPlanned(pr, api, options))) continue;
    if (await newerStatusExists(pr, api, options)) {
      options.log(`#${pr.number}: a newer ${options.context} status exists; skipped`);
      continue;
    }
    await api.post(`/repos/${options.repository}/statuses/${pr.head}`, {
      state,
      context: options.context,
      description: description.length > 140 ? `${description.slice(0, 137)}...` : description,
      ...(options.targetUrl === undefined ? {} : { target_url: options.targetUrl }),
    });
    options.log(`#${pr.number}: ${state} on ${pr.head.slice(0, 12)} (${description})`);
    posted++;
  }
  return posted;
}

async function stillAsPlanned(pr: PlannedPr, api: ReturnType<typeof github>, options: PublishOptions): Promise<boolean> {
  const current = await api.get(`/repos/${options.repository}/pulls/${pr.number}`);
  if (!isObject(current) || current["state"] !== "open" || dig(current, "head", "sha") !== pr.head || dig(current, "base", "ref") !== pr.baseRef) {
    options.log(`#${pr.number}: closed or changed since the rescan started; skipped`);
    return false;
  }
  const branch = await api.get(`/repos/${options.repository}/branches/${encodeURIComponent(pr.baseRef)}`);
  if (dig(branch, "commit", "sha") !== pr.base) {
    options.log(`#${pr.number}: ${pr.baseRef} moved since the rescan started; skipped`);
    return false;
  }
  return true;
}

/** Statuses come newest first: read pages until one predates the rescan, or they run out. */
async function newerStatusExists(pr: PlannedPr, api: ReturnType<typeof github>, options: PublishOptions): Promise<boolean> {
  for (let page = 1; ; page++) {
    const statuses = await api.get(`/repos/${options.repository}/commits/${pr.head}/statuses?per_page=100&page=${page}`);
    if (!Array.isArray(statuses) || statuses.length === 0) return false;
    for (const status of statuses) {
      if (!isObject(status) || typeof status["created_at"] !== "string") continue;
      if (new Date(status["created_at"]) <= options.startedAt) return false;
      if (status["context"] === options.context) return true;
    }
    if (statuses.length < 100) return false;
  }
}

function dig(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((current, key) => (isObject(current) ? current[key] : undefined), value);
}

function github(options: PublishOptions) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${options.token}`,
  };
  return {
    async get(path: string): Promise<unknown> {
      const response = await options.fetch(`${GITHUB_API}${path}`, { headers });
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`GitHub API ${path} failed with HTTP ${response.status}`);
      return response.json();
    },
    async post(path: string, body: unknown): Promise<void> {
      const response = await options.fetch(`${GITHUB_API}${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`GitHub API POST ${path} failed with HTTP ${response.status}`);
    },
  };
}

/** The status description's one line: what failed first, or what passed with: inherited findings, coverage gaps. */
export function verdictSummary(report: {
  completed: boolean;
  verdict: string;
  failures: ReadonlyArray<string>;
  warnings: ReadonlyArray<string>;
  gaps?: ReadonlyArray<string>;
}): string {
  if (!report.completed) return "didn't complete";
  if (report.verdict === "fail") return `${report.failures.length} failure(s): ${report.failures[0] ?? ""}`;
  const parts = [
    ...(report.warnings.length === 0 ? [] : [`${report.warnings.length} inherited finding(s)`]),
    ...((report.gaps ?? []).length === 0 ? [] : [`${report.gaps!.length} coverage gap(s)`]),
  ];
  return parts.length === 0 ? "clean" : `pass, ${parts.join(", ")}`;
}
