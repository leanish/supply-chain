/**
 * Floors: a minimum version forced on a dependency (usually a transitive
 * one) for a security fix or for compatibility. `.github/dependency-floors.json`
 * records every one, so a floor never outlives its reason unnoticed:
 *
 *   { "floors": [{
 *       "ecosystem": "Maven", "package": "com.google.guava:guava", "version": "33.7.2-jre",
 *       "declaredIn": "build.gradle.kts", "selector": [":checkstyle", ":errorprone"],
 *       "purpose": "security", "advisories": ["CVE-2026-102554"],
 *       "reason": "Checkstyle and Error Prone pull an affected Guava", "added": "2026-10-04" }] }
 *
 * The checks, on head:
 *   - Gradle (Maven packages): in every configuration the selector names, the
 *     build declares the package at exactly the floor version, with a
 *     `because(...)` naming every advisory (security) or saying why
 *     (compatibility), and resolves it at or above the floor, by Gradle's
 *     ordering. The inventory's declared dependencies come from Gradle itself,
 *     catalog versions included, so no build file is parsed.
 *   - npm: the `overrides` entry at each selector path (a list of keys,
 *     `["aws-cdk-lib", "brace-expansion"]`; a string for a top-level key) in
 *     `declaredIn` (a package.json) pins the floor or above (`x`, `^x`, `~x`,
 *     `>=x`), and every locked copy in its lockfile is at or above it. Every
 *     override must have a floor entry.
 *   - Gradle declarations whose reason names an advisory but have no floor
 *     entry are noted (a plugin can inject them; not this repository's to record).
 */
import { dirname } from "node:path";

import { compareGradleVersions } from "./gradle-versions.ts";
import { gradleLocation } from "./gradle.ts";
import { isIsoDate } from "./exceptions.ts";
import type { Inventory } from "./inventory.ts";
import { isObject } from "./json.ts";
import type { Tree } from "./tree.ts";
import { isSemVer, versionScheme } from "./versions.ts";

export const FLOORS_PATH = ".github/dependency-floors.json";

export interface Floor {
  readonly ecosystem: "npm" | "Maven";
  readonly package: string;
  readonly version: string;
  /** The file that declares it: a Gradle build file, or the package.json with the override. */
  readonly declaredIn: string;
  /** Gradle: the configuration locations it must hold in (`:checkstyle`). */
  readonly locations: ReadonlyArray<string>;
  /** npm: the `overrides` key paths that pin it, each a list of keys (`["aws-cdk-lib", "brace-expansion"]`). */
  readonly overridePaths: ReadonlyArray<ReadonlyArray<string>>;
  readonly purpose: "security" | "compatibility";
  readonly advisories: ReadonlyArray<string>;
  readonly reason: string;
  readonly added: string;
}

const ADVISORY_ID = /^(?:GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|CVE-\d{4}-\d{4,}|MAL-\d{4}-\d+)$/;

export function parseFloors(raw: unknown): Floor[] {
  const where = "dependency-floors.json";
  if (!isObject(raw) || !Array.isArray(raw["floors"]) || Object.keys(raw).some((key) => key !== "floors")) {
    throw new Error(`${where} must be { "floors": [...] }`);
  }
  const seen = new Set<string>();
  return raw["floors"].map((entry: unknown, i): Floor => {
    const at = `${where}: floors[${i}]`;
    if (!isObject(entry)) throw new Error(`${at} must be an object`);
    const known = ["ecosystem", "package", "version", "declaredIn", "selector", "purpose", "advisories", "reason", "added"];
    const unknown = Object.keys(entry).filter((key) => !known.includes(key));
    if (unknown.length > 0) throw new Error(`${at} has unknown field(s): ${unknown.join(", ")}`);
    const text = (key: string): string => {
      const value = entry[key];
      if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) throw new Error(`${at}.${key} is required (trimmed, nonempty)`);
      return value;
    };
    const ecosystem = text("ecosystem");
    if (ecosystem !== "npm" && ecosystem !== "Maven") throw new Error(`${at}.ecosystem must be npm or Maven`);
    const purpose = text("purpose");
    if (purpose !== "security" && purpose !== "compatibility") throw new Error(`${at}.purpose must be security or compatibility`);
    const selectorValue = entry["selector"];
    const selector = typeof selectorValue === "string" ? [selectorValue] : selectorValue;
    if (!Array.isArray(selector) || selector.length === 0) throw new Error(`${at}.selector must be a nonempty string or list`);
    const nonempty = (item: unknown) => typeof item === "string" && item.trim() !== "";
    let locations: string[] = [];
    let overridePaths: string[][] = [];
    if (ecosystem === "Maven") {
      if (!selector.every(nonempty)) throw new Error(`${at}.selector must list Gradle configuration locations`);
      locations = selector as string[];
    } else {
      overridePaths = selector.map((item: unknown) => (typeof item === "string" ? [item] : item)) as string[][];
      if (!overridePaths.every((path) => Array.isArray(path) && path.length > 0 && path.every(nonempty))) {
        throw new Error(`${at}.selector must list overrides key paths (a key, or a list of keys)`);
      }
    }
    const advisories = entry["advisories"] ?? [];
    if (!Array.isArray(advisories) || advisories.some((id) => typeof id !== "string" || !ADVISORY_ID.test(id))) {
      throw new Error(`${at}.advisories must list GHSA-, CVE- or MAL- ids`);
    }
    if (purpose === "security" && advisories.length === 0) throw new Error(`${at}: a security floor names the advisories it fixes`);
    if (purpose === "compatibility" && advisories.length > 0) throw new Error(`${at}: a compatibility floor names no advisories`);
    const added = text("added");
    if (!isIsoDate(added)) throw new Error(`${at}.added must be a real YYYY-MM-DD date`);
    const floor: Floor = {
      ecosystem,
      package: text("package"),
      version: text("version"),
      declaredIn: text("declaredIn"),
      locations,
      overridePaths,
      purpose,
      advisories: advisories as string[],
      reason: text("reason"),
      added,
    };
    // Two floors for one package in one file can't claim the same configuration or override.
    for (const claim of [...floor.locations, ...floor.overridePaths.map((path) => JSON.stringify(path))]) {
      const key = `${floor.ecosystem}|${floor.package}|${floor.declaredIn}|${claim}`;
      if (seen.has(key)) throw new Error(`${at} duplicates an earlier floor for ${floor.package} in ${floor.declaredIn} (${claim})`);
      seen.add(key);
    }
    return floor;
  });
}

