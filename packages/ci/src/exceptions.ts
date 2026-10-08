/**
 * `.github/supply-chain-exceptions.json`: reviewed exceptions in three lists,
 * each entry naming the exact package and version, with a reason and an
 * expiry date (valid through that UTC day).
 *
 * - `vulnerabilities`: an advisory (any id of its alias group) on a package
 *   version, at the `paths` it covers: lockfile paths or Gradle configuration
 *   ids. A copy anywhere else still fails.
 * - `releaseAge`: a version younger than the wait, with the advisory it fixes,
 *   for fixes the gate can't prove by itself.
 * - `identity`: an npm publisher identity break that was reviewed.
 *
 * Malware can't be excepted. The format is the one leanish-development's and
 * dtv's gates used, plus an optional `ecosystem` (any, when absent).
 */
import type { Finding } from "./findings.ts";
import type { Snapshot } from "./snapshot.ts";

export interface VulnerabilityException {
  readonly ecosystem: string | undefined;
  readonly id: string;
  readonly package: string;
  readonly version: string;
  readonly paths: ReadonlyArray<string>;
  readonly reason: string;
  readonly expires: string;
}

export interface ReleaseAgeException {
  readonly ecosystem: string | undefined;
  readonly package: string;
  readonly version: string;
  /** An advisory that affects a version the change replaces and not this one. */
  readonly advisory: string;
  readonly reason: string;
  readonly expires: string;
}

export interface IdentityException {
  readonly package: string;
  readonly version: string;
  readonly reason: string;
  readonly expires: string;
}

export interface Exceptions {
  readonly vulnerabilities: ReadonlyArray<VulnerabilityException>;
  readonly releaseAge: ReadonlyArray<ReleaseAgeException>;
  readonly identity: ReadonlyArray<IdentityException>;
}

export const NO_EXCEPTIONS: Exceptions = { vulnerabilities: [], releaseAge: [], identity: [] };

/**
 * Shape-checks the exceptions file: every field trimmed and nonempty (a
 * vulnerability's `paths` a nonempty list of them), a real `YYYY-MM-DD`
 * expiry, no `MAL-*` ids, no duplicates.
 */
export function parseExceptions(raw: unknown): Exceptions {
  const value = (raw ?? {}) as { vulnerabilities?: unknown; releaseAge?: unknown; identity?: unknown };
  return {
    vulnerabilities: exceptionList("vulnerabilities", value.vulnerabilities, ["id", "package", "version", "reason", "expires"], ["paths"]).map(
      (record) => ({
        ecosystem: record["ecosystem"] as string | undefined,
        id: record["id"] as string,
        package: record["package"] as string,
        version: record["version"] as string,
        paths: record["paths"] as string[],
        reason: record["reason"] as string,
        expires: record["expires"] as string,
      }),
    ),
    releaseAge: exceptionList("releaseAge", value.releaseAge, ["package", "version", "advisory", "reason", "expires"]).map((record) => ({
      ecosystem: record["ecosystem"] as string | undefined,
      package: record["package"] as string,
      version: record["version"] as string,
      advisory: record["advisory"] as string,
      reason: record["reason"] as string,
      expires: record["expires"] as string,
    })),
    identity: exceptionList("identity", value.identity, ["package", "version", "reason", "expires"]).map((record) => ({
      package: record["package"] as string,
      version: record["version"] as string,
      reason: record["reason"] as string,
      expires: record["expires"] as string,
    })),
  };
}

function exceptionList(
  field: string,
  entries: unknown,
  keys: ReadonlyArray<string>,
  listKeys: ReadonlyArray<string> = [],
): Array<Record<string, unknown>> {
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) throw new Error(`exceptions: \`${field}\` must be an array`);
  const seen = new Set<string>();
  return entries.map((entry: unknown, i) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    for (const key of [...keys, ...(record["ecosystem"] === undefined ? [] : ["ecosystem"])]) {
      const v = record[key];
      if (typeof v !== "string" || v.trim() === "" || v !== v.trim()) {
        throw new Error(`exceptions: ${field}[${i}].${key} is required (trimmed, nonempty)`);
      }
    }
    for (const key of listKeys) {
      const v = record[key];
      const valid =
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((item) => typeof item === "string" && item.trim() !== "" && item === item.trim()) &&
        new Set(v).size === v.length;
      if (!valid) throw new Error(`exceptions: ${field}[${i}].${key} must be a nonempty list of distinct, trimmed strings`);
    }
    if (!isIsoDate(record["expires"] as string)) {
      throw new Error(`exceptions: ${field}[${i}].expires must be a real YYYY-MM-DD date`);
    }
    if ([record["id"], record["advisory"]].some((id) => typeof id === "string" && id.startsWith("MAL-"))) {
      throw new Error(`exceptions: ${field}[${i}] tries to excuse a known-malicious package`);
    }
    const identity = ["ecosystem", ...keys]
      .filter((key) => key !== "reason" && key !== "expires")
      .map((key) => record[key] ?? "")
      .join("|");
    if (seen.has(identity)) throw new Error(`exceptions: ${field}[${i}] duplicates an earlier entry`);
    seen.add(identity);
    return record;
  });
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Why `finding` still fails under the exceptions, or undefined when an
 * unexpired exception covers it at every location. Malware always fails.
 */
export function unexcusedProblem(finding: Finding, exceptions: Exceptions, snapshot: Snapshot, today: string): string | undefined {
  const label = `${finding.name}@${finding.version}: ${finding.advisory}`;
  if (finding.malicious) return `${label} is a known-malicious package (no exception can cover it)`;
  const exception = exceptions.vulnerabilities.find(
    (entry) =>
      (entry.ecosystem === undefined || entry.ecosystem === finding.ecosystem) &&
      entry.package === finding.name &&
      entry.version === finding.version &&
      snapshot.group(entry.id) === finding.advisory,
  );
  if (exception === undefined) return `${label} has no exception`;
  if (exception.expires < today) return `${label}: its exception expired on ${exception.expires}`;
  const uncovered = finding.locations.filter((location) => !exception.paths.includes(location));
  if (uncovered.length > 0) return `${label} at ${uncovered.join(", ")} isn't covered by its exception's paths`;
  return undefined;
}
