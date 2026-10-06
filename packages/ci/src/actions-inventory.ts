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
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";

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
  /** Every workflow and action file read, even one without any `uses:`. */
  readonly files: ReadonlyArray<string>;
  /** Local actions a workflow uses that have no `action.yml`. */
  readonly gaps: ReadonlyArray<string>;
}

const USES = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/[^@\s]+)?@([^@\s]+)$/;

/** The `uses:` of one workflow or action file; YAML aliases are followed, keeping the anchor's comment. */
export function parseUses(text: string, file: string): { uses: ActionUse[]; local: string[]; docker: string[] } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`${file} isn't valid YAML: ${doc.errors[0]!.message}`);
  const uses: ActionUse[] = [];
  const local: string[] = [];
  const docker: string[] = [];
  const visited = new Set<unknown>();
  const resolve = (node: unknown): unknown => (isAlias(node) ? node.resolve(doc) : node);
  const walk = (start: unknown): void => {
    const node = resolve(start);
    if (visited.has(node)) return;
    visited.add(node);
    if (isMap(node)) {
      for (const pair of node.items) {
        if (isScalar(pair.key) && pair.key.value === "uses") {
          const value = resolve(pair.value);
          if (!isScalar(value) || typeof value.value !== "string") throw new Error(`${file}: a \`uses:\` isn't a string`);
          const comment = (isScalar(pair.value) ? pair.value.comment : undefined) ?? (isAlias(pair.value) ? pair.value.comment : undefined) ?? value.comment;
          record(value.value.trim(), comment?.trim() || undefined);
        }
        walk(pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) walk(item);
    }
  };
  const record = (value: string, comment: string | undefined) => {
    if (value.startsWith("./")) local.push(value);
    else if (value.startsWith("docker://")) docker.push(`${value} (${file})`);
    else {
      const match = USES.exec(value);
      if (match === null) throw new Error(`${file}: can't read \`uses: ${value}\``);
      uses.push({ name: `${match[1]}/${match[2]}`.toLowerCase(), path: match[3]?.slice(1), ref: match[4]!, comment, file });
    }
  };
  walk(doc.contents);
  return { uses, local, docker };
}

/** Every `uses:` in the tree's workflows and actions, local actions followed. */
export async function readActionsInventory(tree: Tree): Promise<ActionsInventory> {
  const queue: Array<{ files: string[]; from: string | undefined }> = [
    ...(await tree.list(".github/workflows")).filter((path) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)).map((file) => ({ files: [file], from: undefined })),
    ...(await tree.list(".github/actions")).filter((path) => /\/action\.ya?ml$/.test(path)).map((file) => ({ files: [file], from: undefined })),
    { files: ["action.yml", "action.yaml"], from: undefined },
  ];
  const seen = new Set<string>();
  const uses: ActionUse[] = [];
  const docker: string[] = [];
  const files: string[] = [];
  const gaps: string[] = [];
  while (queue.length > 0) {
    const { files: candidates, from } = queue.shift()!;
    let found = false;
    for (const file of candidates) {
      if (seen.has(file)) {
        found = true;
        continue;
      }
      const text = await tree.read(file);
      if (text === undefined) continue;
      seen.add(file);
      found = true;
      files.push(file);
      const parsed = parseUses(text, file);
      uses.push(...parsed.uses);
      docker.push(...parsed.docker);
      for (const dir of parsed.local) {
        const base = dir.replace(/^\.\//, "").replace(/\/+$/, "");
        queue.push({ files: [`${base}/action.yml`, `${base}/action.yaml`], from: `${dir} (${file})` });
      }
    }
    if (!found && from !== undefined) gaps.push(`GitHub Actions local action ${from} has no action.yml, so what it uses isn't read`);
  }
  return { uses, docker, files, gaps };
}

export type Resolution =
  | { readonly kind: "pinned"; readonly version: string }
  | { readonly kind: "unpinned" }
  | { readonly kind: "unverified"; readonly reason: string };

const COMMIT = /^[0-9a-f]{40}$/;
/** A full release version (`v7.0.1`): a floating major tag (`v7`) can't name what's pinned. */
const TAG = /^(?:tag=)?(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

/** The tag a use's comment names, if any. */
export function commentTag(use: Pick<ActionUse, "comment">): string | undefined {
  return use.comment?.split(/\s+/).map((word) => TAG.exec(word)?.[1]).find((word) => word !== undefined);
}

/** Uses that resolve the same way: same action, ref and named tag. */
export function resolutionKey(use: ActionUse): string {
  return `${use.name}@${use.ref}#${commentTag(use) ?? ""}`;
}

/** One occurrence: where, what and how it's annotated; a changed comment or a new file is a change. */
export function occurrenceKey(use: ActionUse): string {
  return `${use.file}|${use.name}@${use.ref}|${use.comment ?? ""}`;
}

/** Whether a use is pinned to a commit whose comment names a tag that GitHub says points at it. */
export async function resolveUse(use: ActionUse, github: ActionsGitHub): Promise<Resolution> {
  if (!COMMIT.test(use.ref)) return { kind: "unpinned" };
  const tag = commentTag(use);
  if (tag === undefined) return { kind: "unverified", reason: "no `# vX.Y.Z` comment names its full version" };
  const commit = await github.tagCommit(use.name, tag);
  if (commit === undefined) return { kind: "unverified", reason: `${use.name} has no tag ${tag}` };
  if (commit !== use.ref) return { kind: "unverified", reason: `tag ${tag} of ${use.name} points at ${commit.slice(0, 12)}, not ${use.ref.slice(0, 12)}` };
  return { kind: "pinned", version: tag };
}
