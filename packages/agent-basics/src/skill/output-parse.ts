// Copied from leanish/leanish-development core/runtime/src/skill/output-parse.ts at e4f8a1e; see PROVENANCE.md.
import { EntrypointInvocationError } from "../errors.ts";

import { tail } from "./tail.ts";

/**
 * Extract + parse the terminal fenced-`json` block from an Entry-point
 * Skill's response. Per ADR-0004:
 *
 *   - The block must be the final non-whitespace content of the response.
 *   - Text before the final JSON block is allowed (reasoning / debugging).
 *   - Text after the final JSON block is an invocation failure
 *     (`trailing-content-after-final-json`).
 *
 * Returns the parsed JSON value (still unchecked against `outputSchema`;
 * the caller does that next).
 */
export function extractTerminalJson(
  responseText: string,
  entrypoint: string,
): unknown {
  const blocks = [...findJsonFences(responseText)];
  if (blocks.length === 0) {
    throw new EntrypointInvocationError(
      "missing-terminal-json-block",
      entrypoint,
      "Entry-point skill response is missing a fenced-json block",
      undefined,
      { stdoutTail: tail(responseText) },
    );
  }
  const last = blocks[blocks.length - 1]!;
  const trailing = responseText.slice(last.endOffset);
  if (trailing.trim().length > 0) {
    // Surface a short excerpt of the offending tail in the message itself —
    // logs are searchable on that string, and a one-line failure is easier
    // to triage than "see captured field". The full (4 KiB-capped) tail is
    // still on `captured.trailingContent` for in-depth debugging.
    const excerpt = trailing.trim().slice(0, MESSAGE_TAIL_BYTES);
    const elided = trailing.trim().length > MESSAGE_TAIL_BYTES ? " (…elided)" : "";
    throw new EntrypointInvocationError(
      "trailing-content-after-final-json",
      entrypoint,
      `Entry-point skill response had content after its final fenced-json block: ${JSON.stringify(excerpt)}${elided}`,
      undefined,
      {
        jsonBlock: last.body,
        trailingContent: tail(trailing),
      },
    );
  }
  try {
    return JSON.parse(last.body);
  } catch (err) {
    throw new EntrypointInvocationError(
      "json-parse-fail",
      entrypoint,
      `Entry-point skill response's final fenced-json block did not parse: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      { jsonBlock: last.body },
    );
  }
}

interface JsonFence {
  readonly body: string;
  readonly endOffset: number;
}

/**
 * Find every ```json ... ``` block. Tolerates whitespace + newline
 * variations and language tags written `json`, `JSON`, `Json`.
 */
function* findJsonFences(text: string): Generator<JsonFence> {
  const re = /```[ \t]*json[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    yield {
      body: match[1] ?? "",
      endOffset: match.index + match[0].length,
    };
  }
}

const MESSAGE_TAIL_BYTES = 200; // user-visible message; deeper detail lives on `captured`
