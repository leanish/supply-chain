// Copied from leanish/leanish-development core/runtime/test/fixtures/codex-rollout.ts at e4f8a1e; see PROVENANCE.md.
/**
 * Synthetic Codex session-file ("rollout") lines in the shape codex-cli
 * 0.159.3 and 0.160.0 write under `<CODEX_HOME>/sessions` — a compatibility
 * fixture for `codex-rollouts.ts`: when a new CLI changes the shape, add a
 * builder for it here, labelled with its version, instead of editing these.
 * Every id, path and count is made up.
 */
export const ROLLOUT_SHAPE_VERSIONS = ["0.159.3", "0.160.0"] as const;

export interface Tokens {
  readonly input: number;
  readonly cached?: number;
  readonly cacheWrite?: number;
  readonly output: number;
  readonly reasoning?: number;
}

export interface Window {
  readonly usedPercent: number;
  readonly windowMinutes: number;
  readonly resetsAt: number;
}

export interface Limits {
  readonly limitId?: string;
  readonly planType?: string;
  readonly primary?: Window | null;
  readonly secondary?: Window | null;
}

let clock = Date.parse("2026-01-01T00:00:00.000Z");
function timestamp(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

export function sessionMeta(id: string, parentId?: string, cliVersion: (typeof ROLLOUT_SHAPE_VERSIONS)[number] = "0.160.0"): string {
  return JSON.stringify({
    timestamp: timestamp(),
    type: "session_meta",
    payload: {
      session_id: parentId ?? id,
      id,
      ...(parentId !== undefined ? { parent_thread_id: parentId } : {}),
      cwd: "/work/example",
      originator: "codex_exec",
      cli_version: cliVersion,
      source: parentId === undefined ? "exec" : { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } },
      thread_source: parentId === undefined ? "user" : "subagent",
      model_provider: "openai",
    },
  });
}

export function turnContext(model: string, turnId = `turn-${model}`): string {
  return JSON.stringify({ timestamp: timestamp(), type: "turn_context", payload: { turn_id: turnId, root_turn_id: turnId, model, effort: "medium" } });
}

/**
 * A `token_usage_record`: one response's `usage` in thread `threadId`, turn
 * `turnId`, with the thread's running total after it (`threadTotal`, when the
 * caller wants it checked).
 */
export function usageRecord(record: {
  readonly threadId: string;
  readonly turnId: string;
  readonly responseId: string;
  readonly usage: Tokens;
  readonly threadTotal?: Tokens;
}): string {
  return JSON.stringify({
    timestamp: timestamp(),
    type: "token_usage_record",
    payload: {
      thread_id: record.threadId,
      turn_id: record.turnId,
      session_id: record.threadId,
      root_turn_id: record.turnId,
      response_id: record.responseId,
      usage: usage(record.usage),
      turn_token_usage: usage(record.usage),
      thread_token_usage: usage(record.threadTotal ?? record.usage),
    },
  });
}

function usage(tokens: Tokens): Record<string, number> {
  const cached = tokens.cached ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  const reasoning = tokens.reasoning ?? 0;
  return {
    input_tokens: tokens.input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: tokens.output,
    reasoning_output_tokens: reasoning,
    total_tokens: tokens.input + tokens.output,
  };
}

function limits(value: Limits | null): unknown {
  if (value === null) return null;
  const window = (w: Window | null | undefined) =>
    w === undefined || w === null ? null : { used_percent: w.usedPercent, window_minutes: w.windowMinutes, resets_at: w.resetsAt };
  return {
    ...(value.limitId !== undefined ? { limit_id: value.limitId } : {}),
    limit_name: null,
    primary: window(value.primary),
    secondary: window(value.secondary),
    credits: { has_credits: false, unlimited: false, balance: null },
    plan_type: value.planType ?? null,
    rate_limit_reached_type: null,
  };
}

/** A `token_count` event: the session's cumulative `total` and the latest request's `last` (null `total`: a rate-limit-only reading). */
export function tokenCount(total: Tokens | null, last: Tokens | null, rateLimits: Limits | null = null): string {
  return JSON.stringify({
    timestamp: timestamp(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info:
        total === null
          ? null
          : { total_token_usage: usage(total), last_token_usage: last === null ? null : usage(last), model_context_window: 272000 },
      rate_limits: limits(rateLimits),
    },
  });
}

/** A `token_count` whose `info` is there but carries no usable cumulative usage. */
export function tokenCountWithNullUsage(): string {
  return JSON.stringify({
    timestamp: timestamp(),
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: null, last_token_usage: null }, rate_limits: null },
  });
}

export function lines(...entries: ReadonlyArray<string>): string {
  return `${entries.join("\n")}\n`;
}
