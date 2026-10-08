/** Bound Node API types to the oldest runtime declared by the repository and its workspaces. */
import { posix } from "node:path";

import semver from "semver";
import { parse } from "yaml";

import type { Tree } from "./tree.ts";

interface Declaration {
  readonly lockfile: string;
  readonly workspace: string;
}

export interface NodeRuntime {
  readonly major: number | undefined;
  readonly sources: ReadonlyArray<string>;
}

interface Evidence {
  readonly major: number;
  readonly source: string;
}

/** Use the minimum across evidence, so a newer development/CI runtime cannot raise the support floor. */
export async function nodeRuntime(tree: Tree, declarations: ReadonlyArray<Declaration>): Promise<NodeRuntime> {
  const roots = new Set([".", ...declarations.flatMap((declaration) => {
    const root = posix.dirname(declaration.lockfile);
    return [root, posix.join(root, declaration.workspace)];
  })]);
  const evidence: Evidence[] = [];
  for (const root of [...roots].sort()) {
    const manifestPath = posix.join(root, "package.json");
    const manifest = objectOf(await tree.read(manifestPath));
    addEvidence(evidence, engineMajor(record(manifest.engines).node), `${manifestPath}: engines.node`);
    addEvidence(evidence, pinnedMajor(record(manifest.volta).node), `${manifestPath}: volta.node`);
    for (const name of [".nvmrc", ".node-version"]) {
      const path = posix.join(root, name);
      addEvidence(evidence, pinnedMajor((await tree.read(path))?.trim()), path);
    }
  }
  for (const path of await tree.list(".github/workflows")) {
    if (!/\.ya?ml$/.test(path)) continue;
    evidence.push(...workflowEvidence(await tree.read(path), path));
  }
  return {
    major: evidence.length === 0 ? undefined : Math.min(...evidence.map((item) => item.major)),
    sources: [...new Set(evidence.map((item) => item.source))].sort(),
  };
}

/** Without a readable runtime, retain the existing type major; patches and minors can still move. */
export function nodeTypeVersions(from: string, versions: ReadonlyArray<string>, runtime: NodeRuntime): string[] {
  const current = semver.parse(from);
  return versions.filter((version) => {
    const candidate = semver.parse(version);
    if (candidate === null || current === null) return false;
    return runtime.major === undefined ? candidate.major === current.major : candidate.major <= runtime.major;
  });
}

export function nodeTypeProblem(runtime: NodeRuntime): string {
  if (runtime.major === undefined) {
    return "cannot read a supported Node major from engines.node, .nvmrc, .node-version, volta.node or CI node-version; keeping the current @types/node major";
  }
  return `@types/node targets are capped at the lowest supported Node major (${runtime.major}; ${runtime.sources.join(", ")})`;
}

function engineMajor(value: unknown): number | undefined {
  if (typeof value !== "string" || semver.validRange(value) === null) return undefined;
  const minimum = semver.minVersion(value);
  // An unconstrained range supplies no useful lower runtime bound.
  return minimum === null || minimum.version === "0.0.0" ? undefined : minimum.major;
}

function pinnedMajor(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const match = /^v?(\d+)(?:\.(?:\d+|x|\*)){0,2}$/.exec(String(value).trim());
  if (match === null) return undefined;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) ? major : undefined;
}

function workflowEvidence(text: string | undefined, path: string): Evidence[] {
  if (text === undefined) return [];
  let workflow: Record<string, unknown>;
  try {
    workflow = record(parse(text));
  } catch {
    return [];
  }
  const evidence: Evidence[] = [];
  for (const raw of Object.values(record(workflow.jobs))) {
    const job = record(raw);
    if (typeof job.uses === "string") {
      for (const version of nodeVersions(record(job.with)["node-version"], job)) {
        addEvidence(evidence, pinnedMajor(version), `${path}: node-version`);
      }
    }
    if (!Array.isArray(job.steps)) continue;
    for (const rawStep of job.steps) {
      const step = record(rawStep);
      if (typeof step.uses !== "string" || !/^actions\/setup-node@/i.test(step.uses)) continue;
      const value = record(step.with)["node-version"];
      for (const version of nodeVersions(value, job)) {
        addEvidence(evidence, pinnedMajor(version), `${path}: node-version`);
      }
    }
  }
  return evidence;
}

function nodeVersions(value: unknown, job: Record<string, unknown>): unknown[] {
  if (typeof value !== "string") return [value];
  const expression = /^\s*\$\{\{\s*matrix\.([\w-]+)\s*\}\}\s*$/.exec(value);
  if (expression === null) return value.split(/\r?\n/);
  const key = expression[1]!;
  const matrix = record(record(job.strategy).matrix);
  const versions: unknown[] = Array.isArray(matrix[key]) ? matrix[key] : [];
  const included = Array.isArray(matrix.include) ? matrix.include.map((item) => record(item)[key]) : [];
  return [...versions, ...included];
}

function objectOf(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  try {
    return record(JSON.parse(text));
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function addEvidence(evidence: Evidence[], major: number | undefined, source: string): void {
  if (major !== undefined) evidence.push({ major, source });
}
