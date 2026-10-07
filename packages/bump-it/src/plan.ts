/** A bounded PR payload: exact npm file hashes, never their contents. */
import { createHash } from "node:crypto";

import { planBlock, planPayload, withPlanSection as replaceSection } from "../../remediation/src/plan-blocks.ts";

import type { CopyChange, NpmResult } from "./npm-compute.ts";
import type { DirectMove, Unit } from "./units.ts";

export interface PlannedMove extends DirectMove {
  readonly commitSha?: string;
}

export interface BumpPlan {
  readonly kind: Unit["kind"];
  readonly topic: string;
  readonly package: string | undefined;
  readonly moves: ReadonlyArray<PlannedMove>;
  readonly npmFiles: ReadonlyArray<{ readonly path: string; readonly sha256: string; readonly dependencySha256?: string }>;
  readonly changes: ReadonlyArray<CopyChange>;
  readonly changeCount: number;
  readonly notes: ReadonlyArray<string>;
}

export const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies", "peerDependenciesMeta", "overrides", "workspaces"];
export const dependencyDigest = (text: string) => {
  const manifest = JSON.parse(text) as Record<string, unknown>;
  return sha256(JSON.stringify(stable(Object.fromEntries(DEPENDENCY_FIELDS.map((field) => [field, manifest[field]])))));
};

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const HEADING = "### What bump-it moved";
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
};
const sorted = <T>(items: ReadonlyArray<T>): T[] => [...items].sort((a, b) => JSON.stringify(stable(a)).localeCompare(JSON.stringify(stable(b))));

export async function planFor(unit: Unit, npm: NpmResult, tagCommit: (name: string, tag: string) => Promise<string | undefined>): Promise<BumpPlan> {
  const moves: PlannedMove[] = [];
  for (const move of unit.moves) {
    if (move.mechanism !== "action-pin") moves.push(move);
    else {
      const commitSha = await tagCommit(move.name, move.to);
      if (commitSha === undefined || !/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error(`no commit for ${move.name}@${move.to}`);
      moves.push({ ...move, commitSha });
    }
  }
  return { ...unit, moves, npmFiles: [...npm.files].map(([path, content]) => ({ path, sha256: sha256(content), ...(path.endsWith("package.json") ? { dependencySha256: dependencyDigest(content) } : {}) })).sort((a, b) => a.path.localeCompare(b.path)), changes: npm.changes.slice(0, 30), changeCount: npm.changes.length, notes: npm.notes };
}

export function planDigest(plan: BumpPlan): string {
  const moves = plan.moves.map((move) => ({ ...move, locations: [...move.locations].sort(), declarations: sorted(move.declarations) }));
  return sha256(JSON.stringify(stable({ kind: plan.kind, topic: plan.topic, package: plan.package, moves: sorted(moves), npmFiles: sorted(plan.npmFiles) })));
}

/** The payload is untrusted data from a PR body; reject malformed or oversized plans. */
export function planOf(body: string): BumpPlan | undefined {
  const value = planPayload(body);
  if (!object(value) || !["routine", "major"].includes(String(value.kind)) || typeof value.topic !== "string") return undefined;
  if (value.kind === "major" ? typeof value.package !== "string" : value.package !== undefined) return undefined;
  if (!Array.isArray(value.moves) || !Array.isArray(value.npmFiles) || !Array.isArray(value.changes) || !Array.isArray(value.notes)) return undefined;
  if (!Number.isSafeInteger(value.changeCount) || (value.changeCount as number) < value.changes.length) return undefined;
  if (!value.notes.every((note) => typeof note === "string")) return undefined;
  if (!value.npmFiles.every((file) => object(file) && safePath(file.path) && typeof file.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.sha256) && (!file.path.endsWith("package.json") || typeof file.dependencySha256 === "string" && /^[0-9a-f]{64}$/.test(file.dependencySha256)))) return undefined;
  if (new Set(value.npmFiles.map((file) => file.path)).size !== value.npmFiles.length) return undefined;
  if (!value.moves.every(validMove)) return undefined;
  if (!value.changes.every((change) => object(change) && safePath(change.lockfile) && typeof change.path === "string" && typeof change.name === "string" && (change.from === undefined || typeof change.from === "string") && (change.to === undefined || typeof change.to === "string"))) return undefined;
  return value as unknown as BumpPlan;
}

export function safePath(path: unknown): path is string {
  return typeof path === "string" && path !== "" && !path.startsWith("/") && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..") && !path.includes("\0");
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validMove(move: unknown): boolean {
  if (!object(move) || !["npm", "Maven", "GitHub Actions"].includes(String(move.ecosystem))) return false;
  const mechanism = { npm: "npm-range", Maven: "gradle-declared", "GitHub Actions": "action-pin" }[String(move.ecosystem)];
  return move.mechanism === mechanism && [move.name, move.from, move.to].every((value) => typeof value === "string" && value !== "") && typeof move.major === "boolean"
    && Array.isArray(move.locations) && move.locations.every((location) => typeof location === "string")
    && Array.isArray(move.declarations) && move.declarations.every((declaration) => object(declaration) && safePath(declaration.lockfile) && [declaration.workspace, declaration.declaredAs, declaration.spec].every((value) => typeof value === "string"))
    && (mechanism !== "action-pin" || typeof move.commitSha === "string" && /^[0-9a-f]{40}$/i.test(move.commitSha));
}

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
export function planSection(plan: BumpPlan): string {
  const direct = ["| Package | From | To | Locations |", "|---|---|---|---|", ...plan.moves.map((move) => `| ${cell(move.name)} | ${cell(move.from)} | ${cell(move.to)} | ${cell(move.locations.join(", "))} |`)];
  const changes = plan.changes.slice(0, 30).map((change) => `- ${cell(change.name)} at ${cell(`${change.lockfile}:${change.path}`)}: ${change.from ?? "new"} → ${change.to ?? "removed"}`);
  if (plan.changeCount > 30) changes.push(`- and ${plan.changeCount - 30} more npm copy changes`);
  const section = `${HEADING}\n\n${direct.join("\n")}\n\n${changes.join("\n")}\n\n${plan.notes.map((note) => `- ${cell(note)}`).join("\n")}\n\n${planBlock(plan)}`;
  if (section.length > 43000) throw new Error("bump-it's plan is too large for a PR body");
  return section;
}
export function withPlanSection(body: string, plan: BumpPlan): string {
  return replaceSection(body, HEADING, planSection(plan));
}
