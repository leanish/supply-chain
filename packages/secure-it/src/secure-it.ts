/** Routine security fixes together, each major apart, or all malware first; every publication verifies. */
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
import { type ChangePlan, packageKey, planFor, selectWork, type SecurityUnit } from "./plan.ts";
import { namedProblems, retryWithoutNamed, type ProblemMoves } from "./retry.ts";
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

interface Execution {
  readonly context: ToolRunContext;
  readonly deps: SecureItDeps;
  readonly env: GateEnvironment;
  readonly inventories: GradleInventories;
  readonly publication: PublicationContext;
}

interface PlanBase {
  readonly tree: Tree;
  readonly gradle: GradleInputs["head"];
}

type Content = NonNullable<SkillAnswer["publication"]>;

async function run(context: ToolRunContext, deps: SecureItDeps): Promise<Readonly<Record<string, unknown>>> {
  const staleScan = await deps.staleScan(context);
  if (staleScan.stale) context.logger.warn("secure-it: the daily scan looks stale", { detail: staleScan.detail });
  const env = await deps.gate(context);
  const inventories = deps.gradle(context);
  const tree = await deps.trees.commit(context.workingCopy, context.workingCopy.headSha);
  const base = { tree, gradle: await inventories.ofCommit(tree) };
  const found = await deps.candidates(tree, env, { head: base.gradle });
  const report = { staleScan, gaps: found.gaps.length };
  if (found.incomplete.length > 0) return { ...report, outcome: "incomplete", incomplete: found.incomplete };
  const selection = selectWork(found.fixes);
  const waiting = selection.blocked.flatMap((group) => group.reasons);
  if (selection.units.length === 0) return { ...report, outcome: "nothing-to-fix", waiting, blocked: selection.blocked, units: [] };
  const execution = { context, deps, env, inventories, publication: publicationOf(context, deps) };
  const own = await ownOpenPullRequests(context.github, RULES, context.repo.repo, context.base);
  const results: Readonly<Record<string, unknown>>[] = [];
  for (const unit of selection.units) {
    try {
      results.push(await runUnit(execution, unit, base, own));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      context.logger.warn("secure-it: a unit failed", { topic: unit.topic, error: detail });
      results.push({ topic: unit.topic, outcome: "failed", detail });
    }
  }
  return { ...report, ...(results.length === 1 ? results[0]! : { outcome: "completed" }), waiting, blocked: selection.blocked, units: results };
}

async function planUnit(execution: Execution, unit: SecurityUnit, base: PlanBase): Promise<ChangePlan> {
  const actions = new ActionsGitHub(execution.env.fetch, execution.env.githubToken);
  return planFor(unit.work, { lockfiles: await lockfilesOf(base.tree), gradle: base.gradle, tagCommit: (action, tag) => actions.tagCommit(action, tag) }, unit);
}

async function runUnit(execution: Execution, unit: SecurityUnit, base: PlanBase, own: ReadonlyArray<GitHubPullRequest>): Promise<Readonly<Record<string, unknown>>> {
  const { context, deps, publication } = execution;
  const plan = await planUnit(execution, unit, base);
  const owned = await recognisedPlans(context, publication, own, plan);
  const already = owned.find((pr) => {
    const previous = planOf(pr.body);
    return previous !== undefined && planDigest(previous) === planDigest(plan);
  });
  const details = { topic: plan.topic, packages: plan.packages };
  if (already !== undefined) return { ...details, outcome: "already-open", pullRequest: already.url };
  // Version support is checked before any old PR's edits are reverted.
  const input = await agentInput(context, deps, execution.env, plan, "apply");
  const reusable = owned[0];
  const prepared = await preparePlan(context, deps, plan, reusable, own, base.tree.id);
  const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({ entrypoint: "secure-it", input, effort: effortFor(context, plan) });
  if (answer.outcome !== "applied" || answer.publication === undefined) return { ...details, outcome: "cannot-apply", summary: answer.summary };
  const verified = await verifyWithRetry(execution, base, plan, answer.publication);
  const checked = { ...details, packages: verified.plan.packages, named: verified.named, leftOut: verified.leftOut };
  if (verified.problems.length > 0) return { ...checked, outcome: "verification-failed", problems: verified.problems };
  const content = { ...verified.content, body: withPlanSection(verified.content.body, verified.plan) };
  if (reusable !== undefined) {
    const { pr } = await publishUpdate(publication, prepared, reusable.number, content, 0);
    return { ...checked, outcome: "updated", pullRequest: pr.url };
  }
  const created = await publishNew(publication, prepared, content);
  return created === undefined
    ? { ...checked, outcome: "nothing-changed", summary: answer.summary }
    : { ...checked, outcome: "published", pullRequest: created.url };
}

async function preparePlan(context: ToolRunContext, deps: SecureItDeps, plan: ChangePlan, reusable: GitHubPullRequest | undefined, own: ReadonlyArray<GitHubPullRequest>, baseSha: string): Promise<PreparedBranch> {
  if (reusable !== undefined) return reconcileBranch(context, deps, reusable, baseSha);
  const taken = new Set(own.map((pr) => pr.headRef));
  let branch = branchFor(RULES, context.now, plan.topic);
  for (let n = 2; taken.has(branch); n++) branch = branchFor(RULES, context.now, `${plan.topic}-${n}`);
  await clearLeftoverBranch(context.github, RULES, context.repo.repo, branch);
  const fresh = await context.workspace.prepareBranch(context.workingCopy, { branch, start: "default" });
  if (fresh.kind !== "prepared") throw new Error(`${branch} couldn't be prepared`);
  if (fresh.prepared.baseSha !== baseSha) throw new Error("the default branch moved while secure-it ran; the next run starts over");
  return fresh.prepared;
}

