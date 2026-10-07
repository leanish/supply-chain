/** Keep existing npm overrides/floors in charge of their declarations, while other moves proceed. */
import { dirname, join } from "node:path";

import semver from "semver";

import type { Tree } from "../../ci/src/tree.ts";

import { rangeOf } from "./npm-graph.ts";
import { repositoryOverrides, type RepositoryOverrides } from "./npm-overrides.ts";
import type { DirectMove, Unit } from "./units.ts";

export async function constrainedUnit(unit: Unit, base: Tree): Promise<{ unit: Unit; notes: string[] }> {
  const roots = new Map<string, RepositoryOverrides>();
  const notes: string[] = [];
  const moves: DirectMove[] = [];
  for (const move of unit.moves) {
    if (move.ecosystem !== "npm") {
      moves.push(move);
      continue;
    }
    const declarations = [];
    for (const declaration of move.declarations) {
      const root = join(dirname(declaration.lockfile), "package.json");
      let overrides = roots.get(root);
      if (overrides === undefined) {
        overrides = repositoryOverrides(JSON.parse(await base.read(root) ?? "{}"));
        roots.set(root, overrides);
      }
      const range = overrides.rangeFor(declaration.declaredAs) ?? overrides.rangeFor(move.name);
      const complex = overrides.isComplex(declaration.declaredAs) || overrides.isComplex(move.name);
      if (complex || (range !== undefined && !semver.satisfies(move.to, rangeOf(range) ?? "<0.0.0"))) {
        notes.push(`${root}: ${declaration.declaredAs} stays at base under an existing override${complex ? " (scoped rule unresolved)" : ` (${range})`}`);
      } else {
        declarations.push(declaration);
      }
    }
    if (declarations.length > 0) {
      moves.push({ ...move, declarations, locations: [...new Set(declarations.map((declaration) => `${declaration.lockfile}#${declaration.workspace}`))].sort() });
    }
  }
  return { unit: { ...unit, moves }, notes };
}
