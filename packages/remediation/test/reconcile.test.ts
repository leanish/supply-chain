import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { changedSince } from "../src/git-copies.ts";
import { revertToBase } from "../src/reconcile.ts";

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function repo(): Promise<{ workingCopy: WorkingCopy; git: (...args: string[]) => { status: number | null; stdout: string } }> {
  root = await mkdtemp(join(tmpdir(), "reconcile-"));
  const workingCopy: WorkingCopy = { projectId: "leanish/widget", path: join(root, "wc"), branch: "main", headSha: "", gitDir: join(root, "git") };
  spawnSync("git", ["init", "-q", "-b", "main", "--separate-git-dir", workingCopy.gitDir!, workingCopy.path]);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: workingCopy.path, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout.trim() };
  };
  return { workingCopy, git };
}

const write = (wc: WorkingCopy, path: string, text: string) => writeFile(join(wc.path, path), text);

describe("revertToBase", () => {
  it("puts every path a conflicted merge leaves different from the new base back to the base's content", async () => {
    const { workingCopy, git } = await repo();
    await write(workingCopy, "package.json", '{"dependencies":{"vite":"^8.3.0"}}\n');
    await write(workingCopy, "gone.txt", "base\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "bump-it/2026-10-07-routine");
    // The PR: a range edit, a new file, a removed one.
    await write(workingCopy, "package.json", '{"dependencies":{"vite":"^8.4.0"}}\n');
    await write(workingCopy, "added.txt", "pr\n");
    git("rm", "-q", "gone.txt");
    git("add", "-A");
    git("commit", "-q", "-m", "pr");
    // The default branch moves: the same line, differently, and something else.
    git("checkout", "-q", "main");
    await write(workingCopy, "package.json", '{"dependencies":{"vite":"^8.3.5"}}\n');
    await write(workingCopy, "other.txt", "base moved\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base moved");
    const newBase = git("rev-parse", "HEAD").stdout;
    git("checkout", "-q", "bump-it/2026-10-07-routine");
    expect(git("merge", "-q", "--no-edit", "main").status).not.toBe(0);
    // An untracked leftover counts as a change too.
    await write(workingCopy, "scratch.log", "x\n");

    const reverted = await revertToBase(workingCopy, newBase);
    expect(reverted).toEqual(["added.txt", "gone.txt", "package.json", "scratch.log"]);
    expect(await changedSince(workingCopy, newBase)).toEqual([]);
    expect(await readFile(join(workingCopy.path, "package.json"), "utf8")).toBe('{"dependencies":{"vite":"^8.3.5"}}\n');
    // The merge is resolved: it commits.
    expect(git("commit", "-q", "-m", "merging main").status).toBe(0);
    expect(git("diff", "--quiet", newBase, "HEAD").status).toBe(0);
  });

  it("does nothing when the tree is the base's already, and wants a full sha", async () => {
    const { workingCopy, git } = await repo();
    await write(workingCopy, "a.txt", "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    expect(await revertToBase(workingCopy, git("rev-parse", "HEAD").stdout)).toEqual([]);
    await expect(revertToBase(workingCopy, "main")).rejects.toThrow("full commit sha");
  });
});
