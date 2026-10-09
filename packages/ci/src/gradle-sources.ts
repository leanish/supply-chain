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
 * - a version catalog library: `"g:n:v"`, `{ module = "g:n" }` or `{ group = "g", name = "n" }`.
 * Comments don't count (Kotlin's nested block comments included). Shorthands such as
 * `kotlin("stdlib")` aren't recognised, so such a dependency isn't moved automatically. A match is
 * evidence, not proof: a coordinate named anywhere in a build, or in a catalog entry, counts for
 * the whole build, without checking which configurations it controls.
 *
 * Each build owns its directory, minus the builds nested in it; its `buildSrc` and `build-logic`
 * count as its own, since their convention plugins declare its dependencies.
 */
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
    for (const path of await ownSources(tree, build, builds)) {
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

/** Coordinates in code: quoted `group:name[:version]` literals, and `group`/`name` in one argument list. */
function scriptCoordinates(text: string): string[] {
  const code = withoutComments(text);
  const found: string[] = [];
  for (const match of code.matchAll(/["']([\w.-]+):([\w.-]+)(?::[^"'\s]*)?["']/g)) found.push(`${match[1]}:${match[2]}`);
  for (const match of code.matchAll(GROUP_FIRST)) found.push(`${match[1]}:${match[2]}`);
  for (const match of code.matchAll(NAME_FIRST)) found.push(`${match[2]}:${match[1]}`);
  return found;
}

/** Libraries of a version catalog, one entry per line (TOML inline tables can't span lines). */
function catalogCoordinates(text: string): string[] {
  const found: string[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    const line = withoutHashComment(raw).trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      section = header[1]!.trim();
      continue;
    }
    if (section !== "libraries") continue;
    const value = /^[\w.-]+\s*=\s*(.+)$/.exec(line)?.[1];
    if (value === undefined) continue;
    const literal = /^"([\w.-]+):([\w.-]+)(?::[^"]*)?"$/.exec(value);
    if (literal !== null) {
      found.push(`${literal[1]}:${literal[2]}`);
      continue;
    }
    const module = /\bmodule\s*=\s*"([\w.-]+):([\w.-]+)"/.exec(value);
    if (module !== null) {
      found.push(`${module[1]}:${module[2]}`);
      continue;
    }
    const group = /\bgroup\s*=\s*"([\w.-]+)"/.exec(value)?.[1];
    const name = /\bname\s*=\s*"([\w.-]+)"/.exec(value)?.[1];
    if (group !== undefined && name !== undefined) found.push(`${group}:${name}`);
  }
  return found;
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

function withoutHashComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && line[i - 1] !== "\\") quoted = !quoted;
    else if (line[i] === "#" && !quoted) return line.slice(0, i);
  }
  return line;
}
