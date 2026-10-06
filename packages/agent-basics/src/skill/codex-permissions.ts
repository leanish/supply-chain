// Copied from leanish/leanish-development core/runtime/src/skill/codex-permissions.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: `Access` from `types/access.ts` instead of the agent descriptor.
import { isAbsolute, join, relative, sep } from "node:path";

import type { Access } from "../types/access.ts";

/**
 * The Codex permission profile a run gets, passed with `-c` so nothing comes
 * from a config file. Profiles replace Codex's older `--sandbox` settings (the
 * two don't compose) and are the only way to deny reads.
 *
 * Every run: the whole filesystem readable, minus `readDenied` (with
 * `readAllowed` exceptions inside it) and minus the staged `CODEX_HOME`'s
 * `auth.json` (the linked login, or whatever replaced it). `read-only`: the working copies readable even
 * under a denied path, no writes, no network. `write`: the working copies, the
 * temp dirs and `writableRoots` writable, each one's git metadata (kept outside
 * the working tree) explicitly read-only — the agent edits files, the runtime
 * commits — network on.
 *
 * Rules on the same path resolve deny > write > read; a more specific path
 * overrides a broader one.
 */
export const CODEX_PERMISSION_PROFILE = "agent-runtime";

export interface CodexPermissionRequest {
  readonly access: Access;
  /** Each working copy's git metadata directory (write runs only); read-only even under a writable root such as `/tmp`. */
  readonly gitDirs: ReadonlyArray<string>;
  readonly stagedHome: string;
  /** Absolute; write runs only. */
  readonly writableRoots: ReadonlyArray<string>;
  /** Absolute paths sandboxed commands may not read. */
  readonly readDenied: ReadonlyArray<string>;
  /** Absolute paths inside `readDenied` that stay readable. */
  readonly readAllowed: ReadonlyArray<string>;
}

type TomlValue = string | boolean | ReadonlyArray<readonly [string, TomlValue]>;

export function codexPermissionArgs(request: CodexPermissionRequest): string[] {
  const write = request.access === "write";
  const filesystem: Array<readonly [string, TomlValue]> = [
    [":root", "read"],
    [":workspace_roots", [[".", write ? "write" : "read"]]],
  ];
  if (write) {
    filesystem.push([":tmpdir", "write"], [":slash_tmp", "write"]);
    for (const path of request.writableRoots) filesystem.push([path, "write"]);
    for (const path of request.gitDirs) filesystem.push([path, "read"]);
  }
  for (const path of request.readDenied) filesystem.push([path, "deny"]);
  for (const path of request.readAllowed) filesystem.push([path, "read"]);
  // Only the login file: denying the whole staged home (with its skills as an
  // exception) is shown to the model as policy, and it then won't open them.
  filesystem.push([join(request.stagedHome, "auth.json"), "deny"]);

  const profile = `permissions.${CODEX_PERMISSION_PROFILE}`;
  return [
    "-c",
    `default_permissions="${CODEX_PERMISSION_PROFILE}"`,
    "-c",
    `${profile}.filesystem=${toml(filesystem)}`,
    "-c",
    `${profile}.network.enabled=${write}`,
    "-c",
    'approval_policy="never"',
  ];
}

/**
 * Fails when a path the agent works in sits inside a denied path. Codex's
 * macOS sandbox denies metadata reads on a denied directory too, and tools
 * that resolve real paths through every ancestor break under one — a JVM
 * crashes or can't load its jars, Node can't run scripts — even where the path
 * itself is readable or writable. So working copies, build caches and
 * toolchains belong outside a denied root (Codex also shows the denied paths
 * to the model, which is why a root is denied whole rather than entry by
 * entry).
 */
export function assertOutsideDenied(paths: ReadonlyArray<string>, readDenied: ReadonlyArray<string>, what: string): void {
  for (const path of paths) {
    const denied = readDenied.find((root) => root === path || isInsidePath(path, root));
    if (denied !== undefined) {
      throw new Error(
        `CodexRunner: ${what} ${path} is inside the read-denied ${denied}; tools can't resolve paths under a denied directory — move it outside`,
      );
    }
  }
}

/**
 * Fails at construction on rules that can't mean what they say: relative
 * paths, a path both denied and allowed, or an exception outside every denied
 * path (it would already be readable).
 */
export function validateReadRules(readDenied: ReadonlyArray<string>, readAllowed: ReadonlyArray<string>): void {
  for (const path of [...readDenied, ...readAllowed]) {
    if (!isAbsolute(path)) throw new Error(`CodexRunner: read rule path '${path}' must be absolute`);
  }
  for (const path of readAllowed) {
    if (readDenied.includes(path)) {
      throw new Error(`CodexRunner: '${path}' is both in readDenied and readAllowed`);
    }
    if (!readDenied.some((denied) => isInsidePath(path, denied))) {
      throw new Error(`CodexRunner: readAllowed entry '${path}' isn't inside any readDenied path`);
    }
  }
}

export function assertAbsolute(paths: ReadonlyArray<string>, option: string): void {
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error(`CodexRunner: ${option} entry '${path}' must be absolute`);
  }
}

/** True when `path` is strictly below `parent` (both absolute). */
export function isInsidePath(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/** TOML inline table; JSON string syntax is valid TOML basic-string syntax. */
function toml(entries: ReadonlyArray<readonly [string, TomlValue]>): string {
  return `{${entries.map(([key, value]) => `${JSON.stringify(key)}=${tomlValue(value)}`).join(", ")}}`;
}

function tomlValue(value: TomlValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  return toml(value);
}
