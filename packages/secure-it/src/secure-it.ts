/**
 * secure-it: fixes what the supply-chain gate's full scan fails on, one
 * package per run (every malicious package together), with the version the
 * gate's rule picks, and opens a PR for it. The code decides and verifies;
 * the agent edits (design items 12, 19–24).
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";
import type { PreparedBranch, WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { ActionsGitHub } from "../../ci/src/actions-github.ts";
import { type SecurityCandidates, securityCandidates } from "../../ci/src/candidates.ts";
import type { GateEnvironment, GradleInputs } from "../../ci/src/gate.ts";
import { namingFailures } from "../../ci/src/http.ts";
import { runProcess } from "../../ci/src/process.ts";
import { gitTree, type Tree, workingTree } from "../../ci/src/tree.ts";
import type { ToolHandlers, ToolRunContext } from "../../remediation/src/command.ts";
import { changedSince, sameTreeAs } from "../../remediation/src/git-copies.ts";
import { FileJournal, type PublicationJournal } from "../../remediation/src/journal.ts";
import { ensureOsvScanner } from "../../remediation/src/osv-scanner.ts";
import { branchFor, ownPullRequests, stateOf, topicOf } from "../../remediation/src/own-pr.ts";
import { clearLeftoverBranch, closeAndDelete, ownOpenPullRequests, type PublicationContext, publishNew, publishUpdate } from "../../remediation/src/publication.ts";
import { type BaseMerge, reviewOpenPullRequests, type ReviewSteps } from "../../remediation/src/review.ts";

import { type GradleInventories, lockfilesOf, sandboxedGradleInventories } from "./inventory.ts";
import { planDigest, planOf, planSection } from "./plan-block.ts";
import { type ChangePlan, planFor, selectWork } from "./plan.ts";
import { staleScanStatus, type StaleScan } from "./stale-scan.ts";
import { verifyPlan, type VerifyInputs } from "./verify.ts";

export const RULES = ownPullRequests("secure-it");
const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));
const FLOORS_FILE = ".github/dependency-floors.json";

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
  readonly sameTreeAs: (workingCopy: WorkingCopy, sha: string) => Promise<boolean>;
  readonly journal: (context: ToolRunContext) => PublicationJournal;
  /** Writes `content` at `path` (relative to the working copy): taking the base's side of a conflicted dependency file. */
  readonly writeFile: (workingCopy: WorkingCopy, path: string, content: string) => Promise<void>;
}

