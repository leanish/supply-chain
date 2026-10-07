// Copied from leanish/leanish-development agents/bump-it/src/ci-state.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: `CiConclusion` defined here instead of bump-it's handler type; failingCheckNames supplies both failed Actions jobs and commit status contexts to adaptations.
import type { GitHubHeadChecks } from "../../agent-basics/src/types/clients.ts";

/** What a PR head's CI says. */
export type CiConclusion = "success" | "failure" | "pending" | "none";

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);
const FAILED_STATUSES: ReadonlySet<string> = new Set(["failure", "error"]);
const RUNNING_RUN_STATUSES: ReadonlySet<string> = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

/**
 * The CI state of a PR head from its latest check runs and commit statuses,
 * in this order:
 *
 *   - `failure` — any check concluded failed (or any status failed), even
 *     while others still run: a known failure needs the agent now;
 *   - `pending` — anything still queued, waiting or running;
 *   - `success` — everything completed with success / neutral / skipped
 *     (statuses: success), and at least one check or status really succeeded;
 *   - `none` — nothing to go on: no checks, all skipped or neutral, or a
 *     value this function doesn't know (never read as success).
 *
 * "All observed checks passed", not "all required checks passed": GitHub's
 * required-check list isn't read, so a required check that never started
 * is invisible here — the same blind spot as `gh pr checks`.
 */
export function classifyCi(checks: GitHubHeadChecks): CiConclusion {
  const { checkRuns, statuses } = checks;
  const failed =
    checkRuns.some((run) => run.status === "completed" && run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion)) ||
    statuses.some((status) => FAILED_STATUSES.has(status.state));
  if (failed) return "failure";

  // An unknown run status is ambiguous even next to a running check: never wait it out.
  if (checkRuns.some((run) => run.status !== "completed" && !RUNNING_RUN_STATUSES.has(run.status))) return "none";

  const running =
    checkRuns.some((run) => RUNNING_RUN_STATUSES.has(run.status)) || statuses.some((status) => status.state === "pending");
  if (running) return "pending";

  const allPassing =
    checkRuns.every((run) => run.status === "completed" && run.conclusion !== null && PASSING_CONCLUSIONS.has(run.conclusion)) &&
    statuses.every((status) => status.state === "success");
  const anySucceeded =
    checkRuns.some((run) => run.conclusion === "success") || statuses.some((status) => status.state === "success");
  return allPassing && anySucceeded ? "success" : "none";
}

/** Failure names from the same jobs and statuses used to classify CI. */
export function failingCheckNames(checks: GitHubHeadChecks): string[] {
  const jobs = checks.checkRuns
    .filter((run) => run.status === "completed" && run.conclusion !== null && FAILED_CONCLUSIONS.has(run.conclusion))
    .map((run) => run.name);
  const statuses = checks.statuses.filter((status) => FAILED_STATUSES.has(status.state)).map((status) => status.context);
  return [...new Set([...jobs, ...statuses])].sort();
}
