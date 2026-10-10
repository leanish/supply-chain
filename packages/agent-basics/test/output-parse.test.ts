// Copied from leanish/leanish-development core/runtime/test/unit/output-parse.test.ts at c6282df; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`.
import { describe, expect, it } from "vitest";

import { EntrypointInvocationError } from "../src/errors.ts";
import { extractTerminalJson } from "../src/skill/output-parse.ts";

describe("extractTerminalJson", () => {
  it("returns the parsed final fenced-json block", () => {
    const text = [
      "<thinking>let me see…</thinking>",
      "",
      "Here is the result:",
      "",
      "```json",
      '{"answer": 42}',
      "```",
    ].join("\n");
    expect(extractTerminalJson(text, "ask")).toEqual({ answer: 42 });
  });

  it("picks the LAST json block when multiple are present", () => {
    const text = [
      "First an example:",
      "```json",
      '{"sample": true}',
      "```",
      "And the actual answer:",
      "```json",
      '{"answer": 7}',
      "```",
    ].join("\n");
    expect(extractTerminalJson(text, "ask")).toEqual({ answer: 7 });
  });

  it("throws missing-terminal-json-block when none is present", () => {
    expect(() => extractTerminalJson("no json here", "ask")).toThrowError(
      EntrypointInvocationError,
    );
  });

  it("throws trailing-content-after-final-json when post-block text exists", () => {
    const text = [
      "```json",
      '{"answer": 1}',
      "```",
      "oops, more text",
    ].join("\n");
    try {
      extractTerminalJson(text, "ask");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EntrypointInvocationError);
      const ei = err as EntrypointInvocationError;
      expect(ei.reason).toBe("trailing-content-after-final-json");
      // The user-visible message embeds an excerpt of the offending tail
      // (quoted via JSON.stringify so newlines/quotes are visible).
      expect(ei.message).toContain('"oops, more text"');
      // The 4 KiB-capped full tail still lives on `captured` for deeper debugging.
      expect((ei.captured as { trailingContent?: string })?.trailingContent).toContain("oops, more text");
    }
  });

  it("elides the excerpt when the trailing content is longer than the message cap", () => {
    const huge = "x".repeat(400);
    const text = ["```json", '{"answer": 1}', "```", huge].join("\n");
    try {
      extractTerminalJson(text, "ask");
      expect.unreachable();
    } catch (err) {
      expect((err as EntrypointInvocationError).message).toMatch(/elided/);
    }
  });

  it("throws json-parse-fail when the block isn't valid JSON", () => {
    const text = ["```json", "{not-json", "```"].join("\n");
    try {
      extractTerminalJson(text, "ask");
      expect.unreachable();
    } catch (err) {
      expect((err as EntrypointInvocationError).reason).toBe("json-parse-fail");
    }
  });
});
