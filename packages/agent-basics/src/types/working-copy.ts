// Copied from leanish/leanish-development core/runtime/src/types/working-copy.ts at c6282df; see PROVENANCE.md.
// Local changes: the `remote-merging` start and its `conflicted` result; `PublishBranchArgs.beforePush`.
/**
 * Runtime-owned references to checked-out project working copies. Returned
 * by `runtime.syncWorkingCopies(projects)` and consumed by `runtime.runSkill`.
 *
 * Phase-1 choices:
 *   - `path` is an absolute filesystem path under the runtime's
 *     workspace root. The handler does not own its layout.
 *   - `branch` is the locally checked-out branch (matches the project's
 *     `source.branch` after a sync).
 *   - `headSha` is the commit the working copy is pinned at after sync.
 *
 * See ADR-0008.
 */
export interface WorkingCopy {
  readonly projectId: string;
  readonly path: string;
  readonly branch: string;
  readonly headSha: string;
  /**
   * The clone's git metadata when it lives outside `path` (`LocalGitWorkspace`
   * keeps it there so a coding agent that can write the working tree can't
   * plant hooks or config in it). Write runs need it: the runner shows it to
   * the agent read-only.
   */
  readonly gitDir?: string;
}

/**
 * Per-project outcome from a `syncWorkingCopies` call.
 *
 *   - `cloned` — the working copy did not exist; created from scratch.
 *   - `fast-forward` — existed at a strict ancestor of the remote head; advanced.
 *   - `no-change` — already at the expected head.
 *   - `reset` — existed but diverged; reset hard to remote (phase-1 default for
 *     dirty / divergent local state).
 *   - `dedup` — a sync for this project already happened in this process;
 *     reused the existing working copy without touching git.
 */
export type SyncOutcome =
  | "cloned"
  | "fast-forward"
  | "no-change"
  | "reset"
  | "dedup";

export interface SyncReportEntry {
  readonly projectId: string;
  readonly outcome: SyncOutcome;
  readonly fromSha?: string;
  readonly toSha: string;
}

export interface SyncResult {
  readonly workingCopies: ReadonlyArray<WorkingCopy>;
  readonly report: ReadonlyArray<SyncReportEntry>;
}

/**
 * Where a branch prepared for publication starts (`Workspace.prepareBranch`):
 *
 *   - `default` — a new branch at the tracked (default) branch's remote head;
 *   - `remote` — the branch's own remote head, as is;
 *   - `remote-merged` — the branch's remote head with the default branch's
 *     remote head merged in (no merge commit when it's already contained);
 *   - `remote-merging` — the same, but a conflicting merge is left in
 *     progress for its conflicts to be resolved in the working tree;
 *     `publishBranch` then commits the merge.
 */
export type PrepareBranchStart = "default" | "remote" | "remote-merged" | "remote-merging";

export interface PrepareBranchArgs {
  readonly branch: string;
  readonly start: PrepareBranchStart;
}

/** A branch checked out for an agent to edit, with the heads it was prepared from. */
export interface PreparedBranch {
  readonly branch: string;
  /** The default branch's remote head when the branch was prepared. */
  readonly baseSha: string;
  /** The branch's remote head when it was prepared; `null` for a new branch. */
  readonly remoteHeadSha: string | null;
  /** The commit the working tree was checked out at for the agent. */
  readonly preparedSha: string;
}

export type PrepareBranchResult =
  | { readonly kind: "prepared"; readonly prepared: PreparedBranch }
  /** `remote-merged` only: merging the default branch conflicted; nothing is checked out for an agent. */
  | { readonly kind: "conflict" }
  /**
   * `remote-merging` only: merging the default branch conflicted and the merge is in progress: `conflicted` lists
   * the paths to resolve in the working tree (`prepared.preparedSha` is the branch's head, the merge's first parent).
   */
  | { readonly kind: "conflicted"; readonly prepared: PreparedBranch; readonly conflicted: ReadonlyArray<string> };

export interface PublishBranchArgs {
  /** The commit message for the agent's working-tree changes (one commit). */
  readonly message: string;
  /**
   * Called with the commit about to be pushed, after it's committed and before the push: a caller records it here,
   * so a push that lands while what follows fails can still be recognised. If it throws, nothing is pushed.
   */
  readonly beforePush?: (sha: string) => Promise<void>;
}

export type PublishBranchResult =
  /** The branch's remote head is now `sha` (a new branch, or a fast-forward). */
  | { readonly kind: "pushed"; readonly sha: string }
  /** Nothing to publish: no working-tree changes and nothing new since the remote head. */
  | { readonly kind: "unchanged" };

export interface DeleteRemoteBranchArgs {
  readonly branch: string;
  /** The remote head the branch must still have; anything else leaves it in place. */
  readonly expectedSha: string;
}

export type DeleteRemoteBranchResult =
  | { readonly kind: "deleted" }
  /** The branch wasn't at `expectedSha` (`found`: its head, `null` when it's already gone); nothing was deleted. */
  | { readonly kind: "moved"; readonly found: string | null };
