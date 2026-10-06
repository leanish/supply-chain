/**
 * Takes the advisory snapshot for a set of package versions: OSV-Scanner
 * over all of them in one run, plus the published advisories of each one's
 * source repository that OSV didn't cover at scan time (when OSV's record for
 * the advisory names that package and predates the scan, OSV-Scanner's
 * verdict on the version stands). A repository advisory marked as malware is
 * always kept: OSV might not classify it the same way.
 */
import type { Fetch } from "./http.ts";
import { OsvRecords } from "./osv-records.ts";
import { scanWithOsvScanner, type OsvRecord, type OsvScannerOptions } from "./osv-scanner.ts";
import { type PackageVersion, uniqueVersions, versionKey } from "./package-version.ts";
import { matchRepositoryAdvisories, type RepositoryAdvisory, type RepositoryAdvisoryOptions } from "./repository-advisories.ts";
import { type Advisory, isMalware, Snapshot } from "./snapshot.ts";
import { sourceRepositories, type SourceRepoOptions } from "./source-repos.ts";

export interface SnapshotOptions {
  readonly osv: OsvScannerOptions;
  readonly sourceRepos: SourceRepoOptions;
  readonly repositoryAdvisories: RepositoryAdvisoryOptions;
  /** For OSV record lookups. */
  readonly fetch: Fetch;
  readonly now: () => Date;
}

export async function takeSnapshot(packages: ReadonlyArray<PackageVersion>, options: SnapshotOptions): Promise<Snapshot> {
  const unique = uniqueVersions(packages);
  const takenAt = options.now();
  const [osv, repos] = await Promise.all([
    scanWithOsvScanner(unique, options.osv),
    sourceRepositories(unique, options.sourceRepos),
  ]);
  const repository = await matchRepositoryAdvisories(unique, repos, options.repositoryAdvisories);
  const records = new OsvRecords(options.fetch);
  const affecting = new Map<string, Advisory[]>();
  for (const pkg of unique) {
    const key = versionKey(pkg);
    const fromRepositories: Advisory[] = [];
    for (const advisory of repository.affecting.get(key) ?? []) {
      const converted = fromRepository(advisory);
      const covered = converted.malicious ? [] : await Promise.all(converted.ids.map((id) => records.coveredAtScan(id, pkg, takenAt)));
      if (!covered.some(Boolean)) fromRepositories.push(converted);
    }
    affecting.set(key, [...(osv.get(key) ?? []).map(fromOsv), ...fromRepositories]);
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
