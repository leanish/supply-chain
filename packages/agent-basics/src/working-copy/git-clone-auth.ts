// Copied from leanish/leanish-development core/runtime/src/working-copy/git-clone-auth.ts at e4f8a1e; see PROVENANCE.md.
// Local changes: `gitCloneAuth(token, host)` replaces `resolveGitCloneAuth(needs, env)`; the tool passes its token.
/**
 * Clone-time GitHub credential plumbing.
 *
 * The working copy is cloned before any skill runs, so a *private* target
 * repo needs credentials at clone time — and `git clone` over HTTPS does not
 * pick up a token from the environment on its own. The tool passes its own
 * (write) token, read from its secret store; the agent never sees it.
 *
 * Two small pure functions keep the policy out of the workspace: the tool
 * builds the credential, and the workspace decides — per git network call —
 * whether to attach it, based on the target's host. The workspace never reads
 * env-var names itself.
 */

export interface GitCloneAuth {
  /** The GitHub host the token is valid for (compared against the clone URL's hostname). */
  readonly host: string;
  /** A GitHub token usable as the HTTP basic-auth password (`x-access-token:<token>`). */
  readonly token: string;
}

/** Clone-time auth for `host` (github.com unless the tool's config names a GitHub Enterprise host). */
export function gitCloneAuth(token: string, host = "github.com"): GitCloneAuth {
  if (token.length === 0) throw new Error("a git clone token can't be empty");
  if (host.length === 0) throw new Error("a git clone host can't be empty");
  return { host, token };
}

/**
 * Build the one-shot git args that attach `auth` to a network call against
 * `url`. Returns `[]` (no token attached) unless `url` is an `https:` URL whose
 * host matches `auth.host` — so the PAT is never broadcast to a different host,
 * an SSH URL, or a malformed value.
 *
 * The token rides a per-invocation `-c http.extraheader=...` rather than the
 * remote URL or a persisted `git config`, so it never lands in the clone's
 * `.git/config` where the (credential-scrubbed) coding-agent subprocess could
 * read it. The config key is **URL-scoped to the host** (`http.https://<host>/`)
 * rather than the global `http.extraheader`, so git only ever sends the header
 * to that host — a redirect target or a drifted `origin` on another host gets
 * nothing.
 */
export function cloneAuthArgs(auth: GitCloneAuth | undefined, url: string): string[] {
  if (auth === undefined) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  if (parsed.protocol !== "https:") return [];
  if (parsed.hostname !== auth.host) return [];
  const basic = Buffer.from(`x-access-token:${auth.token}`).toString("base64");
  return ["-c", `http.https://${auth.host}/.extraheader=Authorization: Basic ${basic}`];
}
