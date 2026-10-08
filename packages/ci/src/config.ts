/**
 * `.github/supply-chain.json`, the adopting repository's configuration.
 * Every field is optional; unknown fields fail, so a typo can't silently
 * turn a check off.
 *
 *   {
 *     "npm": { "lockfiles": ["package-lock.json"], "registries": ["https://registry.npmjs.org"] },
 *     "gradle": { "builds": ["."], "ignoreConfigurations": [] },
 *     "maven": { "repositories": ["https://repo1.maven.org/maven2", "https://plugins.gradle.org/m2"] },
 *     "releaseAgeDays": 7,
 *     "ownPackages": { "npm": { "scopes": ["@acme"] }, "Maven": { "groups": ["com.acme"], "pluginIdPrefixes": ["com.acme."] } },
 *     "repositories": { "npm:some-package": "owner/repo" },
 *     "compatibleLines": { "Maven:org.springframework.boot:*": 2 }
 *   }
 */
import { isObject } from "./json.ts";
import { NPM_REGISTRY } from "./npm-lock.ts";
import { MAVEN_CENTRAL } from "./source-repos.ts";
import { packageKey, type PackageName } from "./package-version.ts";
import { ECOSYSTEMS, type Ecosystem } from "./versions.ts";

export interface Config {
  readonly npm: {
    /**
     * Lockfiles to read, relative to the repository root; each must exist.
     * Undefined (not configured): `package-lock.json` if the tree has one.
     */
    readonly lockfiles: ReadonlyArray<string> | undefined;
    /** Registries a locked package may come from. */
    readonly registries: ReadonlyArray<string>;
  };
  readonly gradle: {
    /**
     * Gradle builds to inventory, relative to the repository root. Undefined
     * (not configured): the root build if the tree has one; `[]` turns Gradle off.
     */
    readonly builds: ReadonlyArray<string> | undefined;
    /** Configuration locations (`:sub:someConfiguration`) whose resolution failures don't fail the run. */
    readonly ignoreConfigurations: ReadonlyArray<string>;
  };
  readonly maven: {
    /**
     * Immutable repositories whose POM `Last-Modified` is the publish time, in
     * the order they're asked; a version in none of them fails the age check.
     */
    readonly repositories: ReadonlyArray<string>;
  };
  /** The wait before a new version is taken, in days. */
  readonly releaseAgeDays: number;
  readonly ownPackages: OwnPackages;
  /** `packageKey` → `owner/repo`, where the source repository can't be found automatically. */
  readonly repositories: ReadonlyMap<string, string>;
  /**
   * `<ecosystem>:<package>` (a trailing `*` matches a prefix) → how many
   * leading numeric segments make a compatible line, where the ecosystem's
   * rule (npm's caret range, Maven's first segment) doesn't fit.
   */
  readonly compatibleLines: ReadonlyArray<readonly [pattern: string, segments: number]>;
}

export interface OwnPackages {
  /** npm scopes, with the `@`. */
  readonly npmScopes: ReadonlyArray<string>;
  /** Exact Maven groups. */
  readonly mavenGroups: ReadonlyArray<string>;
  /** Gradle plugin id prefixes; they match plugin marker coordinates `<id>:<id>.gradle.plugin` only. */
  readonly pluginIdPrefixes: ReadonlyArray<string>;
}

export const GRADLE_PLUGIN_PORTAL = "https://plugins.gradle.org/m2";

export const DEFAULT_CONFIG: Config = {
  npm: { lockfiles: undefined, registries: [NPM_REGISTRY] },
  gradle: { builds: undefined, ignoreConfigurations: [] },
  maven: { repositories: [MAVEN_CENTRAL, GRADLE_PLUGIN_PORTAL] },
  releaseAgeDays: 7,
  ownPackages: { npmScopes: [], mavenGroups: [], pluginIdPrefixes: [] },
  repositories: new Map(),
  compatibleLines: [],
};

/** Own packages skip the release-age wait, and only that. */
export function isOwnPackage(own: OwnPackages, pkg: PackageName): boolean {
  if (pkg.ecosystem === "npm") return own.npmScopes.some((scope) => pkg.name.startsWith(`${scope}/`));
  const [group, artifact] = pkg.name.split(":");
  if (own.mavenGroups.includes(group!)) return true;
  return own.pluginIdPrefixes.some((prefix) => group!.startsWith(prefix) && artifact === `${group}.gradle.plugin`);
}

