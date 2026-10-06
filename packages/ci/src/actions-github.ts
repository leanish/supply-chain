/**
 * What the gate asks GitHub about actions: which commit a tag points at,
 * when its release was published, which releases a repository has, and
 * GitHub's global advisory database (OSV holds GitHub Actions advisories but
 * doesn't match versions against them; GitHub's `affects=` filter does).
 * Every call fails closed: an error other than a 404 throws.
 */
import type { Fetch } from "./http.ts";
import { isObject, optionalString } from "./json.ts";
import { type Advisory, isMalware } from "./snapshot.ts";

const GITHUB_API = "https://api.github.com";
/** Releases past this many pages make the listing incomplete: the young-fix proof can't use it. */
const RELEASE_PAGES = 20;

export class ActionsGitHub {
  private readonly fetch: Fetch;
  private readonly token: string | undefined;
  private readonly tagCommits = new Map<string, Promise<string | undefined>>();
  private readonly releases = new Map<string, Promise<Releases>>();

  constructor(fetch: Fetch, token: string | undefined) {
    this.fetch = fetch;
    this.token = token;
  }

  /** The commit `tag` points at in `repo` (annotated tags dereferenced); undefined when there's no such tag. */
  tagCommit(repo: string, tag: string): Promise<string | undefined> {
    const key = `${repo}@${tag}`;
    let cached = this.tagCommits.get(key);
    if (cached === undefined) {
      cached = this.resolveTag(repo, tag);
      this.tagCommits.set(key, cached);
    }
    return cached;
  }

  private async resolveTag(repo: string, tag: string): Promise<string | undefined> {
    const ref = await this.get(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`);
    if (ref === undefined) return undefined;
    let target = isObject(ref) ? ref["object"] : undefined;
    for (let depth = 0; depth < 5; depth++) {
      if (!isObject(target) || typeof target["sha"] !== "string" || typeof target["type"] !== "string") {
        throw new Error(`GitHub tag ${tag} of ${repo} came back malformed`);
      }
      if (target["type"] === "commit") return target["sha"];
      if (target["type"] !== "tag") return undefined;
      const annotated = await this.get(`/repos/${repo}/git/tags/${target["sha"]}`);
      target = isObject(annotated) ? annotated["object"] : undefined;
    }
    throw new Error(`GitHub tag ${tag} of ${repo} nests too many tag objects`);
  }

  /** Published (non-draft) releases of `repo`, tag → publish time, every page; `complete` false past the page cap. */
  releasesOf(repo: string): Promise<Releases> {
    let cached = this.releases.get(repo);
    if (cached === undefined) {
      cached = this.listReleases(repo);
      this.releases.set(repo, cached);
    }
    return cached;
  }

  private async listReleases(repo: string): Promise<Releases> {
    const found = new Map<string, Date>();
    for (let page = 1; page <= RELEASE_PAGES; page++) {
      const body = await this.get(`/repos/${repo}/releases?per_page=100&page=${page}`);
      if (body === undefined) return { byTag: found, complete: true };
      if (!Array.isArray(body)) throw new Error(`GitHub releases of ${repo} aren't a list`);
      for (const release of body) {
        if (!isObject(release) || release["draft"] === true) continue;
        const tag = release["tag_name"];
        const published = typeof release["published_at"] === "string" ? new Date(release["published_at"]) : undefined;
        if (typeof tag === "string" && published !== undefined && !Number.isNaN(published.getTime())) found.set(tag, published);
      }
      if (body.length < 100) return { byTag: found, complete: true };
    }
    return { byTag: found, complete: false };
  }