export interface FloorCheck {
  readonly failures: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
}

export async function checkFloors(floors: ReadonlyArray<Floor>, inventory: Inventory, tree: Tree): Promise<FloorCheck> {
  const failures: string[] = [];
  const notes: string[] = [];
  for (const floor of floors) {
    const label = `floor ${floor.package} ${floor.version} (${floor.declaredIn})`;
    if ((await tree.read(floor.declaredIn)) === undefined) {
      failures.push(`${label}: ${floor.declaredIn} isn't in ${tree.id}`);
      continue;
    }
    failures.push(...(floor.ecosystem === "Maven" ? gradleFloorProblems(floor, inventory, label) : await npmFloorProblems(floor, inventory, tree, label)));
  }
  failures.push(...(await unrecordedOverrides(floors, inventory, tree)));
  notes.push(...unrecordedGradleFloors(floors, inventory));
  return { failures, notes };
}

function gradleFloorProblems(floor: Floor, inventory: Inventory, label: string): string[] {
  if (inventory.gradle === undefined) return [`${label}: the tree has no Gradle build`];
  const [group, name] = floor.package.split(":");
  const problems: string[] = [];
  for (const location of floor.locations) {
    const configuration = inventory.gradle.builds
      .flatMap((build) => build.configurations.map((config) => ({ location: gradleLocation(build.build, config.id), config })))
      .find((candidate) => candidate.location === location)?.config;
    if (configuration === undefined) {
      problems.push(`${label}: Gradle has no resolvable configuration ${location}`);
      continue;
    }
    const declared = configuration.declared.filter((dependency) => dependency.group === group && dependency.name === name);
    // Any declaration at the floor's version with the reason it needs: a plugin may declare the same version unreasoned.
    const atFloor = declared.filter((dependency) => dependency.version === floor.version);
    const missingFrom = (reason: string | undefined) => floor.advisories.filter((id) => !(reason ?? "").toUpperCase().includes(id.toUpperCase()));
    const reasoned = (reason: string | undefined) => floor.purpose === "security" ? missingFrom(reason).length === 0 : (reason ?? "").trim() !== "";
    if (atFloor.length === 0) {
      const versions = declared.map((dependency) => dependency.version ?? "no version").join(", ");
      problems.push(`${label}: ${location} doesn't declare ${floor.package}:${floor.version}${versions === "" ? "" : ` (declares ${versions})`}`);
    } else if (!atFloor.some((dependency) => reasoned(dependency.reason))) {
      if (floor.purpose === "security") problems.push(`${label}: ${location}'s because(...) doesn't name ${missingFrom(atFloor.find((dependency) => dependency.reason !== undefined)?.reason).join(", ")}`);
      else problems.push(`${label}: ${location} declares it without a because(...)`);
    }
    const resolved = configuration.resolved.filter((component) => component.group === group && component.name === name);
    if (resolved.length === 0) problems.push(`${label}: ${location} doesn't resolve ${floor.package}`);
    for (const component of resolved) {
      if (compareGradleVersions(component.version, floor.version) < 0) {
        problems.push(`${label}: ${location} resolves ${floor.package}:${component.version}, below the floor`);
      }
    }
  }
  return problems;
}

