// Copied from leanish/leanish-development core/runtime/src/working-copy/in-memory-workspace.ts at c6282df; see PROVENANCE.md.
// Local changes: `RepoSource` instead of catalog-it's `Project`; `remote-merging` (a scheduled conflict lists package-lock.json);
// calls `beforePush`.
import type { RepoSource as Project } from "../types/repo-source.ts";

import type {
  DeleteRemoteBranchArgs,
  DeleteRemoteBranchResult,
  PrepareBranchArgs,
  PrepareBranchResult,
  PreparedBranch,
  PublishBranchArgs,
  PublishBranchResult,
  SyncOutcome,
  SyncResult,
  SyncReportEntry,
  WorkingCopy,
} from "../types/working-copy.ts";

import type { Workspace } from "./workspace.ts";

/**
 * Workspace that fabricates `WorkingCopy` records without touching disk
 * or git. Used in tests where the agent contract is what's being exercised
 * and the on-disk source isn't.
 *
 * The `path` returned is a synthetic `/synthetic/<projectId>` string.
 *
 * Outcomes the fake can produce (matches the spec's 5-way `SyncOutcome`):
 *
 *   - `cloned`        — first sync for the project (or first since
 *                       `setExpectedOutcome` declared a fresh value).
 *   - `dedup`         — a sync for this project already happened in the
 *                       same `InMemoryWorkspace`; reuses the existing
 *                       working copy without mutating the report shape.
 *   - `no-change`     — opt-in via `setExpectedOutcome(id, "no-change", sha)`;
 *                       returns the existing working copy with `toSha`
 *                       matching the previously synced sha.
 *   - `fast-forward`  — opt-in via `setExpectedOutcome(id, "fast-forward", newSha)`;
 *                       advances the stored `headSha` while preserving
 *                       `branch` + `path`, and emits a `fromSha`/`toSha`
 *                       report entry.
 *   - `reset`         — opt-in via `setExpectedOutcome(id, "reset", newSha)`;
 *                       same shape as `fast-forward` but the outcome string
 *                       tells the consumer the local state diverged.
 *
 * `prepareBranch` / `publishBranch` record their calls (`preparations`,
 * `publications`) and answer with synthetic SHAs: a branch prepared from
 * `remote` / `remote-merged` has the remote head `setRemoteHead` gave it (or
 * `"a".repeat(40)`), and a publication pushes `"c".repeat(40)`.
 * `setPrepareConflict(branch)` makes the next `remote-merged` preparation of
 * that branch conflict, `setPublishUnchanged()` the next publication report
 * `unchanged`. `deleteRemoteBranch` records `deletions` and deletes, unless
 * `setDeleteMoved(branch, found)` made the next deletion of that branch find
 * another head.
 *
 * Per-test overrides are queued via `setExpectedOutcome`; the next `sync()`
 * for that project consumes the queue entry and reverts to the default
 * cloned/dedup behaviour after.
 */
interface ScheduledOutcome {
  readonly outcome: Exclude<SyncOutcome, "cloned" | "dedup">;
  readonly toSha: string;
}

export class InMemoryWorkspace implements Workspace {
  readonly #synced = new Map<string, WorkingCopy>();
  readonly #scheduled = new Map<string, ScheduledOutcome>();
  readonly #remoteHeads = new Map<string, string>();
  readonly #conflicts = new Set<string>();
  #nextPublishUnchanged = false;
  readonly #movedOnDelete = new Map<string, string | null>();
  /** Every `prepareBranch` call, in order. */
  readonly preparations: Array<{ readonly projectId: string; readonly args: PrepareBranchArgs }> = [];
  /** Every `publishBranch` call, in order. */
  readonly publications: Array<{ readonly projectId: string; readonly prepared: PreparedBranch; readonly args: PublishBranchArgs }> = [];
  /** Every `deleteRemoteBranch` call, in order. */
  readonly deletions: Array<{ readonly projectId: string; readonly args: DeleteRemoteBranchArgs }> = [];

  setRemoteHead(branch: string, sha: string): void {
    this.#remoteHeads.set(branch, sha);
  }

  setPrepareConflict(branch: string): void {
    this.#conflicts.add(branch);
  }

  setPublishUnchanged(): void {
    this.#nextPublishUnchanged = true;
  }

  setDeleteMoved(branch: string, found: string | null): void {
    this.#movedOnDelete.set(branch, found);
  }

