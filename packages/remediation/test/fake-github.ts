// Adapted from leanish/leanish-development agents/bump-it/test/fake-github.ts at c6282df: secure-it's rules and PR state
// instead of bump-it's constants; the Dependabot PR factory is left out; CI fixtures use actions-jobs source.
import { GitHubApiError } from "../../agent-basics/src/github/github-client.ts";
import type { GitHubClient, GitHubHeadChecks, GitHubNewPullRequest, GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";

import { ownPullRequests, withMarker } from "../src/own-pr.ts";

export const RULES = ownPullRequests("secure-it");
export const OWN_BRANCH = "secure-it/2026-10-05-snappy-java";
export const HEAD_SHA = "a".repeat(40);
/** What `InMemoryWorkspace` reports as the default branch's head (its working copies' head) when the PR was published. */
export const BASE_SHA = "e".repeat(40);
/** What `InMemoryWorkspace.publishBranch` reports it pushed. */
export const PUSHED_SHA = "c".repeat(40);

/** An open draft secure-it PR for `OWN_BRANCH` in `leanish/widget`, published at HEAD_SHA on BASE_SHA; override any field. */
export function ownPr(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    number: 7,
    nodeId: "PR_node7",
    url: "https://github.com/leanish/widget/pull/7",
    title: "fixing snappy-java",
    body: withMarker(RULES, "Body.", { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }),
    state: "open",
    merged: false,
    isDraft: true,
    author: "leanish",
    labels: [RULES.label],
    baseRef: "main",
    headSha: HEAD_SHA,
    headRef: OWN_BRANCH,
    headRepo: "leanish/widget",
    ...overrides,
  };
}

export const GREEN: GitHubHeadChecks = {
  source: "actions-jobs",
  checkRuns: [{ name: "check", status: "completed", conclusion: "success" }],
  statuses: [],
};

export const RED: GitHubHeadChecks = {
  source: "actions-jobs",
  checkRuns: [{ name: "check", status: "completed", conclusion: "failure" }],
  statuses: [],
};

type Step<T> = T | GitHubApiError;

/**
 * A `GitHubClient` over an in-memory set of PRs (`prs`, by number):
 * `findPullRequests` answers from the scripted `pullRequests` steps when set
 * (each call takes the next; the last repeats), else from `prs` by head
 * branch; `listOpenPullRequests` and `getPullRequest` read `prs`; writes
 * change `prs` the way GitHub would. `fail` makes the next call of a method
 * throw; `before` runs a step (e.g. someone's `push`) at the next call of a
 * method, before it acts. Records every call.
 */
export class FakeGitHub implements GitHubClient {
  readonly calls: string[] = [];
  readonly prs = new Map<number, GitHubPullRequest>();
  pullRequests: ReadonlyArray<Step<ReadonlyArray<GitHubPullRequest>>> | undefined;
  checks: Step<GitHubHeadChecks> = GREEN;
  /** Branches `deleteBranch` finds (others answer 422, like GitHub for a missing ref). */
  readonly branches = new Set<string>();
  readonly #failures = new Map<string, GitHubApiError>();
  readonly #before = new Map<string, () => void>();
  #nextNumber = 42;

  constructor(...prs: ReadonlyArray<GitHubPullRequest>) {
    for (const pr of prs) this.prs.set(pr.number, pr);
  }

  fail(method: keyof GitHubClient, error = new GitHubApiError(method, "unexpected response", 502)): void {
    this.#failures.set(method, error);
  }

  before(method: keyof GitHubClient, step: () => void): void {
    this.#before.set(method, step);
  }

  async findPullRequests(args: { readonly repo: string; readonly branch: string }): Promise<ReadonlyArray<GitHubPullRequest>> {
    const index = this.calls.filter((call) => call.startsWith("findPullRequests")).length;
    this.#record("findPullRequests", `${args.repo} ${args.branch}`);
    if (this.pullRequests !== undefined) return unwrap(this.pullRequests[Math.min(index, this.pullRequests.length - 1)] ?? []);
    return [...this.prs.values()].filter((pr) => pr.headRef === args.branch);
  }

