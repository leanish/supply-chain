/**
 * secure-it: fixes what the supply-chain gate's full scan fails on, one
 * package per run (every malicious package together), with the version the
 * gate's rule picks, and opens a PR for it. The code decides and verifies;
 * the agent edits (design items 12, 19–24).
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";
import type { PreparedBranch, WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { ActionsGitHub } from "../../ci/src/actions-github.ts";
import { type SecurityCandidates, type SecurityFix, securityCandidates } from "../../ci/src/candidates.ts";
import type { GateEnvironment, GradleInputs } from "../../ci/src/gate.ts";
import { namingFailures } from "../../ci/src/http.ts";
import { runProcess } from "../../ci/src/process.ts";
import { gitTree, type Tree, workingTree } from "../../ci/src/tree.ts";
import { failingCheckNames } from "../../remediation/src/ci-state.ts";
import type { ToolHandlers, ToolRunContext } from "../../remediation/src/command.ts";
import { FLOORS_FILE, isMechanical } from "../../remediation/src/edit-checks.ts";
import { changedSince } from "../../remediation/src/git-copies.ts";
import { type GradleInventories, lockfilesOf, sandboxedGradleInventories } from "../../remediation/src/inventories.ts";
import { FileJournal, type PublicationJournal } from "../../remediation/src/journal.ts";
import { requireNpmExcludes } from "../../remediation/src/npm-version.ts";
import { runSandboxed } from "../../remediation/src/sandboxed.ts";
import { ensureOsvScanner, verifyingRun } from "../../remediation/src/osv-scanner.ts";
import { branchFor, ownPullRequests, stateOf, topicOf } from "../../remediation/src/own-pr.ts";
import { revertToBase } from "../../remediation/src/reconcile.ts";
import { clearLeftoverBranch, closeAndDelete, ownOpenPullRequests, type PublicationContext, publishNew, publishUpdate } from "../../remediation/src/publication.ts";
import { type BaseMerge, reviewOpenPullRequests, type ReviewSteps } from "../../remediation/src/review.ts";

import { npmWindowFor } from "./npm-window.ts";
import { planDigest, planOf, planSection, withPlanSection } from "./plan-block.ts";
import { type ChangePlan, packageKey, planFor, selectWork } from "./plan.ts";
import { staleScanStatus, type StaleScan } from "./stale-scan.ts";
import { verifyPlan, type VerifyInputs } from "./verify.ts";

export const RULES = ownPullRequests("secure-it");
const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

/** What the agent answers (the skill's output schema). */
interface SkillAnswer {
  readonly outcome: "applied" | "cannot-apply";
  readonly summary: string;
  readonly publication?: { readonly title: string; readonly body: string; readonly commitMessage: string };
}

/** What secure-it reaches outside its own logic; tests replace them. */
export interface SecureItDeps {
  readonly gate: (context: ToolRunContext) => Promise<GateEnvironment>;
  readonly gradle: (context: ToolRunContext) => GradleInventories;
  readonly trees: { readonly commit: (workingCopy: WorkingCopy, sha: string) => Promise<Tree>; readonly working: (workingCopy: WorkingCopy) => Tree };
  readonly candidates: (tree: Tree, env: GateEnvironment, gradle: GradleInputs) => Promise<SecurityCandidates>;
  readonly verify: (inputs: VerifyInputs) => Promise<string[]>;
  readonly staleScan: (context: ToolRunContext) => Promise<StaleScan>;
  readonly changedSince: (workingCopy: WorkingCopy, sha: string) => Promise<string[]>;
  readonly journal: (context: ToolRunContext) => PublicationJournal;
  /** Writes `content` at `path` (relative to the working copy): taking the base's side of a conflicted dependency file. */
  readonly writeFile: (workingCopy: WorkingCopy, path: string, content: string) => Promise<void>;
  /** npm under the same sandbox and PATH as the agent, used to check exclusion support. */
  readonly npm: (context: ToolRunContext, args: ReadonlyArray<string>) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Puts every path that differs from `baseSha` back to the base's content (reconcile by revert); returns them. */
  readonly revert: (workingCopy: WorkingCopy, baseSha: string) => Promise<string[]>;
}

