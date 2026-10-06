// Copied from leanish/leanish-development core/runtime/src/skill/codex-usage-meter.ts at e4f8a1e; see PROVENANCE.md.
import { performance } from "node:perf_hooks";

import { observeQuota, type QuotaUsage } from "../usage/quota.ts";
import { type SkillUsage, sumTokens, ZERO_TOKENS } from "../usage/skill-usage.ts";
import type { QuotaBaseline } from "./codex-quota-baseline.ts";
import { parseRollouts, readRolloutFiles, type RolloutUsage } from "./codex-rollouts.ts";

/**
 * Collects what one `CodexRunner.run` attempt consumed while it runs, and
 * turns it into the attempt's `SkillUsage`. Lives exactly as long as the
 * attempt; nothing here ever throws into the run.
 *
 *   - no `codex exec` started (a failure before it, e.g. staging, login or the
 *     budget): zero tokens, complete — no provider call was made;
 *   - otherwise: tokens from the staged home's session files (read before the
 *     home is removed), complete only when the CLI exited normally and every
 *     file parsed cleanly; quota from the app-server reading before the run
 *     and the session files' latest readings.
 */
export class CodexUsageMeter {
  readonly #startedAt = performance.now();
  readonly #requestedModel: string | undefined;
  #model: string | undefined;
  #baseline: QuotaBaseline | undefined;
  #baselineGap: string | undefined;
  #execStarted = false;
  #execSucceeded = false;
  #rollouts: RolloutUsage | undefined;
  #rolloutsGap: string | undefined;

  constructor(requestedModel: string | undefined) {
    this.#requestedModel = requestedModel;
  }

  modelResolved(model: string | undefined): void {
    this.#model = model;
  }

  baselineRead(baseline: QuotaBaseline): void {
    this.#baseline = baseline;
  }

  baselineFailed(err: unknown): void {
    this.#baselineGap = `no quota reading before the run: ${err instanceof Error ? err.message : String(err)}`;
  }

  execStarted(): void {
    this.#execStarted = true;
  }

  execSucceeded(): void {
    this.#execSucceeded = true;
  }

  /** Reads the session files under the staged home; call before the home is removed. Never throws. */
  async collectRollouts(codexHome: string): Promise<void> {
    if (!this.#execStarted) return;
    try {
      this.#rollouts = parseRollouts(await readRolloutFiles(codexHome), this.#model ?? this.#requestedModel);
    } catch (err) {
      this.#rolloutsGap = `Codex's session files couldn't be read: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  snapshot(): SkillUsage {
    const base = {
      codingAgent: "codex",
      ...(this.#requestedModel !== undefined ? { requestedModel: this.#requestedModel } : {}),
      ...(this.#model !== undefined ? { model: this.#model } : {}),
      durationMs: Math.round(performance.now() - this.#startedAt),
      synthetic: false,
    };
    if (!this.#execStarted) {
      return {
        ...base,
        measurement: "complete",
        tokens: ZERO_TOKENS,
        models: [],
        quota: { status: "not-applicable", reason: "no provider call was made" },
        gaps: [],
      };
    }

    const gaps: string[] = [];
    if (!this.#execSucceeded) {
      gaps.push("Codex didn't finish normally (failed, timed out or was stopped); the counts cover what it recorded before that");
    }
    if (this.#rolloutsGap !== undefined) gaps.push(this.#rolloutsGap);
    const rollouts = this.#rollouts;
    if (rollouts !== undefined) gaps.push(...rollouts.gaps);
    const quota = this.#quota(rollouts, gaps);
    const measured = rollouts !== undefined && rollouts.sessions > 0;
    return {
      ...base,
      measurement: this.#execSucceeded && rollouts?.clean === true ? "complete" : "partial",
      ...(measured ? { tokens: sumTokens(rollouts.models.map((entry) => entry.tokens)) } : {}),
      models: rollouts?.models ?? [],
      quota,
      gaps,
    };
  }

  #quota(rollouts: RolloutUsage | undefined, gaps: string[]): QuotaUsage {
    const after = rollouts?.rateLimits ?? [];
    const baseline = this.#baseline;
    if (after.length === 0 && baseline?.accountType === "apiKey") {
      return { status: "not-applicable", reason: "Codex ran with an API-key login, which has no subscription quota" };
    }
    if (this.#baselineGap !== undefined) gaps.push(this.#baselineGap);
    if (after.length === 0 && (baseline === undefined || baseline.snapshots.length === 0)) {
      gaps.push("no rate-limit reading, so no quota change");
      return { status: "unavailable" };
    }
    const planType = after.find((snapshot) => snapshot.planType !== undefined)?.planType ?? baseline?.planType;
    return {
      status: "observed",
      approximate: true,
      ...(planType !== undefined ? { planType } : {}),
      windows: observeQuota(baseline?.snapshots, after),
    };
  }
}
