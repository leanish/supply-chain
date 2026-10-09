/** Exempt young fixes and already locked young versions from npm's window; compare still judges induced changes. */
import { NpmRegistry, publishTime } from "../../ci/src/npm-registry.ts";
import { type Fetch, mapLimited } from "../../ci/src/http.ts";
import { lockedPackages } from "../../ci/src/npm-lock.ts";

import { type ChangePlan, lockfileOf } from "./plan.ts";

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
  baseLocks: ReadonlyMap<string, unknown> = new Map(),
): Promise<NpmWindow> {
  if (days === 0) return { exclude: [...new Set(ownScopes)].sort(), notes: [] };
  const registry = new NpmRegistry(fetch);
  const exclude = new Set([...ownScopes, ...plan.requiredNpm?.filter((target) => target.exempt).map((target) => target.name) ?? []]);
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const move of plan.moves) {
    if (move.ecosystem !== "npm") continue;
    const key = `${move.name}@${move.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const published = await publishedAt(registry, move.name, move.to);
    if (published !== undefined && now.getTime() - published.getTime() >= days * 86_400_000) continue;
    exclude.add(move.name);
    const reason = published === undefined ? "its publish time could not be read" : "it is younger than the release window";
    notes.push(`${key}: npm's window excludes ${move.name} because ${reason}; verification still requires the planned target`);
  }
  const affected = new Set(plan.moves.filter((move) => move.ecosystem === "npm" && baseLocks.size > 0).flatMap((move) =>
    move.locations.map((location) => lockfileOf(baseLocks, location).lock)));
  const copies = new Map([...affected].flatMap(lockedPackages).map((copy) => [`${copy.name}@${copy.version}`, copy]));
  const checked = await mapLimited([...copies.values()], 8, async (copy) => ({ copy, published: await publishedAt(registry, copy.name, copy.version) }));
  for (const { copy, published } of checked) {
    if (published !== undefined && now.getTime() - published.getTime() >= days * 86_400_000) continue;
    exclude.add(copy.name);
    const reason = published === undefined ? "its publish time could not be read" : "it is younger than the release window";
    notes.push(`${copy.name}: npm's window excludes its locked ${copy.version} because ${reason}; exact targets and compare still gate publication`);
  }
  return { exclude: [...exclude].sort(), notes };
}

async function publishedAt(registry: NpmRegistry, name: string, version: string): Promise<Date | undefined> {
  try {
    return publishTime(await registry.packument(name), name, version);
  } catch {
    // Missing age metadata cannot veto an already selected security target or a version locked in base.
    return undefined;
  }
}
