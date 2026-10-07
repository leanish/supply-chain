import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { runProcess, type RunProcess } from "../../ci/src/process.ts";
import type { ToolRunContext } from "../../remediation/src/command.ts";
import { WRAPPER_FILES, WRAPPER_JAR, WRAPPER_PROPERTIES } from "../src/gradle-wrapper.ts";
import type { DirectMove } from "../src/units.ts";
import { generateWrapper, readWrapperFiles, writeWrapperFiles } from "../src/wrapper-generation.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});
const move: DirectMove = {
  ecosystem: "Gradle Wrapper", name: "gradle/gradle", from: "8.0", to: "8.1", major: false,
  mechanism: "gradle-wrapper", locations: [WRAPPER_PROPERTIES], declarations: [],
  wrapper: { distributionUrl: "https://services.gradle.org/distributions/gradle-8.1-all.zip", distributionSha256: "a".repeat(64), jarSha256: "b".repeat(64) },
};
const JAR = Buffer.from([0x50, 0x4b, 0xff, 0x00, 0xfe]);

async function fixture(change?: (dir: string) => Promise<void>) {
  const root = await mkdtemp(join(process.cwd(), ".wrapper-test-"));
  dirs.push(root);
  const path = join(root, "copy");
  const gitDir = join(root, "metadata");
  await mkdir(join(path, "gradle", "wrapper"), { recursive: true });
  for (const file of WRAPPER_FILES) {
    await writeFile(join(path, file), "base");
  }
  await chmod(join(path, "gradlew"), 0o755);
  await writeFile(join(path, "build.gradle.kts"), "base build");
  await writeFile(join(path, ".gitignore"), ".gradle/\n*.kts\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8" }).trim();
  git("init", "--quiet", `--separate-git-dir=${gitDir}`);
  git("add", ".");
  git("add", "-f", "build.gradle.kts");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "fixture");
  const sha = git("rev-parse", "HEAD");
  const workingCopy: WorkingCopy = { projectId: "acme/widget", path, gitDir, headSha: sha, branch: "main" };
  const context = { workingCopy, isolation: {} } as ToolRunContext;
  const commands: string[][] = [];
  let scratch: string | undefined;
  const run: RunProcess = async (command, args, options) => {
    if (command !== "codex") {
      return runProcess(command, args, options);
    }
    expect(args[0]).toBe("sandbox");
    expect(options?.env?.["GITHUB_TOKEN"]).toBeUndefined();
    expect(options?.env?.["GH_TOKEN"]).toBeUndefined();
    const gradle = args.slice(args.indexOf("--") + 1);
    commands.push([...gradle]);
    scratch = options!.cwd!;
    expect(await readFile(join(scratch, "gradlew"), "utf8")).toBe(commands.length === 1 ? "base" : "generated script");
    for (const file of WRAPPER_FILES) {
      await writeFile(join(scratch, file), file === WRAPPER_JAR ? JAR : "generated script");
    }
    await mkdir(join(scratch, ".gradle"), { recursive: true });
    await writeFile(join(scratch, ".gradle", "cache"), "ignored build output");
    if (change !== undefined) {
      await change(scratch);
    }
    return { code: 0, stdout: "generated", stderr: "" };
  };
  return { context, commands, run, sha, scratch: () => scratch };
}

describe("tool wrapper generation", () => {
  it("runs two sandboxed no-daemon tasks from base, records binary bytes and modes, and copies only artifacts", async () => {
    const f = await fixture();
    const files = await generateWrapper(f.context, f.sha, move, f.run);
    expect(f.commands).toEqual([0, 1].map(() => ["./gradlew", "wrapper", "--gradle-version", "8.1", "--gradle-distribution-sha256-sum", "a".repeat(64), "--distribution-type", "all", "--no-daemon"]));
    expect(files.map((file) => file.path)).toEqual(WRAPPER_FILES);
    expect(files.find((file) => file.path === WRAPPER_JAR)?.bytes).toEqual(JAR);
    expect(files.find((file) => file.path === "gradlew")?.executable).toBe(true);
    expect(files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(await readFile(join(f.context.workingCopy.path, "gradlew"), "utf8")).toBe("base");
    await writeWrapperFiles(f.context.workingCopy, files);
    expect(await readWrapperFiles(f.context.workingCopy)).toEqual(files);
    await expect(readFile(join(f.scratch()!, "gradlew"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["edit", "add", "remove", "mode"])("rejects an outside %s and removes the scratch copy", async (kind) => {
    const f = await fixture(async (dir) => {
      const path = join(dir, "build.gradle.kts");
      if (kind === "edit") await writeFile(path, "changed");
      if (kind === "add") await writeFile(join(dir, "unexpected.txt"), "added");
      if (kind === "remove") await rm(path, { force: true });
      if (kind === "mode") await chmod(path, 0o755);
    });
    await expect(generateWrapper(f.context, f.sha, move, f.run)).rejects.toThrow("other repository files");
    expect(await readFile(join(f.context.workingCopy.path, "build.gradle.kts"), "utf8")).toBe("base build");
    await expect(readFile(join(f.scratch()!, "gradlew"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("protects ignored files tracked in base even when the current PR index removed them", async () => {
    const f = await fixture(async (dir) => { await writeFile(join(dir, "build.gradle.kts"), "changed"); });
    execFileSync("git", ["rm", "--cached", "build.gradle.kts"], { cwd: f.context.workingCopy.path });
    await expect(generateWrapper(f.context, f.sha, move, f.run)).rejects.toThrow("other repository files: build.gradle.kts");
  });
  it("stops after a failed task and refuses generated symlinks", async () => {
    const failed = await fixture();
    let calls = 0;
    const run: RunProcess = async (command, args, options) => {
      if (command !== "codex") return failed.run(command, args, options);
      calls++;
      return { code: 1, stdout: "", stderr: "failed task" };
    };
    await expect(generateWrapper(failed.context, failed.sha, move, run)).rejects.toThrow("failed task");
    expect(calls).toBe(1);
    let pass = 0;
    const linked = await fixture(async (dir) => {
      if (++pass < 2) return;
      await rm(join(dir, WRAPPER_JAR));
      await symlink("../../build.gradle.kts", join(dir, WRAPPER_JAR));
    });
    await expect(generateWrapper(linked.context, linked.sha, move, linked.run)).rejects.toThrow("regular file");
  });
});
