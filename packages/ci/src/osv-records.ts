/**
 * Single OSV records, by id, to tell whether OSV already covers an advisory
 * a package's repository publishes. When it does, OSV-Scanner's verdict on
 * that package version stands: the repository's own range is only used for
 * what OSV doesn't have yet.
 */
import type { Fetch } from "./http.ts";
import { isObject } from "./json.ts";
import { packageKey, type PackageName } from "./package-version.ts";
import { ECOSYSTEMS, type Ecosystem } from "./versions.ts";

const OSV_API = "https://api.osv.dev/v1";

export class OsvRecords {
  private readonly fetch: Fetch;
  private readonly cache = new Map<string, Promise<ReadonlySet<string> | undefined>>();

  constructor(fetch: Fetch) {
    this.fetch = fetch;
  }

  /** Whether OSV has record `id` and it names this package as affected. */
  async covers(id: string, pkg: PackageName): Promise<boolean> {
    let cached = this.cache.get(id);
    if (cached === undefined) {
      cached = this.affectedPackages(id);
      this.cache.set(id, cached);
    }
    return (await cached)?.has(packageKey(pkg)) ?? false;
  }

  private async affectedPackages(id: string): Promise<ReadonlySet<string> | undefined> {
    const response = await this.fetch(`${OSV_API}/vulns/${encodeURIComponent(id)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`OSV lookup of ${id} failed with HTTP ${response.status}`);
    const record = await response.json();
    const affected = isObject(record) ? record["affected"] : undefined;
    if (!Array.isArray(affected)) throw new Error(`OSV record ${id} has no \`affected\` list`);
    const packages = new Set<string>();
    for (const entry of affected) {
      const pkg = isObject(entry) ? entry["package"] : undefined;
      if (!isObject(pkg) || typeof pkg["name"] !== "string" || typeof pkg["ecosystem"] !== "string") continue;
      if (ECOSYSTEMS.includes(pkg["ecosystem"] as Ecosystem)) {
        packages.add(packageKey({ ecosystem: pkg["ecosystem"] as Ecosystem, name: pkg["name"] }));
      }
    }
    return packages;
  }
}
