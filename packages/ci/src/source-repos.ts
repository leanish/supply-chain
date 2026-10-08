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

/** Sections whose `<url>` isn't the project's. */
const NESTED_SECTIONS = [
  "parent",
  "scm",
  "licenses",
  "developers",
  "contributors",
  "organization",
  "issueManagement",
  "ciManagement",
  "distributionManagement",
  "mailingLists",
  "repositories",
  "pluginRepositories",
  "build",
  "reporting",
  "profiles",
  "dependencyManagement",
  "dependencies",
  "properties",
];

export function pomRepository(pom: string, pkg: PackageVersion): string | undefined {
  const xml = stripComments(pom);
  const scm = section(xml, "scm") ?? "";
  let projectLevel = xml;
  for (const name of NESTED_SECTIONS) projectLevel = projectLevel.replace(new RegExp(`<${name}\\b[\\s\\S]*?</${name}>`, "g"), "");
  const candidates = [element(scm, "url"), element(scm, "connection"), element(scm, "developerConnection"), element(projectLevel, "url")];
  const properties = pomProperties(xml, pkg);
  for (const candidate of candidates) {
    const repo = candidate === undefined ? undefined : githubRepository(interpolate(candidate, properties));
    if (repo !== undefined) return repo;
  }
  return undefined;
}

export function pomParent(pom: string): PackageVersion | undefined {
  const parent = section(stripComments(pom), "parent");
  if (parent === undefined) return undefined;
  const group = element(parent, "groupId");
  const artifact = element(parent, "artifactId");
  const version = element(parent, "version");
  if (group === undefined || artifact === undefined || version === undefined || version.includes("${")) return undefined;
  return { ecosystem: "Maven", name: `${group}:${artifact}`, version };
}

function pomProperties(xml: string, pkg: PackageVersion): Map<string, string> {
  const [group, artifact] = mavenCoordinates(pkg.name);
  const properties = new Map([
    ["project.groupId", group],
    ["project.artifactId", artifact],
    ["project.version", pkg.version],
    ["artifactId", artifact],
    ["groupId", group],
    ["version", pkg.version],
  ]);
  const block = section(xml, "properties") ?? "";
  for (const match of block.matchAll(/<([\w.-]+)>([^<]*)<\/\1>/g)) properties.set(match[1]!, match[2]!.trim());
  return properties;
}

function interpolate(value: string, properties: ReadonlyMap<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (whole, key: string) => properties.get(key) ?? whole);
}

function stripComments(xml: string): string {
  // Metadata matching only, never HTML sanitization. Removing comments preserves
  // text split by them (ac<!-- note -->me); spaces would change the repository name.
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

function section(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];
}

function element(xml: string, name: string): string | undefined {
  const value = new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`).exec(xml)?.[1]?.trim();
  return value === undefined || value === "" ? undefined : value;
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
