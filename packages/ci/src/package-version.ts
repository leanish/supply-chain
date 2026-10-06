import type { Ecosystem } from "./versions.ts";

export interface PackageName {
  readonly ecosystem: Ecosystem;
  /** npm: the package name; Maven: `group:artifact`. */
  readonly name: string;
}

export interface PackageVersion extends PackageName {
  readonly version: string;
}

/** `npm|@scope/name`: identifies a package across versions. */
export function packageKey(pkg: PackageName): string {
  return `${pkg.ecosystem}|${pkg.name}`;
}

/** `npm|@scope/name|1.0.0`: identifies one version. */
export function versionKey(pkg: PackageVersion): string {
  return `${pkg.ecosystem}|${pkg.name}|${pkg.version}`;
}

export function label(pkg: PackageVersion): string {
  return `${pkg.name}@${pkg.version}`;
}

export function uniqueVersions<T extends PackageVersion>(packages: Iterable<T>): T[] {
  const unique = new Map<string, T>();
  for (const pkg of packages) if (!unique.has(versionKey(pkg))) unique.set(versionKey(pkg), pkg);
  return [...unique.values()];
}
