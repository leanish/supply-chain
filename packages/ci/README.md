# supply-chain CLI

The CI gate. It reads what a repository installs, looks every package version up against **one advisory snapshot**, and:

- on a **pull request** (`compare`), fails only on what the PR makes worse: a finding head has and base doesn't, malware anywhere in head, or an added or changed version that fails the release-age, source or identity checks;
- on the **default branch** (`scan`), fails on every finding without a valid exception, so a dependency flagged after it merged turns `main` red.

It runs with plain Node 24 (type stripping), reads files from git objects or the working tree, and never runs anything from the repository it checks.

```bash
node packages/ci/src/cli.ts compare --base HEAD^1 --head HEAD --report report.json
node packages/ci/src/cli.ts scan --head HEAD
node packages/ci/src/cli.ts scan --head worktree --repo ../my-repo
```

Exit codes: `0` pass, `1` fail, `2` the gate couldn't complete (a failure too: an unreachable registry, OSV or GitHub API, or data that doesn't parse, never reads as clean).

Environment:

- `OSV_SCANNER` (default `osv-scanner` on `PATH`; `scripts/install-osv-scanner.sh <dir>` installs the version pinned in [`tools.json`](tools.json), checking its sha256);
- `GITHUB_TOKEN` or `GH_TOKEN` for the GitHub API (repository advisories; unauthenticated requests get 60 an hour);
- in Actions, `GITHUB_STEP_SUMMARY` gets a markdown summary and `GITHUB_ACTIONS=true` turns failures and warnings into annotations;
- `SUPPLY_CHAIN_COMMIT` records the gate's own commit in the report.

## What a finding is

A finding is an advisory affecting a package version: **ecosystem + package + advisory**, where the advisory is its whole alias group (`GHSA-…`, `CVE-…`, `MAL-…` that name each other count as one). Version and location don't matter, so:

- an upgrade that fixes A while B still affects the new version **passes**, B shows up as inherited and A as fixed;
- an advisory published today on a dependency both sides share is **inherited**: a warning on the PR, a failure on `main`;
- a new package, or a new version, that brings an advisory base didn't have **fails**, unless an exception covers it;
- **malware** (an OSV `MAL-*` id or alias, or a GitHub advisory tagged CWE-506) in head always fails, inherited or bundled, and no exception covers it.

## Where advisories come from

One snapshot per run, shared by base and head:

- **[OSV-Scanner](https://github.com/google/osv-scanner)**, run once over the union of every package version on both sides, from an empty directory with an empty config, so no `osv-scanner.toml` in the checked repository can ignore anything. Every requested package must come back in its output.
- **Repository security advisories** of each dependency's own GitHub repository (npm: the version manifest's `repository`; Maven: the POM's `scm`, walking up to 5 parents). A repository can publish an advisory days before GitHub reviews it into its database and OSV imports it. The gate reads them, and asks OSV for its record of each, before OSV-Scanner runs: when OSV already has the advisory for that package, OSV's verdict on the version stands; the repository's own range only covers what OSV doesn't have yet. A repository advisory marked as malware is always kept. Ranges are read as maintainers write them (`< 1.1.21, >= 2.0.0 < 2.1.7`, `6.x <6.1.2`, `4.0.0 - 5.0.7`); a range without an upper bound stops at its patched version.

A package with no GitHub source repository, an unreadable repository, and a range the gate can't read are **coverage gaps**: listed in the report, never a pass in disguise.

## Release age, source and identity (npm)

For every version a PR adds or changes:

- **Release age:** published at least `releaseAgeDays` (default 7) ago, unless it's an own package, or a `releaseAge` exception names an advisory that, in this run's snapshot, affects a version the PR replaces and not this one (malware advisories don't count).
- **Source:** every locked package comes from an allowed registry (`npm.registries`, default the npm registry). The gate checks age and identity only against the npm registry, so a package from another allowed registry fails, unless it's an own package with an unexpired `identity` exception recording that its publish was reviewed (own packages skip only the wait).
- **Identity:** a version that replaces another fails on a publisher identity break: provenance dropped or from another repository or workflow, provenance from a repository the replaced version doesn't declare, or (without provenance) a publisher who hadn't published the package up to the replaced version. Every provenance statement must name the exact package, version and locked sha512.
- Bundles the lockfile doesn't fully record fail: every `bundleDependencies` entry, and what it depends on, needs an `inBundle` entry inside the package that ships it.

After a scriptless `npm ci --ignore-scripts`, `npm audit signatures` verifies registry signatures and attestations of what was installed (a workflow step, not this CLI).

## Configuration: `.github/supply-chain.json`

Optional; read from head. Unknown fields fail, so a typo can't turn a check off.

```json
{
  "npm": { "lockfiles": ["package-lock.json", "docker/cli/package-lock.json"], "registries": ["https://registry.npmjs.org"] },
  "releaseAgeDays": 7,
  "ownPackages": { "npm": { "scopes": ["@acme"] } },
  "repositories": { "npm:some-package": "owner/repo", "Maven:group:artifact": "owner/repo" }
}
```

Every listed lockfile must exist in head; one base doesn't have yet reads as empty there.

## Exceptions: `.github/supply-chain-exceptions.json`

Reviewed exceptions in three lists. Each entry names the exact package and version, a `reason` and an `expires` date (valid through that UTC day); an optional `ecosystem` narrows it.

- `vulnerabilities`: `id` (any alias of the advisory), `package`, `version`, and the `paths` it covers (lockfile paths like `node_modules/aws-cdk-lib/node_modules/brace-expansion`; for a lockfile in a subdirectory, prefixed with it). A copy anywhere else still fails.
- `releaseAge`: `package`, `version` and the `advisory` the young version fixes.
- `identity`: a reviewed publisher identity break.

Malware ids can't be excepted.

## Report

`--report <file>` writes JSON: `schemaVersion`, `mode`, the gate's commit and OSV-Scanner version, a digest of the config, `baseSha`, `headSha`, `startedAt` (the snapshot's time), `completedAt`, `completed`, `verdict`, and the failures, warnings, notes and gaps.

## Coming next

Gradle inventories (with Maven release age and floors), GitHub Actions as an ecosystem, the automatic proof that a young security fix may skip the wait, the floors file, and the reusable workflow with its daily rescan of open PRs.
