/** Group minor/patch moves in one routine unit and each major separately, most-depended-on first. */
import type { BumpCandidate, NpmDeclaration } from "../../ci/src/candidates.ts";
import type { Ecosystem } from "../../ci/src/versions.ts";

import type { WrapperCandidates, WrapperTarget } from "./gradle-wrapper.ts";

export type Mechanism = "npm-range" | "gradle-declared" | "action-pin" | "gradle-wrapper";

/** A direct dependency's move. */
export interface DirectMove {
  readonly ecosystem: Ecosystem | "Gradle Wrapper";
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly mechanism: Mechanism;
  /** npm: `lockfile#workspace`; Gradle: configuration locations; Actions: workflow files. */
  readonly locations: ReadonlyArray<string>;
  readonly major: boolean;
  /** npm: each declaration of `from`, to rewrite. */
  readonly declarations: ReadonlyArray<NpmDeclaration>;
  readonly wrapper?: WrapperTarget;
}

export interface Unit {
  readonly kind: "routine" | "major";
  /** For the branch: `routine`, or `<package>-major`. */
  readonly topic: string;
  /** A major's package, `ecosystem|name`; undefined for the routine. */
  readonly package: string | undefined;
  readonly moves: ReadonlyArray<DirectMove>;
}

const MECHANISM: Readonly<Record<Ecosystem, Mechanism>> = { npm: "npm-range", Maven: "gradle-declared", "GitHub Actions": "action-pin" };

export const packageKey = (move: Pick<DirectMove, "ecosystem" | "name">) => `${move.ecosystem}|${move.name}`;

function moveOf(bump: BumpCandidate, to: string, major: boolean): DirectMove {
  return { ecosystem: bump.ecosystem, name: bump.name, from: bump.from, to, mechanism: MECHANISM[bump.ecosystem], locations: bump.locations, major, declarations: bump.declarations };
}

/** The routine unit: every dependency version with a move in its own line (it may have none: the npm refresh alone). */
export function routineUnit(bumps: ReadonlyArray<BumpCandidate>, wrapper: WrapperCandidates = {}): Unit {
  const moves = bumps.flatMap((bump) => (bump.minor === undefined ? [] : [moveOf(bump, bump.minor.version, false)]));
  if (wrapper.routine !== undefined) moves.push(wrapper.routine);
  return { kind: "routine", topic: "routine", package: undefined, moves };
}

/** One unit per package with a major move, every version of it that has one together, most-depended-on first. */
export function majorUnits(bumps: ReadonlyArray<BumpCandidate>, wrapper: WrapperCandidates = {}): Unit[] {
  const byPackage = new Map<string, DirectMove[]>();
  for (const bump of bumps) {
    if (bump.major === undefined) {
      continue;
    }
    const move = moveOf(bump, bump.major.version, true);
    byPackage.set(packageKey(move), [...(byPackage.get(packageKey(move)) ?? []), move]);
  }
  if (wrapper.major !== undefined) byPackage.set(packageKey(wrapper.major), [wrapper.major]);
  const reach = (moves: ReadonlyArray<DirectMove>) => new Set(moves.flatMap((move) => move.locations)).size;
  return [...byPackage.entries()]
    .sort(([a, left], [b, right]) => reach(right) - reach(left) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, moves]) => ({ kind: "major" as const, topic: `${moves[0]!.name}-major`, package: key, moves }));
}
