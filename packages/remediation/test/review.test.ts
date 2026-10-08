import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "../../agent-basics/src/logger/console-logger.ts";
import type { GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";
import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { InMemoryWorkspace } from "../../agent-basics/src/working-copy/in-memory-workspace.ts";
import { MemoryJournal } from "../src/journal.ts";
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

function context(github: FakeGitHub, workspace = new InMemoryWorkspace(), wc = workingCopy(), journal = new MemoryJournal()): ReviewContext {
  workspace.setRemoteHead("secure-it/2026-10-05-snappy-java", HEAD_SHA);
  return { rules: RULES, github, workspace, workingCopy: wc, logger: new ConsoleLogger({ minLevel: "error" }), repo: REPO, base: "main", journal };
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
    github.checks = { source: "actions-jobs", checkRuns: [{ name: "check", status: "in_progress", conclusion: null }], statuses: [] };
    expect((await reviewOpenPullRequests(context(github), steps()))[0]?.outcome).toBe("pending");
    github.checks = { source: "actions-jobs", checkRuns: [], statuses: [] };
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
    expect(retired).toEqual(["rebase #7 conflicted"]);
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

  it("leaves the PR alone when someone pushes between the two preparations of a moved base", async () => {
    const github = new FakeGitHub(ownPr());
    const workspace = new InMemoryWorkspace();
    const prepare = workspace.prepareBranch.bind(workspace);
    workspace.prepareBranch = async (wc, args) => {
      // A push lands right after the first look.
      if (args.start === "remote-merging") workspace.setRemoteHead("secure-it/2026-10-05-snappy-java", "9".repeat(40));
      return prepare(wc, args);
    };
    const calls: string[] = [];
    const entries = await reviewOpenPullRequests(context(github, workspace, workingCopy(NEW_BASE)), steps(calls));
    expect(entries[0]).toMatchObject({ outcome: "left-alone", detail: expect.stringContaining("moved while the tick read it") });
    expect(calls).toEqual([]);
  });

  it("repairs the body after its own push whose update failed, from the journal's exact head, and nothing else", async () => {
    const journal = new MemoryJournal();
    const body = withMarker(RULES, "New plan.", { head: PUSHED_SHA, base: BASE_SHA, adaptations: 1 });
    await journal.pushed(REPO, 7, { head: PUSHED_SHA, base: BASE_SHA, publication: { title: "new plan title", body, adaptations: 1 } });
    const github = new FakeGitHub(ownPr({ headSha: PUSHED_SHA }));
    const workspace = new InMemoryWorkspace();
    const ctx = { ...context(github, workspace, workingCopy(), journal) };
    workspace.setRemoteHead("secure-it/2026-10-05-snappy-java", PUSHED_SHA);
    const entries = await reviewOpenPullRequests(ctx, steps());
    expect(entries[0]?.outcome).toBe("marked-ready");
    expect(github.prs.get(7)).toMatchObject({ title: "new plan title", body });
    expect(stateOf(github.prs.get(7)!.body)).toEqual({ head: PUSHED_SHA, base: BASE_SHA, adaptations: 1 });

    const other = new FakeGitHub(ownPr({ headSha: "9".repeat(40) }));
    expect((await reviewOpenPullRequests(context(other, new InMemoryWorkspace(), workingCopy(), journal), steps()))[0]?.outcome).toBe("left-alone");
  });

  it("recovers the changed plan and count before adapting a pushed head whose body update failed", async () => {
    const workspace = new InMemoryWorkspace();
    const original = ownPr({ body: withMarker(RULES, "Old plan.", { head: HEAD_SHA, base: BASE_SHA, adaptations: 2 }) });
    const failed = new FakeGitHub(original);
    failed.fail("updatePullRequest");
    const journal = new MemoryJournal();
    const ctx = context(failed, workspace, workingCopy(), journal);
    const content = { title: "new target", body: "<!-- leanish:plan {\"target\":\"2.0.0\"} -->", commitMessage: "new target" };
    await expect(publishUpdate(ctx, { branch: original.headRef, baseSha: BASE_SHA, remoteHeadSha: HEAD_SHA, preparedSha: HEAD_SHA }, 7, content, 0)).rejects.toThrow("unexpected response");
    const github = new FakeGitHub({ ...original, headSha: PUSHED_SHA });
    github.checks = RED;
    const recovered = context(github, workspace, workingCopy(), journal);
    workspace.setRemoteHead(original.headRef, PUSHED_SHA);
    let observed: GitHubPullRequest | undefined;
    const entries = await reviewOpenPullRequests(recovered, { ...steps(), adapt: async (pr, _prepared, _publication, attempt) => {
      observed = pr;
      expect(attempt).toBe(1);
      return false;
    } });
    expect(entries[0]?.outcome).toBe("adaptation-unchanged");
    expect(observed).toMatchObject({ title: content.title, body: expect.stringContaining(content.body) });
    expect(stateOf(github.prs.get(7)!.body)?.adaptations).toBe(1);
  });

  it("does not mark a legacy journal head ready or adapt it without its matching publication", async () => {
    const journal = new MemoryJournal();
    await journal.pushed(REPO, 7, { head: PUSHED_SHA, base: BASE_SHA });
    for (const checks of [RED, new FakeGitHub().checks]) {
      const github = new FakeGitHub(ownPr({ headSha: PUSHED_SHA }));
      github.checks = checks;
      const calls: string[] = [];
      const entries = await reviewOpenPullRequests(context(github, new InMemoryWorkspace(), workingCopy(), journal), steps(calls));
      expect(entries[0]).toMatchObject({ outcome: "error", detail: expect.stringContaining("no matching publication content") });
      expect(calls).toEqual([]);
      expect(github.calls.some((call) => call.startsWith("markReadyForReview"))).toBe(false);
    }
  });

  it("counts an adaptation before the agent starts, so failing attempts still run out", async () => {
    const github = new FakeGitHub(ownPr());
    github.checks = RED;
    let calls = 0;
    const failing: ReviewSteps = {
      ...steps(),
      async adapt() {
        calls++;
        throw new Error("the agent's answer failed its schema");
      },
    };
    expect((await reviewOpenPullRequests(context(github), failing))[0]).toMatchObject({ outcome: "error" });
    expect(stateOf(github.prs.get(7)!.body)?.adaptations).toBe(1);
    expect((await reviewOpenPullRequests(context(github), failing))[0]).toMatchObject({ outcome: "error" });
    expect((await reviewOpenPullRequests(context(github), failing))[0]).toMatchObject({ outcome: "closed" });
    expect(calls).toBe(2);
  });
});
