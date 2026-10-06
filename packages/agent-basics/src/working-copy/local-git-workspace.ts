// Copied from leanish/leanish-development core/runtime/src/working-copy/local-git-workspace.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: `RepoSource` instead of catalog-it's `Project`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

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
  SyncReportEntry,
  SyncResult,
  WorkingCopy,
} from "../types/working-copy.ts";

import { cloneAuthArgs, type GitCloneAuth } from "./git-clone-auth.ts";
import type { Workspace } from "./workspace.ts";

/** Where the clones' git metadata lives, under the workspace root and outside every working tree. */
const GIT_DIRS = ".git-dirs";
/** Branch names the workspace checks out and pushes: plain refs, never an option. */
const BRANCH_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * Local-mode workspace backed by the `git` CLI. Assumes:
 *   - `git` is on PATH;
 *   - clone URLs the host can reach without extra credentials — unless
 *     `gitAuth` is supplied, in which case the matching-host clones carry a
 *     token (ADR-0014);
 *   - we may force-reset when the local copy has diverged from the remote
 *     tracked branch (phase-1 default; agents that care about local edits
 *     should bring their own workspace) — and a re-sync always leaves the copy
 *     on the tracked branch at its remote head, without what an earlier run
 *     left behind (another checked-out branch, uncommitted or untracked files).
 *
 * The working tree is the coding agent's; the git metadata is the runtime's.
 * Each clone keeps its git dir under `<root>/.git-dirs/` (the working copy has
 * only a `.git` file pointing there), every git call names `--git-dir` and
 * `--work-tree` explicitly instead of discovering them from the working tree,
 * and git runs with no system or global config, hooks or fsmonitor — so
 * nothing an agent writes in the working tree (a replaced `.git`, a
 * `.gitattributes` naming a filter) makes the runtime's git run its code.
 * Copies from the older layout (git metadata inside the working copy) are
 * discarded and cloned again.
 *
 * Per-process dedup is keyed on `project.id` — a second sync within the
 * same process returns the cached working copy with `outcome: "dedup"`.
 */
export interface LocalGitWorkspaceOptions {
  readonly workspaceRoot: string;
  /** Override `git` binary path (defaults to looking it up on PATH). */
  readonly gitBin?: string;
  /**
   * Clone-time GitHub credentials (ADR-0014). When set, the token is attached
   * — one-shot, host-matched — to the clone, fetch and push of repos on
   * `gitAuth.host`. When absent, clones rely on the remote needing none.
   */
  readonly gitAuth?: GitCloneAuth;
  /** Author and committer of what `publishBranch` and a `remote-merged` preparation commit. */
  readonly commitIdentity?: GitIdentity;
}

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * The commit identity from `AGENT_RUNTIME_GIT_NAME` and `AGENT_RUNTIME_GIT_EMAIL`
 * (both or neither); `undefined` when neither is set. Not git's own
 * `GIT_AUTHOR_*` variables: the workspace's git runs without any `GIT_*`
 * from the environment.
 */
export function resolveGitCommitIdentity(env: Readonly<Record<string, string | undefined>>): GitIdentity | undefined {
  const name = env["AGENT_RUNTIME_GIT_NAME"] ?? "";
  const email = env["AGENT_RUNTIME_GIT_EMAIL"] ?? "";
  if (name === "" && email === "") return undefined;
  if (name === "" || email === "" || /[\n<>]/.test(name + email)) {
    throw new Error("AGENT_RUNTIME_GIT_NAME and AGENT_RUNTIME_GIT_EMAIL must both be set, on one line, without '<' or '>'");
  }
  return { name, email };
}

interface Repo {
  readonly gitDir: string;
  readonly workTree: string;
  readonly url: string;
}

export class LocalGitWorkspace implements Workspace {
  readonly #root: string;
  readonly #git: string;
  readonly #gitAuth: GitCloneAuth | undefined;
  readonly #identity: GitIdentity | undefined;
  readonly #synced = new Map<string, WorkingCopy>();
  /** Source URL per working-copy path, for the network calls of prepare/publish. */
  readonly #urls = new Map<string, string>();

  constructor(options: LocalGitWorkspaceOptions) {
    this.#root = options.workspaceRoot;
    this.#git = options.gitBin ?? "git";
    this.#gitAuth = options.gitAuth;
    this.#identity = options.commitIdentity;
  }

