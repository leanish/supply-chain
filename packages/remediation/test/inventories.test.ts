import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import type { Tree } from "../../ci/src/tree.ts";

import { exportCommit } from "../src/git-copies.ts";
import { sandboxedGradleInventories } from "../src/inventories.ts";
import { runSandboxed } from "../src/sandboxed.ts";

vi.mock("../src/sandboxed.ts", () => ({ runSandboxed: vi.fn() }));
vi.mock("../src/git-copies.ts", () => ({ exportCommit: vi.fn() }));
afterEach(() => vi.clearAllMocks());

const workingCopy: WorkingCopy = {
  projectId: "leanish/widget",
  path: "/synthetic/widget",
  gitDir: "/synthetic/git",
  headSha: "a".repeat(40),
  branch: "main",
};
const tree: Tree = {
  id: "worktree",
  read: async (path) => path === "build.gradle.kts" ? "plugins { java }" : undefined,
  list: async () => [],
};

describe("sandboxed Gradle inventory errors", () => {
  it.each([
    "* What went wrong: / Could not open file hash cache. / > java.io.FileNotFoundException: /worktree/.gradle/fileHashes.lock (Operation not permitted)",
    "Caused by: java.io.FileNotFoundException: /worktree/.gradle/fileHashes.lock (Operation not permitted)",
    "Could not resolve all files",
  ])("preserves the CLI's problem before its usage footer: %s", async (details) => {
    const reported = `Gradle inventory of build . failed with exit code 1: ${details}`;
    const stderr = [
      `✗ ${reported}`,
      "usage:",
      "  supply-chain candidates ...",
      "  supply-chain compare ...",
      "  supply-chain scan ...",
      "  supply-chain gradle-inventory ...",
      "  supply-chain rescan-plan ...",
      "  supply-chain rescan ...",
    ].join("\n");
    vi.mocked(runSandboxed).mockResolvedValue({ code: 2, stdout: "", stderr });
    await expect(sandboxedGradleInventories({}, workingCopy).ofWorkingTree(tree)).rejects.toThrow(
      `the sandboxed Gradle inventory of the working tree failed (exit 2): ✗ ${reported}`,
    );
  });
});

describe("a commit's Gradle inventory with a transform", () => {
  const command = (index = 0) => vi.mocked(runSandboxed).mock.calls[index]![1].command;
  const flag = (args: ReadonlyArray<string>, name: string) => args[args.indexOf(name) + 1]!;
  const transform = { initScript: "/scripts/reference.init.gradle", property: "supplyChain.reference.file", content: (root: string) => ({ repositoryRoot: root, moves: [] }) };

  it("writes the overlay over the exported files and hands the build the transform's input", async () => {
    const exported = await mkdtemp(join(tmpdir(), "inventories-test-"));
    vi.mocked(exportCommit).mockResolvedValue({ dir: exported, remove: async () => rm(exported, { recursive: true, force: true }) });
    let input: unknown;
    let mode = 0;
    vi.mocked(runSandboxed).mockImplementation(async (_isolation, request) => {
      const [, , ...args] = request.command;
      input = JSON.parse(await readFile(flag(args, "--define").split("=")[1]!, "utf8"));
      mode = (await stat(join(exported, "gradlew"))).mode & 0o777;
      await writeFile(flag(args, "--out"), JSON.stringify({ schemaVersion: 1, tree: "worktree", builds: [{ build: ".", configurations: [] }] }));
      return { code: 0, stdout: "", stderr: "" };
    });
    const inventory = await sandboxedGradleInventories({}, workingCopy).ofCommit({ ...tree, id: "b".repeat(40) }, { transform, overlay: [{ path: "gradlew", bytes: Buffer.from("#!/bin/sh\n"), executable: true }] });
    expect(inventory?.tree).toBe("b".repeat(40));
    expect(command()).toEqual(expect.arrayContaining(["--init-script", "/scripts/reference.init.gradle", "--define"]));
    expect(flag(command(), "--define")).toMatch(/^supplyChain\.reference\.file=.+transform\.json$/);
    expect(input).toEqual({ repositoryRoot: exported, moves: [] });
    expect(mode).toBe(0o755);
  });

  it("fails when the build changed the transform's input", async () => {
    const exported = await mkdtemp(join(tmpdir(), "inventories-test-"));
    vi.mocked(exportCommit).mockResolvedValue({ dir: exported, remove: async () => rm(exported, { recursive: true, force: true }) });
    vi.mocked(runSandboxed).mockImplementation(async (_isolation, request) => {
      const [, , ...args] = request.command;
      await writeFile(flag(args, "--define").split("=")[1]!, "{}");
      await writeFile(flag(args, "--out"), JSON.stringify({ schemaVersion: 1, tree: "worktree", builds: [{ build: ".", configurations: [] }] }));
      return { code: 0, stdout: "", stderr: "" };
    });
    await expect(sandboxedGradleInventories({}, workingCopy).ofCommit({ ...tree, id: "b".repeat(40) }, { transform })).rejects.toThrow("the Gradle transform's input changed");
  });
});
