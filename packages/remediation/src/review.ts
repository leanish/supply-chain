/**
 * The review tick both tools run between their scheduled runs: it looks at
 * every open PR of the tool, in this order, and never lets one PR's problem
 * stop the others:
 *
 *   1. someone else pushed (the head isn't the one the tool recorded) →
 *      leave the PR alone, report it;
 *   2. the base moved (any merge, conflicts or not) → `steps.rebase`, before
 *      anything else: the tool recomputes its plan on the new base, retires
 *      what the base already has, or merges the base and re-applies (the agent
 *      only when code needs adapting);
 *   3. CI pending → nothing; green → ready for review; no checks → report;
 *   4. CI failed → `steps.adapt` (the agent), at most `MAX_ADAPTATIONS` times
 *      per PR, counted in its body; after that, close it with a comment.
 *
 * Steps 1 and 3 need no model.
 */
import type { GitHubClient, GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";
import type { Logger } from "../../agent-basics/src/types/logger.ts";
import type { PreparedBranch, WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import type { Workspace } from "../../agent-basics/src/working-copy/workspace.ts";

import { classifyCi } from "./ci-state.ts";
import { type OwnPullRequests, stateOf } from "./own-pr.ts";
import { closeAndDelete, markReady, ownOpenPullRequests, type PublicationContext } from "./publication.ts";

/** How many times the agent may adapt one PR after a failed CI before the tool gives it up. */
export const MAX_ADAPTATIONS = 2;

/** What happened to one PR in a tick. */
export type ReviewOutcome =
  | "left-alone"
  | "rebased"
  | "retired"
  | "pending"
  | "marked-ready"
  | "already-ready"
  | "no-checks"
  | "adapted"
  | "adaptation-unchanged"
  | "closed"
  | "error";

export interface ReviewEntry {
  readonly number: number;
  readonly url: string;
  readonly outcome: ReviewOutcome;
  readonly detail: string | undefined;
}

/** The tool-specific parts of a tick. */
export interface ReviewSteps {
  /**
   * The base moved since the PR was published: recompute the plan on it and
   * either retire the PR (the base already has everything, or the merge
   * conflicts and the next run redoes it; the step closes it) or publish the
   * reconciled change on `merge.prepared`, the PR's branch with the new base
   * merged in. Returns which.
   */
  rebase(pr: GitHubPullRequest, merge: BaseMerge, context: PublicationContext): Promise<"retired" | "rebased">;
  /** CI failed: the agent adapts the change once (`attempt` from 1); whether a change was published. */
  adapt(pr: GitHubPullRequest, prepared: PreparedBranch, context: PublicationContext, attempt: number): Promise<boolean>;
}

/** The PR's branch with the new base merged in, or a conflict (nothing checked out). */
export type BaseMerge = { readonly kind: "merged"; readonly prepared: PreparedBranch } | { readonly kind: "conflict"; readonly remoteHead: string };

export interface ReviewContext {
  readonly rules: OwnPullRequests;
  readonly github: GitHubClient;
  readonly workspace: Workspace;
  readonly workingCopy: WorkingCopy;
  readonly logger: Logger;
  readonly repo: string;
  readonly base: string;
}

/** Runs one tick over the tool's open PRs in `repo`; one entry per PR. */
export async function reviewOpenPullRequests(context: ReviewContext, steps: ReviewSteps): Promise<ReviewEntry[]> {
  const entries: ReviewEntry[] = [];
  for (const pr of await ownOpenPullRequests(context.github, context.rules, context.repo, context.base)) {
    let entry: ReviewEntry;
    try {
      entry = await reviewOne(context, steps, pr);
    } catch (err) {
      // One PR's problem is logged and reported; the tick goes on.
      const detail = err instanceof Error ? err.message : String(err);
      context.logger.warn(`${context.rules.tool}: reviewing a PR failed`, { repo: context.repo, number: pr.number, error: detail });
      entry = { number: pr.number, url: pr.url, outcome: "error", detail };
    }
    entries.push(entry);
  }
  return entries;
}

async function reviewOne(context: ReviewContext, steps: ReviewSteps, pr: GitHubPullRequest): Promise<ReviewEntry> {
  const result = (outcome: ReviewOutcome, detail?: string): ReviewEntry => ({ number: pr.number, url: pr.url, outcome, detail });
  const state = stateOf(pr.body);
  if (state === undefined) return result("left-alone", "its body no longer has the tool's state; someone rewrote it");
  if (pr.headSha !== state.head) return result("left-alone", `someone else pushed (${pr.headSha.slice(0, 12)}, the tool published ${state.head.slice(0, 12)})`);

  const publication: PublicationContext = { ...context };
  const checkedOut = await context.workspace.prepareBranch(context.workingCopy, { branch: pr.headRef, start: "remote" });
  if (checkedOut.kind !== "prepared") throw new Error(`${pr.headRef} couldn't be checked out`);
  if (checkedOut.prepared.remoteHeadSha !== pr.headSha) {
    return result("left-alone", `the branch moved while the tick read it (${checkedOut.prepared.remoteHeadSha ?? "gone"})`);
  }

  if (checkedOut.prepared.baseSha !== state.base) {
    const merged = await context.workspace.prepareBranch(context.workingCopy, { branch: pr.headRef, start: "remote-merged" });
    const merge: BaseMerge = merged.kind === "prepared" ? { kind: "merged", prepared: merged.prepared } : { kind: "conflict", remoteHead: pr.headSha };
    const outcome = await steps.rebase(pr, merge, publication);
    return result(outcome, `base moved from ${state.base.slice(0, 12)} to ${checkedOut.prepared.baseSha.slice(0, 12)}`);
  }

  const ci = classifyCi(await context.github.headChecks({ repo: context.repo, sha: pr.headSha }));
  if (ci === "pending") return result("pending");
  if (ci === "none") return result("no-checks", "no check has passed or failed on the head yet");
  if (ci === "success") {
    if (!pr.isDraft) return result("already-ready");
    await markReady(publication, pr.number, pr.headSha);
    return result("marked-ready");
  }
  if (state.adaptations >= MAX_ADAPTATIONS) {
    await closeAndDelete(
      publication,
      pr.number,
      pr.headSha,
      `CI still fails after ${state.adaptations} adaptation(s); ${context.rules.tool} is giving this one up. The next run starts over from the current default branch.`,
    );
    return result("closed", `CI failed after ${state.adaptations} adaptation(s)`);
  }
  const pushed = await steps.adapt(pr, checkedOut.prepared, publication, state.adaptations + 1);
  return result(pushed ? "adapted" : "adaptation-unchanged", `attempt ${state.adaptations + 1} of ${MAX_ADAPTATIONS}`);
}
