import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "../../agent-basics/src/logger/console-logger.ts";
import type { GitHubPullRequest } from "../../agent-basics/src/types/clients.ts";
import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { InMemoryWorkspace } from "../../agent-basics/src/working-copy/in-memory-workspace.ts";
import type { GradleInventory } from "../../ci/src/gradle.ts";
import type { SecurityFix } from "../../ci/src/candidates.ts";
import type { Tree } from "../../ci/src/tree.ts";
import type { ToolRunContext } from "../../remediation/src/command.ts";
import { parseToolConfig } from "../../remediation/src/config.ts";
import { MemoryJournal } from "../../remediation/src/journal.ts";
import { stateOf, withMarker } from "../../remediation/src/own-pr.ts";
import { BASE_SHA, FakeGitHub, HEAD_SHA, ownPr, PUSHED_SHA, RED } from "../../remediation/test/fake-github.ts";
import { planOf, planSection } from "../src/plan-block.ts";
import { planFor } from "../src/plan.ts";
import type { VerifyInputs } from "../src/verify.ts";
import { RULES, type SecureItDeps, secureIt } from "../src/secure-it.ts";

const REPO = "leanish/widget";
const NOW = new Date("2026-10-07T06:00:00Z");
const CONFIG = parseToolConfig(
  "secure-it",
  `repos: [{ repo: ${REPO} }]
agent: { codingAgent: codex, model: sol, effort: medium, majorEffort: high }
secrets: { write: w, read: r }
commitIdentity: { name: leanish, email: leanish@example.com }
dirs: { state: /tmp/state, cache: /tmp/cache }
`,
  "agent.yaml",
);

const LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: { "": { name: "widget", dependencies: { vite: "^8.3.0" } }, "node_modules/vite": { version: "8.3.1" }, "node_modules/left-pad": { version: "1.0.0" } },
});

