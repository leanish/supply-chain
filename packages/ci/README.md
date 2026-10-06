# supply-chain CLI

The CI gate. It reads what a repository installs (npm lockfiles, what Gradle builds really resolve, and the actions its workflows use), looks every package version up against **one advisory snapshot**, and:

- on a **pull request** (`compare`), fails only on what the PR makes worse: a finding head has and base doesn't, malware anywhere in head, or an added or changed version that fails the release-age, source or identity checks;
- on the **default branch** (`scan`), fails on every finding without a valid exception, so a dependency flagged after it merged turns `main` red.

It runs with Node 24 (type stripping), with one dependency (`yaml`, which keeps the comments where actions name their versions), and reads files from git objects or the working tree. The only thing that runs code from the checked repository is `gradle-inventory`, which runs its Gradle build to learn what it resolves; in CI that happens in a job of its own, and the comparison only reads the JSON it wrote.

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

- **GitHub's advisory database** for GitHub Actions: OSV holds their advisories but doesn't match versions against them; GitHub's `affects=` filter does (reviewed advisories and malware, asked once per action version).

A package with no GitHub source repository, an unreadable repository, and a range the gate can't read are **coverage gaps**: listed in the report, never a pass in disguise.

## Gradle builds

`gradle-inventory` runs [`gradle/supply-chain-inventory.init.gradle`](gradle/supply-chain-inventory.init.gradle) on a clean checkout and records, for every project, **every resolvable configuration**: runtime, compile and test classpaths, annotation processors, tool configurations (checkstyle, pitest, jacoco…), the buildscript classpath (where `plugins {}` and `buildscript {}` put plugins) and the settings classpath. Each configuration lists what resolution selected, what it couldn't resolve, and the external dependencies it declares or inherits, with Gradle's `because(...)` reason.

