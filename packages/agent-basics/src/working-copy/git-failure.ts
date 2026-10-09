// New in this repository; see PROVENANCE.md.
/**
 * What a failed git call says about itself: its stderr, bounded and with every
 * credential masked, so a failure in the logs explains its cause instead of
 * only an exit code.
 */
import type { GitCloneAuth } from "./git-clone-auth.ts";

/** How much raw stderr is held while git runs. */
const STDERR_BUFFER_CHARS = 64 * 1024;
/** How much of the (masked) stderr an error message quotes: its end, where git puts the reason. */
const STDERR_QUOTE_CHARS = 2000;
const MASK = "<redacted>";

/**
 * A git call's stderr, bounded while it streams. Past the buffer the oldest
 * output is dropped, and `text()` then discards the partial line left at the
 * window's start: a credential the cut split would otherwise survive as a
 * fragment that masking no longer recognises.
 */
export class StderrTail {
  #text = "";
  #truncated = false;

  append(chunk: string): void {
    this.#text += chunk;
    if (this.#text.length <= STDERR_BUFFER_CHARS) return;
    this.#text = this.#text.slice(this.#text.length - STDERR_BUFFER_CHARS);
    this.#truncated = true;
  }

  text(): string {
    if (!this.#truncated) return this.#text;
    const newline = this.#text.indexOf("\n");
    return newline === -1 ? "" : this.#text.slice(newline + 1);
  }
}

/**
 * Mask what can carry a credential in git output or arguments: the tool's own
 * token (raw, and as the Basic header value the clone auth sends), any
 * `Authorization:` header value through the end of its line, and the userinfo
 * of an http(s) URL.
 */
export function maskGitCredentials(text: string, auth: GitCloneAuth | undefined): string {
  let masked = text;
  if (auth !== undefined) {
    const basic = Buffer.from(`x-access-token:${auth.token}`).toString("base64");
    for (const secret of [basic, auth.token]) masked = masked.split(secret).join(MASK);
  }
  return masked
    // The whole header value, whatever its scheme (Basic, Bearer, Digest's several fields).
    .replace(/(authorization:[ \t]*)[^\r\n]*/gi, `$1${MASK}`)
    // Through the authority's last `@`: userinfo may hold an unencoded `@` of its own.
    .replace(/(https?:\/\/)[^\s/?#]*@/gi, `$1${MASK}@`);
}

/** `; stderr: <its masked end>`, or nothing when git said nothing. */
export function stderrSuffix(stderr: string, auth: GitCloneAuth | undefined): string {
  const masked = maskGitCredentials(stderr, auth).trim();
  if (masked === "") return "";
  const quoted = masked.length > STDERR_QUOTE_CHARS ? `…${masked.slice(masked.length - STDERR_QUOTE_CHARS)}` : masked;
  return `; stderr: ${quoted}`;
}
