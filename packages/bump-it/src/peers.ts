/** Add code-decided direct companions before npm computes a unit; blocked peer sets leave the routine. */
import { dirname } from "node:path";

import { directDependencies } from "../../ci/src/npm-lock.ts";
import type { NpmPeerPlanner, PeerMove } from "../../ci/src/npm-peers.ts";
import type { NpmDeclaration } from "../../ci/src/candidates.ts";

import type { DirectMove, Unit } from "./units.ts";

export async function coupledUnit(unit: Unit, locks: ReadonlyMap<string, unknown>, peers?: NpmPeerPlanner) {
  if (peers === undefined) return { unit, notes: [], sets: [] as ReadonlyArray<ReadonlyArray<string>> };
  const anchors: PeerMove[] = unit.moves.filter((move) => move.ecosystem === "npm").map((move) => ({
    name: move.name, from: move.from, to: move.to,
    locations: move.declarations.flatMap((declaration) => {
      const lock = locks.get(declaration.lockfile);
      if (lock === undefined) throw new Error(`${declaration.lockfile} is absent while planning peers`);
      const direct = directDependencies(lock).find((edge) => (edge.workspace || ".") === declaration.workspace && edge.declaredAs === declaration.declaredAs);
      if (direct === undefined) throw new Error(`${declaration.declaredAs} in ${declaration.workspace} disappeared while planning peers`);
      const dir = dirname(declaration.lockfile);
      return [dir === "." ? direct.path : `${dir}/${direct.path}`];
    }),
  }));
  const result = await peers.resolve(anchors);
  const omitted = new Set(result.blocked.flatMap((group) => group.moves.map((move) => move.name)));
  expandOmitted(omitted, result.sets);
  const moves = unit.moves.filter((move) => move.ecosystem !== "npm" || !omitted.has(move.name));
  const companions: DirectMove[] = result.additions.filter((move) => !omitted.has(move.name)).map((move) => ({
    ecosystem: "npm", name: move.name, from: move.from, to: move.to, mechanism: "npm-range", major: false,
    locations: [...new Set(move.declarations.map((edge) => `${edge.lockfile}#${edge.workspace || "."}`))].sort(),
    declarations: move.declarations.map((edge) => ({ lockfile: edge.lockfile, workspace: edge.workspace || ".", declaredAs: edge.declaredAs, spec: edge.spec })),
  }));
  return { unit: { ...unit, moves: [...moves, ...companions] }, notes: result.blocked.map((group) => group.reason), sets: result.sets };
}

export function expandOmitted(names: Set<string>, sets: ReadonlyArray<ReadonlyArray<string>>): void {
  for (;;) {
    const size = names.size;
    for (const set of sets) {
      if (set.some((name) => names.has(name))) for (const name of set) names.add(name);
    }
    if (names.size === size) return;
  }
}

/** Do not let a repository constraint drop one peer declaration while keeping the moves requiring it. */
export function constrainedPeers(before: Unit, after: Unit, sets: ReadonlyArray<ReadonlyArray<string>>) {
  const connected = new Set(sets.filter((set) => set.length > 1).flat());
  const kept = new Set(after.moves.flatMap((move) => move.declarations.map((declaration) => declarationKey(move, declaration))));
  const omitted = new Set(before.moves.filter((move) => move.ecosystem === "npm" && connected.has(move.name) &&
    move.declarations.some((declaration) => !kept.has(declarationKey(move, declaration)))).map((move) => move.name));
  expandOmitted(omitted, sets);
  return {
    unit: { ...after, moves: after.moves.filter((move) => move.ecosystem !== "npm" || !omitted.has(move.name)) },
    notes: [...omitted].sort().map((name) => `${name}: its direct-peer set is blocked by a repository constraint`),
  };
}

function declarationKey(move: DirectMove, declaration: NpmDeclaration): string {
  return `${move.name}|${move.from}|${move.to}|${declaration.lockfile}|${declaration.workspace}|${declaration.declaredAs}`;
}
