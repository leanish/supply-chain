/**
 * Source evidence that a repository's Gradle builds declare a dependency themselves, for automatic updates.
 *
 * The inventory records `allDependencies`, which includes what plugins add (the Kotlin DSL
 * plugin's embedded Kotlin, for one): Gradle can't tell who added a dependency. A bump moves a
 * declaration, so it needs one in the repository's files. The evidence is deliberately coarse and
 * errs toward "named": comments count, and a coordinate named anywhere in the repository counts
 * for every build. A false "named" only plans a move bump-it may fail to make, visibly; a false
 * "unnamed" would skip an update and widen verification's plugin-driven exemption.
 *
 * Files read: every `*.gradle`, `*.gradle.kts` and `*.toml`, and the code under `buildSrc/` and
 * `build-logic/` (convention plugins), anywhere in the repository. In each, as raw text:
 * - a library `group:name` is named by a quoted string starting with it (`"g:n"`, `"g:n:1.0"`,
 *   `"g:n:${v ?: d}"`), or by `group` and `name` both quoted whole in one file
 *   (`group = "g", name = "n"`);
 * - a plugin, which resolves as its marker `id:id.gradle.plugin`, is named by its id quoted whole
 *   (`id("x")`, `apply(plugin = "x")`) or before a `:` (`"x:1.0"` in a catalog).
 * A TOML file is also parsed as a version catalog, so escaped strings count there too.
 */
import { parse } from "smol-toml";

import type { Tree } from "./tree.ts";

export interface GradleSourceIndex {
  /** Whether the repository's Gradle sources name `group:name`. */
  named(group: string, name: string): boolean;
}

const BUILD_FILE = /(?:^|\/)[^/]*(?:\.gradle|\.gradle\.kts|\.toml)$/;
const CONVENTION_CODE = /(?:^|\/)(?:buildSrc|build-logic)\/(?:.*\/)?[^/]*\.(?:kt|kts|java|groovy)$/;
const PLUGIN_MARKER = /^([^:]+):\1\.gradle\.plugin$/;

export async function gradleSourceIndex(tree: Tree): Promise<GradleSourceIndex> {
  const texts: string[] = [];
  const catalogued = new Set<string>();
  for (const path of await tree.list(".")) {
    if (!BUILD_FILE.test(path) && !CONVENTION_CODE.test(path)) continue;
    const text = await tree.read(path);
    if (text === undefined) throw new Error(`${path} disappeared while reading it`);
    texts.push(text);
    if (path.endsWith(".toml")) for (const coordinate of catalogCoordinates(text)) catalogued.add(coordinate);
  }
  return {
    named(group, name) {
      if (catalogued.has(`${group}:${name}`)) return true;
      const plugin = PLUGIN_MARKER.exec(`${group}:${name}`)?.[1];
      // Searched in the raw text, without pairing quotes: a stray apostrophe can't hide a match.
      const quoted = new RegExp(`["']${escaped(plugin ?? `${group}:${name}`)}["':]`);
      const whole = (value: string) => new RegExp(`["']${escaped(value)}["']`);
      return texts.some((text) => quoted.test(text) || plugin === undefined && whole(group).test(text) && whole(name).test(text));
    },
  };
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Libraries and plugins of a version catalog: a library's `"g:n:v"`, `module` or `group`/`name`; a plugin's `"id:v"` or `id`. */
function catalogCoordinates(text: string): string[] {
  let catalog: Record<string, unknown>;
  try {
    catalog = parse(text);
  } catch {
    // Not TOML (or Gradle can't load it either): the raw-text evidence still applies.
    return [];
  }
  const found: string[] = [];
  for (const entry of Object.values(tableOf(catalog["libraries"]))) {
    const fields = tableOf(entry);
    const group = textOf(fields["group"]);
    const name = textOf(fields["name"]);
    const coordinate = textOf(entry) ?? textOf(fields["module"]) ?? (group !== undefined && name !== undefined ? `${group}:${name}` : undefined);
    const parts = /^([^:]+):([^:]+)(?::.*)?$/.exec(coordinate ?? "");
    if (parts !== null) found.push(`${parts[1]}:${parts[2]}`);
  }
  for (const entry of Object.values(tableOf(catalog["plugins"]))) {
    const id = textOf(entry)?.split(":")[0] ?? textOf(tableOf(entry)["id"]);
    if (id !== undefined && id !== "") found.push(`${id}:${id}.gradle.plugin`);
  }
  return found;
}

function tableOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
