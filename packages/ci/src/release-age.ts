/**
 * The release-age rule, the same for every ecosystem: a version a change adds
 * or changes must be at least `releaseAgeDays` old, unless it's an own
 * package, or a `releaseAge` exception names an advisory that, in the
 * comparison's snapshot, affects a version the change replaces and not this
 * one. Malware advisories can't justify skipping the wait.
 */
import { type Config, isOwnPackage } from "./config.ts";
import type { Exceptions } from "./exceptions.ts";
import { label, type PackageVersion } from "./package-version.ts";
import type { Snapshot } from "./snapshot.ts";

const DAY_MS = 86_400_000;

export interface AgeContext {
  readonly snapshot: Snapshot;
  readonly exceptions: Exceptions;
  readonly config: Config;
  readonly now: Date;
}

/** Why `pkg`, published at `published`, fails the wait, or undefined when it passes. */
export function releaseAgeProblem(
  pkg: PackageVersion,
  published: Date,
  replaced: ReadonlyArray<string>,
  context: AgeContext,
): string | undefined {
  if (isOwnPackage(context.config.ownPackages, pkg)) return undefined;
  const ageDays = (context.now.getTime() - published.getTime()) / DAY_MS;
  const minimum = context.config.releaseAgeDays;
  if (ageDays >= minimum) return undefined;
  const exception = context.exceptions.releaseAge.find(
    (entry) =>
      (entry.ecosystem === undefined || entry.ecosystem === pkg.ecosystem) && entry.package === pkg.name && entry.version === pkg.version,
  );
  if (exception === undefined) {
    return `${label(pkg)} was published ${published.toISOString()} (${ageDays.toFixed(1)} days ago, under ${minimum})`;
  }
  if (exception.expires < context.now.toISOString().slice(0, 10)) {
    return `${label(pkg)}: its release-age exception expired on ${exception.expires}`;
  }
  const why = advisoryEvidenceProblem(exception.advisory, pkg, replaced, context.snapshot);
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
