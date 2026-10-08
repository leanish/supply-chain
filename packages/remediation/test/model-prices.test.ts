import { describe, expect, it } from "vitest";

import { estimateApiCost } from "../../agent-basics/src/usage/api-cost.ts";
import type { SkillUsage, TokenUsage } from "../../agent-basics/src/usage/skill-usage.ts";
import { DEFAULT_MODEL_PRICES } from "../src/model-prices.ts";

function measuredUsage(model = "gpt-6.1-sol", input = 200_000): SkillUsage {
  const tokens: TokenUsage = { input, cachedInput: 100_000, cacheWriteInput: 0, output: 1_000, reasoningOutput: 100, total: input + 1_000 };
  return {
    codingAgent: "codex", durationMs: 1, synthetic: false, measurement: "complete", tokens,
    models: [{ model, tokens, requests: [{ tokens, exact: true }] }],
    quota: { status: "unavailable" }, gaps: [],
  };
}

describe("default model prices", () => {
  it.each([
    ["gpt-6.1-sol", 2, 0.10, 10], ["gpt-6-sol", 2, 0.20, 10],
    ["gpt-6-astra", 10, 1, 50], ["gpt-6-luna", 0.10, 0.01, 0.50],
    ["gpt-5.6-sol", 4, 0.40, 20], ["gpt-5.6-terra", 2, 0.20, 12],
    ["gpt-5.6-luna", 0.20, 0.02, 1.20],
  ] as const)("records the published Standard rates and provenance for %s", (model, input, cached, output) => {
    expect(DEFAULT_MODEL_PRICES.get(model)).toEqual({
      inputPerMTok: input, cachedInputPerMTok: cached, cacheWritePerMTok: input * 1.25, outputPerMTok: output,
      longContextThresholdTokens: 272_000,
      longContext: { inputPerMTok: input * 2, cachedInputPerMTok: cached * 2, cacheWritePerMTok: input * 2.5, outputPerMTok: output * 1.5 },
      basis: "OpenAI Standard API equivalent, request context tiers, no regional premium",
      source: `https://developers.openai.com/api/docs/models/${model}`, asOf: "2026-10-08",
    });
  });

  it("prices the actual Sol model, cached tokens and reasoning without double counting", () => {
    expect(estimateApiCost(measuredUsage(), DEFAULT_MODEL_PRICES, new Date("2026-10-08"))).toMatchObject({ usd: 0.22, complete: true, gaps: [] });
  });

  it("applies long-context rates per request, not per run's aggregate", () => {
    expect(estimateApiCost(measuredUsage("gpt-6.1-sol", 273_000), DEFAULT_MODEL_PRICES, new Date("2026-10-08"))).toMatchObject({ usd: 0.727, complete: true });
    const usage = measuredUsage();
    const requests = [usage.models[0]!.requests[0]!, usage.models[0]!.requests[0]!];
    expect(estimateApiCost({ ...usage, models: [{ ...usage.models[0]!, requests }] }, DEFAULT_MODEL_PRICES, new Date("2026-10-08")).usd).toBe(0.44);
  });

  it("keeps unknown models and stale pricing explicit", () => {
    expect(estimateApiCost(measuredUsage("unpriced-model"), DEFAULT_MODEL_PRICES, new Date("2026-10-08"))).toMatchObject({ usd: null, gaps: ["no price for unpriced-model"] });
    expect(estimateApiCost(measuredUsage(), DEFAULT_MODEL_PRICES, new Date("2027-02-01")).gaps.join(" ")).toContain("2026-10-08");
  });
});
