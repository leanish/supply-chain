/**
 * Where a side of the comparison reads its files from: a git commit (read
 * with `git show`, so nothing in it runs) or the working tree.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import type { RunProcess } from "./process.ts";

export interface Tree {
  /** `worktree` or the full commit SHA. */
  readonly id: string;
  /** The file's content, or undefined when the tree has no such file. */
  read(path: string): Promise<string | undefined>;
  /**
   * Every file under `dir`, recursively, as paths from the root; empty when there's no such directory. A commit's
   * tree always lists symlinks (reading one gives its target path); a working tree lists those leading to a file
   * (reading one follows it) only with `symlinks`.
   */
  list(dir: string, options?: { readonly symlinks?: boolean }): Promise<string[]>;
}

export function workingTree(root: string): Tree {
  return {
    id: "worktree",
    async read(path) {
      try {
        return await readFile(join(root, path), "utf8");
      } catch (err) {
        // ENOTDIR: a parent is a file (`ci.yml/action.yml`), so there's no such file either.
        if (isMissing(err)) return undefined;
        throw err;
      }
    },
    async list(dir, options) {
      try {
        const entries = await readdir(join(root, dir), { recursive: true, withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
          const path = join(entry.parentPath, entry.name);
          // A wanted symlink counts when it leads to a file; links to directories and broken ones don't.
          if (entry.isFile() || options?.symlinks === true && entry.isSymbolicLink() && await stat(path).then((target) => target.isFile(), () => false)) files.push(relative(root, path));
        }
        return files.sort();
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
    },
  };
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The tree of `revision` in the repository at `root`, resolved to its full SHA once. */
export async function gitTree(root: string, revision: string, run: RunProcess): Promise<Tree> {
  const resolved = await run("git", ["rev-parse", "--verify", `${revision}^{commit}`], { cwd: root });
  if (resolved.code !== 0) throw new Error(`git can't resolve ${revision} to a commit: ${resolved.stderr.trim()}`);
  const sha = resolved.stdout.trim();
  return {
    id: sha,
    async read(path) {
      const listed = await run("git", ["ls-tree", "-z", "--name-only", sha, "--", path], { cwd: root });
      if (listed.code !== 0) throw new Error(`git ls-tree ${sha} ${path} failed: ${listed.stderr.trim()}`);
      if (listed.stdout.trim() === "") return undefined;
      const shown = await run("git", ["show", `${sha}:${path}`], { cwd: root });
      if (shown.code !== 0) throw new Error(`git show ${sha}:${path} failed: ${shown.stderr.trim()}`);
      return shown.stdout;
    },
    async list(dir) {
      // -z: names come back raw, NUL-separated, instead of quoted when they have unusual characters.
      const listed = await run("git", ["ls-tree", "-r", "-z", "--name-only", sha, "--", dir], { cwd: root });
      if (listed.code !== 0) throw new Error(`git ls-tree ${sha} ${dir} failed: ${listed.stderr.trim()}`);
      return listed.stdout.split("\0").filter((line) => line !== "").sort();
    },
  };
}
