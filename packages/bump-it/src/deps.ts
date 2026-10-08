/** The external boundaries bump-it reaches; tests replace each without networking or agents. */
import { tmpdir } from "node:os";

import type { WorkingCopy } from "../../agent-basics/src/types/working-copy.ts";
import { bumpCandidates, type BumpCandidates } from "../../ci/src/candidates.ts";
import type { GateEnvironment, GradleInputs } from "../../ci/src/gate.ts";
import { namingFailures } from "../../ci/src/http.ts";
import { runProcess } from "../../ci/src/process.ts";
import { gitTree, type Tree, workingTree } from "../../ci/src/tree.ts";
import type { ToolRunContext } from "../../remediation/src/command.ts";
import { changedSince } from "../../remediation/src/git-copies.ts";
import { type GradleInventories, sandboxedGradleInventories } from "../../remediation/src/inventories.ts";
import { FileJournal, type PublicationJournal } from "../../remediation/src/journal.ts";
import { ensureOsvScanner, verifyingRun } from "../../remediation/src/osv-scanner.ts";
import { revertToBase } from "../../remediation/src/reconcile.ts";

import { removeLocalFile, writeLocalFile } from "./files.ts";
import type { NpmResult } from "./npm-compute.ts";
import { computeOnBase } from "./npm-runtime.ts";
import { filePriority, type MajorPriority } from "./priority.ts";
import type { Unit } from "./units.ts";
import { verifyPlan, type VerifyInputs } from "./verify.ts";

export interface BumpItDeps {
  readonly gate: (context: ToolRunContext) => Promise<GateEnvironment>;
  readonly gradle: (context: ToolRunContext) => GradleInventories;
  readonly trees: { readonly commit: (workingCopy: WorkingCopy, sha: string) => Promise<Tree>; readonly working: (workingCopy: WorkingCopy) => Tree };
  readonly candidates: (tree: Tree, env: GateEnvironment, gradle: GradleInputs) => Promise<BumpCandidates>;
  readonly npm: (context: ToolRunContext, unit: Unit, base: Tree, env: GateEnvironment, gradle: GradleInputs["head"]) => Promise<NpmResult>;
  readonly verify: (inputs: VerifyInputs) => Promise<string[]>;
  readonly changedSince: (workingCopy: WorkingCopy, sha: string) => Promise<string[]>;
  readonly journal: (context: ToolRunContext) => PublicationJournal;
  readonly priority: (context: ToolRunContext) => MajorPriority;
  readonly writeFile: (workingCopy: WorkingCopy, path: string, content: string) => Promise<void>;
  readonly removeFile: (workingCopy: WorkingCopy, path: string) => Promise<void>;
  readonly revert: (workingCopy: WorkingCopy, baseSha: string) => Promise<ReadonlyArray<string>>;
}

export function defaultDeps(): BumpItDeps {
  return {
    async gate(context) {
      const writable = [context.config.dirs.cache, context.workingCopy.path, tmpdir(), "/tmp", ...(context.isolation.buildCacheRoot === undefined ? [] : [context.isolation.buildCacheRoot])];
      const osv = await ensureOsvScanner(context.config.dirs.state, writable);
      return { run: verifyingRun(runProcess, osv), fetch: namingFailures((url, init) => fetch(url, init)), now: () => new Date(), osvScanner: osv.path, githubToken: context.readToken };
    },
    gradle: (context) => sandboxedGradleInventories(context.isolation, context.workingCopy),
    trees: { commit: (workingCopy, sha) => gitTree(workingCopy.path, sha, runProcess), working: (workingCopy) => workingTree(workingCopy.path) },
    candidates: bumpCandidates,
    npm: computeOnBase,
    verify: verifyPlan,
    changedSince,
    journal: (context) => new FileJournal(context.config.dirs.state),
    priority: (context) => filePriority(context.config.dirs.state, context.repo.repo),
    writeFile: (workingCopy, path, content) => writeLocalFile(workingCopy.path, path, content),
    removeFile: (workingCopy, path) => removeLocalFile(workingCopy.path, path),
    revert: revertToBase,
  };
}
