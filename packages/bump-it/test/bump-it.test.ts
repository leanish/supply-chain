import { describe, expect, it } from "vitest";
import { ConsoleLogger } from "../../agent-basics/src/logger/console-logger.ts";
import type { GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";
import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { InMemoryWorkspace } from "../../agent-basics/src/working-copy/in-memory-workspace.ts";
import type { BumpCandidate } from "../../ci/src/candidates.ts";
import { prepareNpmPeers } from "../../ci/src/npm-peers.ts";
import { versionKey } from "../../ci/src/package-version.ts";
import { Snapshot } from "../../ci/src/snapshot.ts";
import type { Tree } from "../../ci/src/tree.ts";
import type { ToolRunContext } from "../../remediation/src/command.ts";
import { parseToolConfig } from "../../remediation/src/config.ts";
import { MemoryJournal } from "../../remediation/src/journal.ts";
import { branchFor, stateOf, withMarker } from "../../remediation/src/own-pr.ts";
import { BASE_SHA, FakeGitHub, GREEN, HEAD_SHA, ownPr, PUSHED_SHA, RED } from "../../remediation/test/fake-github.ts";
import { bumpIt, type BumpItDeps, RULES } from "../src/bump-it.ts";
import type { NpmResult } from "../src/npm-compute.ts";
import { type BumpPlan, planFor, planOf, planSection } from "../src/plan.ts";
import { majorUnits, routineUnit, type Unit } from "../src/units.ts";
import { candidate } from "./fixtures.ts";

const NOW = new Date("2026-10-07T06:00:00Z");
const NEW_BASE = "f".repeat(40);
const REPO = "leanish/widget";
const CONFIG = parseToolConfig("bump-it", `repos: [{ repo: ${REPO} }]
agent: { codingAgent: codex, model: sol, effort: medium, majorEffort: high }
secrets: { write: w, read: r }
commitIdentity: { name: leanish, email: leanish@example.com }
dirs: { state: /synthetic/state, cache: /synthetic/cache }
maxNewMajorsPerRun: 1
`, "agent.yaml");
const BASE_FILES = { "package.json": JSON.stringify({ dependencies: { lib: "^1.0.0" } }), "package-lock.json": JSON.stringify({ packages: { "": { dependencies: { lib: "^1.0.0" } }, "node_modules/lib": { version: "1.0.0" } } }) };
const tree = (id: string, files: Record<string, string>): Tree => ({ id, read: async (path) => files[path], list: async (dir) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`)) });
function npmOf(unit: Pick<Unit, "moves">): NpmResult {
  const move = unit.moves.find((move) => move.ecosystem === "npm");
  return { files: move === undefined ? new Map() : new Map([["package-lock.json", JSON.stringify({ packages: { "": { dependencies: { [move.name]: `^${move.to}` } }, [`node_modules/${move.name}`]: { version: move.to } } })], ["package.json", JSON.stringify({ dependencies: { [move.name]: `^${move.to}` } })]]), changes: [], notes: [] };
}
async function prFor(unit: Unit, overrides: Partial<GitHubPullRequest> = {}): Promise<GitHubPullRequest> {
  const plan = await planFor(unit, npmOf(unit), async () => "1".repeat(40));
  return ownPr({ headRef: `bump-it/2026-10-05-${unit.topic}`, labels: [RULES.label], body: withMarker(RULES, `Body.\n\n${planSection(plan)}`, { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }), ...overrides });
}
function harness(options: { bumps?: BumpCandidate[]; prs?: GitHubPullRequest[]; baseSha?: string; problems?: string[]; incomplete?: string[]; deferred?: string[]; refuse?: boolean; npm?: (unit: Unit) => Promise<NpmResult> } = {}) {
  const github = new FakeGitHub(...options.prs ?? []);
  const workspace = new InMemoryWorkspace();
  const wc: WorkingCopy = { projectId: REPO, path: "/synthetic/widget", gitDir: "/synthetic/git", headSha: options.baseSha ?? BASE_SHA, branch: "main" };
  const files: Record<string, string> = { ...BASE_FILES };
  const agentCalls: Array<{ effort?: string; input: Record<string, unknown> }> = [];
  const computed: Array<{ topic: string; base: string }> = [];
  const verified: BumpPlan[] = [];
  const reverted: string[] = [];
  const journal = new MemoryJournal();
  let deferred: ReadonlyArray<string> = options.deferred ?? [];
  const reset = (contents: Record<string, string>) => { for (const path of Object.keys(files)) delete files[path]; Object.assign(files, contents); };
  const originalPrepare = workspace.prepareBranch.bind(workspace);
  workspace.prepareBranch = async (workingCopy, args) => {
    if (args.start === "default") reset(BASE_FILES);
    else {
      const pr = [...github.prs.values()].find((pr) => pr.headRef === args.branch);
      if (pr !== undefined) {
        const plan = planOf(pr.body)!;
        reset({ ...BASE_FILES, ...Object.fromEntries(npmOf(plan).files) });
      }
    }
    return originalPrepare(workingCopy, args);
  };
  for (const pr of options.prs ?? []) workspace.setRemoteHead(pr.headRef, pr.headSha);
  const context: ToolRunContext = { config: CONFIG, repo: { repo: REPO, branch: undefined }, base: "main", github, workspace, workingCopy: wc, now: NOW, releaseAgeDays: 7, releaseAgeExclude: [], readToken: "read-token", isolation: {}, logger: new ConsoleLogger({ minLevel: "error" }), agent: (async (call: { effort?: string; input: Record<string, unknown> }) => { agentCalls.push(call); return options.refuse ? { outcome: "cannot-apply", summary: "can't migrate" } : { outcome: "applied", summary: "updated", publication: { title: "upgrading lib", body: "Adapts to the upgrade.", commitMessage: "upgrading lib" } }; }) as ToolRunContext["agent"] };
  const deps: BumpItDeps = {
    gate: async () => ({ run: async () => ({ code: 0, stdout: "", stderr: "" }), fetch: async (url) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => String(url).includes("/git/") ? { object: { type: "commit", sha: "1".repeat(40) } } : {}, text: async () => "" }), now: () => NOW, osvScanner: "osv-scanner", githubToken: "read-token" }),
    gradle: () => ({ ofCommit: async () => undefined, ofWorkingTree: async () => undefined }),
    trees: { commit: async (_wc, sha) => tree(sha, BASE_FILES), working: () => tree("worktree", files) },
    candidates: async () => ({ bumps: options.bumps ?? [candidate()], incomplete: options.incomplete ?? [], gaps: [], osvScannerVersion: "2.6.0" }),
    npm: async (_context, unit, base) => { computed.push({ topic: unit.topic, base: base.id }); return options.npm === undefined ? npmOf(unit) : options.npm(unit); },
    verify: async (input) => { verified.push(input.plan); return options.problems ?? []; },
    changedSince: async () => ["package.json", "package-lock.json"],
    journal: () => journal,
    priority: () => ({ read: async () => deferred, write: async (packages) => { deferred = [...packages]; } }),
    writeFile: async (_wc, path, content) => { files[path] = content; },
    removeFile: async (_wc, path) => { delete files[path]; },
    revert: async (_wc, sha) => { reverted.push(sha); reset(BASE_FILES); return ["package-lock.json"]; },
  };
  return { context, deps, github, workspace, agentCalls, computed, verified, reverted, journal, files, deferred: () => deferred };
}
const major = (bump = candidate()) => majorUnits([bump])[0]!;
const routine = (bump = candidate()) => routineUnit([bump]);

describe("bump-it run", () => {
  it("forces reconciliation of a legacy journal head instead of trusting its stale same-plan body", async () => {
    const pr = await prFor(routine(), { headSha: "9".repeat(40) });
    const h = harness({ prs: [pr], bumps: [candidate({ major: undefined })] });
    await h.journal.pushed(REPO, pr.number, { head: pr.headSha, base: BASE_SHA });
    expect(await bumpIt(h.deps).run(h.context)).toMatchObject({ units: [{ outcome: "updated" }] });
    expect(h.reverted).toEqual([BASE_SHA]);
    expect((await h.journal.last(REPO, pr.number))?.publication?.body).toBe(h.github.prs.get(pr.number)?.body);
  });
  it("reports cross-major Vitest/UI/coverage peer sets as blocked without coordinating their majors", async () => {
    const names = ["vitest", "@vitest/ui", "@vitest/coverage-v8"];
    const manifest = (name: string, version: string) => name === "vitest"
      ? { peerDependencies: { "@vitest/ui": version, "@vitest/coverage-v8": version } }
      : { peerDependencies: { vitest: version } };
    const packages = { "": { devDependencies: Object.fromEntries(names.map((name) => [name, "^4.1.7"])) },
      ...Object.fromEntries(names.map((name) => [`node_modules/${name}`, { version: "4.1.7", ...manifest(name, "4.1.7") }])) };
    const lock = { lockfileVersion: 3, packages };
    const prepared = await prepareNpmPeers(new Map([["package-lock.json", lock]]), names.map((name) => ({ ecosystem: "npm" as const, name, version: "5.0.0" })), {
      versions: async () => ["4.1.7", "4.1.11", "5.0.0"], manifest: async (name, version) => manifest(name, version),
      published: async () => new Date("2026-01-01"), identity: async () => [], line: (_name, version) => version.split(".")[0]!, isOwn: () => false, now: NOW, releaseAgeDays: 7,
    });
    const snapshot = new Snapshot(new Map([...prepared.bases, ...prepared.candidates].map((pkg) => [versionKey(pkg), []])), [], NOW);
    const h = harness({ bumps: names.map((name) => candidate({ name, from: "4.1.7", minor: undefined, major: { version: "5.0.0", line: "5" },
      declarations: [{ lockfile: "package-lock.json", workspace: ".", declaredAs: name, spec: "^4.1.7" }] })) });
    const found = await h.deps.candidates(tree(BASE_SHA, BASE_FILES), await h.deps.gate(h.context), {});
    const result = await bumpIt({ ...h.deps, candidates: async () => ({ ...found, npmPeers: { resolve: (moves) => prepared.resolve(moves, snapshot) } }),
      trees: { ...h.deps.trees, commit: async (_wc, sha) => tree(sha, { "package-lock.json": JSON.stringify(lock), "package.json": JSON.stringify(packages[""]) }) } }).run(h.context);
    expect(result).toMatchObject({ units: [{ outcome: "nothing-to-move" }, ...names.map(() => ({ outcome: "blocked", detail: expect.stringContaining("no safe aged compatible direct-peer set") }))] });
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
    expect(h.computed.map((unit) => unit.topic)).toEqual(["routine"]);
  });
  it("carries the candidate peer planner through routine and major computation before any agent", async () => {
    const h = harness();
    const found = await h.deps.candidates(tree(BASE_SHA, BASE_FILES), await h.deps.gate(h.context), {});
    const calls: Unit[] = [];
    const peers = { resolve: async () => ({ additions: [{ name: "companion", from: "1.0.0", to: "1.0.1", line: "1", aged: true,
      locations: ["node_modules/companion"], declarations: [{ name: "companion", version: "1.0.0", path: "node_modules/companion",
        declaredAs: "companion", workspace: "", lockfile: "package-lock.json", spec: "^1.0.0" }] }], blocked: [], sets: [["lib", "companion"]] }) };
    const deps = { ...h.deps, candidates: async () => ({ ...found, npmPeers: peers }), npm: async (_context: ToolRunContext, unit: Unit) => {
      calls.push(unit);
      return npmOf(unit);
    } };
    expect(await bumpIt(deps).run(h.context)).toMatchObject({ units: [{ outcome: "published" }, { outcome: "published" }] });
    expect(calls.map((unit) => unit.moves.map((move) => move.name))).toEqual([["lib", "companion"], ["lib", "companion"]]);
    expect(h.verified.every((plan) => plan.moves.some((move) => move.name === "companion"))).toBe(true);
    expect(h.agentCalls).toHaveLength(1);
    expect(h.agentCalls[0]?.input["moves"]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "companion", to: "1.0.1", major: false })]));
  });

  it("publishes npm routine without a model and each major with high effort, always from the original base", async () => {
    const h = harness();
    expect(await bumpIt(h.deps).run(h.context)).toMatchObject({ units: [{ topic: "routine", outcome: "published" }, { topic: "lib-major", outcome: "published" }] });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.agentCalls[0]).toMatchObject({ effort: "high", input: { kind: "major", mode: "apply", toolWritten: ["package-lock.json", "package.json"] } });
    expect(h.computed.every((entry) => entry.base === BASE_SHA)).toBe(true);
    expect(h.workspace.preparations.map((entry) => entry.args.start)).toEqual(["default", "default"]);
    expect(planOf(h.github.prs.get(42)!.body)?.kind).toBe("routine");
    expect(stateOf(h.github.prs.get(43)!.body)).toMatchObject({ head: PUSHED_SHA, base: BASE_SHA });
  });
  it("uses the agent only for non-npm routine moves, with normal effort", async () => {
    const h = harness({ bumps: [candidate({ ecosystem: "Maven", name: "g:lib", locations: [":runtimeClasspath"], declarations: [], major: undefined })] });
    await bumpIt(h.deps).run(h.context);
    expect(h.agentCalls).toMatchObject([{ effort: "medium", input: { kind: "routine", moves: [{ mechanism: "gradle-declared" }] } }]);
  });
  it("can publish a routine transitive-only refresh", async () => {
    const h = harness({ bumps: [], npm: async () => ({ files: new Map([["package-lock.json", "refreshed"]]), changes: [], notes: [] }) });
    expect(await bumpIt(h.deps).run(h.context)).toMatchObject({ units: [{ outcome: "published" }] });
    expect(h.agentCalls).toEqual([]);
  });
  it("suppresses only a recognised identical plan; a changed plan is reconciled", async () => {
    const pr = await prFor(routine());
    const same = harness({ prs: [pr], bumps: [candidate({ major: undefined })] });
    expect(await bumpIt(same.deps).run(same.context)).toMatchObject({ units: [{ outcome: "already-open" }] });
    expect(same.workspace.preparations).toEqual([]);
    const changed = harness({ prs: [await prFor(routine(candidate({ minor: { version: "1.0.1", line: "1" } })))], bumps: [candidate({ major: undefined })] });
    expect(await bumpIt(changed.deps).run(changed.context)).toMatchObject({ units: [{ outcome: "updated" }] });
    expect(changed.reverted).toEqual([BASE_SHA]);
    expect(changed.workspace.preparations[0]?.args.start).toBe("remote-merging");
  });
  it("accepts the journal's exact head for run reuse, and never a different head", async () => {
    const pr = await prFor(routine(), { headSha: "9".repeat(40) });
    const h = harness({ prs: [pr], bumps: [candidate({ major: undefined })] });
    await h.journal.pushed(REPO, pr.number, { head: pr.headSha, base: BASE_SHA, publication: {
      title: pr.title, body: withMarker(RULES, pr.body, { head: pr.headSha, base: BASE_SHA, adaptations: 0 }), adaptations: 0,
    } });
    expect(await bumpIt(h.deps).run(h.context)).toMatchObject({ units: [{ outcome: "already-open" }] });
    const human = harness({ prs: [{ ...pr, headRef: "bump-it/2026-10-07-routine" }], bumps: [candidate({ major: undefined })] });
    expect(await bumpIt(human.deps).run(human.context)).toMatchObject({ units: [{ outcome: "published" }] });
    expect(human.github.prs.get(42)?.headRef).toBe("bump-it/2026-10-07-routine-2");
    expect(human.github.prs.get(7)?.headSha).toBe(pr.headSha);
  });
  it("reuses its suffixed PR, but leaves a human push to that branch alone", async () => {
    const old = routine(candidate({ minor: { version: "1.0.1", line: "1" } }));
    const pr = await prFor(old, { headRef: "bump-it/2026-10-05-routine-2" });
    const own = harness({ prs: [pr], bumps: [candidate({ major: undefined })] });
    expect(await bumpIt(own.deps).run(own.context)).toMatchObject({ units: [{ outcome: "updated", pullRequest: pr.url }] });
    expect(own.workspace.preparations[0]?.args).toMatchObject({ branch: pr.headRef, start: "remote-merging" });
    expect(own.github.prs.size).toBe(1);

    const humanHead = "9".repeat(40);
    const human = harness({ prs: [{ ...pr, headSha: humanHead }], bumps: [candidate({ major: undefined })] });
    expect(await bumpIt(human.deps).run(human.context)).toMatchObject({ units: [{ outcome: "published" }] });
    expect(human.github.prs.get(pr.number)?.headSha).toBe(humanHead);
    expect(human.workspace.preparations[0]?.args).toMatchObject({ start: "default" });
    expect(human.workspace.preparations[0]?.args.branch).not.toBe(pr.headRef);
  });
  it("makes room for a human-owned long major branch with a suffix that survives truncation", async () => {
    const bump = candidate({ name: "x".repeat(80) });
    const unit = major(bump);
    const branch = branchFor(RULES, NOW, unit.topic);
    const h = harness({ bumps: [bump], prs: [await prFor(unit, { headRef: branch, headSha: "9".repeat(40) })] });
    await bumpIt(h.deps).run(h.context);
    expect(h.github.prs.get(43)?.headRef).toBe(`${branch.slice(0, -2)}-2`);
  });
  it("continues other units after a computation, verification or agent failure", async () => {
    const h = harness({ npm: async (unit) => { if (unit.kind === "routine") throw new Error("npm failed"); return npmOf(unit); } });
    expect(await bumpIt(h.deps).run(h.context)).toMatchObject({ units: [{ outcome: "failed", detail: "npm failed" }, { outcome: "published" }] });
    const invalid = harness({ problems: ["wrong lock bytes"] });
    expect(await bumpIt(invalid.deps).run(invalid.context)).toMatchObject({ units: [{ outcome: "failed" }, { outcome: "failed" }] });
    expect(invalid.workspace.publications).toEqual([]);
    const refused = harness({ refuse: true });
    expect(await bumpIt(refused.deps).run(refused.context)).toMatchObject({ units: [{ outcome: "published" }, { outcome: "failed" }] });
  });
  it("does nothing with incomplete inventory, or an empty recomputation", async () => {
    const h = harness({ incomplete: ["build failed"] });
    expect(await bumpIt(h.deps).run(h.context)).toMatchObject({ outcome: "incomplete" });
    expect(h.computed).toEqual([]); expect(h.workspace.preparations).toEqual([]);
    const empty = harness({ bumps: [] });
    expect(await bumpIt(empty.deps).run(empty.context)).toMatchObject({ units: [{ outcome: "nothing-to-move" }] });
  });
  it("caps only new majors, updates existing ones past the cap, and remembers the deferred queue", async () => {
    const existing = candidate({ name: "z", locations: ["z"] });
    const bumps = [candidate({ name: "a", locations: ["a", "b", "c"] }), candidate({ name: "b", locations: ["b", "c"] }), existing];
    const h = harness({ bumps, prs: [await prFor(major({ ...existing, major: { version: "2.0.1", line: "2" } }))] });
    expect(await bumpIt(h.deps).run(h.context)).toMatchObject({ units: [{ outcome: "published" }, { topic: "a-major", outcome: "published" }, { topic: "b-major", outcome: "deferred" }, { topic: "z-major", outcome: "updated" }] });
    expect(h.deferred()).toEqual(["npm|b"]);
    const next = harness({ bumps, deferred: ["npm|b"] });
    await bumpIt(next.deps).run(next.context);
    expect(next.computed[1]?.topic).toBe("b-major");
  });
  it("refuses a base or PR head race before any edit or push", async () => {
    const h = harness({ prs: [await prFor(routine(candidate({ minor: { version: "1.0.1", line: "1" } })))], bumps: [candidate({ major: undefined })] });
    const prepare = h.workspace.prepareBranch.bind(h.workspace);
    h.workspace.prepareBranch = (wc, args) => prepare({ ...wc, headSha: NEW_BASE }, args);
    expect(await bumpIt(h.deps).run(h.context)).toMatchObject({ units: [{ outcome: "failed", detail: expect.stringContaining("default branch moved") }] });
    expect(h.reverted).toEqual([]); expect(h.workspace.publications).toEqual([]);
    const pushed = harness({ prs: [await prFor(routine(candidate({ minor: { version: "1.0.1", line: "1" } })))], bumps: [candidate({ major: undefined })] });
    pushed.workspace.setRemoteHead(pushed.github.prs.get(7)!.headRef, "9".repeat(40));
    expect(await bumpIt(pushed.deps).run(pushed.context)).toMatchObject({ units: [{ outcome: "failed", detail: expect.stringContaining("someone pushed") }] });
    expect(pushed.reverted).toEqual([]);
  });
});

describe("bump-it review", () => {
  it("leaves someone else's push alone; pending and green use no model or candidates", async () => {
    const human = harness({ prs: [await prFor(routine(), { headSha: "9".repeat(40) })] });
    expect(await bumpIt(human.deps).review(human.context)).toMatchObject({ reviewed: [{ outcome: "left-alone" }] });
    const green = harness({ prs: [await prFor(major())] });
    green.github.checks = GREEN;
    expect(await bumpIt(green.deps).review(green.context)).toMatchObject({ reviewed: [{ outcome: "marked-ready" }] });
    expect(green.agentCalls).toEqual([]); expect(green.computed).toEqual([]);
    const pending = harness({ prs: [await prFor(major())] });
    pending.github.checks = { ...GREEN, checkRuns: [{ name: "build", status: "in_progress", conclusion: null }] };
    expect(await bumpIt(pending.deps).review(pending.context)).toMatchObject({ reviewed: [{ outcome: "pending" }] });
    expect(pending.agentCalls).toEqual([]);
  });
  it("retires a unit only from recomputation saying nothing remains, before an agent", async () => {
    for (const unit of [routine(), major()]) {
      const h = harness({ prs: [await prFor(unit)], bumps: [], baseSha: NEW_BASE });
      expect(await bumpIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "retired" }] });
      expect(h.agentCalls).toEqual([]);
    }
  });
  it("recomputes the whole routine on a moved base and reconciles a changed plan", async () => {
    const h = harness({ prs: [await prFor(routine())], baseSha: NEW_BASE, bumps: [candidate({ minor: { version: "1.2.0", line: "1" }, major: undefined })] });
    expect(await bumpIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(h.reverted).toEqual([NEW_BASE]);
    expect(h.computed).toEqual([{ topic: "routine", base: NEW_BASE }]);
    expect(h.agentCalls).toEqual([]);
    expect(planOf(h.github.prs.get(7)!.body)?.moves[0]?.to).toBe("1.2.0");
  });
  it("a major's same target merges with no model; a new target redoes high-effort adaptation", async () => {
    const same = harness({ prs: [await prFor(major())], baseSha: NEW_BASE });
    expect(await bumpIt(same.deps).review(same.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(same.agentCalls).toEqual([]); expect(same.reverted).toEqual([]);
    const changed = harness({ prs: [await prFor(major())], baseSha: NEW_BASE, bumps: [candidate({ major: { version: "3.0.0", line: "3" } })] });
    expect(await bumpIt(changed.deps).review(changed.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(changed.agentCalls).toMatchObject([{ effort: "high", input: { mode: "apply" } }]);
    expect(changed.reverted).toEqual([NEW_BASE]);
  });
  it("re-applies mechanical conflicts; explicitly sends code conflicts to major resolve", async () => {
    const mechanical = harness({ prs: [await prFor(major())], baseSha: NEW_BASE });
    mechanical.workspace.setPrepareConflict(mechanical.github.prs.get(7)!.headRef);
    expect(await bumpIt(mechanical.deps).review(mechanical.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(mechanical.agentCalls).toMatchObject([{ input: { mode: "apply" } }]);
    const code = harness({ prs: [await prFor(major())], baseSha: NEW_BASE });
    const prepare = code.workspace.prepareBranch.bind(code.workspace);
    code.workspace.prepareBranch = async (wc, args) => {
      const result = await prepare(wc, args);
      return args.start === "remote-merging" && result.kind === "prepared" ? { kind: "conflicted", prepared: result.prepared, conflicted: ["src/lib.ts"] } : result;
    };
    expect(await bumpIt(code.deps).review(code.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(code.agentCalls).toMatchObject([{ effort: "high", input: { mode: "resolve", conflicted: ["src/lib.ts"] } }]);
  });
  it("routine failures do not adapt; a major adapts with high effort and the attempt marker", async () => {
    const routineFail = harness({ prs: [await prFor(routine())] }); routineFail.github.checks = RED;
    expect(await bumpIt(routineFail.deps).review(routineFail.context)).toMatchObject({ reviewed: [{ outcome: "adaptation-unchanged" }] });
    expect(routineFail.agentCalls).toEqual([]);
    const h = harness({ prs: [await prFor(major())] }); h.github.checks = { ...RED, statuses: [{ context: "legacy", state: "failure" }] };
    expect(await bumpIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "adapted" }] });
    expect(h.agentCalls).toMatchObject([{ effort: "high", input: { mode: "adapt", failingChecks: ["check", "legacy"] } }]);
    expect(stateOf(h.github.prs.get(7)!.body)?.adaptations).toBe(1);
  });
  it.each([
    ["four spaces, CRLF and a final newline", "    ", "\r\n", true],
    ["tabs, LF and no final newline", "\t", "\n", false],
    ["compact JSON", undefined, "\n", false],
  ] as const)("preserves a major's script adaptation and %s across a clean same-target merge", async (_name, indent, newline, finalNewline) => {
    const h = harness({ prs: [await prFor(major())], baseSha: NEW_BASE });
    let expected = "";
    const prepare = h.workspace.prepareBranch.bind(h.workspace);
    h.workspace.prepareBranch = async (wc, args) => {
      const result = await prepare(wc, args);
      const manifest = JSON.parse(h.files["package.json"]!);
      expected = JSON.stringify({ ...manifest, scripts: { test: "new-cli --changed" } }, null, indent)
        .replaceAll("\n", newline) + (finalNewline ? newline : "");
      h.files["package.json"] = expected;
      return result;
    };
    expect(await bumpIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(h.files["package.json"]).toBe(expected);
    expect(h.agentCalls).toEqual([]);
  });
  it("checks recorded lockfile hashes before letting a major adapt", async () => {
    const h = harness({ prs: [await prFor(major())] }); h.github.checks = RED;
    const prepare = h.workspace.prepareBranch.bind(h.workspace);
    h.workspace.prepareBranch = async (wc, args) => { const result = await prepare(wc, args); h.files["package-lock.json"] += "\n"; return result; };
    expect(await bumpIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "error", detail: expect.stringContaining("recorded npm plan") }] });
    expect(h.agentCalls).toEqual([]); expect(h.workspace.publications).toEqual([]);
  });
  it("consumes failed major adaptations, then closes after two attempts", async () => {
    const h = harness({ prs: [await prFor(major())], refuse: true }); h.github.checks = RED;
    expect(await bumpIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "error" }] });
    expect(await bumpIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "error" }] });
    expect(await bumpIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "closed" }] });
    expect(h.agentCalls).toHaveLength(2);
  });
  it("does not publish a failed rebase/adaptation, and keeps reviewing the other PRs", async () => {
    const h = harness({ prs: [await prFor(major()), await prFor(routine(), { number: 8 })], problems: ["wrong bytes"], baseSha: NEW_BASE });
    expect(await bumpIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "error" }, { outcome: "error" }] });
    expect(h.workspace.publications).toEqual([]);
    const adapt = harness({ prs: [await prFor(major())], problems: ["wrong bytes"] }); adapt.github.checks = RED;
    expect(await bumpIt(adapt.deps).review(adapt.context)).toMatchObject({ reviewed: [{ outcome: "error" }] });
    expect(adapt.workspace.publications).toEqual([]);
    expect(stateOf(adapt.github.prs.get(7)!.body)?.adaptations).toBe(1);
  });
});
