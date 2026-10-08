// New in this repository (replaces catalog-it's `Project` in the copied workspace). The id rules are catalog-it's
// (`core/catalog-it/src/repo-id.ts` at e4f8a1e), case-insensitive here since GitHub names keep their case.

/** What the workspace needs to know about a repository: an id for its directories, and where to clone it from. */
export interface RepoSource {
  /** `owner/slug`: turned into directory names, so it's checked with `assertRepoSourceId` before any of them is touched. */
  readonly id: string;
  /** `branch`: the branch to sync, usually the default one (the tool resolves it when its config names none). */
  readonly source: { readonly url: string; readonly branch: string };
}

const OWNER = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const SLUG = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/i;

/**
 * Fails unless `id` is `owner/slug` with both parts in catalog-it's alphabet:
 * no empty part, no `.` or `..`, nothing that would make the workspace's
 * directory resolve outside it (the workspace deletes and re-clones there).
 */
export function assertRepoSourceId(id: string): void {
  const slash = id.indexOf("/");
  const owner = slash === -1 ? "" : id.slice(0, slash);
  const slug = slash === -1 ? "" : id.slice(slash + 1);
  if (!OWNER.test(owner) || !SLUG.test(slug)) throw new Error(`repository id '${id}' isn't owner/slug`);
}
