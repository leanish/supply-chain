/**
 * The GitHub repository a package version is built from, so its published
 * repository security advisories can be read even before (or without) them
 * reaching OSV. npm: the version manifest's `repository`; Maven: the POM's
 * `scm` (or project `url`), walking up to 5 parent POMs; config overrides win.
 * Undefined when nothing names a GitHub repository: a reported coverage gap.
 */
import { mapLimited, type Fetch } from "./http.ts";
import { dig, isObject } from "./json.ts";
import { npmPackageUrl } from "./npm-url.ts";
import { packageKey, type PackageVersion, versionKey } from "./package-version.ts";
import { child, children, text, type XmlElement, xmlRoot } from "./xml.ts";

export const MAVEN_CENTRAL = "https://repo1.maven.org/maven2";
const MAX_PARENT_DEPTH = 5;

export interface SourceRepoOptions {
  readonly fetch: Fetch;
  /** `packageKey` → `owner/repo`, from config. */
  readonly overrides: ReadonlyMap<string, string>;
  /** Maven repositories to read POMs from, in order. */
  readonly mavenRepositories: ReadonlyArray<string>;
}

/** `versionKey` → `owner/repo` (lower case) or undefined. */
export async function sourceRepositories(
  packages: ReadonlyArray<PackageVersion>,
  options: SourceRepoOptions,
): Promise<Map<string, string | undefined>> {
  const repos = await mapLimited(packages, 16, (pkg) => sourceRepository(pkg, options));
  return new Map(packages.map((pkg, i) => [versionKey(pkg), repos[i]]));
}

export async function sourceRepository(pkg: PackageVersion, options: SourceRepoOptions): Promise<string | undefined> {
  const override = options.overrides.get(packageKey(pkg));
  if (override !== undefined) return override.toLowerCase();
  if (pkg.ecosystem === "GitHub Actions") return pkg.name.toLowerCase();
  return pkg.ecosystem === "npm" ? npmRepository(pkg, options.fetch) : mavenRepository(pkg, options, 0);
}

async function npmRepository(pkg: PackageVersion, fetch: Fetch): Promise<string | undefined> {
  const url = npmPackageUrl(pkg.name, pkg.version);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`registry lookup of ${pkg.name}@${pkg.version} failed with HTTP ${response.status}`);
  const manifest = await response.json();
  return isObject(manifest) ? githubRepository(manifest["repository"]) : undefined;
}

async function mavenRepository(pkg: PackageVersion, options: SourceRepoOptions, depth: number): Promise<string | undefined> {
  const pom = await fetchPom(pkg, options);
  if (pom === undefined) return undefined;
  const found = pomRepository(pom, pkg);
  if (found !== undefined || depth >= MAX_PARENT_DEPTH) return found;
  const parent = pomParent(pom);
  return parent === undefined ? undefined : mavenRepository(parent, options, depth + 1);
}

/** The POM of `pkg` from the first repository that has it; undefined when none does. */
export async function fetchPom(pkg: PackageVersion, options: SourceRepoOptions): Promise<string | undefined> {
  for (const base of options.mavenRepositories) {
    const response = await options.fetch(pomUrl(base, pkg));
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`POM lookup of ${pkg.name}:${pkg.version} failed with HTTP ${response.status}`);
    return response.text();
  }
  return undefined;
}

export function pomUrl(base: string, pkg: PackageVersion): string {
  const [group, artifact] = mavenCoordinates(pkg.name);
  return `${base}/${group.replaceAll(".", "/")}/${artifact}/${pkg.version}/${artifact}-${pkg.version}.pom`;
}

export function mavenCoordinates(name: string): [group: string, artifact: string] {
  const parts = name.split(":");
  if (parts.length !== 2 || parts.some((part) => part === "")) throw new Error(`not a Maven group:artifact name: ${name}`);
  return [parts[0]!, parts[1]!];
}

/**
 * The project's GitHub repository: its `<scm>` url and connections, then its own `<url>`, with
 * `${...}` properties expanded. Only `<project>`'s own children count: a profile's or a plugin's
 * `<scm>`, `<url>` or `<properties>` isn't the project's. A POM that can't be read names none.
 */
export function pomRepository(pom: string, pkg: PackageVersion): string | undefined {
  const project = xmlRoot(pom, "project");
  if (project === undefined) return undefined;
  const scm = child(project, "scm");
  const candidates = [text(child(scm, "url")), text(child(scm, "connection")), text(child(scm, "developerConnection")), text(child(project, "url"))];
  const properties = pomProperties(project, pkg);
  for (const candidate of candidates) {
    const repo = candidate === undefined ? undefined : githubRepository(interpolate(candidate, properties));
    if (repo !== undefined) return repo;
  }
  return undefined;
}

export function pomParent(pom: string): PackageVersion | undefined {
  const parent = child(xmlRoot(pom, "project"), "parent");
  const group = text(child(parent, "groupId"));
  const artifact = text(child(parent, "artifactId"));
  const version = text(child(parent, "version"));
  if (group === undefined || artifact === undefined || version === undefined || version.includes("${")) return undefined;
  return { ecosystem: "Maven", name: `${group}:${artifact}`, version };
}

function pomProperties(project: XmlElement, pkg: PackageVersion): Map<string, string> {
  const [group, artifact] = mavenCoordinates(pkg.name);
  const properties = new Map([
    ["project.groupId", group],
    ["project.artifactId", artifact],
    ["project.version", pkg.version],
    ["artifactId", artifact],
    ["groupId", group],
    ["version", pkg.version],
  ]);
  for (const [name, property] of children(child(project, "properties"))) properties.set(name, text(property) ?? "");
  return properties;
}

function interpolate(value: string, properties: ReadonlyMap<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (whole, key: string) => properties.get(key) ?? whole);
}

/**
 * `owner/repo` (lower case) of anything naming a GitHub repository: URLs
 * (https, git+https, ssh, `scm:git:` connections) and npm's `owner/repo` or
 * `github:owner/repo` shorthands, also inside a manifest's `{ url }` object.
 */
export function githubRepository(value: unknown): string | undefined {
  const raw = isObject(value) ? dig(value, ["url"]) : value;
  if (typeof raw !== "string") return undefined;
  const match =
    /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i.exec(raw) ?? /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(raw);
  return match === null ? undefined : `${match[1]}/${match[2]}`.toLowerCase();
}
