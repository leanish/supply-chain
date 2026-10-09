/** Attribute verification messages conservatively; a routine may drop named package groups once. */
import type { ChangePlan, OmittedMoves, PlannedMove } from "./plan.ts";

export interface ProblemMoves {
  readonly problem: string;
  readonly moves: ReadonlyArray<PlannedMove>;
}

export interface BatchRetry {
  readonly plan: ChangePlan | undefined;
  readonly named: ReadonlyArray<ProblemMoves>;
  readonly leftOut: ReadonlyArray<OmittedMoves>;
}

export function retryWithoutNamed(plan: ChangePlan, problems: ReadonlyArray<string>): BatchRetry {
  const named = namedProblems(plan, problems);
  if (plan.kind !== "routine" || plan.moves.some((move) => move.major) || problems.length === 0 || named.some((entry) => entry.moves.length === 0)) {
    return { plan: undefined, named, leftOut: [] };
  }
  const keys = new Set(named.flatMap((entry) => entry.moves.map(moveKey)));
  for (;;) {
    const size = keys.size;
    for (const set of plan.coupled ?? []) {
      if (set.some((key) => keys.has(key))) for (const key of set) keys.add(key);
    }
    if (keys.size === size) break;
  }
  for (const key of keys) if (!plan.packages.includes(key)) keys.delete(key);
  const leftOut = [...keys].sort().map((key) => ({
    moves: plan.moves.filter((move) => moveKey(move) === key),
    problems: named.filter((entry) => entry.moves.some((move) => moveKey(move) === key || (plan.coupled ?? []).some((set) => set.includes(key) && set.includes(moveKey(move))))).map((entry) => entry.problem),
  }));
  const moves = plan.moves.filter((move) => !keys.has(moveKey(move)));
  if (moves.length === 0) return { plan: undefined, named, leftOut };
  const requiredNpm = plan.requiredNpm?.filter((target) => !keys.has(`npm|${target.root.name}`));
  const notes = requiredNpm?.map((target) => target.reason);
  return { plan: { ...plan, moves, requiredNpm, notes, packages: plan.packages.filter((key) => !keys.has(key)), leftOut: [...(plan.leftOut ?? []), ...leftOut] }, named, leftOut };
}

export function namedProblems(plan: ChangePlan, problems: ReadonlyArray<string>): ProblemMoves[] {
  return problems.map((problem) => ({ problem, moves: plan.moves.filter((move) => namesMove(problem, move) || plan.requiredNpm?.some((target) =>
    target.root.name === move.name && target.root.version === move.to && namesMove(problem, { ...move, name: target.name }))) }));
}

const moveKey = (move: PlannedMove) => `${move.ecosystem}|${move.name}`;

function namesMove(problem: string, move: PlannedMove): boolean {
  const name = move.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Version-labelled gate findings and named landing/declaration failures, not package substrings in filenames.
  const versioned = new RegExp(`(?:^|\\s)${name}@[^\\s]+`);
  const landing = new RegExp(`^${name} (?:at |changed from )`);
  const gradle = new RegExp(`(?: declares | resolves | no longer resolves )${name}(?: |$)`);
  return versioned.test(problem) || landing.test(problem) || gradle.test(problem);
}
