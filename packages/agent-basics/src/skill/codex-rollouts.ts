// Copied from leanish/leanish-development core/runtime/src/skill/codex-rollouts.ts at c6282df; see PROVENANCE.md.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RateLimitSnapshot, RateLimitWindowName, RateLimitWindowReading } from "../usage/quota.ts";
import {
  addTokens,
  type ModelUsage,
  type RequestUsage,
  sumTokens,
  type TokenUsage,
  UNATTRIBUTED_MODEL,
  ZERO_TOKENS,
} from "../usage/skill-usage.ts";

/**
 * Token usage and rate-limit readings from the session files ("rollouts")
 * Codex writes under `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`. The
 * runner stages a fresh `CODEX_HOME` per invocation, so every rollout there
 * belongs to it: the `codex exec` session (the root) and the sub-agent
 * sessions it spawned, each in its own file.
 *
 * The format is Codex's internal one, not a published contract; this reads it
 * as observed in CLI 0.159–0.160 (see the version-labelled fixtures in the
 * tests) and turns anything it doesn't recognise into a gap, never a guess:
 *
 *   - `session_meta`: `payload.id`; a sub-agent also has
 *     `payload.parent_thread_id` (and `payload.source.subagent.thread_spawn.
 *     parent_thread_id`). The root has none.
 *   - `turn_context`: `payload.turn_id` and `payload.model`, the model serving
 *     that turn's requests.
 *   - `token_usage_record`: one model response's `payload.usage`, with its
 *     `thread_id`, `turn_id`, `response_id` and the thread's running
 *     `thread_token_usage`.
 *   - `event_msg` / `token_count`: `payload.info.total_token_usage` is the
 *     session's cumulative usage and `payload.info.last_token_usage` the latest
 *     request's; `info` is null on readings that carry only rate limits.
 *     `payload.rate_limits` is one bucket (`limit_id`) with `primary` /
 *     `secondary` windows (`used_percent`, `window_minutes`, `resets_at`).
 *
 * Each session counts only its own requests — a parent's counters don't
 * include its sub-agents' (checked against real sessions) — so the
 * invocation's usage is the root's plus every descendant's. Within a session
 * the usage records are the source: in real sessions they cover requests the
 * cumulative readings miss (some sub-agents have records and no reading at
 * all), so the readings only cross-check them and a session never counts
 * both. Each record goes to its turn's model. A session without records falls
 * back to the readings — each request the growth of the counter between
 * readings, so repeated readings add nothing — and is reported partial, since
 * readings alone have been seen to come up short. Rate limits are the latest
 * valid reading of each bucket across those sessions, taken independently of
 * the usage.
 *
 * Tokens that can't be tied to one model — a record of an unknown turn, a
 * reading folding requests across a model switch — still count in the totals,
 * under `UNATTRIBUTED_MODEL`, which prices as a gap.
 */
export interface RolloutUsage {
  readonly models: ReadonlyArray<ModelUsage>;
  /** The latest valid reading per bucket. */
  readonly rateLimits: ReadonlyArray<RateLimitSnapshot>;
  /** Sessions whose usage was counted: the root and its descendants. */
  readonly sessions: number;
  /** Nothing token-related was malformed, unlinked or missing: the token counts cover every session file there. */
  readonly clean: boolean;
  /** Why the tokens may be incomplete, then why some can't be tied to a model, then why a rate-limit reading was skipped. */
  readonly gaps: ReadonlyArray<string>;
}

export interface RolloutFile {
  /** Path or name, for gap messages. */
  readonly name: string;
  readonly content: string;
}

