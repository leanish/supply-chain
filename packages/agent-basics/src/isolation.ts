// Derived from leanish/leanish-development core/runtime/src/runtime/run-local-cli.ts (`localCodexOptions`,
// `SENSITIVE_HOME_PATHS`) at e4f8a1e; see PROVENANCE.md.
// Local changes: every input is explicit (the tool's config) instead of `AGENT_RUNTIME_*` variables; the agent's
// commands get the configured commit identity instead of the developer's global git identity; the release age is
// the repository's, not a fixed 7, with its own npm scopes excluded from it.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { CodexRunnerOptions } from "./skill/codex-runner.ts";

/**
 * Places under the home that commonly hold credentials or private config:
 * keys, cloud, registry and git credentials, the Codex and Claude logins,
 * shell startup files (which often export tokens) and their history.
 */
export const SENSITIVE_HOME_PATHS: ReadonlyArray<string> = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".codex",
  ".claude",
  ".claude.json",
  ".config",
  ".netrc",
  ".npmrc",
  ".gitconfig",
  ".git-credentials",
  ".docker",
  ".kube",
  ".gradle",
  ".m2",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zsh_history",
  ".bashrc",
  ".bash_profile",
  ".bash_history",
  ".profile",
  "Library/Keychains",
];

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface IsolationSettings {
  /** Who the tool's commits are by; the agent's commands get the same identity (they never see the developer's). */
  readonly commitIdentity: GitIdentity;
  /** Absolute paths the agent's commands may not read, on top of the sensitive home paths (private data folders). */
  readonly readDeny: ReadonlyArray<string>;
  /** Absolute directories put first on the PATH of the agent's commands (the guards), and only theirs. */
  readonly commandPath: ReadonlyArray<string>;
  /** The repository's release age, given to npm as `min-release-age`. */
  readonly releaseAgeDays: number;
  /** npm package patterns exempt from it (the repository's own scopes, `@scope/*`), given to npm as `min-release-age-exclude`. */
  readonly releaseAgeExclude: ReadonlyArray<string>;
  /** Where the build tools' caches go instead of `~/.gradle` and the like. */
  readonly buildCacheRoot: string;
}

/** What `codexIsolation` reads from the machine; each defaults to the real one. */
export interface Machine {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly exists: (path: string) => boolean;
}

/**
 * Codex runs for a tool:
 *   - reuse the developer's file-backed `codex login` (`$CODEX_HOME`, else
 *     `~/.codex`) — the CLI reads it, sandboxed commands can't;
 *   - deny sandboxed commands the sensitive home paths above that exist, plus
 *     `readDeny`: anything they read reaches the model provider, and a write
 *     run has the network. Codex shows the denied paths to the model, so their
 *     names (never their contents) are visible to it; the rest of the home
 *     stays readable, and so do toolchains and working copies under it;
 *   - replace the home's git and npm config (denied above, and able to hold
 *     credentials) with env: the configured commit identity, npm's
 *     `ignore-scripts`, the repository's `min-release-age` and its own
 *     packages' `min-release-age-exclude` (npm 11.17 or later reads it);
 *   - put `commandPath` (the guards) first on the PATH of the agent's
 *     commands — only theirs: the tool's own clone and push keep the real
 *     tools;
 *   - give the agent a dedicated build-tool cache instead of `~/.gradle`,
 *     whose init scripts every later build would run.
 */
export function codexIsolation(settings: IsolationSettings, machine: Partial<Machine> = {}): CodexRunnerOptions {
  const { env = process.env, home = homedir(), exists = existsSync } = machine;
  const relative = [...settings.commandPath, ...settings.readDeny, settings.buildCacheRoot].filter((path) => !isAbsolute(path));
  if (relative.length > 0) throw new Error(`isolation paths must be absolute; got '${relative.join("', '")}'`);
  if (!Number.isInteger(settings.releaseAgeDays) || settings.releaseAgeDays < 0) {
    throw new Error(`releaseAgeDays must be a non-negative integer; got ${settings.releaseAgeDays}`);
  }
  // npm splits the variable on commas.
  const exclude = settings.releaseAgeExclude.find((pattern) => pattern.trim() === "" || pattern.includes(","));
  if (exclude !== undefined) throw new Error(`releaseAgeExclude patterns must be non-empty and have no comma; got '${exclude}'`);
  const readDenied = [...SENSITIVE_HOME_PATHS.map((path) => join(home, path)).filter(exists), ...settings.readDeny];
  const path = nonEmpty(env["PATH"]);
  const commandPath = settings.commandPath.join(":");
  const { name, email } = settings.commitIdentity;
  return {
    loginHome: nonEmpty(env["CODEX_HOME"]) ?? join(home, ".codex"),
    buildCacheRoot: settings.buildCacheRoot,
    readDenied: [...new Set(readDenied)],
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      // git's default excludes file lives under ~/.config too.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.excludesFile",
      GIT_CONFIG_VALUE_0: "/dev/null",
      npm_config_userconfig: "/dev/null",
      npm_config_ignore_scripts: "true",
      npm_config_min_release_age: String(settings.releaseAgeDays),
      ...(settings.releaseAgeExclude.length > 0 ? { npm_config_min_release_age_exclude: settings.releaseAgeExclude.join(",") } : {}),
      ...(commandPath !== "" ? { PATH: path !== undefined ? `${commandPath}:${path}` : commandPath } : {}),
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    },
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
