import { describe, expect, it } from "vitest";

import { actionChanges, actionGaps, actionsLocated, resolveUses } from "../src/actions-changes.ts";
import { ActionsGitHub } from "../src/actions-github.ts";
import { type ActionsInventory, type ActionUse, parseUses, readActionsInventory } from "../src/actions-inventory.ts";
import { parseConfig } from "../src/config.ts";
import type { Tree } from "../src/tree.ts";
import { fakeFetch, type FakeResponse } from "./fake-fetch.ts";

const API = "https://api.github.com";
const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const OLD_CHECKOUT_SHA = "11bd71901bbe5b1630ceea73d27597364c9af683";
const TAG_OBJECT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function tree(files: Record<string, string>): Tree {
  return {
    id: "tree",
    read: async (path) => files[path],
    list: async (dir) => Object.keys(files).filter((path) => path.startsWith(`${dir}/`)).sort(),
  };
}

/** GitHub: actions/checkout's v7.0.1 is a lightweight tag, v4.2.2 an annotated one; releases for both. */
function github(extra: Record<string, FakeResponse> = {}): ActionsGitHub {
  return new ActionsGitHub(
    fakeFetch({
      [`${API}/repos/actions/checkout/git/ref/tags/v7.0.1`]: { body: { object: { type: "commit", sha: CHECKOUT_SHA } } },
      [`${API}/repos/actions/checkout/git/ref/tags/v4.2.2`]: { body: { object: { type: "tag", sha: TAG_OBJECT } } },
      [`${API}/repos/actions/checkout/git/tags/${TAG_OBJECT}`]: { body: { object: { type: "commit", sha: OLD_CHECKOUT_SHA } } },
      [`${API}/repos/actions/checkout/releases?per_page=100&page=1`]: {
        body: [
          { tag_name: "v7.0.1", published_at: "2026-04-10T17:31:14Z", draft: false },
          { tag_name: "v4.2.2", published_at: "2024-10-23T14:46:00Z", draft: false },
        ],
      },
      ...extra,
    }),
    undefined,
  );
}

describe("reading workflows", () => {
  it("reads every uses: with its comment, follows local actions, and keeps docker uses apart", async () => {
    const workflow = `on: pull_request
jobs:
  reuse:
    uses: acme/shared/.github/workflows/ci.yml@0123456789abcdef0123456789abcdef01234567 # v1.2.3
  test:
    steps:
      - uses: actions/checkout@${CHECKOUT_SHA} # v7.0.1
      - name: setup
        uses: "Actions/Setup-Node@v7"
      - run: |
          echo uses: not/an-action@v1
      - uses: ./.github/local-action
      - uses: docker://alpine:3.20
      - "u\\u0073es": escaped/key@v1
`;
    const composite = `runs:
  using: composite
  steps:
    - uses: actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809 # tag=v4.2.4
`;
    const inventory = await readActionsInventory(
      tree({ ".github/workflows/ci.yml": workflow, ".github/workflows/notes.md": "uses: x/y@z", ".github/local-action/action.yml": composite }),
    );
    expect(inventory.uses.map((use) => [use.name, use.path, use.ref, use.comment, use.file])).toEqual([
      ["acme/shared", ".github/workflows/ci.yml", "0123456789abcdef0123456789abcdef01234567", "v1.2.3", ".github/workflows/ci.yml"],
      ["actions/checkout", undefined, CHECKOUT_SHA, "v7.0.1", ".github/workflows/ci.yml"],
      ["actions/setup-node", undefined, "v7", undefined, ".github/workflows/ci.yml"],
      ["escaped/key", undefined, "v1", undefined, ".github/workflows/ci.yml"],
      ["actions/cache", undefined, "0400d5f644dc74513175e3cd8d07132dd4860809", "tag=v4.2.4", ".github/local-action/action.yml"],
    ]);
    expect(inventory.docker).toEqual(["docker://alpine:3.20 (.github/workflows/ci.yml)"]);
  });

  it("fails on YAML that doesn't parse and on a uses: it can't read", () => {
    expect(() => parseUses("jobs: [", "bad.yml")).toThrow("bad.yml isn't valid YAML");
    expect(() => parseUses("steps:\n  - uses: not-an-action\n", "odd.yml")).toThrow("odd.yml: can't read `uses: not-an-action`");
    expect(() => parseUses("steps:\n  - uses: [a]\n", "odd.yml")).toThrow("odd.yml: a `uses:` isn't a string");
  });
});

