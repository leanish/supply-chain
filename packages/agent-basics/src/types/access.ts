// New in this repository (replaces the `Access` type of leanish-development's agent descriptor).

/**
 * `read-only`: the agent reads its working copies and runs commands that don't
 * write. `write`: it may also edit its working copies' files and reach the
 * network. Their git metadata stays read-only either way, so the agent can't
 * commit or push; the tool does that with its own token.
 */
export type Access = "read-only" | "write";
export const ACCESS_LEVELS: ReadonlyArray<Access> = ["read-only", "write"];
