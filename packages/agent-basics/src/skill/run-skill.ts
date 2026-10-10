// Copied from leanish/leanish-development core/runtime/src/skill/run-skill.ts at c6282df; see PROVENANCE.md.
// Local changes: the agent descriptor, `needs` and the target-credentials resolver are replaced by `SkillContext`
// (the tool's entrypoints and support skills) and `SkillCall` (coding agent, model, effort, access and the
// credential env, all from the tool's config).
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { EntrypointInvocationError } from "../errors.ts";
import { getCorrelation } from "../logger/correlation.ts";
import type { SecretEntry } from "../logger/redactor.ts";
import type { Access } from "../types/access.ts";
import type { Logger } from "../types/logger.ts";
import type { WorkingCopy } from "../types/working-copy.ts";
import { estimateApiCost } from "../usage/api-cost.ts";
import type { ModelPriceTable } from "../usage/model-prices.ts";
import {
  type SkillUsageOutcome,
  type SkillUsageRecorder,
  toSkillUsageRecord,
  unreportedSkillUsage,
} from "../usage/skill-usage-record.ts";
import type { SkillUsage } from "../usage/skill-usage.ts";

import { renderInput } from "./input-render.ts";
import { extractTerminalJson } from "./output-parse.ts";
import type { CodingAgentRunner } from "./runner.ts";
import type { SkillLoader } from "./skill-loader.ts";
import { SchemaValidator } from "./validator.ts";

/**
 * Orchestration around a single skill call:
 *
 *   1. Resolve the entrypoint name against the tool's entrypoints; reject
 *      early if absent.
 *   2. Load the Entry-point Skill (cached) + every Support Skill.
 *   3. Validate `input` against the Entry-point Skill's `inputSchema`.
 *   4. Render `input` as YAML (deterministic key order).
 *   5. Hand off to the coding agent's `CodingAgentRunner`.
 *   6. Extract the terminal fenced-`json` block from the response.
 *   7. Validate the parsed value against `outputSchema`.
 *   8. Return the typed result.
 *
 * Every call that reaches the runner (5) ends with one usage record — also
 * when the runner fails or its answer is rejected in 6–7: logged as
 * `runSkill usage` and handed to `usageRecorder`, independently of each other
 * and of the log level. Neither can change the call's outcome.
 */
export interface SkillContext {
  /** The entry-point skills the tool may call. */
  readonly entrypoints: ReadonlyArray<string>;
  /** Support skills staged next to every entrypoint. */
  readonly supportSkills: ReadonlyArray<string>;
  readonly skillLoader: SkillLoader;
  readonly runnerFor: (codingAgent: string) => CodingAgentRunner;
  readonly validator: SchemaValidator;
  readonly logger: Logger;
  /** Prices for the usage record's API-cost estimate; absent: the estimate is a gap. */
  readonly modelPrices?: ModelPriceTable;
  /** Told of each call as it reaches the runner, then gets its usage record. */
  readonly usageRecorder?: SkillUsageRecorder;
}

export interface SkillCall<TInput> {
  readonly entrypoint: string;
  readonly input: TInput;
  readonly workingCopies: ReadonlyArray<WorkingCopy>;
  readonly codingAgent: string;
  readonly model?: string;
  readonly effort?: string;
  readonly access: Access;
  /** Env for the agent's commands (its read-only GitHub token, say), with the secret values among it. */
  readonly credentials?: { readonly env: Readonly<Record<string, string>>; readonly secrets: ReadonlyArray<SecretEntry> };
}

