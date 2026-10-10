// Copied from leanish/leanish-development core/runtime/src/usage/model-prices.ts at c6282df; see PROVENANCE.md.
import { readFile } from "node:fs/promises";

/**
 * API list prices per model, in USD per million tokens, used to estimate what
 * a run would have cost through the provider's API. Read from the JSON file
 * named by `AGENT_RUNTIME_MODEL_PRICES_FILE`, keyed by model id:
 *
 *   {
 *     "<model id>": {
 *       "inputPerMTok": 0, "cachedInputPerMTok": 0, "cacheWritePerMTok": 0, "outputPerMTok": 0,
 *       "basis": "standard, short context",
 *       "longContextThresholdTokens": 0,                     // optional
 *       "longContext": { "inputPerMTok": 0, "cachedInputPerMTok": 0,
 *                        "cacheWritePerMTok": 0, "outputPerMTok": 0 },   // optional, needs the threshold
 *       "source": "<where the prices come from>", "asOf": "<YYYY-MM-DD>"
 *     }
 *   }
 *
 * `basis` names what the prices assume (service tier, context length, region)
 * and travels with every estimate. A request whose own input exceeds
 * `longContextThresholdTokens` is priced with `longContext`, or not at all
 * when that's absent. `asOf` is the date the prices were last checked against
 * `source`; an estimate made more than `PRICES_STALE_AFTER_DAYS` later still
 * counts, with a gap saying so. The runtime ships no prices: an agent's local
 * wrapper supplies its own file (bump-it versions one next to its `run.sh`).
 */
export const MODEL_PRICES_FILE_ENV = "AGENT_RUNTIME_MODEL_PRICES_FILE";

export interface TokenPrices {
  readonly inputPerMTok: number;
  readonly cachedInputPerMTok: number;
  readonly cacheWritePerMTok: number;
  readonly outputPerMTok: number;
}

export interface ModelPrice extends TokenPrices {
  readonly basis: string;
  readonly longContextThresholdTokens?: number;
  readonly longContext?: TokenPrices;
  readonly source: string;
  readonly asOf: string;
}

/** Validated prices, by model id. */
export type ModelPriceTable = ReadonlyMap<string, ModelPrice>;

export class ModelPricesError extends Error {
  override readonly name = "ModelPricesError";
}

/**
 * The price table `env` configures: none when `AGENT_RUNTIME_MODEL_PRICES_FILE`
 * is unset or empty (estimates then carry a gap). A configured file that is
 * missing, unreadable or invalid fails — it was meant to be used.
 */
export async function loadModelPricesFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Promise<ModelPriceTable | undefined> {
  const path = env[MODEL_PRICES_FILE_ENV];
  if (path === undefined || path === "") return undefined;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new ModelPricesError(`${MODEL_PRICES_FILE_ENV}=${path} can't be read: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ModelPricesError(`${MODEL_PRICES_FILE_ENV}=${path} is not JSON: ${(err as Error).message}`);
  }
  return parseModelPrices(parsed, path);
}

const PRICE_KEYS: ReadonlyArray<keyof TokenPrices> = ["inputPerMTok", "cachedInputPerMTok", "cacheWritePerMTok", "outputPerMTok"];
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  ...PRICE_KEYS,
  "basis",
  "longContextThresholdTokens",
  "longContext",
  "source",
  "asOf",
]);

/** Validates a parsed price file; `origin` names it in errors. */
export function parseModelPrices(value: unknown, origin: string): ModelPriceTable {
  if (!isRecord(value)) throw new ModelPricesError(`${origin}: expected an object keyed by model id`);
  const table = new Map<string, ModelPrice>();
  for (const [model, entry] of Object.entries(value)) {
    if (model.length === 0) throw new ModelPricesError(`${origin}: a model id is empty`);
    table.set(model, parseEntry(entry, `${origin}: ${model}`));
  }
  return table;
}

function parseEntry(entry: unknown, where: string): ModelPrice {
  if (!isRecord(entry)) throw new ModelPricesError(`${where}: expected an object`);
  const unknownKeys = Object.keys(entry).filter((key) => !ENTRY_KEYS.has(key));
  if (unknownKeys.length > 0) throw new ModelPricesError(`${where}: unknown keys ${unknownKeys.join(", ")}`);
  const threshold = entry["longContextThresholdTokens"];
  if (threshold !== undefined && !(Number.isInteger(threshold) && (threshold as number) > 0)) {
    throw new ModelPricesError(`${where}: longContextThresholdTokens must be a positive integer`);
  }
  const longContext = entry["longContext"];
  if (longContext !== undefined && threshold === undefined) {
    throw new ModelPricesError(`${where}: longContext prices need longContextThresholdTokens`);
  }
  return {
    ...parsePrices(entry, where),
    basis: requireText(entry, "basis", where),
    ...(threshold !== undefined ? { longContextThresholdTokens: threshold as number } : {}),
    ...(longContext !== undefined ? { longContext: parseLongContext(longContext, `${where}: longContext`) } : {}),
    source: requireText(entry, "source", where),
    asOf: requireDate(entry, "asOf", where),
  };
}

function parseLongContext(value: unknown, where: string): TokenPrices {
  if (!isRecord(value)) throw new ModelPricesError(`${where}: expected an object`);
  const unknownKeys = Object.keys(value).filter((key) => !(PRICE_KEYS as ReadonlyArray<string>).includes(key));
  if (unknownKeys.length > 0) throw new ModelPricesError(`${where}: unknown keys ${unknownKeys.join(", ")}`);
  return parsePrices(value, where);
}

function parsePrices(value: Readonly<Record<string, unknown>>, where: string): TokenPrices {
  const price = (key: keyof TokenPrices): number => {
    const amount = value[key];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new ModelPricesError(`${where}: ${key} must be a non-negative number`);
    }
    return amount;
  };
  return {
    inputPerMTok: price("inputPerMTok"),
    cachedInputPerMTok: price("cachedInputPerMTok"),
    cacheWritePerMTok: price("cacheWritePerMTok"),
    outputPerMTok: price("outputPerMTok"),
  };
}

function requireText(value: Readonly<Record<string, unknown>>, key: string, where: string): string {
  const text = value[key];
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ModelPricesError(`${where}: ${key} must be a non-empty string`);
  }
  return text;
}

/** A `YYYY-MM-DD` calendar date that exists. */
function requireDate(value: Readonly<Record<string, unknown>>, key: string, where: string): string {
  const text = value[key];
  const date = typeof text === "string" && /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : undefined;
  if (date === undefined || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new ModelPricesError(`${where}: ${key} must be the date the prices were checked, as YYYY-MM-DD`);
  }
  return text as string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
