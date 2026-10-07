/** Exempt only planned young npm fixes from npm's window; every other package keeps it. */
import { NpmRegistry, publishTime } from "../../ci/src/npm-registry.ts";
import type { Fetch } from "../../ci/src/http.ts";

import type { ChangePlan } from "./plan.ts";

interface NpmWindow {
  readonly exclude: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
}

export async function npmWindowFor(
  plan: ChangePlan,
  days: number,
  ownScopes: ReadonlyArray<string>,
  now: Date,
  fetch: Fetch,
): Promise<NpmWindow> {
  if (days === 0) return { exclude: [...new Set(ownScopes)].sort(), notes: [] };
  const registry = new NpmRegistry(fetch);
  const exclude = new Set(ownScopes);
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const move of plan.moves) {
    if (move.ecosystem !== "npm") continue;
    const key = `${move.name}@${move.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let published: Date | undefined;
    try {
      published = publishTime(await registry.packument(move.name), move.name, move.to);
    } catch {
      // The security rule permits young fixes; missing age metadata cannot veto an already selected exact target.
    }
    if (published !== undefined && now.getTime() - published.getTime() >= days * 86_400_000) continue;
    exclude.add(move.name);
    const reason = published === undefined ? "its publish time could not be read" : "it is younger than the release window";
    notes.push(`${key}: npm's window excludes ${move.name} because ${reason}; verification still requires the planned target`);
  }
  return { exclude: [...exclude].sort(), notes };
}
