/**
 * Security advisories a package's own GitHub repository publishes
 * (`GET /repos/{owner}/{repo}/security-advisories`). They can name a fix
 * days before GitHub reviews them into its global database and OSV imports
 * them (snappy-java's CVE-2026-90559 was one), so the gate reads them too.
 *
 * Each repository is read once per run. A 404 (renamed, deleted or private
 * repository) is a coverage gap; any other failure, rate limits included,
 * fails the run. Withdrawn advisories are left out; an advisory whose range
 * doesn't parse is a gap, never a pass.
 */
import { mapLimited, type Fetch } from "./http.ts";
import { isObject, optionalString, stringList } from "./json.ts";
import { label, type PackageVersion, versionKey } from "./package-version.ts";
import { mavenCoordinates } from "./source-repos.ts";
import { inAdvisoryRange, parseAdvisoryRange, type VersionScheme, versionScheme } from "./versions.ts";

const GITHUB_API = "https://api.github.com";

/** How GitHub's advisories name each ecosystem. */
const GITHUB_ECOSYSTEMS: Readonly<Record<PackageVersion["ecosystem"], string>> = { npm: "npm", Maven: "maven", "GitHub Actions": "actions" };

export interface RepositoryAdvisory {
  readonly ghsaId: string;
  readonly cveId: string | undefined;
  readonly summary: string | undefined;
  readonly severity: string | undefined;
  readonly cweIds: ReadonlyArray<string>;
  readonly vulnerabilities: ReadonlyArray<{
    readonly ecosystem: string;
    readonly name: string;
    readonly range: string | undefined;
    /** `patched_versions`: the fixed version, when the maintainer names one. */
    readonly patched: string | undefined;
  }>;
}

export interface RepositoryAdvisoryMatch {
  /** `versionKey` → the repository advisories affecting it. */
  readonly affecting: Map<string, RepositoryAdvisory[]>;
  readonly gaps: ReadonlyArray<string>;
}

export interface RepositoryAdvisoryOptions {
  readonly fetch: Fetch;
  /** A token for the GitHub API; unauthenticated requests get 60 an hour. */
  readonly token: string | undefined;
}

/**
 * Matches each package version against its source repository's published
 * advisories. `repos` maps `versionKey` to `owner/repo`, undefined for a
 * package without one (a gap).
 */
export async function matchRepositoryAdvisories(
  packages: ReadonlyArray<PackageVersion>,
  repos: ReadonlyMap<string, string | undefined>,
  options: RepositoryAdvisoryOptions,
  /** `versionKey`s whose gaps aren't reported (young-fix candidates: their package is reported already). */
  quiet: ReadonlySet<string> = new Set(),
): Promise<RepositoryAdvisoryMatch> {
  const gaps: string[] = [];
  const wanted = [...new Set(packages.flatMap((pkg) => repos.get(versionKey(pkg)) ?? []))].sort();
  const fetched = await mapLimited(wanted, 8, (repo) => fetchRepositoryAdvisories(repo, options));
  const byRepo = new Map(wanted.map((repo, i) => [repo, fetched[i]]));
  const affecting = new Map<string, RepositoryAdvisory[]>();
  for (const pkg of packages) {
    const repo = repos.get(versionKey(pkg));
    const report = (gap: string) => {
      if (!quiet.has(versionKey(pkg))) gaps.push(gap);
    };
    if (repo === undefined) {
      report(`${pkg.ecosystem} ${label(pkg)}: no GitHub source repository found, so its repository advisories aren't read`);
      continue;
    }
    const advisories = byRepo.get(repo);
    if (advisories === undefined) {
      report(`${pkg.ecosystem} ${label(pkg)}: source repository ${repo} isn't readable (renamed, deleted or private)`);
      continue;
    }
    const hits: RepositoryAdvisory[] = [];
    for (const advisory of advisories) {
      const verdict = affects(advisory, pkg);
      if (verdict === undefined) report(`${advisory.ghsaId} (${repo}) has a range the gate can't read for ${label(pkg)}`);
      else if (verdict) hits.push(advisory);
    }
    affecting.set(versionKey(pkg), hits);
  }
  return { affecting, gaps };
}

/**
 * Whether any of the advisory's vulnerable ranges for this package contains
 * its version; undefined if a range doesn't parse. A range without an upper
 * bound stops at its single patched version, if it names one: maintainers
 * often write `>=5.0.0-beta.1` with `5.0.0-rc.2` as the fix.
 */
