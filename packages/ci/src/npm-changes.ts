/**
 * Checks on what a change adds or changes in an npm lockfile: the source of
 * every locked package, the release age of each added or changed version,
 * and the publisher identity of each version that replaces another.
 *
 * The wait itself is `release-age.ts`, shared with Maven.
 *
 * Ported from leanish-development `tools/supply-chain/src/supply-chain.ts`
 * (commit 9e7d098); the advisory evidence now comes from the shared snapshot.
 */
import { type Config, isOwnPackage } from "./config.ts";
import type { Exceptions } from "./exceptions.ts";
import { changedPackages, fromRegistry, type LockedPackage, NPM_REGISTRY, sourceProblems } from "./npm-lock.ts";
import { type NpmRegistry, publishTime } from "./npm-registry.ts";
import { uniqueVersions } from "./package-version.ts";
import { releaseAgeProblem } from "./release-age.ts";
import type { Snapshot } from "./snapshot.ts";

export interface NpmChangeContext {
  readonly registry: NpmRegistry;
  readonly snapshot: Snapshot;
  readonly exceptions: Exceptions;
  readonly config: Config;
  readonly now: Date;
}

/** Problems with the versions `head` adds or changes over `base`; empty means they pass. */
export async function npmChangeProblems(
  base: ReadonlyArray<LockedPackage>,
  head: ReadonlyArray<LockedPackage>,
  context: NpmChangeContext,
): Promise<string[]> {
  const problems = sourceProblems(head, context.config.npm.registries);
  const today = context.now.toISOString().slice(0, 10);
  const changed = changedPackages(base, head).filter((pkg) => fromRegistry(pkg, context.config.npm.registries));
  for (const pkg of uniqueVersions(changed.map((locked) => ({ ...locked, ecosystem: "npm" as const })))) {
    if (!pkg.resolved!.startsWith(`${NPM_REGISTRY}/`)) {
      problems.push(...otherRegistryProblems(pkg, context, today));
      continue;
    }
    problems.push(...(await context.registry.identityProblems(pkg, identityBaseline(pkg.name, base, head), context.exceptions, today)));
    const age = await ageProblem(pkg, replacedVersions(pkg.name, base, head), context);
    if (age !== undefined) problems.push(age);
  }
  return problems;
}

/**
 * Another allowed registry has no publish time or identity source the gate
 * trusts: an own package still skips only the wait, so its identity needs an
 * unexpired `identity` exception recording a review; anything else fails.
 */
function otherRegistryProblems(pkg: LockedPackage, context: NpmChangeContext, today: string): string[] {
  const label = `${pkg.name}@${pkg.version}`;
  if (!isOwnPackage(context.config.ownPackages, { ecosystem: "npm", name: pkg.name })) {
    return [`${label} comes from ${pkg.resolved}, where the gate can't check its release age or publisher identity`];
  }
  const reviewed = context.exceptions.identity.find(
    (entry) => entry.package === pkg.name && entry.version === pkg.version && entry.expires >= today,
  );
  return reviewed === undefined
    ? [`${label} comes from ${pkg.resolved}, where the gate can't check its publisher identity; an identity exception records the review`]
    : [];
}

async function ageProblem(pkg: LockedPackage, replaced: ReadonlyArray<string>, context: NpmChangeContext): Promise<string | undefined> {
  const npmPkg = { ecosystem: "npm" as const, name: pkg.name, version: pkg.version };
  if (isOwnPackage(context.config.ownPackages, npmPkg)) return undefined;
  const published = publishTime(await context.registry.packument(pkg.name), pkg.name, pkg.version);
  return releaseAgeProblem(npmPkg, published, replaced, context);
}

/**
 * Versions of `name` that `base` had at a lockfile path where `head` no longer
 * has them: upgraded in place, or removed (npm may hoist the new version
 * elsewhere). A copy `head` keeps doesn't count, so an added copy can't borrow
 * a retained copy's advisory.
 */
function replacedVersions(name: string, base: ReadonlyArray<LockedPackage>, head: ReadonlyArray<LockedPackage>): string[] {
  return [...new Set(replacedEntries(name, base, head).map((old) => old.version))];
}

function replacedEntries(name: string, base: ReadonlyArray<LockedPackage>, head: ReadonlyArray<LockedPackage>): LockedPackage[] {
  const kept = new Set(head.map((pkg) => `${pkg.path}|${pkg.name}@${pkg.version}`));
  return base.filter((old) => old.name === name && !kept.has(`${old.path}|${old.name}@${old.version}`));
}

/**
 * The identity baseline of `name`: each replaced version that was shipped as
 * its own registry tarball (not bundled), with that tarball's locked integrity.
 */
function identityBaseline(name: string, base: ReadonlyArray<LockedPackage>, head: ReadonlyArray<LockedPackage>): Map<string, string | undefined> {
  const baseline = new Map<string, string | undefined>();
  for (const old of replacedEntries(name, base, head)) {
    if (old.bundled || !old.resolved?.startsWith(`${NPM_REGISTRY}/`)) continue;
    if (baseline.get(old.version) === undefined) baseline.set(old.version, old.integrity);
  }
  return baseline;
}
