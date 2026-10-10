// Copied from leanish/leanish-development core/runtime/src/skill/codex-quota-baseline.ts at c6282df; see PROVENANCE.md.
import { spawn } from "node:child_process";

import type { Redactor } from "../logger/redactor.ts";
import type { RateLimitSnapshot, RateLimitWindowName, RateLimitWindowReading } from "../usage/quota.ts";
import { forwardTerminationSignals, killGroup, scrubbedProcessEnv, withoutAmbientCredentials } from "./spawn-capture.ts";

/**
 * The account's quota right before a Codex run, read through `codex app-server`
 * without a model call: `initialize`, then `account/read` (which login the
 * CLI picked: `apiKey`, `chatgpt`, …) and `account/rateLimits/read` (every
 * bucket's windows). The run's own session files only show readings taken
 * after its first request, so without this one there is nothing to compare
 * them with.
 *
 * Settles only once the server process — and anything it started — is gone,
 * so the run never overlaps it. Rejects when the server can't start, errs,
 * answers something unusable or misses `timeoutMs`; the caller turns that into
 * a gap, never a failed run.
 */
export interface QuotaBaseline {
  /** `account/read`'s account type, when it answered. */
  readonly accountType?: string;
  readonly planType?: string;
  readonly snapshots: ReadonlyArray<RateLimitSnapshot>;
}

export interface QuotaBaselineOptions {
  readonly bin: string;
  readonly cwd: string;
  /** The same env the run gets (its `CODEX_HOME` and login included). */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Applied to server error messages before they're surfaced. */
  readonly redactor: Redactor;
}

/** How long a server that answered gets to exit on its own once its input closes. */
const EXIT_GRACE_MS = 1_000;

const INITIALIZE_ID = 1;
const ACCOUNT_ID = 2;
const RATE_LIMITS_ID = 3;

export function readQuotaBaseline(options: QuotaBaselineOptions): Promise<QuotaBaseline> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.bin, ["app-server"], {
      cwd: options.cwd,
      env: { ...withoutAmbientCredentials(scrubbedProcessEnv()), ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const group = child.pid;
    const stopForwarding = forwardTerminationSignals(group);
    let markExited: () => void = () => {};
    const exited = new Promise<void>((done) => {
      markExited = done;
    });
    child.once("close", () => markExited());

    let outcome: { readonly value: QuotaBaseline } | { readonly error: string } | undefined;
    let account: { readonly type?: string; readonly planType?: string } | undefined;
    let rateLimits: { readonly snapshots: ReadonlyArray<RateLimitSnapshot> } | { readonly error: string } | undefined;
    let pending = "";

    const send = (message: Readonly<Record<string, unknown>>): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const finish = (result: NonNullable<typeof outcome>): void => {
      if (outcome !== undefined) return;
      outcome = result;
      clearTimeout(timer);
      child.stdin.end();
      const grace = setTimeout(() => void killGroup(group), EXIT_GRACE_MS);
      void exited.then(async () => {
        clearTimeout(grace);
        stopForwarding();
        await killGroup(group);
        if ("value" in result) resolve(result.value);
        else reject(new Error(options.redactor.redact(result.error)));
      });
    };
    const settleIfAnswered = (): void => {
      if (account === undefined || rateLimits === undefined) return;
      if ("snapshots" in rateLimits) {
        finish({
          value: {
            ...(account.type !== undefined ? { accountType: account.type } : {}),
            ...(account.planType !== undefined ? { planType: account.planType } : {}),
            snapshots: rateLimits.snapshots,
          },
        });
        return;
      }
      // An API-key login has no subscription to read; anything else should have answered.
      if (account.type === "apiKey") finish({ value: { accountType: "apiKey", snapshots: [] } });
      else finish({ error: rateLimits.error });
    };

    const timer = setTimeout(
      () => finish({ error: `'${options.bin} app-server' did not answer within ${options.timeoutMs}ms` }),
      options.timeoutMs,
    );
    child.on("error", (err) => {
      finish({ error: `cannot run '${options.bin} app-server': ${err.message}` });
      if (child.pid === undefined) markExited(); // never started, so no close event
    });
    void exited.then(() => finish({ error: `'${options.bin} app-server' exited without answering` }));
    child.stdin.on("error", () => {}); // the server may exit before reading everything
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const message = parseMessage(line);
        if (message?.["id"] === INITIALIZE_ID) {
          if (message["error"] !== undefined) {
            finish({ error: `app-server initialize failed: ${errorText(message["error"])}` });
            return;
          }
          send({ method: "initialized" });
          send({ id: ACCOUNT_ID, method: "account/read", params: { refreshToken: false } });
          send({ id: RATE_LIMITS_ID, method: "account/rateLimits/read", params: { excludeResetCreditDetails: true } });
        } else if (message?.["id"] === ACCOUNT_ID) {
          account = parseAccount(message["result"]);
          settleIfAnswered();
        } else if (message?.["id"] === RATE_LIMITS_ID) {
          rateLimits =
            message["error"] !== undefined
              ? { error: `account/rateLimits/read failed: ${errorText(message["error"])}` }
              : parseRateLimitsAnswer(message["result"]);
          settleIfAnswered();
        }
      }
    });
    send({ id: INITIALIZE_ID, method: "initialize", params: { clientInfo: { name: "agent-runtime", version: "1" } } });
  });
}

