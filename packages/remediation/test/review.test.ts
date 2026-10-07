import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "../../agent-basics/src/logger/console-logger.ts";
import type { GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";
import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { InMemoryWorkspace } from "../../agent-basics/src/working-copy/in-memory-workspace.ts";
import { stateOf, withMarker } from "../src/own-pr.ts";
import { closeAndDelete, publishUpdate, type PublicationContext } from "../src/publication.ts";
import { type BaseMerge, MAX_ADAPTATIONS, type ReviewContext, reviewOpenPullRequests, type ReviewSteps } from "../src/review.ts";
import { BASE_SHA, FakeGitHub, HEAD_SHA, ownPr, PUSHED_SHA, RED, RULES } from "./fake-github.ts";

const REPO = "leanish/widget";
const NEW_BASE = "f".repeat(40);

/** A working copy whose head is the default branch's: `InMemoryWorkspace` reports it as each preparation's base. */
function workingCopy(baseSha = BASE_SHA): WorkingCopy {
  return { projectId: REPO, path: "/synthetic/leanish/widget", branch: "main", headSha: baseSha, gitDir: "/synthetic/leanish/widget/.git" };
}

function context(github: FakeGitHub, workspace = new InMemoryWorkspace(), wc = workingCopy()): ReviewContext {
  workspace.setRemoteHead("secure-it/2026-10-05-snappy-java", HEAD_SHA);
  return { rules: RULES, github, workspace, workingCopy: wc, logger: new ConsoleLogger({ minLevel: "error" }), repo: REPO, base: "main" };
}

/** Steps that record what they were asked, rebasing by updating the PR and adapting by pushing. */
function steps(calls: string[] = [], outcome: "retired" | "rebased" = "rebased"): ReviewSteps {
  return {
    async rebase(pr: GitHubPullRequest, merge: BaseMerge, publication: PublicationContext) {
      calls.push(`rebase #${pr.number} ${merge.kind}`);
      if (outcome === "retired") {
        await closeAndDelete(publication, pr.number, pr.headSha, "the default branch has these versions now");
        return "retired";
      }
      if (merge.kind !== "merged") throw new Error("expected a merge");
      await publishUpdate(publication, merge.prepared, pr.number, { title: pr.title, body: pr.body, commitMessage: "merging the default branch" });
      return "rebased";
    },
    async adapt(pr: GitHubPullRequest, prepared, publication, attempt) {
      calls.push(`adapt #${pr.number} attempt ${attempt}`);
      const { pushed } = await publishUpdate(publication, prepared, pr.number, { title: pr.title, body: pr.body, commitMessage: "adapting" }, attempt);
      return pushed;
    },
  };
}

describe("reviewOpenPullRequests", () => {
  it("marks a draft with green CI ready, and leaves pending CI and an already-ready PR alone, with no model", async () => {
    const github = new FakeGitHub(ownPr());
    const calls: string[] = [];
    expect(await reviewOpenPullRequests(context(github), steps(calls))).toEqual([
      { number: 7, url: "https://github.com/leanish/widget/pull/7", outcome: "marked-ready", detail: undefined },
    ]);
    expect(github.prs.get(7)?.isDraft).toBe(false);
    expect(calls).toEqual([]);

    expect((await reviewOpenPullRequests(context(github), steps()))[0]?.outcome).toBe("already-ready");
    github.checks = { source: "check-runs", checkRuns: [{ name: "check", status: "in_progress", conclusion: null }], statuses: [] };
    expect((await reviewOpenPullRequests(context(github), steps()))[0]?.outcome).toBe("pending");
    github.checks = { source: "check-runs", checkRuns: [], statuses: [] };
    expect((await reviewOpenPullRequests(context(github), steps()))[0]?.outcome).toBe("no-checks");
  });

  it("leaves a PR someone else pushed to, or whose state someone removed, without touching it", async () => {
    const github = new FakeGitHub(ownPr({ headSha: "9".repeat(40) }), ownPr({ number: 8, nodeId: "PR_node8", url: "u8", body: `Rewritten.\n\n${RULES.marker}\n` }));
    const entries = await reviewOpenPullRequests(context(github), steps());
    expect(entries.map((entry) => [entry.number, entry.outcome])).toEqual([
      [7, "left-alone"],
      [8, "left-alone"],
    ]);
    expect(entries[0]?.detail).toContain("someone else pushed");
    expect(github.calls.filter((call) => !call.startsWith("listOpenPullRequests"))).toEqual([]);
  });

  it("recomputes on a moved base before looking at CI, merged or conflicting, and retires what the base has", async () => {
    const github = new FakeGitHub(ownPr());
    github.checks = RED;
    const calls: string[] = [];
    const moved = await reviewOpenPullRequests(context(github, new InMemoryWorkspace(), workingCopy(NEW_BASE)), steps(calls));
    expect(moved[0]).toMatchObject({ outcome: "rebased", detail: `base moved from ${BASE_SHA.slice(0, 12)} to ${NEW_BASE.slice(0, 12)}` });
    expect(calls).toEqual(["rebase #7 merged"]);
    // The update recorded the new base and the pushed head, so the next tick looks at CI again.
    expect(stateOf(github.prs.get(7)!.body)).toEqual({ head: PUSHED_SHA, base: NEW_BASE, adaptations: 0 });

    const conflicting = new FakeGitHub(ownPr());
    const workspace = new InMemoryWorkspace();
    workspace.setPrepareConflict("secure-it/2026-10-05-snappy-java");
    const retired: string[] = [];
    const entries = await reviewOpenPullRequests(context(conflicting, workspace, workingCopy(NEW_BASE)), steps(retired, "retired"));
    expect(entries[0]?.outcome).toBe("retired");
    expect(retired).toEqual(["rebase #7 conflict"]);
    expect(conflicting.prs.get(7)?.state).toBe("closed");
    expect(workspace.deletions.map((deletion) => deletion.args)).toEqual([{ branch: "secure-it/2026-10-05-snappy-java", expectedSha: HEAD_SHA }]);
  });

  it("lets the agent adapt a failing PR at most twice, counting in the body, then closes it", async () => {
    const github = new FakeGitHub(ownPr());
    github.checks = RED;
    const calls: string[] = [];
    const first = await reviewOpenPullRequests(context(github), steps(calls));
    expect(first[0]).toMatchObject({ outcome: "adapted", detail: "attempt 1 of 2" });
    expect(stateOf(github.prs.get(7)!.body)).toEqual({ head: PUSHED_SHA, base: BASE_SHA, adaptations: 1 });

    const exhausted = new FakeGitHub(ownPr({ body: withMarker(RULES, "Body.", { head: HEAD_SHA, base: BASE_SHA, adaptations: MAX_ADAPTATIONS }) }));
    exhausted.checks = RED;
    const entries = await reviewOpenPullRequests(context(exhausted), steps(calls));
    expect(entries[0]).toMatchObject({ outcome: "closed", detail: "CI failed after 2 adaptation(s)" });
    expect(exhausted.prs.get(7)?.state).toBe("closed");
    expect(exhausted.calls.some((call) => call.startsWith("createComment 7 CI still fails after 2 adaptation(s)"))).toBe(true);
    expect(calls).toEqual(["adapt #7 attempt 1"]);
  });

  it("reports one PR's error and goes on to the next", async () => {
    const github = new FakeGitHub(ownPr(), ownPr({ number: 8, nodeId: "PR_node8", url: "u8" }));
    let headChecks = 0;
    const real = github.headChecks.bind(github);
    github.headChecks = async (args) => {
      headChecks++;
      if (headChecks === 1) throw new Error("checks unreadable");
      return real(args);
    };
    const entries = await reviewOpenPullRequests(context(github), steps());
    expect(entries.map((entry) => [entry.number, entry.outcome, entry.detail])).toEqual([
      [7, "error", "checks unreadable"],
      [8, "marked-ready", undefined],
    ]);
  });
});
