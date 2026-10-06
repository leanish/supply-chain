/**
 * The checks on actions a change adds or changes, and what the advisory scan
 * gets from them:
 *   - a `uses:` that's new or points elsewhere must be pinned to a full
 *     commit SHA whose `# vX.Y.Z` comment names a tag pointing at it;
 *   - its age is its GitHub release's publish time (a tag's own date is
 *     whatever its author wrote); no published release fails, own actions
 *     aside (they skip only the wait);
 *   - unchanged uses that aren't pinned or verified, `docker://` uses and
 *     local actions without metadata are coverage gaps: the PR didn't make
 *     them worse.
 * Each occurrence is judged on its own; each distinct action, ref and
 * named tag is resolved with GitHub once for both sides.
 */
import type { ActionsGitHub } from "./actions-github.ts";
import { type ActionsInventory, occurrenceKey, type Resolution, resolutionKey, resolveUse } from "./actions-inventory.ts";
import { type Config, isOwnPackage } from "./config.ts";
import type { Located } from "./findings.ts";
import { mapLimited } from "./http.ts";
import type { PackageName, PackageVersion } from "./package-version.ts";
import type { ChangedVersion } from "./release-age.ts";
import type { VersionCatalog } from "./young-fixes.ts";

/** Resolves every distinct action, ref and named tag across the given inventories, once each. */
export async function resolveUses(
  inventories: ReadonlyArray<ActionsInventory>,
  github: ActionsGitHub,
): Promise<ReadonlyMap<string, Resolution>> {
  const unique = [...new Map(inventories.flatMap((inventory) => inventory.uses).map((use) => [resolutionKey(use), use])).values()];
  const resolved = await mapLimited(unique, 8, (use) => resolveUse(use, github));
  return new Map(unique.map((use, i) => [resolutionKey(use), resolved[i]!]));
}

/** The pinned, verified actions of an inventory, located in the files that use them. */
export function actionsLocated(inventory: ActionsInventory, resolutions: ReadonlyMap<string, Resolution>): Located[] {
  const byVersion = new Map<string, { name: string; version: string; locations: Set<string> }>();
  for (const use of inventory.uses) {
    const resolution = resolutions.get(resolutionKey(use));
    if (resolution?.kind !== "pinned") continue;
    const key = `${use.name}@${resolution.version}`;
    const entry = byVersion.get(key) ?? { name: use.name, version: resolution.version, locations: new Set() };
    entry.locations.add(use.file);
    byVersion.set(key, entry);
  }
  return [...byVersion.values()].map((entry) => ({ ecosystem: "GitHub Actions", name: entry.name, version: entry.version, locations: [...entry.locations] }));
}

export interface ActionChanges {
  readonly problems: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
  readonly changes: ReadonlyArray<ChangedVersion>;
}

/**
 * Each `uses:` occurrence is judged on its own: one is new or changed unless
 * base has as many occurrences with the same file, action (subpath included),
 * ref and comment. So removing a comment, repointing a ref, switching a
 * subpath, or copying an unpinned ref (into another workflow or the same one)
 * all count as changes.
 */
