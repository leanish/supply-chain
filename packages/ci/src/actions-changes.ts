/**
 * The checks on actions a change adds or changes, and what the advisory scan
 * gets from them:
 *   - a `uses:` that's new or points elsewhere must be pinned to a full
 *     commit SHA whose `# vX.Y.Z` comment names a tag pointing at it;
 *   - its age is its GitHub release's publish time (a tag's own date is
 *     whatever its author wrote); no published release fails, own actions
 *     aside (they skip only the wait);
 *   - unchanged uses that aren't pinned or verified, and `docker://` uses, are
 *     coverage gaps: the PR didn't make them worse.
 * Each distinct `name@ref` is resolved once for both sides.
 */
import type { ActionsGitHub } from "./actions-github.ts";
import { type ActionsInventory, type ActionUse, type Resolution, resolveUse } from "./actions-inventory.ts";
import { type Config, isOwnPackage } from "./config.ts";
import type { Located } from "./findings.ts";
import { mapLimited } from "./http.ts";
import type { PackageName, PackageVersion } from "./package-version.ts";
import type { ChangedVersion } from "./release-age.ts";
import type { VersionCatalog } from "./young-fixes.ts";

const useKey = (use: Pick<ActionUse, "name" | "ref">) => `${use.name}@${use.ref}`;

/** Resolves every distinct `name@ref` across the given inventories. */
export async function resolveUses(
  inventories: ReadonlyArray<ActionsInventory>,
  github: ActionsGitHub,
): Promise<ReadonlyMap<string, Resolution>> {
  const unique = [...new Map(inventories.flatMap((inventory) => inventory.uses).map((use) => [useKey(use), use])).values()];
  const resolved = await mapLimited(unique, 8, (use) => resolveUse(use, github));
  return new Map(unique.map((use, i) => [useKey(use), resolved[i]!]));
}

/** The pinned, verified actions of an inventory, located in the files that use them. */
export function actionsLocated(inventory: ActionsInventory, resolutions: ReadonlyMap<string, Resolution>): Located[] {
  const byVersion = new Map<string, { name: string; version: string; locations: Set<string> }>();
  for (const use of inventory.uses) {
    const resolution = resolutions.get(useKey(use));
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

export async function actionChanges(
  base: ActionsInventory,
  head: ActionsInventory,
  resolutions: ReadonlyMap<string, Resolution>,
  github: ActionsGitHub,
  config: Config,
): Promise<ActionChanges> {
  const before = new Set(base.uses.map(useKey));
  const problems: string[] = [];
  const gaps: string[] = [...head.docker.map((use) => `GitHub Actions ${use}: no advisory source covers container images`)];
  const changes: ChangedVersion[] = [];
  const seen = new Set<string>();
  const headVersions = new Set(
    head.uses.flatMap((use) => {
      const resolution = resolutions.get(useKey(use));
      return resolution?.kind === "pinned" ? [`${use.name}@${resolution.version}`] : [];
    }),
  );
  for (const use of head.uses) {
    const key = useKey(use);
    if (seen.has(key)) continue;
    seen.add(key);
    const resolution = resolutions.get(key)!;
    const label = `${use.name}@${use.ref} (${use.file})`;
    const changed = !before.has(key);
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
    if (isOwnPackage(config.ownPackages, pkg)) continue;
    const published = await github.releasePublished(use.name, resolution.version);
    if (published === undefined) {
      problems.push(`${label}: ${use.name} has no published GitHub release for ${resolution.version}, so the gate can't check its age`);
      continue;
    }
    // Versions of this action that base used and head no longer does.
    const replaced = [
      ...new Set(
        base.uses.flatMap((old) => {
          const was = resolutions.get(useKey(old));
          return old.name === use.name && was?.kind === "pinned" && !headVersions.has(`${old.name}@${was.version}`) ? [was.version] : [];
        }),
      ),
    ];
    changes.push({ pkg, published, replaced });
  }
  return { problems, gaps, changes };
}

/** An action's versions are its releases' tags; their dates, the releases' publish times. */
export class ActionsCatalog implements VersionCatalog {
  private readonly github: ActionsGitHub;

  constructor(github: ActionsGitHub) {
    this.github = github;
  }

  async versions(pkg: PackageName): Promise<ReadonlyArray<string>> {
    return [...(await this.github.releasesOf(pkg.name)).keys()];
  }

  published(pkg: PackageVersion): Promise<Date | undefined> {
    return this.github.releasePublished(pkg.name, pkg.version);
  }
}
