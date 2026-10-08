// Adapted from leanish/leanish-development agents/bump-it/src/publication.ts at e4f8a1e: parametrised by the tool's
// own-PR rules; a repository can have several open PRs of a tool (one per topic); the workspace and logger are passed
// in instead of bump-it's runtime; Dependabot closing is left out; the PR body records the published state;
// the pre-push journal stores the matching title, body, plan and adaptation count for recovery.
import { GitHubApiError } from "../../agent-basics/src/github/github-client.ts";
import type { GitHubClient, GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";
import type { Logger } from "../../agent-basics/src/types/logger.ts";
import type { PreparedBranch, WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import type { Workspace } from "../../agent-basics/src/working-copy/workspace.ts";

import type { PublicationJournal } from "./journal.ts";
import { isOwnPullRequest, type OwnPullRequests, type PullRequestState, stateOf, withMarker } from "./own-pr.ts";

/**
 * Everything a tool writes to GitHub, done by the tool's own process with its
 * write token from what the agent prepared — the agent itself only edits the
 * working tree and reads GitHub with a read-only token. Every write that acts
 * on an existing PR re-reads it immediately before and stops unless it's still
 * the tool's, open, and at the head the run was prepared from. GitHub can't
 * condition closing a PR or marking it ready on its head, so a push landing
 * between that re-read and the write still gets through; deleting a branch is
 * conditioned on its head (`Workspace.deleteRemoteBranch`).
 */
export interface PublicationContext {
  readonly rules: OwnPullRequests;
  readonly github: GitHubClient;
  readonly workspace: Workspace;
  readonly logger: Logger;
  readonly repo: string;
  /** The default branch every PR of the tool targets. */
  readonly base: string;
  readonly workingCopy: WorkingCopy;
  /** Where each push is recorded before the PR's body says so (see journal.ts). */
  readonly journal: PublicationJournal;
}

/** A PR's title, description and the commit message of the agent's change. */
export interface PullRequestContent {
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
}

/** The tool's open PRs in the repository, oldest first. */
export async function ownOpenPullRequests(
  github: GitHubClient,
  rules: OwnPullRequests,
  repo: string,
  base: string,
): Promise<GitHubPullRequest[]> {
  return (await github.listOpenPullRequests({ repo })).filter((pr) => isOwnPullRequest(rules, pr, repo, base)).sort((a, b) => a.number - b.number);
}

/**
 * Make room for a new branch: a remote branch of that name with no open PR is
 * a leftover and goes (its commits must not ride along); one with an open PR
 * stops the run.
 */
export async function clearLeftoverBranch(github: GitHubClient, rules: OwnPullRequests, repo: string, branch: string): Promise<void> {
  const open = (await github.findPullRequests({ repo, branch })).filter((pr) => pr.state === "open");
  if (open.length > 0) {
    throw new Error(`${rules.tool}: ${repo} branch ${branch} already has an open PR (#${open[0]!.number})`);
  }
  try {
    await github.deleteBranch({ repo, branch });
  } catch (err) {
    // 422: no such ref — nothing left over.
    if (!(err instanceof GitHubApiError) || err.status !== 422) throw err;
  }
}

/** Commit and push the agent's edits on a new branch and open a draft PR; `undefined` when there was nothing to publish. */
export async function publishNew(
  context: PublicationContext,
  prepared: PreparedBranch,
  content: PullRequestContent,
): Promise<GitHubPullRequest | undefined> {
  if (prepared.remoteHeadSha !== null) throw new Error(`${context.rules.tool}: ${prepared.branch} exists already; update its PR instead`);
  const pushed = await context.workspace.publishBranch(context.workingCopy, prepared, { message: content.commitMessage });
  if (pushed.kind === "unchanged") return undefined;
  const created = await createDraftPullRequest(context, prepared.branch, content, { head: pushed.sha, base: prepared.baseSha, adaptations: 0 });
  await ensureLabel(context, created);
  return created;
}

/**
 * Commit and push onto an existing PR's branch (drafted again first when it
 * was ready), then rewrite its title and description with the new state:
 * the head now on the branch, the base `prepared` was computed against, and
 * `adaptations` (by default the PR's own count). Returns the PR as updated.
 */
export async function publishUpdate(
  context: PublicationContext,
  prepared: PreparedBranch,
  number: number,
  content: PullRequestContent,
  adaptations?: number,
): Promise<{ readonly pr: GitHubPullRequest; readonly pushed: boolean }> {
  const { github, repo } = context;
  const remoteHead = existingHead(context, prepared);
  const current = await reReadOwn(context, number, remoteHead);
  const attempts = adaptations ?? stateOf(current.body)?.adaptations ?? 0;
  const bodyAt = (head: string) => withMarker(context.rules, content.body, { head, base: prepared.baseSha, adaptations: attempts });
  if (!current.isDraft) await github.convertToDraft({ nodeId: current.nodeId });
  const pushed = await context.workspace.publishBranch(context.workingCopy, prepared, {
    message: content.commitMessage,
    // Recorded before the push: whatever fails after it lands, the next tick still knows this exact head as the tool's.
    beforePush: (sha) => context.journal.pushed(repo, current.number, {
      head: sha,
      base: prepared.baseSha,
      publication: { title: content.title, body: bodyAt(sha), adaptations: attempts },
    }),
  });
  // GitHub may still report the old head for a moment after a push; anything else is someone else's push.
  await reReadOwn(context, current.number, remoteHead, ...(pushed.kind === "pushed" ? [pushed.sha] : []));
  const head = pushed.kind === "pushed" ? pushed.sha : remoteHead;
  const body = bodyAt(head);
  const updated = await github.updatePullRequest({ repo, number: current.number, title: content.title, body });
  // Nothing new reached the branch: the PR stays as ready as it was.
  if (pushed.kind === "unchanged" && !current.isDraft) await markReady(context, current.number, remoteHead);
  await ensureLabel(context, updated);
  return { pr: updated, pushed: pushed.kind === "pushed" };
}

/** Restore the entire publication for this exact pushed head, never an old plan with a new state marker. */
export async function recoverPublication(context: PublicationContext, pr: GitHubPullRequest): Promise<GitHubPullRequest> {
  const recorded = stateOf(pr.body);
  if (recorded === undefined || recorded.head === pr.headSha) return pr;
  const pushed = await context.journal.last(context.repo, pr.number);
  if (pushed?.head !== pr.headSha) return pr;
  const saved = pushed.publication;
  const state = saved === undefined ? undefined : stateOf(saved.body);
  if (saved === undefined || state?.head !== pushed.head || state.base !== pushed.base || state.adaptations !== saved.adaptations) {
    throw new Error(`${pr.url}: the journal has no matching publication content; rerun the tool to recompute before reviewing`);
  }
  await reReadOwn(context, pr.number, pr.headSha);
  return context.github.updatePullRequest({ repo: context.repo, number: pr.number, title: saved.title, body: saved.body });
}

/**
 * Rewrite the state in the PR's body (its text kept), once it's still the
 * tool's at `expectedHead`: to count an adaptation before the agent starts, or
 * to repair the head a failed update left behind.
 */
export async function recordState(context: PublicationContext, number: number, expectedHead: string, state: PullRequestState): Promise<GitHubPullRequest> {
  const current = await reReadOwn(context, number, expectedHead);
  return context.github.updatePullRequest({ repo: context.repo, number, title: current.title, body: withMarker(context.rules, current.body, state) });
}

/** Mark the PR ready, once it's still the tool's draft at `expectedHead`. */
export async function markReady(context: PublicationContext, number: number, expectedHead: string): Promise<void> {
  const current = await reReadOwn(context, number, expectedHead);
  if (current.isDraft) await context.github.markReadyForReview({ nodeId: current.nodeId });
}

/**
 * Close the PR — once it's still the tool's at `expectedHead` — explain why,
 * and delete its branch unless someone pushed to it since (then it stays, for
 * a human to look at).
 */
export async function closeAndDelete(context: PublicationContext, number: number, expectedHead: string, comment: string): Promise<void> {
  const { github, repo, logger, rules } = context;
  const current = await reReadOwn(context, number, expectedHead);
  await github.closePullRequest({ repo, number });
  try {
    await github.createComment({ repo, number, body: comment });
  } catch (err) {
    if (!(err instanceof GitHubApiError)) throw err;
    logger.warn(`${rules.tool}: explaining the close failed; the PR is closed`, { repo, number, error: err.message, comment });
  }
  const deleted = await context.workspace.deleteRemoteBranch(context.workingCopy, { branch: current.headRef, expectedSha: expectedHead });
  if (deleted.kind === "moved") {
    logger.warn(`${rules.tool}: kept the closed PR's branch — it moved after the check`, { repo, number, branch: current.headRef, found: deleted.found });
  }
}

async function createDraftPullRequest(
  context: PublicationContext,
  branch: string,
  content: PullRequestContent,
  state: PullRequestState,
): Promise<GitHubPullRequest> {
  const { github, repo, base, rules } = context;
  const request = { repo, head: branch, base, title: content.title, body: withMarker(rules, content.body, state), draft: true };
  try {
    return await github.createPullRequest(request);
  } catch (err) {
    if (!(err instanceof GitHubApiError)) throw err;
    // The PR may exist even though the response was lost; otherwise try once more.
    const open = (await github.findPullRequests({ repo, branch })).find((pr) => isOwnPullRequest(rules, pr, repo, base));
    return open ?? (await github.createPullRequest(request));
  }
}

/** A missing label is logged, not fatal: the marker still identifies the PR. */
async function ensureLabel(context: PublicationContext, pr: GitHubPullRequest): Promise<void> {
  if (pr.labels.includes(context.rules.label)) return;
  try {
    await context.github.addLabels({ repo: context.repo, number: pr.number, labels: [context.rules.label] });
  } catch (err) {
    if (!(err instanceof GitHubApiError)) throw err;
    context.logger.warn(`${context.rules.tool}: labelling the PR failed`, { repo: context.repo, number: pr.number, error: err.message });
  }
}

/** The remote head of a branch that has a PR (so it exists). */
function existingHead(context: PublicationContext, prepared: PreparedBranch): string {
  if (prepared.remoteHeadSha === null) throw new Error(`${context.rules.tool}: ${prepared.branch} has a PR but was prepared as a new branch`);
  return prepared.remoteHeadSha;
}

/** The PR again, refused unless it is still an open PR of the tool at one of `expectedHeads`. */
export async function reReadOwn(context: PublicationContext, number: number, ...expectedHeads: ReadonlyArray<string | null>): Promise<GitHubPullRequest> {
  const { github, repo, base, rules } = context;
  const current = await github.getPullRequest({ repo, number });
  if (!isOwnPullRequest(rules, current, repo, base)) throw new Error(`${rules.tool}: ${repo}#${number} is no longer an open ${rules.tool} PR`);
  if (!expectedHeads.includes(current.headSha)) {
    throw new Error(
      `${rules.tool}: ${repo}#${number} moved to ${current.headSha} (expected ${expectedHeads.map((head) => head ?? "none").join(" or ")}); not publishing over it`,
    );
  }
  return current;
}
