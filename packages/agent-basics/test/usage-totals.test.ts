// Copied from leanish/leanish-development core/runtime/test/unit/usage-totals.test.ts at e4f8a1e; see PROVENANCE.md.
import { describe, expect, it } from "vitest";

import type { SkillUsageRecord } from "../src/usage/skill-usage-record.ts";
import { ZERO_TOKENS } from "../src/usage/skill-usage.ts";
import { totalSkillUsage } from "../src/usage/usage-totals.ts";

function record(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    invocationId: "id",
    entrypoint: "ask",
    outcome: "succeeded",
    codingAgent: "codex",
    durationMs: 10,
    synthetic: false,
    measurement: "complete",
    tokens: { ...ZERO_TOKENS, input: 100, output: 10, total: 110 },
    models: [],
    quota: { status: "unavailable" },
    apiCost: { usd: 0.5, complete: true, byModel: [{ model: "m", usd: 0.5, basis: "standard" }], gaps: [] },
    gaps: [],
    ...overrides,
  };
}

describe("totalSkillUsage", () => {
  it("reports no total while a skill run is in flight, keeping the finished ones as lower bounds", () => {
    const totals = totalSkillUsage([record()], 1);
    expect(totals).toMatchObject({
      skillRuns: 1,
      skillRunsInProgress: 1,
      tokens: null,
      estimatedApiCostUsd: null,
      tokensLowerBound: { total: 110 },
      estimatedApiCostUsdLowerBound: 0.5,
    });
    expect(totals.gaps).toEqual(["1 skill run(s) were still in progress, so their usage is unknown"]);
    expect(totalSkillUsage([], 1)).toMatchObject({ tokens: null, estimatedApiCostUsd: null, tokensLowerBound: { total: 0 } });
  });

  it("is zero tokens and zero cost without skill runs", () => {
    expect(totalSkillUsage([])).toEqual({
      skillRuns: 0,
      skillRunsInProgress: 0,
      tokens: ZERO_TOKENS,
      tokensLowerBound: ZERO_TOKENS,
      estimatedApiCostUsd: 0,
      estimatedApiCostUsdLowerBound: 0,
      pricingBases: [],
      gaps: [],
    });
  });

  it("adds complete runs", () => {
    const totals = totalSkillUsage([record(), record()]);
    expect(totals.tokens?.total).toBe(220);
    expect(totals.estimatedApiCostUsd).toBe(1);
    expect(totals.pricingBases).toEqual(["standard"]);
  });

  it("reports no total, only a lower bound, when any part is unknown", () => {
    const { tokens: _unmeasured, ...withoutTokens } = record({
      measurement: "partial",
      apiCost: { usd: null, complete: false, byModel: [], gaps: [] },
    });
    const totals = totalSkillUsage([
      record(),
      record({ measurement: "partial", apiCost: { usd: 0.25, complete: false, byModel: [], gaps: [] } }),
      withoutTokens,
    ]);
    expect(totals.tokens).toBeNull();
    expect(totals.tokensLowerBound.total).toBe(220);
    expect(totals.estimatedApiCostUsd).toBeNull();
    expect(totals.estimatedApiCostUsdLowerBound).toBe(0.75);
    expect(totals.gaps).toEqual([
      "2 of 3 skill run(s) have missing or partial token counts",
      "2 of 3 skill run(s) have a missing or partial cost estimate",
    ]);
  });
});
