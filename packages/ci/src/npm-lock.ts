/**
 * npm lockfiles (v2/v3 `packages` map): what's installed, where, from which
 * source, and which bundles the lockfile doesn't fully record.
 *
 * Ported from leanish-development `tools/supply-chain/src/supply-chain.ts`
 * (commit 9e7d098); `sourceProblems` now takes the allowed registries.
 */

export const NPM_REGISTRY = "https://registry.npmjs.org";

export interface LockedPackage {
  readonly name: string;
  readonly version: string;
  /** Lockfile key, e.g. `node_modules/a/node_modules/b`. */
  readonly path: string;
  readonly resolved: string | undefined;
  /** Shipped inside an ancestor's tarball (`inBundle`): no source of its own, the ancestor's is checked. */
  readonly bundled: boolean;
  /** Subresource integrity of the locked tarball, e.g. `sha512-…`. */
  readonly integrity: string | undefined;
}

/** The fields of a lockfile `packages` entry the gate reads. */
interface LockEntry {
  readonly name?: string;
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly link?: boolean;
  readonly inBundle?: boolean;
  readonly dependencies?: Record<string, string>;
  readonly bundleDependencies?: ReadonlyArray<string> | boolean;
  readonly bundledDependencies?: ReadonlyArray<string> | boolean;
}

