import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCompare, type GateEnvironment } from "../../ci/src/gate.ts";
import type { Tree } from "../../ci/src/tree.ts";
import type { ChangePlan } from "../src/plan.ts";
import { verifyPlan } from "../src/verify.ts";

vi.mock("../../ci/src/gate.ts", async (load) => ({ ...await load<typeof import("../../ci/src/gate.ts")>(), runCompare: vi.fn() }));

const tree = (id: string): Tree => ({ id, read: async () => undefined, list: async () => [] });
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
});
