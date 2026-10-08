import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "../../agent-basics/src/logger/console-logger.ts";
import type { PreparedBranch, WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { InMemoryWorkspace } from "../../agent-basics/src/working-copy/in-memory-workspace.ts";
import { MemoryJournal } from "../src/journal.ts";
import { ownPullRequests, stateOf, withMarker } from "../src/own-pr.ts";
import { clearLeftoverBranch, closeAndDelete, markReady, ownOpenPullRequests, publishNew, publishUpdate, recordState, recoverPublication, type PublicationContext } from "../src/publication.ts";
import { BASE_SHA, FakeGitHub, HEAD_SHA, OWN_BRANCH, ownPr, PUSHED_SHA, RULES } from "./fake-github.ts";

const WC: WorkingCopy = { projectId: "leanish/widget", path: "/synthetic/leanish/widget", branch: "main", headSha: BASE_SHA, gitDir: "/x/.git" };
const CONTENT = { title: "fixing snappy-java", body: "Moves snappy-java to 1.1.10.10.", commitMessage: "moving snappy-java to 1.1.10.10" };

function context(github: FakeGitHub, workspace = new InMemoryWorkspace(), journal = new MemoryJournal()): PublicationContext {
  return { rules: RULES, github, workspace, logger: new ConsoleLogger({ minLevel: "error" }), repo: "leanish/widget", base: "main", workingCopy: WC, journal };
}

const fresh: PreparedBranch = { branch: "secure-it/2026-10-07-vite", baseSha: BASE_SHA, remoteHeadSha: null, preparedSha: BASE_SHA };
const existing: PreparedBranch = { branch: OWN_BRANCH, baseSha: BASE_SHA, remoteHeadSha: HEAD_SHA, preparedSha: HEAD_SHA };

describe("publication", () => {
  it.each(["secure-it", "bump-it"] as const)("adds %s's new label when publishing or updating, keeping the legacy label", async (tool) => {
    const rules = ownPullRequests(tool);
    const branch = `${tool}/2026-10-05-security`;
    const created = new FakeGitHub();
    const pr = await publishNew({ ...context(created), rules }, { ...fresh, branch }, CONTENT);
    expect(created.prs.get(pr!.number)?.labels).toEqual([`leanish:${tool}`]);

    for (const unchanged of [false, true]) {
      const legacy = `leanish:agent=${tool}`;
      const github = new FakeGitHub(ownPr({ headRef: branch, labels: [legacy], body: "No marker.", isDraft: false }));
      const workspace = new InMemoryWorkspace();
      if (unchanged) workspace.setPublishUnchanged();
      await publishUpdate({ ...context(github, workspace), rules }, { ...existing, branch }, 7, CONTENT);
      expect(github.prs.get(7)?.labels).toEqual([legacy, `leanish:${tool}`]);
      expect(github.calls.filter((call) => call.startsWith("addLabels"))).toEqual([`addLabels 7 leanish:${tool}`]);
    }
  });

  it("adds the current label when recording state, recovering a publication or marking a legacy PR ready", async () => {
    const legacy = "leanish:agent=secure-it";
    const updated = new FakeGitHub(ownPr({ labels: [legacy] }));
    await recordState(context(updated), 7, HEAD_SHA, { head: HEAD_SHA, base: BASE_SHA, adaptations: 1 });
    expect(updated.prs.get(7)?.labels).toEqual([legacy, "leanish:secure-it"]);

    const recovering = new FakeGitHub(ownPr({ labels: [legacy], headSha: PUSHED_SHA }));
    const journal = new MemoryJournal();
    const body = withMarker(RULES, CONTENT.body, { head: PUSHED_SHA, base: BASE_SHA, adaptations: 1 });
    await journal.pushed(WC.projectId, 7, { head: PUSHED_SHA, base: BASE_SHA, publication: { title: CONTENT.title, body, adaptations: 1 } });
    await recoverPublication(context(recovering, new InMemoryWorkspace(), journal), recovering.prs.get(7)!);
    expect(recovering.prs.get(7)?.labels).toEqual([legacy, "leanish:secure-it"]);

    const ready = new FakeGitHub(ownPr({ labels: [legacy] }));
    await markReady(context(ready), 7, HEAD_SHA);
    expect(ready.prs.get(7)).toMatchObject({ isDraft: false, labels: [legacy, "leanish:secure-it"] });
  });

  it("opens a labelled draft PR recording the pushed head and its base, or nothing when nothing changed", async () => {
    const github = new FakeGitHub();
    const pr = await publishNew(context(github), fresh, CONTENT);
    expect(pr).toMatchObject({ isDraft: true, headRef: "secure-it/2026-10-07-vite" });
    expect(stateOf(github.prs.get(pr!.number)!.body)).toEqual({ head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 });
    expect(github.prs.get(pr!.number)?.labels).toEqual([RULES.label]);

    const workspace = new InMemoryWorkspace();
    workspace.setPublishUnchanged();
    expect(await publishNew(context(new FakeGitHub(), workspace), fresh, CONTENT)).toBeUndefined();
    await expect(publishNew(context(github), existing, CONTENT)).rejects.toThrow("exists already");
  });

  it("updates an existing PR as a draft, then puts a ready PR back to ready when nothing new was pushed", async () => {
    const github = new FakeGitHub(ownPr({ isDraft: false }));
    const { pr, pushed } = await publishUpdate(context(github), existing, 7, CONTENT);
    expect(pushed).toBe(true);
    expect(github.calls.filter((call) => /convertToDraft|markReadyForReview/.test(call))).toEqual(["convertToDraft PR_node7"]);
    expect(stateOf(pr.body)).toEqual({ head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 });

    const unchanged = new FakeGitHub(ownPr({ isDraft: false, body: withMarker(RULES, "Body.", { head: HEAD_SHA, base: BASE_SHA, adaptations: 1 }) }));
    const workspace = new InMemoryWorkspace();
    workspace.setPublishUnchanged();
    const result = await publishUpdate(context(unchanged, workspace), existing, 7, CONTENT);
    expect(result.pushed).toBe(false);
    expect(unchanged.prs.get(7)?.isDraft).toBe(false);
    // The adaptation count carries over unless the caller sets it.
    expect(stateOf(result.pr.body)).toEqual({ head: HEAD_SHA, base: BASE_SHA, adaptations: 1 });
  });

  it("records the commit in the journal before pushing it, and pushes nothing when it can't", async () => {
    const workspace = new InMemoryWorkspace();
    const rejecting = { pushed: async () => { throw new Error("disk full"); }, last: async () => undefined };
    await expect(publishUpdate({ ...context(new FakeGitHub(ownPr()), workspace), journal: rejecting }, existing, 7, CONTENT)).rejects.toThrow("disk full");
    expect(workspace.publications).toHaveLength(1);
  });

  it("records a push in the journal before the body says so, so a failed update leaves a trace", async () => {
    const github = new FakeGitHub(ownPr());
    github.fail("updatePullRequest");
    const journal = new MemoryJournal();
    await expect(publishUpdate(context(github, new InMemoryWorkspace(), journal), existing, 7, CONTENT)).rejects.toThrow("unexpected response");
    expect(await journal.last("leanish/widget", 7)).toEqual({ head: PUSHED_SHA, base: BASE_SHA,
      publication: { title: CONTENT.title, body: withMarker(RULES, CONTENT.body, { head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 }), adaptations: 0 } });
    expect(stateOf(github.prs.get(7)!.body)?.head).toBe(HEAD_SHA);
  });

  it("refuses to publish over a PR that moved or stopped being the tool's", async () => {
    const moved = new FakeGitHub(ownPr({ headSha: "9".repeat(40) }));
    await expect(publishUpdate(context(moved), existing, 7, CONTENT)).rejects.toThrow("moved to 9999");
    const taken = new FakeGitHub(ownPr({ labels: [], body: "someone's now" }));
    await expect(publishUpdate(context(taken), existing, 7, CONTENT)).rejects.toThrow("no longer an open secure-it PR");
  });

  it("closes with a comment and deletes the branch, keeping it when it moved after the check", async () => {
    const github = new FakeGitHub(ownPr());
    const workspace = new InMemoryWorkspace();
    workspace.setDeleteMoved(OWN_BRANCH, "9".repeat(40));
    await closeAndDelete(context(github, workspace), 7, HEAD_SHA, "fixed on main already");
    expect(github.prs.get(7)?.state).toBe("closed");
    expect(github.calls).toContain("createComment 7 fixed on main already");
    expect(workspace.deletions).toHaveLength(1);
  });

  it("lists the tool's open PRs oldest first, and clears a leftover branch but not one with an open PR", async () => {
    const github = new FakeGitHub(ownPr({ number: 9, nodeId: "n9" }), ownPr(), ownPr({ number: 3, nodeId: "n3", labels: [], body: "not ours" }));
    expect((await ownOpenPullRequests(github, RULES, "leanish/widget", "main")).map((pr) => pr.number)).toEqual([7, 9]);
    github.branches.add("secure-it/2026-10-07-vite");
    await clearLeftoverBranch(github, RULES, "leanish/widget", "secure-it/2026-10-07-vite");
    expect(github.branches.has("secure-it/2026-10-07-vite")).toBe(false);
    await clearLeftoverBranch(github, RULES, "leanish/widget", "secure-it/2026-10-07-gone");
    await expect(clearLeftoverBranch(github, RULES, "leanish/widget", OWN_BRANCH)).rejects.toThrow("already has an open PR (#");
  });
});
