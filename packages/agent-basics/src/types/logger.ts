// Copied from leanish/leanish-development core/runtime/src/types/logger.ts at e4f8a1e; see PROVENANCE.md.
/**
 * Structured logger surface. Same interface for AWS-mode (CloudWatch via
 * stdout JSON) and local-mode (pretty stdout). Correlation context (agent
 * identifier, requestId) is bound by the runtime before passing to the
 * handler — handlers don't need to thread it through manually.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Returns a child logger that includes the supplied fields on every line. */
  with(fields: LogFields): Logger;
}
