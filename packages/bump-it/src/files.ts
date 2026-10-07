/** Tool writes must not follow a repository's symlink outside the working copy. */
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { safePath } from "./plan.ts";

export async function assertLocalFile(root: string, path: string): Promise<void> {
  if (!safePath(path)) {
    throw new Error(`unsafe npm path: ${path}`);
  }
  const canonicalRoot = await realpath(root);
  const canonicalParent = await realpath(dirname(join(root, path)));
  const rel = relative(canonicalRoot, canonicalParent);
  if (rel === ".." || rel.startsWith("../")) {
    throw new Error(`${path} points outside the working copy`);
  }
  try {
    const stat = await lstat(join(root, path));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${path} must be a regular file`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

export async function writeLocalFile(root: string, path: string, content: string): Promise<void> {
  // Planned npm files already have their directories in the exported base.
  await assertLocalFile(root, path);
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

/** A deleted mechanical file takes the base's side without following a repository symlink. */
export async function removeLocalFile(root: string, path: string): Promise<void> {
  await assertLocalFile(root, path);
  await rm(join(root, path), { force: true });
}
