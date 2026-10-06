/**
 * The daily rescan of open PRs, and its publisher.
 *
 * The rescan compares each open PR's head, merged onto its base's current
 * tip, against that tip, with today's advisories; it runs in jobs that can't
 * write anything. The publisher, which runs no PR code, then posts each
 * verdict as a commit status on the PR's head, under the same name as the
 * required `supply-chain` check: GitHub requires both to pass, so a red
 * status blocks the merge although the PR's own check was green. The latest
 * status of a context wins, and nothing is posted on the test merge commit
 * (GitHub would evaluate that one instead).
 *
 * Before posting, the publisher re-reads the PR and its base: closed, a new
 * head, or a moved base means the verdict is stale and is skipped; a newer
 * status from another run is never overwritten. A PR the rescan planned but
 * left no verdict for gets a failure: a scan that didn't complete is never
 * read as clean.
 */
import { readdir, readFile } from "node:fs/promises";
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

export interface RescanVerdict {
  readonly number: number;
  readonly head: string;
  readonly base: string;
  readonly completed: boolean;
  readonly verdict: "pass" | "fail";
  /** One line for the status description. */
  readonly summary: string;
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

/** Every `verdict-<number>.json` in `dir`, by PR number; malformed files are ignored (that PR gets "didn't complete"). */
export async function readVerdicts(dir: string): Promise<Map<number, RescanVerdict>> {
  const verdicts = new Map<number, RescanVerdict>();
  let files: string[];
  try {
    files = await readdir(dir, { recursive: true });
  } catch {
    return verdicts;
  }
  for (const file of files.filter((name) => /(^|\/)verdict-\d+\.json$/.test(name))) {
    try {
      const raw: unknown = JSON.parse(await readFile(join(dir, file), "utf8"));
      if (
        isObject(raw) &&
        Number.isInteger(raw["number"]) &&
        isSha(raw["head"]) &&
        isSha(raw["base"]) &&
        typeof raw["completed"] === "boolean" &&
        (raw["verdict"] === "pass" || raw["verdict"] === "fail") &&
        typeof raw["summary"] === "string"
      ) {
        verdicts.set(raw["number"] as number, raw as unknown as RescanVerdict);
      }
    } catch {
      // A verdict that doesn't parse is a missing verdict.
    }
  }
  return verdicts;
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

/** Posts one status per planned PR that's still as planned; returns how many were posted. */
export async function publishRescan(
  plan: ReadonlyArray<PlannedPr>,
  verdicts: ReadonlyMap<number, RescanVerdict>,
  options: PublishOptions,
): Promise<number> {
  const api = github(options);
  let posted = 0;
  for (const pr of plan) {
    const current = await api.get(`/repos/${options.repository}/pulls/${pr.number}`);
    const head = dig(current, "head", "sha");
    const baseRef = dig(current, "base", "ref");
    if (!isObject(current) || current["state"] !== "open" || head !== pr.head || baseRef !== pr.baseRef) {
      options.log(`#${pr.number}: closed or changed since the rescan started; skipped`);
      continue;
    }
    const branch = await api.get(`/repos/${options.repository}/branches/${encodeURIComponent(pr.baseRef)}`);
    if (dig(branch, "commit", "sha") !== pr.base) {
      options.log(`#${pr.number}: ${pr.baseRef} moved since the rescan started; skipped`);
      continue;
    }
    const statuses = await api.get(`/repos/${options.repository}/commits/${pr.head}/statuses?per_page=100`);
    const newer = Array.isArray(statuses)
      ? statuses.some(
          (status: unknown) =>
            isObject(status) &&
            status["context"] === options.context &&
            typeof status["created_at"] === "string" &&
            new Date(status["created_at"]) > options.startedAt,
        )
      : false;
    if (newer) {
      options.log(`#${pr.number}: a newer ${options.context} status exists; skipped`);
      continue;
    }
    const verdict = verdicts.get(pr.number);
    const matches = verdict !== undefined && verdict.head === pr.head && verdict.base === pr.base;
    const state = matches && verdict.completed && verdict.verdict === "pass" ? "success" : "failure";
    const description = !matches || !verdict.completed ? "Daily rescan didn't complete" : `Daily rescan: ${verdict.summary}`;
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

/** The status description's one line: what failed first, or how many warnings. */
export function verdictSummary(report: { completed: boolean; verdict: string; failures: ReadonlyArray<string>; warnings: ReadonlyArray<string> }): string {
  if (!report.completed) return "didn't complete";
  if (report.verdict === "fail") return `${report.failures.length} failure(s): ${report.failures[0] ?? ""}`;
  return report.warnings.length === 0 ? "clean" : `pass, ${report.warnings.length} inherited warning(s)`;
}
