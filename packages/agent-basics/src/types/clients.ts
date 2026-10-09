// Copied from leanish/leanish-development core/runtime/src/types/clients.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: only the GitHub client's types; headChecks uses Actions jobs and commit statuses, with an actions-jobs source; a job's steps.
/**
 * Narrow GitHub REST/GraphQL client for handler-side, model-free work (see
 * `github/github-client.ts`): the decisions a handler settles without a skill,
 * and publishing what a skill prepared, with credentials the skill never sees. Every method throws `GitHubApiError` on
 * any GitHub-side problem — missing token, network failure or timeout,
 * non-2xx, malformed response — so callers can fall back without catching
 * programming errors.
 */
export interface GitHubClient {
  /** Every PR (open or closed) whose head is `<repo owner>:<branch>`. */
  findPullRequests(args: { readonly repo: string; readonly branch: string }): Promise<ReadonlyArray<GitHubPullRequest>>;
  /** Every open PR of the repo, all pages read. */
  listOpenPullRequests(args: { readonly repo: string }): Promise<ReadonlyArray<GitHubPullRequest>>;
  getPullRequest(args: { readonly repo: string; readonly number: number }): Promise<GitHubPullRequest>;
  /**
   * The head's latest Actions jobs and commit statuses, all pages read.
   * Requires Actions and Commit statuses read, never Checks. Checks from other
   * apps are visible only if they publish commit statuses.
   */
  headChecks(args: { readonly repo: string; readonly sha: string }): Promise<GitHubHeadChecks>;
  /** GraphQL `markPullRequestReadyForReview`; resolves only once GitHub reports the PR no longer draft. */
  markReadyForReview(args: { readonly nodeId: string }): Promise<void>;
  /** GraphQL `convertPullRequestToDraft`; resolves only once GitHub reports the PR draft. */
  convertToDraft(args: { readonly nodeId: string }): Promise<void>;
  /** A PR from `head` (a branch of `repo`) into `base`. */
  createPullRequest(args: GitHubNewPullRequest): Promise<GitHubPullRequest>;
  updatePullRequest(args: {
    readonly repo: string;
    readonly number: number;
    readonly title: string;
    readonly body: string;
  }): Promise<GitHubPullRequest>;
  closePullRequest(args: { readonly repo: string; readonly number: number }): Promise<GitHubPullRequest>;
  addLabels(args: { readonly repo: string; readonly number: number; readonly labels: ReadonlyArray<string> }): Promise<void>;
  /** A comment on the PR's conversation. */
  createComment(args: { readonly repo: string; readonly number: number; readonly body: string }): Promise<void>;
  /** Delete `refs/heads/<branch>`. */
  deleteBranch(args: { readonly repo: string; readonly branch: string }): Promise<void>;
}

export interface GitHubNewPullRequest {
  readonly repo: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly nodeId: string;
  readonly url: string;
  readonly title: string;
  /** `""` when the PR has no description. */
  readonly body: string;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly isDraft: boolean;
  /** The author's login; `null` when the account was deleted. */
  readonly author: string | null;
  readonly labels: ReadonlyArray<string>;
  readonly baseRef: string;
  readonly headSha: string;
  readonly headRef: string;
  /** `owner/name` of the head repository; `null` when it was deleted. */
  readonly headRepo: string | null;
}

export interface GitHubHeadChecks {
  /** Where `checkRuns` came from. */
  readonly source: "actions-jobs";
  readonly checkRuns: ReadonlyArray<GitHubCheckRun>;
  readonly statuses: ReadonlyArray<GitHubCommitStatus>;
}

/** A check run, or an Actions job (or a job-less run) standing in for one — same status/conclusion values. */
export interface GitHubCheckRun {
  readonly name: string;
  /** `queued`, `in_progress`, `completed`, … as GitHub reports it. */
  readonly status: string;
  /** Set once completed: `success`, `failure`, `neutral`, `skipped`, …; `null` otherwise. */
  readonly conclusion: string | null;
  /** An Actions job's steps, in order, when GitHub listed them. */
  readonly steps?: ReadonlyArray<GitHubCheckStep>;
}

export interface GitHubCheckStep {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export interface GitHubCommitStatus {
  readonly context: string;
  /** `success`, `pending`, `failure` or `error`. */
  readonly state: string;
}
