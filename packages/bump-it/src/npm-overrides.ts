/** Plain repository overrides constrain targets; scoped or complex rules keep copies at base. */
import semver from "semver";

import { rangeOf } from "./npm-graph.ts";

export interface RepositoryOverrides {
  /** The range a plain top-level override holds `name` to; undefined when none does. */
  readonly rangeFor: (name: string) => string | undefined;
  /** Whether the overrides name `name` in a way bump-it doesn't reason about: selection cannot prove those copies. */
  readonly isComplex: (name: string) => boolean;
  /** Every key at the top level, as written (bump-it's temporary locks must not collide with them). */
  readonly topLevelKeys: ReadonlySet<string>;
}

/** An exact pin after repositoryOverrides has resolved any `$lib` reference. */
export function isExactOverride(spec: string | undefined): boolean {
  if (spec === undefined) {
    return false;
  }
  return semver.valid(rangeOf(spec) ?? "") !== null;
}

/** The overrides of the root `package.json` (parsed). */
export function repositoryOverrides(manifest: unknown): RepositoryOverrides {
  const root = (manifest ?? {}) as { overrides?: unknown; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  const overrides = isObject(root.overrides) ? root.overrides : {};
  const ranges = new Map<string, string>();
  const complex = new Set<string>();
  const own = { ...root.optionalDependencies, ...root.devDependencies, ...root.dependencies };
  const visit = (rules: Record<string, unknown>, nested: boolean) => {
    for (const [key, value] of Object.entries(rules)) {
      if (key === ".") {
        continue;
      }
      const { name, spec } = splitKey(key);
      if (isObject(value)) {
        if ("." in value) {
          complex.add(name);
        }
        visit(value, true);
        continue;
      }
      if (typeof value !== "string" || nested || spec !== undefined) {
        complex.add(name);
        continue;
      }
      // `$lib` means the root's own spec for lib.
      const range = value.startsWith("$") ? own[value.slice(1)] : value;
      if (range === undefined || rangeOf(range) === undefined) {
        complex.add(name);
      } else {
        ranges.set(name, range);
      }
    }
  };
  visit(overrides, false);
  return {
    rangeFor: (name) => (complex.has(name) ? undefined : ranges.get(name)),
    isComplex: (name) => complex.has(name),
    topLevelKeys: new Set(Object.keys(overrides)),
  };
}

/** `lib`, `lib@^1`, `@scope/lib@1.2.3` → name and spec. */
export function splitKey(key: string): { readonly name: string; readonly spec: string | undefined } {
  const at = key.indexOf("@", key.startsWith("@") ? 1 : 0);
  return at === -1 ? { name: key, spec: undefined } : { name: key.slice(0, at), spec: key.slice(at + 1) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
