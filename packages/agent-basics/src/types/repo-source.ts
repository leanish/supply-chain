// New in this repository (replaces catalog-it's `Project` in the copied workspace).

/** What the workspace needs to know about a repository: an id for its directories, and where to clone it from. */
export interface RepoSource {
  readonly id: string;
  /** `branch`: the branch to sync, usually the default one (the tool resolves it when its config names none). */
  readonly source: { readonly url: string; readonly branch: string };
}
