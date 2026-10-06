// Copied from leanish/leanish-development core/runtime/src/errors.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: only the classes the copied modules use; parameter properties written as fields.

/**
 * Common base — every runtime-thrown error extends this so callers can
 * branch on `instanceof RuntimeError` without listing each subclass.
 */
export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Startup-time failure for an Entry-point Skill with missing or invalid
 * `inputSchema` / `outputSchema`.
 */
export class EntrypointSchemaError extends RuntimeError {
  readonly entrypoint: string;

  constructor(entrypoint: string, message: string) {
    super(`Entry-point skill '${entrypoint}' schema invalid: ${message}`);
    this.entrypoint = entrypoint;
  }
}

/**
 * A concrete skill call failed the entrypoint contract. Locked reason set.
 */
export class EntrypointInvocationError extends RuntimeError {
  readonly reason: EntrypointInvocationReason;
  readonly entrypoint: string;
  readonly schemaErrors: ReadonlyArray<SchemaErrorItem> | undefined;
  #captured: EntrypointInvocationCapture | undefined;

  constructor(
    reason: EntrypointInvocationReason,
    entrypoint: string,
    message: string,
    schemaErrors?: ReadonlyArray<SchemaErrorItem>,
    captured?: EntrypointInvocationCapture,
  ) {
    super(message);
    this.reason = reason;
    this.entrypoint = entrypoint;
    this.schemaErrors = schemaErrors;
    this.#captured = captured;
  }

  /** Diagnostic capture bag (terminal JSON block, trailing content, stdout/stderr tails). */
  get captured(): EntrypointInvocationCapture | undefined {
    return this.#captured;
  }

  /**
   * Merge a stderr tail into the capture bag after construction. The parse
   * step that throws this error only sees stdout; the skill call merges in the
   * runner's stderr tail here so the class — not an external cast — owns the
   * mutation of its own diagnostic state.
   */
  attachStderrTail(stderrTail: string): void {
    if (stderrTail.length === 0) return;
    this.#captured = { ...(this.#captured ?? {}), stderrTail };
  }
}

export type EntrypointInvocationReason =
  | "entrypoint-not-declared"
  | "write-without-working-copy"
  | "input-validation-fail"
  | "missing-terminal-json-block"
  | "trailing-content-after-final-json"
  | "json-parse-fail"
  | "output-validation-fail";

export interface SchemaErrorItem {
  readonly pointer: string;
  readonly keyword: string;
  readonly message: string;
}

export interface EntrypointInvocationCapture {
  readonly jsonBlock?: string;
  readonly trailingContent?: string;
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
}
