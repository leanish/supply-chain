// Copied from leanish/leanish-development core/runtime/test/unit/synthesize-fixture.test.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`.
import { describe, expect, it } from "vitest";

import { synthesizeFixture } from "../src/skill/synthesize-fixture.ts";

describe("synthesizeFixture", () => {
  it("returns the ask skill's required answer shape", () => {
    const askOutputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: {
        answer: { type: "string", minLength: 1, maxLength: 51200 },
      },
    };
    expect(synthesizeFixture(askOutputSchema)).toEqual({ answer: "fake-fixture" });
  });

  it("respects `const` and `enum` over the type-based defaults", () => {
    expect(synthesizeFixture({ const: "exact" })).toBe("exact");
    expect(synthesizeFixture({ enum: ["a", "b", "c"] })).toBe("a");
  });

  it("respects `minimum` for numbers", () => {
    expect(synthesizeFixture({ type: "number", minimum: 7 })).toBe(7);
    expect(synthesizeFixture({ type: "integer", minimum: 0 })).toBe(0);
    expect(synthesizeFixture({ type: "integer" })).toBe(0);
  });

  it("pads strings to satisfy minLength", () => {
    const v = synthesizeFixture({ type: "string", minLength: 32 });
    expect(typeof v).toBe("string");
    expect((v as string).length).toBeGreaterThanOrEqual(32);
  });

  it("walks nested required properties", () => {
    const schema = {
      type: "object",
      required: ["meta", "items"],
      properties: {
        meta: {
          type: "object",
          required: ["count"],
          properties: { count: { type: "integer" } },
        },
        items: { type: "array" },
      },
    };
    expect(synthesizeFixture(schema)).toEqual({
      meta: { count: 0 },
      items: [],
    });
  });

  it("emits an empty object when no required keys are declared", () => {
    expect(synthesizeFixture({ type: "object" })).toEqual({});
  });
});

describe("FakeCodingAgentRunner default responder", () => {
  it("throws by default when no per-entrypoint response is registered", async () => {
    const { FakeCodingAgentRunner } = await import("../src/skill/fake-runner.ts");
    const { parseSkillFile } = await import("../src/skill/skill-loader.ts");

    const askSkill = parseSkillFile(
      `---
name: ask
inputSchema: { type: object }
outputSchema: { type: object }
---

# ask
`,
      "ask",
      "/synthetic/ask/SKILL.md",
    );

    const runner = new FakeCodingAgentRunner("claude-code");
    await expect(
      runner.run({
        entrypoint: askSkill,
        supportSkills: [],
        renderedArguments: "",
        workingCopies: [],
      }),
    ).rejects.toThrowError(/no response registered for entrypoint 'ask'/);
  });

  it("synthesises a fenced-json response when synthesiseDefault: true is opted into", async () => {
    const { FakeCodingAgentRunner } = await import("../src/skill/fake-runner.ts");
    const { parseSkillFile } = await import("../src/skill/skill-loader.ts");
    const { extractTerminalJson } = await import("../src/skill/output-parse.ts");

    const askSkill = parseSkillFile(
      `---
name: ask
inputSchema:
  type: object
outputSchema:
  type: object
  required: [answer]
  properties:
    answer: { type: string }
---

# ask
`,
      "ask",
      "/synthetic/ask/SKILL.md",
    );

    const runner = new FakeCodingAgentRunner("claude-code", [], { synthesiseDefault: true });
    const result = await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "question: x",
      workingCopies: [],
    });

    const parsed = extractTerminalJson(result.responseText, "ask");
    expect(parsed).toEqual({ answer: "fake-fixture" });
  });

  it("explicit register() takes precedence over the synthesised default", async () => {
    const { FakeCodingAgentRunner } = await import("../src/skill/fake-runner.ts");
    const { parseSkillFile } = await import("../src/skill/skill-loader.ts");

    const askSkill = parseSkillFile(
      `---
name: ask
inputSchema: { type: object }
outputSchema:
  type: object
  required: [answer]
  properties:
    answer: { type: string }
---

# ask
`,
      "ask",
      "/synthetic/ask/SKILL.md",
    );

    const runner = new FakeCodingAgentRunner("claude-code", [], { synthesiseDefault: true });
    runner.register("ask", () => ({
      responseText: '```json\n{"answer":"explicit"}\n```',
    }));
    const result = await runner.run({
      entrypoint: askSkill,
      supportSkills: [],
      renderedArguments: "",
      workingCopies: [],
    });
    expect(result.responseText).toContain('"answer":"explicit"');
  });
});
