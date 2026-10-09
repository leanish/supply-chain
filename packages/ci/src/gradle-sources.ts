/**
 * Source evidence that a Gradle build declares a dependency itself, for automatic updates.
 *
 * The inventory records `allDependencies`, which includes what plugins add (the Kotlin DSL
 * plugin's embedded Kotlin, for one): Gradle can't tell who added a dependency. A bump moves a
 * declaration, so it needs one in the build's own files. This index looks for the coordinate
 * where builds write it, with bounded notation:
 * - a string literal `"group:name"` or `"group:name:version"` in a build script or in
 *   `buildSrc`/`build-logic` code (`implementation("g:n:1.0")`, `dependencies.add(.., "g:n:1.0")`);
 * - `group = "g", name = "n"` (or `group: 'g', name: 'n'`, either order, other named arguments
 *   between them) in one argument list;
 * - a version catalog library (read with a TOML parser): `"g:n:v"`, `{ module = "g:n" }` or
 *   `{ group = "g", name = "n" }`, in any TOML form;
 * - a plugin, which resolves as its marker `id:id.gradle.plugin`: `id("x")`/`id 'x'` in a script, or
 *   a catalog plugin, `"x:v"` or `{ id = "x" }`.
 * Comments don't count (Kotlin's nested block comments included). Shorthands such as
 * `kotlin("stdlib")` aren't recognised, so such a dependency isn't moved automatically. A match is
 * evidence, not proof: a coordinate named anywhere in a build, or in a catalog entry, counts for
 * the whole build, without checking which configurations it controls.
 *
 * Each build owns its directory, minus the builds nested in it; its `buildSrc` and `build-logic`
 * count as its own, since their convention plugins declare its dependencies. A catalog its settings
 * import by path (`from(files("../gradle/libs.versions.toml"))`) counts too, wherever it lives.
 */
import { posix } from "node:path";

import { parse } from "smol-toml";

import type { Tree } from "./tree.ts";

export interface GradleSourceIndex {
  /** Whether the build at `build` (`.` for the root) names `group:name` in its own sources. */
  named(build: string, group: string, name: string): boolean;
}

const CONVENTION_BUILDS = ["buildSrc", "build-logic"];
const SKIPPED_SEGMENTS = new Set(["build", ".gradle", "node_modules", "out", ".git"]);
const CODE = /\.(?:kt|kts|java|groovy|gradle)$/;

export async function gradleSourceIndex(tree: Tree, builds: ReadonlyArray<string>): Promise<GradleSourceIndex> {
  const coordinates = new Map<string, Set<string>>();
  for (const build of builds) {
    const found = new Set<string>();
    for (const path of [...await ownSources(tree, build, builds), ...await importedCatalogs(tree, build)]) {
      const text = await tree.read(path);
      if (text === undefined) throw new Error(`${path} disappeared while reading it`);
      for (const coordinate of path.endsWith(".toml") ? catalogCoordinates(path, text) : scriptCoordinates(text)) found.add(coordinate);
    }
    coordinates.set(build, found);
  }
  return {
    named(build, group, name) {
      const found = coordinates.get(build);
      if (found === undefined) throw new Error(`no source index for the Gradle build ${build}`);
      return found.has(`${group}:${name}`);
    },
  };
}