export function defaultDeps(): SecureItDeps {
  return {
    gate: async (context) => ({
      run: runProcess,
      fetch: namingFailures((url, init) => fetch(url, init)),
      now: () => new Date(),
      osvScanner: await ensureOsvScanner(context.config.dirs.cache),
      githubToken: context.readToken,
    }),
    gradle: (context) => sandboxedGradleInventories(context.isolation, context.workingCopy),
    trees: { commit: (workingCopy, sha) => gitTree(workingCopy.path, sha, runProcess), working: (workingCopy) => workingTree(workingCopy.path) },
    candidates: securityCandidates,
    verify: verifyPlan,
    staleScan: (context) => staleScanStatus(context.repo.repo, context.base, context.readToken, context.now, context.config.staleScanHours ?? 36),
    changedSince: (workingCopy, sha) => changedSince(workingCopy, sha),
    sameTreeAs: (workingCopy, sha) => sameTreeAs(workingCopy, sha),
    journal: (context) => new FileJournal(context.config.dirs.state),
    writeFile: (workingCopy, path, content) => writeFile(join(workingCopy.path, path), content),
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

function skillInput(context: ToolRunContext, plan: ChangePlan, mode: "apply" | "adapt" | "resolve", extra: { failingChecks?: string[]; conflicted?: ReadonlyArray<string> } = {}) {
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
    })),
    floorsFile: FLOORS_FILE,
    ...(extra.failingChecks === undefined ? {} : { failingChecks: extra.failingChecks }),
    ...(extra.conflicted === undefined ? {} : { conflicted: [...extra.conflicted] }),
  };
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
  const waiting = found.fixes
    .filter((fix) => fix.to === undefined || fix.to.blockers.length > 0)
    .map((fix) => `${fix.name}@${fix.from}: ${fix.problem ?? fix.to?.blockers.join("; ") ?? ""}`);
  const work = selectWork(found.fixes);
  if (work.length === 0) return { ...report, outcome: "nothing-to-fix", waiting };

  const github = new ActionsGitHub(env.fetch, env.githubToken);
  const plan = await planFor(work, { lockfiles: await lockfilesOf(base), gradle: baseGradle, tagCommit: (action, tag) => github.tagCommit(action, tag) });
  const publication = publicationOf(context, deps);
  const own = await ownOpenPullRequests(context.github, RULES, context.repo.repo, context.base);
  const topicBranch = branchFor(RULES, context.now, plan.topic);
  const topic = topicOf(RULES, topicBranch);
  const sameTopic = own.filter((pr) => topicOf(RULES, pr.headRef) === topic);
  const digest = planDigest(plan);
  const already = sameTopic.find((pr) => {
    const existing = planOf(pr.body);
    return existing !== undefined && planDigest(existing) === digest;
  });
  if (already !== undefined) return { ...report, outcome: "already-open", pullRequest: already.url, waiting };

  // An open PR for the package is updated with the new plan, unless someone else pushed to it.
  let reusable: GitHubPullRequest | undefined;
  for (const pr of sameTopic) {
    const recorded = stateOf(pr.body);
    const journaled = await publication.journal.last(context.repo.repo, pr.number);
    if (recorded?.head === pr.headSha || journaled?.head === pr.headSha) reusable = pr;
  }
  let prepared: PreparedBranch;
  if (reusable !== undefined) {
    const checkedOut = await context.workspace.prepareBranch(context.workingCopy, { branch: reusable.headRef, start: "remote" });
    if (checkedOut.kind !== "prepared" || checkedOut.prepared.remoteHeadSha !== reusable.headSha) throw new Error(`${reusable.url} moved while secure-it prepared it`);
    prepared = checkedOut.prepared;
  } else {
    const taken = new Set(own.map((pr) => pr.headRef));
    let branch = topicBranch;
    for (let n = 2; taken.has(branch); n++) branch = branchFor(RULES, context.now, `${plan.topic}-${n}`);
    await clearLeftoverBranch(context.github, RULES, context.repo.repo, branch);
    const fresh = await context.workspace.prepareBranch(context.workingCopy, { branch, start: "default" });
    if (fresh.kind !== "prepared") throw new Error(`${branch} couldn't be prepared`);
    prepared = fresh.prepared;
  }

  const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({ entrypoint: "secure-it", input: skillInput(context, plan, "apply"), effort: effortFor(context, plan) });
  if (answer.outcome !== "applied" || answer.publication === undefined) return { ...report, outcome: "cannot-apply", summary: answer.summary, plan: digest };

  const problems = await verifyEdit(context, deps, plan, env, inventories, base, baseGradle);
  if (problems.length > 0) return { ...report, outcome: "verification-failed", problems };

  const content = { title: answer.publication.title, body: `${answer.publication.body}\n\n${planSection(plan)}`, commitMessage: answer.publication.commitMessage };
  if (reusable !== undefined) {
    const { pr } = await publishUpdate(publication, prepared, reusable.number, content, 0);
    return { ...report, outcome: "updated", pullRequest: pr.url, waiting };
  }
  const created = await publishNew(publication, prepared, content);
  if (created === undefined) return { ...report, outcome: "nothing-changed", summary: answer.summary };
  return { ...report, outcome: "published", pullRequest: created.url, waiting };
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
      const plan = planFrom(pr);
      const baseSha = merge.prepared.baseSha;
      if (merge.kind === "conflicted") {
        const base = await deps.trees.commit(context.workingCopy, baseSha);
        const code: string[] = [];
        for (const path of merge.conflicted) {
          const theirs = isMechanical(path) ? await base.read(path) : undefined;
          if (theirs === undefined) code.push(path);
          else await deps.writeFile(context.workingCopy, path, theirs);
        }
        // The dependency files now have the base's side; the agent re-applies the moves (and resolves any code).
        const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
          entrypoint: "secure-it",
          input: skillInput(context, plan, code.length > 0 ? "resolve" : "apply", code.length > 0 ? { conflicted: code } : {}),
          effort: effortFor(context, plan),
        });
        if (answer.outcome !== "applied") throw new Error(`the agent couldn't re-apply the plan on the new base: ${answer.summary}`);
      }
      if (await deps.sameTreeAs(context.workingCopy, baseSha)) {
        await closeAndDelete(publication, pr.number, pr.headSha, "The default branch has these versions now, so this PR has nothing left to change.");
        return "retired";
      }
      const problems = await verifyAgainst(plan, baseSha);
      if (problems.length > 0) throw new Error(`after merging the default branch: ${problems.join("; ")}`);
      await publishUpdate(publication, merge.prepared, pr.number, { title: pr.title, body: pr.body, commitMessage: `merging ${context.base}` });
      return "rebased";
    },
    async adapt(pr, prepared, _context, attempt) {
      const plan = planFrom(pr);
      const checks = await context.github.headChecks({ repo: context.repo.repo, sha: pr.headSha });
      const failingChecks = checks.checkRuns.filter((check) => check.status === "completed" && check.conclusion !== null && !["success", "neutral", "skipped"].includes(check.conclusion)).map((check) => check.name);
      const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
        entrypoint: "secure-it",
        input: skillInput(context, plan, "adapt", { failingChecks }),
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

/** Dependency files whose conflicts take the base's side, the moves then re-applied on top. */
function isMechanical(path: string): boolean {
  const name = path.split("/").at(-1) ?? path;
  return ["package-lock.json", "npm-shrinkwrap.json", "package.json", "gradle.lockfile"].includes(name) || path === FLOORS_FILE || path.endsWith("gradle/libs.versions.toml");
}
