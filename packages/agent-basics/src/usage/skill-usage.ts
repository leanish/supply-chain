// Copied from leanish/leanish-development core/runtime/src/usage/skill-usage.ts at e4f8a1e; see PROVENANCE.md.
import type { QuotaUsage } from "./quota.ts";

/**
 * What one `CodingAgentRunner.run` attempt consumed, as far as the runner
 * could measure it. A runner hands exactly one snapshot per attempt to
 * `SkillInvocation.onUsage` — on success and on every failure, including
 * failures before anything was staged — once its own cleanup is done.
 *
 * Token counts follow the OpenAI convention Codex records: `cachedInput` and
 * `cacheWriteInput` are parts of `input`, `reasoningOutput` is part of
 * `output`. `measurement` says whether `tokens` cover the whole attempt
 * (`complete`) or are a lower bound / missing (`partial`); `gaps` say why.
 */
export interface SkillUsage {
  readonly codingAgent: string;
  /** The model the invocation asked for (a family name or a concrete id); absent for the coding agent's default. */
  readonly requestedModel?: string;
  /** The concrete model the runner passed to the CLI, when it resolved one. */
  readonly model?: string;
  /** Wall time of the attempt on a monotonic clock, staging and cleanup included. */
  readonly durationMs: number;
  /** A fake runner's canned answer: no provider was called. */
  readonly synthetic: boolean;
  readonly measurement: "complete" | "partial";
  /** Sum over `models`; absent when the runner couldn't measure tokens at all. */
  readonly tokens?: TokenUsage;
  /** Tokens per model that served requests (a run can switch models, and sub-agents run their own). */
  readonly models: ReadonlyArray<ModelUsage>;
  readonly quota: QuotaUsage;
  /** Why something above is missing, partial or approximate; empty when nothing is. */
  readonly gaps: ReadonlyArray<string>;
}

export interface TokenUsage {
  readonly input: number;
  readonly cachedInput: number;
  readonly cacheWriteInput: number;
  readonly output: number;
  readonly reasoningOutput: number;
  readonly total: number;
}

export interface ModelUsage {
  readonly model: string;
  readonly tokens: TokenUsage;
  /**
   * Usage per model request, in order — what per-request price rules (a
   * long-context threshold) need. `exact: false` when one entry folds several
   * requests together (a counter update was lost), so its input can't be
   * attributed to a single request.
   */
  readonly requests: ReadonlyArray<RequestUsage>;
}

export interface RequestUsage {
  readonly tokens: TokenUsage;
  readonly exact: boolean;
}

/**
 * The model name for tokens a runner measured but can't tie to one model: they
 * count in the totals, and their cost is a gap.
 */
export const UNATTRIBUTED_MODEL = "unattributed";

export const ZERO_TOKENS: TokenUsage = Object.freeze({
  input: 0,
  cachedInput: 0,
  cacheWriteInput: 0,
  output: 0,
  reasoningOutput: 0,
  total: 0,
});

export function addTokens(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    cachedInput: left.cachedInput + right.cachedInput,
    cacheWriteInput: left.cacheWriteInput + right.cacheWriteInput,
    output: left.output + right.output,
    reasoningOutput: left.reasoningOutput + right.reasoningOutput,
    total: left.total + right.total,
  };
}

export function sumTokens(usages: ReadonlyArray<TokenUsage>): TokenUsage {
  return usages.reduce(addTokens, ZERO_TOKENS);
}

/**
 * Hands `usage` to the invocation's callback, frozen. A throwing callback is
 * contained: usage reporting must never replace a run's own outcome (the
 * callback's owner reports its own failures).
 */
export function deliverSkillUsage(onUsage: ((usage: SkillUsage) => void) | undefined, usage: SkillUsage): void {
  if (onUsage === undefined) return;
  try {
    onUsage(deepFreeze(usage));
  } catch {
    // Contained on purpose; see above.
  }
}

/** Freezes `value` and everything reachable from it; returns it. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
