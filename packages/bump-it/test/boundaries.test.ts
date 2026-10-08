import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SkillLoader } from "../../agent-basics/src/skill/skill-loader.ts";
import { filePriority } from "../src/priority.ts";
import { assertLocalFile, writeLocalFile } from "../src/files.ts";

const dirs: string[] = [];
const temp = async () => { const dir = await mkdtemp(join(process.cwd(), ".bump-test-")); dirs.push(dir); return dir; };
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe("tool boundaries", () => {
  it("loads a write-capable skill with strict input and output schemas", async () => {
    const skill = await new SkillLoader({ skillsDirs: [fileURLToPath(new URL("../skills", import.meta.url))] }).loadEntrypoint("bump-it");
    expect(skill.inputSchema).toMatchObject({ additionalProperties: false, required: ["repo", "mode", "today", "kind", "moves", "toolWritten"] });
    expect(skill.outputSchema).toMatchObject({ additionalProperties: false });
    expect(skill.compatibleCodingAgents).toEqual(["codex"]);
  });
  it("keeps deferred priorities through a file round trip, treating corrupt state as an error", async () => {
    const dir = await temp();
    const queue = filePriority(dir, "acme/widget");
    expect(await queue.read()).toEqual([]);
    await queue.write(["npm|a", "npm|b", "npm|a"]);
    expect(await filePriority(dir, "acme/widget").read()).toEqual(["npm|a", "npm|b"]);
    await writeFile(join(dir, "deferred", "acme__widget.json"), "{}");
    await expect(queue.read()).rejects.toThrow("deferred-major list");
  });
  it("refuses symlink writes outside the copy and traversal, leaving the target intact", async () => {
    const root = await temp(); const outside = await temp();
    await writeFile(join(outside, "package.json"), "private");
    await symlink(join(outside, "package.json"), join(root, "package.json"));
    await expect(writeLocalFile(root, "package.json", "changed")).rejects.toThrow("regular file");
    await symlink(outside, join(root, "alias"));
    await expect(assertLocalFile(root, "alias/package.json")).rejects.toThrow("outside");
    await expect(assertLocalFile(root, "../package.json")).rejects.toThrow("unsafe");
    expect(await readFile(join(outside, "package.json"), "utf8")).toBe("private");
  });
});
