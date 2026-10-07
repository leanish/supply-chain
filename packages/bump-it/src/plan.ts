/** A bounded PR payload: exact npm file hashes, never their contents. */
import { createHash } from "node:crypto";

import { planBlock, planPayload, withPlanSection as replaceSection } from "../../remediation/src/plan-blocks.ts";

import { WRAPPER_PROPERTIES } from "./gradle-wrapper.ts";
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

export const DEPENDENCY_FIELDS = [
  "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundleDependencies",
  "bundledDependencies", "peerDependenciesMeta", "overrides", "workspaces",
];

export const dependencyDigest = (text: string) => {
  const manifest = JSON.parse(text) as Record<string, unknown>;
  const fields = Object.fromEntries(DEPENDENCY_FIELDS.map((field) => [field, manifest[field]]));
  return sha256(JSON.stringify(stable(fields)));
};

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const HEADING = "### What bump-it moved";

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]);
    return Object.fromEntries(entries);
  }
  return value;
};

const sorted = <T>(items: ReadonlyArray<T>): T[] => [...items].sort((a, b) => JSON.stringify(stable(a)).localeCompare(JSON.stringify(stable(b))));

export async function planFor(unit: Unit, npm: NpmResult, tagCommit: (name: string, tag: string) => Promise<string | undefined>): Promise<BumpPlan> {
  const moves: PlannedMove[] = [];
  for (const move of unit.moves) {
    if (move.mechanism !== "action-pin") {
      moves.push(move);
    } else {
      const commitSha = await tagCommit(move.name, move.to);
      if (commitSha === undefined || !/^[0-9a-f]{40}$/i.test(commitSha)) {
        throw new Error(`no commit for ${move.name}@${move.to}`);
      }
      moves.push({ ...move, commitSha });
    }
  }
  const npmFiles = [...npm.files]
    .map(([path, content]) => ({
      path,
      sha256: sha256(content),
      ...(path.endsWith("package.json") ? { dependencySha256: dependencyDigest(content) } : {}),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    ...unit,
    moves,
    npmFiles,
    changes: npm.changes.slice(0, 30),
    changeCount: npm.changes.length,
    notes: npm.notes,
  };
}

export function planDigest(plan: BumpPlan): string {
  const moves = plan.moves.map((move) => ({ ...move, locations: [...move.locations].sort(), declarations: sorted(move.declarations) }));
  return sha256(JSON.stringify(stable({ kind: plan.kind, topic: plan.topic, package: plan.package, moves: sorted(moves), npmFiles: sorted(plan.npmFiles) })));
}

/** The payload is untrusted data from a PR body; reject malformed or oversized plans. */
export function planOf(body: string): BumpPlan | undefined {
  const value = planPayload(body);
  if (!object(value) || !validUnit(value)) {
    return undefined;
  }
  if (!Array.isArray(value.moves) || !value.moves.every(validMove)) {
    return undefined;
  }
  if (!Array.isArray(value.npmFiles) || !value.npmFiles.every(validNpmFile)) {
    return undefined;
  }
  if (new Set(value.npmFiles.map((file) => file.path)).size !== value.npmFiles.length) {
    return undefined;
  }
  if (!Array.isArray(value.changes) || !value.changes.every(validCopyChange)) {
    return undefined;
  }
  if (!Number.isSafeInteger(value.changeCount) || (value.changeCount as number) < value.changes.length) {
    return undefined;
  }
  if (!Array.isArray(value.notes) || !value.notes.every((note) => typeof note === "string")) {
    return undefined;
  }
  return value as unknown as BumpPlan;
}

function validUnit(value: Record<string, unknown>): boolean {
  if (value.kind !== "routine" && value.kind !== "major") {
    return false;
  }
  if (typeof value.topic !== "string") {
    return false;
  }
  return value.kind === "major" ? typeof value.package === "string" : value.package === undefined;
}

function validNpmFile(file: unknown): boolean {
  if (!object(file) || !safePath(file.path) || !validHash(file.sha256)) {
    return false;
  }
  return !file.path.endsWith("package.json") || validHash(file.dependencySha256);
}

function validHash(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validCopyChange(change: unknown): boolean {
  if (!object(change) || !safePath(change.lockfile)) {
    return false;
  }
  if (typeof change.path !== "string" || typeof change.name !== "string") {
    return false;
  }
  return optionalString(change.from) && optionalString(change.to);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function safePath(path: unknown): path is string {
  if (typeof path !== "string" || path === "") {
    return false;
  }
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validMove(move: unknown): boolean {
  if (!object(move)) {
    return false;
  }
  if (move.ecosystem !== "npm" && move.ecosystem !== "Maven" && move.ecosystem !== "GitHub Actions" && move.ecosystem !== "Gradle Wrapper") {
    return false;
  }
  const mechanism = { npm: "npm-range", Maven: "gradle-declared", "GitHub Actions": "action-pin", "Gradle Wrapper": "gradle-wrapper" }[move.ecosystem];
  if (move.mechanism !== mechanism || typeof move.major !== "boolean") {
    return false;
  }
  if (![move.name, move.from, move.to].every((value) => typeof value === "string" && value !== "")) {
    return false;
  }
  if (!Array.isArray(move.locations) || !move.locations.every((location) => typeof location === "string")) {
    return false;
  }
  if (!Array.isArray(move.declarations) || !move.declarations.every(validDeclaration)) {
    return false;
  }
  if (mechanism === "gradle-wrapper") {
    return validWrapperMove(move);
  }
  return mechanism !== "action-pin" || validCommitSha(move.commitSha);
}

function validWrapperMove(move: Record<string, unknown>): boolean {
  if (move.name !== "gradle/gradle" || !Array.isArray(move.locations) || move.locations.length !== 1 || move.locations[0] !== WRAPPER_PROPERTIES) {
    return false;
  }
  if (!Array.isArray(move.declarations) || move.declarations.length !== 0 || !object(move.wrapper)) {
    return false;
  }
  if (typeof move.wrapper.distributionUrl !== "string" || !/^https:\/\/services\.gradle\.org\/distributions\/gradle-\d+(?:\.\d+){1,2}-(?:bin|all)\.zip$/.test(move.wrapper.distributionUrl)) {
    return false;
  }
  return validHash(move.wrapper.distributionSha256) && validHash(move.wrapper.jarSha256);
}

function validDeclaration(declaration: unknown): boolean {
  if (!object(declaration) || !safePath(declaration.lockfile)) {
    return false;
  }
  return [declaration.workspace, declaration.declaredAs, declaration.spec].every((value) => typeof value === "string");
}

function validCommitSha(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

export function planSection(plan: BumpPlan): string {
  const direct = ["| Package | From | To | Locations |", "|---|---|---|---|", ...plan.moves.map((move) => `| ${cell(move.name)} | ${cell(move.from)} | ${cell(move.to)} | ${cell(move.locations.join(", "))} |`)];
  const changes = plan.changes.slice(0, 30).map((change) => `- ${cell(change.name)} at ${cell(`${change.lockfile}:${change.path}`)}: ${change.from ?? "new"} → ${change.to ?? "removed"}`);
  if (plan.changeCount > 30) {
    changes.push(`- and ${plan.changeCount - 30} more npm copy changes`);
  }
  const section = `${HEADING}\n\n${direct.join("\n")}\n\n${changes.join("\n")}\n\n${plan.notes.map((note) => `- ${cell(note)}`).join("\n")}\n\n${planBlock(plan)}`;
  if (section.length > 43000) {
    throw new Error("bump-it's plan is too large for a PR body");
  }
  return section;
}

export function withPlanSection(body: string, plan: BumpPlan): string {
  return replaceSection(body, HEADING, planSection(plan));
}