function affects(advisory: RepositoryAdvisory, pkg: PackageVersion): boolean | undefined {
  const scheme = versionScheme(pkg.ecosystem);
  let unreadable = false;
  for (const vulnerability of advisory.vulnerabilities) {
    if (!namesPackage(vulnerability, pkg)) continue;
    const verdict = vulnerability.range === undefined ? undefined : inAdvisoryRange(scheme, vulnerability.range, pkg.version);
    if (verdict === undefined) {
      unreadable = true;
      continue;
    }
    if (verdict && !fixedByPatch(vulnerability.range!, vulnerability.patched, pkg.version, scheme)) return true;
  }
  return unreadable ? undefined : false;
}

function fixedByPatch(range: string, patched: string | undefined, version: string, scheme: VersionScheme): boolean {
  const intervals = parseAdvisoryRange(range, scheme === versionScheme("npm"));
  if (patched === undefined || intervals === undefined || intervals.some((interval) => interval.upper !== undefined)) return false;
  const fix = patched.trim().replace(/^v/, "");
  if (!/^\d[0-9A-Za-z.+_-]*$/.test(fix)) return false;
  try {
    return scheme.compare(version, fix) >= 0;
  } catch {
    return false;
  }
}

/** Same ecosystem, and the same name; for Maven a bare artifactId counts too (snappy-java's own advisories use one). */
function namesPackage(vulnerability: { ecosystem: string; name: string }, pkg: PackageVersion): boolean {
  if (vulnerability.ecosystem.toLowerCase() !== GITHUB_ECOSYSTEMS[pkg.ecosystem]) return false;
  if (vulnerability.name === pkg.name || (pkg.ecosystem === "GitHub Actions" && vulnerability.name.toLowerCase() === pkg.name)) return true;
  return pkg.ecosystem === "Maven" && vulnerability.name === mavenCoordinates(pkg.name)[1];
}

/** Published, non-withdrawn advisories of `owner/repo`; undefined when the repository isn't there. */
export async function fetchRepositoryAdvisories(
  repo: string,
  options: RepositoryAdvisoryOptions,
): Promise<RepositoryAdvisory[] | undefined> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  const advisories: RepositoryAdvisory[] = [];
  let url: string | undefined = `${GITHUB_API}/repos/${repo}/security-advisories?state=published&per_page=100`;
  while (url !== undefined) {
    const response = await options.fetch(url, { headers });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      const hint = response.status === 403 || response.status === 429 ? " (rate limited? set GITHUB_TOKEN)" : "";
      throw new Error(`GitHub repository advisories of ${repo} failed with HTTP ${response.status}${hint}`);
    }
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`GitHub repository advisories of ${repo} aren't a list`);
    for (const entry of page) {
      const advisory = parseRepositoryAdvisory(entry, repo);
      if (advisory !== undefined) advisories.push(advisory);
    }
    url = nextLink(response.headers.get("link"));
  }
  return advisories;
}

function parseRepositoryAdvisory(entry: unknown, repo: string): RepositoryAdvisory | undefined {
  if (!isObject(entry) || typeof entry["ghsa_id"] !== "string" || entry["ghsa_id"] === "") {
    throw new Error(`GitHub repository advisories of ${repo}: an entry has no ghsa_id`);
  }
  const ghsaId = entry["ghsa_id"];
  const where = `repository advisory ${ghsaId} (${repo})`;
  if (entry["state"] !== "published" || optionalString(entry, "withdrawn_at", where) !== undefined) return undefined;
  const vulnerabilities = entry["vulnerabilities"] ?? [];
  if (!Array.isArray(vulnerabilities)) throw new Error(`${where}: \`vulnerabilities\` must be a list`);
  return {
    ghsaId,
    cveId: optionalString(entry, "cve_id", where),
    summary: optionalString(entry, "summary", where),
    severity: optionalString(entry, "severity", where)?.toUpperCase(),
    cweIds: stringList(entry, "cwe_ids", where),
    vulnerabilities: vulnerabilities.map((vulnerability: unknown) => {
      const pkg = isObject(vulnerability) ? vulnerability["package"] : undefined;
      if (!isObject(pkg) || typeof pkg["ecosystem"] !== "string" || typeof pkg["name"] !== "string") {
        throw new Error(`${where}: a vulnerability has no package`);
      }
      return {
        ecosystem: pkg["ecosystem"],
        name: pkg["name"],
        range: optionalString(vulnerability as Record<string, unknown>, "vulnerable_version_range", where),
        patched: optionalString(vulnerability as Record<string, unknown>, "patched_versions", where),
      };
    }),
  };
}

function nextLink(header: string | null): string | undefined {
  if (header === null) return undefined;
  return /<([^>]+)>;\s*rel="next"/.exec(header)?.[1];
}