describe("resolving uses", () => {
  const use = (ref: string, comment: string | undefined) => ({ name: "actions/checkout", path: undefined, ref, comment, file: "ci.yml" });
  const inventory = (...uses: ReturnType<typeof use>[]): ActionsInventory => ({ uses, docker: [], files: ["ci.yml"], gaps: [] });

  it("pins a commit whose comment names a tag pointing at it, annotated tags included", async () => {
    const resolutions = await resolveUses(
      [
        inventory(
          use(CHECKOUT_SHA, "v7.0.1"),
          use(OLD_CHECKOUT_SHA, "pin v4.2.2"),
          use("v7", undefined),
          use(CHECKOUT_SHA.replace("3d", "4d"), "v7.0.1"),
          use(OLD_CHECKOUT_SHA.replace("11", "22"), "no version"),
          use(OLD_CHECKOUT_SHA.replace("11", "33"), "v9.9.9"),
        ),
      ],
      github(),
    );
    expect([...resolutions.values()]).toEqual([
      { kind: "pinned", version: "v7.0.1" },
      { kind: "pinned", version: "v4.2.2" },
      { kind: "unpinned" },
      { kind: "unverified", reason: `tag v7.0.1 of actions/checkout points at ${CHECKOUT_SHA.slice(0, 12)}, not 4d3c42e5aac5` },
      { kind: "unverified", reason: "no `# vX.Y.Z` comment names its full version" },
      { kind: "unverified", reason: "actions/checkout has no tag v9.9.9" },
    ]);
  });

  it("fails on changed uses that aren't pinned or verified, gaps the unchanged ones, and dates changed ones by their release", async () => {
    const config = parseConfig({});
    const base = inventory(use(OLD_CHECKOUT_SHA, "v4.2.2"), use("v6", undefined));
    const head: ActionsInventory = {
      uses: [use(CHECKOUT_SHA, "v7.0.1"), use("v6", undefined), { ...use("v7", undefined), name: "actions/setup-node" }],
      docker: ["docker://alpine:3.20 (ci.yml)"],
      files: ["ci.yml"],
      gaps: [],
    };
    const gh = github();
    const resolutions = await resolveUses([base, head], gh);
    const result = await actionChanges(base, head, resolutions, gh, config);
    expect(result.problems).toEqual([
      "actions/setup-node@v7 (ci.yml) is new or changed, so it must be pinned to a full commit SHA with a `# vX.Y.Z` comment",
    ]);
    expect(result.gaps).toEqual([
      "GitHub Actions docker://alpine:3.20 (ci.yml): no advisory source covers container images",
      "GitHub Actions actions/checkout@v6 (ci.yml): not pinned to a commit, so its version (and advisories) can't be told",
    ]);
    expect(result.changes).toEqual([
      {
        pkg: { ecosystem: "GitHub Actions", name: "actions/checkout", version: "v7.0.1" },
        published: new Date("2026-04-10T17:31:14Z"),
        replaced: ["v4.2.2"],
      },
    ]);
    expect(actionsLocated(head, resolutions)).toEqual([
      { ecosystem: "GitHub Actions", name: "actions/checkout", version: "v7.0.1", locations: ["ci.yml"] },
    ]);
    expect(actionGaps(head, resolutions)).toHaveLength(3);
  });

  it("fails a changed action without a published release, unless it's an own action", async () => {
    const own = { name: "acme/tools", path: undefined, ref: CHECKOUT_SHA, comment: "v1.0.0", file: "ci.yml" };
    const gh = github({
      [`${API}/repos/acme/tools/git/ref/tags/v1.0.0`]: { body: { object: { type: "commit", sha: CHECKOUT_SHA } } },
    });
    const head: ActionsInventory = { uses: [own], docker: [], files: ["ci.yml"], gaps: [] };
    const none: ActionsInventory = { uses: [], docker: [], files: [], gaps: [] };
    const resolutions = await resolveUses([head], gh);
    expect((await actionChanges(none, head, resolutions, gh, parseConfig({}))).problems).toEqual([
      "acme/tools@3d3c42e5aac5ba805825da76410c181273ba90b1 (ci.yml): acme/tools has no published GitHub release for v1.0.0, so the gate can't check its age",
    ]);
    const config = parseConfig({ ownPackages: { "GitHub Actions": { owners: ["acme"] } } });
    expect(await actionChanges(none, head, resolutions, gh, config)).toEqual({ problems: [], gaps: [], changes: [] });
  });
});