export function defaultDeps(): SecureItDeps {
  return {
    gate: async (context) => {
      // Outside everything sandboxed commands can write, and checked right before each run.
      const writable = [context.config.dirs.cache, context.workingCopy.path, tmpdir(), "/tmp", ...(context.isolation.buildCacheRoot === undefined ? [] : [context.isolation.buildCacheRoot])];
      const osv = await ensureOsvScanner(context.config.dirs.state, writable);
      return { run: verifyingRun(runProcess, osv), fetch: namingFailures((url, init) => fetch(url, init)), now: () => new Date(), osvScanner: osv.path, githubToken: context.readToken };
    },
    gradle: (context) => sandboxedGradleInventories(context.isolation, context.workingCopy),
    trees: { commit: (workingCopy, sha) => gitTree(workingCopy.path, sha, runProcess), working: (workingCopy) => workingTree(workingCopy.path) },
    candidates: securityCandidates,
    npm: (context, args) => runSandboxed(context.isolation, { workingCopy: context.workingCopy, command: ["npm", ...args] }),
    verify: verifyPlan,
    staleScan: (context) => staleScanStatus(context.repo.repo, context.base, context.readToken, context.now, context.config.staleScanHours ?? 36),
    changedSince: (workingCopy, sha) => changedSince(workingCopy, sha),
    journal: (context) => new FileJournal(context.config.dirs.state),
    writeFile: (workingCopy, path, content) => writeFile(join(workingCopy.path, path), content),
    revert: (workingCopy, baseSha) => revertToBase(workingCopy, baseSha),
  };
}

export function secureIt(deps: SecureItDeps = defaultDeps()): ToolHandlers {
  return {
    tool: "secure-it",
    skills: { dirs: [SKILLS_DIR], entrypoints: ["secure-it"], support: [] },
    run: (context) => run(context, deps),
    review: (context) => review(context, deps),
  };
}

function publicationOf(context: ToolRunContext, deps: SecureItDeps): PublicationContext {
  return {
    rules: RULES,
    github: context.github,
    workspace: context.workspace,
    logger: context.logger,
    repo: context.repo.repo,
    base: context.base,
    workingCopy: context.workingCopy,
    journal: deps.journal(context),
  };
}

function skillInput(context: ToolRunContext, plan: ChangePlan, npmAgeExclusions: ReadonlyArray<string>, mode: "apply" | "adapt" | "resolve", extra: { failingChecks?: string[]; conflicted?: ReadonlyArray<string> } = {}) {
  return {
    repo: context.repo.repo,
    mode,
    today: context.now.toISOString().slice(0, 10),
    moves: plan.moves.map((move) => ({
      ecosystem: move.ecosystem,
      name: move.name,
      from: move.from,
      to: move.to,
      mechanism: move.mechanism,
      locations: [...move.locations],
      advisories: [...move.advisories],
      major: move.major,
      ...(move.commitSha === undefined ? {} : { commitSha: move.commitSha }),
      ...(move.declaredAs === undefined ? {} : { declaredAs: move.declaredAs }),
    })),
    floorsFile: FLOORS_FILE,
    npmAgeExclusions: [...npmAgeExclusions],
    ...(extra.failingChecks === undefined ? {} : { failingChecks: extra.failingChecks }),
    ...(extra.conflicted === undefined ? {} : { conflicted: [...extra.conflicted] }),
  };
}

/** Every agent mode receives the same explicit npm window, after checking the sandbox's npm. */
async function agentInput(
  context: ToolRunContext,
  deps: SecureItDeps,
  env: GateEnvironment,
  plan: ChangePlan,
  mode: "apply" | "adapt" | "resolve",
  extra: { failingChecks?: string[]; conflicted?: ReadonlyArray<string> } = {},
) {
  const window = await npmWindowFor(plan, context.releaseAgeDays, context.releaseAgeExclude, context.now, env.fetch);
  for (const detail of window.notes) context.logger.warn("secure-it: npm release-age exclusion", { detail });
  if (plan.moves.some((move) => move.ecosystem === "npm")) {
    await requireNpmExcludes((_dir, args) => deps.npm(context, args), context.workingCopy.path, window.exclude, "planned young or unreadable security targets or own-package exclusions");
  }
  return skillInput(context, plan, window.exclude, mode, extra);
}

const effortFor = (context: ToolRunContext, plan: ChangePlan) => (plan.moves.some((move) => move.major) ? context.config.agent.majorEffort : context.config.agent.effort);

