/**
 * An npm lockfile (v2/v3 `packages` map) as a graph: every installed copy,
 * and every dependency edge with the copy Node resolves it to (the nearest
 * `node_modules` walking up from the dependent). The root and the workspaces
 * declare; installed packages depend (their dev dependencies aren't
 * installed, so they aren't edges).
 */
import semver from "semver";

export interface LockEntry {
  readonly name?: string;
  readonly version?: string;
  readonly link?: boolean;
  readonly inBundle?: boolean;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

/** An installed copy of a registry package. */
export interface Copy {
  /** Lockfile key, `node_modules/a/node_modules/b`. */
  readonly path: string;
  /** The registry package (an alias's target). */
  readonly name: string;
  /** The key it's installed under: `name`, or an `npm:` alias. */
  readonly installedAs: string;
  readonly version: string;
  /** Shipped inside its parent's tarball: it moves with the parent, never on its own. */
  readonly bundled: boolean;
}

export interface Edge {
  /** The dependent's lockfile key (`""` for the root, a workspace's directory, or an installed package). */
  readonly from: string;
  /** The key it depends on (the alias, when it is one). */
  readonly key: string;
  readonly spec: string;
  readonly kind: "dependency" | "optional" | "dev" | "peer";
  /** Declared by the root or a workspace: a direct dependency. */
  readonly declared: boolean;
  /** The copy it resolves to; undefined when none is installed (an optional or peer dependency left out). */
  readonly to: string | undefined;
}

export class NpmGraph {
  readonly packages: Readonly<Record<string, LockEntry>>;
  readonly #edges: Edge[];

  constructor(lock: unknown) {
    const packages = (lock as { packages?: unknown } | null)?.packages;
    if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
      throw new Error("the lockfile has no `packages` map");
    }
    this.packages = packages as Record<string, LockEntry>;
    this.#edges = [];
    for (const [from, entry] of Object.entries(this.packages)) {
      if (entry.link === true) {
        continue;
      }
      const declared = !from.includes("node_modules/");
      const specs = { ...entry.peerDependencies, ...entry.optionalDependencies, ...(declared ? entry.devDependencies : {}), ...entry.dependencies };
      for (const [key, spec] of Object.entries(specs)) {
        const kind = entry.dependencies?.[key] !== undefined ? "dependency" : declared && entry.devDependencies?.[key] !== undefined ? "dev" : entry.optionalDependencies?.[key] !== undefined ? "optional" : "peer";
        this.#edges.push({ from, key, spec, kind, declared, to: nearestCopy(this.packages, from, key) });
      }
    }
  }

  /** Every installed registry copy: neither the root, a workspace, nor a link. */
  copies(): Copy[] {
    return Object.entries(this.packages).flatMap(([path, entry]) => {
      const marker = path.lastIndexOf("node_modules/");
      if (marker === -1 || entry.link === true || entry.version === undefined) {
        return [];
      }
      const installedAs = path.slice(marker + "node_modules/".length);
      return [{ path, name: entry.name ?? installedAs, installedAs, version: entry.version, bundled: entry.inBundle === true }];
    });
  }

  /** The edges that resolve to the copy at `path`. */
  edgesTo(path: string): Edge[] {
    return this.#edges.filter((edge) => edge.to === path);
  }

  /** The edges the root and the workspaces declare. */
  declaredEdges(): Edge[] {
    return this.#edges.filter((edge) => edge.declared);
  }

  /** The package name of the root, a workspace or an installed package at `path`. */
  nameAt(path: string): string | undefined {
    const entry = this.packages[path];
    if (entry === undefined) {
      return undefined;
    }
    if (entry.name !== undefined) {
      return entry.name;
    }
    const marker = path.lastIndexOf("node_modules/");
    return marker === -1 ? undefined : path.slice(marker + "node_modules/".length);
  }
}

/** The lockfile key of the copy of `key` an entry at `from` resolves to, walking up its directories as Node does. */
export function nearestCopy(packages: Readonly<Record<string, unknown>>, from: string, key: string): string | undefined {
  let dir = from;
  for (;;) {
    const candidate = dir === "" ? `node_modules/${key}` : `${dir}/node_modules/${key}`;
    if (packages[candidate] !== undefined) {
      return candidate;
    }
    if (dir === "") {
      return undefined;
    }
    const cut = dir.lastIndexOf("/node_modules/");
    dir = cut !== -1 ? dir.slice(0, cut) : dir.includes("/") && !dir.startsWith("node_modules/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
}

/** The semver range a spec asks for (`npm:lib@^1` → `^1`); undefined when it isn't one (a tag, a URL, a path, git). */
export function rangeOf(spec: string): string | undefined {
  const trimmed = spec.trim();
  const alias = /^npm:(?:@[^/@]+\/)?[^@]+(?:@(.+))?$/.exec(trimmed);
  const range = alias === null ? trimmed : (alias[1] ?? "*");
  return semver.validRange(range) === null ? undefined : range;
}

/**
 * `spec` with its range's base moved to `to`, keeping its style: `^1.2.0` →
 * `^1.4.0`, `~1.2` → `~1.4.0`, `1.2.0` → `1.4.0`, `>=1.2.0` → `>=1.4.0`, an
 * `npm:` alias keeping its target. A range of another shape is kept when it
 * already allows `to` (only the lock moves); otherwise undefined: it can't be
 * rewritten mechanically.
 */
export function rewriteSpec(spec: string, to: string): string | undefined {
  const trimmed = spec.trim();
  const alias = /^(npm:(?:@[^/@]+\/)?[^@]+)(?:@(.+))?$/.exec(trimmed);
  const prefix = alias === null ? "" : `${alias[1]}@`;
  const range = alias === null ? trimmed : alias[2];
  if (range === undefined) {
    return undefined;
  }
  const simple = /^(\^|~|>=|=)?v?\d+(?:\.\d+(?:\.\d+(?:-[0-9A-Za-z.-]+)?)?)?$/.exec(range);
  if (simple !== null) {
    return `${prefix}${simple[1] ?? ""}${to}`;
  }
  return semver.validRange(range) !== null && semver.satisfies(to, range) ? spec : undefined;
}