  async sync(projects: ReadonlyArray<Project>): Promise<SyncResult> {
    await mkdir(join(this.#root, GIT_DIRS), { recursive: true });
    const workingCopies: WorkingCopy[] = [];
    const report: SyncReportEntry[] = [];
    for (const project of projects) {
      const cached = this.#synced.get(project.id);
      if (cached !== undefined) {
        workingCopies.push(cached);
        report.push({
          projectId: project.id,
          outcome: "dedup",
          toSha: cached.headSha,
        });
        continue;
      }
      const result = await this.#syncOne(project);
      this.#synced.set(project.id, result.workingCopy);
      this.#urls.set(result.workingCopy.path, project.source.url);
      workingCopies.push(result.workingCopy);
      report.push(result.report);
    }
    return { workingCopies, report };
  }

  async prepareBranch(workingCopy: WorkingCopy, args: PrepareBranchArgs): Promise<PrepareBranchResult> {
    const repo = this.#repoOf(workingCopy);
    assertBranch(args.branch);
    const base = workingCopy.branch;
    await this.#fetch(repo, base);
    const baseSha = await this.#rev(repo, `refs/remotes/origin/${base}`);
    if (args.start === "default") {
      await this.#checkout(repo, args.branch, baseSha);
      return prepared({ branch: args.branch, baseSha, remoteHeadSha: null, preparedSha: baseSha });
    }

    await this.#fetch(repo, args.branch);
    const remoteHeadSha = await this.#rev(repo, `refs/remotes/origin/${args.branch}`);
    await this.#checkout(repo, args.branch, remoteHeadSha);
    if (args.start === "remote-merged" && !(await this.#isAncestor(repo, baseSha, remoteHeadSha))) {
      const merged = await this.#runStatus(repo, [
        ...this.#identityArgs("merge"),
        "merge",
        "--no-edit",
        "--no-verify",
        `refs/remotes/origin/${base}`,
      ]);
      if (merged !== 0) {
        await this.#runStatus(repo, ["merge", "--abort"]);
        await this.#checkout(repo, args.branch, remoteHeadSha);
        return { kind: "conflict" };
      }
    }
    const preparedSha = await this.#rev(repo, "HEAD");
    return prepared({ branch: args.branch, baseSha, remoteHeadSha, preparedSha });
  }

  async publishBranch(
    workingCopy: WorkingCopy,
    preparation: PreparedBranch,
    args: PublishBranchArgs,
  ): Promise<PublishBranchResult> {
    const repo = this.#repoOf(workingCopy);
    assertBranch(preparation.branch);
    if (args.message.trim() === "") throw new Error("publishBranch: empty commit message");
    if ((await this.#currentBranch(repo)) !== preparation.branch || (await this.#rev(repo, "HEAD")) !== preparation.preparedSha) {
      throw new Error(`publishBranch: ${workingCopy.path} is no longer at the prepared ${preparation.branch} head`);
    }

    await this.#run(repo, "add", ["add", "--all"]);
    const staged = (await this.#runStatus(repo, ["diff", "--cached", "--quiet"])) === 1;
    if (staged) {
      await this.#run(repo, "commit", [...this.#identityArgs("commit"), "commit", "--no-verify", "--quiet", "-m", args.message]);
    }
    const head = await this.#rev(repo, "HEAD");
    if (head === (preparation.remoteHeadSha ?? preparation.baseSha)) return { kind: "unchanged" };

    const remoteHead = await this.#remoteHead(repo, preparation.branch);
    if (remoteHead !== preparation.remoteHeadSha) {
      throw new Error(
        `publishBranch: origin/${preparation.branch} moved since it was prepared ` +
          `(expected ${preparation.remoteHeadSha ?? "no branch"}, found ${remoteHead ?? "no branch"})`,
      );
    }
    // A plain push: GitHub refuses anything but a fast-forward or a new branch.
    await this.#run(repo, "push", [
      ...cloneAuthArgs(this.#gitAuth, repo.url),
      "push",
      "--no-verify",
      "--quiet",
      "origin",
      `${head}:refs/heads/${preparation.branch}`,
    ]);
    return { kind: "pushed", sha: head };
  }

  async deleteRemoteBranch(workingCopy: WorkingCopy, args: DeleteRemoteBranchArgs): Promise<DeleteRemoteBranchResult> {
    const repo = this.#repoOf(workingCopy);
    assertBranch(args.branch);
    // The lease makes the remote refuse the deletion unless the branch is still at `expectedSha`.
    const code = await this.#runStatus(repo, [
      ...cloneAuthArgs(this.#gitAuth, repo.url),
      "push",
      "--no-verify",
      "--quiet",
      `--force-with-lease=refs/heads/${args.branch}:${args.expectedSha}`,
      "origin",
      `:refs/heads/${args.branch}`,
    ]);
    if (code === 0) return { kind: "deleted" };
    const found = await this.#remoteHead(repo, args.branch);
    if (found !== args.expectedSha) return { kind: "moved", found };
    throw new Error(`deleteRemoteBranch: git push exited with code ${code} deleting origin/${args.branch}`);
  }

  async #syncOne(
    project: Project,
  ): Promise<{ workingCopy: WorkingCopy; report: SyncReportEntry }> {
    const id = sanitizeProjectId(project.id);
    const repo: Repo = { workTree: join(this.#root, id), gitDir: join(this.#root, GIT_DIRS, id), url: project.source.url };
    const branch = project.source.branch;
    assertBranch(branch);
    if (!existsSync(repo.gitDir) || !existsSync(repo.workTree)) {
      // Missing either half, or the older layout with `.git` inside the working copy: start over.
      await rm(repo.workTree, { recursive: true, force: true });
      await rm(repo.gitDir, { recursive: true, force: true });
      await this.#runIn(this.#root, "clone", [
        ...cloneAuthArgs(this.#gitAuth, repo.url),
        "clone",
        `--separate-git-dir=${repo.gitDir}`,
        "--branch",
        branch,
        "--",
        repo.url,
        repo.workTree,
      ]);
      const headSha = await this.#rev(repo, "HEAD");
      return {
        workingCopy: workingCopyOf(project.id, repo, branch, headSha),
        report: { projectId: project.id, outcome: "cloned", toSha: headSha },
      };
    }
    const fromSha = await this.#rev(repo, "HEAD");
    await this.#fetch(repo, branch);
    const remoteHead = await this.#rev(repo, `refs/remotes/origin/${branch}`);
    // An earlier run may have left the copy on another branch (e.g. an agent's
    // PR branch) or with local changes; only a clean copy on the tracked branch
    // counts as unchanged or fast-forwardable.
    const tidyOnBranch = (await this.#currentBranch(repo)) === branch && (await this.#isClean(repo));
    if (tidyOnBranch && fromSha === remoteHead) {
      return {
        workingCopy: workingCopyOf(project.id, repo, branch, fromSha),
        report: { projectId: project.id, outcome: "no-change", fromSha, toSha: fromSha },
      };
    }
    const outcome: SyncOutcome =
      tidyOnBranch && (await this.#isAncestor(repo, fromSha, remoteHead)) ? "fast-forward" : "reset";
    await this.#checkout(repo, branch, remoteHead);
    return {
      workingCopy: workingCopyOf(project.id, repo, branch, remoteHead),
      report: { projectId: project.id, outcome, fromSha, toSha: remoteHead },
    };
  }

  #repoOf(workingCopy: WorkingCopy): Repo {
    const url = this.#urls.get(workingCopy.path);
    if (url === undefined || workingCopy.gitDir === undefined) {
      throw new Error(`LocalGitWorkspace: ${workingCopy.path} wasn't synced by this workspace`);
    }
    return { gitDir: workingCopy.gitDir, workTree: workingCopy.path, url };
  }

  async #fetch(repo: Repo, branch: string): Promise<void> {
    await this.#run(repo, "fetch", [
      ...cloneAuthArgs(this.#gitAuth, repo.url),
      "fetch",
      "--quiet",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
  }

  /** `branch` at `sha`, the working tree matching it exactly (untracked and ignored files removed). */
  async #checkout(repo: Repo, branch: string, sha: string): Promise<void> {
    await this.#run(repo, "checkout", ["checkout", "--quiet", "--force", "-B", branch, sha]);
    await this.#run(repo, "clean", ["clean", "-ffdxq"]);
  }

  /** The branch's head on origin, or `null` when it has none. */
  async #remoteHead(repo: Repo, branch: string): Promise<string | null> {
    const { stdout } = await this.#capture(repo, [
      ...cloneAuthArgs(this.#gitAuth, repo.url),
      "ls-remote",
      "--heads",
      "origin",
      `refs/heads/${branch}`,
    ]);
    const line = stdout.split("\n").find((entry) => entry.endsWith(`\trefs/heads/${branch}`));
    return line === undefined ? null : line.split("\t")[0]!;
  }

  /** The checked-out branch, or undefined on a detached HEAD. */
  async #currentBranch(repo: Repo): Promise<string | undefined> {
    try {
      const { stdout } = await this.#capture(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  async #isClean(repo: Repo): Promise<boolean> {
    const { stdout } = await this.#capture(repo, ["status", "--porcelain", "--untracked-files=all"]);
    return stdout.trim() === "";
  }

  async #rev(repo: Repo, ref: string): Promise<string> {
    const { stdout } = await this.#capture(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return stdout.trim();
  }

  async #isAncestor(repo: Repo, ancestor: string, descendant: string): Promise<boolean> {
    const code = await this.#runStatus(repo, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return code === 0;
  }

  #identityArgs(operation: string): string[] {
    if (this.#identity === undefined) throw new Error(`LocalGitWorkspace: git ${operation} needs a commitIdentity`);
    return ["-c", `user.name=${this.#identity.name}`, "-c", `user.email=${this.#identity.email}`];
  }

  async #run(repo: Repo, label: string, args: ReadonlyArray<string>): Promise<void> {
    const code = await this.#runStatus(repo, args);
    if (code !== 0) {
      throw new Error(`git ${label} exited with code ${code}; args=[${redactArgs(args)}]`);
    }
  }

  async #runIn(cwd: string, label: string, args: ReadonlyArray<string>): Promise<void> {
    const code = await this.#spawnStatus(cwd, args);
    if (code !== 0) {
      throw new Error(`git ${label} exited with code ${code}; args=[${redactArgs(args)}]`);
    }
  }

  #runStatus(repo: Repo, args: ReadonlyArray<string>): Promise<number> {
    return this.#spawnStatus(repo.workTree, [...repoArgs(repo), ...args]);
  }

  #spawnStatus(cwd: string, args: ReadonlyArray<string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#git, [...TRUSTED_CONFIG_ARGS, ...args], { cwd, env: trustedGitEnv(), stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? -1));
    });
  }

  #capture(repo: Repo, args: ReadonlyArray<string>): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#git, [...TRUSTED_CONFIG_ARGS, ...repoArgs(repo), ...args], {
        cwd: repo.workTree,
        env: trustedGitEnv(),
        stdio: ["ignore", "pipe", "inherit"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve({ stdout });
        else reject(new Error(`git ${redactArgs(args)} exited with code ${code}`));
      });
    });
  }
}

