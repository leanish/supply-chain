/**
 * The plan in a PR's body: a table for people, and the plan itself as JSON in
 * a hidden comment, so a later run can tell whether its new plan is the same
 * (then it leaves the PR to its review tick) and the review tick can re-apply
 * and verify it exactly.
 */
import { createHash } from "node:crypto";

import { planBlock, planPayload, withPlanSection as replaced } from "../../remediation/src/plan-blocks.ts";

import type { ChangePlan, PlannedMove } from "./plan.ts";

const HEADING = "### What secure-it moved";

/** A stable digest of what the plan moves: two runs with the same moves and targets get the same one. */
export function planDigest(plan: ChangePlan): string {
  const moves = [...plan.moves]
    .map((move) => ({ ...move, locations: [...move.locations].sort(), advisories: [...move.advisories].sort() }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(moves)).digest("hex");
}

/** The section secure-it adds to the agent's description: the moves, and the plan for later runs. */
export function planSection(plan: ChangePlan): string {
  const rows = plan.moves.map(
    (move) =>
      `| ${move.ecosystem} | \`${move.name}\` | ${move.from} → ${move.to}${move.major ? " (major)" : ""} | ${move.mechanism} | ${fixesLabel(plan, move)} | ${move.locations.map((location) => `\`${location}\``).join(", ")} |`,
  );
  return [
    HEADING,
    "",
    "| Ecosystem | Package | Version | How | Fixes | Where |",
    "|---|---|---|---|---|---|",
    ...rows,
    ...omittedSection(plan),
    "",
    "Security targets are the versions the supply-chain gate's rule picks (`supply-chain candidates --rule security`); code chose any required direct-peer companions at their lowest safe compatible versions. The gate verified the change before it was published.",
    "",
    planBlock(plan),
  ].join("\n");
}

/** A companion aligns the direct-peer set rather than claiming to fix an advisory itself. */
function fixesLabel(plan: ChangePlan, move: PlannedMove): string {
  if (move.advisories.length > 0 || plan.malware) return move.advisories.join(", ");
  const coupled = plan.coupled?.some((set) => set.includes(`${move.ecosystem}|${move.name}`));
  return coupled ? "direct peer compatibility" : "";
}

/** Omissions are visible to reviewers as well as the command report and persisted plan. */
function omittedSection(plan: ChangePlan): string[] {
  if (plan.leftOut === undefined || plan.leftOut.length === 0) return [];
  return [
    "",
    "#### Left out after verification failed",
    "",
    ...plan.leftOut.flatMap((entry) => [
      ...entry.moves.map((move) => `- ${move.ecosystem} \`${move.name}\` ${move.from} → ${move.to}: omitted from this batch's explicit moves.`),
      ...entry.problems.map((problem) => `  - ${problem.replace(/\s+/g, " ")}`),
    ]),
    "",
    "The remaining batch was re-applied from the base and verified. npm may still induce transitive changes; omitted explicit moves are not claimed as completed.",
  ];
}

/** `body` with its plan section replaced by `plan`'s (or `plan`'s appended when it has none). */
export function withPlanSection(body: string, plan: ChangePlan): string {
  return replaced(body, HEADING, planSection(plan));
}

/** The plan a PR's body carries, if it has one that parses. */
export function planOf(body: string): ChangePlan | undefined {
  const plan = planPayload(body) as ChangePlan | undefined;
  return plan !== undefined && typeof plan === "object" && plan !== null && Array.isArray(plan.moves) && plan.moves.every(isMove) && validMetadata(plan) ? plan : undefined;
}

function validMetadata(plan: ChangePlan): boolean {
  if (plan.kind !== undefined && !["routine", "major", "malware"].includes(plan.kind)) return false;
  if (plan.coupled !== undefined && (!Array.isArray(plan.coupled) || !plan.coupled.every((set) => Array.isArray(set) && set.every((name: unknown) => typeof name === "string")))) return false;
  if (plan.leftOut === undefined) return true;
  return Array.isArray(plan.leftOut) && plan.leftOut.every((entry) =>
    entry !== null && typeof entry === "object" && Array.isArray(entry.moves) && entry.moves.every(isMove) &&
    Array.isArray(entry.problems) && entry.problems.every((problem: unknown) => typeof problem === "string"));
}

function isMove(move: unknown): move is PlannedMove {
  if (typeof move !== "object" || move === null) return false;
  const m = move as Record<string, unknown>;
  return typeof m["name"] === "string" && typeof m["from"] === "string" && typeof m["to"] === "string" && typeof m["mechanism"] === "string" && Array.isArray(m["locations"]);
}
