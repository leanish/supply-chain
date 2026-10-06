// Copied from leanish/leanish-development core/runtime/src/usage/quota.ts at e4f8a1e; see PROVENANCE.md.
/**
 * Subscription quota ("plan usage") seen around one coding-agent run: the
 * account's rate-limit buckets read before the run and the latest ones the
 * run itself recorded. The change is an **observed account quota
 * percentage-point change**, never a precise share of the subscription the
 * run consumed: percentages are whole numbers (a short run can show +0), they
 * count everything the account did meanwhile (e.g. a concurrent review), and
 * the two readings aren't taken at the run's exact edges.
 */
export type QuotaUsage =
  | {
      readonly status: "observed";
      /** Always true: see above. */
      readonly approximate: true;
      readonly planType?: string;
      readonly windows: ReadonlyArray<QuotaWindowObservation>;
    }
  | {
      /** The run can't draw on a subscription: no provider call, an API-key login, or a synthetic run. */
      readonly status: "not-applicable";
      readonly reason: string;
    }
  | {
      /** It may have drawn on one, but nothing usable was read; `SkillUsage.gaps` says why. */
      readonly status: "unavailable";
    };

/** One bucket's reading (`limitId`, e.g. `codex`) at one point in time. */
export interface RateLimitSnapshot {
  readonly limitId: string;
  readonly planType?: string;
  readonly windows: ReadonlyArray<RateLimitWindowReading>;
}

export type RateLimitWindowName = "primary" | "secondary";

export interface RateLimitWindowReading {
  readonly window: RateLimitWindowName;
  readonly usedPercent: number;
  readonly windowMinutes?: number;
  /** When the window resets, in epoch seconds. */
  readonly resetsAt?: number;
}

/**
 * One window of one bucket, before and after. `changePercentPoints` is there
 * only when both readings describe the same window — same bucket, window and
 * duration, both with a reset time and the same one (within
 * `RESET_JITTER_SECONDS`) — and the percentage didn't drop; otherwise
 * `noChangeReason` says why it isn't.
 */
export interface QuotaWindowObservation {
  readonly limitId: string;
  readonly window: RateLimitWindowName;
  readonly windowMinutes?: number;
  readonly beforePercent?: number;
  readonly afterPercent?: number;
  readonly beforeResetsAt?: number;
  readonly afterResetsAt?: number;
  readonly changePercentPoints?: number;
  readonly noChangeReason?: QuotaNoChangeReason;
}

export type QuotaNoChangeReason =
  | "no-reading-before"
  | "no-reading-after"
  | "window-duration-changed"
  | "missing-reset-time"
  | "window-reset-during-run"
  | "percentage-decreased";

/**
 * Pairs the readings window by window (bucket id + window name + duration)
 * and computes each change it can vouch for. `before` absent means no
 * baseline was read; every window then says so.
 */
export function observeQuota(
  before: ReadonlyArray<RateLimitSnapshot> | undefined,
  after: ReadonlyArray<RateLimitSnapshot>,
): ReadonlyArray<QuotaWindowObservation> {
  const beforeReadings = indexReadings(before ?? []);
  const afterReadings = indexReadings(after);
  const keys = [...new Set([...afterReadings.keys(), ...beforeReadings.keys()])].sort();
  return keys.map((key) => compareWindow(beforeReadings.get(key), afterReadings.get(key)));
}

/**
 * Codex reports a window's reset time a second or so differently from one
 * reading to the next (seen up to ~10 s); a real reset moves it by about the
 * window's length (hours or days). Differences up to this many seconds are the
 * same window.
 */
export const RESET_JITTER_SECONDS = 120;

interface KeyedReading {
  readonly limitId: string;
  readonly reading: RateLimitWindowReading;
}

function indexReadings(snapshots: ReadonlyArray<RateLimitSnapshot>): Map<string, KeyedReading> {
  const readings = new Map<string, KeyedReading>();
  for (const snapshot of snapshots) {
    for (const reading of snapshot.windows) {
      readings.set(`${snapshot.limitId}\u0000${reading.window}`, { limitId: snapshot.limitId, reading });
    }
  }
  return readings;
}

function compareWindow(before: KeyedReading | undefined, after: KeyedReading | undefined): QuotaWindowObservation {
  const identity = (after ?? before)!;
  const base = {
    limitId: identity.limitId,
    window: identity.reading.window,
    ...(identity.reading.windowMinutes !== undefined ? { windowMinutes: identity.reading.windowMinutes } : {}),
    ...(before !== undefined ? { beforePercent: before.reading.usedPercent } : {}),
    ...(after !== undefined ? { afterPercent: after.reading.usedPercent } : {}),
    ...(before?.reading.resetsAt !== undefined ? { beforeResetsAt: before.reading.resetsAt } : {}),
    ...(after?.reading.resetsAt !== undefined ? { afterResetsAt: after.reading.resetsAt } : {}),
  };
  if (before === undefined) return { ...base, noChangeReason: "no-reading-before" };
  if (after === undefined) return { ...base, noChangeReason: "no-reading-after" };
  if (before.reading.windowMinutes !== after.reading.windowMinutes) {
    return { ...base, noChangeReason: "window-duration-changed" };
  }
  if (before.reading.resetsAt === undefined || after.reading.resetsAt === undefined) {
    return { ...base, noChangeReason: "missing-reset-time" };
  }
  if (Math.abs(after.reading.resetsAt - before.reading.resetsAt) > RESET_JITTER_SECONDS) {
    return { ...base, noChangeReason: "window-reset-during-run" };
  }
  const change = after.reading.usedPercent - before.reading.usedPercent;
  if (change < 0) return { ...base, noChangeReason: "percentage-decreased" };
  return { ...base, changePercentPoints: change };
}