  /** When the release of `tag` was published; undefined when `repo` has no published release for it. */
  async releasePublished(repo: string, tag: string): Promise<Date | undefined> {
    const listed = (await this.releasesOf(repo)).byTag.get(tag);
    if (listed !== undefined) return listed;
    const release = await this.get(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (!isObject(release) || release["draft"] === true || typeof release["published_at"] !== "string") return undefined;
    const published = new Date(release["published_at"]);
    return Number.isNaN(published.getTime()) ? undefined : published;
  }

  /** Global advisories (reviewed and malware) affecting `repo@version`, every page, withdrawn ones left out. */
  async advisories(repo: string, version: string): Promise<Advisory[]> {
    const affects = encodeURIComponent(`${repo}@${version}`);
    const found: Advisory[] = [];
    for (const type of ["reviewed", "malware"] as const) {
      let path: string | undefined = `/advisories?ecosystem=actions&affects=${affects}&type=${type}&per_page=100`;
      while (path !== undefined) {
        const { body, next } = await this.getPage(path);
        if (body === undefined) break;
        if (!Array.isArray(body)) throw new Error(`GitHub advisories for ${repo}@${version} aren't a list`);
        for (const entry of body) {
          const advisory = globalAdvisory(entry, type === "malware");
          if (advisory !== undefined) found.push(advisory);
        }
        path = next;
      }
    }
    return found;
  }

  /**
   * Whether GitHub's global database has advisory `id` naming `repo` as an
   * affected action, as a type the version queries return (reviewed or
   * malware): an unreviewed record would hide a finding nothing else reports.
   */
  async globalCovers(id: string, repo: string): Promise<boolean> {
    if (!id.startsWith("GHSA-")) return false;
    const body = await this.get(`/advisories/${id}`);
    if (!isObject(body) || !Array.isArray(body["vulnerabilities"])) return false;
    if (body["type"] !== "reviewed" && body["type"] !== "malware") return false;
    if (typeof body["withdrawn_at"] === "string") return false;
    return body["vulnerabilities"].some((vulnerability: unknown) => {
      const pkg = isObject(vulnerability) ? vulnerability["package"] : undefined;
      return isObject(pkg) && pkg["ecosystem"] === "actions" && typeof pkg["name"] === "string" && pkg["name"].toLowerCase() === repo;
    });
  }

  private async get(path: string): Promise<unknown> {
    return (await this.getPage(path)).body;
  }

  /** One response, and the path of the next page when its Link header names one. */
  private async getPage(path: string): Promise<{ body: unknown; next: string | undefined }> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    if (this.token !== undefined) headers["authorization"] = `Bearer ${this.token}`;
    const response = await this.fetch(`${GITHUB_API}${path}`, { headers });
    if (response.status === 404) return { body: undefined, next: undefined };
    if (!response.ok) {
      const hint = response.status === 403 || response.status === 429 ? " (rate limited? set GITHUB_TOKEN)" : "";
      throw new Error(`GitHub API ${path} failed with HTTP ${response.status}${hint}`);
    }
    const link = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
    return { body: await response.json(), next: link === undefined ? undefined : link.replace(GITHUB_API, "") };
  }
}

export interface Releases {
  readonly byTag: ReadonlyMap<string, Date>;
  /** False when the repository has more releases than the gate reads. */
  readonly complete: boolean;
}

function globalAdvisory(entry: unknown, fromMalwareQuery: boolean): Advisory | undefined {
  if (!isObject(entry) || typeof entry["ghsa_id"] !== "string" || entry["ghsa_id"] === "") {
    throw new Error("GitHub global advisories: an entry has no ghsa_id");
  }
  const id = entry["ghsa_id"];
  const where = `GitHub advisory ${id}`;
  if (optionalString(entry, "withdrawn_at", where) !== undefined) return undefined;
  const cve = optionalString(entry, "cve_id", where);
  const identifiers = Array.isArray(entry["identifiers"])
    ? entry["identifiers"].flatMap((identifier: unknown) =>
        isObject(identifier) && typeof identifier["value"] === "string" ? [identifier["value"]] : [],
      )
    : [];
  const cwes = Array.isArray(entry["cwes"])
    ? entry["cwes"].flatMap((cwe: unknown) => (isObject(cwe) && typeof cwe["cwe_id"] === "string" ? [cwe["cwe_id"]] : []))
    : [];
  const ids = [...new Set([id, ...(cve === undefined ? [] : [cve]), ...identifiers])];
  return {
    id,
    ids,
    source: "github",
    malicious: fromMalwareQuery || entry["type"] === "malware" || isMalware(ids, cwes),
    summary: optionalString(entry, "summary", where),
    severity: optionalString(entry, "severity", where)?.toUpperCase(),
  };
}
