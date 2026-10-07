/**
 * What the tools read about a tree. The Gradle inventory runs the build, so
 * it runs under the agent's sandbox (`runSandboxed`), never in the tool's
 * process; the rest is read as data: lockfiles and settings from git objects
 * or the working tree.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CodexRunnerOptions } from "../../agent-basics/src/skill/codex-runner.ts";
import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { treeSources } from "../../ci/src/gate.ts";
import { gradleFailureDetails, type GradleInventory, parseGradleInventory } from "../../ci/src/gradle.ts";
import type { Tree } from "../../ci/src/tree.ts";

import { exportCommit } from "./git-copies.ts";
import { runSandboxed } from "./sandboxed.ts";

const GATE_CLI = fileURLToPath(new URL("../../ci/src/cli.ts", import.meta.url));

/** Gradle inventories, each made by `gradle-inventory` under the agent's sandbox. */
export interface GradleInventories {
  /** Commit `tree.id`'s, from its files exported to a temporary directory (the working copy may have something else checked out). */
  ofCommit(tree: Tree): Promise<GradleInventory | undefined>;
  /** The working tree's, as it is. */
  ofWorkingTree(tree: Tree): Promise<GradleInventory | undefined>;
}

export function sandboxedGradleInventories(isolation: CodexRunnerOptions, workingCopy: WorkingCopy, codex = "codex"): GradleInventories {
  const inventory = async (dir: string, tree: Tree, label: string): Promise<GradleInventory | undefined> => {
    const builds = (await treeSources(tree)).gradleBuilds;
    if (builds.length === 0) return undefined;
    const outDir = await mkdtemp(join(tmpdir(), "remediation-gradle-"));
    try {
      const out = join(outDir, "gradle.json");
      const result = await runSandboxed(
        isolation,
        { workingCopy: { ...workingCopy, path: dir }, command: [process.execPath, GATE_CLI, "gradle-inventory", "--repo", ".", "--out", out, "--head", "worktree"] },
        undefined,
        codex,
      );
      if (result.code !== 0) {
        throw new Error(`the sandboxed Gradle inventory of ${label} failed (exit ${result.code}): ${gradleFailureDetails(result.stderr)}`);
      }
      // Made from a plain directory, so labelled `worktree`; the caller knows which tree it is.
      return { ...parseGradleInventory(JSON.parse(await readFile(out, "utf8")), "worktree", builds), tree: tree.id };
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  };
  return {
    async ofCommit(tree) {
      const copy = await exportCommit(workingCopy, tree.id);
      try {
        return await inventory(copy.dir, tree, tree.id);
      } finally {
        await copy.remove();
      }
    },
    ofWorkingTree: (tree) => inventory(workingCopy.path, tree, "the working tree"),
  };
}

/** Every lockfile the tree's settings list, parsed. */
export async function lockfilesOf(tree: Tree): Promise<Map<string, unknown>> {
  const lockfiles = new Map<string, unknown>();
  for (const path of (await treeSources(tree)).lockfiles) {
    const text = await tree.read(path);
    if (text === undefined) continue;
    lockfiles.set(path, JSON.parse(text));
  }
  return lockfiles;
}
