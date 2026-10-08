/**
 * Maven versions a change adds or changes (Gradle builds), with their publish
 * times for the release-age rule. The publish time is the POM's `Last-Modified` in the first
 * configured repository that has it: Maven Central and the Gradle Plugin
 * Portal by default, both immutable, so a file's date is its upload. A
 * version none of them has fails: the gate can't tell its age.
 */
import { type Config, isOwnPackage } from "./config.ts";
import type { Located } from "./findings.ts";
import type { Fetch } from "./http.ts";
import { label, type PackageVersion, uniqueVersions } from "./package-version.ts";
import type { ChangedVersion } from "./release-age.ts";
import { pomUrl } from "./source-repos.ts";

/** Publish times from POM `Last-Modified`, each version asked once per run. */
export class MavenDates {
  private readonly fetch: Fetch;
  private readonly repositories: ReadonlyArray<string>;
  private readonly cache = new Map<string, Promise<Date | undefined>>();

  constructor(fetch: Fetch, repositories: ReadonlyArray<string>) {
    this.fetch = fetch;
    this.repositories = repositories;
  }

  /** When `pkg` was published, or undefined when no configured repository has it. */
  published(pkg: PackageVersion): Promise<Date | undefined> {
    const key = `${pkg.name}@${pkg.version}`;
    let cached = this.cache.get(key);
    if (cached === undefined) {
      cached = this.lookUp(pkg);
      this.cache.set(key, cached);
    }
    return cached;
  }

  private async lookUp(pkg: PackageVersion): Promise<Date | undefined> {
    for (const repository of this.repositories) {
      const url = pomUrl(repository, pkg);
      const response = await this.fetch(url, { method: "HEAD" });
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`POM lookup ${url} failed with HTTP ${response.status}`);
      const header = response.headers.get("last-modified");
      const date = header === null ? undefined : new Date(header);
      if (date === undefined || Number.isNaN(date.getTime())) throw new Error(`${url} has no valid Last-Modified header`);
      return date;
    }
    return undefined;
  }
}

/**
 * The versions `pkg` replaces: where head resolves it (a configuration),
 * whatever base resolved there that head no longer does at that location. A
 * version head keeps elsewhere still counts (upgraded at runtime, kept in
 * tests). Where none of its locations existed in base, any version base had
 * that head no longer has anywhere.
 */
function replacedAt(pkg: Located, base: ReadonlyArray<Located>, head: ReadonlyArray<Located>, kept: ReadonlySet<string>): string[] {
  const versionsAt = (side: ReadonlyArray<Located>) => {
    const at = new Map<string, Set<string>>();
    for (const entry of side) {
      if (entry.ecosystem !== "Maven" || entry.name !== pkg.name) continue;
      for (const location of entry.locations) at.set(location, (at.get(location) ?? new Set()).add(entry.version));
    }
    return at;
  };
  const before = versionsAt(base);
  const after = versionsAt(head);
  const replaced = new Set<string>();
  for (const location of pkg.locations) {
    for (const version of before.get(location) ?? []) if (!after.get(location)?.has(version)) replaced.add(version);
  }
  if (replaced.size === 0 && !pkg.locations.some((location) => before.has(location))) {
    for (const old of base) if (old.ecosystem === "Maven" && old.name === pkg.name && !kept.has(`${old.name}@${old.version}`)) replaced.add(old.version);
  }
  return [...replaced];
}

export interface MavenChanges {
  /** Versions whose age no configured repository can tell. */
  readonly problems: ReadonlyArray<string>;
  readonly changes: ReadonlyArray<ChangedVersion>;
}

/** The Maven versions `head` has and `base` doesn't, with their publish times. */
export async function mavenChanges(
  base: ReadonlyArray<Located>,
  head: ReadonlyArray<Located>,
  context: { readonly config: Config; readonly dates: MavenDates },
): Promise<MavenChanges> {
  const before = new Set(base.filter((pkg) => pkg.ecosystem === "Maven").map((pkg) => `${pkg.name}@${pkg.version}`));
  const kept = new Set(head.filter((pkg) => pkg.ecosystem === "Maven").map((pkg) => `${pkg.name}@${pkg.version}`));
  const changed = uniqueVersions(head.filter((pkg) => pkg.ecosystem === "Maven" && !before.has(`${pkg.name}@${pkg.version}`)));
  const problems: string[] = [];
  const changes: ChangedVersion[] = [];
  for (const pkg of changed) {
    if (isOwnPackage(context.config.ownPackages, pkg)) continue;
    const published = await context.dates.published(pkg);
    if (published === undefined) {
      problems.push(`${label(pkg)} isn't in ${context.config.maven.repositories.join(" or ")}, so the gate can't check its release age`);
      continue;
    }
    changes.push({ pkg: { ecosystem: "Maven", name: pkg.name, version: pkg.version }, published, replaced: replacedAt(pkg, base, head, kept) });
  }
  return { problems, changes };
}
