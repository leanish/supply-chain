// Copied from leanish/leanish-development core/runtime/test/unit/skill-loader.test.ts at c6282df; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`.
import { describe, expect, it } from "vitest";

import { EntrypointSchemaError } from "../src/errors.ts";
import { parseSkillFile } from "../src/skill/skill-loader.ts";

const ASK_SKILL = `---
description: Answer questions about a codebase
inputSchema:
  type: object
  required: [question]
  properties:
    question: { type: string }
outputSchema:
  type: object
  required: [answer]
  properties:
    answer: { type: string }
compatibleCodingAgents: [claude-code, codex]
---

# ask

You answer questions about a codebase. Respond with a final fenced-json block.
`;

describe("parseSkillFile", () => {
  it("parses frontmatter + body", () => {
    const skill = parseSkillFile(ASK_SKILL, "ask", "/skills/ask/SKILL.md");
    expect(skill.name).toBe("ask");
    expect(skill.description).toBe("Answer questions about a codebase");
    expect(skill.inputSchema).toMatchObject({ type: "object" });
    expect(skill.outputSchema).toMatchObject({ type: "object" });
    expect(skill.compatibleCodingAgents).toEqual(["claude-code", "codex"]);
    expect(skill.body).toContain("# ask");
  });

  it("falls back to a body-only skill when frontmatter is absent", () => {
    const skill = parseSkillFile("Plain text body", "support", "/path");
    expect(skill.body).toBe("Plain text body");
    expect(skill.inputSchema).toBeUndefined();
  });

  it("rejects invalid frontmatter shapes loudly", () => {
    const bad = `---
inputSchema: not-an-object
---

body`;
    expect(() => parseSkillFile(bad, "ask", "/skills/ask/SKILL.md")).toThrowError(
      EntrypointSchemaError,
    );
  });
});