/** The build's scripts and catalogs, and its convention builds' scripts, catalogs and main code. */
async function ownSources(tree: Tree, build: string, builds: ReadonlyArray<string>): Promise<string[]> {
  const prefix = build === "." ? "" : `${build}/`;
  const conventions = CONVENTION_BUILDS.map((dir) => `${prefix}${dir}/`);
  const isConvention = (dir: string) => conventions.some((convention) => dir.startsWith(convention));
  const nested = builds.filter((other) => other !== build && (build === "." || other.startsWith(prefix)))
    .map((other) => `${other}/`).filter((dir) => !isConvention(dir));
  return (await tree.list(build)).filter((path) => {
    if (nested.some((dir) => path.startsWith(dir))) return false;
    const convention = conventions.find((dir) => path.startsWith(dir));
    const relative = path.slice((convention ?? prefix).length);
    const segments = relative.split("/");
    if (segments.slice(0, -1).some((segment) => SKIPPED_SEGMENTS.has(segment))) return false;
    if (/^gradle\/[^/]+\.versions\.toml$/.test(relative)) return true;
    // In a convention build, its main code declares the build's dependencies too.
    if (convention !== undefined && CODE.test(relative) && /(?:^|\/)src\/main\//.test(relative)) return true;
    // Scripts outside `src/`: precompiled script plugins there are what a build ships, not how it builds.
    return /\.gradle(?:\.kts)?$/.test(relative) && !segments.includes("src");
  });
}

// One named argument, `key = "value"` or `key: 'value'`, and the separator before the next.
const ARGUMENT = String.raw`\w+\s*[=:]\s*["'][^"'\n]*["']\s*,\s*`;
const GROUP_FIRST = new RegExp(String.raw`\bgroup\s*[=:]\s*["']([\w.-]+)["']\s*,\s*(?:${ARGUMENT})*name\s*[=:]\s*["']([\w.-]+)["']`, "g");
const NAME_FIRST = new RegExp(String.raw`\bname\s*[=:]\s*["']([\w.-]+)["']\s*,\s*(?:${ARGUMENT})*group\s*[=:]\s*["']([\w.-]+)["']`, "g");

/** Catalogs the build's settings import from a file, resolved from the build's directory. */
async function importedCatalogs(tree: Tree, build: string): Promise<string[]> {
  const found: string[] = [];
  for (const settings of ["settings.gradle", "settings.gradle.kts"].map((file) => posix.join(build, file))) {
    const text = await tree.read(settings);
    if (text === undefined) continue;
    for (const match of withoutComments(text).matchAll(/\bfrom\s*\(?\s*files\s*\(\s*["']([^"']+\.toml)["']\s*\)/g)) {
      // One outside the repository can't be read: its entries just don't count.
      if (posix.isAbsolute(match[1]!)) continue;
      const path = posix.normalize(posix.join(build, match[1]!));
      if (path.startsWith("../") || path === "..") continue;
      if (await tree.read(path) !== undefined) found.push(path);
    }
  }
  return found;
}

/** Coordinates in code: quoted `group:name[:version]` literals, and `group`/`name` in one argument list. */
function scriptCoordinates(text: string): string[] {
  const code = withoutComments(text);
  const found: string[] = [];
  for (const match of code.matchAll(/["']([\w.-]+):([\w.-]+)(?::[^"'\s]*)?["']/g)) found.push(`${match[1]}:${match[2]}`);
  for (const match of code.matchAll(GROUP_FIRST)) found.push(`${match[1]}:${match[2]}`);
  for (const match of code.matchAll(NAME_FIRST)) found.push(`${match[2]}:${match[1]}`);
  for (const match of code.matchAll(/\bid\s*\(?\s*["']([\w.-]+)["']/g)) found.push(pluginMarker(match[1]!));
  return found;
}

/** Gradle resolves a plugin id through its marker artifact. */
function pluginMarker(id: string): string {
  return `${id}:${id}.gradle.plugin`;
}

/** Libraries and plugins of a version catalog: a library's `"g:n:v"`, `module` or `group`/`name`; a plugin's `"id:v"` or `id`. */
function catalogCoordinates(path: string, text: string): string[] {
  let catalog: Record<string, unknown>;
  try {
    catalog = parse(text);
  } catch (error) {
    // Gradle can't read it either; a dependency it declares can't be told apart from a plugin's.
    throw new Error(`${path} isn't a readable version catalog: ${error instanceof Error ? error.message : String(error)}`);
  }
  const found: string[] = [];
  for (const entry of Object.values(tableOf(catalog["libraries"]))) {
    const fields = tableOf(entry);
    const group = textOf(fields["group"]);
    const name = textOf(fields["name"]);
    const coordinate = textOf(entry) ?? textOf(fields["module"]) ?? (group !== undefined && name !== undefined ? `${group}:${name}` : undefined);
    const parts = /^([\w.-]+):([\w.-]+)(?::.*)?$/.exec(coordinate ?? "");
    if (parts !== null) found.push(`${parts[1]}:${parts[2]}`);
  }
  for (const entry of Object.values(tableOf(catalog["plugins"]))) {
    const id = textOf(entry)?.split(":")[0] ?? textOf(tableOf(entry)["id"]);
    if (id !== undefined && /^[\w.-]+$/.test(id)) found.push(pluginMarker(id));
  }
  return found;
}

function tableOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Drops `//` and `/* *\/` comments outside string literals, keeping line breaks. */
function withoutComments(text: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote !== undefined) {
      out += char;
      if (char === "\\") out += text[++i] ?? "";
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && text[i + 1] === "*") {
      // Kotlin block comments nest; Groovy and Java ones can't contain `/*` that matters here.
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === "/" && text[i + 1] === "*") { depth++; i++; } else if (text[i] === "*" && text[i + 1] === "/") { depth--; i++; } else if (text[i] === "\n") out += "\n";
        if (depth === 0) break;
      }
    } else out += char;
  }
  return out;
}