export function parseConfig(raw: unknown): Config {
  const where = "supply-chain.json";
  const root = object(raw, where, ["npm", "gradle", "maven", "releaseAgeDays", "ownPackages", "repositories", "compatibleLines"]);
  const npm = root["npm"] === undefined ? {} : object(root["npm"], `${where}: npm`, ["lockfiles", "registries"]);
  const gradle = root["gradle"] === undefined ? {} : object(root["gradle"], `${where}: gradle`, ["builds", "ignoreConfigurations"]);
  const maven = root["maven"] === undefined ? {} : object(root["maven"], `${where}: maven`, ["repositories"]);
  const own = root["ownPackages"] === undefined ? {} : object(root["ownPackages"], `${where}: ownPackages`, ["npm", "Maven"]);
  const ownNpm = own["npm"] === undefined ? {} : object(own["npm"], `${where}: ownPackages.npm`, ["scopes"]);
  const ownMaven = own["Maven"] === undefined ? {} : object(own["Maven"], `${where}: ownPackages.Maven`, ["groups", "pluginIdPrefixes"]);
  const releaseAgeDays = root["releaseAgeDays"] ?? DEFAULT_CONFIG.releaseAgeDays;
  if (typeof releaseAgeDays !== "number" || !Number.isInteger(releaseAgeDays) || releaseAgeDays < 0) {
    throw new Error(`${where}: releaseAgeDays must be a nonnegative integer`);
  }
  const scopes = strings(ownNpm["scopes"], `${where}: ownPackages.npm.scopes`) ?? [];
  for (const scope of scopes) {
    if (!/^@[a-z0-9][\w.-]*$/i.test(scope)) throw new Error(`${where}: ownPackages.npm.scopes has ${scope}, not an @scope`);
  }
  return {
    npm: {
      lockfiles: strings(npm["lockfiles"], `${where}: npm.lockfiles`),
      registries: (strings(npm["registries"], `${where}: npm.registries`) ?? DEFAULT_CONFIG.npm.registries).map((url) =>
        url.replace(/\/+$/, ""),
      ),
    },
    gradle: {
      builds: strings(gradle["builds"], `${where}: gradle.builds`)?.map((build) => {
        if (build.startsWith("/") || build.split("/").includes("..")) throw new Error(`${where}: gradle.builds has ${build}, not a path inside the repository`);
        return build.replace(/\/+$/, "") || ".";
      }),
      ignoreConfigurations: strings(gradle["ignoreConfigurations"], `${where}: gradle.ignoreConfigurations`) ?? [],
    },
    maven: {
      repositories: (strings(maven["repositories"], `${where}: maven.repositories`) ?? DEFAULT_CONFIG.maven.repositories).map((url) =>
        url.replace(/\/+$/, ""),
      ),
    },
    releaseAgeDays,
    ownPackages: {
      npmScopes: scopes,
      mavenGroups: strings(ownMaven["groups"], `${where}: ownPackages.Maven.groups`) ?? [],
      pluginIdPrefixes: strings(ownMaven["pluginIdPrefixes"], `${where}: ownPackages.Maven.pluginIdPrefixes`) ?? [],
    },
    repositories: repositories(root["repositories"], `${where}: repositories`),
    compatibleLines: compatibleLines(root["compatibleLines"], `${where}: compatibleLines`),
  };
}

function compatibleLines(value: unknown, where: string): Array<readonly [string, number]> {
  if (value === undefined) return [];
  if (!isObject(value)) throw new Error(`${where} must be an object`);
  return Object.entries(value).map(([pattern, segments]) => {
    const ecosystem = pattern.slice(0, pattern.indexOf(":")) as Ecosystem;
    if (!ECOSYSTEMS.includes(ecosystem) || pattern.length <= ecosystem.length + 1) {
      throw new Error(`${where}: ${pattern} isn't <ecosystem>:<package> (a trailing * matches a prefix)`);
    }
    if (typeof segments !== "number" || !Number.isInteger(segments) || segments < 1) {
      throw new Error(`${where}: ${pattern} must map to a positive number of segments`);
    }
    return [pattern, segments] as const;
  });
}

function object(value: unknown, where: string, keys: ReadonlyArray<string>): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${where} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${where} has unknown field(s): ${unknown.join(", ")}`);
  return value;
}

function strings(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "" || item !== item.trim())) {
    throw new Error(`${where} must be a list of trimmed, nonempty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${where} has duplicates`);
  return value as string[];
}

/** `{"npm:name": "owner/repo", "Maven:group:artifact": "owner/repo"}`. */
function repositories(value: unknown, where: string): Map<string, string> {
  if (value === undefined) return new Map();
  if (!isObject(value)) throw new Error(`${where} must be an object`);
  const result = new Map<string, string>();
  for (const [key, repo] of Object.entries(value)) {
    const cut = key.indexOf(":");
    const ecosystem = key.slice(0, cut) as Ecosystem;
    const name = key.slice(cut + 1);
    if (cut === -1 || !ECOSYSTEMS.includes(ecosystem) || name === "") {
      throw new Error(`${where}: ${key} isn't <ecosystem>:<package> (ecosystems: ${ECOSYSTEMS.join(", ")})`);
    }
    if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`${where}: ${key} must map to owner/repo`);
    result.set(packageKey({ ecosystem, name }), repo);
  }
  return result;
}
