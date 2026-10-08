// Adapted from leanish/leanish-development agents/bump-it/src/own-pr.ts at e4f8a1e: one set of rules per tool
// (secure-it, bump-it) instead of bump-it's constants, and the PR's state (what the tool last published) in its body.
import type { GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";

export type ToolName = "secure-it" | "bump-it";

/** How a tool recognises its own PRs: branch, label and body marker. */
export interface OwnPullRequests {
  readonly tool: ToolName;
  /** `leanish:agent=<tool>`; it says which rule applies, CI still checks the proof for skipping the wait. */
  readonly label: string;
  /** The footer every PR body of the tool ends with. */
  readonly marker: string;
}

const MARKER = (tool: ToolName) => `<!-- leanish:agent=${tool} -->`;
const STATE = /<!-- leanish:state head=([0-9a-f]{40}) base=([0-9a-f]{40}) adaptations=(\d+) -->/;

/**
 * What the tool last published on a PR, kept in its body: the head it pushed,
 * the base it was computed against, and how many times the agent adapted it
 * after a failed CI. A head that differs means someone else pushed; a base
 * that differs means the plan has to be recomputed.
 */
export interface PullRequestState {
  readonly head: string;
  readonly base: string;
  readonly adaptations: number;
}

export function ownPullRequests(tool: ToolName): OwnPullRequests {
  return { tool, label: `leanish:agent=${tool}`, marker: MARKER(tool) };
}

/** The branch a run opens a PR from: `<tool>/<UTC date>-<topic>`, the topic made branch-safe. */
export function branchFor(rules: OwnPullRequests, now: Date, topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  if (slug === "") throw new Error(`a ${rules.tool} branch needs a topic with letters or digits; got '${topic}'`);
  return `${rules.tool}/${now.toISOString().slice(0, 10)}-${slug}`;
}

function isOwnBranch(rules: OwnPullRequests, branch: string): boolean {
  return new RegExp(`^${rules.tool}/\\d{4}-\\d{2}-\\d{2}-[a-z0-9._-]+$`).test(branch);
}

/**
 * A PR the tool may update, mark ready or close: an open PR from one of its
 * dated branches of `repo` itself (not a fork) into `base`, carrying the
 * marker or the label — either one, so a PR whose labelling failed is still
 * recognised.
 */
export function isOwnPullRequest(rules: OwnPullRequests, pr: GitHubPullRequest, repo: string, base: string): boolean {
  return (
    pr.state === "open" &&
    isOwnBranch(rules, pr.headRef) &&
    pr.headRepo?.toLowerCase() === repo.toLowerCase() &&
    pr.baseRef === base &&
    (pr.body.includes(rules.marker) || pr.labels.includes(rules.label))
  );
}

/** `body` ending with the PR's state and the marker, replacing earlier ones. */
export function withMarker(rules: OwnPullRequests, body: string, state: PullRequestState): string {
  if (!/^[0-9a-f]{40}$/.test(state.head) || !/^[0-9a-f]{40}$/.test(state.base) || !Number.isInteger(state.adaptations) || state.adaptations < 0) {
    throw new Error(`invalid PR state ${JSON.stringify(state)}`);
  }
  const bare = body.replaceAll(rules.marker, "").replace(new RegExp(STATE.source, "g"), "").trimEnd();
  return `${bare}\n\n<!-- leanish:state head=${state.head} base=${state.base} adaptations=${state.adaptations} -->\n${rules.marker}\n`;
}

/** The state the tool recorded in a PR body; undefined when there's none (a body someone rewrote). */
export function stateOf(body: string): PullRequestState | undefined {
  const found = STATE.exec(body);
  return found === null ? undefined : { head: found[1]!, base: found[2]!, adaptations: Number(found[3]) };
}
