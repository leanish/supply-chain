// Copied from leanish/leanish-development core/runtime/test/unit/model-prices.test.ts at e4f8a1e; see PROVENANCE.md.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadModelPricesFromEnv, ModelPricesError, parseModelPrices } from "../src/usage/model-prices.ts";

/** Synthetic prices: round numbers that make the arithmetic easy to check, not any provider's. */
const ENTRY = {
  inputPerMTok: 2,
  cachedInputPerMTok: 0.5,
  cacheWritePerMTok: 2.5,
  outputPerMTok: 10,
  basis: "standard, short context",
  source: "test fixture",
  asOf: "2026-01-01",
};

describe("parseModelPrices", () => {
  it("accepts entries with and without long-context prices", () => {
    const table = parseModelPrices(
      {
        "model-a": ENTRY,
        "model-b": {
          ...ENTRY,
          longContextThresholdTokens: 1000,
          longContext: { inputPerMTok: 4, cachedInputPerMTok: 1, cacheWritePerMTok: 5, outputPerMTok: 20 },
        },
      },
      "prices.json",
    );
    expect(table.get("model-a")).toEqual(ENTRY);
    expect(table.get("model-b")?.longContext?.outputPerMTok).toBe(20);
  });

  it.each([
    ["not an object", [], /expected an object keyed by model id/],
    ["a negative price", { m: { ...ENTRY, outputPerMTok: -1 } }, /m: outputPerMTok must be a non-negative number/],
    ["a missing price", { m: { ...ENTRY, cacheWritePerMTok: undefined } }, /cacheWritePerMTok must be a non-negative number/],
    ["no basis", { m: { ...ENTRY, basis: " " } }, /basis must be a non-empty string/],
    ["no source", { m: { ...ENTRY, source: undefined } }, /source must be a non-empty string/],
    ["an unknown key", { m: { ...ENTRY, discount: 1 } }, /unknown keys discount/],
    ["an asOf that isn't a date", { m: { ...ENTRY, asOf: "last week" } }, /asOf must be the date the prices were checked, as YYYY-MM-DD/],
    ["an asOf that doesn't exist", { m: { ...ENTRY, asOf: "2026-02-30" } }, /asOf must be the date/],
    ["long-context prices without a threshold", { m: { ...ENTRY, longContext: ENTRY } }, /need longContextThresholdTokens/],
    ["a fractional threshold", { m: { ...ENTRY, longContextThresholdTokens: 1.5 } }, /positive integer/],
    ["a malformed long-context entry", { m: { ...ENTRY, longContextThresholdTokens: 10, longContext: { inputPerMTok: 1 } } }, /longContext: cachedInputPerMTok/],
  ])("rejects %s", (_case, value, message) => {
    expect(() => parseModelPrices(JSON.parse(JSON.stringify(value)), "prices.json")).toThrowError(message);
    expect(() => parseModelPrices(JSON.parse(JSON.stringify(value)), "prices.json")).toThrowError(ModelPricesError);
  });
});

describe("loadModelPricesFromEnv", () => {
  it("has no table when the variable is unset or empty", async () => {
    expect(await loadModelPricesFromEnv({})).toBeUndefined();
    expect(await loadModelPricesFromEnv({ AGENT_RUNTIME_MODEL_PRICES_FILE: "" })).toBeUndefined();
  });

  it("loads the named file", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "model-prices-")), "prices.json");
    await writeFile(file, JSON.stringify({ "model-a": ENTRY }));
    const table = await loadModelPricesFromEnv({ AGENT_RUNTIME_MODEL_PRICES_FILE: file });
    expect([...(table?.keys() ?? [])]).toEqual(["model-a"]);
  });

  it("fails when the configured file is missing or isn't JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-prices-"));
    await expect(loadModelPricesFromEnv({ AGENT_RUNTIME_MODEL_PRICES_FILE: join(dir, "missing.json") })).rejects.toThrowError(
      /AGENT_RUNTIME_MODEL_PRICES_FILE=.*missing\.json can't be read/,
    );
    await writeFile(join(dir, "broken.json"), "{");
    await expect(loadModelPricesFromEnv({ AGENT_RUNTIME_MODEL_PRICES_FILE: join(dir, "broken.json") })).rejects.toThrowError(
      /is not JSON/,
    );
  });
});
