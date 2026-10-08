/** Tool writes must not follow a repository's symlink outside the working copy. */
import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export function safePath(path: unknown): path is string {
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

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
