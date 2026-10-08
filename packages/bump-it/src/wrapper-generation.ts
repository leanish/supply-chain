/** Generate from the base in an isolated scratch copy; protect every resulting wrapper byte and mode. */
import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readlink, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { type RunProcess, runProcess } from "../../ci/src/process.ts";
import type { ToolRunContext } from "../../remediation/src/command.ts";
import { exportCommit, git } from "../../remediation/src/git-copies.ts";
import { runSandboxed } from "../../remediation/src/sandboxed.ts";

import { assertLocalFile } from "./files.ts";
import { WRAPPER_FILES } from "./gradle-wrapper.ts";
import type { DirectMove } from "./units.ts";

export interface WrapperFile {
  readonly path: string;
  readonly sha256: string;
  readonly executable: boolean;
}

export interface WrapperArtifact extends WrapperFile {
  readonly bytes: Buffer;
}

export async function readWrapperFiles(workingCopy: WorkingCopy): Promise<ReadonlyArray<WrapperArtifact>> {
  const files: WrapperArtifact[] = [];
  for (const path of WRAPPER_FILES) {
    await assertLocalFile(workingCopy.path, path);
    const bytes = await readFile(join(workingCopy.path, path));
    const stat = await lstat(join(workingCopy.path, path));
    files.push({ path, bytes, sha256: hash(bytes), executable: (stat.mode & 0o111) !== 0 });
  }
  return files;
}

export async function writeWrapperFiles(workingCopy: WorkingCopy, files: ReadonlyArray<WrapperArtifact>): Promise<void> {
  for (const file of files) {
    if (!WRAPPER_FILES.includes(file.path)) {
      throw new Error(`unexpected wrapper file: ${file.path}`);
    }
    await assertLocalFile(workingCopy.path, file.path);
    await writeFile(join(workingCopy.path, file.path), file.bytes);
    await chmod(join(workingCopy.path, file.path), file.executable ? 0o755 : 0o644);
  }
}

export async function generateWrapper(context: ToolRunContext, baseSha: string, move: DirectMove, run: RunProcess = runProcess): Promise<ReadonlyArray<WrapperArtifact>> {
  const scratch = await exportCommit(context.workingCopy, baseSha, run);
  try {
    const workingCopy = { ...context.workingCopy, path: scratch.dir };
    const tracked = await git(workingCopy, ["ls-tree", "--name-only", "-r", "-z", baseSha], run);
    if (tracked.code !== 0) {
      throw new Error(`listing base wrapper generation files failed: ${tracked.stderr}`);
    }
    return await generateInCopy(context, workingCopy, move, run, tracked.stdout.split("\0").filter(Boolean));
  } finally {
    await scratch.remove();
  }
}

/** Only ignored build/cache output may accompany the four wrapper files. */
async function generateInCopy(context: Pick<ToolRunContext, "isolation">, workingCopy: WorkingCopy, move: DirectMove, run: RunProcess = runProcess, tracked: ReadonlyArray<string> = []): Promise<ReadonlyArray<WrapperArtifact>> {
  if (move.wrapper === undefined) {
    throw new Error("wrapper generation needs official target metadata");
  }
  const before = await repositoryFiles(workingCopy, run, tracked);
  const type = move.wrapper.distributionUrl.endsWith("-all.zip") ? "all" : "bin";
  const command = ["./gradlew", "wrapper", "--gradle-version", move.to, "--gradle-distribution-sha256-sum", move.wrapper.distributionSha256, "--distribution-type", type, "--no-daemon"];
  for (let pass = 0; pass < 2; pass++) {
    const result = await runSandboxed(context.isolation, { workingCopy, command }, run);
    if (result.code !== 0) {
      throw new Error(`Gradle wrapper generation failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }
  const after = await repositoryFiles(workingCopy, run, tracked);
  const outside = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => !WRAPPER_FILES.includes(path) && before.get(path) !== after.get(path));
  if (outside.length > 0) {
    throw new Error(`wrapper generation changed other repository files: ${outside.join(", ")}`);
  }
  return readWrapperFiles(workingCopy);
}

async function repositoryFiles(workingCopy: WorkingCopy, run: RunProcess, tracked: ReadonlyArray<string>): Promise<Map<string, string>> {
  const listed = await git(workingCopy, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], run);
  if (listed.code !== 0) {
    throw new Error(`listing wrapper generation files failed: ${listed.stderr}`);
  }
  const files = new Map<string, string>();
  const root = await realpath(workingCopy.path);
  for (const path of new Set([...tracked, ...listed.stdout.split("\0").filter(Boolean)])) {
    const fingerprint = await repositoryFile(root, path);
    if (fingerprint !== undefined) {
      files.set(path, fingerprint);
    }
  }
  return files;
}

async function repositoryFile(root: string, path: string): Promise<string | undefined> {
  try {
    const parent = await realpath(dirname(join(root, path)));
    const rel = relative(root, parent);
    if (rel === ".." || rel.startsWith("../")) {
      throw new Error(`${path} points outside the wrapper scratch copy`);
    }
    const stat = await lstat(join(root, path));
    if (stat.isDirectory()) {
      // Submodules are exported as empty directories; generation cannot populate them.
      if ((await readdir(join(root, path))).length > 0) {
        throw new Error(`wrapper generation populated repository directory ${path}`);
      }
      return undefined;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error(`${path} is not a regular repository file or symlink`);
    }
    const bytes = stat.isSymbolicLink() ? Buffer.from(await readlink(join(root, path))) : await readFile(join(root, path));
    return `${stat.mode & 0o777}:${hash(bytes)}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
