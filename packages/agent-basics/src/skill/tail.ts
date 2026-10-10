// Copied from leanish/leanish-development core/runtime/src/skill/tail.ts at c6282df; see PROVENANCE.md.
/** Diagnostic capture cap: each captured tail is bounded to 4 KiB (ADR-0004). */
export const TAIL_BYTES = 4096;

/** Return the last `TAIL_BYTES` bytes of `s` — used for stderr / stdout tails on failures. */
export function tail(s: string): string {
  if (s.length <= TAIL_BYTES) return s;
  return s.slice(-TAIL_BYTES);
}
