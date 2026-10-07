import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { runSandboxed } from "../src/sandboxed.ts";

const hasCodex = spawnSync("codex", ["sandbox", "--help"], { stdio: "ignore" }).status === 0;
let root: string;
let workingCopy: WorkingCopy;
let secretDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sandboxed-test-"));
  await mkdir(join(root, "wc"));
  await mkdir(join(root, "git"));
  secretDir = join(root, "private");
  await mkdir(secretDir);
  await writeFile(join(secretDir, "token.txt"), "not for the build");
  workingCopy = { projectId: "leanish/widget", path: join(root, "wc"), branch: "main", headSha: "a".repeat(40), gitDir: join(root, "git") };
});

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

// A real `codex sandbox` (seatbelt on macOS): what a build run this way can and can't do.
describe.skipIf(!hasCodex || process.platform !== "darwin")("runSandboxed", () => {
  it("lets the command write in the working copy, but not read denied paths or see credential variables", async () => {
    process.env["SANDBOX_TEST_TOKEN"] = "leaked";
    try {
      const isolation = { readDenied: [secretDir], buildCacheRoot: join(root, "cache"), env: { GIT_CONFIG_GLOBAL: "/dev/null" } };
      await mkdir(join(root, "cache"));
      const result = await runSandboxed(isolation, {
        workingCopy,
        command: [
          "/bin/sh",
          "-c",
          `echo built > out.txt; cat "${join(secretDir, "token.txt")}" >/dev/null 2>&1; echo "denied=$?"; echo "token=\${SANDBOX_TEST_TOKEN:-none}"; echo "git=$GIT_CONFIG_GLOBAL"`,
        ],
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("denied=1");
      expect(result.stdout).toContain("token=none");
      expect(result.stdout).toContain("git=/dev/null");
      expect(await readFile(join(workingCopy.path, "out.txt"), "utf8")).toBe("built\n");
    } finally {
      delete process.env["SANDBOX_TEST_TOKEN"];
    }
  }, 30_000);
});

describe("runSandboxed arguments", () => {
  it("runs codex sandbox with the write profile and the command after --, in the working copy", async () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string>; cwd: string | undefined }> = [];
    await runSandboxed({ readDenied: ["/Users/dev/.ssh"], buildCacheRoot: "/cache", env: {} }, { workingCopy, command: ["./gradlew", "--version"] }, async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd });
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(calls[0]?.command).toBe("codex");
    expect(calls[0]?.args[0]).toBe("sandbox");
    expect(calls[0]?.args.slice(-3)).toEqual(["--", "./gradlew", "--version"]);
    expect(calls[0]?.args.join(" ")).toContain('"/Users/dev/.ssh"="deny"');
    expect(calls[0]?.args.join(" ")).toContain("network.enabled=true");
    expect(calls[0]?.cwd).toBe(workingCopy.path);
    await expect(runSandboxed({}, { workingCopy: { ...workingCopy, gitDir: undefined }, command: ["true"] })).rejects.toThrow("separate directory");
  });
});
