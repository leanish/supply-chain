// Copied from leanish/leanish-development core/runtime/test/unit/schema-subset.test.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`; regressions for the
// nullable-object union and restricted conditional required object (other unions/conditionals still fail).
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

describe("narrow nullable answer schemas", () => {
  it("allows only the object/null union", () => {
    expect(() => assertSubset({ type: ["object", "null"], properties: { title: { type: "string" } } }, "tool")).not.toThrow();
  });

  it.each([["string", "null"], ["object", "string"], ["object", "null", "string"], ["null", "object"]])("rejects other type unions %s", (...types) => {
    expect(() => assertSubset({ type: types }, "tool")).toThrow(EntrypointSchemaError);
  });

  it("allows a discriminator to require one non-null object", () => {
    expect(() => assertSubset({ if: { properties: { outcome: { const: "applied" } } }, then: { required: ["publication"], properties: { publication: { type: "object" } } } }, "tool")).not.toThrow();
  });

  it.each([
    { if: { properties: { outcome: { enum: ["applied"] } } }, then: { required: ["publication"], properties: { publication: { type: "object" } } } },
    { if: { properties: { outcome: { const: "applied" } } } },
    { then: { required: ["publication"], properties: { publication: { type: "object" } } } },
    { if: { properties: { outcome: { const: "applied" } } }, then: { required: ["publication"], properties: { publication: { type: ["object", "null"] } } } },
  ])("rejects general or incomplete conditionals %#", (schema) => {
    expect(() => assertSubset(schema, "tool")).toThrow(EntrypointSchemaError);
  });
});
