// Copied from leanish/leanish-development core/runtime/src/usage/api-cost.ts at e4f8a1e; see PROVENANCE.md.
import { MODEL_PRICES_FILE_ENV, type ModelPrice, type ModelPriceTable, type TokenPrices } from "./model-prices.ts";
import { type RequestUsage, type SkillUsage, type TokenUsage, UNATTRIBUTED_MODEL } from "./skill-usage.ts";

/**
 * What a run's measured tokens would have cost through the provider's API at
 * the configured list prices — an estimate, not a bill (a subscription run is
 * not charged per token). Per request:
 *
 *   ((input − cachedInput − cacheWriteInput) × input price
 *     + cachedInput × cached-input price + cacheWriteInput × cache-write price
 *     + output × output price) / 1 000 000
 *
 * with reasoning tokens inside `output`. `usd` is null when any model or
 * request can't be priced; `complete` says whether it covers the whole run
 * (every model priced and the token measurement complete). A synthetic run
 * costs 0. Prices checked more than `PRICES_STALE_AFTER_DAYS` before `now`
 * still price the run, with a gap naming their date.
 */
export interface ApiCostEstimate {
  readonly usd: number | null;
  readonly complete: boolean;
  readonly byModel: ReadonlyArray<ModelCostEstimate>;
  readonly gaps: ReadonlyArray<string>;
}

export interface ModelCostEstimate {
  readonly model: string;
  readonly usd: number | null;
  /** The price entry used: what it assumes, where it comes from and when it was checked. */
  readonly basis?: string;
  readonly source?: string;
  readonly asOf?: string;
  /** Requests priced at the long-context rates. */
  readonly longContextRequests?: number;
}

/** Prices last checked longer ago than this still estimate, with a gap saying so. */
export const PRICES_STALE_AFTER_DAYS = 90;

/** `now` dates the estimate, for the prices' staleness check. */
export function estimateApiCost(usage: SkillUsage, prices: ModelPriceTable | undefined, now: Date = new Date()): ApiCostEstimate {
  if (usage.synthetic) return { usd: 0, complete: true, byModel: [], gaps: [] };
  if (usage.tokens === undefined) {
    return { usd: null, complete: false, byModel: [], gaps: ["no token counts, so no cost estimate"] };
  }
  if (usage.models.length === 0) {
    return { usd: 0, complete: usage.measurement === "complete", byModel: [], gaps: [] };
  }
  if (prices === undefined) {
    return {
      usd: null,
      complete: false,
      byModel: [],
      gaps: [`no model prices configured (${MODEL_PRICES_FILE_ENV} unset)`],
    };
  }
  const gaps: string[] = [];
  const byModel = usage.models.map((modelUsage): ModelCostEstimate => {
    if (modelUsage.model === UNATTRIBUTED_MODEL) {
      gaps.push(`${modelUsage.tokens.total} tokens aren't tied to a model, so they can't be priced`);
      return { model: modelUsage.model, usd: null };
    }
    const price = prices.get(modelUsage.model);
    if (price === undefined) {
      gaps.push(`no price for ${modelUsage.model}`);
      return { model: modelUsage.model, usd: null };
    }
    const priced = priceRequests(modelUsage.model, modelUsage.requests, price, gaps);
    if (daysBetween(price.asOf, now) > PRICES_STALE_AFTER_DAYS) {
      gaps.push(`${modelUsage.model}: prices checked on ${price.asOf}, over ${PRICES_STALE_AFTER_DAYS} days ago`);
    }
    return {
      model: modelUsage.model,
      usd: priced.usd,
      basis: price.basis,
      source: price.source,
      asOf: price.asOf,
      ...(priced.longContextRequests > 0 ? { longContextRequests: priced.longContextRequests } : {}),
    };
  });
  const usd = byModel.every((entry) => entry.usd !== null)
    ? roundUsd(byModel.reduce((sum, entry) => sum + (entry.usd ?? 0), 0))
    : null;
  return { usd, complete: usd !== null && usage.measurement === "complete", byModel, gaps };
}

function priceRequests(
  model: string,
  requests: ReadonlyArray<RequestUsage>,
  price: ModelPrice,
  gaps: string[],
): { readonly usd: number | null; readonly longContextRequests: number } {
  let usd = 0;
  let longContextRequests = 0;
  for (const request of requests) {
    const problem = tokenProblem(request.tokens);
    if (problem !== undefined) {
      gaps.push(`${model}: ${problem}, so it can't be priced`);
      return { usd: null, longContextRequests };
    }
    const tier = priceTier(request, price);
    if (tier.kind === "unpriced") {
      gaps.push(`${model}: ${tier.reason}`);
      return { usd: null, longContextRequests };
    }
    if (tier.kind === "long-context") longContextRequests += 1;
    usd += requestCost(request.tokens, tier.prices);
  }
  return { usd: roundUsd(usd), longContextRequests };
}

type PriceTier =
  | { readonly kind: "standard" | "long-context"; readonly prices: TokenPrices }
  | { readonly kind: "unpriced"; readonly reason: string };

function priceTier(request: RequestUsage, price: ModelPrice): PriceTier {
  const threshold = price.longContextThresholdTokens;
  if (threshold === undefined || request.tokens.input <= threshold) return { kind: "standard", prices: price };
  if (!request.exact) {
    return {
      kind: "unpriced",
      reason: `a usage entry folding several requests has ${request.tokens.input} input tokens, over the ${threshold}-token long-context threshold, and can't be split per request`,
    };
  }
  if (price.longContext === undefined) {
    return {
      kind: "unpriced",
      reason: `a request with ${request.tokens.input} input tokens is over the ${threshold}-token long-context threshold and no long-context prices are configured`,
    };
  }
  return { kind: "long-context", prices: price.longContext };
}

function requestCost(tokens: TokenUsage, prices: TokenPrices): number {
  const uncachedInput = tokens.input - tokens.cachedInput - tokens.cacheWriteInput;
  return (
    (uncachedInput * prices.inputPerMTok +
      tokens.cachedInput * prices.cachedInputPerMTok +
      tokens.cacheWriteInput * prices.cacheWritePerMTok +
      tokens.output * prices.outputPerMTok) /
    1_000_000
  );
}

/** Why `tokens` don't add up the way the formula assumes, or undefined when they do. */
function tokenProblem(tokens: TokenUsage): string | undefined {
  const counts = Object.values(tokens);
  if (counts.some((count) => !Number.isInteger(count) || count < 0)) return "a request has a non-integer or negative token count";
  if (tokens.cachedInput + tokens.cacheWriteInput > tokens.input) {
    return "a request has more cached and cache-write input tokens than input tokens";
  }
  if (tokens.reasoningOutput > tokens.output) return "a request has more reasoning tokens than output tokens";
  return undefined;
}

/** Whole UTC days from the `YYYY-MM-DD` date `asOf` to `now`'s date. */
function daysBetween(asOf: string, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
}

/** Rounds to a millionth of a dollar, dropping float noise. */
export function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}