interface VerifiedBatch {
  readonly plan: ChangePlan;
  readonly content: Content;
  readonly problems: ReadonlyArray<string>;
  readonly named: ReadonlyArray<ProblemMoves>;
  readonly leftOut: NonNullable<ChangePlan["leftOut"]>;
}

/** Restart once from the same base without named package groups; never shrink malware or guess an unnamed cause. */
async function verifyWithRetry(execution: Execution, base: PlanBase, plan: ChangePlan, content: Content): Promise<VerifiedBatch> {
  const { context, deps, env, inventories } = execution;
  const problems = await verifyEdit(context, deps, plan, env, inventories, base.tree, base.gradle);
  if (problems.length === 0) return { plan, content, problems, named: [], leftOut: plan.leftOut ?? [] };
  const retry = retryWithoutNamed(plan, problems);
  if (retry.plan === undefined) return { plan, content, problems, named: retry.named, leftOut: retry.leftOut };
  context.logger.warn("secure-it: retrying the routine without named package groups", { leftOut: retry.leftOut });
  await deps.revert(context.workingCopy, base.tree.id);
  const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
    entrypoint: "secure-it", input: await agentInput(context, deps, env, retry.plan, "apply"), effort: effortFor(context, retry.plan),
  });
  if (answer.outcome !== "applied" || answer.publication === undefined) {
    return { plan: retry.plan, content, problems: [`retry could not apply: ${answer.summary}`], named: retry.named, leftOut: retry.plan.leftOut ?? [] };
  }
  const remaining = await verifyEdit(context, deps, retry.plan, env, inventories, base.tree, base.gradle);
  return { plan: retry.plan, content: answer.publication, problems: remaining, named: [...retry.named, ...namedProblems(retry.plan, remaining)], leftOut: retry.plan.leftOut ?? [] };
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
    const previous = planOf(pr.body);
    if (previous?.kind !== plan.kind) continue;
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
  const execution = { context, deps, env, inventories, publication };
  const notes: Array<Readonly<Record<string, unknown>>> = [];
  const planFrom = (pr: GitHubPullRequest): ChangePlan => {
    const plan = planOf(pr.body);
    if (plan === undefined) throw new Error(`${pr.url} has no plan secure-it can read`);
    return plan;
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
      const unit = reviewUnit(previous, found.fixes);
      const blocked = selectWork(found.fixes).blocked;
      if (blocked.length > 0) notes.push({ number: pr.number, blocked });
      if (unit === undefined) {
        await closeAndDelete(publication, pr.number, pr.headSha, "No actionable fixes remain for this security unit on the default branch. Blocked fixes are reported by secure-it.");
        return "retired";
      }
      const recomputed = await planUnit(execution, unit, { tree: base, gradle: baseGradle });
      // Plans predating batches retain their package scope and branch topic until retired.
      const plan = previous.kind === undefined ? { ...recomputed, kind: undefined, topic: previous.topic } : recomputed;
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
      const verified = await verifyWithRetry(execution, { tree: base, gradle: baseGradle }, plan, content);
      if (verified.leftOut.length > 0) notes.push({ number: pr.number, leftOut: verified.leftOut, named: verified.named });
      if (verified.problems.length > 0) throw new Error(`after merging the default branch: ${verified.problems.join("; ")}`);
      await publishUpdate(publication, merge.prepared, pr.number, { ...verified.content, body: withPlanSection(verified.content.body, verified.plan) });
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
      const base = await deps.trees.commit(context.workingCopy, prepared.baseSha);
      const verified = await verifyWithRetry(execution, { tree: base, gradle: await inventories.ofCommit(base) }, plan, { title: pr.title, body: pr.body, commitMessage: answer.publication.commitMessage });
      if (verified.leftOut.length > 0) notes.push({ number: pr.number, leftOut: verified.leftOut, named: verified.named });
      if (verified.problems.length > 0) throw new Error(`the adaptation doesn't verify: ${verified.problems.join("; ")}`);
      const { pushed } = await publishUpdate(publication, prepared, pr.number, { ...verified.content, body: withPlanSection(verified.content.body, verified.plan) }, attempt);
      return pushed;
    },
  };
  const reviewed = await reviewOpenPullRequests({ ...publication }, steps);
  return { outcome: "reviewed", reviewed, notes };
}

/** New routine PRs recompute all non-majors; majors and legacy PRs retain their package scope. */
function reviewUnit(previous: ChangePlan, fixes: ReadonlyArray<SecurityFix>): SecurityUnit | undefined {
  if (previous.kind !== "malware" && !previous.malware && fixes.some((fix) => fix.malicious)) {
    throw new Error("malware on the new base must be fixed together before this security unit can verify");
  }
  const ours = new Set(previous.packages);
  const scoped = previous.kind === "routine" || previous.malware ? fixes : fixes.filter((fix) => ours.has(packageKey(fix)));
  const selected = selectWork(scoped);
  if (previous.malware || previous.kind === "malware") return selected.units.find((unit) => unit.kind === "malware");
  if (previous.kind === "routine") return selected.units.find((unit) => unit.kind === "routine");
  if (previous.kind === "major") return selected.units.find((unit) => unit.kind === "major");
  return selected.units[0];
}
