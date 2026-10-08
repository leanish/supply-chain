import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import type { Tree } from "../../ci/src/tree.ts";

import { sandboxedGradleInventories } from "../src/inventories.ts";
import { runSandboxed } from "../src/sandboxed.ts";

vi.mock("../src/sandboxed.ts", () => ({ runSandboxed: vi.fn() }));
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
