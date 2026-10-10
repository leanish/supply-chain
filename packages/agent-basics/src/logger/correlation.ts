// Copied from leanish/leanish-development core/runtime/src/logger/correlation.ts at c6282df; see PROVENANCE.md.
import { AsyncLocalStorage } from "node:async_hooks";

import type { LogFields } from "../types/logger.ts";

/**
 * Async-local correlation context. The dispatcher runs each handler
 * invocation inside `withCorrelation({ requestId, sourceTrigger, stage })`,
 * and every `ConsoleLogger.with(...)` chain reads from this store on each
 * emit. The result: handlers (and anything they call — `runSkill`, the
 * coding-agent runner, etc.) emit log lines carrying the same correlation
 * fields without having to thread a child logger through every call site.
 */
const store = new AsyncLocalStorage<LogFields>();

export function withCorrelation<T>(fields: LogFields, fn: () => Promise<T> | T): Promise<T> | T {
  return store.run(fields, fn);
}

export function getCorrelation(): LogFields | undefined {
  return store.getStore();
}
