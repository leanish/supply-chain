// Copied from leanish/leanish-development core/runtime/src/logger/console-logger.ts at e4f8a1e; see PROVENANCE.md.
import { getCorrelation } from "./correlation.ts";
import { NOOP_REDACTOR, Redactor } from "./redactor.ts";
import type { Logger, LogFields, LogLevel } from "../types/logger.ts";

/**
 * JSON-line structured logger. Same output shape in AWS mode (CloudWatch
 * tails stdout) and local mode (humans can read it; `jq`-friendly).
 *
 * On every emit, merges the async-local correlation context (set by the
 * dispatcher's `withCorrelation(...)`) so handler-emitted lines and
 * runtime-emitted lines share the same request/stage fields without the
 * handler having to thread a child logger through every call.
 *
 * Lines are passed through the optional `Redactor` before writing, which
 * substring-replaces known `secretBacked` env-var values with
 * `<redacted:NAME>` placeholders (ADR-0004 §Secret redaction).
 *
 * Production users may wrap this with a colourising pretty-printer in
 * local mode; the JSON output is the canonical shape so downstream tools
 * (logs queries, alerting) parse the same content everywhere.
 */
export interface ConsoleLoggerOptions {
  readonly minLevel?: LogLevel;
  readonly clock?: () => string; // ISO 8601; defaults to `new Date().toISOString()`.
  readonly stream?: NodeJS.WritableStream; // defaults to `process.stdout`.
  readonly redactor?: Redactor;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class ConsoleLogger implements Logger {
  readonly #context: LogFields;
  readonly #minLevel: LogLevel;
  readonly #clock: () => string;
  readonly #stream: NodeJS.WritableStream;
  readonly #redactor: Redactor;

  constructor(options: ConsoleLoggerOptions = {}, context: LogFields = {}) {
    this.#context = context;
    this.#minLevel = options.minLevel ?? "info";
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#stream = options.stream ?? process.stdout;
    this.#redactor = options.redactor ?? NOOP_REDACTOR;
  }

  debug(msg: string, fields?: LogFields): void {
    this.#emit("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.#emit("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.#emit("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.#emit("error", msg, fields);
  }

  with(fields: LogFields): Logger {
    return new ConsoleLogger(
      {
        minLevel: this.#minLevel,
        clock: this.#clock,
        stream: this.#stream,
        redactor: this.#redactor,
      },
      { ...this.#context, ...fields },
    );
  }

  #emit(level: LogLevel, msg: string, fields: LogFields | undefined): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#minLevel]) return;
    const correlation = getCorrelation() ?? {};
    const line = {
      ts: this.#clock(),
      level,
      msg,
      ...this.#context,
      ...correlation,
      ...(fields ?? {}),
    };
    const serialized = JSON.stringify(line);
    this.#stream.write(`${this.#redactor.redact(serialized)}\n`);
  }
}
