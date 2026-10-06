// Copied from leanish/leanish-development core/runtime/test/unit/api-cost.test.ts at e4f8a1e; see PROVENANCE.md.
import { describe, expect, it } from "vitest";

import { estimateApiCost } from "../src/usage/api-cost.ts";
import { parseModelPrices } from "../src/usage/model-prices.ts";
import { type RequestUsage, type SkillUsage, sumTokens, type TokenUsage, UNATTRIBUTED_MODEL } from "../src/usage/skill-usage.ts";

/** Synthetic prices (USD per million tokens), not any provider's. */
const PRICES = parseModelPrices(
  {
    "model-a": {
      inputPerMTok: 2,
      cachedInputPerMTok: 0.5,
      cacheWritePerMTok: 2.5,
      outputPerMTok: 10,
      basis: "standard, short context",
      source: "test fixture",
      asOf: "2026-01-01",
    },
    "model-long": {
      inputPerMTok: 1,
      cachedInputPerMTok: 0.1,
      cacheWritePerMTok: 1,
      outputPerMTok: 4,
      basis: "standard",
      longContextThresholdTokens: 1000,
      longContext: { inputPerMTok: 2, cachedInputPerMTok: 0.2, cacheWritePerMTok: 2, outputPerMTok: 8 },
      source: "test fixture",
      asOf: "2026-01-01",
    },
    "model-threshold-only": {
      inputPerMTok: 1,
      cachedInputPerMTok: 0.1,
      cacheWritePerMTok: 1,
      outputPerMTok: 4,
      basis: "short context only",
      longContextThresholdTokens: 1000,
      source: "test fixture",
      asOf: "2026-01-01",
    },
  },
  "test",
);

function tokens(input: number, output: number, extra: Partial<TokenUsage> = {}): TokenUsage {
  return { input, cachedInput: 0, cacheWriteInput: 0, output, reasoningOutput: 0, total: input + output, ...extra };
}

function usage(models: Record<string, ReadonlyArray<RequestUsage>>, overrides: Partial<SkillUsage> = {}): SkillUsage {
  const entries = Object.entries(models).map(([model, requests]) => ({
    model,
    tokens: sumTokens(requests.map((request) => request.tokens)),
    requests,
  }));
  return {
    codingAgent: "codex",
    durationMs: 1,
    synthetic: false,
    measurement: "complete",
    tokens: sumTokens(entries.map((entry) => entry.tokens)),
    models: entries,
    quota: { status: "unavailable" },
    gaps: [],
    ...overrides,
  };
}

const exact = (t: TokenUsage): RequestUsage => ({ tokens: t, exact: true });

/** The fixture prices are dated 2026-01-01; estimates in these tests are made two weeks later. */
const NOW = new Date("2026-01-15T12:00:00Z");

