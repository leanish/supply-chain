/** Security fixes and a separate proved floor-removal unit; malware first, every publication verified. */
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import type { GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";
import type { PreparedBranch, WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { ActionsGitHub } from "../../ci/src/actions-github.ts";
import type { Floor } from "../../ci/src/floors.ts";
import { type SecurityCandidates, type SecurityFix, securityCandidates } from "../../ci/src/candidates.ts";
import { type CooldownEvaluation, heldUntil } from "../../ci/src/cooldown.ts";
import type { NpmPeerPlanner } from "../../ci/src/npm-peers.ts";
import type { GateEnvironment, GradleInputs } from "../../ci/src/gate.ts";
import type { GradleInventory } from "../../ci/src/gradle.ts";
import { namingFailures } from "../../ci/src/http.ts";
import { NpmRegistry, releaseSignals } from "../../ci/src/npm-registry.ts";
import type { HeldVersion } from "../../ci/src/release-age.ts";
import { runProcess } from "../../ci/src/process.ts";
import { gitTree, type Tree, workingTree } from "../../ci/src/tree.ts";
import { failingCheckNames } from "../../remediation/src/ci-state.ts";
import type { ToolHandlers, ToolRunContext } from "../../remediation/src/command.ts";
import { FLOORS_FILE, isMechanical } from "../../remediation/src/edit-checks.ts";
import { writeLocalFile } from "../../remediation/src/local-files.ts";
import { gradleSourceIndex } from "../../ci/src/gradle-sources.ts";
import { changedSince } from "../../remediation/src/git-copies.ts";
import { referenceTransform } from "../../remediation/src/gradle-reference.ts";
import { type GradleInventories, lockfilesOf, sandboxedGradleInventories } from "../../remediation/src/inventories.ts";
import { FileJournal, type PublicationJournal } from "../../remediation/src/journal.ts";
import { formatManifest } from "../../remediation/src/manifest-format.ts";
import { NPM_DEPENDENCY_FIELDS } from "../../remediation/src/npm-file-checks.ts";
import { requireNpmExcludes } from "../../remediation/src/npm-version.ts";
import { runSandboxed } from "../../remediation/src/sandboxed.ts";
import { ensureOsvScanner, verifyingRun } from "../../remediation/src/osv-scanner.ts";
import { branchFor, ownPullRequests, stateOf, topicOf } from "../../remediation/src/own-pr.ts";
import { revertToBase } from "../../remediation/src/reconcile.ts";
import { clearLeftoverBranch, closeAndDelete, ownOpenPullRequests, type PublicationContext, publishNew, publishUpdate, recoverPublication } from "../../remediation/src/publication.ts";
import { type BaseMerge, type CooldownState, reviewOpenPullRequests, type ReviewSteps } from "../../remediation/src/review.ts";

import { removalTransform } from "./floor-gradle.ts";
import { probeOnBase } from "./floor-probe.ts";
import { type ComputedRemoval, type RemovalProbe, floorsOf, selectRemovals } from "./floor-removal.ts";
import { reconcileNpmFloors } from "./npm-floor-history.ts";
import { materializeOnBase } from "./npm-materialize.ts";
import { requiredNpmPlan } from "./npm-required-plan.ts";
import { npmWindowFor } from "./npm-window.ts";
import { planDigest, planOf, planSection, withPlanSection } from "./plan-block.ts";
import { type ChangePlan, coupledWork, HELD_TOPIC, packageKey, planFor, type PlannedHold, type SecurityUnit } from "./plan.ts";
import { namedProblems, retryWithoutNamed, type ProblemMoves } from "./retry.ts";
import { staleScanStatus, type StaleScan } from "./stale-scan.ts";
import { referencePlan, verifyPlan, type VerifyInputs } from "./verify.ts";

export const RULES = ownPullRequests("secure-it");
const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

/** What the agent answers (the skill's output schema). */
interface SkillAnswer {
  readonly outcome: "applied" | "cannot-apply";
  readonly summary: string;
  readonly publication?: { readonly title: string; readonly body: string; readonly commitMessage: string } | null;
}

/** What secure-it reaches outside its own logic; tests replace them. */
export interface SecureItDeps {
  readonly requiredNpm: typeof requiredNpmPlan;
  readonly materializeNpm: typeof materializeOnBase;
  readonly floorProbe: (context: ToolRunContext, base: Tree, floors: ReadonlyArray<Floor>, env: GateEnvironment) => Promise<RemovalProbe>;
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
    requiredNpm: requiredNpmPlan,
    materializeNpm: materializeOnBase,
    floorProbe: probeOnBase,
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
    writeFile: (workingCopy, path, content) => writeLocalFile(workingCopy.path, path, content),
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
    ...(plan.floorRemoval === undefined ? {} : {
      floorRemovals: plan.floorRemoval.floors.filter((floor) => floor.ecosystem === "Maven").map((floor) => ({
        ecosystem: floor.ecosystem, package: floor.package, version: floor.version, declaredIn: floor.declaredIn, locations: floor.locations, advisories: floor.advisories,
      })),
      toolWritten: plan.floorRemoval.files.map((file) => file.path),
    }),
    floorsFile: FLOORS_FILE,
    npmAgeExclusions: [...npmAgeExclusions],
    ...(extra.failingChecks === undefined ? {} : { failingChecks: extra.failingChecks }),
    ...(extra.conflicted === undefined ? {} : { conflicted: [...extra.conflicted] }),
  };
}

/** Every agent mode receives the same explicit npm window, after checking the sandbox's npm. */
async function agentInput(
  execution: Execution,
  plan: ChangePlan,
  base: Tree,
  mode: "apply" | "adapt" | "resolve",
  extra: { failingChecks?: string[]; conflicted?: ReadonlyArray<string> } = {},
) {
  const window = await prepareNpmFiles(execution, plan, base);
  return { ...skillInput(execution.context, plan, window.exclude, mode, extra), toolWritten: [...execution.npmFiles.keys()].filter((path) => path !== FLOORS_FILE || !plan.moves.some((move) => move.mechanism === "gradle-floor")) };
}

/** Write the recomputed npm files before either agent work or a clean, model-free rebase verification. */
async function prepareNpmFiles(execution: Execution, plan: ChangePlan, base: Tree, reconcileFloors = false) {
  const { context, deps, env } = execution;
  const window = await npmWindowFor(plan, context.releaseAgeDays, context.releaseAgeExclude, context.now, env.fetch, await lockfilesOf(base));
  for (const detail of window.notes) context.logger.warn("secure-it: npm release-age exclusion", { detail });
  if (plan.moves.some((move) => move.ecosystem === "npm")) {
    await requireNpmExcludes((_dir, args) => deps.npm(context, args), context.workingCopy.path, window.exclude, "young security targets or proved requirements, unreadable or young locked base versions, or own-package exclusions");
  }
  let files = await deps.materializeNpm(context, base, plan, window.exclude);
  if (reconcileFloors) files = reconcileNpmFloors(files, await deps.trees.working(context.workingCopy).read(FLOORS_FILE));
  execution.npmFiles.clear();
  for (const [path, text] of files) {
    execution.npmFiles.set(path, text);
    let output = text;
    if (path.endsWith("package.json") && plan.moves.some((move) => move.major)) {
      const current = await deps.trees.working(context.workingCopy).read(path);
      if (current !== undefined) {
        const manifest = JSON.parse(current) as Record<string, unknown>;
        const original = structuredClone(manifest);
        const planned = JSON.parse(text) as Record<string, unknown>;
        for (const field of NPM_DEPENDENCY_FIELDS) {
          if (planned[field] === undefined) delete manifest[field];
          else manifest[field] = planned[field];
        }
        output = isDeepStrictEqual(original, manifest) ? current : formatManifest(current, manifest);
      }
    }
    await deps.writeFile(context.workingCopy, path, output);
  }
  return window;
}

const effortFor = (context: ToolRunContext, plan: ChangePlan) => (plan.moves.some((move) => move.major) ? context.config.agent.majorEffort : context.config.agent.effort);

interface Execution {
  readonly context: ToolRunContext;
  readonly deps: SecureItDeps;
  readonly env: GateEnvironment;
  readonly inventories: GradleInventories;
  readonly publication: PublicationContext;
  readonly npmFiles: Map<string, string>;
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
  const selection = await coupledWork(found.fixes, found.npmPeers);
  const waiting = selection.blocked.flatMap((group) => group.reasons);

  const execution = { context, deps, env, inventories, publication: publicationOf(context, deps), npmFiles: new Map<string, string>() };
  const own = await ownOpenPullRequests(context.github, RULES, context.repo.repo, context.base);
  const results: Readonly<Record<string, unknown>>[] = [];
  for (const unit of await holdRequiredYoung(execution, selection.units, base)) {
    try {
      results.push(await runUnit(execution, unit, base, own));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      context.logger.warn("secure-it: a unit failed", { topic: unit.topic, error: detail });
      results.push({ topic: unit.topic, outcome: "failed", detail });
    }
  }
  if (!found.fixes.some((fix) => fix.malicious) && (await floorsOf(tree)).some((floor) => floor.purpose === "security")) {
    try {
      const removal = await computeRemoval(execution, base);
      results.push(removal.plan === undefined
        ? { topic: "floor-removal", outcome: "nothing-to-remove", notes: removal.notes }
        : await runRemoval(execution, removal, base, own));
    } catch (err) {
      results.push({ topic: "floor-removal", outcome: "failed", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  if (results.length === 0) return { ...report, outcome: "nothing-to-fix", waiting, blocked: selection.blocked, units: [] };
  return { ...report, ...(results.length === 1 ? results[0]! : { outcome: "completed" }), waiting, blocked: selection.blocked, units: results };
}

async function computeRemoval(execution: Execution, base: PlanBase): Promise<ComputedRemoval> {
  return selectRemovals(await floorsOf(base.tree), (floors) => execution.deps.floorProbe(execution.context, base.tree, floors, execution.env),
    (text) => createHash("sha256").update(text).digest("hex"));
}

async function applyRemoval(execution: Execution, removal: ComputedRemoval): Promise<Content> {
  const plan = removal.plan!;
  for (const [path, content] of removal.files) await execution.deps.writeFile(execution.context.workingCopy, path, content);
  const content = { title: "removing redundant security floors", body: planSection(plan), commitMessage: "removing redundant security floors" };
  if (!plan.floorRemoval!.floors.some((floor) => floor.ecosystem === "Maven")) return content;
  const answer = await execution.context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
    entrypoint: "secure-it", input: skillInput(execution.context, plan, [], "apply"), effort: execution.context.config.agent.effort,
  });
  if (answer.outcome !== "applied") throw new Error(`the agent couldn't remove the planned Gradle declarations: ${answer.summary}`);
  return content;
}

async function runRemoval(execution: Execution, removal: ComputedRemoval, base: PlanBase, own: ReadonlyArray<GitHubPullRequest>): Promise<Readonly<Record<string, unknown>>> {
  const plan = removal.plan!;
  const owned = await recognisedPlans(execution.context, execution.publication, own, plan);
  const already = owned.find((pr) => stateOf(pr.body)?.head === pr.headSha && planDigest(planOf(pr.body)!) === planDigest(plan));
  const report = { topic: plan.topic, packages: plan.packages, notes: removal.notes };
  if (already !== undefined) return { ...report, outcome: "already-open", pullRequest: already.url };
  const reusable = owned[0];
  const prepared = await preparePlan(execution.context, execution.deps, plan, reusable, own, base.tree.id);
  const content = await applyRemoval(execution, removal);
  const problems = await verifyEdit(execution.context, execution.deps, plan, execution.env, execution.inventories, base.tree, base.gradle);
  if (problems.length > 0) return { ...report, outcome: "verification-failed", problems };
  if (reusable !== undefined) {
    const { pr } = await publishUpdate(execution.publication, prepared, reusable.number, content, 0);
    return { ...report, outcome: "updated", pullRequest: pr.url };
  }
  const pr = await publishNew(execution.publication, prepared, content);
  return { ...report, outcome: pr === undefined ? "nothing-changed" : "published", ...(pr === undefined ? {} : { pullRequest: pr.url }) };
}

/**
 * A routine fix whose required npm dependency is younger than the wait can't
 * wait either: it moves to the held unit with every package coupled to it.
 * Moving roots only drops requirements, so one pass leaves the rest aged.
 */
async function holdRequiredYoung(execution: Execution, units: ReadonlyArray<SecurityUnit>, base: PlanBase): Promise<SecurityUnit[]> {
  const aged = units.find((unit) => unit.kind === "routine" && unit.held !== true);
  if (aged === undefined) return [...units];
  let plan: ChangePlan;
  try {
    plan = await planUnit(execution, aged, base);
  } catch {
    // Its own run reports why it can't be planned.
    return [...units];
  }
  const moved = new Set((plan.requiredNpm ?? []).filter((target) => target.exempt).map((target) => `npm|${target.root.name}`));
  if (moved.size === 0) return [...units];
  for (;;) {
    const size = moved.size;
    for (const set of aged.coupled ?? []) if (set.some((key) => moved.has(key))) for (const key of set) moved.add(key);
    if (moved.size === size) break;
  }
  const held = units.find((unit) => unit.kind === "routine" && unit.held === true);
  const stays = aged.work.filter((fix) => !moved.has(packageKey(fix)));
  const joined: SecurityUnit = {
    kind: "routine",
    topic: HELD_TOPIC,
    held: true,
    work: [...(held?.work ?? []), ...aged.work.filter((fix) => moved.has(packageKey(fix)))],
    coupled: [...(held?.coupled ?? []), ...(aged.coupled ?? []).filter((set) => set.some((key) => moved.has(key)))],
  };
  const rest = stays.length === 0 ? [] : [{ ...aged, work: stays, coupled: (aged.coupled ?? []).filter((set) => !set.some((key) => moved.has(key))) }];
  return [...units.filter((unit) => unit !== aged && unit !== held), ...rest, joined];
}

async function planUnit(execution: Execution, unit: SecurityUnit, base: PlanBase): Promise<ChangePlan> {
  const actions = new ActionsGitHub(execution.env.fetch, execution.env.githubToken);
  const sources = base.gradle === undefined ? undefined : await gradleSourceIndex(base.tree);
  const plan = await planFor(unit.work, { lockfiles: await lockfilesOf(base.tree), gradle: base.gradle, named: sources?.named, tagCommit: (action, tag) => actions.tagCommit(action, tag) }, unit);
  return execution.deps.requiredNpm(base.tree, plan, execution.env);
}

async function runUnit(execution: Execution, unit: SecurityUnit, base: PlanBase, own: ReadonlyArray<GitHubPullRequest>): Promise<Readonly<Record<string, unknown>>> {
  const { context, deps, publication } = execution;
  const plan = await planUnit(execution, unit, base);
  const owned = await recognisedPlans(context, publication, own, plan);
  const already = owned.find((pr) => {
    const previous = planOf(pr.body);
    return stateOf(pr.body)?.head === pr.headSha && previous !== undefined && planDigest(previous) === planDigest(plan);
  });
  const details = { topic: plan.topic, packages: plan.packages, notes: plan.notes ?? [] };
  if (already !== undefined) return { ...details, outcome: "already-open", pullRequest: already.url };
  const reusable = owned[0];
  const prepared = await preparePlan(context, deps, plan, reusable, own, base.tree.id);
  const input = await agentInput(execution, plan, base.tree, "apply");
  const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({ entrypoint: "secure-it", input, effort: effortFor(context, plan) });
  if (answer.outcome !== "applied" || answer.publication == null) return { ...details, outcome: "cannot-apply", summary: answer.summary };
  const verified = await verifyWithRetry(execution, base, plan, answer.publication);
  const checked = { ...details, notes: verified.plan.notes ?? [], packages: verified.plan.packages, named: verified.named, leftOut: verified.leftOut };
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
  if (execution.npmFiles.size === 0 && plan.moves.some((move) => move.ecosystem === "npm")) {
    const window = await npmWindowFor(plan, context.releaseAgeDays, context.releaseAgeExclude, context.now, env.fetch, await lockfilesOf(base.tree));
    for (const [path, text] of await deps.materializeNpm(context, base.tree, plan, window.exclude)) execution.npmFiles.set(path, text);
  }
  let cooldown: CooldownEvaluation | undefined;
  const heard = (evaluation: CooldownEvaluation) => {
    cooldown = evaluation;
  };
  const problems = await verifyEdit(context, deps, plan, env, inventories, base.tree, base.gradle, execution.npmFiles, heard);
  if (problems.length === 0) return withCooldown(env, { plan, content, problems, named: [], leftOut: plan.leftOut ?? [] }, cooldown);
  const retry = retryWithoutNamed(plan, problems);
  if (retry.plan === undefined) return { plan, content, problems, named: retry.named, leftOut: retry.leftOut };
  context.logger.warn("secure-it: retrying the routine without named package groups", { leftOut: retry.leftOut });
  await deps.revert(context.workingCopy, base.tree.id);
  const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
    entrypoint: "secure-it", input: await agentInput(execution, retry.plan, base.tree, "apply"), effort: effortFor(context, retry.plan),
  });
  if (answer.outcome !== "applied" || answer.publication == null) {
    return { plan: retry.plan, content, problems: [`retry could not apply: ${answer.summary}`], named: retry.named, leftOut: retry.plan.leftOut ?? [] };
  }
  cooldown = undefined;
  const remaining = await verifyEdit(context, deps, retry.plan, env, inventories, base.tree, base.gradle, execution.npmFiles, heard);
  const batch = { plan: retry.plan, content: answer.publication, problems: remaining, named: [...retry.named, ...namedProblems(retry.plan, remaining)], leftOut: retry.plan.leftOut ?? [] };
  return remaining.length === 0 ? withCooldown(env, batch, cooldown) : batch;
}

/**
 * The verified plan with what the verifying comparison's cooldown holds (and
 * the signals people weigh), or without any; a cooldown the comparison
 * couldn't evaluate is a problem, never "nothing held".
 */
async function withCooldown(env: GateEnvironment, batch: VerifiedBatch, cooldown: CooldownEvaluation | undefined): Promise<VerifiedBatch> {
  if (cooldown?.evaluated === false) return { ...batch, problems: [`the cooldown can't be evaluated: ${cooldown.reason}`] };
  const { cooldown: _previous, ...plan } = batch.plan;
  const held = cooldown?.held ?? [];
  if (held.length === 0) return { ...batch, plan };
  const registry = new NpmRegistry(env.fetch);
  const planned: PlannedHold[] = [];
  for (const entry of held) planned.push({ ...entry, signals: entry.ecosystem === "npm" ? await npmSignals(registry, entry) : [] });
  return { ...batch, plan: { ...plan, cooldown: planned } };
}

async function npmSignals(registry: NpmRegistry, entry: HeldVersion): Promise<string[]> {
  try {
    return releaseSignals(await registry.packument(entry.name), entry.name, entry.version, entry.replaced);
  } catch {
    return ["registry metadata unreadable"];
  }
}

async function recognisedPlans(
  context: ToolRunContext,
  publication: PublicationContext,
  own: ReadonlyArray<GitHubPullRequest>,
  plan: ChangePlan,
): Promise<GitHubPullRequest[]> {
  const topic = topicOf(RULES, branchFor(RULES, context.now, plan.topic));
  const owned: GitHubPullRequest[] = [];
  for (const candidate of own) {
    // A numeric suffix is the tool's PR opened next to one a human took over.
    const previous = planOf(candidate.body);
    if (previous === undefined || previous.kind !== plan.kind) continue;
    const prTopic = topicOf(RULES, candidate.headRef);
    const suffix = prTopic?.startsWith(`${topic}-`) ? prTopic.slice(`${topic}-`.length) : undefined;
    if (prTopic !== topic && (suffix === undefined || !/^\d+$/.test(suffix) || previous.topic !== plan.topic)) continue;
    const journaled = await publication.journal.last(context.repo.repo, candidate.number);
    // Legacy entries prove only the head: reconcile a freshly computed plan rather than trusting the body.
    const pr = journaled?.head === candidate.headSha && journaled.publication === undefined
      ? candidate : await recoverPublication(publication, candidate);
    const recorded = stateOf(pr.body);
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
  npmFiles?: ReadonlyMap<string, string>,
  cooldown?: (evaluation: CooldownEvaluation) => void,
): Promise<string[]> {
  const head = deps.trees.working(context.workingCopy);
  const headGradle = await inventories.ofWorkingTree(head);
  let reference: GradleInventory | undefined;
  try {
    reference = await referenceOf(plan, base, baseGradle, inventories);
  } catch (err) {
    return [`the plan's Gradle reference can't be built: ${(err as Error).message}`];
  }
  return deps.verify({
    plan, base, head, env, npmFiles, gradle: { base: baseGradle, head: headGradle }, reference, changedFiles: await deps.changedSince(context.workingCopy, base.id),
    ...(cooldown === undefined ? {} : { cooldown }),
  });
}

/**
 * The base with the plan applied by Gradle (`gradle-reference.ts`): its floors removed for a floor removal, its
 * declaration moves and floors otherwise. The base's own inventory when the plan changes nothing there, or when its
 * moves can't be applied faithfully (verification reports why).
 */
async function referenceOf(plan: ChangePlan, base: Tree, baseGradle: GradleInputs["head"], inventories: GradleInventories): Promise<GradleInventory | undefined> {
  if (baseGradle === undefined) return undefined;
  if (plan.kind === "floor-removal") {
    const floors = (plan.floorRemoval?.floors ?? []).filter((floor) => floor.ecosystem === "Maven");
    return floors.length === 0 ? baseGradle : inventories.ofCommit(base, { transform: removalTransform(floors) });
  }
  const { moves, floors, problems } = referencePlan(plan, baseGradle);
  if (problems.length > 0 || (moves.length === 0 && floors.length === 0)) return baseGradle;
  return inventories.ofCommit(base, { transform: referenceTransform(moves, floors) });
}

async function review(context: ToolRunContext, deps: SecureItDeps): Promise<Readonly<Record<string, unknown>>> {
  const env = await deps.gate(context);
  const inventories = deps.gradle(context);
  const publication = publicationOf(context, deps);
  const execution = { context, deps, env, inventories, publication, npmFiles: new Map<string, string>() };
  const notes: Array<Readonly<Record<string, unknown>>> = [];
  const planFrom = (pr: GitHubPullRequest): ChangePlan => {
    const plan = planOf(pr.body);
    if (plan === undefined) throw new Error(`${pr.url} has no plan secure-it can read`);
    return plan;
  };
  const steps: ReviewSteps = {
    cooldown: (pr) => cooldownState(planFrom(pr), context.now),
    async rebase(pr, merge: BaseMerge) {
      execution.npmFiles.clear();
      const previous = planFrom(pr);
      const baseSha = merge.prepared.baseSha;
      // Recomputed on the new base first: it may already have the fix, or need a different one.
      const base = await deps.trees.commit(context.workingCopy, baseSha);
      const baseGradle = await inventories.ofCommit(base);
      const found = await deps.candidates(base, env, { head: baseGradle });
      if (found.incomplete.length > 0) throw new Error(`the new base's inventory is incomplete: ${found.incomplete.join("; ")}`);
      if (previous.kind === "floor-removal") {
        if (found.fixes.some((fix) => fix.malicious)) throw new Error("malware on base must be fixed before removing floors");
        const removal = await computeRemoval(execution, { tree: base, gradle: baseGradle });
        notes.push({ number: pr.number, notes: removal.notes });
        if (removal.plan === undefined) {
          if (removal.notes.length > 0) throw new Error(`floor-removal recomputation is blocked; keeping the PR: ${removal.notes.join("; ")}`);
          await closeAndDelete(publication, pr.number, pr.headSha, "The default branch no longer has removable security floors.");
          return "retired";
        }
        // Recompute unlocked on every changed base; dependency conflicts are resolved by reverting the old plan.
        await deps.revert(context.workingCopy, baseSha);
        const content = await applyRemoval(execution, removal);
        const problems = await verifyEdit(context, deps, removal.plan, env, inventories, base, baseGradle);
        if (problems.length > 0) throw new Error(`floor removal after merging base: ${problems.join("; ")}`);
        await publishUpdate(publication, merge.prepared, pr.number, content);
        return "rebased";
      }
      const { units, blocked } = await reviewUnits(previous, found.fixes, found.npmPeers);
      if (blocked.length > 0) notes.push({ number: pr.number, blocked });
      // Split exactly as a run would, required-dependency moves included, before telling which unit is this PR's.
      const unit = unitOf(previous, await holdRequiredYoung(execution, units, { tree: base, gradle: baseGradle }));
      if (unit === undefined) {
        await closeAndDelete(publication, pr.number, pr.headSha, "No actionable fixes remain for this security unit on the default branch. Blocked fixes are reported by secure-it.");
        return "retired";
      }
      const recomputed = await planUnit(execution, unit, { tree: base, gradle: baseGradle });
      // Plans predating batches retain their package scope and branch topic until retired.
      const plan = previous.kind === undefined ? { ...recomputed, kind: undefined, topic: previous.topic } : recomputed;
      if (plan.notes !== undefined && plan.notes.length > 0) notes.push({ number: pr.number, notes: plan.notes });
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
          input: await agentInput(execution, plan, base, code.length > 0 ? "resolve" : "apply", code.length > 0 ? { conflicted: code } : {}),
          effort: effortFor(context, plan),
        });
        if (answer.outcome !== "applied") throw new Error(`the agent couldn't re-apply the plan on the new base: ${answer.summary}`);
        // A different plan is a different change: its own title and description.
        if (changed && answer.publication != null) {
          content = { title: answer.publication.title, body: `${answer.publication.body}\n\n${planSection(plan)}`, commitMessage: answer.publication.commitMessage };
        }
      } else {
        await prepareNpmFiles(execution, plan, base, true);
      }
      // Fixes remain (the recomputation said so): an edit that left the base as it was fails verification, it isn't retired.
      const verified = await verifyWithRetry(execution, { tree: base, gradle: baseGradle }, plan, content);
      if (verified.leftOut.length > 0) notes.push({ number: pr.number, leftOut: verified.leftOut, named: verified.named });
      if (verified.problems.length > 0) throw new Error(`after merging the default branch: ${verified.problems.join("; ")}`);
      await publishUpdate(publication, merge.prepared, pr.number, { ...verified.content, body: withPlanSection(verified.content.body, verified.plan) });
      return "rebased";
    },
    async adapt(pr, prepared, _context, attempt) {
      execution.npmFiles.clear();
      const plan = planFrom(pr);
      if (plan.kind === "floor-removal") {
        context.logger.warn("secure-it: floor-removal CI failure cannot be adapted", { number: pr.number, detail: "the proved removal cannot legitimately be edited" });
        return false;
      }
      const checks = await context.github.headChecks({ repo: context.repo.repo, sha: pr.headSha });
      const failingChecks = failingCheckNames(checks);
      const base = await deps.trees.commit(context.workingCopy, prepared.baseSha);
      const answer = await context.agent<ReturnType<typeof skillInput>, SkillAnswer>({
        entrypoint: "secure-it",
        input: await agentInput(execution, plan, base, "adapt", { failingChecks }),
        effort: effortFor(context, plan),
      });
      if (answer.outcome !== "applied" || answer.publication == null) return false;
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

/** Whether a PR's plan is held, and whether its last held version has aged by `now`. */
export function cooldownState(plan: ChangePlan, now: Date): CooldownState | undefined {
  const until = heldUntil(plan.cooldown ?? []);
  if (until === undefined) return undefined;
  return { kind: now.getTime() >= Date.parse(until) ? "aged" : "waiting", until };
}

/** New routine PRs recompute all non-majors; majors and legacy PRs retain their package scope. */
async function reviewUnits(previous: ChangePlan, fixes: ReadonlyArray<SecurityFix>, peers?: NpmPeerPlanner) {
  if (previous.kind !== "malware" && !previous.malware && fixes.some((fix) => fix.malicious)) {
    throw new Error("malware on the new base must be fixed together before this security unit can verify");
  }
  const ours = new Set(previous.packages);
  const scoped = previous.kind === "routine" || previous.malware ? fixes : fixes.filter((fix) => ours.has(packageKey(fix)));
  return coupledWork(scoped, peers);
}

/** The recomputed unit an open PR stands for: two routine units can exist (aged and held), so its topic says which. */
function unitOf(previous: ChangePlan, units: ReadonlyArray<SecurityUnit>): SecurityUnit | undefined {
  const kind = previous.malware ? "malware" : previous.kind;
  if (kind === undefined) return units[0];
  return units.find((unit) => unit.kind === kind && (kind !== "routine" || unit.topic === previous.topic));
}
