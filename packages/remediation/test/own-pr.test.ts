import { describe, expect, it } from "vitest";

import { branchFor, isOwnPullRequest, ownPullRequests, stateOf, topicOf, withMarker } from "../src/own-pr.ts";
import { BASE_SHA, HEAD_SHA, ownPr, RULES } from "./fake-github.ts";

describe("own PRs", () => {
  it.each(["secure-it", "bump-it"] as const)("publishes %s's new label and recognises its legacy label even without a marker", (tool) => {
    const rules = ownPullRequests(tool);
    const pr = ownPr({ headRef: `${tool}/2026-10-05-security`, body: "No marker.", labels: [`leanish:agent=${tool}`] });
    expect(rules.label).toBe(`leanish:${tool}`);
    expect(rules.marker).toBe(`<!-- leanish:agent=${tool} -->`);
    expect(isOwnPullRequest(rules, pr, "leanish/widget", "main")).toBe(true);
    expect(isOwnPullRequest(rules, { ...pr, labels: [`leanish:${tool}`] }, "leanish/widget", "main")).toBe(true);
    const other = tool === "secure-it" ? "bump-it" : "secure-it";
    expect(isOwnPullRequest(rules, { ...pr, labels: [`leanish:agent=${other}`, `leanish:${other}`] }, "leanish/widget", "main")).toBe(false);
    expect(isOwnPullRequest(rules, { ...pr, headRepo: "someone/widget" }, "leanish/widget", "main")).toBe(false);
    expect(isOwnPullRequest(rules, { ...pr, state: "closed" }, "leanish/widget", "main")).toBe(false);
  });

  it("names a branch by tool, UTC date and a branch-safe topic", () => {
    const now = new Date("2026-10-07T23:30:00Z");
    expect(branchFor(RULES, now, "org.xerial.snappy:snappy-java")).toBe("secure-it/2026-10-07-org.xerial.snappy-snappy-java");
    expect(branchFor(ownPullRequests("bump-it"), now, "@types/node 26")).toBe("bump-it/2026-10-07-types-node-26");
    expect(() => branchFor(RULES, now, "@@@")).toThrow("needs a topic");
    expect(topicOf(RULES, branchFor(RULES, now, "vite"))).toBe("vite");
    expect(topicOf(RULES, "secure-it/2026-01-02-vite")).toBe("vite");
    expect(topicOf(RULES, "bump-it/2026-01-02-vite")).toBeUndefined();
  });

  it("recognises the tool's open PRs from its own branches and repo, by marker or label", () => {
    const repo = "leanish/widget";
    expect(isOwnPullRequest(RULES, ownPr(), repo, "main")).toBe(true);
    expect(isOwnPullRequest(RULES, ownPr({ labels: [] }), repo, "main")).toBe(true);
    expect(isOwnPullRequest(RULES, ownPr({ body: "no marker" }), repo, "main")).toBe(true);
    expect(isOwnPullRequest(RULES, ownPr({ body: "no marker", labels: [] }), repo, "main")).toBe(false);
    expect(isOwnPullRequest(RULES, ownPr({ headRepo: "someone/widget" }), repo, "main")).toBe(false);
    expect(isOwnPullRequest(RULES, ownPr({ baseRef: "release" }), repo, "main")).toBe(false);
    expect(isOwnPullRequest(RULES, ownPr({ state: "closed" }), repo, "main")).toBe(false);
    expect(isOwnPullRequest(RULES, ownPr({ headRef: "bump-it/2026-10-05-snappy-java" }), repo, "main")).toBe(false);
    expect(isOwnPullRequest(ownPullRequests("bump-it"), ownPr(), repo, "main")).toBe(false);
  });

  it("keeps one state and one marker at the end of the body, replacing earlier ones", () => {
    const once = withMarker(RULES, "Fixes snappy.", { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 });
    expect(once).toBe(`Fixes snappy.\n\n<!-- leanish:state head=${HEAD_SHA} base=${BASE_SHA} adaptations=0 -->\n${RULES.marker}\n`);
    const twice = withMarker(RULES, `${once}\nMore.`, { head: BASE_SHA, base: HEAD_SHA, adaptations: 2 });
    expect(twice.match(/leanish:state/g)).toHaveLength(1);
    expect(twice.match(/leanish:agent=secure-it/g)).toHaveLength(1);
    expect(stateOf(twice)).toEqual({ head: BASE_SHA, base: HEAD_SHA, adaptations: 2 });
    expect(stateOf("no state")).toBeUndefined();
    expect(() => withMarker(RULES, "x", { head: "nope", base: BASE_SHA, adaptations: 0 })).toThrow("invalid PR state");
  });
});