- `buildSrc`, included builds and plugin builds (`pluginManagement { includeBuild(...) }`) that Gradle configures from the root build are covered by the same run, under their own location prefix (`buildSrc/:compileClasspath`). Each build also writes a manifest from Gradle's own model (its projects and nested builds), so a project without output, or a nested build the run didn't export, fails the run; such a build has to be listed in `gradle.builds`.
- A configuration that doesn't resolve fails the run on either side: a hole in the inventory would read as clean. `gradle.ignoreConfigurations` names locations to leave out, explicitly.
- The inventory names the commit it was made from, and `compare`/`scan` check it matches and covers the builds the tree lists.
- Base and head each have their own sources: a PR can add a repository's first Gradle build (base needs no inventory) or remove its last one (base's inventory still counts, and what it had shows as fixed).
- A plugin's injected dependencies show up in its consumers' builds, which run this gate themselves (for example, java-conventions' checkstyle and errorprone dependencies in sqs-codec).
- Gradle runs the build's own code, so a malicious build script or plugin can alter its own inventory; keeping that job apart keeps it from touching the comparison and its credentials, not from lying about itself.

## GitHub Actions

Every `uses:` in `.github/workflows/*.yml`, in `.github/actions/**/action.yml`, in a root `action.yml`, and in every local `./` action a workflow uses, is an action version, located in the file that uses it. Files are parsed as YAML (comments kept, aliases followed, a file that doesn't parse fails), and every `uses:` key counts.

- A use resolves to a version when it's pinned to a full commit SHA and its comment names a full release tag (`# v7.0.1`, `# tag=v7.0.1`; a floating `# v7` doesn't say what's pinned) that GitHub says points at that commit, annotated tags dereferenced.
- **A new or changed `uses:`** must resolve: a tag or branch ref, a missing comment, or a comment whose tag points elsewhere fails. Each occurrence is judged on its own: same file, action, ref and comment as in base, or it's a change (so dropping a comment, or copying an unpinned ref into another workflow, counts). Its age is its GitHub release's publish time (a tag's own date is whatever its author wrote); no published release fails, own actions aside (`ownPackages["GitHub Actions"].owners`).
- An unchanged `uses:` that doesn't resolve, `docker://` uses, and a local action without an `action.yml` are coverage gaps: the PR didn't make them worse.
- A young action version can pass by the young-fix rule like any other, its candidates being the repository's releases (every page; past 2,000 releases the listing is incomplete and the rule can't be checked).

## Floors: `.github/dependency-floors.json`

A floor forces a minimum version on a dependency, usually a transitive one: a security fix (`purpose: "security"`, naming the advisories) or a compatibility need (`purpose: "compatibility"`, naming none). Every floor is recorded, so none outlives its reason unnoticed; secure-it removes security floors that are no longer needed.

```json
{
  "floors": [
    {
      "ecosystem": "Maven",
      "package": "com.google.guava:guava",
      "version": "33.7.2-jre",
      "declaredIn": "build.gradle.kts",
      "selector": [":checkstyle", ":errorprone"],
      "purpose": "security",
      "advisories": ["CVE-2026-102554"],
      "reason": "Checkstyle and Error Prone pull an affected Guava",
      "added": "2026-10-04"
    }
  ]
}
```

- **Gradle:** in every configuration the `selector` names, Gradle must declare the package at exactly the floor version, with a `because(...)` that names every advisory (or, for compatibility, any reason), and resolve it at or above the floor by Gradle's own version ordering (which isn't Maven's: `33.7.2-jre` sorts before `33.7.2`). The declarations come from Gradle's inventory, catalog versions included, so no build file is parsed. Floors are explicit dependencies, never `constraints`.
- **npm:** the `selector` lists `overrides` key paths in `declaredIn` (a key, or a list of keys for a nested override: `[["aws-cdk-lib", "brace-expansion"]]`; keys may carry version ranges). Each must pin the floor's own package, as `x`, `^x`, `~x` or `>=x` with `x` at or above the floor, and every copy in the lockfile next to it must be at or above it. Every override in a checked lockfile's `package.json` needs an entry for its package.
- One package can have separate floors in one file for disjoint configurations; two floors can't claim the same configuration or override.
- A Gradle declaration with a `because(...)` that no entry covers (same package and version, in that configuration) is noted, not failed: a plugin can inject it (java-conventions' Guava floor shows up in its consumers' builds).

## Release age, source and identity (npm)

For every version a PR adds or changes:

- **Release age:** published at least `releaseAgeDays` (default 7) ago, unless it's an own package, or it's the security fix the version rule picks (below), or a `releaseAge` exception names an advisory that, in this run's snapshot, affects a version the PR replaces and not this one (malware advisories don't count).
- **Source:** every locked package comes from an allowed registry (`npm.registries`, default the npm registry). The gate checks age and identity only against the npm registry, so a package from another allowed registry fails, unless it's an own package with an unexpired `identity` exception recording that its publish was reviewed (own packages skip only the wait).
- **Identity:** a version that replaces another fails on a publisher identity break: provenance dropped or from another repository or workflow, provenance from a repository the replaced version doesn't declare, or (without provenance) a publisher who hadn't published the package up to the replaced version. Every provenance statement must name the exact package, version and locked sha512.
- Bundles the lockfile doesn't fully record fail: every `bundleDependencies` entry, and what it depends on, needs an `inBundle` entry inside the package that ships it.

After a scriptless `npm ci --ignore-scripts`, `npm audit signatures` verifies registry signatures and attestations of what was installed (a workflow step, not this CLI).

## A young security fix (any ecosystem)

A version younger than the wait passes without an exception when it's the fix the version rule picks. For a version V replacing R:

- **Targets:** the advisories that affect R and not V. An upgrade that fixes A and leaves B fixes A; malware isn't a target. No target, no fix.
- **Candidates:** the registry's versions above R, up to the end of V's line. Prereleases count only if R is one; a Maven version keeps R's flavor (`-jre`). A candidate fixes when no target affects it, and it brings no advisory R doesn't have, malware included.
- **The rule:**
  1. Take the first compatible line with a fixing candidate, starting from R's own (npm's caret range; Maven's first numeric segment, or `compatibleLines` in config). A backport 1.9.5 beats a mature 2.0.0.
  2. In that line, take the lowest fixing candidate at least `releaseAgeDays` old.
  3. If none is that old, take the lowest fixing candidate, however young.
- V passes only if it's that version. If an older fix in the line turns 7 days old before CI runs, the check fails on purpose: that one is safer, and secure-it picks it up.

Candidates join the same advisory snapshot as base and head, so the rule and the comparison read the same data. On sqs-codec's snappy-java 1.1.10.8 → 1.1.10.10, three days old, it passes with no exception: 1.1.10.9 leaves two of the seven advisories, and 1.1.10.10 is the lowest that fixes them all.

## Release age (Maven)

Every Maven version a change adds needs the same wait, own packages aside. Its publish time is the POM's `Last-Modified` in the first configured repository that has it (`maven.repositories`, default Maven Central and the Gradle Plugin Portal, both immutable, so a file's date is its upload; Renovate reads Maven release dates the same way). A version none of them has fails: the gate can't tell its age. A young security fix passes by the rule above, or by a `releaseAge` exception (with `"ecosystem": "Maven"`) checked against the snapshot like npm's. What a version replaces is read per configuration: upgraded at runtime while tests keep the old version, it still replaces the runtime one.

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
    "Maven": { "groups": ["com.acme"], "pluginIdPrefixes": ["com.acme."] },
    "GitHub Actions": { "owners": ["acme"] }
  },
  "repositories": { "npm:some-package": "owner/repo", "Maven:group:artifact": "owner/repo" },
  "compatibleLines": { "Maven:org.springframework.boot:*": 2 }
}
```

- Without `npm.lockfiles`, the gate reads `package-lock.json` if the tree has one; without `gradle.builds`, the root build if the tree has a `settings.gradle(.kts)` or `build.gradle(.kts)`. So an ecosystem in the repository is never skipped for lack of configuration; `"builds": []` turns Gradle off explicitly. Workflows are always read. A tree with none of these fails.
- Every listed lockfile must exist in head; one base doesn't have yet reads as empty there.
- Own Maven packages: exact `groups`, and `pluginIdPrefixes` that only match Gradle plugin markers (`<id>:<id>.gradle.plugin`), so `com.acme.` doesn't exempt every `com.acme.*` group.
- `compatibleLines`: how many leading numeric segments make a compatible line for a package (a trailing `*` matches a prefix), where the default (npm's caret range, Maven's first segment) doesn't fit.

## Exceptions: `.github/supply-chain-exceptions.json`

Reviewed exceptions in three lists. Each entry names the exact package and version, a `reason` and an `expires` date (valid through that UTC day); an optional `ecosystem` narrows it.

- `vulnerabilities`: `id` (any alias of the advisory), `package`, `version`, and the `paths` it covers: lockfile paths like `node_modules/aws-cdk-lib/node_modules/brace-expansion` (for a lockfile in a subdirectory, prefixed with it), or Gradle configuration locations like `:checkstyle` or `buildSrc/:runtimeClasspath`. A copy anywhere else still fails.
- `releaseAge`: `package`, `version` and the `advisory` the young version fixes.
- `identity`: a reviewed publisher identity break.

Malware ids can't be excepted.

## Report

`--report <file>` writes JSON: `schemaVersion`, `mode`, the gate's commit and OSV-Scanner version, a digest of the config, `baseSha`, `headSha`, `startedAt` (the snapshot's time), `completedAt`, `completed`, `verdict`, and the failures, warnings, notes and gaps.

## Adopting the gate

The reusable workflow [`.github/workflows/supply-chain.yml`](../../.github/workflows/supply-chain.yml) runs all of it. Call it from a workflow of your own, pinned to a full commit SHA of this repository (the gate is checked out from the same commit, so that's the only pin):

```yaml
# .github/workflows/supply-chain.yml
name: supply-chain

