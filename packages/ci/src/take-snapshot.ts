/**
 * Takes the advisory snapshot for a set of package versions: OSV-Scanner
 * over all npm and Maven ones in one run, GitHub's advisory database for
 * GitHub Actions (OSV can't match their versions), plus the published advisories of each one's
 * source repository that OSV didn't cover yet. Repository advisories and
 * OSV's records for them are read first, the scanner runs after, so OSV
 * "covering" an advisory always means the scan saw it: then OSV-Scanner's
 * verdict on the version stands. A repository advisory marked as malware is
 * always kept: OSV might not classify it the same way.
 */
import type { ActionsGitHub } from "./actions-github.ts";
import { type Fetch, mapLimited } from "./http.ts";
import { OsvRecords } from "./osv-records.ts";
import { scanWithOsvScanner, type OsvRecord, type OsvScannerOptions } from "./osv-scanner.ts";
import { packageKey, type PackageVersion, uniqueVersions, versionKey } from "./package-version.ts";
import { matchRepositoryAdvisories, type RepositoryAdvisory, type RepositoryAdvisoryOptions } from "./repository-advisories.ts";
import { type Advisory, isMalware, Snapshot } from "./snapshot.ts";
import { sourceRepositories, type SourceRepoOptions } from "./source-repos.ts";

export interface SnapshotOptions {
  readonly osv: OsvScannerOptions;
  readonly sourceRepos: SourceRepoOptions;
  readonly repositoryAdvisories: RepositoryAdvisoryOptions;
  /** For OSV record lookups. */
  readonly fetch: Fetch;
  /** GitHub's advisory database, for GitHub Actions. */
  readonly actions: ActionsGitHub;
  readonly now: () => Date;
}

/**
 * `candidates` (young-fix candidates) join the scan; their source repository
 * is the one of another version of the same package in `packages`, and their
 * coverage gaps aren't reported again.
 */
export async function takeSnapshot(
  packages: ReadonlyArray<PackageVersion>,
  options: SnapshotOptions,
  candidates: ReadonlyArray<PackageVersion> = [],
): Promise<Snapshot> {
  const takenAt = options.now();
  const listed = uniqueVersions(packages);
  const listedKeys = new Set(listed.map(versionKey));
  const extra = uniqueVersions(candidates).filter((pkg) => !listedKeys.has(versionKey(pkg)));
  const repos = await sourceRepositories(listed, options.sourceRepos);
  const repoOfPackage = new Map<string, string>();
  for (const pkg of listed) {
    const repo = repos.get(versionKey(pkg));
    if (repo !== undefined && !repoOfPackage.has(packageKey(pkg))) repoOfPackage.set(packageKey(pkg), repo);
  }
  for (const pkg of extra) repos.set(versionKey(pkg), repoOfPackage.get(packageKey(pkg)));
  const unique = [...listed, ...extra];
  const repository = await matchRepositoryAdvisories(unique, repos, options.repositoryAdvisories, new Set(extra.map(versionKey)));
  const records = new OsvRecords(options.fetch);
  const covers = (id: string, pkg: PackageVersion) =>
    pkg.ecosystem === "GitHub Actions" ? options.actions.globalCovers(id, pkg.name) : records.covers(id, pkg);
  const fromRepositories = new Map<string, Advisory[]>();
  for (const pkg of unique) {
    const kept: Advisory[] = [];
    for (const advisory of repository.affecting.get(versionKey(pkg)) ?? []) {
      const converted = fromRepository(advisory);
      const covered = converted.malicious ? [] : await Promise.all(converted.ids.map((id) => covers(id, pkg)));
      if (!covered.some(Boolean)) kept.push(converted);
    }
    fromRepositories.set(versionKey(pkg), kept);
  }
  // After the coverage lookups, never before: see the file header. OSV can't match Actions versions; GitHub can.
  const osv = await scanWithOsvScanner(unique.filter((pkg) => pkg.ecosystem !== "GitHub Actions"), options.osv);
  const actions = unique.filter((pkg) => pkg.ecosystem === "GitHub Actions");
  const fromGitHub = await mapLimited(actions, 8, (pkg) => options.actions.advisories(pkg.name, pkg.version));
  const github = new Map(actions.map((pkg, i) => [versionKey(pkg), fromGitHub[i]!]));
  const affecting = new Map<string, Advisory[]>();
  for (const pkg of unique) {
    const key = versionKey(pkg);
    affecting.set(key, [...(osv.get(key) ?? []).map(fromOsv), ...(github.get(key) ?? []), ...(fromRepositories.get(key) ?? [])]);
  }
  return new Snapshot(affecting, repository.gaps, takenAt);
}

export function fromOsv(record: OsvRecord): Advisory {
  const ids = [record.id, ...record.aliases];
  return {
    id: record.id,
    ids,
    source: "osv",
    malicious: isMalware(ids, record.cweIds),
    summary: record.summary,
    severity: record.severity,
  };
}

export function fromRepository(advisory: RepositoryAdvisory): Advisory {
  const ids = [advisory.ghsaId, ...(advisory.cveId === undefined ? [] : [advisory.cveId])];
  return {
    id: advisory.ghsaId,
    ids,
    source: "repository",
    malicious: isMalware(ids, advisory.cweIds),
    summary: advisory.summary,
    severity: advisory.severity,
  };
}
