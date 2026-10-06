# supply-chain CLI

The CI gate. It reads what a repository installs (npm lockfiles, and what Gradle builds really resolve), looks every package version up against **one advisory snapshot**, and:

- on a **pull request** (`compare`), fails only on what the PR makes worse: a finding head has and base doesn't, malware anywhere in head, or an added or changed version that fails the release-age, source or identity checks;
- on the **default branch** (`scan`), fails on every finding without a valid exception, so a dependency flagged after it merged turns `main` red.

It runs with plain Node 24 (type stripping) and reads files from git objects or the working tree. The only thing that runs code from the checked repository is `gradle-inventory`, which runs its Gradle build to learn what it resolves; in CI that happens in a job of its own, and the comparison only reads the JSON it wrote.

```bash
node packages/ci/src/cli.ts compare --base HEAD^1 --head HEAD --report report.json
node packages/ci/src/cli.ts scan --head HEAD
node packages/ci/src/cli.ts scan --head worktree --repo ../my-repo        # runs Gradle inline if the repo has a build
node packages/ci/src/cli.ts gradle-inventory --repo checkout --out head-gradle.json
node packages/ci/src/cli.ts compare --base "$BASE" --head "$HEAD" --base-gradle base-gradle.json --head-gradle head-gradle.json
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

## Gradle builds

`gradle-inventory` runs [`gradle/supply-chain-inventory.init.gradle`](gradle/supply-chain-inventory.init.gradle) on a clean checkout and records, for every project, **every resolvable configuration**: runtime, compile and test classpaths, annotation processors, tool configurations (checkstyle, pitest, jacoco…), the buildscript classpath (where `plugins {}` and `buildscript {}` put plugins) and the settings classpath. Each configuration lists what resolution selected, what it couldn't resolve, and the external dependencies it declares or inherits, with Gradle's `because(...)` reason.

- `buildSrc`, and included builds Gradle configures from the root build, are covered by the same run, under their own location prefix (`buildSrc/:compileClasspath`). Any other `includeBuild(...)` has to be listed in `gradle.builds`, or the run fails.
- A configuration that doesn't resolve fails the run on either side: a hole in the inventory would read as clean. `gradle.ignoreConfigurations` names locations to leave out, explicitly.
- The inventory names the commit it was made from, and `compare`/`scan` check it matches.
- A plugin's injected dependencies show up in its consumers' builds, which run this gate themselves (for example, java-conventions' checkstyle and errorprone dependencies in sqs-codec).
- Gradle runs the build's own code, so a malicious build script or plugin can alter its own inventory; keeping that job apart keeps it from touching the comparison and its credentials, not from lying about itself.

## Release age, source and identity (npm)

For every version a PR adds or changes:

- **Release age:** published at least `releaseAgeDays` (default 7) ago, unless it's an own package, or a `releaseAge` exception names an advisory that, in this run's snapshot, affects a version the PR replaces and not this one (malware advisories don't count).
- **Source:** every locked package comes from an allowed registry (`npm.registries`, default the npm registry). The gate checks age and identity only against the npm registry, so a package from another allowed registry fails, unless it's an own package with an unexpired `identity` exception recording that its publish was reviewed (own packages skip only the wait).
- **Identity:** a version that replaces another fails on a publisher identity break: provenance dropped or from another repository or workflow, provenance from a repository the replaced version doesn't declare, or (without provenance) a publisher who hadn't published the package up to the replaced version. Every provenance statement must name the exact package, version and locked sha512.
- Bundles the lockfile doesn't fully record fail: every `bundleDependencies` entry, and what it depends on, needs an `inBundle` entry inside the package that ships it.

After a scriptless `npm ci --ignore-scripts`, `npm audit signatures` verifies registry signatures and attestations of what was installed (a workflow step, not this CLI).

## Release age (Maven)

Every Maven version a change adds needs the same wait, own packages aside. Its publish time is the POM's `Last-Modified` in the first configured repository that has it (`maven.repositories`, default Maven Central and the Gradle Plugin Portal, both immutable, so a file's date is its upload; Renovate reads Maven release dates the same way). A version none of them has fails: the gate can't tell its age. A young security fix needs a `releaseAge` exception (with `"ecosystem": "Maven"`), checked against the snapshot like npm's.

## Configuration: `.github/supply-chain.json`

Optional; read from head. Unknown fields fail, so a typo can't turn a check off.

```json
{
  "npm": { "lockfiles": ["package-lock.json", "docker/cli/package-lock.json"], "registries": ["https://registry.npmjs.org"] },
  "gradle": { "builds": ["."], "ignoreConfigurations": [] },
  "maven": { "repositories": ["https://repo1.maven.org/maven2", "https://plugins.gradle.org/m2"] },
  "releaseAgeDays": 7,
  "ownPackages": {
    "npm": { "scopes": ["@acme"] },
    "Maven": { "groups": ["com.acme"], "pluginIdPrefixes": ["com.acme."] }
  },
  "repositories": { "npm:some-package": "owner/repo", "Maven:group:artifact": "owner/repo" }
}
```

- Without `npm.lockfiles`, the gate reads `package-lock.json` if the tree has one; without `gradle.builds`, the root build if the tree has a `settings.gradle(.kts)` or `build.gradle(.kts)`. So an ecosystem in the repository is never skipped for lack of configuration; `"builds": []` turns Gradle off explicitly.
- Every listed lockfile must exist in head; one base doesn't have yet reads as empty there.
- Own Maven packages: exact `groups`, and `pluginIdPrefixes` that only match Gradle plugin markers (`<id>:<id>.gradle.plugin`), so `com.acme.` doesn't exempt every `com.acme.*` group.

## Exceptions: `.github/supply-chain-exceptions.json`

Reviewed exceptions in three lists. Each entry names the exact package and version, a `reason` and an `expires` date (valid through that UTC day); an optional `ecosystem` narrows it.

- `vulnerabilities`: `id` (any alias of the advisory), `package`, `version`, and the `paths` it covers: lockfile paths like `node_modules/aws-cdk-lib/node_modules/brace-expansion` (for a lockfile in a subdirectory, prefixed with it), or Gradle configuration locations like `:checkstyle` or `buildSrc/:runtimeClasspath`. A copy anywhere else still fails.
- `releaseAge`: `package`, `version` and the `advisory` the young version fixes.
- `identity`: a reviewed publisher identity break.

Malware ids can't be excepted.

## Report

`--report <file>` writes JSON: `schemaVersion`, `mode`, the gate's commit and OSV-Scanner version, a digest of the config, `baseSha`, `headSha`, `startedAt` (the snapshot's time), `completedAt`, `completed`, `verdict`, and the failures, warnings, notes and gaps.

## Coming next

GitHub Actions as an ecosystem, the automatic proof that a young security fix may skip the wait, the floors file, and the reusable workflow with its daily rescan of open PRs.
