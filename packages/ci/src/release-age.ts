/**
 * The release-age rule, the same for every ecosystem: a version a change adds
 * or changes must be at least `releaseAgeDays` old, unless
 *   - it's an own package (own packages skip only this wait), or
 *   - it's the security fix the version rule picks (`young-fixes.ts`), or
 *   - it's a carrier version that rule picks for the bundled advisories it
 *     drops (`bundle-fix-proof.ts`), or
 *   - npm needs it for that fix and no aged version satisfies the requirement
 *     (only the lowest satisfying version, independently proved), or
 *   - a `releaseAge` exception names an advisory that, in the comparison's
 *     snapshot, affects a version the change replaces and not this one (for
 *     fixes the proof can't make). Malware advisories can't justify it.
 *
 * Passing this rule isn't trusting the version: every young version, however
 * justified, is also held by the cooldown (`cooldown.ts`) until it ages.
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
  /** `versionKey` of a young carrier version → undefined when its bundle fix is proved, else why it isn't. */
  readonly bundleFixes?: ReadonlyMap<string, string | undefined>;
}

/** Under the wait and not an own package: what the proof or an exception must justify. */
export function isYoung(change: ChangedVersion, config: Config, now: Date): boolean {
  if (isOwnPackage(config.ownPackages, change.pkg)) return false;
  return (now.getTime() - change.published.getTime()) / DAY_MS < config.releaseAgeDays;
}

/** What let a young version through: the fix proof, the required-dependency proof, an exception; or nothing. */
export type YoungJustification = "security-fix" | "bundle-fix" | "required" | "exception" | "unjustified";

/** A version the change adds or changes that is still under the wait. */
export interface HeldVersion {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly version: string;
  /** Versions of the package the change replaces. */
  readonly replaced: ReadonlyArray<string>;
  readonly published: string;
  /** When it turns `releaseAgeDays` old. */
  readonly eligibleAt: string;
  readonly justification: YoungJustification;
}

export interface ReleaseAgeReview {
  readonly problems: ReadonlyArray<string>;
  /** Every young version, justified or not. */
  readonly held: ReadonlyArray<HeldVersion>;
}

export async function reviewReleaseAge(changes: ReadonlyArray<ChangedVersion>, context: AgeContext): Promise<ReleaseAgeReview> {
  const problems: string[] = [];
  const held: HeldVersion[] = [];
  for (const change of changes) {
    if (!isYoung(change, context.config, context.now)) continue;
    const judged = await judgeYoung(change, context);
    if (judged.problem !== undefined) problems.push(judged.problem);
    held.push({
      ecosystem: change.pkg.ecosystem,
      name: change.pkg.name,
      version: change.pkg.version,
      replaced: change.replaced,
      published: change.published.toISOString(),
      eligibleAt: new Date(change.published.getTime() + context.config.releaseAgeDays * DAY_MS).toISOString(),
      justification: judged.justification,
    });
  }
  return { problems, held };
}

/** Just the problems: what fails the `supply-chain` verdict. */
export async function releaseAgeProblems(changes: ReadonlyArray<ChangedVersion>, context: AgeContext): Promise<string[]> {
  return [...(await reviewReleaseAge(changes, context)).problems];
}

async function judgeYoung(change: ChangedVersion, context: AgeContext): Promise<{ readonly justification: YoungJustification; readonly problem?: string }> {
  const { pkg } = change;
  if (pkg.ecosystem === "npm" && context.required?.has(versionKey(pkg))) return { justification: "required" };
  const proof = await youngFixProblem(
    { pkg, replaced: change.replaced },
    context.candidates.get(versionKey(pkg)) ?? new Map(),
    context.snapshot,
    context.catalogs[pkg.ecosystem],
    context.config,
    context.now,
  );
  if (proof === undefined) return { justification: "security-fix" };
  const bundled = context.bundleFixes?.get(versionKey(pkg));
  if (context.bundleFixes?.has(versionKey(pkg)) === true && bundled === undefined) return { justification: "bundle-fix" };
  const exception = context.exceptions.releaseAge.find(
    (entry) => (entry.ecosystem === undefined || entry.ecosystem === pkg.ecosystem) && entry.package === pkg.name && entry.version === pkg.version,
  );
  if (exception === undefined) {
    const ageDays = (context.now.getTime() - change.published.getTime()) / DAY_MS;
    return {
      justification: "unjustified",
      problem: `${label(pkg)} was published ${change.published.toISOString()} (${ageDays.toFixed(1)} days ago, under ${
        context.config.releaseAgeDays
      }), and it isn't the security fix the version rule would take: ${proof}${bundled === undefined ? "" : `; nor a bundled fix: ${bundled}`}`,
    };
  }
  if (exception.expires < context.now.toISOString().slice(0, 10)) {
    return { justification: "unjustified", problem: `${label(pkg)}: its release-age exception expired on ${exception.expires}` };
  }
  const why = advisoryEvidenceProblem(exception.advisory, pkg, change.replaced, context.snapshot);
  return why === undefined ? { justification: "exception" } : { justification: "unjustified", problem: `${label(pkg)}: ${why}` };
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