async function npmFloorProblems(floor: Floor, inventory: Inventory, tree: Tree, label: string): Promise<string[]> {
  const scheme = versionScheme("npm");
  if (!isSemVer(floor.version)) return [`${label}: ${floor.version} isn't a SemVer version`];
  const manifest = await readJson(tree, floor.declaredIn);
  const overrides = isObject(manifest) ? manifest["overrides"] : undefined;
  const problems: string[] = [];
  for (const path of floor.overridePaths) {
    const shown = path.join(" > ");
    if (overrideTarget(path) !== floor.package) {
      problems.push(`${label}: the override ${shown} is for ${overrideTarget(path)}, not ${floor.package}`);
      continue;
    }
    const spec = overrideAt(overrides, path);
    if (spec === undefined) {
      problems.push(`${label}: ${floor.declaredIn} has no override at ${shown}`);
      continue;
    }
    const base = /^(?:\^|~|>=\s*)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(spec.trim())?.[1];
    if (base === undefined) problems.push(`${label}: the override ${shown} is "${spec}"; a floor needs x, ^x, ~x or >=x`);
    else if (scheme.compare(base, floor.version) < 0) problems.push(`${label}: the override ${shown} is "${spec}", below the floor`);
  }
  const dir = dirname(floor.declaredIn);
  const lockfile = inventory.npm.find((candidate) => dirname(candidate.path) === dir);
  if (lockfile === undefined) return [...problems, `${label}: no checked lockfile sits next to ${floor.declaredIn}`];
  const copies = lockfile.packages.filter((pkg) => pkg.name === floor.package);
  if (copies.length === 0) problems.push(`${label}: ${lockfile.path} doesn't install ${floor.package}`);
  for (const copy of copies) {
    if (scheme.compare(copy.version, floor.version) < 0) problems.push(`${label}: ${lockfile.path} has ${floor.package}@${copy.version} at ${copy.path}, below the floor`);
  }
  return problems;
}

/** The package an override path pins: its last key, without a version qualifier (`child@^2` → `child`). */
function overrideTarget(path: ReadonlyArray<string>): string {
  const key = path.at(-1)!;
  const at = key.indexOf("@", 1);
  return at === -1 ? key : key.slice(0, at);
}

/** The override spec at a key path (a nested override's own version is its `.` key). */
export function overrideAt(overrides: unknown, path: ReadonlyArray<string>): string | undefined {
  let node: unknown = overrides;
  for (const key of path) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  if (isObject(node)) node = node["."];
  return typeof node === "string" ? node : undefined;
}

/** Every override in a checked lockfile's package.json needs a floor entry. */
async function unrecordedOverrides(floors: ReadonlyArray<Floor>, inventory: Inventory, tree: Tree): Promise<string[]> {
  const problems: string[] = [];
  for (const lockfile of inventory.npm) {
    const manifestPath = dirname(lockfile.path) === "." ? "package.json" : `${dirname(lockfile.path)}/package.json`;
    const manifest = await readJson(tree, manifestPath);
    const overrides = isObject(manifest) ? manifest["overrides"] : undefined;
    for (const path of overridePaths(overrides, [])) {
      const recorded = floors.some(
        (floor) =>
          floor.ecosystem === "npm" &&
          floor.declaredIn === manifestPath &&
          floor.package === overrideTarget(path) &&
          floor.overridePaths.some((claimed) => JSON.stringify(claimed) === JSON.stringify(path)),
      );
      if (!recorded) problems.push(`${manifestPath} overrides ${path.join(" > ")} without an entry in ${FLOORS_PATH}`);
    }
  }
  return problems;
}

function overridePaths(node: unknown, prefix: string[]): string[][] {
  if (!isObject(node)) return [];
  return Object.entries(node).flatMap(([key, value]) => {
    if (key === ".") return [prefix];
    if (typeof value === "string") return [[...prefix, key]];
    return overridePaths(value, [...prefix, key]);
  });
}

/**
 * Gradle declarations with a `because(...)` that no floor entry covers (same
 * package and version, in that configuration): noted, since a plugin can
 * inject them.
 */
function unrecordedGradleFloors(floors: ReadonlyArray<Floor>, inventory: Inventory): string[] {
  if (inventory.gradle === undefined) return [];
  const notes = new Set<string>();
  for (const build of inventory.gradle.builds) {
    for (const configuration of build.configurations) {
      const location = gradleLocation(build.build, configuration.id);
      for (const dependency of configuration.declared) {
        if (dependency.reason === undefined || dependency.reason.trim() === "") continue;
        const name = `${dependency.group}:${dependency.name}`;
        const covered = floors.some(
          (floor) => floor.ecosystem === "Maven" && floor.package === name && floor.version === dependency.version && floor.locations.includes(location),
        );
        if (!covered) notes.add(`${name}:${dependency.version ?? "?"} is declared in ${location} because "${dependency.reason}" without an entry in ${FLOORS_PATH}`);
      }
    }
  }
  return [...notes];
}

async function readJson(tree: Tree, path: string): Promise<unknown> {
  const text = await tree.read(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} in ${tree.id} isn't JSON`);
  }
}
