/**
 * The release-age check on Maven versions a change adds or changes (Gradle
 * builds). The publish time is the POM's `Last-Modified` in the first
 * configured repository that has it: Maven Central and the Gradle Plugin
 * Portal by default, both immutable, so a file's date is its upload. A
 * version none of them has fails: the gate can't tell its age.
 */
import { isOwnPackage } from "./config.ts";
import type { Located } from "./findings.ts";
import type { Fetch } from "./http.ts";
import { label, type PackageVersion, uniqueVersions } from "./package-version.ts";
import { type AgeContext, releaseAgeProblem } from "./release-age.ts";
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

/** Release-age problems of the Maven versions `head` has and `base` doesn't. */
export async function mavenChangeProblems(
  base: ReadonlyArray<Located>,
  head: ReadonlyArray<Located>,
  context: AgeContext & { readonly dates: MavenDates },
): Promise<string[]> {
  const before = new Set(base.filter((pkg) => pkg.ecosystem === "Maven").map((pkg) => `${pkg.name}@${pkg.version}`));
  const kept = new Set(head.filter((pkg) => pkg.ecosystem === "Maven").map((pkg) => `${pkg.name}@${pkg.version}`));
  const changed = uniqueVersions(head.filter((pkg) => pkg.ecosystem === "Maven" && !before.has(`${pkg.name}@${pkg.version}`)));
  const problems: string[] = [];
  for (const pkg of changed) {
    if (isOwnPackage(context.config.ownPackages, pkg)) continue;
    const published = await context.dates.published(pkg);
    if (published === undefined) {
      problems.push(`${label(pkg)} isn't in ${context.config.maven.repositories.join(" or ")}, so the gate can't check its release age`);
      continue;
    }
    // Versions of this package that base resolved and head no longer does.
    const replaced = [
      ...new Set(
        base
          .filter((old) => old.ecosystem === "Maven" && old.name === pkg.name && !kept.has(`${old.name}@${old.version}`))
          .map((old) => old.version),
      ),
    ];
    const problem = releaseAgeProblem(pkg, published, replaced, context);
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}