/** `account/read`'s account type and plan; empty when it erred or answered something else. */
function parseAccount(result: unknown): { readonly type?: string; readonly planType?: string } {
  const accountValue = asRecord(asRecord(result)?.["account"]);
  const type = asText(accountValue?.["type"]);
  const planType = asText(accountValue?.["planType"]);
  return { ...(type !== undefined ? { type } : {}), ...(planType !== undefined ? { planType } : {}) };
}

/**
 * Every bucket from `rateLimitsByLimitId`, or the single-bucket `rateLimits`
 * view when the server has no multi-bucket one.
 */
function parseRateLimitsAnswer(result: unknown): { readonly snapshots: ReadonlyArray<RateLimitSnapshot> } | { readonly error: string } {
  const answer = asRecord(result);
  const byLimitId = asRecord(answer?.["rateLimitsByLimitId"]);
  const entries: Array<readonly [string | undefined, unknown]> =
    byLimitId !== undefined
      ? Object.entries(byLimitId)
      : [[asText(asRecord(answer?.["rateLimits"])?.["limitId"]), answer?.["rateLimits"]]];
  const snapshots: RateLimitSnapshot[] = [];
  for (const [limitId, raw] of entries) {
    if (raw === null || raw === undefined) continue;
    const snapshot = parseSnapshot(limitId, asRecord(raw));
    if (snapshot === undefined) return { error: "account/rateLimits/read answered an unusable rate-limit bucket" };
    snapshots.push(snapshot);
  }
  return { snapshots };
}

function parseSnapshot(limitId: string | undefined, raw: Readonly<Record<string, unknown>> | undefined): RateLimitSnapshot | undefined {
  if (limitId === undefined || raw === undefined) return undefined;
  const windows: RateLimitWindowReading[] = [];
  for (const name of ["primary", "secondary"] as const satisfies ReadonlyArray<RateLimitWindowName>) {
    const window = raw[name];
    if (window === null || window === undefined) continue;
    const reading = asRecord(window);
    const usedPercent = reading?.["usedPercent"];
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
    const windowMinutes = finiteNumber(reading?.["windowDurationMins"]);
    const resetsAt = finiteNumber(reading?.["resetsAt"]);
    windows.push({
      window: name,
      usedPercent,
      ...(windowMinutes !== undefined ? { windowMinutes } : {}),
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }
  const planType = asText(raw["planType"]);
  return { limitId, ...(planType !== undefined ? { planType } : {}), windows };
}

function parseMessage(line: string): Readonly<Record<string, unknown>> | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function errorText(error: unknown): string {
  return asText(asRecord(error)?.["message"]) ?? "unknown error";
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
