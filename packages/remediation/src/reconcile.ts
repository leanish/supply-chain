/**
 * Reconcile by revert (design item 28): with the default branch merged into
 * a PR's branch (or that merge left in progress, conflicts and all), every
 * path the branch still changes relative to the new base goes back to the
 * base's content, so the new plan is applied to the base as it is: changes
 * an earlier plan made and the new one doesn't want go, instead of piling up.
 * Only the working tree and the index change; the tool then publishes the
 * result as a normal commit (never a force-push).
 */
import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { runProcess, type RunProcess } from "../../ci/src/process.ts";

import { changedSince, git } from "./git-copies.ts";

/** Puts every path that differs from `baseSha` back to its content there (removing what it doesn't have); returns those paths. */
export async function revertToBase(workingCopy: WorkingCopy, baseSha: string, run: RunProcess = runProcess): Promise<string[]> {
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error(`revertToBase needs a full commit sha; got '${baseSha}'`);
  const changed = await changedSince(workingCopy, baseSha, run);
  if (changed.length === 0) return [];
  const listed = await git(workingCopy, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", baseSha, "--", ...changed], run);
  if (listed.code !== 0) throw new Error(`git ls-tree ${baseSha} failed: ${listed.stderr.trim()}`);
  const inBase = new Set(listed.stdout.split("\0").filter((path) => path !== ""));
  const restore = changed.filter((path) => inBase.has(path));
  const remove = changed.filter((path) => !inBase.has(path));
  // `checkout <sha> -- <path>` also resolves a conflicted path (stage 0 from the base), byte for byte, binaries included.
  if (restore.length > 0) await expect(git(workingCopy, ["checkout", baseSha, "--", ...restore], run), "checkout");
  // `rm` drops every stage of a conflicted path too; untracked files leave the working tree.
  if (remove.length > 0) await expect(git(workingCopy, ["rm", "-q", "-r", "-f", "--ignore-unmatch", "--", ...remove], run), "rm");
  const left = await changedSince(workingCopy, baseSha, run);
  for (const path of left.filter((path) => remove.includes(path))) {
    await expect(git(workingCopy, ["clean", "-q", "-f", "--", path], run), "clean");
  }
  const still = await changedSince(workingCopy, baseSha, run);
  if (still.length > 0) throw new Error(`reverting to ${baseSha} left ${still.join(", ")} changed`);
  return changed;
}

async function expect(result: Promise<{ code: number; stderr: string }>, what: string): Promise<void> {
  const { code, stderr } = await result;
  if (code !== 0) throw new Error(`git ${what} failed while reverting to the base: ${stderr.trim()}`);
}
