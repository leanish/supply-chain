// Copied from leanish/leanish-development core/runtime/test/unit/schema-subset.test.ts at e4f8a1e; see PROVENANCE.md.
import { describe, expect, it } from "vitest";

import { EntrypointSchemaError } from "../src/errors.ts";
import { assertSubset } from "../src/skill/schema-subset.ts";

describe("assertSubset (ADR-0004 schema subset)", () => {
  it("accepts the allowed keyword set", () => {
    expect(() =>
      assertSubset(
        {
          type: "object",
          description: "doc string allowed",
          properties: {
            outcome: { type: "string", enum: ["pr-opened", "no-op"] },
            count: { type: "integer", minimum: 0 },
            url: { type: "string", minLength: 1 },
          },
          required: ["outcome"],
          additionalProperties: false,
        },
        "ask",
      ),
    ).not.toThrow();
  });

  it("rejects combinators", () => {
    expect(() =>
      assertSubset({ type: "object", anyOf: [{ type: "object" }] }, "ask"),
    ).toThrowError(EntrypointSchemaError);
  });

  it("rejects $ref", () => {
    expect(() => assertSubset({ $ref: "#/defs/foo" }, "ask")).toThrowError(
      EntrypointSchemaError,
    );
  });

  it("rejects type: null", () => {
    expect(() => assertSubset({ type: "null" }, "ask")).toThrowError(
      EntrypointSchemaError,
    );
  });

  it("rejects pattern / format", () => {
    expect(() =>
      assertSubset({ type: "string", pattern: "^x$" }, "ask"),
    ).toThrowError(EntrypointSchemaError);
  });

  it("allows annotation keywords without validation effect", () => {
    expect(() =>
      assertSubset(
        {
          type: "object",
          title: "Outcome",
          examples: [{ outcome: "ok" }],
          properties: { outcome: { type: "string", description: "what happened" } },
        },
        "ask",
      ),
    ).not.toThrow();
  });
});
