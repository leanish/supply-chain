// Copied from leanish/leanish-development core/runtime/src/usage/usage-totals.ts at c6282df; see PROVENANCE.md.
import { roundUsd } from "./api-cost.ts";
import type { SkillUsageRecord } from "./skill-usage-record.ts";
import { sumTokens, type TokenUsage } from "./skill-usage.ts";

/**
 * A command's skill runs added up. A total is only reported as one when every
 * part is known: `tokens` needs every run's tokens measured completely and
 * `estimatedApiCostUsd` every run's estimate complete, and no run may still be
 * in flight (its usage unknown) — otherwise they're null and the
 * `…LowerBound` fields hold what is known. No skill runs means zero tokens and
 * zero cost.
 *
 * Quota changes are deliberately not added up: runs of one command overlap in
 * account activity (each reading counts everything the account did), so a
 * sum would double count. Each run's own observation stays in its record.
 */
export interface UsageTotals {
  /** Skill runs with a usage record. */
  readonly skillRuns: number;
  /** Skill runs started and not finished when the totals were taken (e.g. interrupted): their usage is unknown. */
  readonly skillRunsInProgress: number;
  readonly tokens: TokenUsage | null;
  readonly tokensLowerBound: TokenUsage;
  readonly estimatedApiCostUsd: number | null;
  readonly estimatedApiCostUsdLowerBound: number;
  /** The distinct pricing bases the estimates used. */
  readonly pricingBases: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
}

export function totalSkillUsage(records: ReadonlyArray<SkillUsageRecord>, inProgress = 0): UsageTotals {
  const measured = sumTokens(records.flatMap((record) => (record.tokens !== undefined ? [record.tokens] : [])));
  const partialTokens = records.filter((record) => record.measurement !== "complete" || record.tokens === undefined);
  const incompleteCost = records.filter((record) => !record.apiCost.complete);
  const knownCost = records.reduce((sum, record) => sum + (record.apiCost.usd ?? 0), 0);
  const known = inProgress === 0;
  const gaps = [
    ...(inProgress > 0 ? [`${inProgress} skill run(s) were still in progress, so their usage is unknown`] : []),
    ...(partialTokens.length > 0
      ? [`${partialTokens.length} of ${records.length} skill run(s) have missing or partial token counts`]
      : []),
    ...(incompleteCost.length > 0
      ? [`${incompleteCost.length} of ${records.length} skill run(s) have a missing or partial cost estimate`]
      : []),
  ];
  const pricingBases = [
    ...new Set(records.flatMap((record) => record.apiCost.byModel.flatMap((entry) => (entry.basis !== undefined ? [entry.basis] : [])))),
  ].sort();
  return {
    skillRuns: records.length,
    skillRunsInProgress: inProgress,
    tokens: known && partialTokens.length === 0 ? measured : null,
    tokensLowerBound: measured,
    estimatedApiCostUsd: known && incompleteCost.length === 0 ? roundUsd(knownCost) : null,
    estimatedApiCostUsdLowerBound: roundUsd(knownCost),
    pricingBases,
    gaps,
  };
}
