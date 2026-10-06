// Copied from leanish/leanish-development core/runtime/test/unit/github-client.test.ts at e4f8a1e; see PROVENANCE.md.
import { describe, expect, it } from "vitest";

import { createGitHubClient, GitHubApiError } from "../src/github/github-client.ts";

const TOKEN = "ghp_secret-token-value";
const SHA = "c".repeat(40);

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** Fake `fetch` answering each call with the next scripted response. */
function scripted(...responses: Array<Response | Error>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected extra fetch");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiPr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    node_id: "PR_node7",
    html_url: "https://github.com/leanish/widget/pull/7",
    title: "refreshing dependencies",
    body: "body",
    state: "open",
    draft: true,
    merged_at: null,
    user: { login: "leanish" },
    labels: [{ name: "leanish:agent:bump-it" }],
    base: { ref: "main" },
    head: { sha: SHA, ref: "bump-it/dependency-refresh-2026-10-05", repo: { full_name: "leanish/widget" } },
    ...overrides,
  };
}

function client(fetchFn: typeof fetch, env: Record<string, string | undefined> = { GITHUB_TOKEN: TOKEN }) {
  return createGitHubClient({ env, fetch: fetchFn });
}

describe("createGitHubClient", () => {
  it("looks PRs up by owner:branch with the token, and maps them", async () => {
    const { fetch, calls } = scripted(
      json([
        apiPr(),
        apiPr({ number: 3, state: "closed", draft: false, merged_at: "2026-10-01T00:00:00Z", body: null, user: null, labels: [], head: { sha: SHA, ref: "x", repo: null } }),
      ]),
    );
    const pulls = await client(fetch).findPullRequests({ repo: "leanish/widget", branch: "bump-it/dependency-refresh-2026-10-05" });

    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/leanish/widget/pulls?head=leanish%3Abump-it%2Fdependency-refresh-2026-10-05&state=all&per_page=100&page=1",
    );
    expect((calls[0]?.init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.init.redirect).toBe("error");
    const common = { nodeId: "PR_node7", url: "https://github.com/leanish/widget/pull/7", title: "refreshing dependencies", baseRef: "main", headSha: SHA };
    expect(pulls).toEqual([
      { ...common, number: 7, body: "body", state: "open", merged: false, isDraft: true, author: "leanish", labels: ["leanish:agent:bump-it"], headRef: "bump-it/dependency-refresh-2026-10-05", headRepo: "leanish/widget" },
      { ...common, number: 3, body: "", state: "closed", merged: true, isDraft: false, author: null, labels: [], headRef: "x", headRepo: null },
    ]);
  });

  it("reads every page of the PR list", async () => {
    const { fetch, calls } = scripted(json(Array.from({ length: 100 }, () => apiPr())), json([apiPr()]));
    const pulls = await client(fetch).findPullRequests({ repo: "leanish/widget", branch: "b" });
    expect(pulls).toHaveLength(101);
    expect(calls[1]?.url).toContain("&page=2");
  });

  it("reads the latest check runs and the combined status across pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, status: "completed", conclusion: "success" }));
    const { fetch, calls } = scripted(
      json({ total_count: 101, check_runs: page1 }),
      json({ total_count: 101, check_runs: [{ name: "last", status: "in_progress", conclusion: null }] }),
      json({ total_count: 1, statuses: [{ context: "ci/legacy", state: "success" }] }),
    );
    const checks = await client(fetch).headChecks({ repo: "leanish/widget", sha: SHA });

    expect(calls.map((call) => call.url)).toEqual([
      `https://api.github.com/repos/leanish/widget/commits/${SHA}/check-runs?filter=latest&per_page=100&page=1`,
      `https://api.github.com/repos/leanish/widget/commits/${SHA}/check-runs?filter=latest&per_page=100&page=2`,
      `https://api.github.com/repos/leanish/widget/commits/${SHA}/status?per_page=100&page=1`,
    ]);
    expect(checks.source).toBe("check-runs");
    expect(checks.checkRuns).toHaveLength(101);
    expect(checks.checkRuns.at(-1)).toEqual({ name: "last", status: "in_progress", conclusion: null });
    expect(checks.statuses).toEqual([{ context: "ci/legacy", state: "success" }]);
  });

  it("reads every page of the combined status", async () => {
    const statuses = Array.from({ length: 100 }, (_, i) => ({ context: `s${i}`, state: "success" }));
    const { fetch, calls } = scripted(
      json({ total_count: 0, check_runs: [] }),
      json({ total_count: 101, statuses }),
      json({ total_count: 101, statuses: [{ context: "last", state: "pending" }] }),
    );
    const checks = await client(fetch).headChecks({ repo: "leanish/widget", sha: SHA });
    expect(checks.statuses).toHaveLength(101);
    expect(calls[2]?.url).toBe(`https://api.github.com/repos/leanish/widget/commits/${SHA}/status?per_page=100&page=2`);
  });

  it("refuses to read more than 10 pages", async () => {
    const full = () => json(Array.from({ length: 100 }, () => apiPr()));
    const { fetch, calls } = scripted(...Array.from({ length: 10 }, full));
    await expect(client(fetch).findPullRequests({ repo: "leanish/widget", branch: "b" })).rejects.toThrow("more than 10 pages");
    expect(calls).toHaveLength(10);
  });

  const wfRun = (id: number, name: string, status: string, conclusion: string | null, workflowId = 1, event = "pull_request") => ({
    id, name, status, conclusion, workflow_id: workflowId, event,
  });
  const job = (id: number, name: string, status: string, conclusion: string | null) => ({ id, name, status, conclusion });

  async function fallbackChecks(runs: unknown[], jobsPerRun: unknown[][]) {
    const { fetch, calls } = scripted(
      json({ message: "Resource not accessible by personal access token" }, 403),
      json({ total_count: runs.length, workflow_runs: runs }),
      ...jobsPerRun.map((jobs) => json({ total_count: jobs.length, jobs })),
      json({ total_count: 0, statuses: [] }),
    );
    return { checks: await client(fetch).headChecks({ repo: "leanish/widget", sha: SHA }), calls };
  }

  it("falls back to the head's latest Actions jobs when check runs are forbidden", async () => {
    const { checks, calls } = await fallbackChecks(
      [wfRun(5, "CI", "completed", "success"), wfRun(6, "Lint", "completed", "success", 2)],
      [[job(50, "build", "completed", "success")], [job(60, "lint", "completed", "skipped")]],
    );
    expect(calls.map((call) => call.url.replace("https://api.github.com/repos/leanish/widget", ""))).toEqual([
      `/commits/${SHA}/check-runs?filter=latest&per_page=100&page=1`,
      `/actions/runs?head_sha=${SHA}&per_page=100&page=1`,
      "/actions/runs/5/jobs?filter=latest&per_page=100&page=1",
      "/actions/runs/6/jobs?filter=latest&per_page=100&page=1",
      `/commits/${SHA}/status?per_page=100&page=1`,
    ]);
    expect(checks.source).toBe("actions-jobs");
    // A completed run with jobs is represented by its jobs only.
    expect(checks.checkRuns).toEqual([
      { name: "build", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "skipped" },
    ]);
  });

  it("lets a re-run's newer jobs win over an older attempt, even under a lower run number", async () => {
    const { checks } = await fallbackChecks(
      [wfRun(5, "CI", "completed", "failure"), wfRun(6, "CI", "completed", "success")],
      [[job(70, "e2e", "completed", "failure")], [job(60, "e2e", "completed", "success")]],
    );
    expect(checks.checkRuns).toContainEqual({ name: "e2e", status: "completed", conclusion: "failure" });
    expect(checks.checkRuns).not.toContainEqual({ name: "e2e", status: "completed", conclusion: "success" });
  });

  it("keeps groups apart: same names under another workflow or event don't overwrite a failure", async () => {
    const { checks } = await fallbackChecks(
      [wfRun(5, "CI", "completed", "failure", 1, "push"), wfRun(6, "CI", "completed", "success", 1, "pull_request"), wfRun(7, "CI", "completed", "success", 2)],
      [[job(50, "build", "completed", "failure")], [job(60, "build", "completed", "success")], [job(70, "build", "completed", "success")]],
    );
    expect(checks.checkRuns).toContainEqual({ name: "build", status: "completed", conclusion: "failure" });
    expect(checks.checkRuns).toHaveLength(3);
  });

  it("doesn't let a successful run stand in for jobs that were all skipped", async () => {
    const { checks } = await fallbackChecks([wfRun(5, "CI", "completed", "success")], [[job(50, "build", "completed", "skipped")]]);
    expect(checks.checkRuns).toEqual([{ name: "build", status: "completed", conclusion: "skipped" }]);
  });

  it("counts a completed run with no jobs as itself", async () => {
    const { checks } = await fallbackChecks([wfRun(5, "CI", "completed", "startup_failure")], [[]]);
    expect(checks.checkRuns).toEqual([{ name: "CI", status: "completed", conclusion: "startup_failure" }]);
  });

  it("keeps a run that isn't completed as pending even when its returned jobs are green", async () => {
    const { checks } = await fallbackChecks([wfRun(5, "CI", "in_progress", null)], [[job(50, "build", "completed", "success")]]);
    expect(checks.checkRuns).toContainEqual({ name: "CI", status: "in_progress", conclusion: null });
  });

  it("surfaces a continue-on-error job failure inside a successful run", async () => {
    const { checks } = await fallbackChecks([wfRun(1, "CI", "completed", "success")], [[job(10, "flaky", "completed", "failure")]]);
    expect(checks.checkRuns).toContainEqual({ name: "flaky", status: "completed", conclusion: "failure" });
  });

  it("doesn't fall back on other check-run failures, and fails when the Actions runs are forbidden too", async () => {
    const other = scripted(json({ message: "nope" }, 404));
    await expect(client(other.fetch).headChecks({ repo: "leanish/widget", sha: SHA })).rejects.toMatchObject({ status: 404 });
    expect(other.calls).toHaveLength(1);

    const both = scripted(json({}, 403), json({}, 403));
    await expect(client(both.fetch).headChecks({ repo: "leanish/widget", sha: SHA })).rejects.toMatchObject({ status: 403 });
  });

  it("fails the whole read when a later page fails", async () => {
    const page1 = Array.from({ length: 100 }, () => ({ name: "c", status: "completed", conclusion: "success" }));
    const { fetch } = scripted(json({ total_count: 150, check_runs: page1 }), json({ message: "boom" }, 502));
    await expect(client(fetch).headChecks({ repo: "leanish/widget", sha: SHA })).rejects.toThrow(GitHubApiError);
  });

  it("marks a PR ready through GraphQL with the node id as a variable", async () => {
    const { fetch, calls } = scripted(json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }));
    await client(fetch).markReadyForReview({ nodeId: "PR_node7" });
    expect(calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ variables: { id: "PR_node7" } });
  });

  it.each([
    ["GraphQL errors on HTTP 200", { errors: [{ message: "nope" }] }],
    ["no mutation data", { data: {} }],
    ["a PR still draft", { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: true } } } }],
  ])("rejects %s", async (_name, body) => {
    const { fetch } = scripted(json(body));
    await expect(client(fetch).markReadyForReview({ nodeId: "PR_node7" })).rejects.toThrow(GitHubApiError);
  });

  it.each([
    ["a non-2xx", () => json({ message: "Resource not accessible by personal access token" }, 403)],
    ["a network error", () => new TypeError("fetch failed")],
    ["a timeout", () => Object.assign(new Error("timed out"), { name: "TimeoutError" })],
    ["a non-JSON body", () => new Response("<html>", { status: 200 })],
    ["a malformed PR", () => json([{ number: "7" }])],
  ])("throws GitHubApiError on %s, never echoing the token or body", async (_name, response) => {
    const { fetch } = scripted(response());
    const error = await client(fetch).findPullRequests({ repo: "leanish/widget", branch: "b" }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(String((error as Error).message)).not.toContain("personal access token");
  });

  it("converts a PR to draft through GraphQL and checks the state it reports", async () => {
    const { fetch, calls } = scripted(json({ data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } }), json({ data: { convertPullRequestToDraft: { pullRequest: { isDraft: false } } } }));
    await client(fetch).convertToDraft({ nodeId: "PR_node7" });
    expect(String(calls[0]?.init.body)).toContain("convertPullRequestToDraft");
    await expect(client(fetch).convertToDraft({ nodeId: "PR_node7" })).rejects.toThrow(GitHubApiError);
  });

  it("lists the open PRs across pages and reads one by number", async () => {
    const { fetch, calls } = scripted(json(Array.from({ length: 100 }, () => apiPr())), json([apiPr({ number: 9 })]), json(apiPr({ number: 4 })));
    const github = client(fetch);
    expect(await github.listOpenPullRequests({ repo: "leanish/widget" })).toHaveLength(101);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/leanish/widget/pulls?state=open&per_page=100&page=1");
    expect((await github.getPullRequest({ repo: "leanish/widget", number: 4 })).number).toBe(4);
    expect(calls[2]?.url).toBe("https://api.github.com/repos/leanish/widget/pulls/4");
  });

  it("creates, updates and closes PRs with the fields as a JSON body", async () => {
    const { fetch, calls } = scripted(json(apiPr(), 201), json(apiPr({ title: "new" })), json(apiPr({ state: "closed" })));
    const github = client(fetch);
    const created = await github.createPullRequest({ repo: "leanish/widget", head: "bump-it/dependency-refresh-2026-10-05", base: "main", title: "t", body: "b", draft: true });
    expect(created.number).toBe(7);
    expect(calls[0]?.url).toBe("https://api.github.com/repos/leanish/widget/pulls");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ head: "bump-it/dependency-refresh-2026-10-05", base: "main", title: "t", body: "b", draft: true });
    await github.updatePullRequest({ repo: "leanish/widget", number: 7, title: "new", body: "b2" });
    expect(calls[1]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ title: "new", body: "b2" });
    expect((await github.closePullRequest({ repo: "leanish/widget", number: 7 })).state).toBe("closed");
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ state: "closed" });
  });

  it("labels and comments on a PR's issue, and deletes a branch ref (204)", async () => {
    const { fetch, calls } = scripted(json([{ name: "x" }]), json({ id: 1 }, 201), new Response(null, { status: 204 }));
    const github = client(fetch);
    await github.addLabels({ repo: "leanish/widget", number: 7, labels: ["leanish:agent:bump-it"] });
    await github.createComment({ repo: "leanish/widget", number: 7, body: "closing: malware" });
    await github.deleteBranch({ repo: "leanish/widget", branch: "bump-it/dependency-refresh-2026-10-05" });
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      "POST https://api.github.com/repos/leanish/widget/issues/7/labels",
      "POST https://api.github.com/repos/leanish/widget/issues/7/comments",
      "DELETE https://api.github.com/repos/leanish/widget/git/refs/heads/bump-it/dependency-refresh-2026-10-05",
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ labels: ["leanish:agent:bump-it"] });
    expect(calls[2]?.init.body).toBeUndefined();
  });

  it.each([
    ["an empty title", () => client(scripted().fetch).updatePullRequest({ repo: "leanish/widget", number: 7, title: " ", body: "" })],
    ["an oversized body", () => client(scripted().fetch).updatePullRequest({ repo: "leanish/widget", number: 7, title: "t", body: "x".repeat(65_537) })],
    ["a branch going up", () => client(scripted().fetch).deleteBranch({ repo: "leanish/widget", branch: "../main" })],
    ["a branch that's an option", () => client(scripted().fetch).createPullRequest({ repo: "leanish/widget", head: "-x", base: "main", title: "t", body: "", draft: true })],
    ["a non-positive PR number", () => client(scripted().fetch).closePullRequest({ repo: "leanish/widget", number: 0 })],
    ["an empty comment", () => client(scripted().fetch).createComment({ repo: "leanish/widget", number: 7, body: "  " })],
    ["no labels", () => client(scripted().fetch).addLabels({ repo: "leanish/widget", number: 7, labels: [] })],
  ])("rejects a write with %s before any request", async (_name, call) => {
    await expect(call()).rejects.toThrow(GitHubApiError);
  });

  it("fails each call, not construction, when GITHUB_TOKEN is missing — and calls nothing", async () => {
    const { fetch, calls } = scripted();
    const github = client(fetch, {});
    await expect(github.findPullRequests({ repo: "leanish/widget", branch: "b" })).rejects.toThrow("GITHUB_TOKEN is not set");
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["a repo with a path", () => client(scripted().fetch).findPullRequests({ repo: "leanish/widget/../x", branch: "b" })],
    ["an empty branch", () => client(scripted().fetch).findPullRequests({ repo: "leanish/widget", branch: "" })],
    ["a non-sha ref", () => client(scripted().fetch).headChecks({ repo: "leanish/widget", sha: "main" })],
  ])("rejects %s before any request", async (_name, call) => {
    await expect(call()).rejects.toThrow(GitHubApiError);
  });
});