describe("occurrences and edge cases", () => {
  const use = (ref: string, comment: string | undefined, file = "ci.yml"): ActionUse => ({ name: "actions/checkout", path: undefined, ref, comment, file });
  const inventory = (...uses: ActionUse[]): ActionsInventory => ({ uses, docker: [], files: ["ci.yml"], gaps: [] });

  it("judges each occurrence: a dropped comment, or an unpinned ref copied to another workflow, is a change", async () => {
    const gh = github();
    const base = inventory(use(CHECKOUT_SHA, "v7.0.1"), use("v6", undefined));
    const dropped = inventory(use(CHECKOUT_SHA, undefined), use("v6", undefined));
    const copied = inventory(use(CHECKOUT_SHA, "v7.0.1"), use("v6", undefined), use("v6", undefined, "release.yml"));
    const config = parseConfig({});
    const resolutions = await resolveUses([base, dropped, copied], gh);
    expect((await actionChanges(base, dropped, resolutions, gh, config)).problems).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 (ci.yml): no `# vX.Y.Z` comment names its full version",
    ]);
    expect((await actionChanges(base, copied, resolutions, gh, config)).problems).toEqual([
      "actions/checkout@v6 (release.yml) is new or changed, so it must be pinned to a full commit SHA with a `# vX.Y.Z` comment",
    ]);
  });

  it("counts a duplicate step and a switched subpath as changes, and reads alias keys", async () => {
    const gh = github();
    const config = parseConfig({});
    const base = inventory(use("v6", undefined));
    const duplicated = inventory(use("v6", undefined), use("v6", undefined));
    const subpath = inventory({ ...use("v6", undefined), path: "two" });
    const resolutions = await resolveUses([base, duplicated, subpath], gh);
    expect((await actionChanges(base, duplicated, resolutions, gh, config)).problems).toEqual([
      "actions/checkout@v6 (ci.yml) is new or changed, so it must be pinned to a full commit SHA with a `# vX.Y.Z` comment",
    ]);
    expect((await actionChanges(base, subpath, resolutions, gh, config)).problems).toEqual([
      "actions/checkout/two@v6 (ci.yml) is new or changed, so it must be pinned to a full commit SHA with a `# vX.Y.Z` comment",
    ]);
    const aliased = parseUses("steps:\n  - &key uses: acme/old@v1\n  - *key : acme/new@v1\n", "ci.yml");
    expect(aliased.uses.map((found) => found.name)).toEqual(["acme/old", "acme/new"]);
  });

  it("won't take a floating major tag as the version", async () => {
    const gh = github({ [`${API}/repos/actions/checkout/git/ref/tags/v7`]: { body: { object: { type: "commit", sha: CHECKOUT_SHA } } } });
    expect([...(await resolveUses([inventory(use(CHECKOUT_SHA, "v7"))], gh)).values()]).toEqual([
      { kind: "unverified", reason: "no `# vX.Y.Z` comment names its full version" },
    ]);
  });

  it("follows YAML aliases with the anchor's comment, and reports a local action without metadata", async () => {
    const workflow = `on: push
x-checkout: &checkout actions/checkout@${CHECKOUT_SHA} # v7.0.1
jobs:
  a:
    steps:
      - uses: *checkout
      - &setup
        uses: actions/setup-node@v7
  b:
    steps:
      - *setup
      - uses: ./missing-action
`;
    const read = await readActionsInventory(tree({ ".github/workflows/ci.yml": workflow, ".github/workflows/shell.yml": "on: push\njobs:\n  a:\n    steps:\n      - run: echo hi\n" }));
    expect(read.uses.map((found) => [found.name, found.ref, found.comment])).toEqual([
      ["actions/checkout", CHECKOUT_SHA, "v7.0.1"],
      ["actions/setup-node", "v7", undefined],
    ]);
    expect(read.files).toEqual([".github/workflows/ci.yml", ".github/workflows/shell.yml"]);
    expect(read.gaps).toEqual(["GitHub Actions local action ./missing-action (.github/workflows/ci.yml) has no action.yml, so what it uses isn't read"]);
  });
});

