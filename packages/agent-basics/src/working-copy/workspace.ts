// Copied from leanish/leanish-development core/runtime/src/working-copy/workspace.ts at c6282df; see PROVENANCE.md.
// Local changes: `RepoSource` instead of catalog-it's `Project`.
import type { RepoSource as Project } from "../types/repo-source.ts";

import type {
  DeleteRemoteBranchArgs,
  DeleteRemoteBranchResult,
  PrepareBranchArgs,
  PrepareBranchResult,
  PreparedBranch,
  PublishBranchArgs,
  PublishBranchResult,
  SyncResult,
  WorkingCopy,
} from "../types/working-copy.ts";

/**
 * Workspace abstraction. AWS-mode + local-mode (CLI-driven `git`)
 * implementations live alongside each other and share this interface.
 *
 * Implementations MUST deduplicate within a single process: a second
 * `sync()` for an already-synced project returns the same `WorkingCopy`
 * with `outcome: "dedup"` and no remote round-trip.
 *
 * `prepareBranch` / `publishBranch` let a handler publish what a coding agent
 * edited without the agent touching git: the runtime checks the branch out,
 * the agent only edits the working tree, and the runtime commits and pushes
 * (never forced) with its own credentials; `deleteRemoteBranch` deletes a
 * branch only while it is still at the head the caller checked.
 */
export interface Workspace {
  sync(projects: ReadonlyArray<Project>): Promise<SyncResult>;
  prepareBranch(workingCopy: WorkingCopy, args: PrepareBranchArgs): Promise<PrepareBranchResult>;
  publishBranch(workingCopy: WorkingCopy, prepared: PreparedBranch, args: PublishBranchArgs): Promise<PublishBranchResult>;
  deleteRemoteBranch(workingCopy: WorkingCopy, args: DeleteRemoteBranchArgs): Promise<DeleteRemoteBranchResult>;
}
