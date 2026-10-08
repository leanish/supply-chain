// Copied from leanish/leanish-development core/runtime/src/skill/wc-mount.ts at e4f8a1e; see PROVENANCE.md.
import type { WorkingCopy } from "../types/working-copy.ts";

/**
 * How a runner mounts a set of `WorkingCopy` records into a coding-agent
 * subprocess. `cwd` is the spawn directory (always one path); `addDirs` is
 * every additional working-copy path the subprocess should be able to
 * read/edit. Both Claude Code and the Codex CLI expose `--add-dir`-style
 * flags for the latter; each runner translates `addDirs` into its own
 * argv shape.
 *
 * Empty `workingCopies` → spawn from `process.cwd()`, no extra mounts.
 */
export interface WorkingCopyMount {
  readonly cwd: string;
  readonly addDirs: ReadonlyArray<string>;
}

export function resolveWorkingCopyMount(
  workingCopies: ReadonlyArray<WorkingCopy>,
): WorkingCopyMount {
  if (workingCopies.length === 0) {
    return { cwd: process.cwd(), addDirs: [] };
  }
  const first = workingCopies[0]!;
  const rest = workingCopies.slice(1);
  return {
    cwd: first.path,
    addDirs: rest.map((w) => w.path),
  };
}
