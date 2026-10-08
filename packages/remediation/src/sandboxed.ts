/**
 * Runs a command that executes repository code (the Gradle inventory, a
 * build) under `codex sandbox` with the agent's own write permission profile,
 * so it can't reach what the tool's process can: the Keychain (where the
 * write token lives), the sensitive home paths, anything but the working
 * copy, the temp dirs and the build cache for writes. No model is involved.
 * Its environment is the scrubbed one the agent's commands get, without any
 * credential.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodexRunnerOptions } from "../../agent-basics/src/skill/codex-runner.ts";
import { codexPermissionArgs } from "../../agent-basics/src/skill/codex-permissions.ts";
import { scrubbedProcessEnv, withoutAmbientCredentials } from "../../agent-basics/src/skill/spawn-capture.ts";
import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { runProcess, type RunProcess } from "../../ci/src/process.ts";

export interface SandboxedCommand {
  readonly workingCopy: WorkingCopy;
  /** The command and its arguments, run with the working copy as its directory. */
  readonly command: ReadonlyArray<string>;
}

/** The isolation the agent runs with (`codexIsolation`): denied paths, build cache and command env. */
export type Isolation = Pick<CodexRunnerOptions, "readDenied" | "buildCacheRoot" | "env">;

export async function runSandboxed(
  isolation: Isolation,
  { workingCopy, command }: SandboxedCommand,
  run: RunProcess = runProcess,
  codex = "codex",
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (command.length === 0) throw new Error("runSandboxed needs a command");
  if (workingCopy.gitDir === undefined) throw new Error(`${workingCopy.path}'s git metadata must be in a separate directory`);
  // `codexPermissionArgs` denies the staged Codex home's auth.json; a sandboxed command has no Codex home, so an empty one.
  const stagedHome = await mkdtemp(join(tmpdir(), "sandboxed-"));
  try {
    const args = codexPermissionArgs({
      access: "write",
      gitDirs: [workingCopy.gitDir],
      stagedHome,
      writableRoots: isolation.buildCacheRoot === undefined ? [] : [isolation.buildCacheRoot],
      readDenied: isolation.readDenied ?? [],
      readAllowed: [],
    });
    const env = { ...withoutAmbientCredentials(scrubbedProcessEnv()), ...isolation.env, CODEX_HOME: stagedHome };
    return await run(codex, ["sandbox", ...args, "--", ...command], { cwd: workingCopy.path, env });
  } finally {
    await rm(stagedHome, { recursive: true, force: true });
  }
}