on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
  push:
    branches: [main]
  schedule:
    - cron: "17 5 * * *" # an odd minute: GitHub delays or drops scheduled runs on the hour
  workflow_dispatch:
    inputs:
      pr:
        description: Rescan only this open PR now
        required: false
        type: string

permissions:
  contents: read

jobs:
  supply-chain:
    uses: leanish/supply-chain/.github/workflows/supply-chain.yml@<full commit SHA> # v0.1.0
    permissions:
      contents: read
      pull-requests: read # the daily rescan lists open PRs
      statuses: write # the daily rescan posts its verdicts
    with:
      java-version: "25" # for Gradle builds; several lines for several JDKs, the last one runs Gradle
```

What runs where:

- **On a PR:** two inventory jobs (base and head) run the Gradle builds with a read-only token; the `supply-chain` job compares their output and the lockfiles and workflows read from git, and its result is the verdict. It runs with `if: always()` and fails when an inventory job didn't succeed, so a skipped job never satisfies the required check.
- **On pushes to the default branch and daily:** the full `scan`.
- **Daily (and on `workflow_dispatch`):** every open PR's head is merged onto its base's current tip (the same commit in every job; the head itself, against its merge base, when the merge conflicts), inventoried, and compared, with today's advisories. A publisher job that runs no code from the repository re-reads each PR (still open, same head, same base, no newer status) and posts the verdict as a commit status on the PR's head, named like the required check. A rescan that didn't complete posts a failure.

**GitHub settings**

- A ruleset (or branch protection) on the default branch requiring the check `supply-chain / supply-chain` (`<your job id> / supply-chain`; pass `required-check` if you call the job something else), from GitHub Actions. GitHub then requires both the check and the daily status of that name to pass: a red status blocks a PR whose own check was green, and the latest status wins. Required checks on private repositories need a paid plan.
- Actions enabled, allowing the actions this workflow uses (actions/checkout, setup-node, setup-java, upload-artifact, download-artifact).
- The dependency graph and Dependabot **alerts** on; Dependabot version and security updates off (secure-it and bump-it make those PRs, with this gate's rules).

**Limits**

- **Fork PRs:** their workflow runs from the fork's own files, with a read-only token and no secrets, so their check is only as trustworthy as the PR: review workflow and build changes, require approval for outside contributors' runs, and don't merge before the daily rescan's status lands (or trigger it with `workflow_dispatch`, `pr` input).
- **Scheduled runs** are best effort: GitHub may delay or skip them under load, and disables them in a public repository after 60 days without activity.
- The Gradle inventory comes from running the build, so a malicious build script or plugin can alter its own inventory; the job split keeps it from touching the comparison and the publishing credentials, not from lying about itself.

**Updating the pin:** a PR that changes the SHA (and its `# vX.Y.Z` comment); bump-it does it like any other action update.

## Coming next

A `candidates` command for secure-it and bump-it.