async function run(context: ToolRunContext, deps: SecureItDeps): Promise<Readonly<Record<string, unknown>>> {
  const staleScan = await deps.staleScan(context);
  if (staleScan.stale) context.logger.warn("secure-it: the daily scan looks stale", { detail: staleScan.detail });
  const env = await deps.gate(context);
  const inventories = deps.gradle(context);
  const baseSha = context.workingCopy.headSha;
  const base = await deps.trees.commit(context.workingCopy, baseSha);
  const baseGradle = await inventories.ofCommit(base);
  const found = await deps.candidates(base, env, { head: baseGradle });
  const report = { staleScan, gaps: found.gaps.length };
  if (found.incomplete.length > 0) return { ...report, outcome: "incomplete", incomplete: found.incomplete };
  const initial = selectWork(found.fixes);
  if (initial.work.length === 0) return { ...report, outcome: "nothing-to-fix", waiting: initial.blocked.flatMap((group) => group.reasons), skipped: [] };
  const publication = publicationOf(context, deps);
  const own = await ownOpenPullRequests(context.github, RULES, context.repo.repo, context.base);
  const selected = await nextPlan(context, found.fixes, base, baseGradle, env, publication, own);
  const { plan, reusable, waiting, skipped } = selected;
  const details = { ...report, waiting, skipped };
  if (plan === undefined) {
    return skipped.length === 0
      ? { ...details, outcome: "nothing-to-fix" }
      : { ...details, outcome: "already-open", pullRequest: skipped[0]?.pullRequest };
  }
  const digest = planDigest(plan);
  const topicBranch = branchFor(RULES, context.now, plan.topic);
  // An open PR for the package is reconciled to the new plan; one someone else pushed to is left alone.
  const input = await agentInput(context, deps, env, plan, "apply");
  let prepared: PreparedBranch;
  if (reusable !== undefined) {
    prepared = await reconcileBranch(context, deps, reusable, baseSha);
  } else {
    const taken = new Set(own.map((pr) => pr.headRef));
    let branch = topicBranch;
    for (let n = 2; taken.has(branch); n++) branch = branchFor(RULES, context.now, `${plan.topic}-${n}`);
    await clearLeftoverBranch(context.github, RULES, context.repo.repo, branch);
    const fresh = await context.workspace.prepareBranch(context.workingCopy, { branch, start: "default" });
    if (fresh.kind !== "prepared") throw new Error(`${branch} couldn't be prepared`);
    prepared = fresh.prepared;
  }

  const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({ entrypoint: "secure-it", input, effort: effortFor(context, plan) });
  if (answer.outcome !== "applied" || answer.publication === undefined) return { ...details, outcome: "cannot-apply", summary: answer.summary, plan: digest };

  const problems = await verifyEdit(context, deps, plan, env, inventories, base, baseGradle);
  if (problems.length > 0) return { ...details, outcome: "verification-failed", problems };

  const content = { title: answer.publication.title, body: `${answer.publication.body}\n\n${planSection(plan)}`, commitMessage: answer.publication.commitMessage };
  if (reusable !== undefined) {
    const { pr } = await publishUpdate(publication, prepared, reusable.number, content, 0);
    return { ...details, outcome: "updated", pullRequest: pr.url };
  }
  const created = await publishNew(publication, prepared, content);
  if (created === undefined) return { ...details, outcome: "nothing-changed", summary: answer.summary };
  return { ...details, outcome: "published", pullRequest: created.url };
}

interface SelectedPlan {
  readonly plan: ChangePlan | undefined;
  readonly reusable: GitHubPullRequest | undefined;
  readonly waiting: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<{ readonly packages: ReadonlyArray<string>; readonly pullRequest: string }>;
}

