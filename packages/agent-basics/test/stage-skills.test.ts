// Copied from leanish/leanish-development core/runtime/test/unit/stage-skills.test.ts at c6282df; see PROVENANCE.md.
// Local changes: imports this package's modules from `../src/` instead of `../../src/`.
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { SkillLoader } from "../src/skill/skill-loader.ts";
import { stageSkills } from "../src/skill/stage-skills.ts";

const ASK_SKILL_FILE = `---
name: ask
description: Test ask skill.
compatibleCodingAgents: [claude-code, codex]
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
---

# ask

Answer the question.
`;

const KARPATHY_FILE = `---
name: karpathy-guidelines
description: Behavioural guidelines.
---

# karpathy-guidelines

Always-on support.
`;

describe("stageSkills (byte-identical via fs.cp)", () => {
  let skillsDir: string;
  let loader: SkillLoader;

  beforeAll(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), "agent-runtime-staging-src-"));
    await mkdir(join(skillsDir, "ask"), { recursive: true });
    await writeFile(join(skillsDir, "ask", "SKILL.md"), ASK_SKILL_FILE);
    // A companion file that should also be copied — `fs.cp` is recursive.
    await writeFile(join(skillsDir, "ask", "examples.md"), "# examples\n");
    await mkdir(join(skillsDir, "karpathy-guidelines"), { recursive: true });
    await writeFile(join(skillsDir, "karpathy-guidelines", "SKILL.md"), KARPATHY_FILE);
    loader = new SkillLoader({ skillsDirs: [skillsDir] });
  });

  it("writes the canonical plugin layout with manifest + skills (byte-identical)", async () => {
    const ask = await loader.loadEntrypoint("ask");
    const karpathy = await loader.load("karpathy-guidelines");
    const staged = await stageSkills({
      entrypoint: ask,
      supportSkills: [karpathy],
    });
    try {
      // Manifest
      const manifestRaw = await readFile(
        join(staged.dir, ".claude-plugin", "plugin.json"),
        "utf8",
      );
      expect(JSON.parse(manifestRaw)).toMatchObject({
        name: "agent-runtime-staged",
        version: "0.0.0",
        author: { name: "leanish" },
      });

      // Entrypoint skill — byte-identical to source.
      const stagedAsk = await readFile(
        join(staged.dir, "skills", "ask", "SKILL.md"),
        "utf8",
      );
      expect(stagedAsk).toBe(ASK_SKILL_FILE);

      // Companion file came along for the ride.
      const stagedExamples = await readFile(
        join(staged.dir, "skills", "ask", "examples.md"),
        "utf8",
      );
      expect(stagedExamples).toBe("# examples\n");

      // Support skill — byte-identical.
      const stagedKarpathy = await readFile(
        join(staged.dir, "skills", "karpathy-guidelines", "SKILL.md"),
        "utf8",
      );
      expect(stagedKarpathy).toBe(KARPATHY_FILE);
    } finally {
      await staged.cleanup();
    }
  });

  it("dedups skills that appear in both entrypoint and support arrays", async () => {
    const ask = await loader.loadEntrypoint("ask");
    const karpathy = await loader.load("karpathy-guidelines");
    const staged = await stageSkills({
      entrypoint: ask,
      supportSkills: [ask, karpathy], // ask listed twice
    });
    try {
      await expect(
        stat(join(staged.dir, "skills", "ask", "SKILL.md")),
      ).resolves.toBeDefined();
      await expect(
        stat(join(staged.dir, "skills", "karpathy-guidelines", "SKILL.md")),
      ).resolves.toBeDefined();
    } finally {
      await staged.cleanup();
    }
  });

  it("cleans up the staged dir on cleanup()", async () => {
    const ask = await loader.loadEntrypoint("ask");
    const staged = await stageSkills({
      entrypoint: ask,
      supportSkills: [],
    });
    await staged.cleanup();
    await expect(stat(staged.dir)).rejects.toThrowError(/ENOENT/);
  });
});
