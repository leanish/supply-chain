// Copied from leanish/leanish-development core/runtime/test/unit/input-render.test.ts at c6282df; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`.
import { describe, expect, it } from "vitest";

import { renderInput } from "../src/skill/input-render.ts";

describe("renderInput", () => {
  it("emits scalars inline and follows schema property order", () => {
    const schema = {
      type: "object",
      properties: {
        question: { type: "string" },
        audience: { type: "string" },
        projectScope: {
          type: "object",
          properties: {
            source: { type: "string" },
            projects: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" } },
              },
            },
          },
        },
      },
    };
    const input = {
      // Intentionally jumbled key order — renderer should reorder.
      projectScope: {
        projects: [{ id: "leanish/atc" }],
        source: "payload-project-ids",
      },
      audience: "codebase",
      question: "What does auth do?",
    };
    expect(renderInput(input, schema)).toBe(
      [
        "question: What does auth do?",
        "audience: codebase",
        "projectScope:",
        "  source: payload-project-ids",
        "  projects:",
        "    - id: leanish/atc",
      ].join("\n"),
    );
  });

  it("omits undefined and null fields", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "string" },
        c: { type: "string" },
      },
    };
    expect(
      renderInput({ a: "x", b: undefined, c: null }, schema),
    ).toBe("a: x");
  });

  it("appends extra keys (not in schema.properties) after declared ones", () => {
    const schema = {
      type: "object",
      properties: { known: { type: "string" } },
    };
    expect(renderInput({ extra: "y", known: "x" }, schema)).toBe(
      "known: x\nextra: y",
    );
  });
});