describe("estimateApiCost", () => {
  it("prices uncached input, cached input, cache writes and output separately", () => {
    const estimate = estimateApiCost(
      usage({ "model-a": [exact(tokens(1_000_000, 50_000, { cachedInput: 200_000, cacheWriteInput: 100_000, reasoningOutput: 20_000 }))] }),
      PRICES,
      NOW,
    );
    // 0.7M × 2 + 0.2M × 0.5 + 0.1M × 2.5 + 0.05M × 10 (reasoning is inside output)
    expect(estimate).toEqual({
      usd: 2.25,
      complete: true,
      byModel: [{ model: "model-a", usd: 2.25, basis: "standard, short context", source: "test fixture", asOf: "2026-01-01" }],
      gaps: [],
    });
  });

  it("uses the long-context prices for a request over the threshold", () => {
    const estimate = estimateApiCost(usage({ "model-long": [exact(tokens(1000, 100_000)), exact(tokens(500_000, 0))] }), PRICES, NOW);
    // 1000 × 1 + 100k × 4, then 500k × 2 (long context)
    expect(estimate.usd).toBeCloseTo(0.001 + 0.4 + 1, 6);
    expect(estimate.byModel[0]?.longContextRequests).toBe(1);
  });

  it("can't price a request over the threshold without long-context prices", () => {
    const estimate = estimateApiCost(usage({ "model-threshold-only": [exact(tokens(2000, 10))] }), PRICES, NOW);
    expect(estimate).toMatchObject({ usd: null, complete: false });
    expect(estimate.gaps[0]).toMatch(/over the 1000-token long-context threshold and no long-context prices/);
  });

  it("can't split a folded entry over the threshold, but prices one under it", () => {
    const folded = estimateApiCost(usage({ "model-long": [{ tokens: tokens(2000, 10), exact: false }] }), PRICES, NOW);
    expect(folded.usd).toBeNull();
    expect(folded.gaps[0]).toMatch(/folding several requests/);
    expect(estimateApiCost(usage({ "model-long": [{ tokens: tokens(900, 10), exact: false }] }), PRICES, NOW).usd).toBeCloseTo(0.00094, 8);
  });

  it("leaves the total open when one model has no price, keeping the priced ones", () => {
    const estimate = estimateApiCost(usage({ "model-a": [exact(tokens(1_000_000, 0))], "model-x": [exact(tokens(1, 1))] }), PRICES, NOW);
    expect(estimate.usd).toBeNull();
    expect(estimate.complete).toBe(false);
    expect(estimate.byModel.map((entry) => [entry.model, entry.usd])).toEqual([
      ["model-a", 2],
      ["model-x", null],
    ]);
    expect(estimate.gaps).toEqual(["no price for model-x"]);
  });

  it("can't price tokens tied to no model", () => {
    const estimate = estimateApiCost(usage({ "model-a": [exact(tokens(1_000_000, 0))], [UNATTRIBUTED_MODEL]: [exact(tokens(40, 2))] }), PRICES, NOW);
    expect(estimate).toMatchObject({ usd: null, complete: false });
    expect(estimate.gaps).toEqual(["42 tokens aren't tied to a model, so they can't be priced"]);
  });

  it("is a gap without prices, and without token counts", () => {
    expect(estimateApiCost(usage({ "model-a": [exact(tokens(1, 1))] }), undefined)).toMatchObject({
      usd: null,
      gaps: ["no model prices configured (AGENT_RUNTIME_MODEL_PRICES_FILE unset)"],
    });
    const { tokens: _dropped, ...withoutTokens } = usage({});
    expect(estimateApiCost({ ...withoutTokens, measurement: "partial" }, PRICES, NOW)).toMatchObject({ usd: null, complete: false });
  });

  it("rejects token counts that don't add up", () => {
    const estimate = estimateApiCost(usage({ "model-a": [exact(tokens(10, 1, { cachedInput: 8, cacheWriteInput: 5 }))] }), PRICES, NOW);
    expect(estimate.usd).toBeNull();
    expect(estimate.gaps[0]).toMatch(/more cached and cache-write input tokens than input tokens/);
    expect(estimateApiCost(usage({ "model-a": [exact(tokens(10, 1, { reasoningOutput: 2 }))] }), PRICES, NOW).gaps[0]).toMatch(
      /more reasoning tokens than output tokens/,
    );
  });

  it("still prices with prices checked over 90 days before the run, saying so", () => {
    const run = usage({ "model-a": [exact(tokens(1_000_000, 0))] });
    // 2026-01-01 to 2026-04-01 is 90 days: still fresh.
    expect(estimateApiCost(run, PRICES, new Date("2026-04-01T23:59:00Z"))).toMatchObject({ usd: 2, complete: true, gaps: [] });
    expect(estimateApiCost(run, PRICES, new Date("2026-04-02T00:01:00Z"))).toMatchObject({
      usd: 2,
      complete: true,
      gaps: ["model-a: prices checked on 2026-01-01, over 90 days ago"],
    });
  });

  it("costs nothing for a synthetic run or one without provider calls; a partial measurement isn't complete", () => {
    expect(estimateApiCost(usage({}, { synthetic: true }), undefined)).toEqual({ usd: 0, complete: true, byModel: [], gaps: [] });
    expect(estimateApiCost(usage({}), undefined)).toEqual({ usd: 0, complete: true, byModel: [], gaps: [] });
    expect(estimateApiCost(usage({ "model-a": [exact(tokens(1_000_000, 0))] }, { measurement: "partial" }), PRICES, NOW)).toMatchObject({
      usd: 2,
      complete: false,
    });
  });
});
