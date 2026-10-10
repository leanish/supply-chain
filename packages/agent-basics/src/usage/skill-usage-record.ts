// Copied from leanish/leanish-development core/runtime/src/usage/skill-usage-record.ts at c6282df; see PROVENANCE.md.
import type { ApiCostEstimate } from "./api-cost.ts";
import type { QuotaUsage } from "./quota.ts";
import type { SkillUsage, TokenUsage } from "./skill-usage.ts";

/**
 * One `runSkill` call's usage as `runSkill` logs it (`runSkill usage`) and
 * hands it to `BuildRuntimeOptions.usageRecorder`: the runner's snapshot,
 * per-request detail folded into counts, with the call's identity and the
 * API-price estimate. Recorded for every call that reached the runner, also
 * when the runner failed or its answer was rejected afterwards.
 */
export interface SkillUsageRecord {
  /** Unique per `runSkill` call, so repeated and concurrent calls stay apart. */
  readonly invocationId: string;
  readonly entrypoint: string;
  readonly requestId?: string;
  readonly stage?: string;
  /** `succeeded`, the runner threw (`runner-failed`), or its answer failed parsing / validation (`output-rejected`). */
  readonly outcome: SkillUsageOutcome;
  readonly codingAgent: string;
  readonly requestedModel?: string;
  readonly model?: string;
  readonly durationMs: number;
  readonly synthetic: boolean;
  readonly measurement: "complete" | "partial";
  readonly tokens?: TokenUsage;
  readonly models: ReadonlyArray<ModelUsageSummary>;
  readonly quota: QuotaUsage;
  readonly apiCost: ApiCostEstimate;
  readonly gaps: ReadonlyArray<string>;
}

export type SkillUsageOutcome = "succeeded" | "runner-failed" | "output-rejected";

/**
 * Where `runSkill` reports usage (`BuildRuntimeOptions.usageRecorder`):
 * `started` as a call hands over to its runner, then `record` once it's done —
 * so a recorder knows which calls are still in flight (their usage unknown).
 */
export interface SkillUsageRecorder {
  readonly started?: (run: SkillRunStart) => void;
  readonly record: (record: SkillUsageRecord) => void;
}

export interface SkillRunStart {
  readonly invocationId: string;
  readonly entrypoint: string;
}

export interface ModelUsageSummary {
  readonly model: string;
  readonly tokens: TokenUsage;
  readonly requests: number;
}

export interface SkillUsageContext {
  readonly invocationId: string;
  readonly entrypoint: string;
  readonly requestId?: string;
  readonly stage?: string;
  readonly outcome: SkillUsageOutcome;
}

export function toSkillUsageRecord(
  usage: SkillUsage,
  context: SkillUsageContext,
  apiCost: ApiCostEstimate,
): SkillUsageRecord {
  return {
    ...context,
    codingAgent: usage.codingAgent,
    ...(usage.requestedModel !== undefined ? { requestedModel: usage.requestedModel } : {}),
    ...(usage.model !== undefined ? { model: usage.model } : {}),
    durationMs: usage.durationMs,
    synthetic: usage.synthetic,
    measurement: usage.measurement,
    ...(usage.tokens !== undefined ? { tokens: usage.tokens } : {}),
    models: usage.models.map((entry) => ({ model: entry.model, tokens: entry.tokens, requests: entry.requests.length })),
    quota: usage.quota,
    apiCost,
    gaps: usage.gaps,
  };
}

/** The usage of a runner that never reported any: a measured duration, nothing else. */
export function unreportedSkillUsage(codingAgent: string, durationMs: number, requestedModel: string | undefined): SkillUsage {
  return {
    codingAgent,
    ...(requestedModel !== undefined ? { requestedModel } : {}),
    durationMs,
    synthetic: false,
    measurement: "partial",
    models: [],
    quota: { status: "unavailable" },
    gaps: [`the ${codingAgent} runner reported no usage; the duration is runSkill's own measurement`],
  };
}
