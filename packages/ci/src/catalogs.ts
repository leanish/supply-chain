/**
 * Version catalogs for the young-fix proof: every version a registry has,
 * and when each was published. npm reads the packument (already fetched for
 * the age and identity checks); Maven joins `maven-metadata.xml` of every
 * configured repository that has it, and reads publish times from POM
 * `Last-Modified`.
 */
import type { Fetch } from "./http.ts";
import type { MavenDates } from "./maven-changes.ts";
import { type NpmRegistry, publishTime } from "./npm-registry.ts";
import type { PackageName, PackageVersion } from "./package-version.ts";
import { mavenCoordinates } from "./source-repos.ts";
import type { VersionCatalog } from "./young-fixes.ts";

export class NpmCatalog implements VersionCatalog {
  private readonly registry: NpmRegistry;

  constructor(registry: NpmRegistry) {
    this.registry = registry;
  }

  async versions(pkg: PackageName): Promise<ReadonlyArray<string> | undefined> {
    return Object.keys((await this.registry.packument(pkg.name)).versions);
  }

  async published(pkg: PackageVersion): Promise<Date | undefined> {
    const doc = await this.registry.packument(pkg.name);
    try {
      return publishTime(doc, pkg.name, pkg.version);
    } catch {
      // A version without a valid time can't count as aged.
      return undefined;
    }
  }
}

export class MavenCatalog implements VersionCatalog {
  private readonly fetch: Fetch;
  private readonly repositories: ReadonlyArray<string>;
  private readonly dates: MavenDates;

  constructor(fetch: Fetch, repositories: ReadonlyArray<string>, dates: MavenDates) {
    this.fetch = fetch;
    this.repositories = repositories;
    this.dates = dates;
  }

  /** The union of every configured repository's listing; undefined when none lists the package. */
  async versions(pkg: PackageName): Promise<ReadonlyArray<string> | undefined> {
    const [group, artifact] = mavenCoordinates(pkg.name);
    let found: Set<string> | undefined;
    for (const repository of this.repositories) {
      const url = `${repository}/${group.replaceAll(".", "/")}/${artifact}/maven-metadata.xml`;
      const response = await this.fetch(url);
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`Maven metadata ${url} failed with HTTP ${response.status}`);
      const block = /<versions>([\s\S]*?)<\/versions>/.exec(await response.text())?.[1];
      if (block === undefined) throw new Error(`Maven metadata ${url} has no <versions>`);
      found ??= new Set();
      for (const match of block.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)) found.add(match[1]!);
    }
    return found === undefined ? undefined : [...found];
  }

  published(pkg: PackageVersion): Promise<Date | undefined> {
    return this.dates.published(pkg);
  }
}
