/**
 * GitHub Actions as an ecosystem: every `uses:` in the repository's workflows
 * (`.github/workflows/*.yml`), its composite actions (`.github/actions/**`
 * and any local `./` action a workflow uses) and a root `action.yml`.
 *
 * Files are parsed as YAML (comments kept, so `uses: owner/repo@<sha> #
 * v7.0.1` gives the version), every `uses:` key in the document counts, and a
 * file that doesn't parse fails the run. Local `./` uses are followed to their
 * `action.yml`; `docker://` uses are coverage gaps.
 *
 * A use resolves to a version when its ref is a full commit SHA and its
 * comment names a tag that points at that commit (checked with GitHub).
 */
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import type { ActionsGitHub } from "./actions-github.ts";
import type { Tree } from "./tree.ts";

export interface ActionUse {
  /** `owner/repo`, lower case. */
  readonly name: string;
  /** What follows `owner/repo` (a subdirectory or a reusable workflow's path), if anything. */
  readonly path: string | undefined;
  readonly ref: string;
  /** The trailing comment, trimmed, if any. */
  readonly comment: string | undefined;
  /** The file it's used in. */
  readonly file: string;
}

export interface ActionsInventory {
  readonly uses: ReadonlyArray<ActionUse>;
  /** `docker://` uses: no advisory source covers them. */
  readonly docker: ReadonlyArray<string>;
}

const USES = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/[^@\s]+)?@([^@\s]+)$/;

/** The `uses:` of one workflow or action file. */
export function parseUses(text: string, file: string): { uses: ActionUse[]; local: string[]; docker: string[] } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`${file} isn't valid YAML: ${doc.errors[0]!.message}`);
  const uses: ActionUse[] = [];
  const local: string[] = [];
  const docker: string[] = [];
  const walk = (node: unknown): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        if (isScalar(pair.key) && pair.key.value === "uses") {
          if (!isScalar(pair.value) || typeof pair.value.value !== "string") throw new Error(`${file}: a \`uses:\` isn't a string`);
          const value = pair.value.value.trim();
          if (value.startsWith("./")) local.push(value);
          else if (value.startsWith("docker://")) docker.push(`${value} (${file})`);
          else {
            const match = USES.exec(value);
            if (match === null) throw new Error(`${file}: can't read \`uses: ${value}\``);
            uses.push({
              name: `${match[1]}/${match[2]}`.toLowerCase(),
              path: match[3]?.slice(1),
              ref: match[4]!,
              comment: pair.value.comment?.trim() || undefined,
              file,
            });
          }
        }
        walk(pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) walk(item);
    }
  };
  walk(doc.contents);
  return { uses, local, docker };
}

/** Every `uses:` in the tree's workflows and actions, local actions followed. */
export async function readActionsInventory(tree: Tree): Promise<ActionsInventory> {
  const queue = [
    ...(await tree.list(".github/workflows")).filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)),
    ...(await tree.list(".github/actions")).filter((path) => /\/action\.ya?ml$/.test(path)),
    ...["action.yml", "action.yaml"],
  ];
  const seen = new Set<string>();
  const uses: ActionUse[] = [];
  const docker: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await tree.read(file);
    if (text === undefined) continue;
    const parsed = parseUses(text, file);
    uses.push(...parsed.uses);
    docker.push(...parsed.docker);
    for (const dir of parsed.local) {
      const base = dir.replace(/^\.\//, "").replace(/\/+$/, "");
      queue.push(`${base}/action.yml`, `${base}/action.yaml`);
    }
  }
  return { uses, docker };
}

export type Resolution =
  | { readonly kind: "pinned"; readonly version: string }
  | { readonly kind: "unpinned" }
  | { readonly kind: "unverified"; readonly reason: string };

const COMMIT = /^[0-9a-f]{40}$/;
const TAG = /^(?:tag=)?(v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)$/;

/** Whether a use is pinned to a commit whose comment names a tag that GitHub says points at it. */
export async function resolveUse(use: ActionUse, github: ActionsGitHub): Promise<Resolution> {
  if (!COMMIT.test(use.ref)) return { kind: "unpinned" };
  const tag = use.comment?.split(/\s+/).map((word) => TAG.exec(word)?.[1]).find((word) => word !== undefined);
  if (tag === undefined) return { kind: "unverified", reason: "no `# vX.Y.Z` comment names its version" };
  const commit = await github.tagCommit(use.name, tag);
  if (commit === undefined) return { kind: "unverified", reason: `${use.name} has no tag ${tag}` };
  if (commit !== use.ref) return { kind: "unverified", reason: `tag ${tag} of ${use.name} points at ${commit.slice(0, 12)}, not ${use.ref.slice(0, 12)}` };
  return { kind: "pinned", version: tag };
}
