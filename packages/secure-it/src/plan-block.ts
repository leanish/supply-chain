/**
 * The plan in a PR's body: a table for people, and the plan itself as JSON in
 * a hidden comment, so a later run can tell whether its new plan is the same
 * (then it leaves the PR to its review tick) and the review tick can re-apply
 * and verify it exactly.
 */
import { createHash } from "node:crypto";

import type { ChangePlan, PlannedMove } from "./plan.ts";

const BLOCK = /<!-- leanish:plan ([A-Za-z0-9+/=]+) -->/;

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
      `| ${move.ecosystem} | \`${move.name}\` | ${move.from} → ${move.to}${move.major ? " (major)" : ""} | ${move.mechanism} | ${move.advisories.join(", ")} | ${move.locations.map((location) => `\`${location}\``).join(", ")} |`,
  );
  const encoded = Buffer.from(JSON.stringify(plan)).toString("base64");
  return [
    "### What secure-it moved",
    "",
    "| Ecosystem | Package | Version | How | Fixes | Where |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    "The versions are the ones the supply-chain gate's rule picks (`supply-chain candidates --rule security`); the gate verified the change before it was published.",
    "",
    `<!-- leanish:plan ${encoded} -->`,
  ].join("\n");
}

/** The plan a PR's body carries, if it has one that parses. */
export function planOf(body: string): ChangePlan | undefined {
  const found = BLOCK.exec(body);
  if (found === null) return undefined;
  try {
    const plan = JSON.parse(Buffer.from(found[1]!, "base64").toString("utf8")) as ChangePlan;
    return Array.isArray(plan.moves) && plan.moves.every(isMove) ? plan : undefined;
  } catch {
    return undefined;
  }
}

function isMove(move: unknown): move is PlannedMove {
  if (typeof move !== "object" || move === null) return false;
  const m = move as Record<string, unknown>;
  return typeof m["name"] === "string" && typeof m["from"] === "string" && typeof m["to"] === "string" && typeof m["mechanism"] === "string" && Array.isArray(m["locations"]);
}