  async prepareBranch(workingCopy: WorkingCopy, args: PrepareBranchArgs): Promise<PrepareBranchResult> {
    this.preparations.push({ projectId: workingCopy.projectId, args });
    const baseSha = workingCopy.headSha;
    const remoteHeadSha = args.start === "default" ? null : (this.#remoteHeads.get(args.branch) ?? "a".repeat(40));
    if (args.start === "remote-merged" && this.#conflicts.delete(args.branch)) return { kind: "conflict" };
    if (args.start === "remote-merging" && this.#conflicts.delete(args.branch)) {
      return { kind: "conflicted", prepared: { branch: args.branch, baseSha, remoteHeadSha, preparedSha: remoteHeadSha! }, conflicted: ["package-lock.json"] };
    }
    const preparedSha = args.start === "remote-merged" || args.start === "remote-merging" ? "b".repeat(40) : (remoteHeadSha ?? baseSha);
    return { kind: "prepared", prepared: { branch: args.branch, baseSha, remoteHeadSha, preparedSha } };
  }

  async publishBranch(workingCopy: WorkingCopy, prepared: PreparedBranch, args: PublishBranchArgs): Promise<PublishBranchResult> {
    this.publications.push({ projectId: workingCopy.projectId, prepared, args });
    if (this.#nextPublishUnchanged) {
      this.#nextPublishUnchanged = false;
      return { kind: "unchanged" };
    }
    await args.beforePush?.("c".repeat(40));
    return { kind: "pushed", sha: "c".repeat(40) };
  }

  async deleteRemoteBranch(workingCopy: WorkingCopy, args: DeleteRemoteBranchArgs): Promise<DeleteRemoteBranchResult> {
    this.deletions.push({ projectId: workingCopy.projectId, args });
    if (!this.#movedOnDelete.has(args.branch)) return { kind: "deleted" };
    const found = this.#movedOnDelete.get(args.branch) ?? null;
    this.#movedOnDelete.delete(args.branch);
    return { kind: "moved", found };
  }

  /**
   * Force the **next** `sync()` call for `projectId` to report the given
   * non-default outcome. The first sync must have already happened
   * (otherwise there's nothing to "fast-forward" or "reset" from);
   * `cloned` is implicit on first sync. Single-use — once consumed the
   * queue entry is dropped.
   */
  setExpectedOutcome(
    projectId: string,
    outcome: ScheduledOutcome["outcome"],
    toSha: string,
  ): void {
    this.#scheduled.set(projectId, { outcome, toSha });
  }

  async sync(projects: ReadonlyArray<Project>): Promise<SyncResult> {
    const workingCopies: WorkingCopy[] = [];
    const report: SyncReportEntry[] = [];
    for (const project of projects) {
      const existing = this.#synced.get(project.id);
      const scheduled = this.#scheduled.get(project.id);

      if (existing !== undefined && scheduled !== undefined) {
        // Honor the test's scheduled outcome — advance / reset the head.
        this.#scheduled.delete(project.id);
        const advanced: WorkingCopy = {
          projectId: existing.projectId,
          path: existing.path,
          branch: existing.branch,
          headSha: scheduled.toSha,
          gitDir: `${existing.path}/.git`,
        };
        this.#synced.set(project.id, advanced);
        workingCopies.push(advanced);
        report.push({
          projectId: project.id,
          outcome: scheduled.outcome,
          fromSha: existing.headSha,
          toSha: scheduled.toSha,
        });
        continue;
      }

      if (existing !== undefined) {
        // Default: a repeated sync without a scheduled outcome is a dedup.
        workingCopies.push(existing);
        report.push({
          projectId: project.id,
          outcome: "dedup",
          toSha: existing.headSha,
        });
        continue;
      }

      // First sync for this project.
      const workingCopy: WorkingCopy = {
        projectId: project.id,
        path: this.#pathFor(project),
        branch: project.source.branch,
        headSha: this.#shaFor(project),
        gitDir: `${this.#pathFor(project)}/.git`,
      };
      this.#synced.set(project.id, workingCopy);
      workingCopies.push(workingCopy);
      report.push({
        projectId: project.id,
        outcome: "cloned",
        toSha: workingCopy.headSha,
      });
    }
    return { workingCopies, report };
  }

  #pathFor(project: Project): string {
    return `/synthetic/${project.id}`;
  }

  #shaFor(_project: Project): string {
    return "0".repeat(40);
  }
}
