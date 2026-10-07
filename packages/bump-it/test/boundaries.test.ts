import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { defaultDeps } from "../src/deps.ts";
import { WRAPPER_JAR } from "../src/gradle-wrapper.ts";
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
    expect(skill.inputSchema).toMatchObject({ properties: { moves: { items: { properties: {
      ecosystem: { enum: expect.arrayContaining(["Gradle Wrapper"]) },
      mechanism: { enum: expect.arrayContaining(["gradle-wrapper"]) },
      wrapper: { additionalProperties: false, required: ["distributionUrl", "distributionSha256", "jarSha256"] },
    } } } } });
    expect(skill.body).toContain("twice, sequentially");
    expect(skill.body).toContain("--no-daemon --gradle-version <to>");
    expect(skill.outputSchema).toMatchObject({ additionalProperties: false });
    expect(skill.compatibleCodingAgents).toEqual(["codex"]);
  });
  it("hashes and restores wrapper jars as binary, refusing symlinks and unsafe restore paths", async () => {
    const root = await temp();
    await mkdir(join(root, "gradle", "wrapper"), { recursive: true });
    const bytes = Buffer.from([0x50, 0x4b, 0xff, 0x00, 0xfe, 0x80]);
    await writeFile(join(root, WRAPPER_JAR), bytes);
    const wc: WorkingCopy = { projectId: "acme/widget", path: root, gitDir: join(root, ".git"), headSha: "a".repeat(40), branch: "main" };
    const deps = defaultDeps();
    expect(await deps.wrapperJarSha256(wc)).toBe(createHash("sha256").update(bytes).digest("hex"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("add", WRAPPER_JAR);
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture");
    const base = git("rev-parse", "HEAD");
    await writeFile(join(root, WRAPPER_JAR), "corrupted jar");
    await deps.restoreWrapperFile(wc, base, WRAPPER_JAR);
    expect(await readFile(join(root, WRAPPER_JAR))).toEqual(bytes);
    await expect(deps.restoreWrapperFile(wc, base, "../outside")).rejects.toThrow("invalid wrapper restore");
    await rm(join(root, WRAPPER_JAR));
    expect(await deps.wrapperJarSha256(wc)).toBeUndefined();
    await symlink(join(root, "package.json"), join(root, WRAPPER_JAR));
    await expect(deps.wrapperJarSha256(wc)).rejects.toThrow("regular file");
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
