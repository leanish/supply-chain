// Copied from leanish/leanish-development core/runtime/src/runtime/run-report.ts at c6282df; see PROVENANCE.md.
// Local changes: one tool command instead of a run-local dispatch loop: no dispatch, delayed-message or
// self-publish counts; `tool` and `repo` instead of `agent`; the command's `result` comes with its end.
import { constants } from "node:os";
import { performance } from "node:perf_hooks";

import type { SkillUsageRecord, SkillUsageRecorder } from "../usage/skill-usage-record.ts";
import { totalSkillUsage, type UsageTotals } from "../usage/usage-totals.ts";

/**
 * What one tool command did, for the single `run finished` JSON line it always
 * ends with on stderr — whatever the log level, and on every exit path: a bad
 * argument, a failed startup, a failure, success, or a SIGINT / SIGTERM /
 * SIGHUP (then written before the process dies by that signal). Only SIGKILL
 * (or a crash of Node itself) ends a run without it.
 *
 * `status` describes the command, not the tool's business outcome: a run that
 * found nothing to do, or left a PR for a human, still completed (`ok`); what
 * it did goes in `result`.
 */
export interface RunFinished {
  readonly ts: string;
  readonly level: "info" | "error";
  readonly msg: "run finished";
  readonly tool?: string;
  /** `owner/repo`. */
  readonly repo?: string;
  readonly status: RunStatus;
  readonly exitCode: number;
  readonly error?: string;
  readonly signal?: string;
  /** Wall time of the whole command on a monotonic clock. */
  readonly durationMs: number;
  /** What the command did (the PR it opened, the findings it fixed…), as the tool reports it. */
  readonly result?: Readonly<Record<string, unknown>>;
  /** One record per finished skill run (`runSkill` call that reached its runner), in completion order. */
  readonly skills: ReadonlyArray<SkillUsageRecord>;
  readonly totals: UsageTotals;
}

export type RunStatus = "ok" | "error" | "interrupted";

export interface RunEnd {
  readonly status: RunStatus;
  readonly exitCode: number;
  readonly error?: string;
  readonly signal?: NodeJS.Signals;
  readonly result?: Readonly<Record<string, unknown>>;
}

/** Accumulates one command's facts; scoped to that command. */
export class RunReport {
  readonly #startedAt = performance.now();
  readonly #clock: () => string;
  readonly #skills: SkillUsageRecord[] = [];
  /** Skill runs that reached their runner and have no record yet. */
  readonly #inFlight = new Set<string>();
  #tool: string | undefined;
  #repo: string | undefined;
  #finished = false;

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.#clock = clock;
  }

  /** Names the tool and repository once the command's arguments are read. */
  identified(tool: string, repo: string): void {
    this.#tool = tool;
    this.#repo = repo;
  }

  /** For `SkillContext.usageRecorder`. */
  readonly usageRecorder: SkillUsageRecorder = {
    started: (run) => {
      this.#inFlight.add(run.invocationId);
    },
    record: (record) => {
      this.#inFlight.delete(record.invocationId);
      this.#skills.push(record);
    },
  };

  /** The final line, once: later calls (a signal racing the normal end) get undefined. */
  finish(end: RunEnd): string | undefined {
    if (this.#finished) return undefined;
    this.#finished = true;
    const totals = totalSkillUsage(this.#skills, this.#inFlight.size);
    const line: RunFinished = {
      ts: this.#clock(),
      level: end.status === "ok" ? "info" : "error",
      msg: "run finished",
      ...(this.#tool !== undefined ? { tool: this.#tool } : {}),
      ...(this.#repo !== undefined ? { repo: this.#repo } : {}),
      status: end.status,
      exitCode: end.exitCode,
      ...(end.error !== undefined ? { error: end.error } : {}),
      ...(end.signal !== undefined ? { signal: end.signal } : {}),
      durationMs: Math.round(performance.now() - this.#startedAt),
      ...(end.result !== undefined ? { result: end.result } : {}),
      skills: [...this.#skills],
      totals,
    };
    return `${JSON.stringify(line)}\n`;
  }
}

/** Writes `line` and resolves once it's handed to the OS, so an exit right after can't drop it. */
export function writeFinalLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  return new Promise((done) => {
    stream.write(line, () => done());
  });
}

const REPORTED_SIGNALS: ReadonlyArray<NodeJS.Signals> = ["SIGINT", "SIGTERM", "SIGHUP"];
/** How long a final line may take to flush before the signal is raised anyway. */
const SIGNAL_FLUSH_MS = 2_000;

/**
 * While a command runs, a SIGINT / SIGTERM / SIGHUP first writes its final
 * line (`interrupted`, exit code 128 + the signal's number), then is raised
 * again with this listener gone, so the process ends by the signal as it
 * would have without it (a running coding agent's own signal forwarding, in
 * `spawnCapture`, still kills its process group). Returns the function that
 * stops listening.
 */
export function reportOnTerminationSignals(report: RunReport, stream: NodeJS.WritableStream): () => void {
  let handling = false;
  const listener = (signal: NodeJS.Signals): void => {
    if (handling) return;
    handling = true;
    let raised = false;
    const raise = (): void => {
      if (raised) return;
      raised = true;
      stop();
      process.kill(process.pid, signal);
    };
    const line = report.finish({
      status: "interrupted",
      exitCode: 128 + (constants.signals[signal] ?? 0),
      signal,
      error: `stopped by ${signal}`,
    });
    if (line === undefined) {
      raise();
      return;
    }
    const fallback = setTimeout(raise, SIGNAL_FLUSH_MS);
    stream.write(line, () => {
      clearTimeout(fallback);
      raise();
    });
  };
  const stop = (): void => {
    for (const signal of REPORTED_SIGNALS) process.removeListener(signal, listener);
  };
  for (const signal of REPORTED_SIGNALS) process.on(signal, listener);
  return stop;
}
