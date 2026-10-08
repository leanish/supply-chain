// Copied from leanish/leanish-development core/runtime/src/skill/codex-login.ts at e4f8a1e; see PROVENANCE.md.
import { randomUUID } from "node:crypto";
import { lstat, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reuse of a file-backed Codex login (`<loginHome>/auth.json`, written by
 * `codex login`) inside the staged `CODEX_HOME`. Only `auth.json` is linked —
 * never the user's config. A keyring-only login has no `auth.json` and isn't
 * reused.
 *
 * The staged entry is a symlink, so token refreshes write through to the real
 * file. If the CLI replaces the link with a regular file instead, the runner
 * never overwrites the real `auth.json`: it saves the replacement next to it
 * and fails, leaving the choice of which one to keep to the user.
 */
const AUTH_FILE = "auth.json";

/** Fails before staging when the run would have no Codex credentials at all. */
export async function assertCodexLoginAvailable(
  loginHome: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  if (await isFile(join(loginHome, AUTH_FILE))) return;
  if (env["CODEX_API_KEY"] !== undefined && env["CODEX_API_KEY"] !== "") return;
  throw new Error(
    `CodexRunner: no file-backed Codex login under ${loginHome} (keyring-only logins aren't reused) — run \`codex login\` or set CODEX_API_KEY`,
  );
}

/** Links the login into the staged home; does nothing when there's no `auth.json` to reuse. */
export async function linkCodexLogin(stagedHome: string, loginHome: string): Promise<void> {
  const source = join(loginHome, AUTH_FILE);
  if (!(await isFile(source))) return;
  await symlink(source, join(stagedHome, AUTH_FILE));
}

/**
 * Checks the staged entry once the CLI has exited. Returns normally when the
 * link is intact (or there was none). When the CLI replaced it with a regular
 * file, saves that file as `<loginHome>/auth.json.agent-runtime-<stamp>`
 * (mode 0600, never overwriting anything) and throws; `runError` becomes the
 * thrown error's `cause`. When even that save fails, the error says the staged
 * home was kept and where — the caller must then skip its cleanup.
 */
export async function reconcileCodexLogin(
  stagedHome: string,
  loginHome: string,
  runError?: unknown,
): Promise<void> {
  const staged = join(stagedHome, AUTH_FILE);
  const entry = await lstat(staged).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (entry === undefined || entry.isSymbolicLink()) return;
  if (!entry.isFile()) {
    throw new Error(`CodexRunner: ${staged} is neither the linked login nor a file`, withCause(runError));
  }

  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const target = join(loginHome, `${AUTH_FILE}.agent-runtime-${stamp}`);
  try {
    await writeFile(target, await readFile(staged), { mode: 0o600, flag: "wx" });
  } catch (saveError) {
    throw new CodexLoginKeptError(
      `CodexRunner: Codex replaced the linked login during the run and saving it next to ${join(loginHome, AUTH_FILE)} failed (${(saveError as Error).message}); the refreshed credentials were kept at ${staged}`,
      withCause(runError),
    );
  }
  throw new Error(
    `CodexRunner: Codex replaced the linked login during the run; its credentials were saved to ${target} and ${join(loginHome, AUTH_FILE)} was left as is — keep whichever is newer`,
    withCause(runError),
  );
}

/** The staged home still holds credentials, so it must not be cleaned up. */
export class CodexLoginKeptError extends Error {
  override readonly name = "CodexLoginKeptError";
}

/** Follows symlinks: a login file that is itself a link still counts. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function withCause(runError: unknown): ErrorOptions | undefined {
  return runError === undefined ? undefined : { cause: runError };
}