/** Reads every rollout under `<codexHome>/sessions`; none (or no such directory) is an empty list. */
export async function readRolloutFiles(codexHome: string): Promise<ReadonlyArray<RolloutFile>> {
  const sessionsDir = join(codexHome, "sessions");
  let entries: string[];
  try {
    entries = await readdir(sessionsDir, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const names = entries.filter((entry) => /(^|\/)rollout-[^/]*\.jsonl$/.test(entry)).sort();
  return Promise.all(
    names.map(async (name) => ({ name, content: await readFile(join(sessionsDir, name), "utf8") })),
  );
}

/** `fallbackModel` names the model of requests no turn context names (the one the runner passed, if any). */
export function parseRollouts(files: ReadonlyArray<RolloutFile>, fallbackModel: string | undefined): RolloutUsage {
  const sessions = files.map((file, index) => parseSession(file, index));
  const gaps: string[] = sessions.flatMap((session) => session.problems.map((problem) => `${session.name}: ${problem}`));
  if (sessions.length === 0) {
    return { models: [], rateLimits: [], sessions: 0, clean: false, gaps: ["Codex left no session file, so its usage is unknown"] };
  }

  const counted = countedSessions(sessions, gaps);
  const attributionGaps: string[] = [];
  const models = usageByModel(counted, fallbackModel, attributionGaps);
  const clean = gaps.length === 0;
  const quotaGaps = counted.flatMap((session) => session.quotaProblems.map((problem) => `${session.name}: ${problem}`));
  return {
    models,
    rateLimits: latestRateLimits(counted),
    sessions: counted.length,
    clean,
    gaps: [...gaps, ...attributionGaps, ...quotaGaps],
  };
}

interface ParsedSession {
  readonly name: string;
  readonly fileIndex: number;
  readonly id?: string;
  readonly parentId?: string;
  readonly requests: ReadonlyArray<AttributedRequest>;
  readonly rateLimits: ReadonlyArray<TimedSnapshot>;
  /** What may make its token usage incomplete. */
  readonly problems: ReadonlyArray<string>;
  /** Rate-limit readings it had to skip. */
  readonly quotaProblems: ReadonlyArray<string>;
}

interface AttributedRequest {
  /** The serving model, or how it's missing: none named yet (the runner's model applies), or not one model. */
  readonly model: string | { readonly unattributed: string };
  readonly request: RequestUsage;
}

/** No turn named a model yet: the runner's own `--model`, if any, applies. */
const BEFORE_ANY_TURN = { unattributed: "came before any turn named its model" } as const;

interface UsageRecordEvent {
  readonly line: number;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly responseId?: string;
  readonly usage: TokenUsage;
  readonly threadTotal?: TokenUsage;
}

interface TimedSnapshot {
  /** Ordering key: event timestamp, then file and line. */
  readonly order: readonly [string, number, number];
  readonly snapshot: RateLimitSnapshot;
}

function parseSession(file: RolloutFile, fileIndex: number): ParsedSession {
  const problems: string[] = [];
  const quotaProblems: string[] = [];
  const readingRequests: AttributedRequest[] = [];
  const records: UsageRecordEvent[] = [];
  const turnModels = new Map<string, string>();
  const rateLimits: TimedSnapshot[] = [];
  let id: string | undefined;
  let parentId: string | undefined;
  let model: string | undefined;
  /** Models named since the previous reading (and the one it was under): more than one makes a folded reading ambiguous. */
  let modelsSinceReading = new Set<string>();
  let lastTotal: TokenUsage | undefined;

  const lines = file.content.split("\n");
  lines.forEach((line, lineIndex) => {
    if (line.trim() === "") return;
    const event = parseLine(line);
    if (event === undefined) {
      const finalLine = lineIndex === lines.length - 1;
      problems.push(finalLine ? "the last line is cut off (Codex stopped mid-write)" : `line ${lineIndex + 1} is not JSON`);
      return;
    }
    const payload = asRecord(event["payload"]);
    if (event["type"] === "session_meta" && payload !== undefined) {
      id = asText(payload["id"]);
      parentId = asText(payload["parent_thread_id"]) ?? asText(subagentParentId(payload));
      return;
    }
    if (event["type"] === "turn_context" && payload !== undefined) {
      model = asText(payload["model"]) ?? model;
      const turnId = asText(payload["turn_id"]);
      if (turnId !== undefined && model !== undefined) turnModels.set(turnId, model);
      if (model !== undefined) modelsSinceReading.add(model);
      return;
    }
    if (event["type"] === "token_usage_record" && payload !== undefined) {
      const record = parseUsageRecord(payload, lineIndex);
      if (record === undefined) problems.push(`line ${lineIndex + 1} has a usage record without a valid usage`);
      else records.push(record);
      return;
    }
    if (event["type"] !== "event_msg" || payload?.["type"] !== "token_count") return;

    const snapshot = parseRateLimits(payload["rate_limits"], quotaProblems, lineIndex);
    if (snapshot !== undefined) {
      rateLimits.push({ order: [asText(event["timestamp"]) ?? "", fileIndex, lineIndex], snapshot });
    }
    const info = payload["info"];
    if (info === null || info === undefined) return;
    const total = parseTokens(asRecord(info)?.["total_token_usage"]);
    if (total === undefined) {
      problems.push(`line ${lineIndex + 1} has a token reading without a valid cumulative usage`);
      return;
    }
    const delta = lastTotal === undefined ? total : subtractTokens(total, lastTotal);
    if (delta === undefined) {
      problems.push(`line ${lineIndex + 1}: the cumulative usage went down; the requests before it are counted, the drop isn't`);
      lastTotal = total;
      return;
    }
    lastTotal = total;
    if (delta.total === 0 && delta.input === 0 && delta.output === 0) return; // a repeated reading
    const last = parseTokens(asRecord(info)?.["last_token_usage"]);
    const exact = last !== undefined && sameTokens(last, delta);
    // A folded reading spanning a model switch can't be split between the models.
    const attribution =
      !exact && modelsSinceReading.size > 1
        ? { unattributed: "fold several requests across a model switch" }
        : (model ?? BEFORE_ANY_TURN);
    readingRequests.push({ model: attribution, request: { tokens: delta, exact } });
    modelsSinceReading = new Set(model !== undefined ? [model] : []);
  });

  if (id === undefined) problems.push("no session id (session_meta), so it can't be linked to the run");
  const requests =
    records.length > 0
      ? requestsFromRecords(records, { id, turnModels, lastReading: lastTotal }, problems)
      : readingRequests;
  if (records.length === 0 && readingRequests.length > 0) {
    problems.push("only cumulative readings, no per-request usage records, and readings alone have been seen to miss requests");
  }
  return {
    name: file.name,
    fileIndex,
    ...(id !== undefined ? { id } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    requests,
    rateLimits,
    problems,
    quotaProblems,
  };
}

/** The root session and its descendants; anything else is a gap and isn't counted. */
function countedSessions(sessions: ReadonlyArray<ParsedSession>, gaps: string[]): ReadonlyArray<ParsedSession> {
  const roots = sessions.filter((session) => session.id !== undefined && session.parentId === undefined);
  if (roots.length !== 1) {
    gaps.push(
      roots.length === 0
        ? "no root session (one without a parent) among Codex's session files, so none is counted"
        : `${roots.length} root sessions among Codex's session files where one was expected, so none is counted`,
    );
    return [];
  }
  const root = roots[0]!;
  const counted: ParsedSession[] = [root];
  const linked = new Set([root.id]);
  for (let index = 0; index < counted.length; index++) {
    const parent = counted[index]!;
    for (const session of sessions) {
      if (session.parentId === parent.id && session.id !== undefined && !linked.has(session.id)) {
        linked.add(session.id);
        counted.push(session);
      }
    }
  }
  const unlinked = sessions.filter((session) => session.id !== undefined && !linked.has(session.id));
  if (unlinked.length > 0) {
    gaps.push(`${unlinked.length} session file(s) don't descend from the root session and weren't counted`);
  }
  return counted;
}

/**
 * A session's requests from its usage records, deduplicated by response id,
 * each attributed to its turn's model. Cross-checks the records against the
 * thread's running total and the cumulative readings; a mismatch is a gap.
 */
function requestsFromRecords(
  records: ReadonlyArray<UsageRecordEvent>,
  session: { readonly id: string | undefined; readonly turnModels: ReadonlyMap<string, string>; readonly lastReading: TokenUsage | undefined },
  problems: string[],
): AttributedRequest[] {
  const seen = new Set<string>();
  const requests: AttributedRequest[] = [];
  for (const record of records) {
    if (record.responseId !== undefined) {
      if (seen.has(record.responseId)) continue; // the same response, recorded again
      seen.add(record.responseId);
    }
    if (record.threadId !== undefined && session.id !== undefined && record.threadId !== session.id) {
      problems.push(`line ${record.line + 1} has a usage record of another thread, not counted`);
      continue;
    }
    const model = record.turnId !== undefined ? session.turnModels.get(record.turnId) : undefined;
    requests.push({
      model: model ?? { unattributed: "belong to a turn that names no model" },
      request: { tokens: record.usage, exact: true },
    });
  }
  const counted = sumTokens(requests.map((entry) => entry.request.tokens));
  const threadTotal = [...records].reverse().find((record) => record.threadTotal !== undefined)?.threadTotal;
  if (threadTotal !== undefined && !sameTokens(threadTotal, counted)) {
    problems.push(`the usage records add up to ${counted.total} tokens but the thread's running total says ${threadTotal.total}`);
  }
  if (session.lastReading !== undefined && session.lastReading.total > counted.total) {
    problems.push(`the cumulative readings show ${session.lastReading.total} tokens, more than the ${counted.total} the usage records add up to`);
  }
  return requests;
}

function parseUsageRecord(payload: Readonly<Record<string, unknown>>, line: number): UsageRecordEvent | undefined {
  const usage = parseTokens(payload["usage"]);
  if (usage === undefined) return undefined;
  const threadId = asText(payload["thread_id"]);
  const turnId = asText(payload["turn_id"]);
  const responseId = asText(payload["response_id"]);
  const threadTotal = parseTokens(payload["thread_token_usage"]);
  return {
    line,
    usage,
    ...(threadId !== undefined ? { threadId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(responseId !== undefined ? { responseId } : {}),
    ...(threadTotal !== undefined ? { threadTotal } : {}),
  };
}

/**
 * Tokens per model. Requests no turn named fall back to the runner's model;
 * whatever still has none goes under `UNATTRIBUTED_MODEL`, with a gap per
 * reason (the tokens count, their cost can't be estimated).
 */
function usageByModel(
  sessions: ReadonlyArray<ParsedSession>,
  fallbackModel: string | undefined,
  gaps: string[],
): ReadonlyArray<ModelUsage> {
  const byModel = new Map<string, { tokens: TokenUsage; requests: RequestUsage[] }>();
  const unattributed = new Map<string, number>();
  for (const session of sessions) {
    for (const { model, request } of session.requests) {
      const name =
        typeof model === "string" ? model : model === BEFORE_ANY_TURN && fallbackModel !== undefined ? fallbackModel : undefined;
      if (name === undefined && typeof model !== "string") {
        unattributed.set(model.unattributed, (unattributed.get(model.unattributed) ?? 0) + 1);
      }
      const key = name ?? UNATTRIBUTED_MODEL;
      const entry = byModel.get(key) ?? { tokens: ZERO_TOKENS, requests: [] };
      byModel.set(key, { tokens: addTokens(entry.tokens, request.tokens), requests: [...entry.requests, request] });
    }
  }
  for (const [reason, count] of unattributed) {
    gaps.push(`${count} request(s) ${reason}, so their tokens can't be tied to a model or priced`);
  }
  return [...byModel.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, entry]) => ({ model, tokens: entry.tokens, requests: entry.requests }));
}

function latestRateLimits(sessions: ReadonlyArray<ParsedSession>): ReadonlyArray<RateLimitSnapshot> {
  const latest = new Map<string, TimedSnapshot>();
  for (const reading of sessions.flatMap((session) => session.rateLimits)) {
    const current = latest.get(reading.snapshot.limitId);
    if (current === undefined || compareOrder(reading.order, current.order) > 0) latest.set(reading.snapshot.limitId, reading);
  }
  return [...latest.values()]
    .map((reading) => reading.snapshot)
    .sort((left, right) => left.limitId.localeCompare(right.limitId));
}

function compareOrder(left: TimedSnapshot["order"], right: TimedSnapshot["order"]): number {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] !== right[1]) return left[1] - right[1];
  return left[2] - right[2];
}

/** A rollout's `rate_limits`; undefined when absent (null) or unusable (a problem then says so). */
function parseRateLimits(value: unknown, problems: string[], lineIndex: number): RateLimitSnapshot | undefined {
  if (value === null || value === undefined) return undefined;
  const limits = asRecord(value);
  const limitId = asText(limits?.["limit_id"]);
  if (limits === undefined || limitId === undefined) {
    problems.push(`line ${lineIndex + 1} has rate limits without a bucket id`);
    return undefined;
  }
  const windows: RateLimitWindowReading[] = [];
  for (const name of ["primary", "secondary"] as const satisfies ReadonlyArray<RateLimitWindowName>) {
    const raw = limits[name];
    if (raw === null || raw === undefined) continue;
    const reading = parseWindow(name, asRecord(raw));
    if (reading === undefined) {
      problems.push(`line ${lineIndex + 1} has a malformed ${name} rate-limit window`);
      return undefined;
    }
    windows.push(reading);
  }
  const planType = asText(limits["plan_type"]);
  return { limitId, ...(planType !== undefined ? { planType } : {}), windows };
}

function parseWindow(window: RateLimitWindowName, raw: Readonly<Record<string, unknown>> | undefined): RateLimitWindowReading | undefined {
  const usedPercent = raw?.["used_percent"];
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
  const windowMinutes = finiteNumber(raw?.["window_minutes"]);
  const resetsAt = finiteNumber(raw?.["resets_at"]);
  return {
    window,
    usedPercent,
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

const TOKEN_FIELDS = [
  ["input", "input_tokens"],
  ["cachedInput", "cached_input_tokens"],
  ["cacheWriteInput", "cache_write_input_tokens"],
  ["output", "output_tokens"],
  ["reasoningOutput", "reasoning_output_tokens"],
  ["total", "total_tokens"],
] as const satisfies ReadonlyArray<readonly [keyof TokenUsage, string]>;

/**
 * Codex's usage object, every count a non-negative integer. `cache_write_input_tokens`
 * is newer than the rest: absent counts as 0.
 */
function parseTokens(value: unknown): TokenUsage | undefined {
  const raw = asRecord(value);
  if (raw === undefined) return undefined;
  const tokens: Partial<Record<keyof TokenUsage, number>> = {};
  for (const [field, key] of TOKEN_FIELDS) {
    const count = raw[key] ?? (field === "cacheWriteInput" ? 0 : undefined);
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return undefined;
    tokens[field] = count;
  }
  return tokens as TokenUsage;
}

/** `total − previous`, or undefined when any counter went down. */
function subtractTokens(total: TokenUsage, previous: TokenUsage): TokenUsage | undefined {
  const delta: Partial<Record<keyof TokenUsage, number>> = {};
  for (const [field] of TOKEN_FIELDS) {
    const difference = total[field] - previous[field];
    if (difference < 0) return undefined;
    delta[field] = difference;
  }
  return delta as TokenUsage;
}

function sameTokens(left: TokenUsage, right: TokenUsage): boolean {
  return TOKEN_FIELDS.every(([field]) => left[field] === right[field]);
}

function subagentParentId(payload: Readonly<Record<string, unknown>>): unknown {
  const source = asRecord(payload["source"]);
  const spawn = asRecord(asRecord(source?.["subagent"])?.["thread_spawn"]);
  return spawn?.["parent_thread_id"];
}

function parseLine(line: string): Readonly<Record<string, unknown>> | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
