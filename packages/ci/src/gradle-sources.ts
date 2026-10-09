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
 * - a version catalog library: `"g:n:v"`, `{ module = "g:n" }` or `{ group = "g", name = "n" }`;
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
      for (const coordinate of path.endsWith(".toml") ? catalogCoordinates(text) : scriptCoordinates(text)) found.add(coordinate);
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

/** Libraries and plugins of a version catalog, from its string values (see `catalogStrings`). */
function catalogCoordinates(text: string): string[] {
  const entries = new Map<string, Map<string, string>>();
  for (const [path, value] of catalogStrings(text)) {
    const [section, alias, ...field] = path;
    if ((section !== "libraries" && section !== "plugins") || alias === undefined) continue;
    const key = `${section}\0${alias}`;
    if (!entries.has(key)) entries.set(key, new Map());
    entries.get(key)!.set(field.join("."), value);
  }
  const found: string[] = [];
  for (const [key, fields] of entries) {
    const literal = fields.get("");
    if (key.startsWith("plugins\0")) {
      const id = literal === undefined ? fields.get("id") : /^([\w.-]+):/.exec(literal)?.[1];
      if (id !== undefined && /^[\w.-]+$/.test(id)) found.push(pluginMarker(id));
      continue;
    }
    const coordinate = literal ?? fields.get("module") ?? (fields.has("group") && fields.has("name") ? `${fields.get("group")}:${fields.get("name")}` : undefined);
    const parts = /^([\w.-]+):([\w.-]+)(?::.*)?$/.exec(coordinate ?? "");
    if (parts !== null) found.push(`${parts[1]}:${parts[2]}`);
  }
  return found;
}

/**
 * Every string value of a TOML document with its key path, inline tables flattened: the subset version
 * catalogs use (tables, dotted and quoted keys, basic and literal strings, nested inline tables). Lines it
 * can't read (multi-line arrays or strings, which catalogs keep to `[bundles]`) are skipped.
 */
function catalogStrings(text: string): Array<[string[], string]> {
  const found: Array<[string[], string]> = [];
  let table: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[[")) {
      table = ["\0array"];
      continue;
    }
    if (line.startsWith("[")) {
      const header = readKey(line, 1);
      table = header !== undefined && line.slice(header.end).trim().startsWith("]") ? header.parts : ["\0unreadable"];
      continue;
    }
    readPair(line, 0, table, found);
  }
  return found;
}

/** `key = value` at `pos`, recording string values under `prefix`; returns where it ended, or undefined. */
function readPair(text: string, pos: number, prefix: string[], found: Array<[string[], string]>): number | undefined {
  const key = readKey(text, pos);
  if (key === undefined) return undefined;
  let at = skipSpace(text, key.end);
  if (text[at] !== "=") return undefined;
  at = skipSpace(text, at + 1);
  const path = [...prefix, ...key.parts];
  const string = readString(text, at);
  if (string !== undefined) {
    found.push([path, string.value]);
    return string.end;
  }
  if (text[at] === "{") {
    at = skipSpace(text, at + 1);
    while (text[at] !== "}") {
      const next = readPair(text, at, path, found);
      if (next === undefined) return undefined;
      at = skipSpace(text, next);
      if (text[at] === ",") at = skipSpace(text, at + 1);
      else if (text[at] !== "}") return undefined;
    }
    return at + 1;
  }
  if (text[at] === "[") return skipArray(text, at);
  // Numbers and booleans: nothing a coordinate lives in.
  const rest = /^[^,}#]*/.exec(text.slice(at))![0];
  return at + rest.length;
}

/** Past a one-line array (`reject = ["1.1", "1.2"]`), strings and nested arrays included; undefined if it doesn't close. */
function skipArray(text: string, pos: number): number | undefined {
  let depth = 0;
  for (let at = pos; at < text.length; at++) {
    const string = readString(text, at);
    if (string !== undefined) {
      at = string.end - 1;
      continue;
    }
    if (text[at] === "[") depth++;
    else if (text[at] === "]" && --depth === 0) return at + 1;
  }
  return undefined;
}

/** A dotted key of bare and quoted parts. */
function readKey(text: string, pos: number): { parts: string[]; end: number } | undefined {
  const parts: string[] = [];
  let at = skipSpace(text, pos);
  for (;;) {
    const quoted = readString(text, at);
    const bare = quoted === undefined ? /^[\w-]+/.exec(text.slice(at))?.[0] : undefined;
    if (quoted === undefined && bare === undefined) return undefined;
    parts.push(quoted?.value ?? bare!);
    at = skipSpace(text, quoted?.end ?? at + bare!.length);
    if (text[at] !== ".") return { parts, end: at };
    at = skipSpace(text, at + 1);
  }
}

/** A one-line basic (`"..."`) or literal (`'...'`) string. A basic string's escapes keep their character (`\\u` escapes aren't decoded: coordinates never need them). */
function readString(text: string, pos: number): { value: string; end: number } | undefined {
  const quote = text[pos];
  if (quote !== '"' && quote !== "'") return undefined;
  let value = "";
  for (let at = pos + 1; at < text.length; at++) {
    const char = text[at]!;
    if (char === quote) return { value, end: at + 1 };
    if (char === "\\" && quote === '"') value += text[++at] ?? "";
    else value += char;
  }
  return undefined;
}

function skipSpace(text: string, pos: number): number {
  while (text[pos] === " " || text[pos] === "\t") pos++;
  return pos;
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

