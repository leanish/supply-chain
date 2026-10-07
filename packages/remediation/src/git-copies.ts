/**
 * Read-only git helpers over a working copy the workspace synced (its git
 * metadata in a separate directory the workspace created, so the repository
 * can't bring config, hooks or filters into these commands):
 *
 *   - `exportCommit`: a commit's files in a fresh directory, for the sandboxed
 *     Gradle inventory of a commit the working copy doesn't have checked out;
 *   - `changedSince`: what the working tree changed relative to a commit;
 *   - `sameTreeAs`: whether the working tree equals a commit.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { runProcess, type RunProcess } from "../../ci/src/process.ts";

function gitArgs(workingCopy: WorkingCopy, args: ReadonlyArray<string>): string[] {
  if (workingCopy.gitDir === undefined) throw new Error(`${workingCopy.path}'s git metadata must be in a separate directory`);
  return ["--git-dir", workingCopy.gitDir, "--work-tree", workingCopy.path, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args];
}

async function git(workingCopy: WorkingCopy, args: ReadonlyArray<string>, run: RunProcess): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  return run("git", gitArgs(workingCopy, args), { cwd: workingCopy.path, env });
}

/** `sha`'s files in a new directory (no git metadata); the caller removes it with the returned `remove`. */
export async function exportCommit(workingCopy: WorkingCopy, sha: string, run: RunProcess = runProcess): Promise<{ readonly dir: string; readonly remove: () => Promise<void> }> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`exportCommit needs a full commit sha; got '${sha}'`);
  const parent = await mkdtemp(join(tmpdir(), "commit-"));
  const remove = () => rm(parent, { recursive: true, force: true });
  try {
    const archive = join(parent, "commit.tar");
    const dir = join(parent, "tree");
    const archived = await git(workingCopy, ["archive", "--format=tar", "-o", archive, sha], run);
    if (archived.code !== 0) throw new Error(`git archive ${sha} failed: ${archived.stderr.trim()}`);
    await run("mkdir", [dir]);
    const extracted = await run("tar", ["-xf", archive, "-C", dir]);
    if (extracted.code !== 0) throw new Error(`extracting ${sha} failed: ${extracted.stderr.trim()}`);
    return { dir, remove };
  } catch (err) {
    await remove();
    throw err;
  }
}

/** Every path the working tree changed, added or removed relative to `sha`, untracked files included (ignored ones aren't). */
export async function changedSince(workingCopy: WorkingCopy, sha: string, run: RunProcess = runProcess): Promise<string[]> {
  const tracked = await git(workingCopy, ["diff", "--name-only", "-z", "--no-renames", sha, "--"], run);
  if (tracked.code !== 0) throw new Error(`git diff ${sha} failed: ${tracked.stderr.trim()}`);
  const untracked = await git(workingCopy, ["ls-files", "--others", "--exclude-standard", "-z"], run);
  if (untracked.code !== 0) throw new Error(`git ls-files failed: ${untracked.stderr.trim()}`);
  return [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter((path) => path !== ""))].sort();
}

/** Whether the working tree has exactly `sha`'s files. */
export async function sameTreeAs(workingCopy: WorkingCopy, sha: string, run: RunProcess = runProcess): Promise<boolean> {
  return (await changedSince(workingCopy, sha, run)).length === 0;
}