/** Walk complete groups in rank order; an identical owned PR belongs to review, not this run. */
async function nextPlan(
  context: ToolRunContext,
  fixes: ReadonlyArray<SecurityFix>,
  base: Tree,
  baseGradle: GradleInputs["head"],
  env: GateEnvironment,
  publication: PublicationContext,
  own: ReadonlyArray<GitHubPullRequest>,
): Promise<SelectedPlan> {
  const actions = new ActionsGitHub(env.fetch, env.githubToken);
  const lockfiles = await lockfilesOf(base);
  const waiting: string[] = [];
  const skipped: Array<{ packages: ReadonlyArray<string>; pullRequest: string }> = [];
  let remaining = fixes;
  while (remaining.length > 0) {
    const { work, blocked } = selectWork(remaining);
    waiting.push(...blocked.flatMap((group) => group.reasons));
    if (work.length === 0) break;
    const plan = await planFor(work, { lockfiles, gradle: baseGradle, tagCommit: (action, tag) => actions.tagCommit(action, tag) });
    const owned = await recognisedPlans(context, publication, own, plan);
    const already = owned.find((pr) => {
      const existing = planOf(pr.body);
      return existing !== undefined && planDigest(existing) === planDigest(plan);
    });
    if (already === undefined) return { plan, reusable: owned[0], waiting, skipped };
    skipped.push({ packages: plan.packages, pullRequest: already.url });
    // Every malicious package must move together; no other group can pass while malware remains in base.
    if (plan.malware) break;
    const handled = new Set([...plan.packages, ...blocked.flatMap((group) => group.packages)]);
    remaining = remaining.filter((fix) => !handled.has(packageKey(fix)));
  }
  return { plan: undefined, reusable: undefined, waiting, skipped };
}

async function recognisedPlans(
  context: ToolRunContext,
  publication: PublicationContext,
  own: ReadonlyArray<GitHubPullRequest>,
  plan: ChangePlan,
): Promise<GitHubPullRequest[]> {
  const topic = topicOf(RULES, branchFor(RULES, context.now, plan.topic));
  const owned: GitHubPullRequest[] = [];
  for (const pr of own) {
    // A numeric suffix is the tool's PR opened next to one a human took over.
    const prTopic = topicOf(RULES, pr.headRef);
    const suffix = prTopic?.startsWith(`${topic}-`) ? prTopic.slice(`${topic}-`.length) : undefined;
    if (prTopic !== topic && (suffix === undefined || !/^\d+$/.test(suffix) || planOf(pr.body)?.topic !== plan.topic)) continue;
    const recorded = stateOf(pr.body);
    const journaled = await publication.journal.last(context.repo.repo, pr.number);
    if (recorded?.head === pr.headSha || journaled?.head === pr.headSha) owned.push(pr);
  }
  return owned;
}

/**
 * The PR's branch with the default branch (at `baseSha`, what the new plan was
 * computed on) merged in and every file it changed put back to the base's
 * content (design item 28): the new plan then goes on the base as it is, and
 * what the old plan changed and the new one doesn't want goes.
 */
async function reconcileBranch(context: ToolRunContext, deps: SecureItDeps, pr: GitHubPullRequest, baseSha: string): Promise<PreparedBranch> {
  const merged = await context.workspace.prepareBranch(context.workingCopy, { branch: pr.headRef, start: "remote-merging" });
  if (merged.kind === "conflict") throw new Error(`${pr.headRef}: remote-merging reported a conflict without leaving it in progress`);
  if (merged.prepared.remoteHeadSha !== pr.headSha) throw new Error(`${pr.url} moved while secure-it prepared it`);
  if (merged.prepared.baseSha !== baseSha) throw new Error(`the default branch moved while secure-it ran (${baseSha.slice(0, 12)} → ${merged.prepared.baseSha.slice(0, 12)}); the next run starts over`);
  await deps.revert(context.workingCopy, baseSha);
  return merged.prepared;
}

/** Item 23 on the working copy as the agent left it, against `base`. */
async function verifyEdit(
  context: ToolRunContext,
  deps: SecureItDeps,
  plan: ChangePlan,
  env: GateEnvironment,
  inventories: GradleInventories,
  base: Tree,
  baseGradle: GradleInputs["head"],
): Promise<string[]> {
  const head = deps.trees.working(context.workingCopy);
  const headGradle = await inventories.ofWorkingTree(head);
  return deps.verify({ plan, base, head, env, gradle: { base: baseGradle, head: headGradle }, changedFiles: await deps.changedSince(context.workingCopy, base.id) });
}

