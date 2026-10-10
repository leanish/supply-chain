/**
 * The review tick both tools run between their scheduled runs: it looks at
 * every open PR of the tool, in this order, and never lets one PR's problem
 * stop the others:
 *
 *   1. someone else pushed (the head is neither the one the PR's body
 *      records nor, after a failed body update, the one the tool's journal
 *      records) → leave the PR alone, report it;
 *   2. the base moved (any merge, conflicts or not) → `steps.rebase`, before
 *      anything else: the tool recomputes its plan on the new base, retires
 *      what the base already has, or merges the base and re-applies (the agent
 *      only when code needs adapting);
 *   3. CI pending → nothing; green → ready for review; no checks → report;
 *   4. CI failed → `steps.adapt` (the agent), at most `MAX_ADAPTATIONS` times
 *      per PR, each attempt counted in its body before the agent starts (a
 *      failed attempt counts too); after that, close it with a comment.
 *
 * A PR the cooldown holds (`steps.cooldown`: it takes versions younger than
 * the release-age wait) never becomes ready on the tool's say: green CI, or
 * only the gate's cooldown failing, leaves it a draft. Once every held version
 * has aged, the draft is retired before anything else, and the tool's next run
 * plans again from scratch, with fresh checks. A person who marked it ready
 * owns it: the tick leaves it alone. Any other PR that only the gate's
 * cooldown holds (the daily rescan, after the base's wait grew) waits as a
 * draft too: no adaptation can make a version older.
 *
 * Steps 1 and 3 need no model.
 */
