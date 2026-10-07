import { describe, expect, it } from "vitest";

import { planOf, planSection, withPlanSection } from "../src/plan-block.ts";
import type { ChangePlan, PlannedMove } from "../src/plan.ts";
import { retryWithoutNamed } from "../src/retry.ts";

function move(name: string, from = "1.0.0"): PlannedMove {
  return { ecosystem: "npm", name, from, to: "1.0.1", mechanism: "npm-lock", locations: [`node_modules/${name}`], advisories: ["GHSA-a"], major: false, commitSha: undefined, declaredAs: undefined };
}

function plan(...moves: PlannedMove[]): ChangePlan {
  return { kind: "routine", topic: "security", malware: false, packages: [...new Set(moves.map((entry) => `${entry.ecosystem}|${entry.name}`))].sort(), moves, severity: "HIGH" };
}

describe("batch retry", () => {
  it("drops all copies of a named package rather than silently publishing only some", () => {
    const original = plan(move("lib"), move("lib", "0.9.0"), move("other"));
    const retry = retryWithoutNamed(original, ["compare: new: lib@1.0.1: GHSA-new has no exception"]);
    expect(retry.plan?.packages).toEqual(["npm|other"]);
    expect(retry.leftOut[0]?.moves.map((entry) => entry.from)).toEqual(["1.0.0", "0.9.0"]);
    expect(original.moves).toHaveLength(3);
  });

  it("matches scoped names and regex characters exactly, not package prefixes or filenames", () => {
    const original = plan(move("@own/lib.plus"), move("@own/lib"), move("lib"));
    const retry = retryWithoutNamed(original, ["compare: @own/lib.plus@1.0.1 has an identity break"]);
    expect(retry.plan?.packages).toEqual(["npm|@own/lib", "npm|lib"]);
    expect(retryWithoutNamed(original, ["the edit changed src/lib.ts"]).plan).toBeUndefined();
  });

  it("does not reduce a batch if any problem is global or names an unplanned induced version", () => {
    const original = plan(move("lib"), move("other"));
    const retry = retryWithoutNamed(original, ["lib at node_modules/lib is gone, not 1.0.1", "compare: induced@2.0.0 has a new advisory"]);
    expect(retry.plan).toBeUndefined();
    expect(retry.named.map((entry) => entry.moves.length)).toEqual([1, 0]);
    expect(retry.leftOut).toEqual([]);
  });

  it("does not retry an empty remainder, malware or a major", () => {
    const original = plan(move("lib"));
    const problems = ["lib at node_modules/lib is gone, not 1.0.1"];
    expect(retryWithoutNamed(original, problems).plan).toBeUndefined();
    expect(retryWithoutNamed({ ...original, kind: "malware", malware: true }, problems).leftOut).toEqual([]);
    expect(retryWithoutNamed({ ...original, kind: "major" }, problems).leftOut).toEqual([]);
  });

  it("names Gradle declaration failures and does not confuse npm with Maven's name suffix", () => {
    const maven = { ...move("g:lib"), ecosystem: "Maven" as const, mechanism: "gradle-declared" as const, locations: [":runtimeClasspath"] };
    const original = plan(maven, move("lib"));
    expect(retryWithoutNamed(original, [":runtimeClasspath declares g:lib nowhere, not 1.0.1"]).plan?.packages).toEqual(["npm|lib"]);
    expect(retryWithoutNamed(original, ["compare: g:lib@1.0.1 has a new advisory"]).plan?.packages).toEqual(["npm|lib"]);
  });

  it("persists and replaces the omissions in the PR-facing section", () => {
    const reduced = retryWithoutNamed(plan(move("lib"), move("other")), ["lib at node_modules/lib is gone, not 1.0.1"]).plan!;
    const body = withPlanSection("Description.", reduced);
    expect(planOf(body)).toEqual(reduced);
    expect(body).toContain("Left out after verification failed");
    expect(body).toContain("lib at node_modules/lib");
    const refreshed = withPlanSection(body, plan(move("other")));
    expect(refreshed).not.toContain("Left out after verification failed");
    expect(refreshed.match(/What secure-it moved/g)).toHaveLength(1);
    expect(planOf(planSection({ ...reduced, kind: "invalid" as never }))).toBeUndefined();
  });
});
