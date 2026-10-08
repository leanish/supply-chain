// Derived from leanish/leanish-development core/runtime/src/runtime/run-local-cli.ts (`localCodexOptions`,
// `SENSITIVE_HOME_PATHS`) at e4f8a1e; see PROVENANCE.md.
// Local changes: every input is explicit (the tool's config) instead of `AGENT_RUNTIME_*` variables; the agent's
// commands get the configured commit identity instead of the developer's global git identity; the release age is
// the repository's, not a fixed 7; the resolved login source and its canonical path (when present) stay unreadable.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
  /** Absolute paths the agent's commands may not read, on top of sensitive home paths and the Codex login source. */
  readonly readDeny: ReadonlyArray<string>;
  /** Absolute directories put first on the PATH of the agent's commands (the guards), and only theirs. */
  readonly commandPath: ReadonlyArray<string>;
  /** The repository's release age, given to npm as `min-release-age`. */
  readonly releaseAgeDays: number;
  /** Where the build tools' caches go instead of `~/.gradle` and the like. */
  readonly buildCacheRoot: string;
}

/** What `codexIsolation` reads from the machine; each defaults to the real one. */
export interface Machine {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly exists: (path: string) => boolean;
  readonly realpath: (path: string) => string;
}

/**
 * Codex runs for a tool:
 *   - reuse the developer's file-backed `codex login` (`$CODEX_HOME`, else
 *     `~/.codex`) — the CLI reads it, sandboxed commands can't;
 *   - deny sandboxed commands the resolved login `auth.json` path (and its
 *     canonical path when present), the sensitive home paths above that exist,
 *     and `readDeny`: anything they read reaches the model provider, and a write
 *     run has the network. Codex shows the denied paths to the model, so their
 *     names (never their contents) are visible to it; the rest of the home
 *     stays readable, and so do toolchains and working copies under it;
 *   - replace the home's git and npm config (denied above, and able to hold
 *     credentials) with env: the configured commit identity, npm's
 *     `ignore-scripts` and the repository's `min-release-age`;
 *   - put `commandPath` (the guards) first on the PATH of the agent's
 *     commands — only theirs: the tool's own clone and push keep the real
 *     tools;
 *   - give the agent a dedicated build-tool cache instead of `~/.gradle`,
 *     whose init scripts every later build would run.
 */
export function codexIsolation(settings: IsolationSettings, machine: Partial<Machine> = {}): CodexRunnerOptions {
  const { env = process.env, home = homedir(), exists = existsSync, realpath = realpathSync } = machine;
  const relative = [...settings.commandPath, ...settings.readDeny, settings.buildCacheRoot].filter((path) => !isAbsolute(path));
  if (relative.length > 0) throw new Error(`isolation paths must be absolute; got '${relative.join("', '")}'`);
  if (!Number.isInteger(settings.releaseAgeDays) || settings.releaseAgeDays < 0) {
    throw new Error(`releaseAgeDays must be a non-negative integer; got ${settings.releaseAgeDays}`);
  }
  const loginHome = nonEmpty(env["CODEX_HOME"]) ?? join(home, ".codex");
  const loginPath = resolve(loginHome, "auth.json");
  const readDenied = [
    ...SENSITIVE_HOME_PATHS.map((path) => join(home, path)).filter(exists),
    ...settings.readDeny,
    loginPath,
    ...(exists(loginPath) ? [realpath(loginPath)] : []),
  ];
  const path = nonEmpty(env["PATH"]);
  const commandPath = settings.commandPath.join(":");
  const { name, email } = settings.commitIdentity;
  return {
    loginHome,
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