export async function actionChanges(
  base: ActionsInventory,
  head: ActionsInventory,
  resolutions: ReadonlyMap<string, Resolution>,
  github: ActionsGitHub,
  config: Config,
): Promise<ActionChanges> {
  // Counted, so a second copy of a step is a change too.
  const before = new Map<string, number>();
  for (const use of base.uses) before.set(occurrenceKey(use), (before.get(occurrenceKey(use)) ?? 0) + 1);
  const counted = new Map<string, number>();
  const problems: string[] = [];
  const gaps: string[] = [...head.gaps, ...head.docker.map((use) => `GitHub Actions ${use}: no advisory source covers container images`)];
  const changes = new Map<string, ChangedVersion>();
  const seen = new Set<string>();
  const headVersions = new Set(
    head.uses.flatMap((use) => {
      const resolution = resolutions.get(resolutionKey(use));
      return resolution?.kind === "pinned" ? [`${use.name}@${resolution.version}`] : [];
    }),
  );
  for (const use of head.uses) {
    const occurrence = occurrenceKey(use);
    const nth = (counted.get(occurrence) ?? 0) + 1;
    counted.set(occurrence, nth);
    const changed = nth > (before.get(occurrence) ?? 0);
    // Report each problem or gap once per occurrence key; an extra copy only matters if it's a change.
    if (seen.has(occurrence) && !changed) continue;
    if (seen.has(`${occurrence}|changed`) && changed) continue;
    seen.add(changed ? `${occurrence}|changed` : occurrence);
    const resolution = resolutions.get(resolutionKey(use))!;
    const label = `${use.name}${use.path === undefined ? "" : `/${use.path}`}@${use.ref} (${use.file})`;
    if (resolution.kind === "unpinned") {
      if (changed) problems.push(`${label} is new or changed, so it must be pinned to a full commit SHA with a \`# vX.Y.Z\` comment`);
      else gaps.push(`GitHub Actions ${label}: not pinned to a commit, so its version (and advisories) can't be told`);
      continue;
    }
    if (resolution.kind === "unverified") {
      if (changed) problems.push(`${label}: ${resolution.reason}`);
      else gaps.push(`GitHub Actions ${label}: ${resolution.reason}`);
      continue;
    }
    if (!changed) continue;
    const pkg: PackageVersion = { ecosystem: "GitHub Actions", name: use.name, version: resolution.version };
    if (isOwnPackage(config.ownPackages, pkg) || changes.has(`${pkg.name}@${pkg.version}`)) continue;
    const published = await github.releasePublished(use.name, resolution.version);
    if (published === undefined) {
      problems.push(`${label}: ${use.name} has no published GitHub release for ${resolution.version}, so the gate can't check its age`);
      continue;
    }
    // Versions of this action that base used and head no longer does.
    const replaced = [
      ...new Set(
        base.uses.flatMap((old) => {
          const was = resolutions.get(resolutionKey(old));
          return old.name === use.name && was?.kind === "pinned" && !headVersions.has(`${old.name}@${was.version}`) ? [was.version] : [];
        }),
      ),
    ];
    changes.set(`${pkg.name}@${pkg.version}`, { pkg, published, replaced });
  }
  return { problems, gaps, changes: [...changes.values()] };
}

/** What a full scan can't tell about a tree's actions: uses not pinned or not verified, container images, missing local actions. */
export function actionGaps(inventory: ActionsInventory, resolutions: ReadonlyMap<string, Resolution>): string[] {
  const gaps = [...inventory.gaps, ...inventory.docker.map((use) => `GitHub Actions ${use}: no advisory source covers container images`)];
  const seen = new Set<string>();
  for (const use of inventory.uses) {
    const occurrence = occurrenceKey(use);
    if (seen.has(occurrence)) continue;
    seen.add(occurrence);
    const resolution = resolutions.get(resolutionKey(use))!;
    const label = `${use.name}@${use.ref} (${use.file})`;
    if (resolution.kind === "unpinned") gaps.push(`GitHub Actions ${label}: not pinned to a commit, so its version (and advisories) can't be told`);
    else if (resolution.kind === "unverified") gaps.push(`GitHub Actions ${label}: ${resolution.reason}`);
  }
  return gaps;
}

/** An action's versions are its releases' tags; their dates, the releases' publish times. */
export class ActionsCatalog implements VersionCatalog {
  private readonly github: ActionsGitHub;

  constructor(github: ActionsGitHub) {
    this.github = github;
  }

  /** Undefined when the repository has more releases than the gate reads: an older fix could hide past them. */
  async versions(pkg: PackageName): Promise<ReadonlyArray<string> | undefined> {
    const releases = await this.github.releasesOf(pkg.name);
    return releases.complete ? [...releases.byTag.keys()] : undefined;
  }

  published(pkg: PackageVersion): Promise<Date | undefined> {
    return this.github.releasePublished(pkg.name, pkg.version);
  }
}
