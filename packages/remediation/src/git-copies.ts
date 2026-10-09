/**
 * Read-only git helpers over a working copy the workspace synced (its git
 * metadata in a separate directory the workspace created, so the repository
 * can't bring config, hooks or filters into these commands):
 *
 *   - `exportCommit`: a commit's files in a fresh directory, byte for byte as
 *     committed (no `export-ignore`, `export-subst`, line-ending or filter
 *     attributes applied), for the sandboxed Gradle inventory of a commit the
 *     working copy doesn't have checked out;
 *   - `changedSince`: what the working tree changed relative to a commit;
 *   - `sameTreeAs`: whether the working tree equals a commit.
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { runProcess, type RunProcess } from "../../ci/src/process.ts";

function gitArgs(workingCopy: WorkingCopy, args: ReadonlyArray<string>): string[] {
  if (workingCopy.gitDir === undefined) throw new Error(`${workingCopy.path}'s git metadata must be in a separate directory`);
  return ["--git-dir", workingCopy.gitDir, "--work-tree", workingCopy.path, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args];
}

/** A git command over the working copy's own metadata, without system or global config, hooks or fsmonitor. */
export async function git(workingCopy: WorkingCopy, args: ReadonlyArray<string>, run: RunProcess): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  return run("git", gitArgs(workingCopy, args), { cwd: workingCopy.path, env });
}

/** `sha`'s files in a new directory (no git metadata), exactly as committed; the caller removes it with `remove`. */
export async function exportCommit(workingCopy: WorkingCopy, sha: string, run: RunProcess = runProcess): Promise<{ readonly dir: string; readonly remove: () => Promise<void> }> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`exportCommit needs a full commit sha; got '${sha}'`);
  const parent = await mkdtemp(join(tmpdir(), "commit-"));
  const remove = () => rm(parent, { recursive: true, force: true });
  try {
    const dir = join(parent, "tree");
    await mkdir(dir);
    const listed = await git(workingCopy, ["ls-tree", "-r", "-z", "--full-tree", sha], run);
    if (listed.code !== 0) throw new Error(`git ls-tree ${sha} failed: ${listed.stderr.trim()}`);
    const entries = listed.stdout
      .split("\0")
      .filter((line) => line !== "")
      .map((line) => {
        const tab = line.indexOf("\t");
        const [mode, type, object] = line.slice(0, tab).split(" ") as [string, string, string];
        return { mode, type, object, path: line.slice(tab + 1) };
      });
    const blobs = entries.filter((entry) => entry.type === "blob");
    assertSafePaths(sha, entries);
    const contents = await catFileBatch(workingCopy, blobs.map((blob) => blob.object));
    // Regular files first, symlinks last: no write ever goes through a link the tree brought.
    const ordered = [...blobs.filter((blob) => blob.mode !== "120000"), ...blobs.filter((blob) => blob.mode === "120000")];
    for (const blob of ordered) {
      const target = join(dir, normalize(blob.path));
      if (!target.startsWith(`${dir}/`)) throw new Error(`${sha} has a path outside its tree: ${blob.path}`);
      await mkdir(dirname(target), { recursive: true });
      const content = contents.get(blob.object)!;
      if (blob.mode === "120000") {
        await symlink(content.toString("utf8"), target);
      } else {
        await writeFile(target, content, { flag: "wx" });
        if (blob.mode === "100755") await chmod(target, 0o755);
      }
    }
    // Submodules (mode 160000) have no files in this repository; they stay empty directories.
    for (const entry of entries.filter((e) => e.type === "commit")) await mkdir(join(dir, normalize(entry.path)), { recursive: true });
    return { dir, remove };
  } catch (err) {
    await remove();
    throw err;
  }
}

/**
 * Refuses a tree whose paths would collide on this filesystem (`A` and `a` on
 * a case-insensitive one: checked case-insensitively everywhere) or that puts
 * an entry under one of its own symlinks: either could write outside the copy.
 */
function assertSafePaths(sha: string, entries: ReadonlyArray<{ readonly mode: string; readonly path: string }>): void {
  const seen = new Map<string, string>();
  const links = new Set<string>();
  for (const entry of entries) {
    const folded = normalize(entry.path).toLowerCase();
    const earlier = seen.get(folded);
    if (earlier !== undefined) throw new Error(`${sha} has paths that collide: ${earlier} and ${entry.path}`);
    seen.set(folded, entry.path);
    if (entry.mode === "120000") links.add(folded);
  }
  for (const folded of seen.keys()) {
    const parts = folded.split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/");
      if (links.has(ancestor)) throw new Error(`${sha} has ${seen.get(folded)} under its symlink ${seen.get(ancestor)}`);
    }
  }
}

/** Every object's raw content, read with one `git cat-file --batch`. */
function catFileBatch(workingCopy: WorkingCopy, objects: ReadonlyArray<string>): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", gitArgs(workingCopy, ["cat-file", "--batch"]), {
      cwd: workingCopy.path,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`git cat-file --batch failed: ${stderr.trim()}`));
      const out = Buffer.concat(chunks);
      const found = new Map<string, Buffer>();
      let at = 0;
      for (const object of new Set(objects)) {
        const newline = out.indexOf(0x0a, at);
        const header = out.subarray(at, newline).toString("utf8");
        const [name, type, size] = header.split(" ");
        if (name !== object || type !== "blob" || size === undefined) return reject(new Error(`git cat-file --batch answered '${header}' for ${object}`));
        const start = newline + 1;
        found.set(object, out.subarray(start, start + Number(size)));
        at = start + Number(size) + 1;
      }
      resolve(found);
    });
    child.stdin.end([...new Set(objects)].map((object) => `${object}\n`).join(""));
  });
}

/** Every path the working tree changed, added or removed relative to `sha`, untracked files included (ignored ones aren't). */
export async function changedSince(workingCopy: WorkingCopy, sha: string, run: RunProcess = runProcess): Promise<string[]> {
  const tracked = await git(workingCopy, ["diff", "--name-only", "-z", "--no-renames", sha, "--"], run);
  if (tracked.code !== 0) throw new Error(`git diff ${sha} failed: ${tracked.stderr.trim()}`);
  const untracked = await git(workingCopy, ["ls-files", "--others", "--exclude-standard", "-z"], run);
  if (untracked.code !== 0) throw new Error(`git ls-files failed: ${untracked.stderr.trim()}`);
  return [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter((path) => path !== ""))].sort();
}

/** Tracked paths whose mode (executable bit, symlink, submodule) differs from `sha`'s, added and removed ones included. */
export async function modeChangedSince(workingCopy: WorkingCopy, sha: string, run: RunProcess = runProcess): Promise<string[]> {
  const raw = await git(workingCopy, ["diff", "--raw", "-z", "--no-renames", sha, "--"], run);
  if (raw.code !== 0) throw new Error(`git diff --raw ${sha} failed: ${raw.stderr.trim()}`);
  // Each entry is `:<old mode> <new mode> <old blob> <new blob> <status>` and its path, NUL-separated.
  const fields = raw.stdout.split("\0");
  const changed: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode, newMode] = fields[index]!.slice(1).split(" ");
    if (oldMode !== newMode) changed.push(fields[index + 1]!);
  }
  return changed.sort();
}

/** Whether the working tree has exactly `sha`'s files. */
export async function sameTreeAs(workingCopy: WorkingCopy, sha: string, run: RunProcess = runProcess): Promise<boolean> {
  return (await changedSince(workingCopy, sha, run)).length === 0;
}
