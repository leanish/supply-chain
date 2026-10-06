/**
 * Findings and the base/head comparison. A finding is a package version an
 * advisory group affects; two findings are "the same" when ecosystem, package
 * and advisory group match, whatever the version or location, so an upgrade
 * that fixes A and leaves B passes, and B shows up as inherited.
 */
import type { PackageVersion } from "./package-version.ts";
import type { Snapshot } from "./snapshot.ts";
import type { Ecosystem } from "./versions.ts";

export interface Located extends PackageVersion {
  /** Where this version is installed or resolved: lockfile paths, Gradle configuration ids, workflow files. */
  readonly locations: ReadonlyArray<string>;
}

export interface Finding {
  readonly ecosystem: Ecosystem | "GitHub Actions";
  readonly name: string;
  readonly version: string;
  /** Canonical id of the advisory group. */
  readonly advisory: string;
  /** Every id this group has across the advisories that hit this version. */
  readonly ids: ReadonlyArray<string>;
  readonly malicious: boolean;
  readonly summary: string | undefined;
  readonly severity: string | undefined;
  readonly locations: ReadonlyArray<string>;
}

/** `npm|lib|GHSA-…`: what makes two findings the same finding. */
export function findingKey(finding: Pick<Finding, "ecosystem" | "name" | "advisory">): string {
  return `${finding.ecosystem}|${finding.name}|${finding.advisory}`;
}

/** Every finding on these packages, one per package version and advisory group. */
export function findingsOf(packages: ReadonlyArray<Located>, snapshot: Snapshot): Finding[] {
  const findings: Finding[] = [];
  for (const pkg of packages) {
    const byGroup = new Map<string, { ids: Set<string>; malicious: boolean; summary?: string; severity?: string }>();
    for (const advisory of snapshot.advisories(pkg)) {
      const group = snapshot.group(advisory.id);
      const entry = byGroup.get(group) ?? { ids: new Set<string>(), malicious: false };
      for (const id of advisory.ids) entry.ids.add(id);
      entry.malicious ||= advisory.malicious;
      entry.summary ??= advisory.summary;
      entry.severity ??= advisory.severity;
      byGroup.set(group, entry);
    }
    for (const [group, entry] of byGroup) {
      findings.push({
        ecosystem: pkg.ecosystem,
        name: pkg.name,
        version: pkg.version,
        advisory: group,
        ids: [...entry.ids].sort(),
        malicious: entry.malicious,
        summary: entry.summary,
        severity: entry.severity,
        locations: pkg.locations,
      });
    }
  }
  return findings;
}

export interface Comparison {
  /** In head, with a key base doesn't have: these fail unless excepted. */
  readonly added: ReadonlyArray<Finding>;
  /** In head, with a key base also has: warnings. */
  readonly inherited: ReadonlyArray<Finding>;
  /** In base, with a key head no longer has. */
  readonly fixed: ReadonlyArray<Finding>;
}

export function compareFindings(base: ReadonlyArray<Finding>, head: ReadonlyArray<Finding>): Comparison {
  const baseKeys = new Set(base.map(findingKey));
  const headKeys = new Set(head.map(findingKey));
  return {
    added: head.filter((finding) => !baseKeys.has(findingKey(finding))),
    inherited: head.filter((finding) => baseKeys.has(findingKey(finding))),
    fixed: base.filter((finding) => !headKeys.has(findingKey(finding))),
  };
}
