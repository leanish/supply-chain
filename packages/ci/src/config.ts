/**
 * `.github/supply-chain.json`, the adopting repository's configuration.
 * Every field is optional; unknown fields fail, so a typo can't silently
 * turn a check off.
 *
 *   {
 *     "npm": { "lockfiles": ["package-lock.json"], "registries": ["https://registry.npmjs.org"] },
 *     "releaseAgeDays": 7,
 *     "ownPackages": { "npm": { "scopes": ["@acme"] } },
 *     "repositories": { "npm:some-package": "owner/repo" }
 *   }
 */
import { isObject } from "./json.ts";
import { NPM_REGISTRY } from "./npm-lock.ts";
import { packageKey, type PackageName } from "./package-version.ts";
import { ECOSYSTEMS, type Ecosystem } from "./versions.ts";

export interface Config {
  readonly npm: {
    /** Lockfiles to read, relative to the repository root; each must exist. */
    readonly lockfiles: ReadonlyArray<string>;
    /** Registries a locked package may come from. */
    readonly registries: ReadonlyArray<string>;
  };
  /** The wait before a new version is taken, in days. */
  readonly releaseAgeDays: number;
  readonly ownPackages: OwnPackages;
  /** `packageKey` → `owner/repo`, where the source repository can't be found automatically. */
  readonly repositories: ReadonlyMap<string, string>;
}

export interface OwnPackages {
  /** npm scopes, with the `@`. */
  readonly npmScopes: ReadonlyArray<string>;
}

export const DEFAULT_CONFIG: Config = {
  npm: { lockfiles: ["package-lock.json"], registries: [NPM_REGISTRY] },
  releaseAgeDays: 7,
  ownPackages: { npmScopes: [] },
  repositories: new Map(),
};

/** Own packages skip the release-age wait, and only that. */
export function isOwnPackage(own: OwnPackages, pkg: PackageName): boolean {
  if (pkg.ecosystem === "npm") return own.npmScopes.some((scope) => pkg.name.startsWith(`${scope}/`));
  return false;
}

export function parseConfig(raw: unknown): Config {
  const where = "supply-chain.json";
  const root = object(raw, where, ["npm", "releaseAgeDays", "ownPackages", "repositories"]);
  const npm = root["npm"] === undefined ? {} : object(root["npm"], `${where}: npm`, ["lockfiles", "registries"]);
  const own = root["ownPackages"] === undefined ? {} : object(root["ownPackages"], `${where}: ownPackages`, ["npm"]);
  const ownNpm = own["npm"] === undefined ? {} : object(own["npm"], `${where}: ownPackages.npm`, ["scopes"]);
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
      lockfiles: strings(npm["lockfiles"], `${where}: npm.lockfiles`) ?? DEFAULT_CONFIG.npm.lockfiles,
      registries: (strings(npm["registries"], `${where}: npm.registries`) ?? DEFAULT_CONFIG.npm.registries).map((url) =>
        url.replace(/\/+$/, ""),
      ),
    },
    releaseAgeDays,
    ownPackages: { npmScopes: scopes },
    repositories: repositories(root["repositories"], `${where}: repositories`),
  };
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