/** Packages from an npm lockfile (v2/v3 `packages` map); workspace links and the root are skipped. */
export function lockedPackages(lock: unknown): LockedPackage[] {
  const { lockfileVersion, packages } = (lock ?? {}) as { lockfileVersion?: number; packages?: unknown };
  if ((lockfileVersion !== 2 && lockfileVersion !== 3) || !isPlainObject(packages)) {
    throw new Error("package-lock.json must be lockfileVersion 2 or 3 with a `packages` map");
  }
  for (const [path, entry] of Object.entries(packages)) {
    if (!isPlainObject(entry)) throw new Error(`lockfile entry ${path || "(root)"} isn't an object`);
  }
  const entries = packages as Record<string, LockEntry>;
  return Object.entries(entries).flatMap(([path, entry]) => {
    const marker = path.lastIndexOf("node_modules/");
    if (marker === -1 || entry.link === true) return [];
    if (entry.version === undefined) throw new Error(`lockfile entry ${path} has no version`);
    // An npm alias (`"x": "npm:y@1"`) is installed under the alias; its entry names the real package.
    const name = entry.name ?? path.slice(marker + "node_modules/".length);
    const bundled = entry.inBundle === true;
    if (bundled) bundlingAncestor(entries, path);
    return [{ name, version: entry.version, path, resolved: entry.resolved, bundled, integrity: entry.integrity }];
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The nearest ancestor of a bundled entry that isn't bundled itself: a locked
 * package (so its source and age are checked) whose tarball ships the entry.
 * A workspace, a workspace link, the root or a missing ancestor can't vouch for it.
 */
function bundlingAncestor(packages: Record<string, { inBundle?: boolean; link?: boolean }>, path: string): string {
  let current = path;
  for (;;) {
    const cut = current.lastIndexOf("/node_modules/");
    const parent = cut === -1 ? undefined : current.slice(0, cut);
    const entry = parent === undefined ? undefined : packages[parent];
    if (parent === undefined || !parent.includes("node_modules/") || entry === undefined || entry.link === true) {
      throw new Error(`lockfile entry ${path} is marked inBundle but no locked package ships it`);
    }
    if (entry.inBundle !== true) return parent;
    current = parent;
  }
}

/**
 * Bundles the lockfile doesn't fully record. A package's tarball ships its
 * `bundleDependencies` and everything they depend on, and each of those must
 * have an `inBundle` entry inside that package: a missing one is code that
 * ships without being scanned (npm can leave them out, e.g. a lockfile written
 * with `--package-lock-only`, which never unpacks the tarball). Optional
 * dependencies may be absent; workspaces and links don't ship bundles.
 */
export function bundleProblems(lock: unknown): string[] {
  const { packages } = lock as { packages: Record<string, LockEntry> };
  const problems = new Set<string>();
  for (const [root, entry] of Object.entries(packages)) {
    const declared = entry.bundleDependencies ?? entry.bundledDependencies;
    if (!root.includes("node_modules/") || entry.link === true || declared === undefined || declared === false) continue;
    const names = declared === true ? Object.keys(entry.dependencies ?? {}) : declared;
    const reached = new Set<string>();
    const queue = names.map((name) => ({ from: root, name }));
    while (queue.length > 0) {
      const { from, name } = queue.shift()!;
      const found = bundledEntry(packages, root, from, name);
      if (found === undefined) {
        problems.add(`${root} ships ${name} (needed by ${from}), but the lockfile has no inBundle entry for it there`);
        continue;
      }
      if (reached.has(found)) continue;
      reached.add(found);
      for (const dependency of Object.keys(packages[found]!.dependencies ?? {})) queue.push({ from: found, name: dependency });
    }
  }
  return [...problems];
}

/** Where Node would find `name` from `from`, looking only inside the bundle under `root`. */
function bundledEntry(packages: Record<string, LockEntry>, root: string, from: string, name: string): string | undefined {
  let dir = from;
  for (;;) {
    const candidate = `${dir}/node_modules/${name}`;
    if (packages[candidate]?.inBundle === true) return candidate;
    if (dir === root) return undefined;
    const cut = dir.lastIndexOf("/node_modules/");
    if (cut < root.length) return undefined;
    dir = dir.slice(0, cut);
  }
}

/** Locked packages that don't come from an allowed registry (git, tarball URLs, local files, other registries). */
export function sourceProblems(packages: ReadonlyArray<LockedPackage>, registries: ReadonlyArray<string> = [NPM_REGISTRY]): string[] {
  return packages
    .filter((pkg) => !pkg.bundled && !fromRegistry(pkg, registries))
    .map(
      (pkg) =>
        `${pkg.name}@${pkg.version} (${pkg.path}) doesn't come from an allowed registry: ${pkg.resolved ?? "no resolved URL"}`,
    );
}

export function fromRegistry(pkg: LockedPackage, registries: ReadonlyArray<string>): boolean {
  return pkg.resolved !== undefined && registries.some((registry) => pkg.resolved!.startsWith(`${registry}/`));
}

/** Packages in `head` that are new or at a different version than in `base`. */
export function changedPackages(
  base: ReadonlyArray<LockedPackage>,
  head: ReadonlyArray<LockedPackage>,
): LockedPackage[] {
  const before = new Map(base.map((pkg) => [pkg.path, `${pkg.name}@${pkg.version}`]));
  return head.filter((pkg) => before.get(pkg.path) !== `${pkg.name}@${pkg.version}`);
}

/** A dependency a lockfile's root or one of its workspaces declares, with the version installed for it. */
export interface DirectDependency {
  /** The registry package's name (an `npm:` alias's target). */
  readonly name: string;
  /** The key it's declared under: `name`, or the alias (`"compat": "npm:lib@^1"` → `compat`). */
  readonly declaredAs: string;
  /** The declared range, as written: `^1.2.0`, `npm:lib@^1`. */
  readonly spec: string;
  /** The workspace that declares it (`""` for the root). */
  readonly workspace: string;
  /** Lockfile key of the installed copy that workspace uses. */
  readonly path: string;
  readonly version: string;
}

/**
 * The registry dependencies the root and every workspace declare
 * (`dependencies`, `devDependencies`, `optionalDependencies`), each with the
 * copy Node resolves for it: the nearest `node_modules` walking up from the
 * workspace, as npm installs them (a nested workspace may use its parent
 * workspace's copy). `npm:` aliases count, under their target's name. Specs
 * that aren't registry ranges (`file:`, `workspace:`, git, URLs, paths) and
 * optional dependencies that aren't installed are left out.
 */
export function directDependencies(lock: unknown): DirectDependency[] {
  const { packages } = (lock ?? {}) as { packages?: Record<string, LockEntry & DeclaringEntry> };
  if (!isPlainObject(packages)) throw new Error("package-lock.json has no `packages` map");
  const found: DirectDependency[] = [];
  for (const [workspace, entry] of Object.entries(packages)) {
    if (workspace.includes("node_modules/") || entry.link === true) continue;
    const declared = { ...entry.optionalDependencies, ...entry.devDependencies, ...entry.dependencies };
    for (const [declaredAs, spec] of Object.entries(declared)) {
      const alias = /^npm:((?:@[^/@]+\/)?[^@]+)@(.+)$/.exec(spec.trim());
      if (alias === null && !isRegistryRange(spec)) continue;
      if (alias !== null && !isRegistryRange(alias[2]!)) continue;
      const path = installedFor(packages, workspace, declaredAs);
      const installed = path === undefined ? undefined : packages[path];
      if (path === undefined || installed?.version === undefined || installed.link === true) continue;
      found.push({ name: installed.name ?? alias?.[1] ?? declaredAs, declaredAs, spec, workspace, path, version: installed.version });
    }
  }
  return found;
}

/** The lockfile key of `key` as seen from `workspace`: its own `node_modules`, then each ancestor's, then the root's. */
function installedFor(packages: Record<string, unknown>, workspace: string, key: string): string | undefined {
  const parts = workspace === "" ? [] : workspace.split("/");
  for (let depth = parts.length; depth >= 0; depth--) {
    const dir = parts.slice(0, depth).join("/");
    const path = dir === "" ? `node_modules/${key}` : `${dir}/node_modules/${key}`;
    if (packages[path] !== undefined) return path;
  }
  return undefined;
}

interface DeclaringEntry {
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

/** A range or dist-tag the registry resolves: no protocol (`file:`, `npm:`, `git+…`), no URL, no path, no `owner/repo`. */
function isRegistryRange(spec: string): boolean {
  const trimmed = spec.trim();
  // `~1.2` and `^1` are ranges; `~/dir` and `./dir` are paths.
  if (/^[\^~<>=\d\s.xX*|-]+$/.test(trimmed)) return true;
  return !/^[a-z+]+:/i.test(trimmed) && !/^[./~]/.test(trimmed) && !trimmed.includes("/");
}
