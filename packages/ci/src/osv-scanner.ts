/**
 * Runs Google's OSV-Scanner once over a list of package versions, through its
 * custom inventory format (`--lockfile osv-scanner:<file>`), and returns the
 * full OSV records affecting each one.
 *
 * One run per comparison is what gives base and head the same advisory data:
 * the caller passes the union of both sides (and any candidate versions).
 * The run happens in an empty directory with an empty config, so no
 * `osv-scanner.toml` in the scanned repository can ignore anything. It fails
 * closed: an exit code other than 0 (nothing found) or 1 (findings), output
 * that doesn't parse, or a requested package missing from the output.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isObject, optionalString, stringList } from "./json.ts";
import { label, type PackageVersion, uniqueVersions, versionKey } from "./package-version.ts";
import type { RunProcess } from "./process.ts";
import { ECOSYSTEMS, type Ecosystem } from "./versions.ts";

/** What the gate reads from an OSV record. */
export interface OsvRecord {
  readonly id: string;
  readonly aliases: ReadonlyArray<string>;
  readonly summary: string | undefined;
  readonly cweIds: ReadonlyArray<string>;
  /** GitHub's severity (`LOW`…`CRITICAL`) when the record carries one. */
  readonly severity: string | undefined;
  readonly withdrawn: boolean;
}

export interface OsvScannerOptions {
  /** The `osv-scanner` binary. */
  readonly binary: string;
  readonly run: RunProcess;
}

const SUPPORTED_MAJOR = 2;

/** The binary's version, failing on one this gate wasn't written against. */
export async function osvScannerVersion(options: OsvScannerOptions): Promise<string> {
  const result = await options.run(options.binary, ["--version"]);
  const version = /osv-scanner version: (\d+)\.(\d+)\.(\d+)/.exec(result.stdout);
  if (result.code !== 0 || version === null) {
    throw new Error(`couldn't read the version of ${options.binary}: ${lastLine(result.stderr || result.stdout)}`);
  }
  if (Number(version[1]) !== SUPPORTED_MAJOR) {
    throw new Error(`osv-scanner ${version.slice(1).join(".")} isn't supported; use ${SUPPORTED_MAJOR}.x`);
  }
  return version.slice(1).join(".");
}

/** OSV records affecting each requested version, keyed by `versionKey`; withdrawn records are left out. */
export async function scanWithOsvScanner(
  packages: ReadonlyArray<PackageVersion>,
  options: OsvScannerOptions,
): Promise<Map<string, OsvRecord[]>> {
  const unique = uniqueVersions(packages);
  const affecting = new Map<string, OsvRecord[]>();
  if (unique.length === 0) return affecting;
  const dir = await mkdtemp(join(tmpdir(), "supply-chain-osv-"));
  try {
    const inventory = join(dir, "osv-scanner-custom.json");
    const config = join(dir, "osv-scanner.toml");
    const body = {
      results: [
        {
          source: { path: "supply-chain inventory", type: "lockfile" },
          packages: unique.map((pkg) => ({ package: { name: pkg.name, version: pkg.version, ecosystem: pkg.ecosystem } })),
        },
      ],
    };
    await writeFile(inventory, JSON.stringify(body));
    await writeFile(config, "");
    const args = [
      "scan",
      "source",
      "--lockfile",
      `osv-scanner:${inventory}`,
      "--config",
      config,
      "--format",
      "json",
      "--all-packages",
      "--all-vulns",
      "--no-resolve",
    ];
    const result = await options.run(options.binary, args, { cwd: dir });
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(`osv-scanner failed with exit code ${result.code}: ${lastLine(result.stderr)}`);
    }
    for (const entry of parseScannerOutput(result.stdout)) {
      const key = versionKey(entry.pkg);
      affecting.set(key, [...(affecting.get(key) ?? []), ...entry.records.filter((record) => !record.withdrawn)]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const missing = unique.filter((pkg) => !affecting.has(versionKey(pkg)));
  if (missing.length > 0) {
    throw new Error(`osv-scanner didn't report on ${missing.length} requested package(s), e.g. ${label(missing[0]!)}`);
  }
  return affecting;
}

interface ScannedPackage {
  readonly pkg: PackageVersion;
  readonly records: ReadonlyArray<OsvRecord>;
}

export function parseScannerOutput(stdout: string): ScannedPackage[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error("osv-scanner output isn't JSON");
  }
  const results = isObject(json) ? json["results"] : undefined;
  if (!Array.isArray(results)) throw new Error("osv-scanner output has no `results` list");
  return results.flatMap((result: unknown) => {
    const packages = isObject(result) ? result["packages"] : undefined;
    if (!Array.isArray(packages)) throw new Error("osv-scanner output has a result without a `packages` list");
    return packages.map(parseScannedPackage);
  });
}

function parseScannedPackage(entry: unknown): ScannedPackage {
  const pkg = isObject(entry) ? entry["package"] : undefined;
  if (!isObject(pkg)) throw new Error("osv-scanner output has a package entry without `package`");
  const { name, version, ecosystem } = pkg;
  if (typeof name !== "string" || typeof version !== "string" || !ECOSYSTEMS.includes(ecosystem as Ecosystem)) {
    throw new Error(`osv-scanner output has a malformed package: ${JSON.stringify(pkg)}`);
  }
  const vulnerabilities = (entry as Record<string, unknown>)["vulnerabilities"] ?? [];
  if (!Array.isArray(vulnerabilities)) throw new Error(`osv-scanner output: ${name}@${version} has malformed vulnerabilities`);
  return { pkg: { ecosystem: ecosystem as Ecosystem, name, version }, records: vulnerabilities.map(parseOsvRecord) };
}

export function parseOsvRecord(record: unknown): OsvRecord {
  if (!isObject(record) || typeof record["id"] !== "string" || record["id"] === "") {
    throw new Error("osv-scanner output has a vulnerability without an id");
  }
  const id = record["id"];
  const where = `OSV record ${id}`;
  const databaseSpecific = record["database_specific"] ?? {};
  if (!isObject(databaseSpecific)) throw new Error(`${where}: \`database_specific\` must be an object`);
  const severity = optionalString(databaseSpecific, "severity", where);
  return {
    id,
    aliases: stringList(record, "aliases", where),
    summary: optionalString(record, "summary", where),
    cweIds: stringList(databaseSpecific, "cwe_ids", where),
    severity: severity?.toUpperCase(),
    withdrawn: optionalString(record, "withdrawn", where) !== undefined,
  };
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1) ?? "";
}
