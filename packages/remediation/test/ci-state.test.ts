// Copied from leanish/leanish-development agents/bump-it/test/ci-state.test.ts at e4f8a1e.
// Local changes: imports; uses actions-jobs source; failingCheckNames regression for Actions job and commit status failures; onlyCooldownHolds.
import { describe, expect, it } from "vitest";

import type { GitHubCheckRun, GitHubCommitStatus } from "../../agent-basics/src/types/clients.ts";

import { classifyCi, COOLDOWN_STEPS, failingCheckNames, onlyCooldownHolds } from "../src/ci-state.ts";

function run(status: string, conclusion: string | null, name = "check"): GitHubCheckRun {
  return { name, status, conclusion };
}

function status(state: string, context = "ci/legacy"): GitHubCommitStatus {
  return { context, state };
}

describe("classifyCi", () => {
  it.each([
    ["all succeeded", [run("completed", "success")], [], "success"],
    ["success plus skipped and neutral", [run("completed", "success"), run("completed", "skipped"), run("completed", "neutral")], [], "success"],
    ["a successful status only", [], [status("success")], "success"],
    ["check and status both green", [run("completed", "success")], [status("success")], "success"],
    ["nothing at all", [], [], "none"],
    ["skipped only", [run("completed", "skipped")], [], "none"],
    ["neutral only", [run("completed", "neutral")], [], "none"],
    ["completed with a null conclusion", [run("completed", null), run("completed", "success")], [], "none"],
    ["an unknown conclusion", [run("completed", "mystery"), run("completed", "success")], [], "none"],
    ["an unknown status state", [run("completed", "success")], [status("mystery")], "none"],
    ["an unknown check-run status", [run("mystery", null), run("completed", "success")], [], "none"],
    ["an unknown check-run status next to a running one", [run("mystery", null), run("queued", null)], [], "none"],
    ["an unknown check-run status next to a failure", [run("mystery", null), run("completed", "failure")], [], "failure"],
    ["waiting", [run("waiting", null)], [], "pending"],
    ["still queued", [run("queued", null), run("completed", "success")], [], "pending"],
    ["in progress", [run("in_progress", null)], [], "pending"],
    ["a pending status", [run("completed", "success")], [status("pending")], "pending"],
    ["a failed check", [run("completed", "failure"), run("completed", "success")], [], "failure"],
    ["a failure while another still runs", [run("completed", "failure"), run("in_progress", null)], [], "failure"],
    ["a failed status while a check runs", [run("in_progress", null)], [status("failure")], "failure"],
    ["an errored status", [run("completed", "success")], [status("error")], "failure"],
    ["cancelled", [run("completed", "cancelled")], [], "failure"],
    ["timed out", [run("completed", "timed_out")], [], "failure"],
    ["action required", [run("completed", "action_required")], [], "failure"],
    ["startup failure", [run("completed", "startup_failure")], [], "failure"],
    ["stale", [run("completed", "stale")], [], "failure"],
  ] as const)("%s → %s", (_name, checkRuns, statuses, expected) => {
    expect(classifyCi({ source: "actions-jobs", checkRuns: [...checkRuns], statuses: [...statuses] })).toBe(expected);
  });
});

describe("failingCheckNames", () => {
  it("includes failed jobs and statuses, with the classifier's failure rules", () => {
    expect(failingCheckNames({ source: "actions-jobs", checkRuns: [run("completed", "failure", "job"), run("completed", "skipped"), run("in_progress", null), run("completed", "mystery")],
      statuses: [status("failure", "legacy"), status("error", "job"), status("pending"), status("success")] })).toEqual(["job", "legacy"]);
  });
});

describe("onlyCooldownHolds", () => {
  const step = (name: string, conclusion: string) => ({ name, status: "completed", conclusion });
  const held = (name = "supply-chain / cooldown", evaluate = "success", hold = "failure", conclusion = "failure"): GitHubCheckRun => ({
    ...run("completed", conclusion, name), steps: [step(COOLDOWN_STEPS.evaluate, evaluate), step(COOLDOWN_STEPS.hold, hold)],
  });
  const verdict = run("completed", "success", "supply-chain / supply-chain");
  const checks = (checkRuns: GitHubCheckRun[], statuses: GitHubCommitStatus[] = []) => ({ source: "actions-jobs" as const, checkRuns, statuses });

  it("is a hold when the cooldown failed its hold step after evaluating, and the comparison passed", () => {
    expect(onlyCooldownHolds(checks([verdict, held(), run("completed", "success", "check")]))).toBe(true);
    expect(onlyCooldownHolds(checks([run("completed", "success", "gate / supply-chain"), held("gate / cooldown")]))).toBe(true);
  });

  it.each([
    ["the evaluation failed (missing report, another head)", checks([verdict, held(undefined, "failure", "skipped")])],
    ["the cooldown was cancelled", checks([verdict, held(undefined, "success", "failure", "cancelled")])],
    ["the cooldown job lists no steps", checks([verdict, run("completed", "failure", "supply-chain / cooldown")])],
    ["another check failed too", checks([verdict, held(), run("completed", "failure", "check")])],
    ["a status failed too", checks([verdict, held()], [status("failure")])],
    ["the comparison didn't pass", checks([run("completed", "failure", "supply-chain / supply-chain"), held()])],
    ["no comparison ran", checks([held()])],
    ["a job merely named like it", checks([verdict, held("cooldown-ish")])],
    ["nothing failed", checks([verdict])],
  ])("isn't a hold when %s", (_name, value) => {
    expect(onlyCooldownHolds(value)).toBe(false);
  });
});
