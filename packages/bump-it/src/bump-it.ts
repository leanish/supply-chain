/** One routine PR and each major apart, with independent computation and verified publication. */
import { fileURLToPath } from "node:url";

import type { GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";
import type { BumpCandidate } from "../../ci/src/candidates.ts";
import type { ToolHandlers, ToolRunContext } from "../../remediation/src/command.ts";
import { isMechanical } from "../../remediation/src/edit-checks.ts";
import { branchFor, topicOf, stateOf } from "../../remediation/src/own-pr.ts";
import { closeAndDelete, ownOpenPullRequests, publishNew, publishUpdate } from "../../remediation/src/publication.ts";
import { reviewOpenPullRequests, type ReviewSteps } from "../../remediation/src/review.ts";

import { type BumpItDeps, defaultDeps } from "./deps.ts";
import { type Computed, compute, edit, type Execution, prepare, RULES, verify, writeNpm } from "./operations.ts";
import { type BumpPlan, planDigest, planOf, withPlanSection } from "./plan.ts";
import { majorUnits, routineUnit, type Unit } from "./units.ts";
import { plannedFiles } from "./verify.ts";

export { type BumpItDeps, defaultDeps } from "./deps.ts";
export { RULES } from "./operations.ts";

const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

export function bumpIt(deps: BumpItDeps = defaultDeps()): ToolHandlers {
  return {
    tool: "bump-it",
    skills: { dirs: [SKILLS_DIR], entrypoints: ["bump-it"], support: [] },
    run: (context) => run(context, deps),
    review: (context) => review(context, deps),
  };
}

async function createExecution(context: ToolRunContext, deps: BumpItDeps): Promise<Execution> {
  return {
    context,
    deps,
    env: await deps.gate(context),
    inventories: deps.gradle(context),
    publication: {
      rules: RULES,
      github: context.github,
      workspace: context.workspace,
      logger: context.logger,
      repo: context.repo.repo,
      base: context.base,
      workingCopy: context.workingCopy,
      journal: deps.journal(context),
    },
  };
}

interface UnitReport {
  readonly topic: string;
  readonly outcome: "published" | "updated" | "already-open" | "nothing-to-move" | "deferred" | "failed";
  readonly pullRequest?: string;
  readonly detail?: string;
  readonly notes?: ReadonlyArray<string>;
}

async function run(context: ToolRunContext, deps: BumpItDeps): Promise<Readonly<Record<string, unknown>>> {
  const execution = await createExecution(context, deps);
  const base = await deps.trees.commit(context.workingCopy, context.workingCopy.headSha);
  const gradle = await execution.inventories.ofCommit(base);
  const found = await deps.candidates(base, execution.env, { head: gradle });
  if (found.incomplete.length > 0) {
    return { outcome: "incomplete", incomplete: found.incomplete };
  }
  const own = await ownOpenPullRequests(context.github, RULES, context.repo.repo, context.base);
  const priority = deps.priority(context);
  const deferredBefore = await priority.read();
  const order = (unit: Unit) => (unit.package === undefined ? -1 : deferredBefore.indexOf(unit.package));
  const majors = majorUnits(found.bumps).sort((a, b) => (order(a) === -1 ? Infinity : order(a)) - (order(b) === -1 ? Infinity : order(b)));
  const units = [routineUnit(found.bumps), ...majors];
  const results: UnitReport[] = [];
  const deferred: string[] = [];
  let openedMajors = 0;
  for (const unit of units) {
    try {
      const owned = await recognised(execution, unit, own);
      if (unit.kind === "major" && owned.length === 0 && openedMajors >= (context.config.maxNewMajorsPerRun ?? 3)) {
        results.push({ topic: unit.topic, outcome: "deferred" });
        deferred.push(unit.package!);
        continue;
      }
      const computed = await compute(execution, unit, base, gradle);
      const result = await runUnit(execution, computed, unit, own, owned);
      if (unit.kind === "major" && result.outcome === "published") {
        openedMajors++;
      }
      results.push(result);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      context.logger.warn("bump-it: a unit failed", { topic: unit.topic, error: detail });
      results.push({ topic: unit.topic, outcome: "failed", detail });
    }
  }
  await priority.write(deferred);
  return {
    outcome: "completed",
    units: results,
    gaps: found.gaps,
    waiting: found.bumps.flatMap((bump) => bump.problems.map((problem) => `${bump.name}@${bump.from}: ${problem}`)),
  };
}

async function recognised(execution: Execution, unit: Unit, own: ReadonlyArray<GitHubPullRequest>): Promise<GitHubPullRequest[]> {
  const matches: GitHubPullRequest[] = [];
  for (const pr of own) {
    const plan = planOf(pr.body);
    if (plan === undefined || plan.kind !== unit.kind || plan.package !== unit.package || plan.topic !== unit.topic) {
      continue;
    }
    const topic = topicOf(RULES, pr.headRef);
    // The block and branch must name this unit. A suffix is the tool's PR beside one a human took over.
    const branchTopic = topicOf(RULES, branchFor(RULES, execution.context.now, unit.topic))!;
    const suffix = /^(.*)-(\d+)$/.exec(topic ?? "");
    const suffixed = suffix !== null && Number(suffix[2]) >= 2 && suffix[1] === branchTopic.slice(0, 60 - suffix[2]!.length - 1);
    if (topic !== branchTopic && !suffixed) {
      continue;
    }
    if (stateOf(pr.body)?.head === pr.headSha || (await execution.publication.journal.last(execution.context.repo.repo, pr.number))?.head === pr.headSha) {
      matches.push(pr);
    }
  }
  return matches;
}

const empty = (computed: Computed) => computed.plan.moves.length === 0 && computed.files.size === 0;

async function runUnit(execution: Execution, computed: Computed, unit: Unit, own: ReadonlyArray<GitHubPullRequest>, owned: ReadonlyArray<GitHubPullRequest>): Promise<UnitReport> {
  if (empty(computed)) {
    return { topic: unit.topic, outcome: "nothing-to-move", notes: computed.plan.notes };
  }
  const same = owned.find((pr) => planDigest(planOf(pr.body)!) === planDigest(computed.plan));
  if (same !== undefined) {
    return { topic: unit.topic, outcome: "already-open", pullRequest: same.url, notes: computed.plan.notes };
  }
  const reusable = owned[0];
  const prepared = await prepare(execution, unit, own, reusable, computed.base.id);
  const content = await edit(execution, computed, "apply");
  await verify(execution, computed);
  if (reusable !== undefined) {
    const { pr } = await publishUpdate(execution.publication, prepared, reusable.number, content, 0);
    return { topic: unit.topic, outcome: "updated", pullRequest: pr.url, notes: computed.plan.notes };
  }
  const pr = await publishNew(execution.publication, prepared, content);
  return {
    topic: unit.topic,
    outcome: pr === undefined ? "nothing-to-move" : "published",
    ...(pr === undefined ? {} : { pullRequest: pr.url }),
    notes: computed.plan.notes,
  };
}

function planFrom(pr: GitHubPullRequest): BumpPlan {
  const plan = planOf(pr.body);
  if (plan === undefined) {
    throw new Error(`${pr.url} has no valid bump-it plan`);
  }
  return plan;
}

function unitFor(previous: BumpPlan, bumps: ReadonlyArray<BumpCandidate>): Unit | undefined {
  return previous.kind === "routine" ? routineUnit(bumps) : majorUnits(bumps).find((unit) => unit.package === previous.package);
}

function sameTargets(previous: BumpPlan, next: BumpPlan): boolean {
  return JSON.stringify(targetKeys(previous)) === JSON.stringify(targetKeys(next));
}

function targetKeys(plan: BumpPlan): string[] {
  const keys = plan.moves.map((move) => {
    const locations = [...move.locations].sort().join(",");
    const declarations = move.declarations
      .map((declaration) => `${declaration.lockfile}:${declaration.workspace}:${declaration.declaredAs}`)
      .sort()
      .join(",");
    return `${move.ecosystem}|${move.name}|${move.to}|${locations}|${declarations}`;
  });
  return [...new Set(keys)].sort();
}

async function review(context: ToolRunContext, deps: BumpItDeps): Promise<Readonly<Record<string, unknown>>> {
  const execution = await createExecution(context, deps);
  const steps: ReviewSteps = {
    async rebase(pr, merge) {
      const previous = planFrom(pr);
      const base = await deps.trees.commit(context.workingCopy, merge.prepared.baseSha);
      const gradle = await execution.inventories.ofCommit(base);
      const found = await deps.candidates(base, execution.env, { head: gradle });
      if (found.incomplete.length > 0) {
        throw new Error(`the new base's inventory is incomplete: ${found.incomplete.join("; ")}`);
      }
      const unit = unitFor(previous, found.bumps);
      const computed = unit === undefined ? undefined : await compute(execution, unit, base, gradle);
      if (computed === undefined || empty(computed)) {
        await closeAndDelete(execution.publication, pr.number, pr.headSha, "Recomputed on the default branch: this unit has nothing left to move.");
        return "retired";
      }
      // A major's adaptation survives a clean merge while its selected targets stay the same.
      const reconcile = previous.kind === "routine" ? planDigest(previous) !== planDigest(computed.plan) : !sameTargets(previous, computed.plan);
      let content = { title: pr.title, body: withPlanSection(pr.body, computed.plan), commitMessage: `merging ${context.base}` };
      if (reconcile) {
        await deps.revert(context.workingCopy, base.id);
        content = await edit(execution, computed, "apply");
      } else if (merge.kind === "conflicted") {
        const code: string[] = [];
        const pins = new Set(computed.plan.moves.filter((move) => move.mechanism === "action-pin").flatMap((move) => move.locations));
        for (const path of merge.conflicted) {
          if (!isMechanical(path) && !pins.has(path)) {
            code.push(path);
            continue;
          }
          const theirs = await base.read(path);
          if (theirs === undefined) {
            await deps.removeFile(context.workingCopy, path);
          } else {
            await deps.writeFile(context.workingCopy, path, theirs);
          }
        }
        if (code.length > 0 && previous.kind === "routine") {
          throw new Error("a routine PR may not resolve code conflicts");
        }
        content = await edit(execution, computed, code.length > 0 ? "resolve" : "apply", code.length > 0 ? { conflicted: code } : {});
      } else {
        await writeNpm(execution, computed.files, previous.kind === "major");
      }
      await verify(execution, computed);
      await publishUpdate(execution.publication, merge.prepared, pr.number, content);
      return "rebased";
    },
    async adapt(pr, prepared, _publication, attempt) {
      const plan = planFrom(pr);
      if (plan.kind === "routine") {
        context.logger.warn("bump-it: routine CI failure cannot be adapted", { number: pr.number, detail: "the exact change cannot legitimately be edited" });
        return false;
      }
      const base = await deps.trees.commit(context.workingCopy, prepared.baseSha);
      const files = await plannedFiles(plan, deps.trees.working(context.workingCopy));
      const computed = { plan, files, base, gradle: await execution.inventories.ofCommit(base) };
      const checks = await context.github.headChecks({ repo: context.repo.repo, sha: pr.headSha });
      const failingChecks = checks.checkRuns
        .filter((check) => check.status === "completed" && check.conclusion !== null && !["success", "neutral", "skipped"].includes(check.conclusion))
        .map((check) => check.name);
      const content = await edit(execution, computed, "adapt", { failingChecks });
      await verify(execution, computed);
      const { pushed } = await publishUpdate(execution.publication, prepared, pr.number, { title: pr.title, body: withPlanSection(pr.body, plan), commitMessage: content.commitMessage }, attempt);
      return pushed;
    },
  };
  return { outcome: "reviewed", reviewed: await reviewOpenPullRequests(execution.publication, steps) };
}
