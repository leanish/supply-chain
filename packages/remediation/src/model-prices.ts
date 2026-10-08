/** Dated Standard API-equivalent prices for the tools' current Codex models. */
import { type ModelPrice, parseModelPrices } from "../../agent-basics/src/usage/model-prices.ts";

// USD per million tokens, checked 2026-10-08 against OpenAI's official pricing:
// https://developers.openai.com/api/docs/pricing
// Retained models' individual /api/docs/models/<id> pages supply their rates.
// >272K input tokens prices the whole request at 2x input/cache and 1.5x output.
// This assumes Standard, no regional premium; it is not a Codex subscription bill.
function standard(model: string, input: number, cached: number, output: number): ModelPrice {
  return {
    inputPerMTok: input,
    cachedInputPerMTok: cached,
    cacheWritePerMTok: input * 1.25,
    outputPerMTok: output,
    longContextThresholdTokens: 272_000,
    longContext: {
      inputPerMTok: input * 2,
      cachedInputPerMTok: cached * 2,
      cacheWritePerMTok: input * 2.5,
      outputPerMTok: output * 1.5,
    },
    basis: "OpenAI Standard API equivalent, request context tiers, no regional premium",
    source: `https://developers.openai.com/api/docs/models/${model}`,
    asOf: "2026-10-08",
  };
}

export const DEFAULT_MODEL_PRICES = parseModelPrices({
  "gpt-6.1-sol": standard("gpt-6.1-sol", 2, 0.10, 10),
  "gpt-6-sol": standard("gpt-6-sol", 2, 0.20, 10),
  "gpt-6-astra": standard("gpt-6-astra", 10, 1, 50),
  "gpt-6-luna": standard("gpt-6-luna", 0.10, 0.01, 0.50),
  "gpt-5.6-sol": standard("gpt-5.6-sol", 4, 0.40, 20),
  "gpt-5.6-terra": standard("gpt-5.6-terra", 2, 0.20, 12),
  "gpt-5.6-luna": standard("gpt-5.6-luna", 0.20, 0.02, 1.20),
}, "built-in OpenAI prices");