import type { GitHubClient, GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";
import type { Logger } from "../../agent-basics/src/types/logger.ts";
import type { PreparedBranch, WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import type { Workspace } from "../../agent-basics/src/working-copy/workspace.ts";

import { classifyCi, onlyCooldownHolds } from "./ci-state.ts";
import type { PublicationJournal } from "./journal.ts";
import { type OwnPullRequests, type PullRequestState, stateOf } from "./own-pr.ts";
import { closeAndDelete, markReady, ownOpenPullRequests, type PublicationContext, recordState, recoverPublication } from "./publication.ts";

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
  | "held"
  | "graduated"
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
   * either retire the PR (the base already has everything; the step closes
   * it) or publish the reconciled change on `merge.prepared`: the PR's branch
   * with the new base merged in, or with the merge in progress and
   * `merge.conflicted` to resolve in the working tree first (mechanically for
   * dependency files, the agent for code). Returns which.
   */
  rebase(pr: GitHubPullRequest, merge: BaseMerge, context: PublicationContext): Promise<"retired" | "rebased">;
  /** CI failed: the agent adapts the change once (`attempt` from 1); whether a change was published. */
  adapt(pr: GitHubPullRequest, prepared: PreparedBranch, context: PublicationContext, attempt: number): Promise<boolean>;
  /**
   * Whether the PR's recorded plan takes versions younger than the wait, and
   * whether they've all aged by now; undefined when it holds none. Throws on
   * a recorded hold it can't read, so such a PR is never marked ready.
   */
  cooldown?(pr: GitHubPullRequest): CooldownState | undefined;
}

/** A held PR's versions: some still `waiting`, or all `aged`; `until` is when the last one turns old enough. */
export interface CooldownState {
  readonly kind: "waiting" | "aged";
  readonly until: string;
}

/** The PR's branch with the new base merged in, or with the merge in progress and its conflicted paths. */
export type BaseMerge =
  | { readonly kind: "merged"; readonly prepared: PreparedBranch }
  | { readonly kind: "conflicted"; readonly prepared: PreparedBranch; readonly conflicted: ReadonlyArray<string> };

export interface ReviewContext {
  readonly rules: OwnPullRequests;
  readonly github: GitHubClient;
  readonly workspace: Workspace;
  readonly workingCopy: WorkingCopy;
  readonly logger: Logger;
  readonly repo: string;
  readonly base: string;
  readonly journal: PublicationJournal;
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
  const publication: PublicationContext = { ...context };
  pr = await recoverPublication(publication, pr);
  const recorded = stateOf(pr.body);
  if (recorded === undefined) return result("left-alone", "its body no longer has the tool's state; someone rewrote it");
  const state: PullRequestState = recorded;
  if (pr.headSha !== recorded.head) {
    const pushed = await context.journal.last(context.repo, pr.number);
    if (pushed?.head !== pr.headSha) {
      return result("left-alone", `someone else pushed (${pr.headSha.slice(0, 12)}, the tool published ${recorded.head.slice(0, 12)})`);
    }
    throw new Error(`${pr.url}: journal recovery did not restore the publication`);
  }

  const cooldown = steps.cooldown?.(pr);
  if (cooldown !== undefined && !pr.isDraft) return result("left-alone", "a person marked the held PR ready");
  if (cooldown?.kind === "aged") {
    const closed = await closeAndDelete(
      publication,
      pr.number,
      pr.headSha,
      `Every version this PR took before the release-age wait ended has now aged past it (the last on ${cooldown.until}). ${context.rules.tool} retires this draft instead of promoting it: its next run plans again from the current default branch and opens a PR with fresh checks, held again only if something in it is still young.`,
      { onlyDraft: true },
    );
    return closed === "closed" ? result("graduated", `held until ${cooldown.until}`) : result("left-alone", "a person marked the held PR ready");
  }

  const checkedOut = await context.workspace.prepareBranch(context.workingCopy, { branch: pr.headRef, start: "remote" });
  if (checkedOut.kind !== "prepared") throw new Error(`${pr.headRef} couldn't be checked out`);
  if (checkedOut.prepared.remoteHeadSha !== pr.headSha) {
    return result("left-alone", `the branch moved while the tick read it (${checkedOut.prepared.remoteHeadSha ?? "gone"})`);
  }

  if (checkedOut.prepared.baseSha !== state.base) {
    const merged = await context.workspace.prepareBranch(context.workingCopy, { branch: pr.headRef, start: "remote-merging" });
    if (merged.kind === "conflict") throw new Error(`${pr.headRef}: remote-merging reported a conflict without leaving it in progress`);
    // Someone may have pushed between the two preparations: the PR is only the tool's at the head it checked.
    if (merged.prepared.remoteHeadSha !== pr.headSha) {
      return result("left-alone", `the branch moved while the tick read it (${merged.prepared.remoteHeadSha ?? "gone"})`);
    }
    const merge: BaseMerge =
      merged.kind === "prepared" ? { kind: "merged", prepared: merged.prepared } : { kind: "conflicted", prepared: merged.prepared, conflicted: merged.conflicted };
    const outcome = await steps.rebase(pr, merge, publication);
    return result(outcome, `base moved from ${state.base.slice(0, 12)} to ${checkedOut.prepared.baseSha.slice(0, 12)}`);
  }

  const checks = await context.github.headChecks({ repo: context.repo, sha: pr.headSha });
  const ci = classifyCi(checks);
  if (ci === "pending") return result("pending");
  if (ci === "none") return result("no-checks", "no check has passed or failed on the head yet");
  // Green, or red only because the gate's cooldown holds it: waiting, not ready and not broken.
  if (cooldown !== undefined && (ci === "success" || onlyCooldownHolds(checks))) return result("held", `until ${cooldown.until}`);
  // Held by the gate although it took nothing young itself: the base's wait grew past one of its versions.
  if (onlyCooldownHolds(checks)) return result("held", "by the gate's cooldown under the base's current wait");
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
  // Counted before the agent starts: an attempt that fails or publishes nothing still uses one up.
  const attempt = state.adaptations + 1;
  await recordState(publication, pr.number, pr.headSha, { ...state, adaptations: attempt });
  const pushed = await steps.adapt(pr, checkedOut.prepared, publication, attempt);
  return result(pushed ? "adapted" : "adaptation-unchanged", `attempt ${attempt} of ${MAX_ADAPTATIONS}`);
}