export async function runSkill<TInput, TOutput>(ctx: SkillContext, call: SkillCall<TInput>): Promise<TOutput> {
  const { skillLoader, runnerFor, validator, logger } = ctx;

  if (!ctx.entrypoints.includes(call.entrypoint)) {
    logEntrypointFailure(logger, "warn", call.entrypoint, "entrypoint-not-declared");
    throw new EntrypointInvocationError(
      "entrypoint-not-declared",
      call.entrypoint,
      `entrypoint '${call.entrypoint}' is not one of the tool's entrypoints`,
    );
  }

  const entrypoint = await skillLoader.loadEntrypoint(call.entrypoint);
  const supportSkills = await Promise.all(ctx.supportSkills.map((name) => skillLoader.load(name)));

  const inputErrors = validator.validate(entrypoint.inputSchema!, call.input);
  if (inputErrors.length > 0) {
    logEntrypointFailure(logger, "error", call.entrypoint, "input-validation-fail", {
      schemaErrors: inputErrors,
    });
    throw new EntrypointInvocationError(
      "input-validation-fail",
      call.entrypoint,
      `input failed validation against ${call.entrypoint}.inputSchema`,
      inputErrors,
    );
  }

  // A write agent only writes in mounted working copies; without one there is nowhere it may write.
  if (call.access === "write" && call.workingCopies.length === 0) {
    logEntrypointFailure(logger, "error", call.entrypoint, "write-without-working-copy");
    throw new EntrypointInvocationError(
      "write-without-working-copy",
      call.entrypoint,
      `entrypoint '${call.entrypoint}' runs with access 'write' and needs at least one working copy`,
    );
  }

  const renderedArguments = renderInput(call.input, entrypoint.inputSchema);
  const runner = runnerFor(call.codingAgent);
  const credentials = call.credentials;

  const invocationId = randomUUID();
  const startedAt = performance.now();
  let usage: SkillUsage | undefined;
  let outcome: SkillUsageOutcome = "runner-failed";
  try {
    reportSkillRunStart(ctx, { invocationId, entrypoint: call.entrypoint });
    const { responseText, stderrTail, model: resolvedModel } = await runner.run({
      entrypoint,
      supportSkills,
      renderedArguments,
      workingCopies: call.workingCopies,
      ...(call.model !== undefined ? { model: call.model } : {}),
      ...(call.effort !== undefined ? { effort: call.effort } : {}),
      ...(credentials !== undefined && Object.keys(credentials.env).length > 0
        ? { env: credentials.env, secrets: credentials.secrets }
        : {}),
      access: call.access,
      onUsage: (reported) => {
        if (usage === undefined) usage = reported;
        else logger.warn("runSkill usage reported twice; keeping the first", { entrypoint: call.entrypoint, invocationId });
      },
    });
    outcome = "output-rejected";

    if (resolvedModel !== undefined) {
      logger.info("runSkill model resolved", { entrypoint: call.entrypoint, requested: call.model, model: resolvedModel });
    }
    const output = parseOutput<TOutput>(ctx, call.entrypoint, entrypoint.outputSchema!, responseText, stderrTail);
    outcome = "succeeded";
    return output;
  } finally {
    recordSkillUsage(ctx, usage ?? unreportedSkillUsage(call.codingAgent, Math.round(performance.now() - startedAt), call.model), {
      invocationId,
      entrypoint: call.entrypoint,
      outcome,
    });
  }
}

/** Steps 6–7: the terminal JSON block, validated against `outputSchema`. */
function parseOutput<TOutput>(
  ctx: SkillContext,
  entrypointName: string,
  outputSchema: object,
  responseText: string,
  stderrTail: string | undefined,
): TOutput {
  const { validator, logger } = ctx;
  let parsed: unknown;
  try {
    parsed = extractTerminalJson(responseText, entrypointName);
  } catch (err) {
    if (err instanceof EntrypointInvocationError) {
      if (stderrTail !== undefined) err.attachStderrTail(stderrTail);
      logEntrypointFailure(logger, "error", entrypointName, err.reason, {
        captured: err.captured,
      });
    }
    throw err;
  }

  const outputErrors = validator.validate(outputSchema, parsed);
  if (outputErrors.length > 0) {
    logEntrypointFailure(logger, "error", entrypointName, "output-validation-fail", {
      schemaErrors: outputErrors,
    });
    throw new EntrypointInvocationError(
      "output-validation-fail",
      entrypointName,
      `entrypoint '${entrypointName}' returned a JSON block that failed outputSchema validation`,
      outputErrors,
      { jsonBlock: JSON.stringify(parsed) },
    );
  }

  return parsed as TOutput;
}

/** Tells the recorder a call is reaching its runner; a failing recorder is logged, never thrown. */
function reportSkillRunStart(ctx: SkillContext, run: { readonly invocationId: string; readonly entrypoint: string }): void {
  try {
    ctx.usageRecorder?.started?.(run);
  } catch (err) {
    try {
      ctx.logger.warn("runSkill usage recorder failed", {
        invocationId: run.invocationId,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // Nothing left to report it to.
    }
  }
}

/**
 * Logs the call's usage record and hands it to the recorder, each on its own:
 * neither a failing logger nor a failing recorder stops the other or reaches
 * the caller.
 */
function recordSkillUsage(
  ctx: SkillContext,
  usage: SkillUsage,
  context: { readonly invocationId: string; readonly entrypoint: string; readonly outcome: SkillUsageOutcome },
): void {
  const correlation = getCorrelation() ?? {};
  const requestId = typeof correlation["requestId"] === "string" ? correlation["requestId"] : undefined;
  const stage = typeof correlation["stage"] === "string" ? correlation["stage"] : undefined;
  const record = toSkillUsageRecord(
    usage,
    {
      ...context,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(stage !== undefined ? { stage } : {}),
    },
    estimateApiCost(usage, ctx.modelPrices),
  );
  try {
    ctx.logger.info("runSkill usage", { ...record });
  } catch {
    // Logging is best effort here; the recorder below still gets the record.
  }
  if (ctx.usageRecorder === undefined) return;
  try {
    ctx.usageRecorder.record(record);
  } catch (err) {
    try {
      ctx.logger.warn("runSkill usage recorder failed", {
        invocationId: record.invocationId,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // Nothing left to report it to.
    }
  }
}

function logEntrypointFailure(
  logger: Logger,
  level: "warn" | "error",
  entrypoint: string,
  reason: string,
  extra: Record<string, unknown> = {},
): void {
  const fields = { entrypoint, reason, ...extra };
  if (level === "warn") {
    logger.warn("runSkill failed", fields);
  } else {
    logger.error("runSkill failed", fields);
  }
}