describe("GitHub's advisory database", () => {
  it("asks for reviewed and malware advisories by version, and reads aliases, malware and withdrawals", async () => {
    const affects = (type: string) => `${API}/advisories?ecosystem=actions&affects=${encodeURIComponent("tj-actions/changed-files@v45.0.7")}&type=${type}&per_page=100`;
    const gh = new ActionsGitHub(
      fakeFetch({
        [affects("reviewed")]: {
          body: [
            {
              ghsa_id: "GHSA-mrrh-fwg8-r2c3",
              cve_id: "CVE-2025-30066",
              type: "reviewed",
              severity: "high",
              summary: "tj-actions changed-files through 45.0.7 allows remote attackers to discover secrets",
              identifiers: [{ type: "GHSA", value: "GHSA-mrrh-fwg8-r2c3" }, { type: "CVE", value: "CVE-2025-30066" }],
              cwes: [{ cwe_id: "CWE-506" }],
              withdrawn_at: null,
            },
            { ghsa_id: "GHSA-gone", type: "reviewed", withdrawn_at: "2026-01-01T00:00:00Z" },
          ],
        },
        [affects("malware")]: { body: [{ ghsa_id: "GHSA-mal1", type: "malware", summary: "Malicious code" }] },
      }),
      "token",
    );
    const found = await gh.advisories("tj-actions/changed-files", "v45.0.7");
    expect(found.map((advisory) => [advisory.id, advisory.ids, advisory.malicious, advisory.severity])).toEqual([
      ["GHSA-mrrh-fwg8-r2c3", ["GHSA-mrrh-fwg8-r2c3", "CVE-2025-30066"], true, "HIGH"],
      ["GHSA-mal1", ["GHSA-mal1"], true, undefined],
    ]);
  });

  it("counts global coverage only for reviewed or malware records, and follows every page", async () => {
    const affects = (type: string) => `${API}/advisories?ecosystem=actions&affects=${encodeURIComponent("a/b@v1.0.0")}&type=${type}&per_page=100`;
    const vulnerable = { vulnerabilities: [{ package: { ecosystem: "actions", name: "a/b" } }] };
    const gh = new ActionsGitHub(
      fakeFetch({
        [`${API}/advisories/GHSA-unrv-unrv-unrv`]: { body: { ghsa_id: "GHSA-unrv-unrv-unrv", type: "unreviewed", ...vulnerable } },
        [`${API}/advisories/GHSA-revd-revd-revd`]: { body: { ghsa_id: "GHSA-revd-revd-revd", type: "reviewed", ...vulnerable } },
        [affects("reviewed")]: { body: [{ ghsa_id: "GHSA-page-one1-aaaa" }], headers: { link: `<${API}/advisories?page=2>; rel="next"` } },
        [`${API}/advisories?page=2`]: { body: [{ ghsa_id: "GHSA-page-two2-bbbb" }] },
        [affects("malware")]: { body: [] },
      }),
      undefined,
    );
    expect(await gh.globalCovers("GHSA-unrv-unrv-unrv", "a/b")).toBe(false);
    expect(await gh.globalCovers("GHSA-revd-revd-revd", "a/b")).toBe(true);
    expect((await gh.advisories("a/b", "v1.0.0")).map((advisory) => advisory.id)).toEqual(["GHSA-page-one1-aaaa", "GHSA-page-two2-bbbb"]);
  });

  it("marks a release listing past the page cap incomplete, so the young-fix proof can't use it", async () => {
    const page = (n: number) =>
      Array.from({ length: 100 }, (_, i) => ({ tag_name: `v1.${n}.${i}`, published_at: "2026-01-01T00:00:00Z", draft: false }));
    const routes = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${API}/repos/a/b/releases?per_page=100&page=${i + 1}`, { body: page(i + 1) }]));
    const gh = new ActionsGitHub(fakeFetch(routes), undefined);
    expect((await gh.releasesOf("a/b")).complete).toBe(false);
    const { ActionsCatalog } = await import("../src/actions-changes.ts");
    expect(await new ActionsCatalog(gh).versions({ ecosystem: "GitHub Actions", name: "a/b" })).toBeUndefined();
  });

  it("fails closed on errors other than a 404", async () => {
    const gh = new ActionsGitHub(fakeFetch({ [`${API}/repos/a/b/git/ref/tags/v1`]: { status: 502 } }), undefined);
    await expect(gh.tagCommit("a/b", "v1")).rejects.toThrow("failed with HTTP 502");
    expect(await gh.tagCommit("a/b", "v2")).toBeUndefined();
  });
});