  async listOpenPullRequests(args: { readonly repo: string }): Promise<ReadonlyArray<GitHubPullRequest>> {
    this.#record("listOpenPullRequests", args.repo);
    return [...this.prs.values()].filter((pr) => pr.state === "open");
  }

  async getPullRequest(args: { readonly repo: string; readonly number: number }): Promise<GitHubPullRequest> {
    this.#record("getPullRequest", `${args.number}`);
    return this.#pr("getPullRequest", args.number);
  }

  async headChecks(args: { readonly repo: string; readonly sha: string }): Promise<GitHubHeadChecks> {
    this.#record("headChecks", `${args.repo} ${args.sha}`);
    return unwrap(this.checks);
  }

  async markReadyForReview(args: { readonly nodeId: string }): Promise<void> {
    this.#record("markReadyForReview", args.nodeId);
    this.#updateByNode(args.nodeId, { isDraft: false });
  }

  async convertToDraft(args: { readonly nodeId: string }): Promise<void> {
    this.#record("convertToDraft", args.nodeId);
    this.#updateByNode(args.nodeId, { isDraft: true });
  }

  async createPullRequest(args: GitHubNewPullRequest): Promise<GitHubPullRequest> {
    this.#record("createPullRequest", `${args.head} -> ${args.base} draft=${args.draft}`);
    const number = this.#nextNumber++;
    const pr = ownPr({
      number,
      nodeId: `PR_node${number}`,
      url: `https://github.com/${args.repo}/pull/${number}`,
      title: args.title,
      body: args.body,
      isDraft: args.draft,
      labels: [],
      baseRef: args.base,
      headRef: args.head,
      headRepo: args.repo,
      headSha: PUSHED_SHA,
    });
    this.prs.set(number, pr);
    return pr;
  }

  async updatePullRequest(args: { readonly repo: string; readonly number: number; readonly title: string; readonly body: string }): Promise<GitHubPullRequest> {
    this.#record("updatePullRequest", `${args.number}`);
    return this.#update(args.number, { title: args.title, body: args.body });
  }

  async closePullRequest(args: { readonly repo: string; readonly number: number }): Promise<GitHubPullRequest> {
    this.#record("closePullRequest", `${args.number}`);
    return this.#update(args.number, { state: "closed" });
  }

  async addLabels(args: { readonly repo: string; readonly number: number; readonly labels: ReadonlyArray<string> }): Promise<void> {
    this.#record("addLabels", `${args.number} ${args.labels.join(",")}`);
    const pr = this.#pr("addLabels", args.number);
    this.#update(args.number, { labels: [...pr.labels, ...args.labels] });
  }

  async createComment(args: { readonly repo: string; readonly number: number; readonly body: string }): Promise<void> {
    this.#record("createComment", `${args.number} ${args.body}`);
  }

  async deleteBranch(args: { readonly repo: string; readonly branch: string }): Promise<void> {
    this.#record("deleteBranch", args.branch);
    if (!this.branches.delete(args.branch)) throw new GitHubApiError("deleteBranch", "unexpected response", 422);
  }

  /** Move a PR's head, as a push would. */
  push(number: number, headSha: string): void {
    this.#update(number, { headSha });
  }

  #record(method: string, detail: string): void {
    this.calls.push(`${method} ${detail}`);
    const step = this.#before.get(method);
    if (step !== undefined) {
      this.#before.delete(method);
      step();
    }
    const failure = this.#failures.get(method);
    if (failure !== undefined) {
      this.#failures.delete(method);
      throw failure;
    }
  }

  #pr(operation: string, number: number): GitHubPullRequest {
    const pr = this.prs.get(number);
    if (pr === undefined) throw new GitHubApiError(operation, "unexpected response", 404);
    return pr;
  }

  #update(number: number, changes: Partial<GitHubPullRequest>): GitHubPullRequest {
    const updated = { ...this.#pr("update", number), ...changes };
    this.prs.set(number, updated);
    return updated;
  }

  #updateByNode(nodeId: string, changes: Partial<GitHubPullRequest>): void {
    const pr = [...this.prs.values()].find((candidate) => candidate.nodeId === nodeId);
    if (pr !== undefined) this.#update(pr.number, changes);
  }
}

function unwrap<T>(step: Step<T>): T {
  if (step instanceof GitHubApiError) throw step;
  return step;
}
