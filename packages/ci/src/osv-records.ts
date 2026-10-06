/**
 * Single OSV records, by id, to tell whether OSV already covers an advisory
 * a package's repository publishes. When it covered it at scan time (the
 * record names the package and was last modified before the scan started),
 * OSV-Scanner's verdict on that package version stands: the repository's own
 * range is only used for what OSV didn't have yet.
 */
import type { Fetch } from "./http.ts";
import { isObject } from "./json.ts";
import { packageKey, type PackageName } from "./package-version.ts";
import { ECOSYSTEMS, type Ecosystem } from "./versions.ts";

const OSV_API = "https://api.osv.dev/v1";

export class OsvRecords {
  private readonly fetch: Fetch;
  private readonly cache = new Map<string, Promise<OsvRecordSummary | undefined>>();

  constructor(fetch: Fetch) {
    this.fetch = fetch;
  }

  /** Whether OSV's record `id` names this package and was last modified before `scanStart`. */
  async coveredAtScan(id: string, pkg: PackageName, scanStart: Date): Promise<boolean> {
    let cached = this.cache.get(id);
    if (cached === undefined) {
      cached = this.summary(id);
      this.cache.set(id, cached);
    }
    const summary = await cached;
    if (summary === undefined || summary.modified === undefined || summary.modified >= scanStart) return false;
    return summary.packages.has(packageKey(pkg));
  }

  private async summary(id: string): Promise<OsvRecordSummary | undefined> {
    const response = await this.fetch(`${OSV_API}/vulns/${encodeURIComponent(id)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`OSV lookup of ${id} failed with HTTP ${response.status}`);
    const record: unknown = await response.json();
    if (!isObject(record)) throw new Error(`OSV record ${id} isn't an object`);
    const affected = record["affected"];
    if (!Array.isArray(affected)) throw new Error(`OSV record ${id} has no \`affected\` list`);
    const packages = new Set<string>();
    for (const entry of affected) {
      const pkg = isObject(entry) ? entry["package"] : undefined;
      if (!isObject(pkg) || typeof pkg["name"] !== "string" || typeof pkg["ecosystem"] !== "string") continue;
      if (ECOSYSTEMS.includes(pkg["ecosystem"] as Ecosystem)) {
        packages.add(packageKey({ ecosystem: pkg["ecosystem"] as Ecosystem, name: pkg["name"] }));
      }
    }
    const modified = typeof record["modified"] === "string" ? new Date(record["modified"]) : undefined;
    return { packages, modified: modified === undefined || Number.isNaN(modified.getTime()) ? undefined : modified };
  }
}

interface OsvRecordSummary {
  /** `packageKey`s the record lists as affected. */
  readonly packages: ReadonlySet<string>;
  /** Undefined when the record has no valid `modified`: never treated as covered. */
  readonly modified: Date | undefined;
}
