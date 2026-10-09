import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ConsoleLogger } from "../src/logger/console-logger.ts";
import { FakeCodingAgentRunner } from "../src/skill/fake-runner.ts";
import { runSkill, type SkillContext } from "../src/skill/run-skill.ts";
import { SkillLoader } from "../src/skill/skill-loader.ts";
import { SchemaValidator } from "../src/skill/validator.ts";

const publication = { title: "moving vite", body: "Fixes the advisory.", commitMessage: "moving vite" };

async function answer(tool: string, value: unknown, inputOverride?: object) {
  const runner = new FakeCodingAgentRunner("codex", [{ entrypoint: tool, respond: () => ({ responseText: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` }) }]);
  const context: SkillContext = {
    entrypoints: [tool], supportSkills: [], runnerFor: () => runner,
    skillLoader: new SkillLoader({ skillsDirs: [fileURLToPath(new URL(`../../${tool}/skills`, import.meta.url))] }),
    validator: new SchemaValidator(), logger: new ConsoleLogger({ minLevel: "error", stream: new PassThrough() }),
  };
  const input = tool === "secure-it"
    ? { repo: "acme/widget", mode: "apply", moves: [], today: "2026-10-09", floorsFile: ".github/dependency-floors.json", npmAgeExclusions: [] }
    : { repo: "acme/widget", mode: "apply", moves: [], today: "2026-10-09", kind: "routine", toolWritten: [] };
  return runSkill(context, { entrypoint: tool, input: inputOverride ?? input, workingCopies: [], codingAgent: "codex", access: "read-only" });
}

for (const tool of ["secure-it", "bump-it"]) {
  describe(`${tool} actual runSkill answer validation`, () => {
    it.each([{}, { publication: null }])("accepts cannot-apply with absent/null publication %#", async (extra) => {
      const value = { outcome: "cannot-apply", summary: "Cannot resolve the supplied set.", ...extra };
      expect(await answer(tool, value)).toEqual(value);
    });
    it("accepts applied only with a complete publication", async () => {
      const value = { outcome: "applied", summary: "Applied.", publication };
      expect(await answer(tool, value)).toEqual(value);
    });
    it.each([undefined, null, {}, { ...publication, title: "" }, { ...publication, unknown: true }])("rejects incomplete applied publication %#", async (publication) => {
      await expect(answer(tool, { outcome: "applied", summary: "Applied.", publication })).rejects.toMatchObject({ reason: "output-validation-fail" });
    });
    it.each([{}, { title: "not complete" }, { ...publication, unknown: true }])("still validates a non-null cannot-apply publication %#", async (publication) => {
      await expect(answer(tool, { outcome: "cannot-apply", summary: "Stopped.", publication })).rejects.toMatchObject({ reason: "output-validation-fail" });
    });
    it("still rejects unknown answer fields and null input", async () => {
      await expect(answer(tool, { outcome: "cannot-apply", summary: "Stopped.", extra: null })).rejects.toMatchObject({ reason: "output-validation-fail" });
      await expect(answer(tool, { outcome: "cannot-apply", summary: "Stopped." }, { repo: null })).rejects.toMatchObject({ reason: "input-validation-fail" });
    });
  });
}