async function review(context: ToolRunContext, deps: SecureItDeps): Promise<Readonly<Record<string, unknown>>> {
  const env = await deps.gate(context);
  const inventories = deps.gradle(context);
  const publication = publicationOf(context, deps);
  const actions = new ActionsGitHub(env.fetch, env.githubToken);
  const planFrom = (pr: GitHubPullRequest): ChangePlan => {
    const plan = planOf(pr.body);
    if (plan === undefined) throw new Error(`${pr.url} has no plan secure-it can read`);
    return plan;
  };
  const verifyAgainst = async (plan: ChangePlan, baseSha: string) => {
    const base = await deps.trees.commit(context.workingCopy, baseSha);
    return verifyEdit(context, deps, plan, env, inventories, base, await inventories.ofCommit(base));
  };
  const steps: ReviewSteps = {
    async rebase(pr, merge: BaseMerge) {
      const previous = planFrom(pr);
      const baseSha = merge.prepared.baseSha;
      // Recomputed on the new base first: it may already have the fix, or need a different one.
      const base = await deps.trees.commit(context.workingCopy, baseSha);
      const baseGradle = await inventories.ofCommit(base);
      const found = await deps.candidates(base, env, { head: baseGradle });
      if (found.incomplete.length > 0) throw new Error(`the new base's inventory is incomplete: ${found.incomplete.join("; ")}`);
      const ours = new Set(previous.packages);
      const still = found.fixes.filter((fix) => ours.has(packageKey(fix)));
      if (still.length === 0) {
        await closeAndDelete(publication, pr.number, pr.headSha, "The default branch has these fixes now, so this PR has nothing left to change.");
        return "retired";
      }
      const { work, blocked } = selectWork(still);
      if (work.length === 0) throw new Error(`on the new base the fix is blocked: ${blocked.flatMap((group) => group.reasons).join("; ")}`);
      const plan = await planFor(work, { lockfiles: await lockfilesOf(base), gradle: baseGradle, tagCommit: (action, tag) => actions.tagCommit(action, tag) });
      const changed = planDigest(plan) !== planDigest(previous);
      const code: string[] = [];
      if (changed) {
        // A different plan: the old one's edits go (conflicts included), the new one is applied on the base as it is.
        await deps.revert(context.workingCopy, baseSha);
      } else if (merge.kind === "conflicted") {
        for (const path of merge.conflicted) {
          const theirs = isMechanical(path) ? await base.read(path) : undefined;
          if (theirs === undefined) code.push(path);
          else await deps.writeFile(context.workingCopy, path, theirs);
        }
      }
      // The agent applies a changed plan, or re-applies the same one over the base's side of conflicted dependency
      // files, resolving code conflicts too.
      let content = { title: pr.title, body: withPlanSection(pr.body, plan), commitMessage: `merging ${context.base}` };
      if (changed || merge.kind === "conflicted") {
        const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
          entrypoint: "secure-it",
          input: await agentInput(context, deps, env, plan, code.length > 0 ? "resolve" : "apply", code.length > 0 ? { conflicted: code } : {}),
          effort: effortFor(context, plan),
        });
        if (answer.outcome !== "applied") throw new Error(`the agent couldn't re-apply the plan on the new base: ${answer.summary}`);
        // A different plan is a different change: its own title and description.
        if (changed && answer.publication !== undefined) {
          content = { title: answer.publication.title, body: `${answer.publication.body}\n\n${planSection(plan)}`, commitMessage: answer.publication.commitMessage };
        }
      }
      // Fixes remain (the recomputation said so): an edit that left the base as it was fails verification, it isn't retired.
      const problems = await verifyEdit(context, deps, plan, env, inventories, base, baseGradle);
      if (problems.length > 0) throw new Error(`after merging the default branch: ${problems.join("; ")}`);
      await publishUpdate(publication, merge.prepared, pr.number, content);
      return "rebased";
    },
    async adapt(pr, prepared, _context, attempt) {
      const plan = planFrom(pr);
      const checks = await context.github.headChecks({ repo: context.repo.repo, sha: pr.headSha });
      const failingChecks = failingCheckNames(checks);
      const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
        entrypoint: "secure-it",
        input: await agentInput(context, deps, env, plan, "adapt", { failingChecks }),
        effort: effortFor(context, plan),
      });
      if (answer.outcome !== "applied" || answer.publication === undefined) return false;
      const problems = await verifyAgainst(plan, prepared.baseSha);
      if (problems.length > 0) throw new Error(`the adaptation doesn't verify: ${problems.join("; ")}`);
      const { pushed } = await publishUpdate(publication, prepared, pr.number, { title: pr.title, body: pr.body, commitMessage: answer.publication.commitMessage }, attempt);
      return pushed;
    },
  };
  const reviewed = await reviewOpenPullRequests({ ...publication }, steps);
  return { outcome: "reviewed", reviewed };
}
