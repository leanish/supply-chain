/**
 * Temporary manifests that make npm lock each copy at exactly its target
 * (design items 9 and 26): bump-it writes them, runs `npm install
 * --package-lock-only`, writes the planned manifests back and installs again;
 * npm keeps a locked version that satisfies the ranges, so the lockfile keeps
 * the targets, which the caller then checks.
 *
 *   - a copy the root or a workspace declares: that declaration's spec set to
 *     exactly the target (an `npm:` alias keeps its target package);
 *   - a package with the repository's plain override: that override set to
 *     exactly the target;
 *   - any other copy: an override keyed by its current version
 *     (`lib@1.9.3` → `1.9.1`), which only edges whose range includes that
 *     version follow; nested under the package that holds the copy when a
 *     top-level key would also catch the root's own declaration (npm refuses
 *     to override those), or would need two targets.
 */
import semver from "semver";

import type { Copy, NpmGraph } from "./npm-graph.ts";
import type { RepositoryOverrides } from "./npm-overrides.ts";

export interface Pin {
  readonly copy: Copy;
  readonly target: string;
}

type Manifest = Record<string, unknown>;

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/**
 * The manifests (by declaring path: `""` for the root, a workspace's
 * directory) with the temporary pins applied; only the ones that changed.
 */
export function pinnedManifests(graph: NpmGraph, pins: ReadonlyArray<Pin>, manifests: ReadonlyMap<string, Manifest>, overrides: RepositoryOverrides): Map<string, Manifest> {
  const changed = new Map<string, Manifest>();
  const edit = (path: string): Manifest => {
    const existing = changed.get(path);
    if (existing !== undefined) return existing;
    const original = manifests.get(path);
    if (original === undefined) throw new Error(`no package.json for ${path === "" ? "the root" : path}`);
    const copy = structuredClone(original);
    changed.set(path, copy);
    return copy;
  };
  const rootOverrides = (): Record<string, unknown> => {
    const root = edit("");
    const current = root["overrides"];
    if (current === undefined) root["overrides"] = {};
    else if (typeof current !== "object" || current === null || Array.isArray(current)) throw new Error("the root package.json's overrides isn't an object");
    return root["overrides"] as Record<string, unknown>;
  };

  const transitive: Pin[] = [];
  for (const pin of pins) {
    const declared = graph.edgesTo(pin.copy.path).filter((edge) => edge.declared);
    if (declared.length > 0) {
      for (const edge of declared) setDeclared(edit(edge.from), edge.key, exactSpec(pin), pin.copy.path);
      continue;
    }
    if (overrides.rangeFor(pin.copy.name) !== undefined) {
      rootOverrides()[pin.copy.name] = exactSpec(pin);
      continue;
    }
    transitive.push(pin);
  }

  const rootDeclares = (key: string) => graph.declaredEdges().filter((edge) => edge.from === "" && edge.key === key);
  const keyOf = (pin: Pin) => `${pin.copy.installedAs}@${pin.copy.version}`;
  const targetsByKey = new Map<string, Set<string>>();
  for (const pin of transitive) targetsByKey.set(keyOf(pin), new Set([...(targetsByKey.get(keyOf(pin)) ?? []), exactSpec(pin)]));
  for (const pin of transitive) {
    const key = keyOf(pin);
    const clashes =
      (targetsByKey.get(key)?.size ?? 0) > 1 ||
      overrides.topLevelKeys.has(key) ||
      rootDeclares(pin.copy.installedAs).some((edge) => {
        const range = /^npm:/.test(edge.spec) ? edge.spec.slice(edge.spec.lastIndexOf("@") + 1) : edge.spec;
        return semver.validRange(range) === null || semver.intersects(range, pin.copy.version);
      });
    if (!clashes) {
      rootOverrides()[key] = exactSpec(pin);
      continue;
    }
    const cut = pin.copy.path.lastIndexOf("/node_modules/");
    const owner = cut === -1 ? undefined : graph.nameAt(pin.copy.path.slice(0, cut));
    if (owner === undefined) throw new Error(`can't lock ${pin.copy.name} at ${pin.copy.path} to ${pin.target}: an override would also catch the root's own declaration of it`);
    if (overrides.topLevelKeys.has(owner)) {
      throw new Error(`can't lock ${pin.copy.name} at ${pin.copy.path} to ${pin.target}: the overrides already have a rule for ${owner}`);
    }
    const scope = (rootOverrides()[owner] ??= {}) as Record<string, unknown>;
    if (scope[key] !== undefined && scope[key] !== exactSpec(pin)) throw new Error(`can't lock two copies of ${pin.copy.name} under ${owner} to different targets in one pass`);
    scope[key] = exactSpec(pin);
  }
  return changed;
}

/** The exact spec that installs the target: the version, or `npm:<name>@<version>` for an alias. */
function exactSpec(pin: Pin): string {
  return pin.copy.installedAs === pin.copy.name ? pin.target : `npm:${pin.copy.name}@${pin.target}`;
}

function setDeclared(manifest: Manifest, key: string, spec: string, path: string): void {
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (typeof deps === "object" && deps !== null && key in deps) (deps as Record<string, string>)[key] = spec;
  }
  if (!DEPENDENCY_FIELDS.some((field) => typeof manifest[field] === "object" && manifest[field] !== null && key in (manifest[field] as object))) {
    throw new Error(`the lockfile says ${key} at ${path} is declared, but its package.json doesn't declare it`);
  }
}
