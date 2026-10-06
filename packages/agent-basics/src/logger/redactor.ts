// Copied from leanish/leanish-development core/runtime/src/logger/redactor.ts at e4f8a1e; see PROVENANCE.md.
/**
 * Substring-replace each known secret value with `<redacted:NAME>`. Used by
 * the runtime to scrub log lines and captured `EntrypointInvocationError`
 * fields before they leave the process (ADR-0004 §Secret redaction).
 *
 * No regex heuristics — exact-string match against the set of values the
 * runtime *actually loaded* at cold-start (via the needs registry's
 * `secretBacked` env vars). No false positives, no leakage of secrets the
 * runtime never knew about.
 */
export interface SecretEntry {
  /** The env-var name, used to label the redaction placeholder. */
  readonly name: string;
  /** The actual secret bytes/string the runtime loaded. */
  readonly value: string;
}

export class Redactor {
  readonly #entries: ReadonlyArray<SecretEntry>;

  constructor(entries: ReadonlyArray<SecretEntry>) {
    // Sort by descending length so longer matches win when one secret is a
    // substring of another (rare, but predictable).
    this.#entries = [...entries]
      .filter((e) => e.value.length > 0)
      .sort((a, b) => b.value.length - a.value.length);
  }

  redact(text: string): string {
    if (this.#entries.length === 0) return text;
    let out = text;
    for (const entry of this.#entries) {
      if (out.includes(entry.value)) {
        out = out.split(entry.value).join(`<redacted:${entry.name}>`);
      }
    }
    return out;
  }
}

export const NOOP_REDACTOR = new Redactor([]);
