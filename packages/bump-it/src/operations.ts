/** Planning and editing one independent unit; no publication until verification passes. */
import { isDeepStrictEqual } from "node:util";

import type { GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";
import type { PreparedBranch } from "../../agent-basics/src/types/working-copy.ts";
import { ActionsGitHub } from "../../ci/src/actions-github.ts";
import type { GateEnvironment, GradleInputs } from "../../ci/src/gate.ts";
import type { Tree } from "../../ci/src/tree.ts";
import type { ToolRunContext } from "../../remediation/src/command.ts";
import type { GradleInventories } from "../../remediation/src/inventories.ts";
import { branchFor, ownPullRequests, topicOf } from "../../remediation/src/own-pr.ts";
import { clearLeftoverBranch, type PublicationContext, type PullRequestContent } from "../../remediation/src/publication.ts";

import { constrainedUnit } from "./constraints.ts";
import type { BumpItDeps } from "./deps.ts";
import { formatManifest } from "./manifest-format.ts";
import { type BumpPlan, DEPENDENCY_FIELDS, planFor, planSection } from "./plan.ts";
import type { Unit } from "./units.ts";

export const RULES = ownPullRequests("bump-it");

export interface Execution {
  readonly context: ToolRunContext;
  readonly deps: BumpItDeps;
  readonly env: GateEnvironment;
  readonly inventories: GradleInventories;
  readonly publication: PublicationContext;
}

export interface Computed {
  readonly plan: BumpPlan;
  readonly files: ReadonlyMap<string, string>;
  readonly base: Tree;
  readonly gradle: GradleInputs["head"];
}

interface SkillAnswer {
  readonly outcome: "applied" | "cannot-apply";
  readonly summary: string;
  readonly publication?: PullRequestContent;
}

export async function compute(execution: Execution, unit: Unit, base: Tree, gradle: GradleInputs["head"]): Promise<Computed> {
  const bounded = await constrainedUnit(unit, base);
  const npm = await execution.deps.npm(execution.context, bounded.unit, base, execution.env, gradle);
  const actions = new ActionsGitHub(execution.env.fetch, execution.env.githubToken);
  const plan = await planFor(bounded.unit, { ...npm, notes: [...bounded.notes, ...npm.notes] }, (name, tag) => actions.tagCommit(name, tag));
  return { plan, files: npm.files, base, gradle };
}

export async function writeNpm(execution: Execution, files: ReadonlyMap<string, string>, preserveManifestFields = false): Promise<void> {
  for (const [path, content] of files) {
    let text = content;
    if (preserveManifestFields && path.endsWith("package.json")) {
      const current = await execution.deps.trees.working(execution.context.workingCopy).read(path);
      if (current !== undefined) {
        const manifest = JSON.parse(current) as Record<string, unknown>;
        const original = structuredClone(manifest);
        const planned = JSON.parse(content) as Record<string, unknown>;
        for (const field of DEPENDENCY_FIELDS) {
          if (planned[field] === undefined) {
            delete manifest[field];
          } else {
            manifest[field] = planned[field];
          }
        }
        text = isDeepStrictEqual(original, manifest) ? current : formatManifest(current, manifest);
      }
    }
    await execution.deps.writeFile(execution.context.workingCopy, path, text);
  }
}

export async function verify(execution: Execution, computed: Computed): Promise<void> {
  const { context, deps, env, inventories } = execution;
  const head = deps.trees.working(context.workingCopy);
  const problems = await deps.verify({
    plan: computed.plan,
    npmFiles: computed.files,
    base: computed.base,
    head,
    env,
    gradle: { base: computed.gradle, head: await inventories.ofWorkingTree(head) },
    changedFiles: await deps.changedSince(context.workingCopy, computed.base.id),
  });
  if (problems.length > 0) {
    throw new Error(`verification failed: ${problems.join("; ")}`);
  }
}

export async function edit(execution: Execution, computed: Computed, mode: "apply" | "adapt" | "resolve", extra: { failingChecks?: string[]; conflicted?: ReadonlyArray<string> } = {}): Promise<PullRequestContent> {
  await writeNpm(execution, computed.files);
  const { plan } = computed;
  if (plan.kind === "routine" && plan.moves.every((move) => move.mechanism === "npm-range")) {
    return mechanicalContent(plan);
  }
  const { context } = execution;
  const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
    entrypoint: "bump-it",
    input: skillInput(context, plan, mode, [...computed.files.keys()], extra),
    effort: plan.kind === "major" ? context.config.agent.majorEffort : context.config.agent.effort,
  });
  if (answer.outcome !== "applied" || answer.publication === undefined) {
    throw new Error(`the agent couldn't apply the plan: ${answer.summary}`);
  }
  if (answer.publication.body.includes("<!-- leanish:plan")) {
    throw new Error("the agent returned a reserved plan marker in its PR description");
  }
  return { ...answer.publication, body: `${answer.publication.body}\n\n${planSection(plan)}` };
}

function skillInput(context: ToolRunContext, plan: BumpPlan, mode: "apply" | "adapt" | "resolve", toolWritten: string[], extra: { failingChecks?: string[]; conflicted?: ReadonlyArray<string> }) {
  return {
    repo: context.repo.repo,
    today: context.now.toISOString().slice(0, 10),
    kind: plan.kind,
    mode,
    moves: plan.moves.map(({ declarations: _declarations, ...move }) => move),
    toolWritten,
    ...extra,
  };
}

export function mechanicalContent(plan: BumpPlan): PullRequestContent {
  const title = plan.kind === "routine" ? "refreshing dependencies" : `upgrading ${plan.moves[0]?.name ?? "dependency"}`;
  return { title, body: `Updates selected by the supply-chain version rule and verified before publication.\n\n${planSection(plan)}`, commitMessage: title };
}

export async function prepare(execution: Execution, unit: Unit, own: ReadonlyArray<GitHubPullRequest>, reusable: GitHubPullRequest | undefined, baseSha: string): Promise<PreparedBranch> {
  const { context, deps } = execution;
  if (reusable !== undefined) {
    const merged = await context.workspace.prepareBranch(context.workingCopy, { branch: reusable.headRef, start: "remote-merging" });
    if (merged.kind === "conflict") {
      throw new Error(`${reusable.headRef}: merge didn't leave its conflicts in progress`);
    }
    if (merged.prepared.remoteHeadSha !== reusable.headSha) {
      throw new Error(`${reusable.url}: someone pushed while preparing it`);
    }
    assertBase(merged.prepared, baseSha);
    await deps.revert(context.workingCopy, baseSha);
    return merged.prepared;
  }
  const taken = new Set(own.map((pr) => pr.headRef));
  let branch = branchFor(RULES, context.now, unit.topic);
  for (let n = 2; taken.has(branch); n++) {
    const suffix = `-${n}`;
    const slug = topicOf(RULES, branchFor(RULES, context.now, unit.topic))!;
    branch = branchFor(RULES, context.now, `${slug.slice(0, 60 - suffix.length)}${suffix}`);
  }
  await clearLeftoverBranch(context.github, RULES, context.repo.repo, branch);
  const fresh = await context.workspace.prepareBranch(context.workingCopy, { branch, start: "default" });
  if (fresh.kind !== "prepared") {
    throw new Error(`${branch} couldn't be prepared`);
  }
  assertBase(fresh.prepared, baseSha);
  return fresh.prepared;
}

export function assertBase(prepared: PreparedBranch, baseSha: string): void {
  if (prepared.baseSha !== baseSha) {
    throw new Error("the default branch moved while bump-it computed its plan; the next run starts over");
  }
}
