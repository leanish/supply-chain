/**
 * The release-age rule, the same for every ecosystem: a version a change adds
 * or changes must be at least `releaseAgeDays` old, unless
 *   - it's an own package (own packages skip only this wait), or
 *   - it's the security fix the version rule picks (`young-fixes.ts`), or
 *   - npm needs it for that fix and no aged version satisfies the requirement
 *     (only the lowest satisfying version, independently proved), or
 *   - a `releaseAge` exception names an advisory that, in the comparison's
 *     snapshot, affects a version the change replaces and not this one (for
 *     fixes the proof can't make). Malware advisories can't justify it.
 */
import { type Config, isOwnPackage } from "./config.ts";
import type { Exceptions } from "./exceptions.ts";
import { label, type PackageVersion, versionKey } from "./package-version.ts";
import type { Snapshot } from "./snapshot.ts";
import type { Ecosystem } from "./versions.ts";
import { type VersionCatalog, youngFixProblem } from "./young-fixes.ts";

const DAY_MS = 86_400_000;

export interface ChangedVersion {
  readonly pkg: PackageVersion;
  readonly published: Date;
  /** Versions of the package the change replaces. */
  readonly replaced: ReadonlyArray<string>;
}

export interface AgeContext {
  readonly snapshot: Snapshot;
  readonly exceptions: Exceptions;
  readonly config: Config;
  readonly now: Date;
  readonly catalogs: Readonly<Record<Ecosystem, VersionCatalog>>;
  /** Independently reconstructed required versions; never read from a PR plan. */
  readonly required?: ReadonlySet<string>;
  /** `versionKey` of a young version → replaced version → its candidates, all in the snapshot. */
  readonly candidates: ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<string>>>;
}

/** Under the wait and not an own package: what the proof or an exception must justify. */
export function isYoung(change: ChangedVersion, config: Config, now: Date): boolean {
  if (isOwnPackage(config.ownPackages, change.pkg)) return false;
  return (now.getTime() - change.published.getTime()) / DAY_MS < config.releaseAgeDays;
}

export async function releaseAgeProblems(changes: ReadonlyArray<ChangedVersion>, context: AgeContext): Promise<string[]> {
  const problems: string[] = [];
  for (const change of changes) {
    if (!isYoung(change, context.config, context.now)) continue;
    const problem = await youngProblem(change, context);
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}

async function youngProblem(change: ChangedVersion, context: AgeContext): Promise<string | undefined> {
  const { pkg } = change;
  if (pkg.ecosystem === "npm" && context.required?.has(versionKey(pkg))) return undefined;
  const proof = await youngFixProblem(
    { pkg, replaced: change.replaced },
    context.candidates.get(versionKey(pkg)) ?? new Map(),
    context.snapshot,
    context.catalogs[pkg.ecosystem],
    context.config,
    context.now,
  );
  if (proof === undefined) return undefined;
  const exception = context.exceptions.releaseAge.find(
    (entry) => (entry.ecosystem === undefined || entry.ecosystem === pkg.ecosystem) && entry.package === pkg.name && entry.version === pkg.version,
  );
  if (exception === undefined) {
    const ageDays = (context.now.getTime() - change.published.getTime()) / DAY_MS;
    return `${label(pkg)} was published ${change.published.toISOString()} (${ageDays.toFixed(1)} days ago, under ${
      context.config.releaseAgeDays
    }), and it isn't the security fix the version rule would take: ${proof}`;
  }
  if (exception.expires < context.now.toISOString().slice(0, 10)) {
    return `${label(pkg)}: its release-age exception expired on ${exception.expires}`;
  }
  const why = advisoryEvidenceProblem(exception.advisory, pkg, change.replaced, context.snapshot);
  return why === undefined ? undefined : `${label(pkg)}: ${why}`;
}

/**
 * Why `advisory` doesn't justify taking `pkg` before the wait, or undefined
 * when it does: not malware, affecting a version this change replaces, and
 * no longer affecting `pkg`, all in the comparison's snapshot.
 */
function advisoryEvidenceProblem(
  advisory: string,
  pkg: PackageVersion,
  replaced: ReadonlyArray<string>,
  snapshot: Snapshot,
): string | undefined {
  const group = snapshot.group(advisory);
  const hits = (version: string) =>
    snapshot.advisories({ ecosystem: pkg.ecosystem, name: pkg.name, version }).filter((entry) => snapshot.group(entry.id) === group);
  if (replaced.length === 0) return `advisory ${advisory} can't justify it: the change removes no ${pkg.name} version`;
  const affected = replaced.flatMap(hits);
  if (affected.length === 0) return `advisory ${advisory} doesn't affect the replaced version(s) ${replaced.join(", ")}`;
  if (affected.some((entry) => entry.malicious)) return `advisory ${advisory} is a malware entry`;
  if (hits(pkg.version).length > 0) return `advisory ${advisory} still affects ${pkg.version}`;
  return undefined;
}