function tree(id: string, files: Record<string, string> = { "package-lock.json": LOCK }): Tree {
  return { id, read: async (path) => files[path], list: async (dir) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`)) };
}

function vite(overrides: Partial<SecurityFix> = {}): SecurityFix {
  return {
    ecosystem: "npm",
    name: "vite",
    from: "8.3.1",
    locations: ["node_modules/vite"],
    targets: ["GHSA-rq7h-c2jc-7f22"],
    unfixable: [],
    malicious: false,
    severity: "MODERATE",
    to: { version: "8.3.3", line: "8", aged: false, major: false, blockers: [] },
    problem: undefined,
    ...overrides,
  };
}

const APPLIED = { outcome: "applied", summary: "moved vite", publication: { title: "moving vite to 8.3.3", body: "Fixes three dev-server advisories.", commitMessage: "moving vite to 8.3.3" } };

interface Harness {
  readonly context: ToolRunContext;
  readonly deps: SecureItDeps;
  readonly github: FakeGitHub;
  readonly workspace: InMemoryWorkspace;
  readonly agentCalls: Array<{ entrypoint: string; input: Record<string, unknown>; effort?: string }>;
  readonly written: string[];
  readonly reverted: string[];
  readonly journal: MemoryJournal;
}

function harness(options: { prs?: GitHubPullRequest[]; fixes?: SecurityFix[]; answer?: unknown; problems?: string[]; baseSha?: string } = {}): Harness {
  const github = new FakeGitHub(...(options.prs ?? []));
  const workspace = new InMemoryWorkspace();
  const workingCopy: WorkingCopy = { projectId: REPO, path: "/synthetic/leanish/widget", branch: "main", headSha: options.baseSha ?? BASE_SHA, gitDir: "/synthetic/.git" };
  const agentCalls: Harness["agentCalls"] = [];
  const written: string[] = [];
  const reverted: string[] = [];
  const journal = new MemoryJournal();
  const context: ToolRunContext = {
    config: CONFIG,
    repo: { repo: REPO, branch: undefined },
    base: "main",
    github,
    workspace,
    workingCopy,
    logger: new ConsoleLogger({ minLevel: "error" }),
    now: NOW,
    releaseAgeDays: 7,
    releaseAgeExclude: [],
    readToken: "read-token",
    isolation: {},
    agent: (async (call: { entrypoint: string; input: Record<string, unknown>; effort?: string }) => {
      agentCalls.push(call);
      return options.answer ?? APPLIED;
    }) as ToolRunContext["agent"],
  };
  const deps: SecureItDeps = {
    gate: async () => ({ run: async () => ({ code: 0, stdout: "", stderr: "" }), fetch: async () => ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => "" }), now: () => NOW, osvScanner: "osv-scanner", githubToken: "read-token" }),
    gradle: () => ({ ofCommit: async () => undefined, ofWorkingTree: async () => undefined }),
    trees: { commit: async (_wc, sha) => tree(sha), working: () => tree("worktree") },
    npm: async () => ({ code: 0, stdout: "11.20.0\n", stderr: "" }),
    candidates: async () => ({ fixes: options.fixes ?? [vite()], incomplete: [], gaps: [], osvScannerVersion: "2.6.0" }),
    verify: async () => options.problems ?? [],
    staleScan: async () => ({ stale: false, lastSuccess: "2026-10-07T05:17:00Z", detail: "fresh" }),
    changedSince: async () => ["package.json", "package-lock.json"],
    journal: () => journal,
    writeFile: async (_wc, path, content) => {
      written.push(`${path}=${content}`);
    },
    revert: async (_wc, sha) => {
      reverted.push(sha);
      return ["package-lock.json"];
    },
  };
  return { context, deps, github, workspace, agentCalls, written, reverted, journal };
}

function leftPad(overrides: Partial<SecurityFix> = {}): SecurityFix {
  return vite({ name: "left-pad", from: "1.0.0", locations: ["node_modules/left-pad"], severity: "LOW", to: { version: "1.0.1", line: "1", aged: true, major: false, blockers: [] }, ...overrides });
}

async function batchPr(fixes: SecurityFix[], overrides: Partial<GitHubPullRequest> = {}): Promise<GitHubPullRequest> {
  const plan = await planFor(fixes, { lockfiles: new Map([["package-lock.json", JSON.parse(LOCK)]]), gradle: undefined, tagCommit: async () => undefined });
  return ownPr({ headRef: `secure-it/2026-10-05-${plan.topic}`, body: withMarker(RULES, `Fixes security findings.\n\n${planSection(plan)}`, { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }), ...overrides });
}

async function vitePr(overrides: Partial<GitHubPullRequest> = {}, fix = vite()): Promise<GitHubPullRequest> {
  return batchPr([fix], overrides);
}

describe("secure-it run", () => {
  it("batches non-major packages, verifies them, and opens one security PR carrying the plan", async () => {
    const h = harness({ fixes: [vite(), vite({ name: "left-pad", from: "1.0.0", locations: ["node_modules/left-pad"], severity: "LOW", to: { version: "1.0.1", line: "1", aged: true, major: false, blockers: [] } })] });
    const result = await secureIt(h.deps).run(h.context);
    expect(result).toMatchObject({ outcome: "published", pullRequest: "https://github.com/leanish/widget/pull/42" });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.agentCalls[0]).toMatchObject({ entrypoint: "secure-it", effort: "medium", input: { mode: "apply", today: "2026-10-07", moves: [{ name: "vite", to: "8.3.3", mechanism: "npm-direct" }, { name: "left-pad", to: "1.0.1" }] } });
    const pr = h.github.prs.get(42)!;
    expect(pr).toMatchObject({ headRef: "secure-it/2026-10-07-security", isDraft: true, title: "moving vite to 8.3.3" });
    expect(planOf(pr.body)?.moves.map((move) => move.name)).toEqual(["vite", "left-pad"]);
    expect(stateOf(pr.body)).toEqual({ head: PUSHED_SHA, base: BASE_SHA, adaptations: 0 });
  });

  it("leaves the same plan's open PR to its review tick, and reconciles one whose plan changed while it's still the tool's", async () => {
    const same = harness({ prs: [await vitePr()] });
    expect(await secureIt(same.deps).run(same.context)).toMatchObject({ outcome: "already-open", pullRequest: "https://github.com/leanish/widget/pull/7" });
    expect(same.agentCalls).toEqual([]);

    const changed = harness({ prs: [await vitePr({}, vite({ to: { version: "8.3.2", line: "8", aged: false, major: false, blockers: [] } }))] });
    changed.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(changed.deps).run(changed.context)).toMatchObject({ outcome: "updated", pullRequest: "https://github.com/leanish/widget/pull/7" });
    // The base merged in and the old plan's edits reverted before the agent applies the new one.
    expect(changed.reverted).toEqual([BASE_SHA]);
    expect(changed.agentCalls.map((call) => call.input["mode"])).toEqual(["apply"]);
    expect(planOf(changed.github.prs.get(7)!.body)?.moves[0]?.to).toBe("8.3.3");
  });

  it("stops reconciling when the default branch moved while the run computed its plan", async () => {
    const h = harness({ prs: [await vitePr({}, vite({ to: { version: "8.3.2", line: "8", aged: false, major: false, blockers: [] } }))] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    const prepare = h.workspace.prepareBranch.bind(h.workspace);
    h.workspace.prepareBranch = async (workingCopy, args) => prepare({ ...workingCopy, headSha: "f".repeat(40) }, args);
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "failed", detail: expect.stringContaining("the default branch moved while secure-it ran") });
    expect(h.reverted).toEqual([]);
    expect(h.agentCalls).toEqual([]);
  });

  it("doesn't take a PR someone else pushed to as covering the same plan", async () => {
    const h = harness({ prs: [await vitePr({ headSha: "9".repeat(40) })] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "published" });
    expect(h.github.prs.get(42)?.headRef).toBe("secure-it/2026-10-07-security");
  });

  it("opens a separate PR for a changed plan when someone else pushed to the package's PR", async () => {
    const older = vite({ to: { version: "8.3.2", line: "8", aged: false, major: false, blockers: [] } });
    const h = harness({ prs: [await vitePr({ headSha: "9".repeat(40), headRef: "secure-it/2026-10-07-security" }, older)] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "published" });
    expect(h.github.prs.get(42)?.headRef).toBe("secure-it/2026-10-07-security-2");
    expect(h.github.prs.get(7)?.headSha).toBe("9".repeat(40));
  });

  it("publishes nothing when verification fails, the agent can't apply, nothing is fixable, or the inventory is incomplete", async () => {
    const failing = harness({ problems: ["vite at node_modules/vite is 8.3.2, not 8.3.3"] });
    expect(await secureIt(failing.deps).run(failing.context)).toMatchObject({ outcome: "verification-failed", problems: ["vite at node_modules/vite is 8.3.2, not 8.3.3"] });
    expect(failing.github.calls.some((call) => call.startsWith("createPullRequest"))).toBe(false);

    const refused = harness({ answer: { outcome: "cannot-apply", summary: "the override would break the build" } });
    expect(await secureIt(refused.deps).run(refused.context)).toMatchObject({ outcome: "cannot-apply", summary: "the override would break the build" });

    const stuck = harness({ fixes: [vite({ to: undefined, problem: "no version above 8.3.1 fixes GHSA-x" })] });
    expect(await secureIt(stuck.deps).run(stuck.context)).toMatchObject({ outcome: "nothing-to-fix", waiting: ["vite@8.3.1: no version above 8.3.1 fixes GHSA-x"] });

    const incomplete = harness();
    const deps = { ...incomplete.deps, candidates: async () => ({ fixes: [vite()], incomplete: ["Gradle :runtimeClasspath couldn't resolve x"], gaps: [], osvScannerVersion: "2.6.0" }) };
    expect(await secureIt(deps).run(incomplete.context)).toMatchObject({ outcome: "incomplete", incomplete: ["Gradle :runtimeClasspath couldn't resolve x"] });
    expect(incomplete.agentCalls).toEqual([]);
  });

  it("expands an existing batch by reconcile-by-revert rather than opening another package PR", async () => {
    const h = harness({ prs: [await vitePr()], fixes: [vite(), leftPad()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "updated" });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.agentCalls[0]?.input).toMatchObject({ moves: [{ name: "vite" }, { name: "left-pad" }] });
    expect(h.workspace.publications).toHaveLength(1);
    expect(h.reverted).toEqual([BASE_SHA]);
    expect(planOf(h.github.prs.get(7)!.body)?.packages).toEqual(["npm|left-pad", "npm|vite"]);
  });

  it("reports blocked packages once when an identical batch is already open", async () => {
    const h = harness({ prs: [await batchPr([vite(), leftPad()])], fixes: [vite({ name: "blocked", severity: "CRITICAL", to: undefined, problem: "identity break" }), leftPad(), vite()] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "already-open", waiting: ["blocked@8.3.1: identity break"] });
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
  });

  it("recognises an identical owned suffixed batch", async () => {
    const h = harness({ prs: [await vitePr({ headRef: "secure-it/2026-10-05-security-2" })] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "already-open" });
    expect(h.agentCalls).toEqual([]);
  });

  it("keeps malware together and does not bypass its already-open group", async () => {
    const malware = vite({ malicious: true });
    const other = vite({ name: "left-pad", from: "1.0.0", locations: ["node_modules/left-pad"], to: { version: "1.0.1", line: "1", aged: true, major: false, blockers: [] } });
    const h = harness({ prs: [await vitePr({ headRef: "secure-it/2026-10-05-malware" }, malware)], fixes: [other, malware] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "already-open", packages: ["npm|vite"] });
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
  });

  it("checks exclusion support before the agent, and leaves publication untouched on old npm", async () => {
    const h = harness();
    const calls: ReadonlyArray<string>[] = [];
    const deps = { ...h.deps, npm: async (_context: ToolRunContext, args: ReadonlyArray<string>) => {
      calls.push(args);
      return { code: 0, stdout: "11.14.1", stderr: "" };
    } };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "failed", detail: expect.stringContaining("require npm >= 11.17.0 (min-release-age-exclude: vite)") });
    expect(calls).toEqual([["--version"]]);
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
  });

  it("passes a young target exclusion while preserving own scopes and the sandbox's age", async () => {
    const h = harness();
    const gate = await h.deps.gate(h.context);
    const deps = { ...h.deps, gate: async () => ({ ...gate, fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ time: { "8.3.3": "2026-10-06T00:00:00Z" }, versions: {} }), text: async () => "" }) }) };
    const install = (exclusions: ReadonlyArray<string>) => {
      if (!exclusions.includes("vite")) throw new Error("notarget: vite target is too young");
      if (exclusions.includes("other")) throw new Error("unplanned package was excluded");
    };
    expect(() => install([])).toThrow("notarget");
    const context = { ...h.context, releaseAgeExclude: ["@leanish/*"], agent: (async (call: { entrypoint: string; input: Record<string, unknown>; effort?: string }) => {
      install(call.input["npmAgeExclusions"] as ReadonlyArray<string>);
      return h.context.agent(call);
    }) as ToolRunContext["agent"] };
    expect(await secureIt(deps).run(context)).toMatchObject({ outcome: "published" });
    expect(h.agentCalls[0]?.input).toMatchObject({ npmAgeExclusions: ["@leanish/*", "vite"] });
    expect(context.releaseAgeDays).toBe(7);
    expect(context.releaseAgeExclude).toEqual(["@leanish/*"]);
  });

  it("needs no newer npm when every target is aged and there are no own scopes", async () => {
    const h = harness();
    const gate = await h.deps.gate(h.context);
    const deps = { ...h.deps, gate: async () => ({ ...gate, fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ time: { "8.3.3": "2026-09-01T00:00:00Z" }, versions: {} }), text: async () => "" }) }),
      npm: async () => { throw new Error("npm version must not be checked"); } };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "published" });
    expect(h.agentCalls[0]?.input["npmAgeExclusions"]).toEqual([]);
  });

  it("opens a routine batch and each major separately from the same base", async () => {
    const major = vite({ to: { version: "9.0.1", line: "9", aged: true, major: true, blockers: [] } });
    const h = harness({ fixes: [major, leftPad()] });
    const result = await secureIt(h.deps).run(h.context);
    expect(result).toMatchObject({ outcome: "completed", units: [{ topic: "security", outcome: "published" }, { topic: "vite-major", outcome: "published" }] });
    expect(h.agentCalls.map((call) => call.effort)).toEqual(["medium", "high"]);
    expect(h.workspace.publications.map((entry) => [entry.prepared.branch, entry.prepared.baseSha])).toEqual([
      ["secure-it/2026-10-07-security", BASE_SHA], ["secure-it/2026-10-07-vite-major", BASE_SHA],
    ]);
  });

  it("leaves an identical routine to review while still publishing a needed major", async () => {
    const major = vite({ to: { version: "9.0.1", line: "9", aged: true, major: true, blockers: [] } });
    const h = harness({ prs: [await batchPr([leftPad()])], fixes: [major, leftPad()] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({
      units: [{ topic: "security", outcome: "already-open" }, { topic: "vite-major", outcome: "published" }],
    });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.workspace.publications).toHaveLength(1);
    expect(h.github.prs.get(7)?.headSha).toBe(HEAD_SHA);
  });

  it("continues to a major when the routine fails, and leaves legacy package PRs to review", async () => {
    const previous = await vitePr();
    const legacy = { ...planOf(previous.body)!, kind: undefined, topic: "vite" };
    const h = harness({ prs: [{ ...previous, headRef: "secure-it/2026-10-05-vite", body: withMarker(RULES, planSection(legacy), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) }],
      fixes: [vite(), leftPad({ to: { version: "2.0.0", line: "2", aged: true, major: true, blockers: [] } })] });
    const deps = { ...h.deps, verify: async (input: VerifyInputs) => input.plan.kind === "routine" ? ["unattributed policy failure"] : [] };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ units: [{ outcome: "verification-failed" }, { topic: "left-pad-major", outcome: "published" }] });
    expect(h.github.prs.get(7)?.headSha).toBe(HEAD_SHA);
    expect(h.workspace.publications).toHaveLength(1);
  });

  it("combines npm, Gradle and action fixes in the routine", async () => {
    const action = vite({ ecosystem: "GitHub Actions", name: "actions/checkout", from: "v4.2.2", locations: [".github/workflows/ci.yml"], to: { version: "v4.2.3", line: "4", aged: true, major: false, blockers: [] } });
    const maven = vite({ ecosystem: "Maven", name: "g:lib", from: "1.0", locations: [":runtimeClasspath"], to: { version: "1.1", line: "1", aged: true, major: false, blockers: [] } });
    const inventory: GradleInventory = { schemaVersion: 1, tree: "base", builds: [{ build: ".", configurations: [{ id: ":runtimeClasspath", kind: "project", declared: [{ group: "g", name: "lib", version: "1.0", reason: undefined }], resolved: [{ group: "g", name: "lib", version: "1.0" }], unresolved: [], error: undefined }] }] };
    const h = harness({ fixes: [vite(), action, maven] });
    const env = await h.deps.gate(h.context);
    const deps = { ...h.deps, gradle: () => ({ ofCommit: async () => inventory, ofWorkingTree: async () => inventory }),
      gate: async () => ({ ...env, fetch: async (url: string) => url.includes("/git/ref/tags/")
        ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ object: { type: "commit", sha: HEAD_SHA } }), text: async () => "" }
        : env.fetch(url) }) };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "published", packages: ["GitHub Actions|actions/checkout", "Maven|g:lib", "npm|vite"] });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.workspace.publications).toHaveLength(1);
    expect(planOf(h.github.prs.get(42)!.body)?.moves.find((move) => move.name === "actions/checkout")?.commitSha).toBe(HEAD_SHA);
  });

  it("retries a failed batch from base once without named package groups and discloses them", async () => {
    const h = harness({ fixes: [vite(), leftPad()] });
    const sequence: string[] = [];
    const deps = { ...h.deps, verify: async (input: VerifyInputs) => {
      sequence.push(`verify:${input.plan.packages.join(",")}`);
      return input.plan.packages.includes("npm|left-pad") ? ["compare: new: left-pad@1.0.1: GHSA-new has no exception"] : [];
    }, revert: async (wc: WorkingCopy, sha: string) => {
      sequence.push(`revert:${sha}`);
      return h.deps.revert(wc, sha);
    } };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "published", packages: ["npm|vite"], leftOut: [{ moves: [{ name: "left-pad" }], problems: [expect.stringContaining("GHSA-new")] }] });
    expect(sequence).toEqual(["verify:npm|left-pad,npm|vite", `revert:${BASE_SHA}`, "verify:npm|vite"]);
    expect(h.agentCalls.map((call) => (call.input["moves"] as Array<{ name: string }>).map((move) => move.name))).toEqual([["vite", "left-pad"], ["vite"]]);
    const pr = h.github.prs.get(42)!;
    expect(pr.body).toContain("Left out after verification failed");
    expect(pr.body).toContain("left-pad");
    expect(planOf(pr.body)?.packages).toEqual(["npm|vite"]);
    expect(planOf(pr.body)?.leftOut?.[0]?.moves[0]?.name).toBe("left-pad");
    expect(h.workspace.publications).toHaveLength(1);
  });

  it("does not retry a second time or guess a parent for an induced/global failure", async () => {
    const h = harness({ fixes: [vite(), leftPad()] });
    let attempts = 0;
    const deps = { ...h.deps, verify: async () => ++attempts === 1 ? ["left-pad at node_modules/left-pad is 1.0.2, not 1.0.1"] : ["vite at node_modules/vite is 8.3.2, not 8.3.3"] };
    expect(await secureIt(deps).run(h.context)).toMatchObject({ outcome: "verification-failed", leftOut: [{ moves: [{ name: "left-pad" }] }], named: [{ moves: [{ name: "left-pad" }] }, { moves: [{ name: "vite" }] }] });
    expect(h.agentCalls).toHaveLength(2);
    expect(h.workspace.publications).toEqual([]);
    const unknown = harness({ fixes: [vite(), leftPad()], problems: ["compare: new: induced@1.0.1: GHSA-new has no exception"] });
    expect(await secureIt(unknown.deps).run(unknown.context)).toMatchObject({ outcome: "verification-failed", named: [{ moves: [] }] });
    expect(unknown.agentCalls).toHaveLength(1);
    expect(unknown.reverted).toEqual([]);
  });

  it("does not shrink malware after verification fails", async () => {
    const h = harness({ fixes: [vite({ malicious: true }), leftPad({ malicious: true })], problems: ["compare: new: left-pad@1.0.1: MAL-bad has no exception"] });
    expect(await secureIt(h.deps).run(h.context)).toMatchObject({ outcome: "verification-failed", topic: "malware", leftOut: [] });
    expect(h.agentCalls).toHaveLength(1);
    expect(h.workspace.publications).toEqual([]);
  });

  it("uses the major effort when a move is a major", async () => {
    const h = harness({ fixes: [vite({ to: { version: "9.0.1", line: "9", aged: true, major: true, blockers: [] } })] });
    await secureIt(h.deps).run(h.context);
    expect(h.agentCalls[0]?.effort).toBe("high");
  });
});

describe("secure-it review", () => {
  const NEW_BASE = "f".repeat(40);

  it("recomputes on the moved base: retires a PR whose fix the base already has, before any agent", async () => {
    const fixedOnBase = harness({ prs: [await vitePr()], baseSha: NEW_BASE, fixes: [] });
    fixedOnBase.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(fixedOnBase.deps).review(fixedOnBase.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "retired" }] });
    expect(fixedOnBase.github.prs.get(7)?.state).toBe("closed");
    expect(fixedOnBase.agentCalls).toEqual([]);

    // Fixes remain on the new base, but the re-applied edit doesn't verify: an error, never a quiet retirement.
    const lost = harness({ prs: [await vitePr()], baseSha: NEW_BASE, problems: ["vite at node_modules/vite is 8.3.1, not 8.3.3"] });
    lost.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(lost.deps).review(lost.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "error", detail: expect.stringContaining("after merging the default branch") }] });
    expect(lost.github.prs.get(7)?.state).toBe("open");

    const merged = harness({ prs: [await vitePr()], baseSha: NEW_BASE });
    merged.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(merged.deps).review(merged.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "rebased" }] });
    expect(stateOf(merged.github.prs.get(7)!.body)).toEqual({ head: PUSHED_SHA, base: NEW_BASE, adaptations: 0 });
    expect(merged.agentCalls).toEqual([]);
  });

  it("reconciles a PR whose plan the moved base changed: reverted to the base, the new plan applied and recorded", async () => {
    const h = harness({ prs: [await vitePr()], baseSha: NEW_BASE, fixes: [vite({ to: { version: "8.3.4", line: "8", aged: true, major: false, blockers: [] } })] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    h.workspace.setPrepareConflict("secure-it/2026-10-05-security");
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "rebased" }] });
    // Reverting resolves the conflicts too: nothing is taken file by file, and the agent applies on the base.
    expect(h.reverted).toEqual([NEW_BASE]);
    expect(h.written).toEqual([]);
    expect(h.agentCalls.map((call) => call.input["mode"])).toEqual(["apply"]);
    expect(h.agentCalls[0]?.input["npmAgeExclusions"]).toEqual(["vite"]);
    const pr = h.github.prs.get(7)!;
    expect(pr.title).toBe("moving vite to 8.3.3");
    expect(planOf(pr.body)?.moves[0]?.to).toBe("8.3.4");
    expect(pr.body.match(/What secure-it moved/g)).toHaveLength(1);
  });

  it("takes the base's side of a conflicted lockfile and has the agent re-apply, or resolve code conflicts", async () => {
    const h = harness({ prs: [await vitePr()], baseSha: NEW_BASE });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    h.workspace.setPrepareConflict("secure-it/2026-10-05-security");
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "rebased" }] });
    expect(h.written).toEqual([`package-lock.json=${LOCK}`]);
    expect(h.agentCalls.map((call) => call.input["mode"])).toEqual(["apply"]);
    expect(h.agentCalls[0]?.input["npmAgeExclusions"]).toEqual(["vite"]);
  });

  it("recomputes the whole routine on a moved base, adding new packages and retiring old fixes", async () => {
    const h = harness({ prs: [await vitePr()], baseSha: NEW_BASE, fixes: [leftPad()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(h.reverted).toEqual([NEW_BASE]);
    expect(planOf(h.github.prs.get(7)!.body)?.packages).toEqual(["npm|left-pad"]);
    expect(h.agentCalls[0]?.input).toMatchObject({ moves: [{ name: "left-pad" }] });
  });

  it("reviews only a major's package and retires it when only non-major work remains", async () => {
    const major = vite({ to: { version: "9.0.1", line: "9", aged: true, major: true, blockers: [] } });
    const h = harness({ prs: [await vitePr({}, major)], baseSha: NEW_BASE, fixes: [major, leftPad()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-vite-major", HEAD_SHA);
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(planOf(h.github.prs.get(7)!.body)?.packages).toEqual(["npm|vite"]);
    const retired = harness({ prs: [await vitePr({}, major)], baseSha: NEW_BASE, fixes: [vite(), leftPad()] });
    retired.workspace.setRemoteHead("secure-it/2026-10-05-vite-major", HEAD_SHA);
    expect(await secureIt(retired.deps).review(retired.context)).toMatchObject({ reviewed: [{ outcome: "retired" }] });
    expect(retired.agentCalls).toEqual([]);
  });

  it("retries a rebased routine and records omissions in its updated plan", async () => {
    const h = harness({ prs: [await vitePr()], baseSha: NEW_BASE, fixes: [vite(), leftPad()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    const deps = { ...h.deps, verify: async (input: VerifyInputs) => input.plan.packages.includes("npm|left-pad") ? ["left-pad at node_modules/left-pad is gone, not 1.0.1"] : [] };
    expect(await secureIt(deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }], notes: [{ leftOut: [{ moves: [{ name: "left-pad" }] }] }] });
    expect(h.agentCalls).toHaveLength(2);
    expect(h.reverted).toEqual([NEW_BASE, NEW_BASE]);
    expect(planOf(h.github.prs.get(7)!.body)?.leftOut?.[0]?.moves[0]?.name).toBe("left-pad");
  });

  it("retires malware when it is gone rather than turning that PR into an ordinary batch", async () => {
    const h = harness({ prs: [await vitePr({}, vite({ malicious: true }))], baseSha: NEW_BASE, fixes: [leftPad()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-malware", HEAD_SHA);
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "retired" }] });
    expect(h.agentCalls).toEqual([]);
    expect(h.workspace.publications).toEqual([]);
  });

  it("retains package scope when reviewing a legacy plan", async () => {
    const pr = await vitePr();
    const legacy = { ...planOf(pr.body)!, kind: undefined, topic: "vite" };
    const h = harness({ prs: [{ ...pr, headRef: "secure-it/2026-10-05-vite", body: withMarker(RULES, planSection(legacy), { head: HEAD_SHA, base: BASE_SHA, adaptations: 0 }) }], baseSha: NEW_BASE, fixes: [vite(), leftPad()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-vite", HEAD_SHA);
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ outcome: "rebased" }] });
    expect(planOf(h.github.prs.get(7)!.body)?.packages).toEqual(["npm|vite"]);
    expect(planOf(h.github.prs.get(7)!.body)?.kind).toBeUndefined();
  });

  it("has the agent adapt a failing PR, verifies the result, and records the attempt", async () => {
    const h = harness({ prs: [await vitePr()] });
    h.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    h.github.checks = { ...RED, statuses: [{ context: "legacy", state: "error" }] };
    expect(await secureIt(h.deps).review(h.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "adapted" }] });
    expect(h.agentCalls[0]).toMatchObject({ input: { mode: "adapt", failingChecks: ["check", "legacy"], npmAgeExclusions: ["vite"] } });
    expect(stateOf(h.github.prs.get(7)!.body)?.adaptations).toBe(1);

    const failing = harness({ prs: [await vitePr()], problems: ["compare: new: vite@8.3.3: GHSA-new has no exception"] });
    failing.workspace.setRemoteHead("secure-it/2026-10-05-security", HEAD_SHA);
    failing.github.checks = RED;
    expect(await secureIt(failing.deps).review(failing.context)).toMatchObject({ reviewed: [{ number: 7, outcome: "error", detail: expect.stringContaining("doesn't verify") }] });
    expect(stateOf(failing.github.prs.get(7)!.body)?.adaptations).toBe(1);
  });
});