/** Never run hooks or an fsmonitor command, whatever the repo's own config says. */
const TRUSTED_CONFIG_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

function repoArgs(repo: Repo): string[] {
  return [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`];
}

/**
 * The process env minus everything git reads as configuration or repository
 * location, and with no system or global config: a filter, credential helper
 * or alias defined there can't be reached through anything the agent writes.
 */
function trustedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_")) env[name] = value;
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

function workingCopyOf(projectId: string, repo: Repo, branch: string, headSha: string): WorkingCopy {
  return { projectId, path: repo.workTree, branch, headSha, gitDir: repo.gitDir };
}

function prepared(preparation: PreparedBranch): PrepareBranchResult {
  return { kind: "prepared", prepared: preparation };
}

function assertBranch(branch: string): void {
  if (!BRANCH_PATTERN.test(branch) || branch.includes("..") || branch.endsWith(".lock") || branch.endsWith("/")) {
    throw new Error(`LocalGitWorkspace: '${branch}' isn't a branch name it handles`);
  }
}

/**
 * Render git args for an error message with any credential value masked. The
 * clone-auth `-c http.…extraheader=Authorization: Basic <base64>` arg carries a
 * reversible token; git failures surface in logs, local stderr, and terminal
 * replies, so the value must never appear there. Keeps the key (host) visible.
 */
function redactArgs(args: ReadonlyArray<string>): string {
  return args
    .map((arg) => (arg.includes("extraheader=") ? arg.replace(/extraheader=.*/s, "extraheader=<redacted>") : arg))
    .join(" ");
}

function sanitizeProjectId(id: string): string {
  // owner/slug → owner__slug; safe for a filesystem directory under WORKSPACE_ROOT.
  return id.replace(/\//g, "__");
}
