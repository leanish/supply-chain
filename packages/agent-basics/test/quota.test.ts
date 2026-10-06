// Copied from leanish/leanish-development core/runtime/test/unit/quota.test.ts at e4f8a1e; see PROVENANCE.md.
import { describe, expect, it } from "vitest";

import { observeQuota, RESET_JITTER_SECONDS, type RateLimitSnapshot } from "../src/usage/quota.ts";

const RESET = 1_900_000_000;

function bucket(limitId: string, usedPercent: number, overrides: { windowMinutes?: number; resetsAt?: number | null } = {}): RateLimitSnapshot {
  const resetsAt = overrides.resetsAt === undefined ? RESET : overrides.resetsAt;
  return {
    limitId,
    windows: [
      {
        window: "primary",
        usedPercent,
        windowMinutes: overrides.windowMinutes ?? 300,
        ...(resetsAt !== null ? { resetsAt } : {}),
      },
    ],
  };
}

describe("observeQuota", () => {
  it("reports the percentage-point change of a window that stayed the same", () => {
    expect(observeQuota([bucket("codex", 40)], [bucket("codex", 43, { resetsAt: RESET + 1 })])).toEqual([
      {
        limitId: "codex",
        window: "primary",
        windowMinutes: 300,
        beforePercent: 40,
        afterPercent: 43,
        beforeResetsAt: RESET,
        afterResetsAt: RESET + 1,
        changePercentPoints: 3,
      },
    ]);
  });

  it("reports +0 for an unchanged whole-number percentage", () => {
    expect(observeQuota([bucket("codex", 40)], [bucket("codex", 40)])[0]?.changePercentPoints).toBe(0);
  });

  it.each([
    ["the window reset during the run", [bucket("codex", 90)], [bucket("codex", 2, { resetsAt: RESET + 18_000 })], "window-reset-during-run"],
    ["a reset time is missing", [bucket("codex", 40, { resetsAt: null })], [bucket("codex", 41)], "missing-reset-time"],
    ["the percentage went down", [bucket("codex", 40)], [bucket("codex", 39)], "percentage-decreased"],
    ["the window's duration changed", [bucket("codex", 40)], [bucket("codex", 41, { windowMinutes: 60 })], "window-duration-changed"],
  ])("gives no change when %s", (_case, before, after, reason) => {
    const [observation] = observeQuota(before, after);
    expect(observation?.changePercentPoints).toBeUndefined();
    expect(observation?.noChangeReason).toBe(reason);
  });

  it("treats a reset time moving by more than the jitter as a reset", () => {
    const [observation] = observeQuota([bucket("codex", 40)], [bucket("codex", 41, { resetsAt: RESET + RESET_JITTER_SECONDS + 1 })]);
    expect(observation?.noChangeReason).toBe("window-reset-during-run");
  });

  it("matches buckets by id: a bucket seen only on one side has no change", () => {
    expect(observeQuota([bucket("premium", 5)], [bucket("codex", 41)]).map((o) => [o.limitId, o.noChangeReason])).toEqual([
      ["codex", "no-reading-before"],
      ["premium", "no-reading-after"],
    ]);
  });

  it("says so for every window when there was no baseline", () => {
    expect(observeQuota(undefined, [bucket("codex", 41)])[0]).toMatchObject({ afterPercent: 41, noChangeReason: "no-reading-before" });
  });
});
