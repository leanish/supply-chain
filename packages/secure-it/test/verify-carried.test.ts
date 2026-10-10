import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCompare, type GateEnvironment } from "../../ci/src/gate.ts";
import type { Tree } from "../../ci/src/tree.ts";
import type { ChangePlan } from "../src/plan.ts";
import { verifyPlan } from "../src/verify.ts";

vi.mock("../../ci/src/gate.ts", async (load) => ({ ...await load<typeof import("../../ci/src/gate.ts")>(), runCompare: vi.fn() }));

const tree = (id: string, files: Record<string, string> = {}): Tree => ({ id, read: async (path) => files[path], list: async () => [] });
/** A lockfile with the carrier still at 1.0.0: verification reads it without reaching the registry. */
const LOCK = { "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "app", dependencies: { carrier: "^1.0.0" } }, "node_modules/carrier": { version: "1.0.0" } } }) };
const env: GateEnvironment = { run: async () => { throw new Error("no process expected"); }, fetch: async () => { throw new Error("no network expected"); }, now: () => new Date(), osvScanner: "osv", githubToken: undefined };

beforeEach(() => {
  vi.mocked(runCompare).mockReset();
});

describe("verifying what a parent move carries", () => {
  it("fails when a replacement coordinate keeps the advisory the move carried away", async () => {
    vi.mocked(runCompare).mockResolvedValue({
      failures: [], warnings: [], notes: [], gaps: [], osvScannerVersion: "2.6.0", configText: undefined, cooldown: { evaluated: true, releaseAgeDays: 7, held: [] },
      // okio-jvm reports the CVE that groups with okio's GHSA.
      group: (id) => (id === "GHSA-okio" || id === "CVE-2023-3635" ? "GHSA-okio" : id),
      headFindings: [{ ecosystem: "Maven", name: "com.squareup.okio:okio-jvm", version: "3.2.0", advisory: "GHSA-okio", ids: ["CVE-2023-3635"], malicious: false, summary: undefined, severity: undefined, locations: [":runtimeClasspath"] }],
    });
    const plan: ChangePlan = { topic: "security", malware: false, packages: ["Maven|com.squareup.okhttp3:okhttp"], severity: "MODERATE", moves: [{
      ecosystem: "Maven", name: "com.squareup.okhttp3:okhttp", from: "4.9.3", to: "4.11.0", mechanism: "gradle-declared", locations: [":runtimeClasspath"], advisories: [],
      major: false, commitSha: undefined, declaredAs: undefined,
      carries: [{ name: "com.squareup.okio:okio", from: ["2.8.0"], to: [], locations: [":runtimeClasspath"], advisories: ["GHSA-okio"] }],
    }] };
    const problems = await verifyPlan({ plan, base: tree("b".repeat(40)), head: tree("worktree"), env, gradle: {}, reference: undefined, changedFiles: ["build.gradle.kts"] });
    expect(problems).toContain("com.squareup.okio:okio-jvm@3.2.0 still has GHSA-okio, which moving com.squareup.okhttp3:okhttp was to fix");
  });

  it("keeps npm's package identity: the carrier's own unfixable advisory sharing the child's group isn't a carried leftover", async () => {
    vi.mocked(runCompare).mockResolvedValue({
      failures: [], warnings: [], notes: [], gaps: [], osvScannerVersion: "2.6.0", configText: undefined, cooldown: { evaluated: true, releaseAgeDays: 7, held: [] },
      group: (id) => id,
      headFindings: [{ ecosystem: "npm", name: "carrier", version: "1.1.0", advisory: "GHSA-shared", ids: ["GHSA-shared"], malicious: false, summary: undefined, severity: undefined, locations: ["node_modules/carrier"] }],
    });
    const plan: ChangePlan = { topic: "security", malware: false, packages: ["npm|carrier"], severity: "HIGH", moves: [{
      ecosystem: "npm", name: "carrier", from: "1.0.0", to: "1.1.0", mechanism: "npm-direct", locations: ["node_modules/carrier"], advisories: [],
      major: false, commitSha: undefined, declaredAs: undefined,
      carries: [{ name: "brace", from: ["5.0.9"], to: ["5.0.12"], locations: ["node_modules/carrier/node_modules/brace"], advisories: ["GHSA-shared"] }],
    }] };
    const problems = await verifyPlan({ plan, base: tree("b".repeat(40), LOCK), head: tree("worktree", LOCK), env, gradle: {}, reference: undefined, changedFiles: ["package.json", "package-lock.json"] });
    expect(problems.filter((problem) => problem.includes("GHSA-shared"))).toEqual([]);
  });
});
