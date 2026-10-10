// Copied from leanish/leanish-development core/runtime/src/skill/codex-command-env.ts at c6282df; see PROVENANCE.md.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * What the commands Codex runs (not the CLI itself) see of its env.
 *
 * Codex passes its whole env to the commands it runs, and its default name
 * filter has changed between versions. The runner states it instead: only
 * the variables it gave the CLI, minus Codex's own API keys — which the CLI
 * needs and the model's commands never do (a write run has the network).
 * `ignore_default_excludes` keeps a version that drops `*TOKEN*` names from
 * removing a target credential the run was given on purpose (e.g. `GH_TOKEN`).
 */
const CODEX_OWN_KEYS: ReadonlySet<string> = new Set(["CODEX_API_KEY", "OPENAI_API_KEY"]);

/** Names usable verbatim as Codex `include_only` patterns (no glob characters). */
const PLAIN_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function commandEnvArgs(cliEnv: Readonly<Record<string, string | undefined>>): string[] {
  const names = Object.keys(cliEnv)
    .filter((name) => cliEnv[name] !== undefined && PLAIN_ENV_NAME.test(name) && !CODEX_OWN_KEYS.has(name))
    .sort();
  return [
    "-c",
    "shell_environment_policy.ignore_default_excludes=true",
    "-c",
    `shell_environment_policy.include_only=${JSON.stringify(names)}`,
  ];
}

/**
 * When the run has a `GH_TOKEN` (a target credential), `gh` reads it directly;
 * `git` gets it through `GIT_ASKPASS` — a script that prints the variable, so
 * the token never lands in a remote URL, `.git/config` or a command line.
 * `gh` gets its own empty config dir: the developer's (`~/.config/gh`) may be
 * read-denied, and it holds their own login.
 */
export async function githubToolsEnv(stagedHome: string): Promise<Record<string, string>> {
  const askpass = join(stagedHome, "git-askpass");
  await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  Username*) echo x-access-token ;;\n  *) printf \'%s\\n\' "$GH_TOKEN" ;;\nesac\n');
  await chmod(askpass, 0o700);
  const ghConfigDir = join(stagedHome, "gh");
  await mkdir(ghConfigDir, { recursive: true });
  return {
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: "0",
    GH_CONFIG_DIR: ghConfigDir,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };
}
