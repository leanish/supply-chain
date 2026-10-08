/** Read Gradle's published interval notation and maintenance-line fixes without guessing unknown ranges. */
import type { RepositoryAdvisory } from "../../ci/src/repository-advisories.ts";
import { inAdvisoryRange, parseAdvisoryRange, versionScheme } from "../../ci/src/versions.ts";

const SCHEME = versionScheme("Maven");
const VERSION = /^\d+(?:\.\d+){0,2}$/;

export function gradleAdvisoryAffects(advisory: RepositoryAdvisory, version: string): boolean {
  if (advisory.vulnerabilities.length === 0) {
    throw new Error(`${advisory.ghsaId}: no Gradle vulnerability ranges`);
  }
  // Read every range, even if an earlier one already matches: an unknown range cannot be safely ignored.
  return advisory.vulnerabilities.map((vulnerability) => vulnerabilityAffects(advisory.ghsaId, vulnerability, version)).some(Boolean);
}

function vulnerabilityAffects(id: string, vulnerability: RepositoryAdvisory["vulnerabilities"][number], version: string): boolean {
  const range = vulnerability.range === undefined ? undefined : normalizedRange(vulnerability.range);
  const intervals = range === undefined ? undefined : parseAdvisoryRange(range);
  if (intervals === undefined || intervals.some(({ lower, upper }) =>
    (lower !== undefined && !VERSION.test(lower.version)) || (upper !== undefined && !VERSION.test(upper.version)))) {
    throw new Error(`${id}: unreadable Gradle advisory range`);
  }
  const hit = inAdvisoryRange(SCHEME, range!, version);
  if (hit === undefined) {
    throw new Error(`${id}: unreadable Gradle advisory range`);
  }
  if (!hit || vulnerability.patched === undefined) {
    return hit;
  }
  const patches = vulnerability.patched.split(",").map((patch) => patch.trim());
  const bounded = intervals.some((interval) => interval.upper !== undefined);
  // A single patch clips an open-ended range, as in the gate. Lists also name backports in separate majors.
  if (bounded && patches.length === 1) {
    return true;
  }
  return !patches.map((patch) => patchedIn(id, patch, version, patches.length > 1)).some(Boolean);
}

function patchedIn(id: string, patch: string, version: string, maintenanceLines: boolean): boolean {
  const matched = /^(>=\s*)?v?(\d+(?:\.\d+){0,2})$/.exec(patch);
  if (matched === null) {
    throw new Error(`${id}: unreadable Gradle patched version`);
  }
  const fixed = matched[2]!;
  const sameLine = version.split(".")[0] === fixed.split(".")[0];
  return (!maintenanceLines || matched[1] !== undefined || sameLine) && SCHEME.compare(version, fixed) >= 0;
}

function normalizedRange(range: string): string {
  return range
    .replace(/([\[(])\s*(\d+(?:\.\d+){0,2})\s*,\s*(\d+(?:\.\d+){0,2})\s*([\])])/g,
      (_match, left: string, lower: string, upper: string, right: string) =>
        `${left === "[" ? ">=" : ">"}${lower} ${right === "]" ? "<=" : "<"}${upper}`)
    .replace(/(\d+(?:\.\d+){0,2})\s+(?:to|through)\s+(\d+(?:\.\d+){0,2}(?:\.[xX])?)/g,
      (_match, lower: string, upper: string) => {
        if (!upper.toLowerCase().endsWith(".x")) {
          return `>=${lower} <=${upper}`;
        }
        const parts = upper.slice(0, -2).split(".");
        parts[parts.length - 1] = String(BigInt(parts.at(-1)!) + 1n);
        return `>=${lower} <${parts.join(".")}`;
      });
}
